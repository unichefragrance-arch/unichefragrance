import { randomBytes } from "crypto";
import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { applyFifoPlan, planFifoDeductions, withProductLocks } from "@/lib/inventory";
import { Customer, Product, Quotation, Sale } from "@/lib/models";
import { computeQuotationTotals } from "@/lib/quotation/calc";
import { normalizeQuotationLines } from "@/lib/quotation/lines";
import {
  FAST_WC,
  creditPortion,
  normalizePaymentBreakdown,
  resolveCustomerByPhone,
  resolveSalesperson,
  trustedCustomerId,
} from "@/lib/sales";
import { computeDiscounts } from "@/lib/sales/discount";
import { resolveDiscountApproval, type DiscountApprover } from "@/lib/sales/discountApproval";
import { checkPriceFloor, needsAdminForFloor, priceFloorMessage } from "@/lib/sales/priceFloor";
import { SaleError } from "@/lib/sales/errors";
import {
  validateSaleLines,
  type DeductionNeed,
  type IncomingSaleLine,
  type ValidatedSaleLine,
} from "@/lib/sales/validateSale";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { assertBranchAccess } from "@/lib/auth/guards";
import type { QuotationStatus } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

function mapQuote(q: Record<string, unknown>) {
  return {
    ...q,
    date: q.date ? new Date(q.date as string).toISOString().slice(0, 10) : null,
    expiry: q.expiry
      ? new Date(q.expiry as string).toISOString().slice(0, 10)
      : null,
  };
}

function isConverted(q: { status?: string; convertedToSaleId?: unknown }): boolean {
  return q.status === "converted" || Boolean(q.convertedToSaleId);
}

const EDITABLE_ANY_STATUS = new Set([
  "customerPoNumber",
  "attachments",
  "notes",
  "customerEmail",
  "customerAddress",
  "customerTrn",
]);

/** POS "convert from quotation" screen prefills its bill from this. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid quotation id" }, { status: 400 });
    }
    const quotation = await Quotation.findById(id);
    if (!quotation) {
      return NextResponse.json({ error: "Quotation not found" }, { status: 404 });
    }
    if (access) {
      const denied = assertBranchAccess(access, quotation.branchId ? String(quotation.branchId) : null);
      if (denied) return denied;
    }
    return NextResponse.json(mapQuote(toJSON(quotation)!));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load quotation") },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid quotation id" }, { status: 400 });
    }
    const body = await req.json();

    const quotation = await Quotation.findById(id);
    if (!quotation) {
      return NextResponse.json({ error: "Quotation not found" }, { status: 404 });
    }
    if (access) {
      const denied = assertBranchAccess(access, quotation.branchId ? String(quotation.branchId) : null);
      if (denied) return denied;
    }

    // A converted quotation is the record behind a completed sale: only
    // reference metadata (PO number, attachments, notes, contact details) may
    // change — never its status, customer, lines or dates.
    if (isConverted(quotation)) {
      const locked = Object.keys(body).filter((k) => !EDITABLE_ANY_STATUS.has(k));
      if (locked.length > 0) {
        return NextResponse.json(
          { error: `This quotation was converted to a sale and is locked (${locked.join(", ")})` },
          { status: 400 },
        );
      }
    }
    // "converted" is set only by the convert action, together with its sale.
    if (body.status === "converted") {
      return NextResponse.json(
        { error: "Use Convert to sale — a quotation can't be marked converted by hand" },
        { status: 400 },
      );
    }

    // Pricing (lines/terms/VAT) can only change on a draft — anything already
    // sent/approved must go through the `revise` action so history is preserved (QTN-05).
    const wantsPricingChange =
      body.lines !== undefined ||
      body.vatPercent !== undefined ||
      body.paymentTerms !== undefined ||
      body.deliveryTerms !== undefined ||
      body.validityDays !== undefined ||
      body.termsText !== undefined;
    if (wantsPricingChange && quotation.status !== "draft") {
      return NextResponse.json(
        {
          error:
            "This quotation is no longer a draft — use the revise action to change lines or terms.",
        },
        { status: 400 },
      );
    }

    if (wantsPricingChange) {
      if (body.lines !== undefined) quotation.lines = normalizeQuotationLines(body.lines);
      if (body.vatPercent !== undefined) quotation.vatPercent = Number(body.vatPercent) || 0;
      if (body.paymentTerms !== undefined) quotation.paymentTerms = body.paymentTerms;
      if (body.deliveryTerms !== undefined) quotation.deliveryTerms = body.deliveryTerms;
      if (body.validityDays !== undefined) quotation.validityDays = Number(body.validityDays) || 14;
      if (body.termsText !== undefined) quotation.termsText = body.termsText;
      const totals = computeQuotationTotals(quotation.lines, quotation.vatPercent);
      quotation.subtotal = totals.subtotal;
      quotation.vatAmount = totals.vatAmount;
      quotation.total = totals.total;
    }

    if (body.customerName !== undefined) quotation.customerName = body.customerName;
    if (body.customerPhone !== undefined) quotation.customerPhone = body.customerPhone;
    if (body.customerId !== undefined) {
      quotation.customerId =
        (await trustedCustomerId(body.customerId || undefined, quotation.customerPhone)) ?? undefined;
    }
    if (body.date) quotation.date = new Date(body.date);
    if (body.expiry) quotation.expiry = new Date(body.expiry);
    for (const key of EDITABLE_ANY_STATUS) {
      if (body[key] !== undefined) {
        (quotation as unknown as Record<string, unknown>)[key] = body[key];
      }
    }
    // QTN-02: signed in-store (e.g. tablet handed to the customer while editing a draft).
    if (body.signatureDataUrl) {
      quotation.signatureDataUrl = body.signatureDataUrl;
      quotation.signedByName = body.signedByName || quotation.customerName;
      quotation.signedAt = new Date();
    }

    if (body.status && body.status !== quotation.status) {
      const fromStatus = quotation.status as QuotationStatus;
      quotation.status = body.status;
      quotation.history.push({
        at: new Date(),
        by: access?.name || "System",
        action: "status_changed",
        fromStatus,
        toStatus: body.status,
      });
    }

    await quotation.save(FAST_WC);
    return NextResponse.json(mapQuote(toJSON(quotation)!));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update quotation") },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid quotation id" }, { status: 400 });
    }
    const quotation = await Quotation.findById(id);
    if (!quotation) {
      return NextResponse.json({ error: "Quotation not found" }, { status: 404 });
    }
    if (access) {
      const denied = assertBranchAccess(access, quotation.branchId ? String(quotation.branchId) : null);
      if (denied) return denied;
    }
    if (quotation.convertedToSaleId) {
      return NextResponse.json(
        { error: "Cannot delete a quotation that has already been converted to a sale" },
        { status: 400 },
      );
    }
    await quotation.deleteOne();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete quotation") },
      { status: 500 },
    );
  }
}

/** QTN-05 revise / QTN-06 convert / QTN-10 share actions. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid quotation id" }, { status: 400 });
    }
    const body = (await req.json().catch(() => null)) ?? {};
    const action = body.action || "convert";
    const quotation = await Quotation.findById(id);
    if (!quotation) {
      return NextResponse.json({ error: "Quotation not found" }, { status: 404 });
    }
    if (access) {
      const denied = assertBranchAccess(access, quotation.branchId ? String(quotation.branchId) : null);
      if (denied) return denied;
    }

    if (action === "revise") {
      if (isConverted(quotation)) {
        return NextResponse.json(
          { error: "This quotation was converted to a sale and can't be revised" },
          { status: 400 },
        );
      }
      const fromVersion = quotation.version;
      const fromStatus = quotation.status as QuotationStatus;

      // QTN-05: snapshot the pre-revision state before applying any change.
      quotation.versions.push({
        version: quotation.version,
        status: quotation.status,
        lines: quotation.lines,
        subtotal: quotation.subtotal,
        vatPercent: quotation.vatPercent,
        vatAmount: quotation.vatAmount,
        total: quotation.total,
        paymentTerms: quotation.paymentTerms,
        deliveryTerms: quotation.deliveryTerms,
        validityDays: quotation.validityDays,
        termsText: quotation.termsText,
        notes: quotation.notes,
        savedAt: new Date(),
        savedBy: access?.name || "System",
      });

      if (body.lines !== undefined) quotation.lines = normalizeQuotationLines(body.lines);
      if (body.vatPercent !== undefined) quotation.vatPercent = Number(body.vatPercent) || 0;
      if (body.paymentTerms !== undefined) quotation.paymentTerms = body.paymentTerms;
      if (body.deliveryTerms !== undefined) quotation.deliveryTerms = body.deliveryTerms;
      if (body.validityDays !== undefined) quotation.validityDays = Number(body.validityDays) || 14;
      if (body.termsText !== undefined) quotation.termsText = body.termsText;
      if (body.notes !== undefined) quotation.notes = body.notes;
      if (body.expiry) quotation.expiry = new Date(body.expiry);
      if (body.customerName !== undefined) quotation.customerName = body.customerName;
      if (body.customerPhone !== undefined) quotation.customerPhone = body.customerPhone;
      if (body.customerId !== undefined) {
        quotation.customerId =
          (await trustedCustomerId(body.customerId || undefined, quotation.customerPhone)) ?? undefined;
      }
      for (const key of EDITABLE_ANY_STATUS) {
        if (body[key] !== undefined) {
          (quotation as unknown as Record<string, unknown>)[key] = body[key];
        }
      }

      const totals = computeQuotationTotals(quotation.lines, quotation.vatPercent);
      quotation.subtotal = totals.subtotal;
      quotation.vatAmount = totals.vatAmount;
      quotation.total = totals.total;

      quotation.version = fromVersion + 1;
      quotation.status = "revised";
      // A fresh revision voids the prior approval/signature — the customer must review it again.
      quotation.approvalToken = undefined;
      quotation.approvalTokenExpiresAt = undefined;
      quotation.publicViewedAt = undefined;
      quotation.customerDecision = undefined;
      quotation.customerDecisionAt = undefined;
      quotation.customerDecisionNote = "";
      quotation.signatureDataUrl = "";
      quotation.signedByName = "";
      quotation.signedAt = undefined;
      // Re-signed in-store as part of this same revision (rare, but supported).
      if (body.signatureDataUrl) {
        quotation.signatureDataUrl = body.signatureDataUrl;
        quotation.signedByName = body.signedByName || quotation.customerName;
        quotation.signedAt = new Date();
      }

      quotation.history.push({
        at: new Date(),
        by: access?.name || "System",
        action: "revised",
        fromStatus,
        toStatus: "revised",
        fromVersion,
        toVersion: quotation.version,
      });

      await quotation.save(FAST_WC);
      return NextResponse.json(mapQuote(toJSON(quotation)!));
    }

    if (action === "share") {
      if (!quotation.approvalToken) {
        quotation.approvalToken = randomBytes(24).toString("base64url");
      }
      quotation.approvalTokenExpiresAt = quotation.expiry;
      if (quotation.status === "draft") {
        quotation.status = "sent";
      }
      quotation.history.push({
        at: new Date(),
        by: access?.name || "System",
        action: "shared",
      });
      await quotation.save(FAST_WC);
      return NextResponse.json({
        quotation: mapQuote(toJSON(quotation)!),
        approvalToken: quotation.approvalToken,
      });
    }

    if (action === "convert") {
      if (quotation.status !== "approved") {
        return NextResponse.json(
          { error: "Only approved quotations can be converted" },
          { status: 400 },
        );
      }
      if (quotation.convertedToSaleId) {
        return NextResponse.json(
          { error: "Quotation already converted" },
          { status: 400 },
        );
      }
      if (!quotation.lines.length) {
        return NextResponse.json(
          { error: "Quotation has no line items to convert" },
          { status: 400 },
        );
      }

      const PAYMENT_METHODS = new Set(["cash", "card", "bank", "credit", "mixed"]);
      const payment = PAYMENT_METHODS.has(body.payment) ? body.payment : "credit";
      // POS-093: same rule as a POS checkout — a salesperson from Settings →
      // Sales Team (the till's choice, else the store default), never the
      // logged-in user's name.
      // POS-108: the stored customerId is honoured only if that customer's
      // phone is the quotation's phone (it came from the client when saved).
      const [salesperson, trustedId] = await Promise.all([
        resolveSalesperson(body.salesperson),
        trustedCustomerId(
          quotation.customerId ? String(quotation.customerId) : undefined,
          quotation.customerPhone,
        ),
      ]);
      // Mixed payment must be split, and the split must cover the total.
      const paymentBreakdown = normalizePaymentBreakdown(
        payment,
        body.paymentBreakdown,
        quotation.total,
        true,
      );
      const creditAmount = creditPortion(payment, quotation.total, paymentBreakdown);

      // POS-110: a custom blend is sold as the Remix product built from its
      // formula — the formula's BOM is what gets consumed. The editor saves
      // blends without a product, so resolve the store's Remix product here.
      type QLine = (typeof quotation.lines)[number];
      const blendWithoutFormula = quotation.lines.find(
        (l: QLine) => l.lineType === "custom_blend" && !l.formulaId,
      );
      if (blendWithoutFormula) {
        return NextResponse.json(
          {
            error: `Custom blend "${blendWithoutFormula.name}" has no formula — revise the quotation and pick one before converting`,
          },
          { status: 400 },
        );
      }
      const needsRemixProduct = quotation.lines.some(
        (l: QLine) => l.lineType === "custom_blend" && !l.productId,
      );
      const remixProduct = needsRemixProduct
        ? await Product.findOne({ category: "Remix" }).select("_id").lean<{ _id: unknown }>()
        : null;
      if (needsRemixProduct && !remixProduct) {
        return NextResponse.json(
          { error: "Create a Remix product before converting custom-blend quotations" },
          { status: 400 },
        );
      }

      // QTN-06: carry every line across at the approved price — no re-entry.
      // Line charges (bottle / design work) become their own lines, so the
      // sale's lines always add up to its subtotal.
      type SaleLine = {
        productId?: mongoose.Types.ObjectId;
        name: string;
        qty: number;
        unitLabel: string;
        unitPrice: number;
        lineType: string;
        formulaId?: mongoose.Types.ObjectId;
        packagingProductIds?: mongoose.Types.ObjectId[];
        bottleNote?: string;
        designNote?: string;
        bomNote?: string;
        oilProductId?: string;
        oilMl?: number;
      };
      const lines: SaleLine[] = [];
      for (const line of quotation.lines as QLine[]) {
        const isBlend = line.lineType === "custom_blend";
        const productId = line.productId ?? (isBlend ? remixProduct?._id : undefined);
        lines.push({
          ...(productId ? { productId: new mongoose.Types.ObjectId(String(productId)) } : {}),
          name: line.name,
          qty: line.qty,
          unitLabel: line.unitLabel,
          unitPrice: line.unitPrice,
          lineType: isBlend ? "remix" : line.lineType,
          ...(line.formulaId ? { formulaId: line.formulaId } : {}),
          ...(line.packagingProductIds?.length ? { packagingProductIds: line.packagingProductIds } : {}),
          ...(line.bottleNote ? { bottleNote: line.bottleNote } : {}),
          ...(line.designNote ? { designNote: line.designNote } : {}),
        });
        if ((line.charges ?? 0) > 0) {
          lines.push({
            name: `${line.name} · charges`,
            qty: 1,
            unitLabel: "charge",
            unitPrice: line.charges,
            lineType: "wholesale",
          });
        }
      }

      // Stock deduction uses the same rules as a POS checkout: plain catalog
      // lines (ready / wholesale / packaging) deduct qty in the product's unit;
      // oil / remix / refill lines go through validateSaleLines so tola → ml
      // and remix BOMs apply (a "1 Tola" line must take 12 ml, not 1).
      const PLAIN = new Set(["ready", "wholesale", "packaging"]);
      const deductions: DeductionNeed[] = [];
      const ruled: { line: IncomingSaleLine; saleIndex: number }[] = [];
      lines.forEach((l, i) => {
        if (!l.productId) return;
        if (PLAIN.has(l.lineType)) {
          deductions.push({ productId: String(l.productId), productName: l.name, qty: Number(l.qty), reason: l.lineType, lineIndex: i });
        } else {
          ruled.push({
            line: {
              productId: String(l.productId),
              name: l.name,
              qty: l.qty,
              unitLabel: l.unitLabel,
              lineType: l.lineType,
              formulaId: l.formulaId ? String(l.formulaId) : undefined,
              packagingProductIds: l.packagingProductIds?.map(String),
            },
            saleIndex: i,
          });
        }
      });
      if (ruled.length > 0) {
        const validated = await validateSaleLines(ruled.map((r) => r.line));
        validated.lines.forEach((v, k) => {
          const target = lines[ruled[k].saleIndex];
          if (v.bomNote) target.bomNote = v.bomNote;
          if (v.oilProductId) target.oilProductId = v.oilProductId;
          if (v.oilMl) target.oilMl = v.oilMl;
        });
        for (const d of validated.deductions) {
          deductions.push({ ...d, lineIndex: ruled[d.lineIndex].saleIndex });
        }
      }
      const needsById = new Map<string, { productId: string; qty: number; productName: string }>();
      for (const d of deductions) {
        const cur = needsById.get(d.productId);
        if (cur) cur.qty += d.qty;
        else needsById.set(d.productId, { productId: d.productId, qty: d.qty, productName: d.productName });
      }
      const needs = [...needsById.values()];

      // POS-060..067: a quotation price below cost + minimum margin needs the
      // Admin — same rule as a POS checkout (charges and VAT are not margin).
      const breakdown = computeDiscounts(lines.map((l) => ({ gross: l.qty * l.unitPrice })));
      const floorViolations = await checkPriceFloor(
        {
          lines: lines.map((l) => ({ ...l, productId: l.productId ? String(l.productId) : undefined })) as ValidatedSaleLine[],
          deductions,
        },
        breakdown,
      );
      const actor = access ? { userId: access.userId, name: access.name, role: access.role } : null;
      let approver: DiscountApprover | null = null;
      if (needsAdminForFloor(floorViolations, actor?.role)) {
        approver = await resolveDiscountApproval(
          breakdown,
          actor,
          {
            email: typeof body.approverEmail === "string" ? body.approverEmail : undefined,
            password: typeof body.approverPassword === "string" ? body.approverPassword : undefined,
          },
          { message: priceFloorMessage(floorViolations) },
        );
      }

      // CRM-02: a converted quotation is a real order — the customer must show up
      // in Customers with this purchase, same as a POS checkout does (createSale()).
      const productNames = [
        ...new Set(quotation.lines.map((l: QLine) => l.name).filter(Boolean)),
      ];
      const customerTouch = {
        $set: {
          lastVisit: new Date(),
          ...(quotation.customerName ? { name: quotation.customerName } : {}),
        },
        $inc: {
          totalPurchases: quotation.total,
          ...(creditAmount > 0 ? { creditBalance: creditAmount } : {}),
        },
        ...(productNames.length > 0
          ? { $addToSet: { productsRequested: { $each: productNames } } }
          : {}),
      };

      const saleId = new mongoose.Types.ObjectId();
      const now = new Date();
      const historyEntry = {
        at: now,
        by: access?.name || "System",
        action: "converted",
        detail: String(saleId),
      };
      let saleDoc: Record<string, unknown> = {};
      let customerObjectId: mongoose.Types.ObjectId | undefined = trustedId
        ? new mongoose.Types.ObjectId(trustedId)
        : undefined;

      // One transaction (same as POS checkout): FIFO deduction, customer
      // stats, the sale and the quotation status commit together or not at
      // all, queued per product with other stock consumers.
      const session = await mongoose.startSession();
      try {
        await withProductLocks(
          needs.map((n) => n.productId),
          () =>
            session.withTransaction(async () => {
              const plan = await planFifoDeductions(needs, session);
              const inventoryDeductions = [...plan.results.entries()].map(
                ([productId, result]) => ({
                  productId: new mongoose.Types.ObjectId(productId),
                  productName: needsById.get(productId)?.productName,
                  qty: result.batches.reduce((s, b) => s + b.qty, 0),
                  reason: "quotation_convert",
                  lineIndex: deductions.find((d) => d.productId === productId)?.lineIndex ?? 0,
                  costTotal: result.costTotal,
                  batches: result.batches.map((b) => ({
                    layerId: new mongoose.Types.ObjectId(b.layerId),
                    qty: b.qty,
                    unitCost: b.unitCost,
                    purchaseDate: b.purchaseDate,
                  })),
                }),
              );

              if (trustedId) {
                customerObjectId = new mongoose.Types.ObjectId(trustedId);
                await Customer.updateOne({ _id: customerObjectId }, customerTouch, { session });
              } else {
                customerObjectId = await resolveCustomerByPhone(
                  quotation.customerPhone,
                  quotation.customerName,
                  customerTouch,
                  session,
                );
              }

              saleDoc = {
                _id: saleId,
                customerPhone: quotation.customerPhone,
                customerName: quotation.customerName,
                customerId: customerObjectId,
                salesperson,
                payment,
                ...(paymentBreakdown.length > 0 ? { paymentBreakdown } : {}),
                status: "completed",
                saleType: "Wholesale",
                // Σ lines = subtotal; subtotal + VAT = total (no discounts on quotations).
                subtotal: quotation.subtotal,
                discountTotal: 0,
                vatPercent: quotation.vatPercent,
                vatAmount: quotation.vatAmount,
                total: quotation.total,
                lines,
                inventoryDeductions,
                quotationId: quotation._id,
                quotationNumber: quotation.number,
                ...(approver
                  ? {
                      discountApprovedBy: {
                        userId: new mongoose.Types.ObjectId(approver.userId),
                        name: approver.name,
                        role: approver.role,
                      },
                    }
                  : {}),
                ...(access?.branchId
                  ? { branchId: new mongoose.Types.ObjectId(access.branchId) }
                  : {}),
                ...(access?.branchName ? { branchName: access.branchName } : {}),
                createdAt: now,
                updatedAt: now,
              };
              await Sale.collection.insertOne(saleDoc, { session });

              // Only an approved, not-yet-converted quotation converts — two
              // simultaneous converts can't both deduct stock.
              const marked = await Quotation.updateOne(
                { _id: quotation._id, status: "approved", convertedToSaleId: null },
                {
                  $set: {
                    convertedToSaleId: saleId,
                    status: "converted",
                    ...(customerObjectId ? { customerId: customerObjectId } : {}),
                  },
                  $push: { history: historyEntry },
                },
                { session },
              );
              if (marked.matchedCount !== 1) {
                throw new SaleError("VALIDATION", "Quotation already converted");
              }

              await applyFifoPlan(plan, session);
            }),
        );
      } finally {
        await session.endSession();
      }

      quotation.customerId = customerObjectId;
      quotation.convertedToSaleId = saleId;
      quotation.status = "converted";
      quotation.history.push(historyEntry);

      return NextResponse.json({
        quotation: mapQuote(toJSON(quotation)!),
        sale: toJSON(saleDoc),
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    // Below-minimum price without (valid) Admin approval → 403, like checkout.
    const denied =
      error instanceof SaleError &&
      (error.code === "PRICE_FLOOR_APPROVAL_REQUIRED" ||
        error.code === "DISCOUNT_APPROVAL_REQUIRED" ||
        error.code === "DISCOUNT_NOT_AUTHORIZED");
    return NextResponse.json(
      {
        error: safeErrorMessage(error, "Failed to process quotation"),
        code: error instanceof SaleError ? error.code : "UNKNOWN",
      },
      { status: denied ? 403 : error instanceof SaleError ? 400 : 500 },
    );
  }
}
