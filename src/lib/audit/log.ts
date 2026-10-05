import { AuditLog } from "@/lib/models";
import type { AppSession } from "@/lib/auth/session";

export type AuditAction =
  | "login_success"
  | "login_failed"
  | "sale_created"
  | "discount_approved"
  | "purchase_created"
  | "purchase_updated"
  | "stock_adjusted"
  | "formula_updated"
  | "formula_deleted"
  | "expense_created"
  | "user_created"
  | "user_updated"
  | "user_deactivated";

function clientIp(req: Request): string | undefined {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || undefined;
}

/**
 * Fire-and-forget audit write — must never block or fail the caller's
 * primary request. Capture-only for now; retention/search/export policy
 * to be confirmed with the client before building a UI on top of this.
 */
export function recordAudit(input: {
  session?: AppSession | null;
  action: AuditAction;
  entityType: string;
  entityId?: string;
  detail?: string;
  req?: Request;
  email?: string;
}): void {
  void AuditLog.create({
    userId: input.session?.userId || undefined,
    userName: input.session?.name || input.email || "unknown",
    userEmail: input.session?.email || input.email || undefined,
    role: input.session?.role,
    branchId: input.session?.branchId || undefined,
    branchName: input.session?.branchName || undefined,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    detail: input.detail,
    ip: input.req ? clientIp(input.req) : undefined,
  }).catch(() => {
    /* audit logging must never break the primary flow */
  });
}
