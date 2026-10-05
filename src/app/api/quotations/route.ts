import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Quotation } from "@/lib/models";
import { computeQuotationTotals } from "@/lib/quotation/calc";
import { normalizeQuotationLines } from "@/lib/quotation/lines";
import { loadQuotationSettings } from "@/lib/quotation/server";
import { trustedCustomerId } from "@/lib/sales";
import { toJSON, toJSONList } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { branchScopeFilter } from "@/lib/auth/guards";
import { escapeRegex, loosePhoneRegex, phoneDigits } from "@/lib/phone";

function mapQuote(q: Record<string, unknown>) {
  return {
    ...q,
    date: q.date ? new Date(q.date as string).toISOString().slice(0, 10) : null,
    expiry: q.expiry
      ? new Date(q.expiry as string).toISOString().slice(0, 10)
      : null,
  };
}

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const phone = searchParams.get("phone")?.trim();
    const customerId = searchParams.get("customerId")?.trim();
    const filter: Record<string, unknown> =
      status && status !== "all" ? { status } : {};
    // QTN-01: customer profile pulls its own open/converted quotations by phone.
    if (phone) {
      const digits = phoneDigits(phone);
      filter.customerPhone =
        digits.length >= 7
          ? { $regex: loosePhoneRegex(digits) }
          : { $regex: escapeRegex(phone), $options: "i" };
    }
    if (customerId) filter.customerId = customerId;
    if (access) {
      const scope = branchScopeFilter(access);
      if (scope) Object.assign(filter, scope);
    }
    const quotations = await Quotation.find(filter).sort({ date: -1 });
    return NextResponse.json(toJSONList(quotations).map(mapQuote));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load quotations") },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const body = await req.json();
    const settings = await loadQuotationSettings();

    const lines = normalizeQuotationLines(body.lines);
    const vatPercent = Number(body.vatPercent ?? settings.vatPercent ?? 0);
    const { subtotal, vatAmount, total } = computeQuotationTotals(lines, vatPercent);

    const prefix = (body.number ? "" : settings.quotationNumberPrefix) || "QT";
    const year = new Date().getFullYear();

    async function nextQuotationNumber(): Promise<string> {
      const seriesPrefix = `${prefix}-${year}-`;
      const last = await Quotation.findOne({
        number: { $regex: `^${seriesPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$` },
      })
        .sort({ number: -1 })
        .select("number")
        .lean<{ number: string }>();
      const lastSeq = last ? parseInt(last.number.slice(seriesPrefix.length), 10) || 0 : 0;
      return `${seriesPrefix}${String(lastSeq + 1).padStart(3, "0")}`;
    }

    const validityDays = Number(body.validityDays ?? settings.quotationDefaultValidityDays ?? 14);
    const date = new Date(body.date || Date.now());
    const expiry = body.expiry
      ? new Date(body.expiry)
      : new Date(date.getTime() + validityDays * 24 * 60 * 60 * 1000);

    const baseDoc = {
      // POS-108: keep a picked customer only if it is the one with this phone.
      customerId:
        (await trustedCustomerId(body.customerId || undefined, String(body.customerPhone ?? ""))) ??
        undefined,
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      customerEmail: body.customerEmail || "",
      customerTrn: body.customerTrn || "",
      customerAddress: body.customerAddress || "",
      date,
      expiry,
      lines,
      subtotal,
      vatPercent,
      vatAmount,
      total,
      customerPoNumber: body.customerPoNumber || "",
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      paymentTerms: body.paymentTerms || "",
      deliveryTerms: body.deliveryTerms || "",
      validityDays,
      termsText: body.termsText || settings.quotationTermsTemplate || "",
      notes: body.notes || "",
      // QTN-02: signed in-store at creation time (e.g. tablet handed to a walk-in customer).
      signatureDataUrl: body.signatureDataUrl || "",
      signedByName: body.signatureDataUrl ? body.signedByName || body.customerName : "",
      signedAt: body.signatureDataUrl ? new Date() : undefined,
      status: "draft" as const,
      version: 1,
      history: [
        {
          at: new Date(),
          by: access?.name || "System",
          action: "created",
          toStatus: "draft",
          toVersion: 1,
        },
      ],
      branchId: access?.branchId ?? undefined,
      branchName: access?.branchName ?? undefined,
    };

    // Retry on unique-index collisions from concurrent requests racing for the same number.
    let quotation;
    for (let attempt = 0; attempt < 5; attempt++) {
      const number = body.number || (await nextQuotationNumber());
      try {
        quotation = await Quotation.create({ ...baseDoc, number });
        break;
      } catch (error) {
        const isDupNumber =
          (error as { code?: number })?.code === 11000 &&
          /number_1/.test((error as { message?: string })?.message || "");
        if (body.number || !isDupNumber || attempt === 4) throw error;
      }
    }
    return NextResponse.json(mapQuote(toJSON(quotation)!), { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create quotation") },
      { status: 400 },
    );
  }
}
