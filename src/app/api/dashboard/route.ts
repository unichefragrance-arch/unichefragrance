import { moneyText, roundMoney } from "@/lib/money";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Customer, Expense, Product, Sale, Supplier } from "@/lib/models";
import { salesByTender } from "@/lib/reports/tenders";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { hasPermission } from "@/lib/auth/roles";
import { ownBranchMatch } from "@/lib/auth/guards";
import type { AppSession } from "@/lib/auth/session";

/** Revenue + recorded FIFO cost (inventoryDeductions[].costTotal), summed in MongoDB. */
async function revenueAndFifoCost(match: Record<string, unknown>) {
  const [row] = await Sale.aggregate<{ revenue: number; cost: number }>([
    { $match: match },
    {
      $group: {
        _id: null,
        revenue: { $sum: "$total" },
        cost: { $sum: { $sum: "$inventoryDeductions.costTotal" } },
      },
    },
  ]);
  return { revenue: row?.revenue ?? 0, cost: row?.cost ?? 0 };
}

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    // requireApiAccess only checks the coarse dashboard:read permission that
    // every role holds — scope the actual payload to each field's own
    // permission so e.g. accountant (no inventory:read/pos:read) never
    // receives stock levels or sales figures in the response body.
    const session = access as AppSession;
    const canPos = hasPermission(session.role, "pos:read");
    const canInventory = hasPermission(session.role, "inventory:read");
    const canReports = hasPermission(session.role, "reports:read");
    const canExpenses = hasPermission(session.role, "expenses:read");

    await connectDB();

    // Non-owner roles are pinned to their own branch, matching how the
    // reporting engine scopes its queries (src/lib/reporting-engine/access.ts).
    const branchFilter = ownBranchMatch(session);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // Today's widgets are aggregated inside MongoDB ($facet) — loading every
    // sale into Node made this endpoint (and, via event-loop stalls, the POS
    // checkout queue) scale badly with sales volume.
    type TodayFacet = {
      totals: { total: number; count: number; remix: number }[];
      payments: { _id: string; amount: number; count: number }[];
      products: { _id: string; qty: number; revenue: number; unit: string | null }[];
      recent: { _id: unknown; createdAt: Date; customerName: string; saleType: string; total: number; payment: string }[];
    };
    const [today] = await Sale.aggregate<TodayFacet>([
      { $match: { status: "completed", createdAt: { $gte: startOfToday }, ...branchFilter } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: "$total" },
                count: { $sum: 1 },
                remix: { $sum: { $cond: [{ $eq: ["$saleType", "Remix"] }, 1, 0] } },
              },
            },
          ],
          payments: [{ $group: { _id: "$payment", amount: { $sum: "$total" }, count: { $sum: 1 } } }],
          products: [
            { $unwind: "$lines" },
            {
              $group: {
                _id: "$lines.name",
                qty: { $sum: "$lines.qty" },
                revenue: { $sum: { $multiply: ["$lines.qty", "$lines.unitPrice"] } },
                unit: { $first: "$lines.unitLabel" },
              },
            },
            { $sort: { revenue: -1 } },
            { $limit: 6 },
          ],
          recent: [
            { $sort: { createdAt: -1 } },
            { $limit: 8 },
            { $project: { createdAt: 1, customerName: 1, saleType: 1, total: 1, payment: 1 } },
          ],
        },
      },
    ]);

    const todayTotal = today?.totals[0]?.total ?? 0;
    const remixCount = today?.totals[0]?.remix ?? 0;
    const transactionsToday = today?.totals[0]?.count ?? 0;
    const avgSaleValue =
      transactionsToday > 0
        ? roundMoney((todayTotal / transactionsToday))
        : 0;

    // POS dashboard charts — how today's till is being paid, and what's
    // actually moving off the shelf, at the front desk / cashier level.
    const paymentMix = (today?.payments ?? [])
      .map(({ _id: method, amount, count }) => ({
        method: String(method).charAt(0).toUpperCase() + String(method).slice(1),
        amount: roundMoney(amount),
        count,
      }))
      .sort((a, b) => b.amount - a.amount);
    const topProductsToday = (today?.products ?? []).map(({ _id: name, qty, revenue, unit }) => ({
      name,
      qty: Math.round(qty * 1000) / 1000,
      unit: unit || "",
      revenue: roundMoney(revenue),
    }));

    // Only the fields the widgets read — this runs over the whole catalogue.
    const products = await Product.find()
      .select("name unit category stockSellable costFifo lowStockAt lastSoldAt")
      .lean<{ _id: unknown; name: string; unit: string; category: string; stockSellable: number; costFifo: number; lowStockAt: number; lastSoldAt?: Date }[]>();
    const fifoValue = products.reduce(
      (s, p) => s + p.stockSellable * p.costFifo,
      0,
    );
    const lowStock = products.filter(
      (p) => p.lowStockAt > 0 && p.stockSellable <= p.lowStockAt,
    );

    // Inventory dashboard charts — stock value grouped by category (folded to
    // "Other" past the top N so the bar chart stays readable) and a
    // healthy/low/out split for the stock-health donut.
    const categoryTotals = new Map<string, { value: number; count: number }>();
    for (const p of products) {
      const entry = categoryTotals.get(p.category) || { value: 0, count: 0 };
      entry.value += p.stockSellable * p.costFifo;
      entry.count += 1;
      categoryTotals.set(p.category, entry);
    }
    const categoryRows = Array.from(categoryTotals.entries())
      .map(([category, { value, count }]) => ({
        category,
        value: roundMoney(value),
        count,
      }))
      .sort((a, b) => b.value - a.value);

    const TOP_CATEGORIES = 6;
    const stockByCategory =
      categoryRows.length <= TOP_CATEGORIES
        ? categoryRows
        : [
            ...categoryRows.slice(0, TOP_CATEGORIES - 1),
            categoryRows.slice(TOP_CATEGORIES - 1).reduce(
              (acc, row) => ({
                category: "Other",
                value: roundMoney((acc.value + row.value)),
                count: acc.count + row.count,
              }),
              { category: "Other", value: 0, count: 0 },
            ),
          ];

    const outOfStockCount = products.filter((p) => p.stockSellable === 0).length;
    const lowNotOutCount = products.filter(
      (p) =>
        p.stockSellable > 0 && p.lowStockAt > 0 && p.stockSellable <= p.lowStockAt,
    ).length;
    const stockHealth = {
      healthy: products.length - outOfStockCount - lowNotOutCount,
      low: lowNotOutCount,
      out: outOfStockCount,
    };

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 6);
    weekAgo.setHours(0, 0, 0, 0);

    // Per local day × sale type, summed in MongoDB (server time zone, same
    // calendar days as the setHours() boundaries this used before).
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const weekRows = await Sale.aggregate<{ _id: { day: string; type: string }; total: number }>([
      { $match: { status: "completed", createdAt: { $gte: weekAgo }, ...branchFilter } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone } },
            type: "$saleType",
          },
          total: { $sum: "$total" },
        },
      },
    ]);
    const dayKey = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const sumFor = (day: string, types: string[]) =>
      weekRows
        .filter((r) => r._id.day === day && types.includes(r._id.type))
        .reduce((sum, r) => sum + r.total, 0);

    const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const salesTrend = Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(weekAgo);
      d.setDate(weekAgo.getDate() + i);
      const key = dayKey(d);
      return {
        label: labels[d.getDay()],
        retail: sumFor(key, ["Retail", "Mixed"]),
        wholesale: sumFor(key, ["Wholesale"]),
        remix: sumFor(key, ["Remix", "Oil", "Refill"]),
      };
    });

    const weekTotal = weekRows.reduce((s, r) => s + r.total, 0);

    // Accountant-facing financial widgets — mirror the reporting engine's
    // cash-closing / expenses-by-category / profit-margin / credit-follow-up
    // aggregations (src/lib/reporting-engine/reports/*.ts) rather than
    // introducing new query logic.
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    type ExpenseRow = { amount: number; category: string; status?: string };
    const todayExpenses = await Expense.find({
      date: { $gte: startOfToday },
      ...branchFilter,
    }).select("amount category status").lean<ExpenseRow[]>();
    const todayExpenseTotal = todayExpenses.reduce((s, e) => s + e.amount, 0);

    const monthExpenses = await Expense.find({
      date: { $gte: startOfMonth },
      ...branchFilter,
    }).select("amount category").lean<ExpenseRow[]>();
    const monthExpenseTotal = monthExpenses.reduce((s, e) => s + e.amount, 0);

    const expenseCategoryTotals = new Map<string, number>();
    for (const e of monthExpenses) {
      expenseCategoryTotals.set(
        e.category,
        (expenseCategoryTotals.get(e.category) || 0) + e.amount,
      );
    }
    const expenseByCategory = Array.from(expenseCategoryTotals.entries())
      .map(([category, amount]) => ({
        category,
        amount: roundMoney(amount),
      }))
      .sort((a, b) => b.amount - a.amount);

    const { revenue: monthRevenue, cost: monthCost } = await revenueAndFifoCost({
      status: "completed",
      createdAt: { $gte: startOfMonth },
      ...branchFilter,
    });
    const grossProfit = roundMoney((monthRevenue - monthCost));
    const netProfit = roundMoney((grossProfit - monthExpenseTotal));
    // Replaces the old hardcoded 42.6 stub — both margins now move with
    // actual sales/cost/expense data instead of showing a fixed number.
    const grossMarginPct =
      monthRevenue > 0 ? Math.round((grossProfit / monthRevenue) * 10000) / 100 : 0;
    const netProfitMarginPct =
      monthRevenue > 0 ? Math.round((netProfit / monthRevenue) * 10000) / 100 : 0;

    // Prior month, same math, purely for the trend badges on the margin
    // rings — real month-over-month comparison, not a placeholder delta.
    const startOfLastMonth = new Date(startOfMonth);
    startOfLastMonth.setMonth(startOfMonth.getMonth() - 1);
    const endOfLastMonth = new Date(startOfMonth.getTime() - 1);

    const { revenue: lastMonthRevenue, cost: lastMonthCost } = await revenueAndFifoCost({
      status: "completed",
      createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth },
      ...branchFilter,
    });
    const lastMonthExpenses = await Expense.find({
      date: { $gte: startOfLastMonth, $lte: endOfLastMonth },
      ...branchFilter,
    }).select("amount").lean<ExpenseRow[]>();
    const lastMonthExpenseTotal = lastMonthExpenses.reduce((s, e) => s + e.amount, 0);
    const lastMonthGrossProfit = lastMonthRevenue - lastMonthCost;
    const lastMonthNetProfit = lastMonthGrossProfit - lastMonthExpenseTotal;
    const lastMonthGrossMarginPct =
      lastMonthRevenue > 0 ? (lastMonthGrossProfit / lastMonthRevenue) * 100 : 0;
    const lastMonthNetProfitMarginPct =
      lastMonthRevenue > 0 ? (lastMonthNetProfit / lastMonthRevenue) * 100 : 0;

    const grossMarginTrendPts = Math.round((grossMarginPct - lastMonthGrossMarginPct) * 100) / 100;
    const netMarginTrendPts =
      Math.round((netProfitMarginPct - lastMonthNetProfitMarginPct) * 100) / 100;

    // Customer.creditBalance / Supplier.outstanding are running balances, not
    // per-invoice open items — no due dates exist yet, so this is a total,
    // not an aged AR/AP report (see reporting-engine's cashClosing.ts note).
    const receivableCustomers = await Customer.find({
      creditBalance: { $gt: 0 },
    })
      .sort({ creditBalance: -1 })
      .select("name creditBalance")
      .lean<{ _id: unknown; name: string; creditBalance?: number }[]>();
    const accountsReceivable = roundMoney(
      receivableCustomers.reduce((s, c) => s + (c.creditBalance || 0), 0),
    );
    const topReceivables = receivableCustomers.slice(0, 5).map((c) => ({
      id: String(c._id),
      name: c.name,
      balance: roundMoney((c.creditBalance || 0)),
    }));

    const payableSuppliers = await Supplier.find({
      outstanding: { $gt: 0 },
    })
      .sort({ outstanding: -1 })
      .select("name outstanding")
      .lean<{ _id: unknown; name: string; outstanding?: number }[]>();
    const accountsPayable = roundMoney(
      payableSuppliers.reduce((s, sup) => s + (sup.outstanding || 0), 0),
    );
    const topPayables = payableSuppliers.slice(0, 5).map((sup) => ({
      id: String(sup._id),
      name: sup.name,
      balance: roundMoney((sup.outstanding || 0)),
    }));

    // Cash in the drawer: cash taken today (incl. the cash part of mixed
    // payments) less today's expenses — card/bank/credit never reach it.
    const todayTenders = await salesByTender({
      status: "completed",
      createdAt: { $gte: startOfToday },
      ...branchFilter,
    });
    const todayPaidExpenses = todayExpenses
      .filter((e) => e.status !== "rejected")
      .reduce((s, e) => s + e.amount, 0);
    const netCash = roundMoney(todayTenders.byTender.cash.amount - todayPaidExpenses);

    const alerts = [
      ...(canInventory
        ? [
            ...lowStock.map((p) => ({
              id: `low-${p._id}`,
              type: "low_stock" as const,
              title: `${p.name} below threshold`,
              detail: `${p.stockSellable} ${p.unit} remaining — threshold ${p.lowStockAt} ${p.unit}`,
              severity:
                p.stockSellable === 0
                  ? ("critical" as const)
                  : p.stockSellable <= p.lowStockAt * 0.5
                    ? ("critical" as const)
                    : ("warning" as const),
            })),
            ...products
              .filter((p) => {
                if (!p.lastSoldAt) return false;
                const days =
                  (Date.now() - new Date(p.lastSoldAt).getTime()) /
                  (1000 * 60 * 60 * 24);
                return days > 30 && p.stockSellable > 0;
              })
              .slice(0, 3)
              .map((p) => ({
                id: `dead-${p._id}`,
                type: "dead_stock" as const,
                title: `${p.name} slow movement`,
                detail: `No sale in 30+ days — review pricing`,
                severity: "info" as const,
              })),
          ]
        : []),
      ...(canReports
        ? [
            {
              id: "weekly-report",
              type: "report" as const,
              title: "Weekly sales report ready",
              detail: `Last 7 days · ${moneyText(weekTotal)} total`,
              severity: "info" as const,
            },
          ]
        : []),
      ...(canExpenses
        ? [
            ...(accountsReceivable > 0
              ? [
                  {
                    id: "receivables-summary",
                    type: "receivables" as const,
                    title: `${receivableCustomers.length} customer${receivableCustomers.length === 1 ? "" : "s"} with outstanding balance`,
                    detail: `${moneyText(accountsReceivable)} total receivable`,
                    severity: "warning" as const,
                  },
                ]
              : []),
            ...(accountsPayable > 0
              ? [
                  {
                    id: "payables-summary",
                    type: "payables" as const,
                    title: `${payableSuppliers.length} supplier${payableSuppliers.length === 1 ? "" : "s"} with outstanding balance`,
                    detail: `${moneyText(accountsPayable)} total payable`,
                    severity: "warning" as const,
                  },
                ]
              : []),
          ]
        : []),
    ];

    const recentSales = (today?.recent ?? []).map((s) => ({
        id: String(s._id),
        time: s.createdAt.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
        customer: s.customerName,
        type: s.saleType,
        total: s.total,
        payment:
          s.payment.charAt(0).toUpperCase() + s.payment.slice(1),
      }));

    return NextResponse.json({
      stats: {
        ...(canPos && {
          todaySales: todayTotal,
          remixSales: remixCount,
          transactionsToday,
          avgSaleValue,
        }),
        ...(canReports && { grossMarginPct, grossMarginTrendPts, weekTotal }),
        ...(canInventory && {
          lowStockCount: lowStock.length,
          fifoValue,
          productCount: products.length,
        }),
        ...(canExpenses && {
          todayExpenseTotal,
          monthExpenseTotal,
          grossProfit,
          netProfit,
          netProfitMarginPct,
          netMarginTrendPts,
          accountsReceivable,
          accountsPayable,
          netCash,
        }),
      },
      ...(canPos && { salesTrend, recentSales, paymentMix, topProductsToday }),
      alerts,
      ...(canInventory && {
        lowStock: [...lowStock]
          .sort((a, b) => a.stockSellable / a.lowStockAt - b.stockSellable / b.lowStockAt)
          .map((p) => ({
            id: String(p._id),
            name: p.name,
            stockSellable: p.stockSellable,
            lowStockAt: p.lowStockAt,
            unit: p.unit,
          })),
        stockByCategory,
        stockHealth,
      }),
      ...(canExpenses && {
        expenseByCategory,
        topReceivables,
        topPayables,
      }),
    });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load dashboard") },
      { status: 500 },
    );
  }
}
