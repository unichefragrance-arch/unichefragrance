import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { connectDB } from "@/lib/db";
import { parseProductSheet } from "@/lib/excel/parse";
import {
  validateImportRows,
  type ExistingProductRef,
} from "@/lib/excel/validate";
import { AppSettings, ImportBatch, Product } from "@/lib/models";
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

export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    // Not multipart (e.g. a JSON body) → formData() throws; that's a bad request.
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const rawRows = parseProductSheet(buffer);
    if (rawRows.length === 0) {
      return NextResponse.json(
        { error: "No product rows found in Excel file" },
        { status: 400 },
      );
    }

    const products = await Product.find().lean();
    const existing = products.map((p) =>
      mapExisting(p as Parameters<typeof mapExisting>[0]),
    );
    const validated = validateImportRows(rawRows, existing, {
      allowPriceFloorOverride: false,
    });

    const created = validated.filter((r) => r.action === "create").length;
    const updated = validated.filter((r) => r.action === "update").length;
    const failed = validated.filter((r) => r.action === "error").length;
    const priceFloorCount = validated.filter((r) => r.priceFloorViolation).length;

    const settings = await AppSettings.findOne({ key: "default" }).lean();
    const userName =
      (settings as { currentUserName?: string } | null)?.currentUserName ||
      "System";

    const batchId = `IMP-${randomUUID().slice(0, 8).toUpperCase()}`;
    const batch = await ImportBatch.create({
      batchId,
      userName,
      fileName: file.name || "upload.xlsx",
      status: "staged",
      total: validated.length,
      created,
      updated,
      failed,
      priceFloorCount,
      rawRows,
      rows: validated.map((r) => ({
        rowNumber: r.rowNumber,
        action: r.action,
        sku: r.sku,
        payload: r.payload || null,
        errorReason: r.errorReason || "",
        previousProductSnapshot: r.previousProductSnapshot || null,
        priceFloorViolation: r.priceFloorViolation || false,
      })),
    });

    return NextResponse.json({
      batchId: batch.batchId,
      fileName: batch.fileName,
      status: batch.status,
      total: batch.total,
      created: batch.created,
      updated: batch.updated,
      failed: batch.failed,
      priceFloorCount: batch.priceFloorCount,
      rows: batch.rows.map((r: {
        rowNumber: number;
        action: string;
        sku: string;
        errorReason?: string;
        priceFloorViolation?: boolean;
        payload?: unknown;
      }) => ({
        rowNumber: r.rowNumber,
        action: r.action,
        sku: r.sku,
        errorReason: r.errorReason,
        priceFloorViolation: r.priceFloorViolation,
        payload: r.payload,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to stage import") },
      { status: 500 },
    );
  }
}
