import { NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/auth/apiGuard";
import { connectDB } from "@/lib/db";
import { Quotation } from "@/lib/models";
import { loadQuotationSettings } from "@/lib/quotation/server";
import { receiptStoreFromSettings } from "@/lib/receipt/document";

type Ctx = { params: Promise<{ token: string }> };

function isExpired(q: { expiry?: Date; approvalTokenExpiresAt?: Date }): boolean {
  const now = Date.now();
  if (q.approvalTokenExpiresAt && new Date(q.approvalTokenExpiresAt).getTime() < now) return true;
  if (q.expiry && new Date(q.expiry).getTime() < now) return true;
  return false;
}

function toPublicView(
  q: InstanceType<typeof Quotation>,
  settings: Awaited<ReturnType<typeof loadQuotationSettings>>,
) {
  return {
    number: q.number,
    status: q.status,
    date: q.date.toISOString().slice(0, 10),
    expiry: q.expiry.toISOString().slice(0, 10),
    store: receiptStoreFromSettings(settings),
    customerName: q.customerName,
    customerPhone: q.customerPhone,
    customerEmail: q.customerEmail,
    customerTrn: q.customerTrn,
    customerAddress: q.customerAddress,
    customerPoNumber: q.customerPoNumber,
    lines: q.lines.map((line: (typeof q.lines)[number]) => ({
      name: line.name,
      qty: line.qty,
      unitLabel: line.unitLabel,
      unitPrice: line.unitPrice,
      lineType: line.lineType,
      formulaName: line.formulaName,
      bottleNote: line.bottleNote,
      designNote: line.designNote,
      charges: line.charges,
      notes: line.notes,
    })),
    subtotal: q.subtotal,
    vatPercent: q.vatPercent,
    vatAmount: q.vatAmount,
    total: q.total,
    paymentTerms: q.paymentTerms,
    deliveryTerms: q.deliveryTerms,
    validityDays: q.validityDays,
    termsText: q.termsText || settings.quotationTermsTemplate,
    notes: q.notes,
    signatureDataUrl: q.signatureDataUrl,
    signedByName: q.signedByName,
    signedAt: q.signedAt ? q.signedAt.toISOString() : undefined,
    customerDecision: q.customerDecision,
    customerDecisionAt: q.customerDecisionAt ? q.customerDecisionAt.toISOString() : undefined,
    customerDecisionNote: q.customerDecisionNote,
    expired: isExpired(q),
  };
}

/** QTN-10 public quotation view — no session, reachable only with the approval token. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    await connectDB();
    const { token } = await ctx.params;
    const quotation = await Quotation.findOne({ approvalToken: token });
    if (!quotation) {
      return NextResponse.json({ error: "Quotation link not found" }, { status: 404 });
    }
    if (!quotation.publicViewedAt) {
      quotation.publicViewedAt = new Date();
      await quotation.save();
    }
    const settings = await loadQuotationSettings();
    return NextResponse.json(toPublicView(quotation, settings));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load quotation") },
      { status: 500 },
    );
  }
}

/** Customer approves/rejects via the public link — records decision + optional signature. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    await connectDB();
    const { token } = await ctx.params;
    const body = (await req.json().catch(() => null)) ?? {};
    const decision = body.decision === "rejected" ? "rejected" : body.decision === "approved" ? "approved" : null;
    if (!decision) {
      return NextResponse.json({ error: "decision must be 'approved' or 'rejected'" }, { status: 400 });
    }

    const quotation = await Quotation.findOne({ approvalToken: token });
    if (!quotation) {
      return NextResponse.json({ error: "Quotation link not found" }, { status: 404 });
    }
    if (isExpired(quotation)) {
      return NextResponse.json({ error: "This quotation link has expired" }, { status: 410 });
    }
    if (quotation.customerDecision) {
      return NextResponse.json({ error: "A decision has already been recorded for this quotation" }, { status: 400 });
    }

    quotation.customerDecision = decision;
    quotation.customerDecisionAt = new Date();
    quotation.customerDecisionNote = String(body.note || "");
    if (decision === "approved") {
      quotation.status = "approved";
      if (body.signatureDataUrl) quotation.signatureDataUrl = String(body.signatureDataUrl);
      if (body.signedByName) quotation.signedByName = String(body.signedByName);
      quotation.signedAt = new Date();
    } else {
      quotation.status = "rejected";
    }
    quotation.history.push({
      at: new Date(),
      by: quotation.signedByName || quotation.customerName || "Customer",
      action: "customer_decision",
      toStatus: quotation.status,
      detail: decision,
    });
    await quotation.save();

    const settings = await loadQuotationSettings();
    return NextResponse.json(toPublicView(quotation, settings));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to record decision") },
      { status: 500 },
    );
  }
}
