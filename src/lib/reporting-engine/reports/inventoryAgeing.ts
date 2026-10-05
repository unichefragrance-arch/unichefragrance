import { roundMoney } from "@/lib/money";
import { connectDB } from "@/lib/db";
import { FifoLayer, Product } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * RPT-03 ageing: how long remaining FIFO stock has been sitting, by layer.
 * Not date-range scoped (a snapshot of what's on hand today) and not
 * branch-scoped — FifoLayer has no `branchId` in this app.
 */
registerReport({
  id: "inventory-ageing",
  label: "Inventory ageing",
  description: "Remaining FIFO layers sorted by age, with days on hand and tied-up value.",
  category: "inventory",
  branchScoped: false,
  columns: [
    { key: "product", label: "Product", type: "string" },
    { key: "supplier", label: "Supplier", type: "string" },
    { key: "purchaseDate", label: "Purchase date", type: "date" },
    { key: "ageDays", label: "Age (days)", type: "number" },
    { key: "qtyRemaining", label: "Qty remaining", type: "number" },
    { key: "value", label: "Value", type: "currency" },
  ],
  async run(_ctx, filters) {
    await connectDB();

    const minAgeDays = Number(filters.extra.minAgeDays || 0);

    const layers = await FifoLayer.find({ qtyRemaining: { $gt: 0 } })
      .sort({ purchaseDate: 1 })
      .lean();

    const productIds = Array.from(new Set(layers.map((l) => String(l.productId))));
    const products = await Product.find({ _id: { $in: productIds } })
      .select("name sku")
      .lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const now = Date.now();
    const rows: ReportRow[] = layers
      .map((l) => {
        const product = productMap.get(String(l.productId));
        const ageDays = Math.floor((now - new Date(l.purchaseDate).getTime()) / 86_400_000);
        return {
          product: product ? `${product.name} (${product.sku})` : "Unknown product",
          supplier: l.supplierName,
          purchaseDate: new Date(l.purchaseDate).toISOString().slice(0, 10),
          ageDays,
          qtyRemaining: l.qtyRemaining,
          value: roundMoney(l.qtyRemaining * l.unitCost),
        };
      })
      .filter((r) => r.ageDays >= minAgeDays)
      .sort((a, b) => b.ageDays - a.ageDays);

    const totals = {
      layers: rows.length,
      qtyRemaining: rows.reduce((s, r) => s + Number(r.qtyRemaining || 0), 0),
      value: roundMoney(rows.reduce((s, r) => s + Number(r.value || 0), 0)),
    };

    return { rows, totals };
  },
});
