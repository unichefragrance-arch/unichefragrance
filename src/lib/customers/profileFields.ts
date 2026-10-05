/**
 * CRM profile fields staff may set when creating or editing a customer.
 * Money and history — creditBalance, totalPurchases, lastVisit — are never
 * client-writable: they change only through sales (and, once POS-06 defines
 * them, audited payments/refunds). Anything else in the body is ignored, so
 * the edit form can keep sending the whole customer object.
 */
const STRING_FIELDS = ["name", "phone", "email", "address", "vatNumber", "notes"] as const;
const LIST_FIELDS = ["productsRequested", "preferences"] as const;

export function customerProfileFields(body: unknown): Record<string, unknown> {
  const src = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of STRING_FIELDS) {
    if (src[key] === undefined) continue;
    out[key] = src[key] == null ? "" : String(src[key]).trim();
  }
  for (const key of LIST_FIELDS) {
    if (src[key] === undefined) continue;
    out[key] = Array.isArray(src[key])
      ? (src[key] as unknown[]).map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];
  }
  if (typeof src.hasCustomFormula === "boolean") out.hasCustomFormula = src.hasCustomFormula;
  return out;
}
