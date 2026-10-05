import { roundMoney } from "@/lib/money";
import { connectDB } from "@/lib/db";
import { ProductionOrder } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * RPT-09: finished batches — formula, expected vs. actual yield, wastage
 * and material cost. Not branch-scoped: ProductionOrder has no `branchId`
 * in this app (production isn't currently tracked per branch).
 */
registerReport({
  id: "production-batches",
  label: "Production batches",
  description: "Completed production runs — yield, variance, wastage and material cost.",
  category: "production",
  branchScoped: false,
  columns: [
    { key: "batch", label: "Batch", type: "string" },
    { key: "formula", label: "Formula", type: "string" },
    { key: "type", label: "Type", type: "string" },
    { key: "runs", label: "Qty (runs)", type: "number" },
    { key: "expectedYieldMl", label: "Expected yield (ml)", type: "number" },
    { key: "actualYieldMl", label: "Actual yield (ml)", type: "number" },
    { key: "wastageMl", label: "Wastage (ml)", type: "number" },
    { key: "materialCost", label: "Material cost", type: "currency" },
    { key: "completedAt", label: "Completed", type: "date" },
  ],
  async run(_ctx, filters) {
    await connectDB();

    const orders = await ProductionOrder.find({
      status: "completed",
      completedAt: { $gte: filters.from, $lte: filters.to },
    })
      .sort({ completedAt: -1 })
      .lean();

    const rows: ReportRow[] = orders.map((o) => {
      const materialCost =
        o.batch?.totalMaterialCost ??
        (o.consumption || []).reduce(
          (s: number, c: { costTotal?: number }) => s + (c.costTotal || 0),
          0,
        );
      return {
        batch: o.batch?.batchNumber || o.orderNumber,
        formula: o.formulaName,
        type: o.formulaType,
        runs: o.qty,
        expectedYieldMl: o.yieldMl,
        actualYieldMl: o.actualYieldMl ?? null,
        wastageMl: o.wastageMl ?? 0,
        materialCost: roundMoney(materialCost),
        completedAt: o.completedAt ? new Date(o.completedAt).toISOString().slice(0, 10) : null,
      };
    });

    const totals = {
      batches: rows.length,
      wastageMl: rows.reduce((s, r) => s + Number(r.wastageMl || 0), 0),
      materialCost: roundMoney(rows.reduce((s, r) => s + Number(r.materialCost || 0), 0)),
    };

    return { rows, totals };
  },
});
