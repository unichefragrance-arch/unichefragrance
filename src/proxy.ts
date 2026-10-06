import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, parseSessionToken } from "@/lib/auth/session";
import { checkSession } from "@/lib/auth/sessionStore";
import { hasPermission, permissionForPath } from "@/lib/auth/roles";
import { applyCorsHeaders, corsPreflightResponse } from "@/lib/cors";

/**
 * Route gate (Next.js 16 proxy) — Node runtime by default, so this now
 * enforces per-role page permission server-side (not just session presence),
 * so a page a role can't open is never rendered even for a moment.
 * Authoritative checks for data still live in API handlers via
 * requireApiAccess / requirePermission — this only protects page HTML.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  if (isApi) {
    const preflight = corsPreflightResponse(request);
    if (preflight) return preflight;
  }

  const withCors = (res: NextResponse) =>
    isApi ? applyCorsHeaders(res, request) : res;

  const isLogin = pathname === "/login" || pathname.startsWith("/login/");
  // QTN-10: customer approval link — reachable only with the unguessable token, no session.
  const isPublicQuotationPage = pathname === "/q" || pathname.startsWith("/q/");
  const isPublicApi =
    pathname === "/api/health" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/me" ||
    pathname.startsWith("/api/auth/formula-admin") ||
    pathname.startsWith("/api/quotations/public/");

  // A cookie that fails signature/expiry validation counts as no session —
  // otherwise forged or expired cookies would get past the page gate.
  const rawSession = request.cookies.get(SESSION_COOKIE)?.value;
  const parsed = parseSessionToken(rawSession);
  const withClearedCookie = (res: NextResponse) => {
    // Only ever called after `session` is resolved below.
    if (rawSession && !session) res.cookies.delete(SESSION_COOKIE);
    return res;
  };

  if (isPublicApi) {
    return withCors(NextResponse.next());
  }

  if (isPublicQuotationPage) {
    return NextResponse.next();
  }

  // Signature is not enough: the session must still be live server-side
  // (not logged out; user still active with the same role/branch).
  const check = parsed ? await checkSession(parsed) : "dead";

  // Database unreachable: we cannot tell whether this signed session was
  // revoked — but an outage is not a logout. Keep the cookie and answer 503
  // (retryable): JSON for APIs, a self-refreshing notice for pages. Nothing is
  // served on the strength of an unverified session.
  if (check === "unavailable" && parsed) {
    if (isApi) {
      return withCors(
        NextResponse.json(
          { error: "Service temporarily unavailable. Please try again shortly.", code: "SERVICE_UNAVAILABLE" },
          { status: 503, headers: { "Retry-After": "5" } },
        ),
      );
    }
    if (!isLogin) {
      return new NextResponse(UNAVAILABLE_PAGE, {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": "10", "Cache-Control": "no-store" },
      });
    }
    return NextResponse.next();
  }

  const session = check === "live" ? parsed : null;
  const hasSession = session !== null;

  if (isLogin) {
    if (hasSession) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return withClearedCookie(NextResponse.next());
  }

  // App pages + protected APIs: require a valid session
  if (!session) {
    if (isApi) {
      return withClearedCookie(
        withCors(
          NextResponse.json(
            { error: "Authentication required. Please sign in." },
            { status: 401 },
          ),
        ),
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return withClearedCookie(NextResponse.redirect(loginUrl));
  }

  // App pages only (not API): block pages the role has no permission for,
  // so restricted pages never render even briefly before a client redirect.
  if (!isApi) {
    const perm = permissionForPath(pathname);
    if (perm && !hasPermission(session.role, perm)) {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  return withCors(NextResponse.next());
}

/** Shown while the database is unreachable; reloads itself, session untouched. */
const UNAVAILABLE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>Temporarily unavailable</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;background:#f6f6f4;color:#222}main{max-width:28rem;text-align:center}@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}}</style></head><body><main><h1>Temporarily unavailable</h1><p>The system can't reach its database right now. You are still signed in — this page will retry automatically.</p></main></body></html>`;

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
