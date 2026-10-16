import type { StockBucket } from "@/lib/types";
import { csvCell } from "@/lib/csvCell";

export type ValuationBucket = StockBucket | "all";

export interface ValuationProductInput {
  id: string;
  sku: string;
  name: string;
  category: string;
  brand?: string;
  unit: string;
  costFifo: number;
  stockSellable: number;
  stockTester: number;
  stockSample: number;
  stockPersonal: number;
  lowStockAt?: number;
}

export interface ValuationProductRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  brand: string;
  unit: string;
  qty: number;
  costFifo: number;
  value: number;
  shareOfCategory: number;
  lowStock: boolean;
}

export interface CategoryValuation {
  category: string;
  skuCount: number;
  qty: number;
  value: number;
  shareOfTotal: number;
  products: ValuationProductRow[];
}

export interface InventoryValuationReport {
  totalValue: number;
  totalSkus: number;
  totalQty: number;
  categoryCount: number;
  highest: CategoryValuation | null;
  lowest: CategoryValuation | null;
  categories: CategoryValuation[];
  generatedAt: string;
  filters: {
    bucket: ValuationBucket;
    category: string | null;
    brand: string | null;
    productId: string | null;
  };
}

export interface ValuationFilterOpts {
  bucket?: ValuationBucket;
  category?: string | null;
  brand?: string | null;
  productId?: string | null;
}

function qtyForBucket(p: ValuationProductInput, bucket: ValuationBucket): number {
  if (bucket === "tester") return Number(p.stockTester) || 0;
  if (bucket === "sample") return Number(p.stockSample) || 0;
  if (bucket === "personal") return Number(p.stockPersonal) || 0;
  if (bucket === "all") {
    return (
      (Number(p.stockSellable) || 0) +
      (Number(p.stockTester) || 0) +
      (Number(p.stockSample) || 0) +
      (Number(p.stockPersonal) || 0)
    );
  }
  return Number(p.stockSellable) || 0;
}

function matchesFilters(
  p: ValuationProductInput,
  opts: ValuationFilterOpts,
): boolean {
  const productId = opts.productId?.trim();
  if (productId && productId !== "All" && p.id !== productId) return false;
  const category = opts.category?.trim();
  if (category && category !== "All" && p.category !== category) return false;
  const brand = opts.brand?.trim();
  if (brand && brand !== "All") {
    const pb = (p.brand || "").trim();
    if (!pb || pb.toLowerCase() !== brand.toLowerCase()) return false;
  }
  return true;
}

/** Build category-wise FIFO inventory valuation from product rows. */
export function buildInventoryValuation(
  products: ValuationProductInput[],
  opts: ValuationFilterOpts = {},
): InventoryValuationReport {
  const bucket: ValuationBucket = opts.bucket ?? "sellable";
  const filtered = products.filter((p) => matchesFilters(p, opts));

  const byCategory = new Map<
    string,
    {
      qty: number;
      value: number;
      products: Omit<ValuationProductRow, "shareOfCategory">[];
    }
  >();

  let totalValue = 0;
  let totalQty = 0;

  for (const p of filtered) {
    const qty = qtyForBucket(p, bucket);
    const cost = Number(p.costFifo) || 0;
    const value = qty * cost;
    totalValue += value;
    totalQty += qty;

    const key = p.category || "Uncategorized";
    const row: Omit<ValuationProductRow, "shareOfCategory"> = {
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: key,
      brand: (p.brand || "").trim(),
      unit: p.unit,
      qty,
      costFifo: cost,
      value,
      lowStock:
        bucket === "sellable" &&
        (p.lowStockAt ?? 0) > 0 &&
        (Number(p.stockSellable) || 0) <= (p.lowStockAt ?? 0),
    };

    const cur = byCategory.get(key);
    if (cur) {
      cur.qty += qty;
      cur.value += value;
      cur.products.push(row);
    } else {
      byCategory.set(key, { qty, value, products: [row] });
    }
  }

  const categories: CategoryValuation[] = [...byCategory.entries()]
    .map(([category, data]) => {
      const products = data.products
        .map((row) => ({
          ...row,
          shareOfCategory: data.value > 0 ? (row.value / data.value) * 100 : 0,
        }))
        .sort((a, b) => b.value - a.value);

      return {
        category,
        skuCount: products.length,
        qty: data.qty,
        value: data.value,
        shareOfTotal: totalValue > 0 ? (data.value / totalValue) * 100 : 0,
        products,
      };
    })
    .sort((a, b) => b.value - a.value);

  const withValue = categories.filter((c) => c.value > 0);
  const highest = withValue[0] ?? categories[0] ?? null;
  const lowest =
    withValue.length > 0
      ? withValue[withValue.length - 1]
      : categories[categories.length - 1] ?? null;

  return {
    totalValue,
    totalSkus: filtered.length,
    totalQty,
    categoryCount: categories.length,
    highest: highest && highest.value > 0 ? highest : null,
    lowest:
      lowest && lowest.value > 0 && lowest.category !== highest?.category
        ? lowest
        : withValue.length > 1
          ? withValue[withValue.length - 1]
          : null,
    categories,
    generatedAt: new Date().toISOString(),
    filters: {
      bucket,
      category: opts.category && opts.category !== "All" ? opts.category : null,
      brand: opts.brand && opts.brand !== "All" ? opts.brand : null,
      productId:
        opts.productId && opts.productId !== "All" ? opts.productId : null,
    },
  };
}

export function buildInventoryValuationCsv(
  report: InventoryValuationReport,
): string {
  const lines: string[] = [
    "Section,Category,SKUs,Qty,Inventory Value,% of Total",
    ...report.categories.map((c) =>
      [
        "Summary",
        csvEscape(c.category),
        c.skuCount,
        Number(c.qty.toFixed(3)),
        Number(c.value.toFixed(3)),
        Number(c.shareOfTotal.toFixed(2)),
      ].join(","),
    ),
    "",
    "Section,Category,SKU,Product,Brand,Unit,Qty,FIFO Cost,Value,% of Category",
    ...report.categories.flatMap((c) =>
      c.products.map((p) =>
        [
          "Detail",
          csvEscape(c.category),
          csvEscape(p.sku),
          csvEscape(p.name),
          csvEscape(p.brand || ""),
          csvEscape(p.unit),
          Number(p.qty.toFixed(3)),
          Number(p.costFifo.toFixed(3)),
          Number(p.value.toFixed(3)),
          Number(p.shareOfCategory.toFixed(2)),
        ].join(","),
      ),
    ),
  ];
  return lines.join("\n");
}

/** Quoting + formula-injection guard shared with the report engine (see lib/csvCell). */
function csvEscape(value: string): string {
  return csvCell(value);
}

export function parseValuationBucket(value: string | null): ValuationBucket {
  if (
    value === "tester" ||
    value === "sample" ||
    value === "personal" ||
    value === "all" ||
    value === "sellable"
  ) {
    return value;
  }
  return "sellable";
}
