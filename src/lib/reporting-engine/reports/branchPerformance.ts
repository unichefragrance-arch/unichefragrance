import { roundMoney } from "@/lib/money";
import { Types } from "mongoose";
import { canAccessAllBranches } from "@/lib/auth/roles";
import { connectDB } from "@/lib/db";
import { Branch, Expense, Sale } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * RPT-13: sales, expenses and profit per branch. Not `branchScoped` in the
 * engine's generic sense — it decides its own branch set: every branch for
 * an all-branch role (owner), otherwise just the caller's own branch, so it
 * degrades to a single row instead of erroring for everyone else. Inventory
 * value is deliberately left out — `Product` has no `branchId` in this app
 * (same reason `inventoryStatus.ts` is not branch-scoped), so a per-branch
 * stock figure would be fabricated.
 */
registerReport({
  id: "branch-performance",
  label: "Branch performance",
  description: "Sales, expenses and profit broken down by branch.",
  category: "branch",
  branchScoped: false,
  columns: [
    { key: "branch", label: "Branch", type: "string" },
    { key: "revenue", label: "Sales revenue", type: "currency" },
    { key: "expenses", label: "Expenses", type: "currency" },
    { key: "profit", label: "Profit", type: "currency" },
  ],
  async run(ctx, filters) {
    await connectDB();

    const branches = canAccessAllBranches(ctx.session.role)
      ? await Branch.find().sort({ name: 1 }).lean()
      : ctx.session.branchId
        ? await Branch.find({ _id: ctx.session.branchId }).lean()
        : [];

    const rows: ReportRow[] = await Promise.all(
      branches.map(async (branch) => {
        const branchId = new Types.ObjectId(String(branch._id));

        const [salesAgg] = await Sale.aggregate([
          {
            $match: {
              status: "completed",
              branchId,
              createdAt: { $gte: filters.from, $lte: filters.to },
            },
          },
          { $group: { _id: null, revenue: { $sum: "$total" } } },
        ]);

        const [expenseAgg] = await Expense.aggregate([
          {
            $match: {
              status: { $ne: "rejected" },
              branchId,
              date: { $gte: filters.from, $lte: filters.to },
            },
          },
          { $group: { _id: null, expenses: { $sum: "$amount" } } },
        ]);

        const revenue = roundMoney((salesAgg?.revenue || 0));
        const expenses = roundMoney((expenseAgg?.expenses || 0));

        return {
          branch: branch.name,
          revenue,
          expenses,
          profit: roundMoney((revenue - expenses)),
        };
      }),
    );

    const totals = {
      revenue: roundMoney(rows.reduce((s, r) => s + Number(r.revenue || 0), 0)),
      expenses: roundMoney(rows.reduce((s, r) => s + Number(r.expenses || 0), 0)),
      profit: roundMoney(rows.reduce((s, r) => s + Number(r.profit || 0), 0)),
    };

    return { rows, totals };
  },
});
