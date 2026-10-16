import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { cookieFromRequest, getSessionFromRequest } from "@/lib/auth/session";

/** BLD-04: formula confidentiality — Admin-only recipe access. */
export const FORMULA_ADMIN_COOKIE = "unich_formula_admin";

const COOKIE_MAX_AGE_SEC = 60 * 60 * 8; // 8 hours

export type FormulaAdminSession = {
  name: string;
  email: string;
  exp: number;
};

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function adminPassword(): string {
  return (
    process.env.ADMIN_PASSWORD ||
    process.env.FORMULA_ADMIN_PASSWORD ||
    process.env.IMPORT_ADMIN_PASSWORD ||
    ""
  );
}

function adminEmail(): string {
  return (
    process.env.ADMIN_EMAIL ||
    process.env.admin_email ||
    ""
  )
    .trim()
    .toLowerCase();
}

function sessionSecret(): string {
  const secret =
    process.env.FORMULA_ADMIN_SECRET ||
    process.env.ADMIN_PASSWORD ||
    process.env.FORMULA_ADMIN_PASSWORD ||
    process.env.IMPORT_ADMIN_PASSWORD ||
    process.env.SESSION_SECRET;
  if (secret) return secret;
  // A known default would let anyone forge the formula-admin cookie.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "FORMULA_ADMIN_SECRET is not set. Refusing to sign formula-admin cookies with an insecure default in production.",
    );
  }
  return "unich-formula-dev-secret";
}

export function getConfiguredAdminEmail(): string {
  return adminEmail();
}

/** Verify email + password against .env (ADMIN_EMAIL + ADMIN_PASSWORD). */
export function verifyFormulaAdminCredentials(input: {
  email?: string;
  password?: string;
}): boolean {
  const expectedEmail = adminEmail();
  const expectedPassword = adminPassword();
  if (!expectedEmail || !expectedPassword) return false;

  const email = (input.email || "").trim().toLowerCase();
  const password = input.password || "";
  if (!email || !password) return false;

  return safeEqual(email, expectedEmail) && safeEqual(password, expectedPassword);
}

/** @deprecated prefer verifyFormulaAdminCredentials */
export function verifyFormulaAdminPassword(password: string | undefined): boolean {
  const expected = adminPassword();
  if (!password || !expected) return false;
  return safeEqual(password, expected);
}

function signPayload(payloadB64: string): string {
  return createHmac("sha256", sessionSecret()).update(payloadB64).digest("base64url");
}

export function createFormulaAdminToken(name: string, email: string): string {
  const session: FormulaAdminSession = {
    name: name.trim() || "Admin",
    email: email.trim().toLowerCase(),
    exp: Date.now() + COOKIE_MAX_AGE_SEC * 1000,
  };
  const payloadB64 = Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url",
  );
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

export function parseFormulaAdminToken(
  token: string | undefined | null,
): FormulaAdminSession | null {
  if (!token) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expected = signPayload(payloadB64);
  if (!safeEqual(sig, expected)) return null;
  try {
    const session = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as FormulaAdminSession;
    if (!session?.name || typeof session.exp !== "number") return null;
    if (session.exp < Date.now()) return null;
    return {
      name: session.name,
      email: session.email || "",
      exp: session.exp,
    };
  } catch {
    return null;
  }
}

/** Resolve admin session from cookie or one-shot credential headers. */
export function getFormulaAdmin(req: Request): FormulaAdminSession | null {
  const fromCookie = parseFormulaAdminToken(cookieFromRequest(req, FORMULA_ADMIN_COOKIE));
  if (fromCookie) return fromCookie;

  // Owner is already the app's top-level admin — don't re-prompt for the
  // separate formula password on top of an owner-role app session.
  const appSession = getSessionFromRequest(req);
  if (appSession && appSession.role === "owner") {
    return {
      name: appSession.name || "Owner",
      email: appSession.email,
      exp: appSession.exp,
    };
  }

  const headerPassword =
    req.headers.get("x-formula-admin-password") ||
    req.headers.get("x-admin-password") ||
    undefined;
  const headerEmail =
    req.headers.get("x-formula-admin-email") ||
    req.headers.get("x-admin-email") ||
    undefined;

  if (
    verifyFormulaAdminCredentials({
      email: headerEmail || undefined,
      password: headerPassword || undefined,
    })
  ) {
    const email = (headerEmail || adminEmail()).trim().toLowerCase();
    const name =
      req.headers.get("x-formula-admin-name")?.trim() || email || "Admin";
    return {
      name,
      email,
      exp: Date.now() + COOKIE_MAX_AGE_SEC * 1000,
    };
  }
  return null;
}

export function requireFormulaAdmin(
  req: Request,
): FormulaAdminSession | NextResponse {
  const admin = getFormulaAdmin(req);
  if (!admin) {
    return NextResponse.json(
      {
        error:
          "Admin access required for formula recipes (BLD-04). Unlock with admin email + password.",
      },
      { status: 403 },
    );
  }
  return admin;
}

export function isFormulaAdminResponse(
  value: FormulaAdminSession | NextResponse,
): value is NextResponse {
  return value instanceof NextResponse;
}

export function formulaAdminCookieHeader(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${FORMULA_ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}${secure}`;
}

export function clearFormulaAdminCookieHeader(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${FORMULA_ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export { COOKIE_MAX_AGE_SEC };
