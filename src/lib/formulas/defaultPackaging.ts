import { Formula } from "@/lib/models";
import {
  matchRemixRole,
  OIL_BASE_PRODUCT_ID,
  REMIX_COMPONENT_ROLES,
} from "@/lib/sales/constants";
import type { FormulaComponent } from "@/lib/types";

type TemplateLean = { components: FormulaComponent[] } | null;

/**
 * BLD-02/BLD-08: a new customer blend (concrete oils, no oil-base
 * placeholder) that's missing packaging lines gets them copied once from
 * the canonical default remix template, so the saved formula is
 * self-contained — a one-time snapshot at creation, not a live runtime
 * dependency on that template ever again.
 */
export async function fillDefaultRemixPackaging(
  components: FormulaComponent[],
): Promise<FormulaComponent[]> {
  const hasOilBase = components.some((c) => c.productId === OIL_BASE_PRODUCT_ID);
  if (hasOilBase) return components; // generic template formulas are built explicitly

  const foundRoles = new Set(
    components.map((c) => matchRemixRole(c.productName)).filter(Boolean),
  );
  // Copy every packaging/fill role the template has (required + optional).
  const missingRoles = REMIX_COMPONENT_ROLES.filter((r) => !foundRoles.has(r));
  if (!missingRoles.length) return components;

  const template = await Formula.findOne({
    type: "remix",
    status: "approved",
    $or: [{ customerId: null }, { customerId: { $exists: false } }],
  })
    .sort({ updatedAt: -1 })
    .lean<TemplateLean>();
  if (!template) return components;

  const filled = [...components];
  for (const role of missingRoles) {
    const match = template.components.find(
      (c) =>
        c.productId !== OIL_BASE_PRODUCT_ID && matchRemixRole(c.productName) === role,
    );
    if (match) filled.push({ ...match });
  }
  return filled;
}
