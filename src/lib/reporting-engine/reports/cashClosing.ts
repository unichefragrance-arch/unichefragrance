import { roundMoney } from "@/lib/money";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Expense } from "@/lib/models";
import { salesByTender } from "@/lib/reports/tenders";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * RPT-08: cash-closing view — what each tender brought in, and the cash that
 * should be in the drawer: cash taken (including the cash part of mixed
 * payments) less expenses. Card and bank are settled outside the drawer;
 * credit is a receivable, not money collected. Expenses carry no payment
 * method and are treated as paid from the drawer.
 * Receivables/payables are running balances (Customer.creditBalance /
 * Supplier.outstanding), not range totals, so they're left to the
 * customer/purchase reports rather than mixed in here.
 */
registerReport({
  id: "cash-closing",
  label: "Cash closing",
  description: "Takings by payment method (mixed split into its parts) and net cash in the drawer after expenses.",
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

    const sales = await salesByTender({
      status: "completed",
      createdAt: { $gte: filters.from, $lte: filters.to },
      ...branchFilter,
    });

    const expenseAgg = await Expense.aggregate([
      {
        $match: {
          date: { $gte: filters.from, $lte: filters.to },
          status: { $ne: "rejected" },
          ...branchFilter,
        },
      },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]);
    const expenses = roundMoney(expenseAgg[0]?.amount || 0);
    const expenseCount = expenseAgg[0]?.count || 0;

    const t = sales.byTender;
    const netCash = roundMoney(t.cash.amount - expenses);
    const rows: ReportRow[] = [
      { payment: "Cash", count: t.cash.count, amount: t.cash.amount },
      { payment: "Card", count: t.card.count, amount: t.card.amount },
      { payment: "Bank transfer", count: t.bank.count, amount: t.bank.amount },
      { payment: "Credit (not collected)", count: t.credit.count, amount: t.credit.amount },
      ...(t.mixed.count > 0
        ? [{ payment: "Mixed (no breakdown — not in cash)", count: t.mixed.count, amount: t.mixed.amount }]
        : []),
      { payment: "Gross sales", count: sales.saleCount, amount: sales.grossSales },
      { payment: "Expenses paid", count: expenseCount, amount: roundMoney(-expenses) },
      { payment: "Net cash in drawer (cash − expenses)", count: null, amount: netCash },
    ];

    return {
      rows,
      totals: {
        grossSales: sales.grossSales,
        cashCollected: t.cash.amount,
        cardAndBank: roundMoney(t.card.amount + t.bank.amount),
        creditSales: t.credit.amount,
        expenses,
        netCash,
      },
    };
  },
});
