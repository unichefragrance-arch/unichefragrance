import { Types } from "mongoose";
import { NextResponse } from "next/server";
import type { UserRole } from "@/lib/types";
import {
  hasPermission,
  type Permission,
} from "@/lib/auth/roles";
import {
  getSessionFromRequest,
  type AppSession,
} from "@/lib/auth/session";
import { canAccessAllBranches } from "@/lib/auth/roles";

export function requireAuth(req: Request): AppSession | NextResponse {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required. Please sign in." },
      { status: 401 },
    );
  }
  return session;
}

export function requireRole(
  req: Request,
  roles: UserRole[],
): AppSession | NextResponse {
  const auth = requireAuth(req);
  if (isAuthResponse(auth)) return auth;
  if (!roles.includes(auth.role)) {
    return NextResponse.json(
      {
        error: `Access denied. Required role: ${roles.join(" | ")}.`,
      },
      { status: 403 },
    );
  }
  return auth;
}

export function requirePermission(
  req: Request,
  permission: Permission,
): AppSession | NextResponse {
  const auth = requireAuth(req);
  if (isAuthResponse(auth)) return auth;
  if (!hasPermission(auth.role, permission)) {
    return NextResponse.json(
      { error: `Permission denied (${permission}).` },
      { status: 403 },
    );
  }
  return auth;
}

export function isAuthResponse(
  value: AppSession | NextResponse,
): value is NextResponse {
  return value instanceof NextResponse;
}

/**
 * Branch isolation: non–super-admin users may only touch their own branch.
 * Resources without branchId are allowed (legacy / shared catalog).
 */
export function assertBranchAccess(
  session: AppSession,
  resourceBranchId: string | null | undefined,
): NextResponse | null {
  if (canAccessAllBranches(session.role)) return null;
  if (!resourceBranchId) return null;
  if (!session.branchId) {
    return NextResponse.json(
      { error: "No branch assigned to your account." },
      { status: 403 },
    );
  }
  if (String(resourceBranchId) !== String(session.branchId)) {
    return NextResponse.json(
      { error: "Branch isolation: resource belongs to another branch." },
      { status: 403 },
    );
  }
  return null;
}

/** Mongo filter fragment for list queries. */
export function branchScopeFilter(
  session: AppSession,
): Record<string, unknown> | null {
  if (canAccessAllBranches(session.role)) return null;
  if (!session.branchId) {
    return { branchId: { $in: [null, undefined] } };
  }
  return {
    $or: [
      { branchId: session.branchId },
      { branchId: null },
      { branchId: { $exists: false } },
    ],
  };
}

/**
 * Exact-branch match for aggregates (dashboard, alerts): Owner → every
 * branch; a branch user → only that branch; a non-owner with no (or an
 * unreadable) branch → only unbranched records — never every branch.
 */
export function ownBranchMatch(session: AppSession): Record<string, unknown> {
  if (canAccessAllBranches(session.role)) return {};
  if (!session.branchId || !Types.ObjectId.isValid(session.branchId)) {
    return { branchId: null };
  }
  return { branchId: new Types.ObjectId(session.branchId) };
}

export function sessionBranchId(session: AppSession): string | null {
  return session.branchId;
}
