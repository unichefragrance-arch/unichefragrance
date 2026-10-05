import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Sale } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * RPT-04: gross profit = revenue − FIFO cost actually consumed
 * (`inventoryDeductions[].costTotal`, recorded per sale at checkout).
 * Revenue is `total`, which is already net of line + invoice discounts
 * (POS-073), so a discount lowers profit and margin here automatically.
 */
registerReport({
  id: "profit-margin-daily",
  label: "Profit & margin (daily)",
  description: "Revenue, FIFO cost, gross profit and margin % per day.",
  category: "profit",
  branchScoped: true,
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "revenue", label: "Revenue", type: "currency" },
    { key: "cost", label: "FIFO cost", type: "currency" },
    { key: "grossProfit", label: "Gross profit", type: "currency" },
    { key: "marginPct", label: "Margin %", type: "percent" },
  ],
  async run(_ctx, filters) {
    await connectDB();

    const match: Record<string, unknown> = {
      status: "completed",
      createdAt: { $gte: filters.from, $lte: filters.to },
    };
    if (filters.branchId && Types.ObjectId.isValid(filters.branchId)) {
      match.branchId = new Types.ObjectId(filters.branchId);
    }

    // Summed per day inside MongoDB (not by loading every sale into Node):
    // day = server-local calendar date, same as toDateInputValue().
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const grouped = await Sale.aggregate<{ _id: string; revenue: number; cost: number }>([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone } },
          revenue: { $sum: "$total" },
          cost: { $sum: { $sum: "$inventoryDeductions.costTotal" } },
        },
      },
    ]);
    const byDay = new Map(grouped.map((g) => [g._id, { revenue: g.revenue, cost: g.cost }]));

    const rows: ReportRow[] = Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { revenue, cost }]) => {
        const grossProfit = revenue - cost;
        return {
          date,
          revenue: Math.round(revenue * 100) / 100,
          cost: Math.round(cost * 100) / 100,
          grossProfit: Math.round(grossProfit * 100) / 100,
          marginPct: revenue > 0 ? Math.round((grossProfit / revenue) * 10000) / 100 : 0,
        };
      });

    const revenue = rows.reduce((s, r) => s + Number(r.revenue || 0), 0);
    const cost = rows.reduce((s, r) => s + Number(r.cost || 0), 0);
    const grossProfit = revenue - cost;

    return {
      rows,
      totals: {
        revenue: Math.round(revenue * 100) / 100,
        cost: Math.round(cost * 100) / 100,
        grossProfit: Math.round(grossProfit * 100) / 100,
        marginPct: revenue > 0 ? Math.round((grossProfit / revenue) * 10000) / 100 : 0,
      },
    };
  },
});
