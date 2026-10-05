import { addFifoLayer } from "@/lib/inventory";

export type PurchaseLineForFifo = {
  productId: { toString(): string } | string;
  productName: string;
  qtyOrdered: number;
  qtyReceived: number;
  qtyFifoApplied: number;
  unitCost: number;
};

export type PurchaseForFifo = {
  _id?: { toString(): string } | string;
  supplierId: { toString(): string } | string;
  supplierName: string;
  date: Date;
  currency: string;
  lines: PurchaseLineForFifo[];
};

/** Derive PO status from cumulative receive qty on lines. */
export function derivePurchaseStatus(
  lines: Array<{ qtyOrdered: number; qtyReceived: number }>,
  fallback: "draft" | "ordered" | "received" | "partial" = "draft",
): "draft" | "ordered" | "received" | "partial" {
  if (!lines.length) return fallback;
  const anyRecv = lines.some((l) => l.qtyReceived > 0);
  if (!anyRecv) return fallback === "received" || fallback === "partial" ? "ordered" : fallback;
  const allRecv = lines.every((l) => l.qtyReceived >= l.qtyOrdered && l.qtyOrdered > 0);
  return allRecv ? "received" : "partial";
}

/**
 * Create FIFO layers for any newly received qty (qtyReceived − qtyFifoApplied).
 * Mutates line.qtyFifoApplied in place. Returns productIds that got layers.
 *
 * `deps.addFifoLayer` defaults to the real DB-writing implementation; tests
 * inject a stub to verify call args without touching the database.
 */
export async function applyFifoFromPurchase(
  po: PurchaseForFifo,
  deps: { addFifoLayer: typeof addFifoLayer } = { addFifoLayer },
): Promise<string[]> {
  const touched: string[] = [];

  for (const line of po.lines) {
    const target = Math.max(0, Number(line.qtyReceived) || 0);
    const applied = Math.max(0, Number(line.qtyFifoApplied) || 0);
    const delta = target - applied;
    if (delta <= 0) continue;

    const productId = String(line.productId);
    await deps.addFifoLayer({
      productId,
      supplierId: String(po.supplierId),
      supplierName: po.supplierName,
      purchaseDate: po.date instanceof Date ? po.date : new Date(po.date),
      qty: delta,
      unitCost: Number(line.unitCost) || 0,
      currency: po.currency || "OMR",
      purchaseOrderId: po._id ? String(po._id) : null,
    });
    line.qtyFifoApplied = applied + delta;
    touched.push(productId);
  }

  return touched;
}

/** When status is received and lines have no qtyReceived yet, treat ordered qty as fully received. */
export function syncReceivedQtys(
  lines: PurchaseLineForFifo[],
  status: string,
): void {
  if (status !== "received" && status !== "partial") return;
  for (const line of lines) {
    if (status === "received" && (Number(line.qtyReceived) || 0) <= 0) {
      line.qtyReceived = Number(line.qtyOrdered) || 0;
    }
  }
}
