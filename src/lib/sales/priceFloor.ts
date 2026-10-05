/**
 * POS-060..067: minimum selling price. A line sold for less than its cost plus
 * the minimum margin of the product being sold needs Admin (owner) approval.
 * floor = (Σ component qty × costFifo) × (1 + line product's minMarginPct / 100)
 * — the same rule the product import applies (excel/validate.ts priceFloorOk).
 * For a remix the margin is the Remix product's, not each oil / bottle's own
 * retail margin. Selling exactly at the floor is allowed.
 */
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { Product } from "@/lib/models";
import { roundMoney, type DiscountBreakdown } from "@/lib/sales/discount";
import type { SaleValidationResult } from "@/lib/sales/validateSale";
import type { UserRole } from "@/lib/types";

/** Admin in the client's role naming (see auth/roles.ts). */
export const PRICE_FLOOR_APPROVER_ROLE: UserRole = "owner";

export type FloorCost = {
  costFifo: number;
  minMarginPct: number;
  /** Charged on top of the line for refill packaging. */
  sellPrice: number;
};

export type PriceFloorViolation = {
  lineIndex: number;
  name: string;
  /** What the line actually brings in, after line + share of invoice discount. */
  revenue: number;
  floor: number;
};

function num(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Pure: final per-line revenue vs. its floor. The invoice discount is spread
 * over lines in proportion to what each line brings in after its own discount.
 * Lines whose components have no recorded cost have no floor.
 */
export function findPriceFloorViolations(
  validated: Pick<SaleValidationResult, "lines" | "deductions">,
  breakdown: DiscountBreakdown,
  costs: Map<string, FloorCost>,
): PriceFloorViolation[] {
  const afterLines = breakdown.subtotal - breakdown.lineDiscountTotal;
  const keep = afterLines > 0 ? (afterLines - breakdown.invoiceDiscountAmount) / afterLines : 0;

  const violations: PriceFloorViolation[] = [];
  validated.lines.forEach((line, i) => {
    let cost = 0;
    let extra = 0;
    for (const d of validated.deductions) {
      if (d.lineIndex !== i) continue;
      const c = costs.get(d.productId);
      if (!c) continue;
      cost += d.qty * Math.max(0, num(c.costFifo));
      if (d.reason === "refill:packaging") extra += d.qty * num(c.sellPrice);
    }
    if (cost <= 0) return;
    const margin = Math.max(0, num(costs.get(line.productId ?? "")?.minMarginPct));
    const floor = cost * (1 + margin / 100);
    const revenue = roundMoney(((breakdown.lines[i]?.net ?? 0) + extra) * keep);
    if (revenue < roundMoney(floor)) {
      violations.push({ lineIndex: i, name: line.name, revenue, floor: roundMoney(floor) });
    }
  });
  return violations;
}

/** Loads current cost + margin for every product the sale deducts. */
export async function checkPriceFloor(
  validated: Pick<SaleValidationResult, "lines" | "deductions">,
  breakdown: DiscountBreakdown,
): Promise<PriceFloorViolation[]> {
  // Components for cost, plus each line's own product for its margin (a remix
  // product is priced but never deducted).
  const ids = [
    ...new Set([
      ...validated.deductions.map((d) => d.productId),
      ...validated.lines.flatMap((l) => (l.productId ? [l.productId] : [])),
    ]),
  ].filter((id) => mongoose.isValidObjectId(id));
  if (ids.length === 0) return [];
  await connectDB();
  const products = await Product.find({ _id: { $in: ids } })
    .select("costFifo minMarginPct sellPrice")
    .lean<Array<{ _id: unknown } & FloorCost>>();
  const costs = new Map(products.map((p) => [String(p._id), p]));
  return findPriceFloorViolations(validated, breakdown, costs);
}

export function priceFloorMessage(violations: PriceFloorViolation[]): string {
  const [v] = violations;
  const more = violations.length > 1 ? ` (+${violations.length - 1} more)` : "";
  return `${v.name} would sell for ${v.revenue.toFixed(3)}, below its minimum of ${v.floor.toFixed(3)}${more} — Admin approval required`;
}

/** The actor is the Admin themselves, or someone who needs an Admin to approve. */
export function needsAdminForFloor(
  violations: PriceFloorViolation[],
  role: UserRole | string | null | undefined,
): boolean {
  return violations.length > 0 && role !== PRICE_FLOOR_APPROVER_ROLE;
}
