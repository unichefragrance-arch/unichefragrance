import { roundMoney } from "@/lib/money";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Expense } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * Demo/reference report proving the engine end to end (RPT-08 finance
 * groundwork) — group approved+pending expenses by category for a branch
 * and date range. Not wired into any existing dashboard or route.
 */
registerReport({
  id: "expenses-by-category",
  label: "Expenses by category",
  description: "Total spend per expense category for the selected range and branch.",
  category: "finance",
  branchScoped: true,
  columns: [
    { key: "category", label: "Category", type: "string" },
    { key: "count", label: "Entries", type: "number" },
    { key: "amount", label: "Amount", type: "currency" },
  ],
  async run(_ctx, filters) {
    await connectDB();

    const match: Record<string, unknown> = {
      date: { $gte: filters.from, $lte: filters.to },
      status: { $ne: "rejected" },
    };
    if (filters.branchId && Types.ObjectId.isValid(filters.branchId)) {
      match.branchId = new Types.ObjectId(filters.branchId);
    }

    const grouped = await Expense.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
        },
      },
      { $sort: { amount: -1 } },
    ]);

    const rows: ReportRow[] = grouped.map((g) => ({
      category: g._id || "Uncategorised",
      count: g.count,
      amount: roundMoney(g.amount),
    }));

    const totals = {
      count: rows.reduce((sum, r) => sum + Number(r.count || 0), 0),
      amount: roundMoney(rows.reduce((sum, r) => sum + Number(r.amount || 0), 0)),
    };

    return { rows, totals };
  },
});
