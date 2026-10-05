import { roundMoney } from "@/lib/money";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Sale } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/** RPT-02: sales totals per salesperson/cashier for the selected range and branch. */
registerReport({
  id: "sales-by-salesperson",
  label: "Sales by salesperson",
  description: "Completed sale count and revenue per salesperson for the selected range.",
  category: "sales",
  branchScoped: true,
  columns: [
    { key: "salesperson", label: "Salesperson", type: "string" },
    { key: "count", label: "Sales", type: "number" },
    { key: "revenue", label: "Revenue", type: "currency" },
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

    const grouped = await Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$salesperson",
          count: { $sum: 1 },
          revenue: { $sum: "$total" },
        },
      },
      { $sort: { revenue: -1 } },
    ]);

    const rows: ReportRow[] = grouped.map((g) => ({
      salesperson: g._id || "Unassigned",
      count: g.count,
      revenue: roundMoney(g.revenue),
    }));

    const totals = {
      count: rows.reduce((s, r) => s + Number(r.count || 0), 0),
      revenue: roundMoney(rows.reduce((s, r) => s + Number(r.revenue || 0), 0)),
    };

    return { rows, totals };
  },
});
