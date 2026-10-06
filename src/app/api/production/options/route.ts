import { NextResponse } from "next/server";
import {
  isFormulaAdminResponse,
  requireFormulaAdmin,
} from "@/lib/auth/formulaAdmin";
import { connectDB } from "@/lib/db";
import { formulaNeedsOilSelection } from "@/lib/production/planProduction";
import { Formula, Product } from "@/lib/models";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

/**
 * Approved formulas + finished-goods SKUs for the production order form.
 * Full recipe ratios are not returned — use /api/production/preview for the plan.
 */
export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const admin = requireFormulaAdmin(req);
    if (isFormulaAdminResponse(admin)) return admin;

    await connectDB();

    const [formulas, outputs, oils] = await Promise.all([
      Formula.find({ status: "approved" })
        .select("name type version yieldMl components customerName")
        .sort({ name: 1 })
        .lean(),
      Product.find({
        itemType: { $nin: ["packaging", "raw"] },
        unit: { $in: ["pcs", "ml", "g", "kg"] },
      })
        .select("name sku unit sellPrice stockSellable itemType category")
        .sort({ name: 1 })
        .limit(500)
        .lean(),
      Product.find({ unit: "ml", itemType: { $ne: "packaging" } })
        .select("name sku unit stockSellable")
        .sort({ name: 1 })
        .limit(300)
        .lean(),
    ]);

    const oilProducts = oils;

    return NextResponse.json({
      formulas: formulas.map((f) => ({
        id: String(f._id),
        name: f.name,
        type: f.type,
        version: typeof f.version === "number" ? f.version : 1,
        yieldMl: f.yieldMl,
        customerName: f.customerName || undefined,
        needsOilSelection: formulaNeedsOilSelection(
          (f.components || []) as Array<{ productId: string }>,
        ),
      })),
      outputProducts: outputs.map((p) => ({
        id: String(p._id),
        name: p.name,
        sku: p.sku,
        unit: p.unit,
        sellPrice: p.sellPrice,
        stockSellable: p.stockSellable,
        itemType: p.itemType,
        category: p.category,
      })),
      oilProducts: oilProducts.map((p) => ({
        id: String(p._id),
        name: p.name,
        sku: p.sku,
        unit: p.unit,
        stockSellable: p.stockSellable,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to load production options"),
      },
      { status: 500 },
    );
  }
}
