export const TOLA_ML = 12;
export const HALF_TOLA_ML = 6;
export const QUARTER_TOLA_ML = 3;

/**
 * Intl.NumberFormat inserts a NO-BREAK SPACE (U+00A0) between the currency
 * code and the number — great for prose, but it means "OMR 37,050.00" can
 * never wrap onto a second line. In a narrow stat box that forces the whole
 * box to overflow into its neighbor instead of wrapping. Swap it for a
 * normal space so long amounts can still break and stay inside their box.
 */
function withBreakableSpace(formatted: string): string {
  return formatted.replace(/\u00A0/g, " ");
}

/**
 * Display policy for amounts that are not real numbers (NaN, ±Infinity,
 * undefined/null or a non-numeric string from loose data): show 0 — the same
 * rule as roundMoney / moneyText in lib/money and money() on receipts — so a
 * screen never shows "OMRNaN" or "OMR ∞". Numeric strings ("12.5") still format.
 */
function displayAmount(amount: unknown): number {
  const n = typeof amount === "number" ? amount : Number(amount);
  return Number.isFinite(n) ? n : 0;
}

export function formatMoney(amount: number, currency = "OMR"): string {
  return withBreakableSpace(
    new Intl.NumberFormat("en-OM", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 3,
    }).format(displayAmount(amount)),
  );
}

/** Short form for tight chart labels, e.g. "OMR 6.2K" instead of "OMR 6,200.00". */
export function formatMoneyCompact(amount: number, currency = "OMR"): string {
  return withBreakableSpace(
    new Intl.NumberFormat("en-OM", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(displayAmount(amount)),
  );
}

export function formatQty(qty: number, unit: string): string {
  const value = Number.isInteger(qty) ? qty.toString() : qty.toFixed(3);
  return `${value} ${unit}`;
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

export function formatPhone(phone: string): string {
  return phone;
}

export function tolaToMl(unit: "tola" | "half_tola" | "quarter_tola"): number {
  if (unit === "tola") return TOLA_ML;
  if (unit === "half_tola") return HALF_TOLA_ML;
  return QUARTER_TOLA_ML;
}

const TOLA_LABEL_ML: Record<string, number> = {
  "1 tola": TOLA_ML,
  tola: TOLA_ML,
  "full tola": TOLA_ML,
  "1tola": TOLA_ML,
  "½ tola": HALF_TOLA_ML,
  "1/2 tola": HALF_TOLA_ML,
  "half tola": HALF_TOLA_ML,
  "half-tola": HALF_TOLA_ML,
  "¼ tola": QUARTER_TOLA_ML,
  "1/4 tola": QUARTER_TOLA_ML,
  "quarter tola": QUARTER_TOLA_ML,
  "quarter-tola": QUARTER_TOLA_ML,
};

/**
 * Approved individual-oil sizes only: ¼ / ½ / 1 tola → 3 / 6 / 12 ml.
 * Whole-label match, so "1½ Tola", "2 Tola" or "7 ml" are NOT oil sizes (→ null).
 */
export function resolveOilTolaMl(unitLabel?: string): number | null {
  if (!unitLabel?.trim()) return null;
  const t = unitLabel.trim().toLowerCase().replace(/\s+/g, " ");
  return TOLA_LABEL_ML[t] ?? null;
}

/**
 * Backend-owned oil/refill ml from unitLabel — never trust client deductMl.
 * Supports: 1 Tola / ½ Tola / ¼ Tola, and explicit "N ml" labels (e.g. refill).
 */
export function resolveDeductMlFromUnitLabel(unitLabel?: string): number | null {
  if (!unitLabel?.trim()) return null;
  const tola = resolveOilTolaMl(unitLabel);
  if (tola != null) return tola;
  const t = unitLabel.trim().toLowerCase().replace(/\s+/g, " ");
  // A tola fraction that is not an exact approved label (e.g. "1½ Tola") is
  // ambiguous — never fall through to a partial match.
  if (/tola/.test(t)) return null;

  const mlMatch = t.match(/(\d+(?:\.\d+)?)\s*ml\b/);
  if (mlMatch) {
    const ml = Number(mlMatch[1]);
    if (Number.isFinite(ml) && ml > 0) return ml;
  }
  return null;
}

export function marginPct(sell: number, cost: number): number {
  if (sell <= 0) return 0;
  return ((sell - cost) / sell) * 100;
}

export function clsx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
