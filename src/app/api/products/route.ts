import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { defaultLowStockAt } from "@/lib/inventory/stockCheck";
import { setSellableStock, StockAdjustmentError } from "@/lib/inventory/stockAdjustment";
import { Product } from "@/lib/models";
import { escapeRegex } from "@/lib/phone";
import { toJSON, toJSONList } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { canViewCostPrices, redactCostFields } from "@/lib/auth/roles";

const COST_FIELDS = ["wholesalePrice", "costFifo", "minMarginPct"];

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q")?.trim();
    const category = searchParams.get("category");
    const filter: Record<string, unknown> = {};
    if (category && category !== "All") filter.category = category;
    if (q) {
      // Search text is literal: "(" or "*" must not be read as regex syntax.
      const safe = escapeRegex(q);
      filter.$or = [
        { name: { $regex: safe, $options: "i" } },
        { sku: { $regex: safe, $options: "i" } },
        { category: { $regex: safe, $options: "i" } },
      ];
    }
    const products = await Product.find(filter).sort({ name: 1 }).lean();
    let list = toJSONList(products);
    if (access && !canViewCostPrices(access.role)) {
      list = list.map((p) => redactCostFields(p, COST_FIELDS));
    }
    return NextResponse.json(list);
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load products") },
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
    // ALT-01: apply default low-stock thresholds when omitted
    if (
      body.lowStockAt === undefined ||
      body.lowStockAt === null ||
      body.lowStockAt === ""
    ) {
      body.lowStockAt = defaultLowStockAt({
        unit: String(body.unit || "pcs"),
        category: body.category,
        itemType: body.itemType,
        name: body.name,
      });
    }
    // Opening stock is booked as a FIFO layer at the given cost — never a bare
    // number — so stockSellable always equals the FIFO total.
    const { stockSellable: opening, costFifo, ...rest } = body as Record<string, unknown>;
    const openingQty = Number(opening) || 0;
    if (openingQty < 0) {
      return NextResponse.json({ error: "Opening stock can't be negative" }, { status: 400 });
    }
    const created = await Product.create({ ...rest, stockSellable: 0, costFifo: Number(costFifo) || 0 });
    if (openingQty > 0) {
      try {
        await setSellableStock({
          product: created.toObject(),
          target: openingQty,
          createdBy: access?.name,
          branchId: access?.branchId,
          branchName: access?.branchName,
          notes: "Opening stock",
        });
      } catch (err) {
        await Product.deleteOne({ _id: created._id });
        if (err instanceof StockAdjustmentError) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
        throw err;
      }
    }
    const product = (await Product.findById(created._id)) ?? created;
    return NextResponse.json(toJSON(product), { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create product") },
      { status: 400 },
    );
  }
}
