import { NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/auth/apiGuard";
import { permissionsForRole } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/auth/session";
import { checkSession } from "@/lib/auth/sessionStore";
import type { AuthMe } from "@/lib/types";

/**
 * GET /api/auth/me — signed cookie + a cached live-session check (revoked,
 * deactivated or demoted sessions report as signed out). If the database is
 * unreachable the signed cookie is still reported (degraded) — an outage must
 * not look like a logout to the client.
 */
export async function GET(req: Request) {
  try {
    const parsed = getSessionFromRequest(req);
    // Revoked / deactivated / demoted sessions report as signed out.
    const check = parsed ? await checkSession(parsed) : "dead";
    const session = check === "dead" ? null : parsed;
    if (!session) {
      const body: AuthMe = {
        authenticated: false,
        user: null,
        permissions: [],
      };
      return NextResponse.json(body);
    }

    const body: AuthMe = {
      authenticated: true,
      user: {
        id: session.userId,
        name: session.name,
        email: session.email,
        role: session.role,
        roleLabel: session.roleLabel,
        branchId: session.branchId,
        branchName: session.branchName,
        active: true,
      },
      permissions: permissionsForRole(session.role),
      ...(check === "unavailable" ? { degraded: true } : {}),
    };
    return NextResponse.json(body);
  } catch (error) {
    return NextResponse.json(
      {
        error: safeErrorMessage(error, "Failed to load session"),
      },
      { status: 500 },
    );
  }
}
