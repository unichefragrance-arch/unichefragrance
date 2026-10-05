/**
 * POS-021: product names are not unique (two "Blue Ocean" SKUs can coexist),
 * so Enter-to-add may only pick a product when its identity is unambiguous.
 * Never resolve by name or list position when more than one product could be
 * meant — the cashier must click the intended card (which carries the DB id).
 */
export type SearchPick<T> =
  | { kind: "pick"; product: T }
  | { kind: "none" }
  | { kind: "ambiguous"; count: number };

export function resolveSearchPick<
  T extends { id: string; name: string; sku: string },
>(results: T[], query: string): SearchPick<T> {
  if (results.length === 0) return { kind: "none" };
  const q = query.trim().toLowerCase();

  // SKU is unique in the schema — an exact SKU is a definitive identity.
  const skuHits = results.filter((p) => p.sku.trim().toLowerCase() === q);
  if (skuHits.length === 1) return { kind: "pick", product: skuHits[0] };

  if (results.length === 1) return { kind: "pick", product: results[0] };

  // Full exact name is only an identity when exactly one product has it.
  const nameHits = results.filter((p) => p.name.trim().toLowerCase() === q);
  if (nameHits.length === 1) return { kind: "pick", product: nameHits[0] };

  return {
    kind: "ambiguous",
    count: nameHits.length > 1 ? nameHits.length : results.length,
  };
}
