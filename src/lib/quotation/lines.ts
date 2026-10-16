export type QuotationLineBody = {
  productId?: string;
  name?: string;
  qty?: number;
  unitLabel?: string;
  unitPrice?: number;
  lineType?: string;
  formulaId?: string;
  formulaName?: string;
  packagingProductIds?: string[];
  bottleNote?: string;
  designNote?: string;
  charges?: number;
  notes?: string;
};

const LINE_TYPES = new Set([
  "ready",
  "remix",
  "oil",
  "refill",
  "packaging",
  "wholesale",
  "custom_blend",
]);

/**
 * Unit price must be a finite number ≥ 0 (same rule as QuotationLineSchema
 * `min: 0`). Rejected with a clear message rather than clamped, so a typo
 * never silently becomes a different price on a customer quotation.
 */
function validUnitPrice(value: unknown, lineNo: number): number {
  const price = Number(value ?? 0);
  if (!Number.isFinite(price)) {
    throw new Error(`Line ${lineNo}: unit price must be a number`);
  }
  if (price < 0) {
    throw new Error(`Line ${lineNo}: unit price cannot be negative`);
  }
  return price;
}

/** Server-side normalization — never trust client-provided line shapes as-is. */
export function normalizeQuotationLines(raw: QuotationLineBody[] | undefined) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l, i) => ({
      productId: l.productId || undefined,
      name: String(l.name || "").trim() || "Item",
      qty: Number(l.qty ?? 0),
      unitLabel: String(l.unitLabel || "").trim() || "pcs",
      unitPrice: validUnitPrice(l.unitPrice, i + 1),
      lineType: LINE_TYPES.has(String(l.lineType)) ? String(l.lineType) : "ready",
      formulaId: l.formulaId || undefined,
      formulaName: String(l.formulaName || ""),
      packagingProductIds: Array.isArray(l.packagingProductIds) ? l.packagingProductIds : [],
      bottleNote: String(l.bottleNote || ""),
      designNote: String(l.designNote || ""),
      charges: Math.max(0, Number(l.charges ?? 0)),
      notes: String(l.notes || ""),
    }))
    .filter((l) => l.qty > 0);
}
