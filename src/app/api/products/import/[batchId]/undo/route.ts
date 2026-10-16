import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { productsInUse } from "@/lib/inventory/productUsage";
import { FifoLayer, ImportBatch, Product } from "@/lib/models";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ batchId: string }> };

/** A reason to answer without changing anything (the transaction rolls back). */
class UndoRefused extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { batchId } = await ctx.params;

    let deleted = 0;
    let restored = 0;
    // The in-use check and the deletes run in ONE transaction. Before, a
    // purchase receipt (or sale) committing between the check and the deletes
    // was wiped out: its FIFO layers deleted with the product. Now any stock
    // change to these products after the check conflicts with the delete below,
    // the transaction retries, and the fresh check refuses the undo.
    await mongoose.connection.transaction(async (session) => {
      deleted = 0;
      restored = 0;
      const latest = await ImportBatch.findOne({ status: "committed" })
        .sort({ createdAt: -1 })
        .session(session);
      if (!latest || latest.batchId !== batchId) {
        throw new UndoRefused(400, { error: "Only the most recent committed import can be undone" });
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
        const inUse = await productsInUse(createdIds, session);
        if (inUse.size > 0) {
          const names = await Product.find({ _id: { $in: [...inUse] } })
            .select("sku name")
            .session(session)
            .lean<{ sku: string; name: string }[]>();
          throw new UndoRefused(409, {
            error: `This import can't be undone: ${inUse.size} imported product(s) have stock, purchases or sales since the import (${names
              .slice(0, 5)
              .map((n) => n.sku || n.name)
              .join(", ")}${names.length > 5 ? ", …" : ""}). Nothing was changed.`,
            code: "IMPORT_IN_USE",
          });
        }
      }

      // Claim the batch first: a second undo of the same batch running at the
      // same time conflicts here instead of undoing (and reporting) it twice.
      const claimed = await ImportBatch.updateOne(
        { _id: latest._id, status: "committed" },
        { $set: { status: "undone" } },
        { session },
      );
      if (claimed.modifiedCount === 0) {
        throw new UndoRefused(409, { error: "This import was just undone by another request" });
      }

      for (const row of latest.rows) {
        if (row.action === "create" && row.createdProductId) {
          await FifoLayer.deleteMany({ productId: row.createdProductId }, { session });
          await Product.deleteOne({ _id: row.createdProductId }, { session });
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
          const product = await Product.findOne({ sku: snap.sku }).session(session);
          if (!product) continue;
          product.name = snap.name;
          product.category = snap.category;
          // Same rules as the import: unit can't change while the product holds
          // stock, and FIFO cost stays derived from the layers.
          const holdsStock =
            (Number(product.stockSellable) || 0) !== 0 ||
            Boolean(
              await FifoLayer.exists({ productId: product._id, qtyRemaining: { $gt: 0 } }).session(session),
            );
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
          await product.save({ session });
          restored += 1;
        }
      }

      await Product.updateMany({ importBatchId: batchId }, { $set: { importBatchId: null } }, { session });
    });

    return NextResponse.json({
      batchId,
      status: "undone",
      deleted,
      restored,
    });
  } catch (error) {
    if (error instanceof UndoRefused) {
      return NextResponse.json(error.body, { status: error.status });
    }
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to undo import") },
      { status: 500 },
    );
  }
}
