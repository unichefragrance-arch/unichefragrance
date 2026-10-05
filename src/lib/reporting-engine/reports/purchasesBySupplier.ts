import { roundMoney } from "@/lib/money";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { PurchaseOrder, Supplier } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/** RPT-05: purchase spend per supplier — ordered vs received vs pending, plus current payable. */
registerReport({
  id: "purchases-by-supplier",
  label: "Purchases by supplier",
  description: "Ordered, received and pending purchase value per supplier, with outstanding payable.",
  category: "purchase",
  branchScoped: true,
  columns: [
    { key: "supplier", label: "Supplier", type: "string" },
    { key: "orders", label: "Orders", type: "number" },
    { key: "ordered", label: "Ordered value", type: "currency" },
    { key: "received", label: "Received value", type: "currency" },
    { key: "pending", label: "Pending value", type: "currency" },
    { key: "payable", label: "Payable (current)", type: "currency" },
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
      .select("supplierId supplierName total lines")
      .lean();

    const bySupplier = new Map<
      string,
      { name: string; orders: number; ordered: number; received: number }
    >();
    for (const po of orders) {
      const key = String(po.supplierId);
      const received = (po.lines || []).reduce(
        (s: number, l: { qtyReceived?: number; unitCost?: number }) =>
          s + (l.qtyReceived || 0) * (l.unitCost || 0),
        0,
      );
      const bucket = bySupplier.get(key) || {
        name: po.supplierName,
        orders: 0,
        ordered: 0,
        received: 0,
      };
      bucket.orders += 1;
      bucket.ordered += po.total;
      bucket.received += received;
      bySupplier.set(key, bucket);
    }

    const suppliers = await Supplier.find({ _id: { $in: Array.from(bySupplier.keys()) } })
      .select("outstanding")
      .lean();
    const payableMap = new Map(suppliers.map((s) => [String(s._id), s.outstanding || 0]));

    const rows: ReportRow[] = Array.from(bySupplier.entries())
      .map(([id, b]) => ({
        supplier: b.name,
        orders: b.orders,
        ordered: roundMoney(b.ordered),
        received: roundMoney(b.received),
        pending: roundMoney((b.ordered - b.received)),
        payable: roundMoney((payableMap.get(id) || 0)),
      }))
      .sort((a, b) => Number(b.ordered) - Number(a.ordered));

    const totals = {
      orders: rows.reduce((s, r) => s + Number(r.orders || 0), 0),
      ordered: roundMoney(rows.reduce((s, r) => s + Number(r.ordered || 0), 0)),
      received: roundMoney(rows.reduce((s, r) => s + Number(r.received || 0), 0)),
      pending: roundMoney(rows.reduce((s, r) => s + Number(r.pending || 0), 0)),
      payable: roundMoney(rows.reduce((s, r) => s + Number(r.payable || 0), 0)),
    };

    return { rows, totals };
  },
});
