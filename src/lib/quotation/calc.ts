import { roundMoney } from "@/lib/money";
export type QuotationCalcLine = {
  qty: number;
  unitPrice: number;
  charges?: number;
};

export function lineAmount(line: QuotationCalcLine): number {
  return line.qty * line.unitPrice + (line.charges || 0);
}

/**
 * B2B quotations quote VAT on top of the line total (unlike POS receipts,
 * where shelf prices are VAT-inclusive) — subtotal + VAT = total.
 */
export function computeQuotationTotals(
  lines: QuotationCalcLine[],
  vatPercent: number,
): { subtotal: number; vatAmount: number; total: number } {
  const subtotal = round2(lines.reduce((sum, line) => sum + lineAmount(line), 0));
  const pct = Math.max(0, Number(vatPercent) || 0);
  const vatAmount = round2(subtotal * (pct / 100));
  const total = round2(subtotal + vatAmount);
  return { subtotal, vatAmount, total };
}

/** Kept for callers; money is rounded to 3 decimals (OMR baisa) — see lib/money. */
export function round2(value: number): number {
  return roundMoney(value);
}
