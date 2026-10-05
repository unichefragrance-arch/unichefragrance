import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Customer, Sale } from "@/lib/models";
import { sendEmail } from "@/lib/notifications/email";
import { logDelivery } from "@/lib/notifications/log";
import { normalizePhone } from "@/lib/notifications/phone";
import { sendSms } from "@/lib/notifications/sms";
import {
  buildWhatsAppUrl,
  formatQuotationMessage,
  formatQuotationSms,
} from "@/lib/notifications/whatsapp";
import { buildReceiptDoc } from "@/lib/receipt/document";
import {
  loadReceiptSettings,
  receiptDocForSale,
  type ReceiptSettings,
} from "@/lib/receipt/server";
import { renderReceiptHtml } from "@/lib/receipt/template";
import { receiptSmsText, receiptText } from "@/lib/receipt/text";
import type { ReceiptLine } from "@/lib/receipt/types";
import type { DeliveryKind } from "@/lib/types";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { assertBranchAccess } from "@/lib/auth/guards";

type Channel = "email" | "whatsapp" | "sms";
type LegacyChannel = Channel | "both";

type Body = {
  channel?: LegacyChannel;
  channels?: Channel[];
  kind?: DeliveryKind;
  saleId?: string;
  toEmail?: string;
  toPhone?: string;
  customerName?: string;
  subject?: string;
  message?: string;
  total?: number;
  /** Receipt only: line + invoice discounts already taken off `total`. */
  discountTotal?: number;
  payment?: string;
  salesperson?: string;
  lines?: ReceiptLine[];
  quotation?: {
    id?: string;
    number: string;
    items: number;
    date?: string;
    expiry?: string;
    approvalUrl?: string;
  };
};

type ChannelResult = {
  ok: boolean;
  error?: string;
  to?: string;
  id?: string;
  url?: string;
};

const ALL_CHANNELS: Channel[] = ["email", "whatsapp", "sms"];

function resolveChannels(body: Body): Channel[] {
  if (Array.isArray(body.channels) && body.channels.length > 0) {
    const picked = body.channels.filter((c): c is Channel =>
      ALL_CHANNELS.includes(c),
    );
    if (picked.length > 0) return Array.from(new Set(picked));
  }
  if (body.channel === "both") return ["email", "whatsapp"];
  if (body.channel && ALL_CHANNELS.includes(body.channel)) return [body.channel];
  return ["whatsapp"];
}

/** Indexed lookups only — never scan the full customer collection. */
function phoneLookupVariants(phone: string): string[] {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  const out = new Set<string>();
  if (trimmed) out.add(trimmed);
  if (!digits) return [...out];

  out.add(digits);
  out.add(`+${digits}`);

  const normalized = normalizePhone(trimmed);
  if (normalized) {
    out.add(normalized);
    out.add(`+${normalized}`);
    out.add(`0${normalized.slice(-9)}`);
  }

  if (digits.startsWith("0") && digits.length > 1) {
    out.add(digits.slice(1));
  }
  if (digits.length >= 10) {
    out.add(digits.slice(-10));
    out.add(`0${digits.slice(-9)}`);
  }

  return [...out];
}

async function findCustomerByPhone(phone: string) {
  const variants = phoneLookupVariants(phone);
  if (variants.length === 0) return null;
  return Customer.findOne({ phone: { $in: variants } })
    .select("name phone email")
    .lean<{ _id: unknown; name?: string; phone?: string; email?: string }>();
}

export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const body = (await req.json()) as Body;
    // A stored sale's receipt (customer details included) is branch-isolated
    // like GET /api/sales/:id — no sending another branch's receipt.
    if (body.saleId && access) {
      await connectDB();
      const sale = await Sale.findById(body.saleId)
        .select("branchId")
        .lean<{ branchId?: unknown }>()
        .catch(() => null);
      if (!sale) return NextResponse.json({ error: "Sale not found" }, { status: 404 });
      const denied = assertBranchAccess(access, sale.branchId ? String(sale.branchId) : null);
      if (denied) return denied;
    }
    const channels = resolveChannels(body);
    const kind: DeliveryKind = body.kind || "custom";

    const toPhone = body.toPhone?.trim() || "";
    let toEmail = body.toEmail?.trim() || "";
    let customerName = body.customerName?.trim() || "";

    const needsEmailLookup =
      channels.includes("email") && !toEmail && Boolean(toPhone);
    const needsNameLookup = !customerName && Boolean(toPhone);
    const shouldPersistEmail = Boolean(toEmail && toPhone);

    // Kick this off alongside the customer lookup below instead of after it —
    // the two are independent DB round-trips and don't need to be sequential.
    const settingsPromise =
      kind === "receipt" ? loadReceiptSettings() : null;

    // Only hit Customer when we actually need data from it.
    if (needsEmailLookup || needsNameLookup || shouldPersistEmail) {
      await connectDB();
      const customer = await findCustomerByPhone(toPhone);
      if (customer) {
        if (!toEmail && customer.email) toEmail = customer.email;
        if (!customerName) customerName = customer.name || "";
        if (shouldPersistEmail && !customer.email) {
          // Persist off the critical path — don't block send on a write.
          void Customer.updateOne(
            { _id: customer._id },
            { $set: { email: toEmail } },
          ).catch(() => {
            /* non-fatal */
          });
        }
      }
    }

    const content = await buildContent({
      body,
      kind,
      channels,
      toPhone,
      toEmail,
      customerName,
      settings: settingsPromise ? await settingsPromise : undefined,
    });

    const jobs: Promise<void>[] = [];
    const results: Partial<Record<Channel, ChannelResult>> = {};

    if (channels.includes("email")) {
      jobs.push(
        (async () => {
          results.email = await deliverEmail({
            to: toEmail,
            subject: body.subject || content.subject,
            text: content.text,
            html: content.html,
          });
          void logDelivery({
            channel: "email",
            kind,
            status: results.email.ok ? "sent" : "failed",
            saleId: body.saleId,
            quotationId: body.quotation?.id,
            receiptNo: content.receiptNo,
            to: toEmail,
            providerId: results.email.id,
            error: results.email.error,
            preview: content.text,
          });
        })(),
      );
    }

    if (channels.includes("whatsapp")) {
      results.whatsapp = deliverWhatsApp(toPhone, content.text);
      void logDelivery({
        channel: "whatsapp",
        kind,
        status: results.whatsapp.ok ? "handoff" : "failed",
        saleId: body.saleId,
        quotationId: body.quotation?.id,
        receiptNo: content.receiptNo,
        to: toPhone,
        error: results.whatsapp.error,
        preview: content.text,
      });
    }

    if (channels.includes("sms")) {
      jobs.push(
        (async () => {
          results.sms = await deliverSms(toPhone, content.sms);
          void logDelivery({
            channel: "sms",
            kind,
            status: results.sms.ok ? "sent" : "failed",
            saleId: body.saleId,
            quotationId: body.quotation?.id,
            receiptNo: content.receiptNo,
            to: toPhone,
            providerId: results.sms.id,
            error: results.sms.error,
            preview: content.sms,
          });
        })(),
      );
    }

    if (jobs.length > 0) await Promise.all(jobs);

    const failed = channels.filter((channel) => !results[channel]?.ok);
    if (failed.length > 0) {
      const parts = channels.map((channel) => {
        const result = results[channel];
        return result?.ok
          ? `${channel.toUpperCase()} OK${result.to ? ` → ${result.to}` : ""}`
          : `${channel.toUpperCase()} FAILED: ${result?.error || "unknown error"}`;
      });
      return NextResponse.json(
        {
          ok: false,
          error: parts.join(" · "),
          receiptNo: content.receiptNo,
          ...results,
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      receiptNo: content.receiptNo,
      ...results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to send notification"),
      },
      { status: 400 },
    );
  }
}

async function buildContent(input: {
  body: Body;
  kind: DeliveryKind;
  channels: Channel[];
  toPhone: string;
  toEmail: string;
  customerName: string;
  settings?: ReceiptSettings;
}): Promise<{
  subject: string;
  text: string;
  sms: string;
  html?: string;
  receiptNo?: string;
}> {
  const { body, kind, channels, toPhone, toEmail, customerName } = input;
  // A receipt's text is always generated — never caller-supplied free text,
  // which would go out under the store's name with a real receipt number.
  const override = kind === "receipt" ? undefined : body.message?.trim();
  const wantsHtml = channels.includes("email") && !override;

  if (kind === "receipt") {
    const settings = input.settings ?? (await loadReceiptSettings());
    // POS-113: a completed sale's receipt comes from the stored sale only —
    // client lines / totals / payment / customer are ignored. Client data is
    // used just for an unsaved cart, and that is always marked as a draft.
    const doc = body.saleId
      ? await receiptDocForSale(body.saleId, { settings })
      : buildReceiptDoc({
          draft: true,
          customer: { name: customerName, phone: toPhone, email: toEmail },
          salesperson: body.salesperson,
          payment: body.payment,
          lines: body.lines ?? [],
          total: body.total,
          discountTotal: body.discountTotal,
          settings,
        });

    if (!doc) {
      throw new Error("Sale not found for this receipt");
    }
    if (body.saleId && toEmail) {
      // The stored receipt carries the sale's customer; keep the address the
      // cashier typed for delivery only.
      doc.customer.email = toEmail;
    }

    return {
      subject: `${doc.store.name} Receipt ${doc.receiptNo}`,
      text: receiptText(doc),
      sms: receiptSmsText(doc),
      html: wantsHtml ? renderReceiptHtml(doc, "a4") : undefined,
      receiptNo: doc.receiptNo,
    };
  }

  if (kind === "quotation" && body.quotation) {
    const quotation = {
      number: body.quotation.number,
      customerName: customerName || "Customer",
      total: Number(body.total || 0),
      items: body.quotation.items,
      date: body.quotation.date,
      expiry: body.quotation.expiry,
      approvalUrl: body.quotation.approvalUrl,
    };
    return {
      subject: `UNICH Quotation ${body.quotation.number}`.trim(),
      text: override || formatQuotationMessage(quotation),
      sms: formatQuotationSms(quotation),
    };
  }

  if (!override) {
    throw new Error("Message is required");
  }
  return { subject: "UNICH Message", text: override, sms: override.slice(0, 300) };
}

async function deliverEmail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<ChannelResult> {
  if (!input.to) {
    return {
      ok: false,
      error: "No customer email on file — add it on POS or in the CRM",
    };
  }
  const sent = await sendEmail(input);
  return sent.ok
    ? { ok: true, id: sent.id, to: input.to }
    : { ok: false, error: sent.error, to: input.to };
}

function deliverWhatsApp(toPhone: string, message: string): ChannelResult {
  if (!toPhone) {
    return { ok: false, error: "Customer phone is required" };
  }
  try {
    return { ok: true, url: buildWhatsAppUrl(toPhone, message), to: toPhone };
  } catch (err) {
    return {
      ok: false,
      error: safeErrorMessage(err, "WhatsApp failed"),
    };
  }
}

async function deliverSms(toPhone: string, text: string): Promise<ChannelResult> {
  if (!toPhone) {
    return { ok: false, error: "Customer phone is required" };
  }
  const sent = await sendSms({ to: toPhone, text });
  return sent.ok
    ? { ok: true, id: sent.id, to: toPhone }
    : { ok: false, error: sent.error, to: toPhone };
}
