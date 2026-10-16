import { timingSafeEqual } from "node:crypto";

/**
 * Price-floor override on product import commit. The password comes from
 * IMPORT_ADMIN_PASSWORD only; when it is unset the override is unavailable
 * (fails closed) — there is no built-in default such as "admin".
 */
export function importOverridePasswordValid(
  password: string | undefined,
  expected: string | undefined = process.env.IMPORT_ADMIN_PASSWORD,
): boolean {
  if (!password || !expected) return false;
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
