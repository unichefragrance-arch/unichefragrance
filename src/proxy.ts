import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, parseSessionToken } from "@/lib/auth/session";
import { hasPermission, permissionForPath } from "@/lib/auth/roles";
import { applyCorsHeaders, corsPreflightResponse } from "@/lib/cors";

/**
 * Route gate (Next.js 16 proxy) — Node runtime by default, so this now
 * enforces per-role page permission server-side (not just session presence),
 * so a page a role can't open is never rendered even for a moment.
 * Authoritative checks for data still live in API handlers via
 * requireApiAccess / requirePermission — this only protects page HTML.
 */
export function proxy(request: NextRequest) {
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
  const session = parseSessionToken(rawSession);
  const hasSession = session !== null;
  const withClearedCookie = (res: NextResponse) => {
    if (rawSession && !session) res.cookies.delete(SESSION_COOKIE);
    return res;
  };

  if (isPublicApi) {
    return withCors(NextResponse.next());
  }

  if (isPublicQuotationPage) {
    return NextResponse.next();
  }

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

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
