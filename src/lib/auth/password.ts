import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "crypto";

const KEYLEN = 64;

/** Store as `scrypt$<salt>$<hash>` (base64url). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, KEYLEN).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(
  password: string,
  stored: string | undefined | null,
): boolean {
  if (!password || !stored) return false;
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  try {
    const computed = scryptSync(password, salt, KEYLEN);
    const expected = Buffer.from(hash, "base64url");
    if (computed.length !== expected.length) return false;
    return timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

const scryptAsync = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, KEYLEN, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** Same check as verifyPassword, off the event loop — for hot request paths. */
export async function verifyPasswordAsync(
  password: string,
  stored: string | undefined | null,
): Promise<boolean> {
  if (!password || !stored) return false;
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  try {
    const computed = await scryptAsync(password, salt);
    const expected = Buffer.from(hash, "base64url");
    if (computed.length !== expected.length) return false;
    return timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}
