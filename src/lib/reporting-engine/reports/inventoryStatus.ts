import { roundMoney } from "@/lib/money";
import { connectDB } from "@/lib/db";
import { Product } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * RPT-03: current stock snapshot — not date-scoped, ignores `filters.from/to`.
 * Not branch-scoped: Product stock is a single central pool in this app
 * (no `branchId` on the Product schema).
 */
registerReport({
  id: "inventory-status",
  label: "Inventory status",
  description: "Available/tester/sample stock, low-stock flag, and FIFO valuation per product.",
  category: "inventory",
  branchScoped: false,
  columns: [
    { key: "sku", label: "SKU", type: "string" },
    { key: "product", label: "Product", type: "string" },
    { key: "category", label: "Category", type: "string" },
    { key: "available", label: "Available", type: "number" },
    { key: "tester", label: "Tester", type: "number" },
    { key: "status", label: "Status", type: "string" },
    { key: "valuation", label: "Stock value", type: "currency" },
  ],
  async run(_ctx, filters) {
    await connectDB();

    const query: Record<string, unknown> = {};
    if (filters.extra.category) query.category = filters.extra.category;
    if (filters.extra.lowOnly === "1") {
      query.$expr = { $lte: ["$stockSellable", "$lowStockAt"] };
      query.lowStockAt = { $gt: 0 };
    }

    const products = await Product.find(query).sort({ name: 1 }).lean();

    const rows: ReportRow[] = products.map((p) => {
      const low = p.lowStockAt > 0 && p.stockSellable <= p.lowStockAt;
      return {
        sku: p.sku,
        product: p.name,
        category: p.category,
        available: p.stockSellable,
        tester: p.stockTester,
        status: p.stockSellable === 0 ? "Out of stock" : low ? "Low stock" : "OK",
        valuation: roundMoney(p.stockSellable * p.costFifo),
      };
    });

    const totals = {
      products: rows.length,
      lowStockCount: rows.filter((r) => r.status !== "OK").length,
      valuation: roundMoney(rows.reduce((s, r) => s + Number(r.valuation || 0), 0)),
    };

    return { rows, totals };
  },
});
