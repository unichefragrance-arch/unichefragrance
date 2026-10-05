/**
 * POS-068..075: item- and invoice-level discounts.
 * Pure + client-safe (no DB imports) — the POS cart and createSale share this
 * math, so the total the cashier sees is the total the server records.
 */
import type { UserRole } from "@/lib/types";
import { SaleError } from "@/lib/sales/errors";

export type DiscountType = "percent" | "amount";

export type DiscountInput = {
  type: DiscountType;
  value: number;
};

/**
 * Max discount % each role may give without approval (share of the gross
 * amount, checked per line and for the whole bill).
 * PRD-05 is not in the repo — these are placeholders to confirm with the client.
 */
export const DISCOUNT_LIMIT_PCT: Record<UserRole, number> = {
  owner: 100,
  manager: 50,
  branch_manager: 20,
  cashier: 10,
  accountant: 0,
  inventory: 0,
};

export function discountLimitFor(role: UserRole | string | null | undefined): number {
  return DISCOUNT_LIMIT_PCT[role as UserRole] ?? 0;
}

/** OMR has 3 decimals (baisa). */
export function roundMoney(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/** Plain decimal only — no hex ("0x5"), exponent ("5e1"), "Infinity" or units. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Normalise a raw discount from the client. `null` = no discount.
 * Throws INVALID_DISCOUNT for negatives, NaN, >100% or more than the base.
 * Values are rounded to 3 dp (OMR baisa) so what's stored is what's applied;
 * anything that rounds to 0 is no discount.
 */
export function parseDiscount(
  raw: unknown,
  base: number,
  label: string,
): DiscountInput | null {
  if (raw == null) return null;
  if (typeof raw !== "object") {
    throw new SaleError("INVALID_DISCOUNT", `${label}: invalid discount`);
  }
  const { type, value } = raw as { type?: unknown; value?: unknown };
  if (type !== "percent" && type !== "amount") {
    throw new SaleError("INVALID_DISCOUNT", `${label}: discount type must be percent or amount`);
  }
  const num =
    typeof value === "string" && PLAIN_NUMBER.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) {
    throw new SaleError("INVALID_DISCOUNT", `${label}: discount must be a number`);
  }
  if (num < 0) {
    throw new SaleError("INVALID_DISCOUNT", `${label}: discount cannot be negative`);
  }
  if (type === "percent" && num > 100) {
    throw new SaleError("INVALID_DISCOUNT", `${label}: discount cannot exceed 100%`);
  }
  const rounded = roundMoney(num);
  if (type === "amount" && rounded > roundMoney(base)) {
    throw new SaleError(
      "INVALID_DISCOUNT",
      `${label}: discount (${num}) cannot exceed the amount (${roundMoney(base)})`,
    );
  }
  if (rounded === 0) return null;
  return { type, value: rounded };
}

export function discountAmount(discount: DiscountInput | null, base: number): number {
  if (!discount || base <= 0) return 0;
  const amount =
    discount.type === "percent" ? (base * discount.value) / 100 : discount.value;
  return roundMoney(Math.min(base, Math.max(0, amount)));
}

/**
 * Cart-side guard: after a qty drop, a fixed-amount discount may exceed the
 * line — cap it instead of letting checkout reject the bill.
 */
export function clampDiscount(
  discount: DiscountInput | null | undefined,
  base: number,
): DiscountInput | null {
  if (!discount || !(discount.value > 0)) return null;
  if (discount.type === "amount" && discount.value > roundMoney(base)) {
    const capped = roundMoney(Math.max(0, base));
    return capped > 0 ? { type: "amount", value: capped } : null;
  }
  return discount;
}

export type DiscountLineInput = {
  /** qty × unitPrice — the amount a line discount applies to. */
  gross: number;
  discount?: unknown;
};

export type DiscountBreakdown = {
  lines: Array<{
    gross: number;
    discount: DiscountInput | null;
    discountAmount: number;
    net: number;
    /** discountAmount / gross × 100 */
    discountPct: number;
  }>;
  /** Sum of line gross — before any discount. */
  subtotal: number;
  lineDiscountTotal: number;
  invoiceDiscount: DiscountInput | null;
  /** Applied to the subtotal after line discounts. */
  invoiceDiscountAmount: number;
  discountTotal: number;
  total: number;
  /** discountTotal / subtotal × 100 */
  discountPct: number;
  /** Largest of the bill-level and any line-level %, rounded to 2 dp for display. */
  maxDiscountPct: number;
  /** Same, unrounded — what the role limit is checked against (10.004% must exceed 10%). */
  rawMaxDiscountPct: number;
};

function rawPct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

function pct(part: number, whole: number): number {
  return Math.round(rawPct(part, whole) * 100) / 100;
}

/**
 * Line discounts first, then the invoice discount on what remains.
 * `extraGross` covers amounts charged outside qty × unitPrice (refill packaging)
 * — they count toward the subtotal/invoice discount but have no line discount.
 */
export function computeDiscounts(
  lines: DiscountLineInput[],
  invoiceDiscountRaw?: unknown,
  extraGross = 0,
): DiscountBreakdown {
  const out = lines.map((line, i) => {
    const gross = roundMoney(line.gross);
    const parsed = parseDiscount(line.discount, gross, `Line ${i + 1}`);
    const amount = discountAmount(parsed, gross);
    return {
      gross,
      // A % too small to take off a single baisa is no discount at all.
      discount: amount > 0 ? parsed : null,
      discountAmount: amount,
      net: roundMoney(gross - amount),
      discountPct: pct(amount, gross),
      rawPct: rawPct(amount, gross),
    };
  });
  const subtotal = roundMoney(out.reduce((s, l) => s + l.gross, 0) + extraGross);
  const lineDiscountTotal = roundMoney(out.reduce((s, l) => s + l.discountAmount, 0));
  const afterLines = roundMoney(subtotal - lineDiscountTotal);
  const parsedInvoice = parseDiscount(invoiceDiscountRaw, afterLines, "Invoice");
  const invoiceDiscountAmount = discountAmount(parsedInvoice, afterLines);
  const invoiceDiscount = invoiceDiscountAmount > 0 ? parsedInvoice : null;
  const discountTotal = roundMoney(lineDiscountTotal + invoiceDiscountAmount);
  const discountPct = pct(discountTotal, subtotal);
  return {
    lines: out.map(({ rawPct: _raw, ...l }) => l),
    subtotal,
    lineDiscountTotal,
    invoiceDiscount,
    invoiceDiscountAmount,
    discountTotal,
    total: roundMoney(subtotal - discountTotal),
    discountPct,
    maxDiscountPct: Math.max(discountPct, ...out.map((l) => l.discountPct)),
    rawMaxDiscountPct: Math.max(rawPct(discountTotal, subtotal), ...out.map((l) => l.rawPct)),
  };
}

/** Float noise only (e.g. 10.000000000000002 for an exact 10%) — never a real basis point. */
const LIMIT_EPSILON = 1e-9;

export function exceedsDiscountLimit(
  breakdown: Pick<DiscountBreakdown, "rawMaxDiscountPct">,
  role: UserRole | string | null | undefined,
): boolean {
  return breakdown.rawMaxDiscountPct > discountLimitFor(role) + LIMIT_EPSILON;
}
