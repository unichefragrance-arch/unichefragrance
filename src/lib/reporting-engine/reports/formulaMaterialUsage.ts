import { roundMoney, roundQty } from "@/lib/money";
import { connectDB } from "@/lib/db";
import { Product, ProductionOrder } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * RPT-10: raw-material consumption and cost per formula, sourced from
 * completed production batches' `consumption[]` (same source data as
 * `productionBatches.ts`). Not branch-scoped: `ProductionOrder` has no
 * `branchId` in this app.
 */
registerReport({
  id: "formula-material-usage",
  label: "Formula material usage",
  description: "Raw materials consumed per formula, with quantity and cost.",
  category: "production",
  branchScoped: false,
  columns: [
    { key: "formula", label: "Formula", type: "string" },
    { key: "material", label: "Material", type: "string" },
    { key: "unit", label: "Unit", type: "string" },
    { key: "qty", label: "Qty consumed", type: "number" },
    { key: "cost", label: "Cost", type: "currency" },
  ],
  async run(_ctx, filters) {
    await connectDB();

    const grouped = await ProductionOrder.aggregate([
      {
        $match: {
          status: "completed",
          completedAt: { $gte: filters.from, $lte: filters.to },
        },
      },
      { $unwind: "$consumption" },
      {
        $lookup: {
          from: Product.collection.name,
          localField: "consumption.productId",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { formula: "$formulaName", material: "$consumption.productName" },
          unit: { $first: "$product.unit" },
          qty: { $sum: "$consumption.qty" },
          cost: { $sum: "$consumption.costTotal" },
        },
      },
      { $sort: { cost: -1 } },
    ]);

    const rows: ReportRow[] = grouped.map((g) => ({
      formula: g._id.formula || "—",
      material: g._id.material || "—",
      unit: g.unit || "—",
      qty: roundQty(g.qty),
      cost: roundMoney(g.cost),
    }));

    const totals = {
      qty: roundQty(rows.reduce((s, r) => s + Number(r.qty || 0), 0)),
      cost: roundMoney(rows.reduce((s, r) => s + Number(r.cost || 0), 0)),
    };

    return { rows, totals };
  },
});
