import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import {
  isAuthResponse,
  requireAuth,
  requirePermission,
} from "@/lib/auth/guards";
import {
  ALL_PERMISSIONS,
  hasAnyPermission,
  hasPermission,
  permissionForApiPath,
  type Permission,
} from "@/lib/auth/roles";
import type { AppSession } from "@/lib/auth/session";

function deny(message: string, status = 403) {
  return NextResponse.json({ error: message }, { status });
}

const DB_CONNECTION_ERROR_NAMES = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongooseServerSelectionError",
  "MongoTimeoutError",
  "MongoNotConnectedError",
  "MongoTopologyClosedError",
  "MongoPoolClearedError",
]);

/** The database is unreachable (not a bad request) — callers answer 503. */
export function isDbUnavailable(error: unknown): boolean {
  return error instanceof Error && DB_CONNECTION_ERROR_NAMES.has(error.name);
}

/**
 * Errors whose text describes our code or database, not the request:
 * runtime faults (TypeError…) and driver/ODM errors (index names, key
 * values, model paths). Business errors (SaleError, plain `Error` thrown
 * with a user-facing message) keep their message.
 */
const INTERNAL_ERROR_NAMES = new Set([
  "TypeError",
  "ReferenceError",
  "RangeError",
  "EvalError",
  "URIError",
  "CastError",
  "MongoError",
  "MongoServerError",
  "MongoBulkWriteError",
  "MongooseError",
  "StrictModeError",
  "VersionError",
  "ParallelSaveError",
  "MissingSchemaError",
  "DocumentNotFoundError",
]);

/** Strip things that must never reach a log: connection strings, key values. */
function redactForLog(text: string): string {
  return text
    .replace(/mongodb(\+srv)?:\/\/[^\s"'`]+/g, "mongodb://<redacted>")
    .replace(/dup key: \{[^}]*\}/g, "dup key: {<redacted>}")
    .replace(/for value "[^"]*"/g, 'for value "<redacted>"');
}

/** Server-side record of an unexpected error; the client only gets the ref. */
export function logServerError(ref: string, error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error));
  const code = (e as { code?: unknown }).code;
  const stack = (e.stack ?? "").split("\n").slice(1).join("\n");
  console.error(
    `[api-error ref=${ref}] ${e.name}${code !== undefined ? ` (code ${String(code)})` : ""}: ${redactForLog(e.message)}\n${redactForLog(stack)}`,
  );
}

/**
 * Message for an API error response. Never returns implementation details
 * (stack traces, runtime/driver messages, connection strings): those get a
 * generic message with a reference id, and the details go to the server log
 * under the same id. Business/validation errors keep their own message.
 */
export function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof SyntaxError) {
    return "Request body must be valid JSON";
  }
  if (error instanceof Error && error.name === "ValidationError") {
    const paths = Object.keys((error as { errors?: Record<string, unknown> }).errors ?? {});
    return paths.length > 0 ? `Invalid data: ${paths.join(", ")}` : "Invalid data";
  }
  const internal =
    !(error instanceof Error) ||
    DB_CONNECTION_ERROR_NAMES.has(error.name) ||
    INTERNAL_ERROR_NAMES.has(error.name) ||
    error.name.startsWith("Mongo");
  if (internal) {
    const ref = randomBytes(4).toString("hex");
    logServerError(ref, error);
    return `${fallback}. Something went wrong — please try again (ref ${ref}).`;
  }
  return error.message || fallback;
}

/**
 * Enforce session + path permission for an API request.
 * Returns `null` when the path is intentionally public (caller continues).
 */
export function requireApiAccess(
  req: Request,
  pathname?: string,
): AppSession | NextResponse | null {
  const url = new URL(req.url);
  const path = pathname || url.pathname;

  if (
    path === "/api/health" ||
    path === "/api/auth/login" ||
    path === "/api/auth/logout" ||
    path.startsWith("/api/auth/formula-admin") ||
    path === "/api/auth/me" ||
    // QTN-10: customer approval link — reachable only with the unguessable token itself.
    path.startsWith("/api/quotations/public/")
  ) {
    return null;
  }

  const auth = requireAuth(req);
  if (isAuthResponse(auth)) return auth;

  const method = req.method.toUpperCase();
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);

  // Settings: any logged-in user may GET (shell needs branch defaults);
  // only settings:write may mutate.
  if (path.startsWith("/api/settings")) {
    if (mutating && !hasPermission(auth.role, "settings:write")) {
      return deny("Permission denied (settings:write).");
    }
    return auth;
  }

  // Product catalog: POS / purchases / inventory / formulas all need GET.
  if (path.startsWith("/api/products") || path.startsWith("/api/fifo-layers")) {
    if (mutating) {
      if (!hasPermission(auth.role, "inventory:write")) {
        return deny("Permission denied (inventory:write).");
      }
      return auth;
    }
    // The catalogue export and the import screens carry cost / wholesale
    // columns — inventory work, not the read-only catalogue the till needs.
    if (path.startsWith("/api/products/export") || path.startsWith("/api/products/import")) {
      if (!hasPermission(auth.role, "inventory:read")) {
        return deny("Permission denied (inventory:read).");
      }
      return auth;
    }
    if (
      !hasAnyPermission(auth.role, [
        "inventory:read",
        "pos:read",
        "purchases:read",
        "formulas:read",
        "production:read",
      ])
    ) {
      return deny("Permission denied (product catalog).");
    }
    return auth;
  }

  // Formulas: redacted customer formulas for POS/CRM; full list Admin-only.
  // Recipe secrecy still enforced by requireFormulaAdmin on mutations / export.
  if (path.startsWith("/api/formulas")) {
    if (mutating) {
      if (!hasPermission(auth.role, "formulas:write")) {
        return deny("Permission denied (formulas:write).");
      }
      return auth;
    }
    const customerId = url.searchParams.get("customerId");
    if (customerId) {
      if (
        !hasAnyPermission(auth.role, [
          "formulas:read",
          "pos:read",
          "customers:read",
        ])
      ) {
        return deny("Permission denied (formulas).");
      }
      return auth;
    }
    if (!hasPermission(auth.role, "formulas:read")) {
      return deny("Permission denied (formulas:read).");
    }
    return auth;
  }

  // Header notification bell — same audience as the dashboard it mirrors.
  // (Its sub-paths /log and /send are receipt delivery, handled below.)
  if (path === "/api/notifications") {
    if (!hasPermission(auth.role, "dashboard:read")) {
      return deny("Permission denied (dashboard:read).");
    }
    return auth;
  }

  // Receipts / notifications tied to completed sales
  if (
    path.startsWith("/api/receipts") ||
    path.startsWith("/api/notifications/")
  ) {
    if (
      !hasAnyPermission(auth.role, [
        "pos:read",
        "pos:write",
        "reports:read",
        "settings:read",
      ])
    ) {
      return deny("Permission denied.");
    }
    return auth;
  }

  // Dashboard
  if (path.startsWith("/api/dashboard")) {
    if (!hasPermission(auth.role, "dashboard:read")) {
      return deny("Permission denied (dashboard:read).");
    }
    return auth;
  }

  const base = permissionForApiPath(path);
  if (!base) {
    return auth; // authenticated catch-all for unmapped APIs
  }

  if (mutating) {
    const writePerm = base.replace(":read", ":write") as Permission;
    if ((ALL_PERMISSIONS as string[]).includes(writePerm)) {
      if (!hasPermission(auth.role, writePerm)) {
        return deny(`Permission denied (${writePerm}).`);
      }
      return auth;
    }
  }

  if (!hasPermission(auth.role, base)) {
    return deny(`Permission denied (${base}).`);
  }
  return auth;
}

export { isAuthResponse, requirePermission, requireAuth };
