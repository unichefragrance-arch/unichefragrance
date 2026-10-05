/**
 * Shared rounding for stored and reported amounts. OMR (and the other Gulf
 * dinars/rials) use 3 decimals (baisa/fils) — rounding money to 2 decimals
 * drops real baisa and makes report totals drift from the sales they sum.
 * Client-safe (no DB imports).
 */
export const MONEY_DECIMALS = 3;

export function roundMoney(n: number): number {
  const v = Number.isFinite(n) ? n : 0;
  return Math.round((v + Number.EPSILON) * 1000) / 1000;
}

/** Quantities (ml / g / pcs) — same 3-decimal precision as Settings → qtyPrecision. */
export function roundQty(n: number): number {
  return roundMoney(n);
}

/** "OMR 12.345" — fixed decimals for plain-text alerts and messages. */
export function moneyText(n: number, currency = "OMR"): string {
  return `${currency} ${(Number.isFinite(n) ? n : 0).toFixed(MONEY_DECIMALS)}`;
}
