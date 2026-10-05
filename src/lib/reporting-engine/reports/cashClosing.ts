import { roundMoney } from "@/lib/money";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Expense, Sale } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * RPT-08: cash-closing view — sales collected by payment method against
 * expenses paid out, netted to a cash movement figure for the range.
 * Receivables/payables are running balances (Customer.creditBalance /
 * Supplier.outstanding), not range totals, so they're left to the
 * customer/purchase reports rather than mixed in here.
 */
registerReport({
  id: "cash-closing",
  label: "Cash closing",
  description: "Sales collected by payment method vs. expenses paid, netted for the range.",
  category: "finance",
  branchScoped: true,
  columns: [
    { key: "payment", label: "Payment method", type: "string" },
    { key: "count", label: "Sales", type: "number" },
    { key: "amount", label: "Amount", type: "currency" },
  ],
  async run(_ctx, filters) {
    await connectDB();

    const branchFilter =
      filters.branchId && Types.ObjectId.isValid(filters.branchId)
        ? { branchId: new Types.ObjectId(filters.branchId) }
        : {};

    const sales = await Sale.aggregate([
      {
        $match: {
          status: "completed",
          createdAt: { $gte: filters.from, $lte: filters.to },
          ...branchFilter,
        },
      },
      { $group: { _id: "$payment", count: { $sum: 1 }, amount: { $sum: "$total" } } },
      { $sort: { amount: -1 } },
    ]);

    const rows: ReportRow[] = sales.map((g) => ({
      payment: g._id || "Unknown",
      count: g.count,
      amount: roundMoney(g.amount),
    }));

    const grossSales = rows.reduce((s, r) => s + Number(r.amount || 0), 0);

    const expenseAgg = await Expense.aggregate([
      {
        $match: {
          date: { $gte: filters.from, $lte: filters.to },
          status: { $ne: "rejected" },
          ...branchFilter,
        },
      },
      { $group: { _id: null, amount: { $sum: "$amount" } } },
    ]);
    const expenses = expenseAgg[0]?.amount || 0;

    return {
      rows,
      totals: {
        grossSales: roundMoney(grossSales),
        expenses: roundMoney(expenses),
        netCash: roundMoney((grossSales - expenses)),
      },
    };
  },
});
