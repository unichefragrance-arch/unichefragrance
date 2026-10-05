import * as XLSX from "xlsx";
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

function summarize(sales: SaleReportRow[]): SaleReportSummary {
  const byPayment: SaleReportSummary["byPayment"] = {};
  const byType: SaleReportSummary["byType"] = {};
  let total = 0;

  for (const sale of sales) {
    total += sale.total;
    const pay = sale.payment || "Unknown";
    const type = sale.type || "Retail";
    byPayment[pay] = byPayment[pay] || { count: 0, total: 0 };
    byPayment[pay].count += 1;
    byPayment[pay].total += sale.total;
    byType[type] = byType[type] || { count: 0, total: 0 };
    byType[type].count += 1;
    byType[type].total += sale.total;
  }

  return {
    count: sales.length,
    total,
    avgTicket: sales.length ? total / sales.length : 0,
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

  const docs = await Sale.find({
    status: opts.status,
    createdAt: { $gte: start, $lte: end },
    ...(opts.branchFilter ? { $and: [opts.branchFilter] } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const sales = toJSONList(docs).map((s) => mapSale(s as Record<string, unknown>));

  return {
    status: opts.status,
    period: opts.period,
    label: formatPeriodLabel(opts.period, start, end),
    from: start.toISOString(),
    to: end.toISOString(),
    summary: summarize(sales),
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
