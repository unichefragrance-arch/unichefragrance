import * as XLSX from "xlsx";
import { roundMoney } from "@/lib/money";
import { Sale } from "@/lib/models";
import {
  formatPeriodLabel,
  getPeriodRange,
  type ReportPeriod,
} from "@/lib/reports/period";
import { toJSONList } from "@/lib/serialize";

export type SaleReportStatus = "completed" | "held";

export interface SaleReportRow {
  id: string;
  createdAt: string;
  time: string;
  customer: string;
  customerPhone: string;
  salesperson: string;
  type: string;
  payment: string;
  status: string;
  items: number;
  total: number;
}

export interface SaleReportSummary {
  count: number;
  total: number;
  avgTicket: number;
  byPayment: Record<string, { count: number; total: number }>;
  byType: Record<string, { count: number; total: number }>;
}

export interface SaleReportResult {
  status: SaleReportStatus;
  period: ReportPeriod;
  label: string;
  from: string;
  to: string;
  summary: SaleReportSummary;
  sales: SaleReportRow[];
}

function mapSale(s: Record<string, unknown>): SaleReportRow {
  const createdAt = s.createdAt ? new Date(s.createdAt as string) : new Date();
  const lines = Array.isArray(s.lines) ? s.lines : [];
  const payment =
    typeof s.payment === "string"
      ? s.payment.charAt(0).toUpperCase() + s.payment.slice(1)
      : String(s.payment ?? "");

  return {
    id: String(s.id),
    createdAt: createdAt.toISOString(),
    time: createdAt.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
    customer: String(s.customerName || "Walk-in"),
    customerPhone: String(s.customerPhone || ""),
    salesperson: String(s.salesperson || ""),
    type: String(s.saleType || "Retail"),
    payment,
    status: String(s.status || ""),
    items: lines.length,
    total: Number(s.total || 0),
  };
}

/**
 * Summary over EVERY sale in the range (database aggregation) — not just the
 * rows returned, which are capped by `limit`. Labels match mapSale().
 */
async function summarizeRange(match: Record<string, unknown>): Promise<SaleReportSummary> {
  const groups = await Sale.aggregate<{
    _id: { payment?: unknown; type?: unknown };
    count: number;
    total: number;
  }>([
    // Aggregation skips schema casting (a string branchId would match
    // nothing) — cast the filter exactly as find() does.
    { $match: Sale.find(match).cast(Sale) },
    {
      $group: {
        _id: { payment: "$payment", type: "$saleType" },
        count: { $sum: 1 },
        total: { $sum: { $ifNull: ["$total", 0] } },
      },
    },
  ]);

  const byPayment: SaleReportSummary["byPayment"] = {};
  const byType: SaleReportSummary["byType"] = {};
  let total = 0;
  let count = 0;
  for (const g of groups) {
    const rawPay = typeof g._id.payment === "string" ? g._id.payment : String(g._id.payment ?? "");
    const pay = (rawPay.charAt(0).toUpperCase() + rawPay.slice(1)) || "Unknown";
    const type = String(g._id.type || "Retail");
    total += g.total;
    count += g.count;
    byPayment[pay] = byPayment[pay] || { count: 0, total: 0 };
    byPayment[pay].count += g.count;
    byPayment[pay].total += g.total;
    byType[type] = byType[type] || { count: 0, total: 0 };
    byType[type].count += g.count;
    byType[type].total += g.total;
  }
  for (const bucket of [byPayment, byType]) {
    for (const v of Object.values(bucket)) v.total = roundMoney(v.total);
  }

  return {
    count,
    total: roundMoney(total),
    avgTicket: count ? roundMoney(total / count) : 0,
    byPayment,
    byType,
  };
}

export async function buildSaleReport(opts: {
  status: SaleReportStatus;
  period: ReportPeriod;
  anchor: Date;
  limit?: number;
  /** Branch isolation (auth/guards branchScopeFilter) — null = every branch. */
  branchFilter?: Record<string, unknown> | null;
}): Promise<SaleReportResult> {
  const { start, end } = getPeriodRange(opts.period, opts.anchor);
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);

  const match = {
    status: opts.status,
    createdAt: { $gte: start, $lte: end },
    ...(opts.branchFilter ? { $and: [opts.branchFilter] } : {}),
  };
  const [docs, summary] = await Promise.all([
    Sale.find(match).sort({ createdAt: -1 }).limit(limit).lean(),
    summarizeRange(match),
  ]);

  const sales = toJSONList(docs).map((s) => mapSale(s as Record<string, unknown>));

  return {
    status: opts.status,
    period: opts.period,
    label: formatPeriodLabel(opts.period, start, end),
    from: start.toISOString(),
    to: end.toISOString(),
    summary,
    sales,
  };
}

export function buildSaleReportExcel(report: SaleReportResult): Buffer {
  const wb = XLSX.utils.book_new();
  const title =
    report.status === "completed" ? "Completed Sales" : "Held Bills";

  const summaryRows: (string | number)[][] = [
    ["Report", title],
    ["Period", report.period],
    ["Range", report.label],
    ["From", report.from],
    ["To", report.to],
    ["Bills", report.summary.count],
    ["Total", report.summary.total],
    ["Avg ticket", report.summary.avgTicket],
    [],
    ["Payment", "Count", "Total"],
    ...Object.entries(report.summary.byPayment).map(([k, v]) => [
      k,
      v.count,
      v.total,
    ]),
    [],
    ["Sale type", "Count", "Total"],
    ...Object.entries(report.summary.byType).map(([k, v]) => [
      k,
      v.count,
      v.total,
    ]),
  ];

  const detailRows: (string | number)[][] = [
    [
      "Date",
      "Time",
      "Customer",
      "Phone",
      "Salesperson",
      "Type",
      "Payment",
      "Items",
      "Total",
      "Sale ID",
    ],
    ...report.sales.map((s) => [
      s.createdAt.slice(0, 10),
      s.time,
      s.customer,
      s.customerPhone,
      s.salesperson,
      s.type,
      s.payment,
      s.items,
      s.total,
      s.id,
    ]),
  ];

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  const detailSheet = XLSX.utils.aoa_to_sheet(detailRows);
  detailSheet["!cols"] = [
    { wch: 12 },
    { wch: 8 },
    { wch: 18 },
    { wch: 14 },
    { wch: 14 },
    { wch: 12 },
    { wch: 10 },
    { wch: 8 },
    { wch: 12 },
    { wch: 26 },
  ];

  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");
  XLSX.utils.book_append_sheet(wb, detailSheet, "Bills");
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as ArrayBuffer;
  return Buffer.from(out);
}
