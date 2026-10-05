import { roundMoney } from "@/lib/money";
import { connectDB } from "@/lib/db";
import { Customer } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * RPT-06: customer snapshot — not date-scoped, ignores `filters.from/to`.
 * Not branch-scoped: Customer has no `branchId` in this app.
 */
registerReport({
  id: "customers-overview",
  label: "Customers overview",
  description: "Customer list with lifetime purchases, credit balance and last visit.",
  category: "customer",
  branchScoped: false,
  columns: [
    { key: "name", label: "Customer", type: "string" },
    { key: "phone", label: "Phone", type: "string" },
    { key: "totalPurchases", label: "Total purchases", type: "currency" },
    { key: "creditBalance", label: "Credit balance", type: "currency" },
    { key: "lastVisit", label: "Last visit", type: "date" },
    { key: "customFormula", label: "Custom formula", type: "string" },
  ],
  async run(_ctx, filters) {
    await connectDB();

    const limit = Number(filters.extra.limit || 200);
    const customers = await Customer.find()
      .sort({ totalPurchases: -1 })
      .limit(Math.min(limit, 1000))
      .lean();

    const rows: ReportRow[] = customers.map((c) => ({
      name: c.name,
      phone: c.phone,
      totalPurchases: roundMoney((c.totalPurchases || 0)),
      creditBalance: roundMoney((c.creditBalance || 0)),
      lastVisit: c.lastVisit ? new Date(c.lastVisit).toISOString().slice(0, 10) : null,
      customFormula: c.hasCustomFormula ? "Yes" : "No",
    }));

    const totals = {
      customers: rows.length,
      totalPurchases: roundMoney(rows.reduce((s, r) => s + Number(r.totalPurchases || 0), 0)),
      creditBalance: roundMoney(rows.reduce((s, r) => s + Number(r.creditBalance || 0), 0)),
    };

    return { rows, totals };
  },
});
