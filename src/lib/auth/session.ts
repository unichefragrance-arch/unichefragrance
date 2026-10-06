import { createHmac, timingSafeEqual } from "crypto";
import type { UserRole } from "@/lib/types";

/** BRN-08 app session cookie (role + branch). Separate from Formula Admin unlock. */
export const SESSION_COOKIE = "unich_session";

const COOKIE_MAX_AGE_SEC = 60 * 60 * 12; // 12 hours

export type AppSession = {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  roleLabel: string;
  branchId: string | null;
  branchName: string | null;
  exp: number;
  /** Server-side session id (AuthSession) — lets one login be revoked. */
  sid?: string;
};

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.FORMULA_ADMIN_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is not set. Refusing to start with an insecure default in production.",
    );
  }
  // Dev-only fallback — never reached in production (see check above).
  return "unich-session-dev-secret";
}

function signPayload(payloadB64: string): string {
  return createHmac("sha256", sessionSecret())
    .update(payloadB64)
    .digest("base64url");
}

export function createSessionToken(
  input: Omit<AppSession, "exp"> & { exp?: number },
): string {
  const session: AppSession = {
    userId: input.userId,
    name: input.name,
    email: input.email.trim().toLowerCase(),
    role: input.role,
    roleLabel: input.roleLabel,
    branchId: input.branchId,
    branchName: input.branchName,
    exp: input.exp ?? Date.now() + COOKIE_MAX_AGE_SEC * 1000,
    ...(input.sid ? { sid: input.sid } : {}),
  };
  const payloadB64 = Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url",
  );
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

export function parseSessionToken(
  token: string | undefined | null,
): AppSession | null {
  if (!token) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expected = signPayload(payloadB64);
  if (!safeEqual(sig, expected)) return null;
  try {
    const session = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as AppSession;
    if (
      !session?.userId ||
      !session?.role ||
      typeof session.exp !== "number"
    ) {
      return null;
    }
    if (session.exp < Date.now()) return null;
    return {
      userId: String(session.userId),
      name: String(session.name || ""),
      email: String(session.email || "").toLowerCase(),
      role: session.role,
      roleLabel: String(session.roleLabel || session.role),
      branchId: session.branchId ? String(session.branchId) : null,
      branchName: session.branchName ? String(session.branchName) : null,
      exp: session.exp,
      ...(session.sid ? { sid: String(session.sid) } : {}),
    };
  } catch {
    return null;
  }
}

export function cookieFromRequest(
  req: Request,
  cookieName: string,
): string | null {
  const header = req.headers.get("cookie") || "";
  const parts = header.split(";");
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === cookieName) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

export function getSessionFromRequest(req: Request): AppSession | null {
  return parseSessionToken(cookieFromRequest(req, SESSION_COOKIE));
}

const cookieBase = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

/** Preferred App Router API — avoids manual Set-Cookie encoding bugs. */
export function applySessionCookie(
  res: { cookies: { set: (name: string, value: string, opts: Record<string, unknown>) => void } },
  token: string,
): void {
  res.cookies.set(SESSION_COOKIE, token, {
    ...cookieBase,
    maxAge: COOKIE_MAX_AGE_SEC,
  });
}

export function clearSessionCookie(
  res: { cookies: { set: (name: string, value: string, opts: Record<string, unknown>) => void } },
): void {
  res.cookies.set(SESSION_COOKIE, "", {
    ...cookieBase,
    maxAge: 0,
  });
}

/** @deprecated Prefer applySessionCookie — kept for string-header call sites. */
export function sessionCookieHeader(token: string): string {
  const secure = cookieBase.secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}${secure}`;
}

/** @deprecated Prefer clearSessionCookie */
export function clearSessionCookieHeader(): string {
  const secure = cookieBase.secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export { COOKIE_MAX_AGE_SEC };
