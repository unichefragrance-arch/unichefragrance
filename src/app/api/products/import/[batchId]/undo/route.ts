import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { productsInUse } from "@/lib/inventory/productUsage";
import { FifoLayer, ImportBatch, Product } from "@/lib/models";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ batchId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { batchId } = await ctx.params;

    const latest = await ImportBatch.findOne({ status: "committed" }).sort({
      createdAt: -1,
    });
    if (!latest || latest.batchId !== batchId) {
      return NextResponse.json(
        { error: "Only the most recent committed import can be undone" },
        { status: 400 },
      );
    }

    // Import creates products with no stock and no FIFO layers, so a layer,
    // any bucket quantity, or a sale / purchase line on one of them is activity
    // AFTER the import. Deleting those products used to destroy received stock,
    // its cost history and the products that sales still point to. Refuse the
    // whole undo — nothing is deleted — and say which products are in use.
    const createdIds = latest.rows
      .filter((r: { action?: string; createdProductId?: unknown }) => r.action === "create" && r.createdProductId)
      .map((r: { createdProductId: unknown }) => r.createdProductId);
    if (createdIds.length > 0) {
      const inUse = await productsInUse(createdIds);
      if (inUse.size > 0) {
        const names = await Product.find({ _id: { $in: [...inUse] } }).select("sku name").lean<{ sku: string; name: string }[]>();
        return NextResponse.json(
          {
            error: `This import can't be undone: ${inUse.size} imported product(s) have stock, purchases or sales since the import (${names
              .slice(0, 5)
              .map((n) => n.sku || n.name)
              .join(", ")}${names.length > 5 ? ", …" : ""}). Nothing was changed.`,
            code: "IMPORT_IN_USE",
          },
          { status: 409 },
        );
      }
    }

    let deleted = 0;
    let restored = 0;

    for (const row of latest.rows) {
      if (row.action === "create" && row.createdProductId) {
        await FifoLayer.deleteMany({ productId: row.createdProductId });
        await Product.findByIdAndDelete(row.createdProductId);
        deleted += 1;
      } else if (row.action === "update" && row.previousProductSnapshot) {
        const snap = row.previousProductSnapshot as {
          sku: string;
          name: string;
          category: string;
          unit: "ml" | "pcs";
          minMarginPct: number;
          costFifo: number;
          sellPrice: number;
          wholesalePrice?: number;
          brand?: string;
          concentration?: string;
          gender?: string;
          size?: string;
          collection?: string;
          notes?: string;
          itemType?: "finished" | "packaging" | "raw";
        };
        const product = await Product.findOne({ sku: snap.sku });
        if (!product) continue;
        product.name = snap.name;
        product.category = snap.category;
        // Same rules as the import: unit can't change while the product holds
        // stock, and FIFO cost stays derived from the layers.
        const holdsStock =
          (Number(product.stockSellable) || 0) !== 0 ||
          Boolean(await FifoLayer.exists({ productId: product._id, qtyRemaining: { $gt: 0 } }));
        if (!holdsStock) {
          product.unit = snap.unit;
          product.costFifo = snap.costFifo;
        }
        product.minMarginPct = snap.minMarginPct;
        product.sellPrice = snap.sellPrice;
        product.wholesalePrice = snap.wholesalePrice ?? 0;
        product.brand = snap.brand || "";
        product.concentration = snap.concentration || "";
        product.gender = snap.gender || "";
        product.size = snap.size || "";
        product.collection = snap.collection || "";
        product.notes = snap.notes || "";
        product.itemType = snap.itemType || "finished";
        product.importBatchId = null;
        await product.save();
        restored += 1;
      }
    }

    await Product.updateMany({ importBatchId: batchId }, { $set: { importBatchId: null } });
    latest.status = "undone";
    await latest.save();

    return NextResponse.json({
      batchId,
      status: "undone",
      deleted,
      restored,
    });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to undo import") },
      { status: 500 },
    );
  }
}
