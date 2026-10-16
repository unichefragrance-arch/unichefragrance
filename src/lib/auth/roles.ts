import type { UserRole } from "@/lib/types";

/** BRN-08 permission keys used by route + API guards. */
export type Permission =
  | "dashboard:read"
  | "pos:read"
  | "pos:write"
  | "inventory:read"
  | "inventory:write"
  | "formulas:read"
  | "formulas:write"
  | "production:read"
  | "production:write"
  | "purchases:read"
  | "purchases:write"
  | "customers:read"
  | "customers:write"
  | "quotations:read"
  | "quotations:write"
  | "reports:read"
  | "expenses:read"
  | "expenses:write"
  | "settings:read"
  | "settings:write"
  | "users:read"
  | "users:write"
  | "branches:read"
  | "branches:write";

export const ALL_PERMISSIONS: Permission[] = [
  "dashboard:read",
  "pos:read",
  "pos:write",
  "inventory:read",
  "inventory:write",
  "formulas:read",
  "formulas:write",
  "production:read",
  "production:write",
  "purchases:read",
  "purchases:write",
  "customers:read",
  "customers:write",
  "quotations:read",
  "quotations:write",
  "reports:read",
  "expenses:read",
  "expenses:write",
  "settings:read",
  "settings:write",
  "users:read",
  "users:write",
  "branches:read",
  "branches:write",
];

const CASHIER_PERMS: Permission[] = [
  "dashboard:read",
  "pos:read",
  "pos:write",
  "customers:read",
  "customers:write",
  "quotations:read",
  "quotations:write",
];

const ACCOUNTANT_PERMS: Permission[] = [
  "dashboard:read",
  "reports:read",
  "expenses:read",
  "expenses:write",
  "purchases:read",
];

/** PUR-04: purchase creation/receipt is owner/manager only — Inventory may view but not commit spend. */
const INVENTORY_PERMS: Permission[] = [
  "dashboard:read",
  "inventory:read",
  "inventory:write",
  "purchases:read",
];

/** Manager: ops + formulas + users (branch-scoped). Not full branch CRUD. */
const MANAGER_PERMS: Permission[] = ALL_PERMISSIONS.filter(
  (p) => p !== "branches:write",
);

/** Branch Manager: day-to-day branch operations, no formulas/users/settings/branches — branch isolation (canAccessAllBranches) does the rest. */
const BRANCH_MANAGER_PERMS: Permission[] = [
  "dashboard:read",
  "pos:read",
  "pos:write",
  "inventory:read",
  "inventory:write",
  "production:read",
  "purchases:read",
  "purchases:write",
  "customers:read",
  "customers:write",
  "quotations:read",
  "quotations:write",
  "reports:read",
  "expenses:read",
  "expenses:write",
];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: [...ALL_PERMISSIONS],
  manager: MANAGER_PERMS,
  cashier: CASHIER_PERMS,
  accountant: ACCOUNTANT_PERMS,
  inventory: INVENTORY_PERMS,
  branch_manager: BRANCH_MANAGER_PERMS,
};

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: "Owner",
  manager: "Manager",
  cashier: "Cashier",
  accountant: "Accountant",
  inventory: "Inventory",
  branch_manager: "Branch Manager",
};

export const ASSIGNABLE_ROLES: UserRole[] = [
  "owner",
  "manager",
  "cashier",
  "accountant",
  "inventory",
  "branch_manager",
];

/**
 * Roles the client has explicitly confirmed for this rollout: Admin (owner),
 * Sales Staff (cashier), Accounting (accountant). `manager` / `inventory` /
 * `branch_manager` stay fully implemented and valid server-side (existing
 * users keep working) but are proposed-only — hidden from the "assign a
 * role" UI until the client signs off on them.
 */
export const CONFIRMED_ASSIGNABLE_ROLES: UserRole[] = [
  "owner",
  "cashier",
  "accountant",
];

/** App page → minimum permission to view. */
export const ROUTE_PERMISSIONS: { prefix: string; permission: Permission }[] = [
  { prefix: "/settings", permission: "settings:read" },
  { prefix: "/playground", permission: "settings:read" },
  { prefix: "/formulas", permission: "formulas:read" },
  { prefix: "/production", permission: "production:read" },
  { prefix: "/inventory", permission: "inventory:read" },
  { prefix: "/purchases", permission: "purchases:read" },
  { prefix: "/customers", permission: "customers:read" },
  { prefix: "/quotations", permission: "quotations:read" },
  { prefix: "/reports", permission: "reports:read" },
  { prefix: "/expenses", permission: "expenses:read" },
  { prefix: "/pos", permission: "pos:read" },
  { prefix: "/", permission: "dashboard:read" },
];

/** API path prefix → permission (first match wins). */
export const API_PERMISSIONS: { prefix: string; permission: Permission }[] = [
  { prefix: "/api/users", permission: "users:read" },
  { prefix: "/api/branches", permission: "branches:read" },
  { prefix: "/api/settings", permission: "settings:read" },
  { prefix: "/api/formulas", permission: "formulas:read" },
  { prefix: "/api/production", permission: "production:read" },
  { prefix: "/api/products", permission: "inventory:read" },
  { prefix: "/api/inventory", permission: "inventory:read" },
  { prefix: "/api/purchases", permission: "purchases:read" },
  { prefix: "/api/suppliers", permission: "purchases:read" },
  { prefix: "/api/customers", permission: "customers:read" },
  { prefix: "/api/quotations", permission: "quotations:read" },
  { prefix: "/api/sales", permission: "pos:read" },
  { prefix: "/api/reports", permission: "reports:read" },
  { prefix: "/api/expenses", permission: "expenses:read" },
];

export function permissionsForRole(role: UserRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

export function hasAnyPermission(
  role: UserRole,
  permissions: Permission[],
): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

export function permissionForPath(pathname: string): Permission | null {
  const path = pathname.split("?")[0] || "/";
  const sorted = [...ROUTE_PERMISSIONS].sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  for (const entry of sorted) {
    if (entry.prefix === "/") {
      if (path === "/" || path === "") return entry.permission;
      continue;
    }
    if (path === entry.prefix || path.startsWith(`${entry.prefix}/`)) {
      return entry.permission;
    }
  }
  return null;
}

export function permissionForApiPath(pathname: string): Permission | null {
  const path = pathname.split("?")[0] || "";
  const sorted = [...API_PERMISSIONS].sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  for (const entry of sorted) {
    if (path === entry.prefix || path.startsWith(`${entry.prefix}/`)) {
      return entry.permission;
    }
  }
  return null;
}

/** Nav hrefs visible for a role. */
export function navAllowed(href: string, role: UserRole): boolean {
  const perm = permissionForPath(href);
  if (!perm) return true;
  return hasPermission(role, perm);
}

export function isUserRole(value: unknown): value is UserRole {
  return (
    typeof value === "string" &&
    (ASSIGNABLE_ROLES as string[]).includes(value)
  );
}

/** Roles that may see all branches (no isolation filter). */
export function canAccessAllBranches(role: UserRole): boolean {
  return role === "owner";
}

/**
 * Cost/margin/supplier-price fields (wholesalePrice, costFifo, minMarginPct,
 * unitCost) are financial data, not catalog data. Sales-facing roles only
 * ever need the sell price to complete a transaction.
 */
export function canViewCostPrices(role: UserRole): boolean {
  return role !== "cashier";
}

/** Strip cost/margin fields from a plain object in place-safe fashion. */
export function redactCostFields<T extends Record<string, unknown>>(
  obj: T,
  fields: string[],
): T {
  const copy = { ...obj };
  for (const f of fields) delete copy[f];
  return copy;
}

/** Product cost/margin fields hidden from roles that may not view cost prices. */
export const PRODUCT_COST_FIELDS = ["wholesalePrice", "costFifo", "minMarginPct"];

/**
 * A sale's FIFO cost (inventoryDeductions → costTotal, batch unitCost) is the
 * same financial data as a product's cost — dropped for roles that may not
 * see cost prices. The till never reads it back.
 */
export function redactSaleCost<T extends Record<string, unknown>>(
  sale: T,
  role: UserRole,
): T {
  if (canViewCostPrices(role)) return sale;
  return redactCostFields(sale, ["inventoryDeductions"]);
}
