import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import type { ExcelProductRow } from "@/lib/excel/columns";
import {
  generatedSku,
  nextSkuSeq,
  validateImportRows,
  type ExistingProductRef,
} from "@/lib/excel/validate";
import { ImportBatch, Product } from "@/lib/models";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

export const runtime = "nodejs";

function mapExisting(p: {
  _id: { toString(): string };
  sku: string;
  name: string;
  category: string;
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
  itemType?: string;
  unit: string;
}): ExistingProductRef {
  return {
    id: p._id.toString(),
    sku: p.sku,
    name: p.name,
    category: p.category,
    minMarginPct: p.minMarginPct,
    costFifo: p.costFifo,
    sellPrice: p.sellPrice,
    wholesalePrice: p.wholesalePrice,
    brand: p.brand,
    concentration: p.concentration,
    gender: p.gender,
    size: p.size,
    collection: p.collection,
    notes: p.notes,
    itemType: p.itemType,
    unit: p.unit,
  };
}

function checkAdminPassword(password: string | undefined): boolean {
  const expected = process.env.IMPORT_ADMIN_PASSWORD || "admin";
  return Boolean(password) && password === expected;
}

export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    }
    const batchId = String(body.batchId || "");
    const adminOverride = Boolean(body.adminOverride);
    const strictMode = body.strictMode !== false;
    const adminPassword = body.adminPassword as string | undefined;

    if (!batchId) {
      return NextResponse.json({ error: "batchId is required" }, { status: 400 });
    }

    const batch = await ImportBatch.findOne({ batchId });
    if (!batch) {
      return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
    }
    if (batch.status !== "staged") {
      return NextResponse.json(
        { error: `Batch is already ${batch.status}` },
        { status: 400 },
      );
    }

    if (adminOverride && !checkAdminPassword(adminPassword)) {
      return NextResponse.json(
        { error: "Invalid admin password for price-floor override" },
        { status: 403 },
      );
    }

    let rows = batch.rows;
    if (adminOverride && Array.isArray(batch.rawRows) && batch.rawRows.length > 0) {
      const products = await Product.find().lean();
      const existing = products.map((p) =>
        mapExisting(p as Parameters<typeof mapExisting>[0]),
      );
      const revalidated = validateImportRows(
        batch.rawRows as ExcelProductRow[],
        existing,
        { allowPriceFloorOverride: true },
      );
      batch.rows = revalidated.map((r) => ({
        rowNumber: r.rowNumber,
        action: r.action,
        sku: r.sku,
        payload: r.payload || null,
        errorReason: r.errorReason || "",
        previousProductSnapshot: r.previousProductSnapshot || null,
        priceFloorViolation: r.priceFloorViolation || false,
      }));
      batch.created = revalidated.filter((r) => r.action === "create").length;
      batch.updated = revalidated.filter((r) => r.action === "update").length;
      batch.failed = revalidated.filter((r) => r.action === "error").length;
      batch.priceFloorCount = revalidated.filter((r) => r.priceFloorViolation).length;
      rows = batch.rows;
    }

    const failedRows = rows
      .filter((r: { action: string }) => r.action === "error")
      .map(
        (r: { rowNumber: number; sku?: string; errorReason?: string }) => ({
          rowNumber: r.rowNumber,
          sku: r.sku || "",
          reason: r.errorReason || "Invalid row",
        }),
      );

    if (strictMode && failedRows.length > 0) {
      return NextResponse.json(
        {
          error:
            "Import blocked in Safe Mode. Fix the listed rows and upload again.",
          strictMode: true,
          failedRows,
        },
        { status: 400 },
      );
    }

    let createdCount = 0;
    let updatedCount = 0;

    let nextSeq: number | null = null;

    // A failed earlier attempt may have written some rows already; progress is
    // saved on the batch so a retry skips/adopts them instead of duplicating.
    try {
      for (const row of rows) {
        if (row.action === "error" || !row.payload) continue;
        const payload = row.payload as Record<string, unknown>;

        if (row.action === "create") {
          if (row.createdProductId) {
            createdCount += 1;
            continue;
          }
          const clash = await Product.findOne({ sku: String(payload.sku) });
          if (clash && clash.importBatchId === batchId) {
            row.createdProductId = clash._id;
            createdCount += 1;
            continue;
          }
          if (clash) {
            // SKU was taken after staging — hand out the next free generated one.
            if (nextSeq == null) {
              const all = await Product.find({}, { sku: 1 }).lean();
              nextSeq = nextSkuSeq(all.map((p) => String(p.sku)));
            }
            let sku: string;
            do {
              sku = generatedSku(String(payload.category), nextSeq);
              nextSeq += 1;
            } while (await Product.exists({ sku }));
            payload.sku = sku;
            row.sku = sku;
            row.payload = { ...payload };
          }
          const created = await Product.create({
            ...payload,
            stockSellable: 0,
            stockTester: 0,
            stockSample: 0,
            stockPersonal: 0,
            lowStockAt: 0,
            importBatchId: batchId,
          });
          row.createdProductId = created._id;
          createdCount += 1;
        } else if (row.action === "update") {
          const sku = String(payload.sku);
          const existing = await Product.findOne({ sku });
          if (!existing) continue;
          // On retry the product already holds this batch's values; keep the original snapshot.
          if (existing.importBatchId !== batchId) {
            row.previousProductSnapshot = {
              id: existing._id.toString(),
              sku: existing.sku,
              name: existing.name,
              category: existing.category,
              minMarginPct: existing.minMarginPct,
              costFifo: existing.costFifo,
              sellPrice: existing.sellPrice,
              wholesalePrice: existing.wholesalePrice,
              brand: existing.brand,
              concentration: existing.concentration,
              gender: existing.gender,
              size: existing.size,
              collection: existing.collection,
              notes: existing.notes,
              itemType: existing.itemType,
              unit: existing.unit,
            };
          }
          existing.name = String(payload.name);
          existing.category = String(payload.category);
          existing.unit = payload.unit as "ml" | "pcs";
          existing.brand = String(payload.brand || "");
          existing.concentration = String(payload.concentration || "");
          existing.costFifo = Number(payload.costFifo);
          existing.sellPrice = Number(payload.sellPrice);
          existing.wholesalePrice = Number(payload.wholesalePrice || 0);
          existing.gender = String(payload.gender || "");
          existing.size = String(payload.size || "");
          existing.collection = String(payload.collection || "");
          existing.notes = String(payload.notes || "");
          existing.itemType = payload.itemType as "finished" | "packaging" | "raw";
          existing.importBatchId = batchId;
          await existing.save();
          updatedCount += 1;
        }
      }
    } catch (error) {
      batch.markModified("rows");
      await batch.save().catch(() => {});
      throw error;
    }

    batch.markModified("rows");
    batch.status = "committed";
    batch.created = createdCount;
    batch.updated = updatedCount;
    batch.failed = rows.filter((r: { action: string }) => r.action === "error").length;
    await batch.save();

    return NextResponse.json({
      batchId: batch.batchId,
      status: batch.status,
      created: batch.created,
      updated: batch.updated,
      failed: batch.failed,
      priceFloorCount: batch.priceFloorCount,
      strictMode,
    });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to commit import") },
      { status: 500 },
    );
  }
}
