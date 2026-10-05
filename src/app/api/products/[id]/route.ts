import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { FifoLayer, Product } from "@/lib/models";
import mongoose from "mongoose";
import { recordAudit } from "@/lib/audit/log";
import { setSellableStock, StockAdjustmentError } from "@/lib/inventory/stockAdjustment";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    const product = await Product.findById(id);
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    return NextResponse.json(toJSON(product));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load product") },
      { status: 500 },
    );
  }
}

/**
 * Catalogue fields the product edit may change. Never stock-by-number or FIFO
 * cost: sellable stock moves only through FIFO (sales, purchases, adjustments —
 * see setSellableStock) and costFifo is derived from the layers.
 */
const EDITABLE_FIELDS = [
  "sku",
  "name",
  "nameAr",
  "category",
  "unit",
  "sellPrice",
  "wholesalePrice",
  "minMarginPct",
  "brand",
  "concentration",
  "gender",
  "size",
  "collection",
  "notes",
  "itemType",
  "stockTester",
  "stockSample",
  "stockPersonal",
  "lowStockAt",
  "isQuickButton",
  "tags",
] as const;

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid product id" }, { status: 400 });
    }
    const body = (await req.json()) as Record<string, unknown>;

    const existing = await Product.findById(id)
      .select("name unit stockSellable costFifo")
      .lean<{ _id: unknown; name: string; unit: string; stockSellable: number; costFifo: number }>();
    if (!existing) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const update: Record<string, unknown> = {};
    for (const key of EDITABLE_FIELDS) {
      if (body[key] !== undefined) update[key] = body[key];
    }
    // Changing ml ↔ pcs would reinterpret every existing layer / tola deduction.
    if (update.unit !== undefined && update.unit !== existing.unit) {
      const hasStock =
        (Number(existing.stockSellable) || 0) !== 0 ||
        (await FifoLayer.exists({ productId: existing._id, qtyRemaining: { $gt: 0 } }));
      if (hasStock) {
        return NextResponse.json(
          { error: `Unit can't change from ${existing.unit} while ${existing.name} has stock` },
          { status: 400 },
        );
      }
    }

    // INV-06: a new sellable figure is booked as a FIFO adjustment (never a
    // raw overwrite), so stock and FIFO layers always agree.
    const warnings: string[] = [];
    let adjustment: { delta: number; adjustmentId?: string } | null = null;
    if (body.stockSellable !== undefined) {
      try {
        adjustment = await setSellableStock({
          product: existing,
          target: Number(body.stockSellable),
          createdBy: access?.name,
          branchId: access?.branchId,
          branchName: access?.branchName,
        });
      } catch (err) {
        if (err instanceof StockAdjustmentError) {
          return NextResponse.json({ error: err.message, warnings: [err.message] }, { status: 400 });
        }
        throw err;
      }
      if (adjustment.delta !== 0) {
        recordAudit({
          session: access,
          action: "stock_adjusted",
          entityType: "InventoryAdjustment",
          entityId: adjustment.adjustmentId,
          detail: `${existing.name} ${adjustment.delta > 0 ? "+" : ""}${adjustment.delta} · stock count correction`,
          req,
        });
      }
    }

    const product =
      Object.keys(update).length > 0
        ? await Product.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true })
        : await Product.findById(id);
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    return NextResponse.json({
      ...toJSON(product),
      warnings,
      ...(adjustment && adjustment.delta !== 0 ? { stockAdjustment: adjustment } : {}),
    });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update product") },
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
    const product = await Product.findByIdAndDelete(id);
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    await FifoLayer.deleteMany({ productId: id });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete product") },
      { status: 500 },
    );
  }
}
