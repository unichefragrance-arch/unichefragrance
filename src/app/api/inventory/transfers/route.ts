import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { addFifoLayer, deductFifoMany } from "@/lib/inventory";
import { warnIfNegativeStock } from "@/lib/inventory/stockCheck";
import {
  ADJUSTMENT_SUPPLIER,
  adjustmentSupplierId,
  assertQtyFitsUnit,
  StockAdjustmentError,
} from "@/lib/inventory/stockAdjustment";
import { Product } from "@/lib/models";
import { SaleError } from "@/lib/sales/errors";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

const BUCKETS = [
  "stockSellable",
  "stockTester",
  "stockSample",
  "stockPersonal",
] as const;

type Bucket = (typeof BUCKETS)[number];

function isBucket(v: string): v is Bucket {
  return (BUCKETS as readonly string[]).includes(v);
}

/**
 * INV-06 / TRF: move qty between in-store stock buckets
 * (sellable ↔ tester ↔ sample ↔ personal).
 * Warns when source would go negative; blocks unless acknowledgeWarning.
 * Multi-branch transfers can reuse the same warning contract later.
 */
export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const body = await req.json();
    const productId = String(body.productId || "");
    const qty = Number(body.qty);
    const from = String(body.from || "");
    const to = String(body.to || "");
    const acknowledgeWarning = Boolean(body.acknowledgeWarning);

    if (!mongoose.isValidObjectId(productId)) {
      return NextResponse.json({ error: "Valid productId required" }, { status: 400 });
    }
    if (!(qty > 0) || !Number.isFinite(qty)) {
      return NextResponse.json({ error: "qty must be > 0" }, { status: 400 });
    }
    if (!isBucket(from) || !isBucket(to) || from === to) {
      return NextResponse.json(
        {
          error:
            "from/to must be different buckets: stockSellable, stockTester, stockSample, stockPersonal",
        },
        { status: 400 },
      );
    }

    const product = await Product.findById(productId);
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const fromQty = Number(product.get(from)) || 0;
    const projectedFrom = fromQty - qty;
    const warnings: string[] = [];

    if (projectedFrom < 0) {
      const w = warnIfNegativeStock(
        `${product.name} (${from})`,
        projectedFrom,
      );
      if (w) warnings.push(w);
    } else if (fromQty < qty) {
      warnings.push(
        `Stock warning: ${product.name} ${from} has ${fromQty}, transfer needs ${qty}. Admin should restock or reorder.`,
      );
    }

    if (warnings.length > 0 && !acknowledgeWarning) {
      return NextResponse.json(
        {
          error: warnings[0],
          code: "STOCK_WARNING",
          warnings,
          requiresAck: true,
        },
        { status: 409 },
      );
    }

    // Hard-block negative bucket transfers — INV-06 warns; do not invent stock
    if (fromQty < qty) {
      return NextResponse.json(
        {
          error: `Insufficient ${from} for ${product.name} (need ${qty}, have ${fromQty})`,
          code: "INSUFFICIENT_STOCK",
          warnings: [
            `Stock warning: Insufficient ${from} for ${product.name}. Admin should restock or reorder.`,
            ...warnings,
          ],
        },
        { status: 400 },
      );
    }

    try {
      assertQtyFitsUnit(qty, product.unit, "qty");
    } catch (err) {
      if (err instanceof StockAdjustmentError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    // Sellable stock is FIFO-backed: moving units out of it consumes layers,
    // moving units into it adds a layer at the current FIFO cost — so
    // stockSellable always equals the FIFO total. Every write is atomic
    // (was read-modify-write, which could lose a concurrent sale).
    const insufficient = () =>
      NextResponse.json(
        {
          error: `Insufficient ${from} for ${product.name} (need ${qty})`,
          code: "INSUFFICIENT_STOCK",
        },
        { status: 400 },
      );
    // Both halves of a transfer commit together: before, the source write
    // committed on its own and a failure on the destination write lost the
    // units (or, for → sellable, left them neither in the bucket nor in FIFO).
    const supplierId = to === "stockSellable" ? await adjustmentSupplierId() : null;
    try {
      await mongoose.connection.transaction(async (session) => {
        if (from === "stockSellable") {
          await deductFifoMany([{ productId, qty, productName: product.name }], { session });
        } else {
          const taken = await Product.updateOne(
            { _id: product._id, [from]: { $gte: qty } },
            { $inc: { [from]: -qty } },
            { session },
          );
          if (taken.modifiedCount === 0) {
            throw new SaleError("INSUFFICIENT_STOCK", `Insufficient ${from}`);
          }
        }
        if (to === "stockSellable") {
          await addFifoLayer(
            {
              productId,
              supplierId: supplierId!,
              supplierName: ADJUSTMENT_SUPPLIER,
              purchaseDate: new Date(),
              qty,
              unitCost: Number(product.costFifo) || 0,
              currency: "OMR",
            },
            { session },
          );
        } else {
          await Product.updateOne({ _id: product._id }, { $inc: { [to]: qty } }, { session });
        }
      });
    } catch (err) {
      if (err instanceof SaleError) return insufficient();
      throw err;
    }
    const saved = await Product.findById(product._id);

    return NextResponse.json({
      ok: true,
      from,
      to,
      qty,
      warnings,
      product: toJSON(saved ?? product),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to transfer stock"),
      },
      { status: 400 },
    );
  }
}
