import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { deductFifoMany, addFifoLayer } from "@/lib/inventory";
import {
  checkStockAvailability,
  warnIfNegativeStock,
} from "@/lib/inventory/stockCheck";
import {
  Customer,
  Expense,
  InventoryAdjustment,
  Product,
} from "@/lib/models";
import { createSale } from "@/lib/sales/createSale";
import { SaleError } from "@/lib/sales/errors";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, isDbUnavailable, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { recordAudit } from "@/lib/audit/log";
import {
  ADJUSTMENT_SUPPLIER,
  adjustmentSupplierId,
  assertQtyFitsUnit,
  StockAdjustmentError,
} from "@/lib/inventory/stockAdjustment";



type AdjustmentReason =
  | "wastage_cost"
  | "wastage_customer"
  | "restock"
  | "adjustment";

function normalizeReason(
  raw: string,
  direction: "in" | "out",
): AdjustmentReason {
  const r = raw.trim().toLowerCase();
  if (r === "wastage_cost" || r === "wastage" || r === "cost") {
    return "wastage_cost";
  }
  if (
    r === "wastage_customer" ||
    r === "customer" ||
    r === "customer_paid" ||
    r === "customer_damage"
  ) {
    return "wastage_customer";
  }
  if (r === "restock" || direction === "in") return "restock";
  return "adjustment";
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

/**
 * Claim an idempotency key BEFORE moving stock: the adjustment record is
 * written first (pending) under a unique (owner, key) index, so a resent
 * request — lost response, retry — can never apply the movement twice.
 * Returns the claim id, or a ready response for a duplicate.
 */
async function claimAdjustment(input: {
  key: string;
  owner: string;
  product: { _id: mongoose.Types.ObjectId; name: string; stockSellable: number; costFifo?: number };
  qty: number;
  direction: "in" | "out";
  reason: AdjustmentReason;
  createdBy?: string;
  branchStamp: Record<string, unknown>;
  /**
   * The movement is itself idempotent under the same key (customer wastage:
   * the replacement sale is deduplicated by createSale), so a duplicate that
   * finds the claim still pending may finish it instead of answering IN_PROGRESS.
   */
  resumePending?: boolean;
}): Promise<{ id: mongoose.Types.ObjectId; created: boolean } | { response: NextResponse }> {
  try {
    const claim = await InventoryAdjustment.create({
      productId: input.product._id,
      productName: input.product.name,
      qty: input.qty,
      direction: input.direction,
      reason: input.reason,
      createdBy: input.createdBy,
      idempotencyKey: input.key,
      idempotencyOwner: input.owner,
      pending: true,
      ...input.branchStamp,
    });
    return { id: claim._id, created: true };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  const existing = await InventoryAdjustment.findOne({
    idempotencyOwner: input.owner,
    idempotencyKey: input.key,
  }).lean<{
    _id: mongoose.Types.ObjectId;
    productId: mongoose.Types.ObjectId;
    qty: number;
    direction: string;
    reason: string;
    pending?: boolean;
    costTotal?: number;
    expenseId?: mongoose.Types.ObjectId;
    saleId?: mongoose.Types.ObjectId;
  }>();
  if (!existing) {
    // The first attempt failed and released the key in between — let the client retry.
    return { response: NextResponse.json({ error: "Please try again.", code: "RETRY" }, { status: 409 }) };
  }
  if (
    String(existing.productId) !== String(input.product._id) ||
    existing.qty !== input.qty ||
    existing.direction !== input.direction
  ) {
    return {
      response: NextResponse.json(
        { error: "This request key was already used for a different adjustment.", code: "IDEMPOTENCY_MISMATCH" },
        { status: 409 },
      ),
    };
  }
  if (existing.pending && input.resumePending) {
    return { id: existing._id, created: false };
  }
  if (existing.pending) {
    return {
      response: NextResponse.json(
        { error: "This adjustment is still being saved — refresh in a moment.", code: "IN_PROGRESS" },
        { status: 409 },
      ),
    };
  }
  // Already applied: answer with the original outcome and today's stock.
  const now = await Product.findById(input.product._id).select("stockSellable costFifo").lean<{ stockSellable?: number; costFifo?: number }>();
  const stockSellable = Number(now?.stockSellable ?? 0);
  return {
    response: NextResponse.json({
      ok: true,
      deduplicated: true,
      direction: existing.direction,
      reason: existing.reason,
      qty: existing.qty,
      costTotal: existing.costTotal,
      expenseId: existing.expenseId ? String(existing.expenseId) : undefined,
      saleId: existing.saleId ? String(existing.saleId) : undefined,
      adjustmentId: String(existing._id),
      stockSellable,
      warnings: [] as string[],
      product: { id: String(input.product._id), stockSellable, costFifo: Number(now?.costFifo) || 0 },
    }),
  };
}

/**
 * INV-06 / INV-07: inventory adjustment.
 * - wastage_cost: FIFO out + expense (other wasted products = cost)
 * - wastage_customer: replacement sale (customer leaked/damaged → replace + pay)
 * - restock / adjustment: FIFO in or generic out
 */
export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;
    const branchStamp = {
      branchId: access?.branchId ?? undefined,
      branchName: access?.branchName ?? undefined,
    };

    await connectDB();
    const body = await req.json();
    const productId = String(body.productId || "");
    const qty = Number(body.qty);
    const direction = String(body.direction || "").toLowerCase() as
      | "in"
      | "out";
    const reason = normalizeReason(
      String(body.reason || (direction === "out" ? "wastage_cost" : "restock")),
      direction === "in" ? "in" : "out",
    );
    const notes = body.notes ? String(body.notes).trim() : "";
    const rawKey = body.idempotencyKey;
    if (rawKey !== undefined && rawKey !== null && typeof rawKey !== "string") {
      return NextResponse.json({ error: "idempotencyKey must be a string" }, { status: 400 });
    }
    const idemKey = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim().slice(0, 200) : null;
    // Who did it comes from the session — never from the request body.
    const createdBy = access?.name || undefined;

    if (!mongoose.isValidObjectId(productId)) {
      return NextResponse.json({ error: "Valid productId required" }, { status: 400 });
    }
    if (!(qty > 0) || !Number.isFinite(qty)) {
      return NextResponse.json({ error: "qty must be > 0" }, { status: 400 });
    }
    if (direction !== "in" && direction !== "out") {
      return NextResponse.json(
        { error: 'direction must be "in" or "out"' },
        { status: 400 },
      );
    }

    if (reason === "wastage_customer" && direction !== "out") {
      return NextResponse.json(
        { error: "Customer wastage must be direction=out" },
        { status: 400 },
      );
    }
    if (reason === "wastage_cost" && direction !== "out") {
      return NextResponse.json(
        { error: "Cost wastage must be direction=out" },
        { status: 400 },
      );
    }

    const product = await Product.findById(productId).lean<{
      _id: mongoose.Types.ObjectId;
      name: string;
      sku?: string;
      unit?: string;
      stockSellable: number;
      costFifo?: number;
      sellPrice?: number;
    }>();
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    // Pieces are whole units (a sale can't sell half a bottle either).
    try {
      assertQtyFitsUnit(qty, product.unit, "qty");
    } catch (err) {
      if (err instanceof StockAdjustmentError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    // ——— INV-07: customer leaked/damaged → replace + customer pays (sale) ———
    if (reason === "wastage_customer") {
      const customerId = String(body.customerId || "");
      if (!mongoose.isValidObjectId(customerId)) {
        return NextResponse.json(
          {
            error:
              "customerId required for customer wastage (INV-07: replaced and paid by customer)",
          },
          { status: 400 },
        );
      }

      const customer = await Customer.findById(customerId).lean<{
        _id: mongoose.Types.ObjectId;
        name: string;
        phone: string;
      }>();
      if (!customer) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }

      const unitPrice =
        body.unitPrice !== undefined && Number(body.unitPrice) >= 0
          ? Number(body.unitPrice)
          : Number(product.sellPrice) || 0;

      if (!(unitPrice > 0)) {
        return NextResponse.json(
          {
            error:
              "Product sell price required so customer can pay for replacement (INV-07)",
          },
          { status: 400 },
        );
      }

      // Keyed: claim the adjustment record first (unique per user + key).
      // The sale and its record used to be written independently, so every
      // retry or double submit of one replacement added another
      // wastage_customer record for the same sale.
      let claim: { id: mongoose.Types.ObjectId; created: boolean } | undefined;
      if (idemKey) {
        const claimed = await claimAdjustment({
          key: idemKey, owner: access?.userId ?? "system", product, qty, direction: "out",
          reason: "wastage_customer", createdBy, branchStamp, resumePending: true,
        });
        if ("response" in claimed) return claimed.response;
        claim = claimed;
      }

      const payment = String(body.payment || "cash").toLowerCase();
      let sale: Awaited<ReturnType<typeof createSale>>["sale"];
      try {
        ({ sale } = await createSale({
        customerId: String(customer._id),
        customerPhone: customer.phone,
        customerName: customer.name,
        payment,
        lines: [
          {
            productId,
            name: product.name,
            qty,
            unitPrice,
            lineType: "ready",
            unitLabel: product.unit || "pcs",
            bomNote: notes || "INV-07 customer leaked/damaged replacement",
          },
        ],
        status: "completed",
        // Same key → createSale returns the same sale on a retry.
        idempotencyKey: idemKey ?? undefined,
        // Keys are scoped per user + branch (no cross-user replay).
        idempotencyOwner: access?.userId,
        branchId: access?.branchId ?? undefined,
        branchName: access?.branchName ?? undefined,
        }));
      } catch (err) {
        if (claim?.created) await InventoryAdjustment.deleteOne({ _id: claim.id }).catch(() => undefined);
        throw err;
      }

      const saleId = String(
        (sale as { id?: string; _id?: unknown }).id ||
          (sale as { _id?: unknown })._id,
      );
      const wastageFields = {
        productId: product._id,
        productName: product.name,
        qty,
        direction: "out",
        reason: "wastage_customer",
        liability: "customer_paid",
        costTotal: 0,
        customerId: customer._id,
        customerName: customer.name,
        customerPhone: customer.phone,
        saleId: new mongoose.Types.ObjectId(saleId),
        notes: notes || "Customer leaked/damaged — replaced and paid by customer",
        createdBy,
      };
      let adjustment: { _id: unknown };
      if (claim) {
        await InventoryAdjustment.updateOne({ _id: claim.id }, { $set: wastageFields, $unset: { pending: 1 } });
        adjustment = { _id: claim.id };
      } else {
        adjustment = await InventoryAdjustment.create({ ...wastageFields, ...branchStamp });
      }

      const updated = await Product.findById(productId);
      recordAudit({
        session: access,
        action: "stock_adjusted",
        entityType: "InventoryAdjustment",
        entityId: String(adjustment._id),
        detail: `${product.name} × ${qty} · out · wastage_customer`,
        req,
      });
      return NextResponse.json(
        {
          ok: true,
          direction: "out",
          reason: "wastage_customer",
          liability: "customer_paid",
          qty,
          saleId,
          adjustmentId: String(adjustment._id),
          stockSellable: updated
            ? Number(
                (updated as { stockSellable?: number }).stockSellable ?? 0,
              )
            : undefined,
          warnings: [] as string[],
          product: updated ? toJSON(updated) : null,
        },
        { status: 201 },
      );
    }

    // ——— INV-07: other wastage = cost (FIFO out + expense) ———
    if (direction === "out") {
      const stockBefore = Number(product.stockSellable) || 0;
      const outReason: AdjustmentReason = reason === "wastage_cost" ? "wastage_cost" : "adjustment";
      let claimId: mongoose.Types.ObjectId | undefined;
      if (idemKey) {
        const claim = await claimAdjustment({ key: idemKey, owner: access?.userId ?? "system", product, qty, direction: "out", reason: outReason, createdBy, branchStamp });
        if ("response" in claim) return claim.response;
        claimId = claim.id;
      }
      const releaseClaim = () =>
        claimId ? InventoryAdjustment.deleteOne({ _id: claimId }).catch(() => undefined) : undefined;

      // The FIFO deduction, the expense (cost wastage) and the adjustment record
      // commit together. Before, the stock left first and a failure saving the
      // record (or finalizing a keyed claim) lost stock with no record, or left
      // the claim pending so every retry answered IN_PROGRESS.
      let costTotal = 0;
      let expenseId: string | undefined;
      let adjustmentId: string | undefined;
      try {
        await mongoose.connection.transaction(async (session) => {
          const map = await deductFifoMany([{ productId, qty, productName: product.name }], { session });
          costTotal = Number((map.get(productId)?.costTotal ?? 0).toFixed(3));

          let expense: { _id: mongoose.Types.ObjectId } | undefined;
          if (reason === "wastage_cost") {
            [expense] = await Expense.create(
              [{
                date: new Date(),
                category: "Wastage",
                detail:
                  notes ||
                  `INV-07 wastage (cost): ${product.name} × ${qty}${product.unit ? ` ${product.unit}` : ""}`,
                amount: costTotal,
                status: "approved",
                ...branchStamp,
              }],
              { session },
            );
          }
          const fields: Record<string, unknown> =
            reason === "wastage_cost"
              ? {
                  productId: product._id,
                  productName: product.name,
                  qty,
                  direction: "out",
                  reason: "wastage_cost",
                  liability: "cost",
                  costTotal,
                  notes: notes || "Other wasted product recorded as cost",
                  createdBy,
                  expenseId: expense!._id,
                }
              : {
                  productId: product._id,
                  productName: product.name,
                  qty,
                  direction: "out",
                  reason: "adjustment",
                  costTotal,
                  notes: notes || "Stock adjustment out",
                  createdBy,
                };
          // With a key, the claimed record becomes the adjustment; otherwise create it.
          if (claimId) {
            await InventoryAdjustment.updateOne({ _id: claimId }, { $set: fields, $unset: { pending: 1 } }, { session });
            adjustmentId = String(claimId);
          } else {
            const [adj] = await InventoryAdjustment.create([{ ...fields, ...branchStamp }], { session });
            adjustmentId = String(adj._id);
          }
          expenseId = expense ? String(expense._id) : undefined;
        });
      } catch (err) {
        await releaseClaim();
        if (err instanceof SaleError) {
          return NextResponse.json(
            {
              error: `Cannot record damage/wastage: need ${qty}, sellable ${stockBefore}. ${err.message}. Restock FIFO first.`,
              code: err.code,
              stockSellable: stockBefore,
            },
            { status: 400 },
          );
        }
        throw err;
      }

      const stockAfter = stockBefore - qty;

      recordAudit({
        session: access,
        action: "stock_adjusted",
        entityType: "InventoryAdjustment",
        entityId: adjustmentId,
        detail: `${product.name} × ${qty} · out · ${reason}`,
        req,
      });

      return NextResponse.json({
        ok: true,
        direction: "out",
        reason: reason === "wastage_cost" ? "wastage_cost" : "adjustment",
        liability: reason === "wastage_cost" ? "cost" : undefined,
        qty,
        costTotal,
        expenseId,
        adjustmentId,
        stockSellableBefore: stockBefore,
        stockSellable: stockAfter,
        warnings: [] as string[],
        product: {
          id: productId,
          stockSellable: stockAfter,
          costFifo: Number(product.costFifo) || 0,
        },
      });
    }

    // direction === "in" — admin restock via adjustment layer
    let inClaimId: mongoose.Types.ObjectId | undefined;
    if (idemKey) {
      const claim = await claimAdjustment({ key: idemKey, owner: access?.userId ?? "system", product, qty, direction: "in", reason: "restock", createdBy, branchStamp });
      if ("response" in claim) return claim.response;
      inClaimId = claim.id;
    }
    // The new FIFO layer (stock) and its adjustment record commit together;
    // on failure nothing moved and the claim is released so a retry can run.
    const stockBefore = Number(product.stockSellable) || 0;
    const stockAfter = stockBefore + qty;
    const inFields = {
      productId: product._id,
      productName: product.name,
      qty,
      direction: "in",
      reason: "restock",
      costTotal: 0,
      notes: notes || "Restock adjustment",
      createdBy,
    };
    const supplierId = await adjustmentSupplierId();
    const requestedCost = Number(body.unitCost);
    let layer!: Awaited<ReturnType<typeof addFifoLayer>>;
    let adjustment!: { _id: unknown };
    try {
      await mongoose.connection.transaction(async (session) => {
        layer = await addFifoLayer(
          {
            productId,
            supplierId,
            supplierName: ADJUSTMENT_SUPPLIER,
            purchaseDate: new Date(),
            qty,
            unitCost: Number.isFinite(requestedCost) && requestedCost >= 0
              ? requestedCost
              : Number(product.costFifo) || 0,
            currency: "OMR",
          },
          { session },
        );
        if (inClaimId) {
          await InventoryAdjustment.updateOne({ _id: inClaimId }, { $set: inFields, $unset: { pending: 1 } }, { session });
          adjustment = { _id: inClaimId };
        } else {
          [adjustment] = await InventoryAdjustment.create([{ ...inFields, ...branchStamp }], { session });
        }
      });
    } catch (err) {
      if (inClaimId) await InventoryAdjustment.deleteOne({ _id: inClaimId }).catch(() => undefined);
      throw err;
    }

    recordAudit({
      session: access,
      action: "stock_adjusted",
      entityType: "InventoryAdjustment",
      entityId: String(adjustment._id),
      detail: `${product.name} × ${qty} · in · restock`,
      req,
    });

    return NextResponse.json(
      {
        ok: true,
        direction: "in",
        reason: "restock",
        qty,
        warnings: [] as string[],
        layerId: String(layer._id),
        adjustmentId: String(adjustment._id),
        stockSellableBefore: stockBefore,
        stockSellable: stockAfter,
        product: {
          id: productId,
          stockSellable: stockAfter,
          costFifo: Number(product.costFifo) || 0,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof SaleError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to adjust inventory"),
      },
      // An unreachable database is not a bad request: 503 tells the client
      // the outcome is unknown and the same idempotency key may be retried.
      { status: isDbUnavailable(error) ? 503 : 400 },
    );
  }
}

/** Preview stock impact without mutating (INV-06 warning surface). */
export async function PUT(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const body = await req.json();
    const productId = String(body.productId || "");
    const qty = Number(body.qty);
    const direction = String(body.direction || "out").toLowerCase();

    if (!mongoose.isValidObjectId(productId) || !(qty > 0)) {
      return NextResponse.json({ error: "productId and qty > 0 required" }, { status: 400 });
    }

    const product = await Product.findById(productId)
      .select("name stockSellable")
      .lean<{ name: string; stockSellable: number }>();
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    if (direction === "in") {
      return NextResponse.json({
        ok: true,
        warnings: [] as string[],
        projectedSellable: product.stockSellable + qty,
      });
    }

    const stock = await checkStockAvailability([
      { productId, qty, productName: product.name },
    ]);
    const projected = product.stockSellable - qty;
    const negWarn = warnIfNegativeStock(product.name, projected);

    return NextResponse.json({
      ok: stock.ok && !negWarn,
      warnings: [...stock.warnings, ...(negWarn ? [negWarn] : [])],
      shortages: stock.shortages,
      projectedSellable: projected,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to preview adjustment"),
      },
      { status: 400 },
    );
  }
}
