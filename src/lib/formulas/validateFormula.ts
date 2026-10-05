import {
  matchRemixRole,
  OIL_BASE_PRODUCT_ID,
  REMIX_OIL_ML,
  REMIX_REQUIRED_ROLES,
  type RemixRole,
  roleLabel,
} from "@/lib/sales/constants";
import type { FormulaComponent, StockUnit } from "@/lib/types";

const UNITS: StockUnit[] = ["ml", "pcs", "g", "kg"];

/** Liquid contribution toward yieldMl (pcs ignored; g≈ml, kg→1000). */
export function liquidMlOf(component: Pick<FormulaComponent, "qty" | "unit">): number {
  const qty = Number(component.qty);
  if (!Number.isFinite(qty)) return 0;
  if (component.unit === "ml" || component.unit === "g") return qty;
  if (component.unit === "kg") return qty * 1000;
  return 0;
}

export function sumLiquidMl(
  components: Pick<FormulaComponent, "qty" | "unit">[],
): number {
  return components.reduce((sum, c) => sum + liquidMlOf(c), 0);
}

export type FormulaValidationInput = {
  name?: string;
  type?: string;
  yieldMl?: number;
  components?: FormulaComponent[];
};

/** Returns human-readable errors; empty = valid. */
export function validateFormulaInput(input: FormulaValidationInput): string[] {
  const errors: string[] = [];
  const name = input.name?.trim() ?? "";
  if (!name) errors.push("Name is required");

  if (!input.type || !["remix", "oil", "bakhoor"].includes(input.type)) {
    errors.push("Type must be remix, oil, or bakhoor");
  }

  const yieldMl = Number(input.yieldMl);
  if (!Number.isFinite(yieldMl) || yieldMl <= 0) {
    errors.push("Yield must be greater than 0 ml");
  }

  const components = input.components ?? [];
  if (components.length === 0) {
    errors.push("Add at least one ingredient");
    return errors;
  }

  components.forEach((c, i) => {
    const n = i + 1;
    if (!c.productId?.trim()) errors.push(`Ingredient #${n}: product is required`);
    if (!c.productName?.trim()) errors.push(`Ingredient #${n}: name is required`);
    const qty = Number(c.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`Ingredient #${n}: quantity must be greater than 0`);
    }
    if (!UNITS.includes(c.unit as StockUnit)) {
      errors.push(`Ingredient #${n}: unit must be ml, g, kg, or pcs`);
    }
  });

  if (errors.length) return errors;

  if (input.type === "remix") {
    const oilBase = components.find((c) => c.productId === OIL_BASE_PRODUCT_ID);
    if (oilBase) {
      // Generic/catalog remix — POS picks the oil at sale time via the placeholder.
      const oilQty = Number(oilBase.qty);
      if (!Number.isFinite(oilQty) || oilQty <= 0 || oilQty !== REMIX_OIL_ML) {
        errors.push(
          `Remix oil-base must be ${REMIX_OIL_ML} ml (BLD-02/03) — got ${oilQty} ml`,
        );
      }
    } else {
      // BLD-08 customer blend — concrete oils in place of the placeholder,
      // must still total the fixed 20 ml (BLD-03), not tola-math.
      const oilMl = components
        .filter((c) => c.unit === "ml" && !matchRemixRole(c.productName))
        .reduce((sum, c) => sum + (Number(c.qty) || 0), 0);
      if (oilMl <= 0) {
        errors.push("Remix requires oil-base or at least one concrete oil ingredient");
      } else if (Math.abs(oilMl - REMIX_OIL_ML) > 0.001) {
        errors.push(
          `Remix oil total must be ${REMIX_OIL_ML} ml (BLD-02/03) — got ${oilMl} ml`,
        );
      }
    }

    // BLD-02: every remix (generic or customer blend) must carry the approved
    // BOM roles (ethanol, bottle, cap, collar, atomizer, pouch) — this is what
    // makes a formula self-contained and production-ready.
    const foundRoles = new Set(
      components
        .map((c) => matchRemixRole(c.productName))
        .filter((r): r is RemixRole => Boolean(r)),
    );
    const missingRoles = REMIX_REQUIRED_ROLES.filter((r) => !foundRoles.has(r));
    if (missingRoles.length) {
      errors.push(
        `Remix formula incomplete: ${missingRoles.map(roleLabel).join(", ")} missing (BLD-02)`,
      );
    }
  }

  const liquid = sumLiquidMl(components);
  if (Math.abs(liquid - yieldMl) > 0.001) {
    errors.push(
      `Liquid total is ${liquid} ml but yield is ${yieldMl} ml — they must match (pcs ignored; g counts as ml, kg × 1000)`,
    );
  }

  return errors;
}
