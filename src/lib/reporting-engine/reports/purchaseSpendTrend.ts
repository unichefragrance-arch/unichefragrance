import { roundMoney } from "@/lib/money";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { PurchaseOrder } from "@/lib/models";
import { toDateInputValue } from "@/lib/reports/period";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * RPT-05b: daily purchase spend trend — ordered vs received vs pending
 * value per day, the tabular/exportable counterpart to the
 * `PurchaseSpendTrendChart` dashboard widget.
 */
registerReport({
  id: "purchase-spend-trend",
  label: "Purchase spend trend",
  description: "Ordered, received and pending purchase value per day.",
  category: "purchase",
  branchScoped: true,
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "orders", label: "Orders", type: "number" },
    { key: "ordered", label: "Ordered value", type: "currency" },
    { key: "received", label: "Received value", type: "currency" },
    { key: "pending", label: "Pending value", type: "currency" },
  ],
  async run(_ctx, filters) {
    await connectDB();

    const match: Record<string, unknown> = {
      date: { $gte: filters.from, $lte: filters.to },
      status: { $ne: "draft" },
    };
    if (filters.branchId && Types.ObjectId.isValid(filters.branchId)) {
      match.branchId = new Types.ObjectId(filters.branchId);
    }

    const orders = await PurchaseOrder.find(match)
      .select("date total lines")
      .lean();

    const byDay = new Map<string, { orders: number; ordered: number; received: number }>();
    for (const po of orders) {
      const day = toDateInputValue(new Date(po.date));
      const received = (po.lines || []).reduce(
        (s: number, l: { qtyReceived?: number; unitCost?: number }) =>
          s + (l.qtyReceived || 0) * (l.unitCost || 0),
        0,
      );
      const bucket = byDay.get(day) || { orders: 0, ordered: 0, received: 0 };
      bucket.orders += 1;
      bucket.ordered += po.total;
      bucket.received += received;
      byDay.set(day, bucket);
    }

    const rows: ReportRow[] = Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, b]) => ({
        date,
        orders: b.orders,
        ordered: roundMoney(b.ordered),
        received: roundMoney(b.received),
        pending: roundMoney((b.ordered - b.received)),
      }));

    const totals = {
      orders: rows.reduce((s, r) => s + Number(r.orders || 0), 0),
      ordered: roundMoney(rows.reduce((s, r) => s + Number(r.ordered || 0), 0)),
      received: roundMoney(rows.reduce((s, r) => s + Number(r.received || 0), 0)),
      pending: roundMoney(rows.reduce((s, r) => s + Number(r.pending || 0), 0)),
    };

    return { rows, totals };
  },
});
