/**
 * Unit tests: src/lib/auth/roles.ts, src/lib/auth/password.ts, src/lib/auth/timeout.ts
 * Decision tables for role × permission, path matching boundaries,
 * password-hash format branches, timeout race states.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_PERMISSIONS,
  ASSIGNABLE_ROLES,
  canAccessAllBranches,
  canViewCostPrices,
  hasAnyPermission,
  hasPermission,
  isUserRole,
  navAllowed,
  permissionForApiPath,
  permissionForPath,
  permissionsForRole,
  redactCostFields,
} from "@/lib/auth/roles";
import { hashPassword, verifyPassword, verifyPasswordAsync } from "@/lib/auth/password";
import { withAuthTimeout } from "@/lib/auth/timeout";
import type { UserRole } from "@/lib/types";

describe("permissionsForRole / hasPermission — role decision table", () => {
  it("owner has every permission", () => {
    assert.deepEqual([...permissionsForRole("owner")].sort(), [...ALL_PERMISSIONS].sort());
  });
  it("manager has everything except branches:write", () => {
    assert.equal(hasPermission("manager", "branches:write"), false);
    assert.equal(permissionsForRole("manager").length, ALL_PERMISSIONS.length - 1);
  });
  const table: [UserRole, string, boolean][] = [
    ["cashier", "pos:write", true],
    ["cashier", "inventory:read", false],
    ["cashier", "reports:read", false],
    ["accountant", "expenses:write", true],
    ["accountant", "purchases:write", false],
    ["inventory", "inventory:write", true],
    ["inventory", "purchases:write", false],
    ["branch_manager", "production:write", false],
    ["branch_manager", "settings:read", false],
    ["branch_manager", "purchases:write", true],
  ];
  for (const [role, perm, expected] of table) {
    it(`${role} ${expected ? "has" : "lacks"} ${perm}`, () => {
      assert.equal(hasPermission(role, perm as never), expected);
    });
  }
  it("unknown role gets no permissions (?? [] branch)", () => {
    assert.deepEqual(permissionsForRole("ghost" as UserRole), []);
    assert.equal(hasPermission("ghost" as UserRole, "dashboard:read"), false);
  });
  it("every role can read the dashboard", () => {
    for (const r of ASSIGNABLE_ROLES) assert.ok(hasPermission(r, "dashboard:read"), r);
  });
});

describe("hasAnyPermission", () => {
  it("empty list → false (Array.some on empty)", () => {
    assert.equal(hasAnyPermission("owner", []), false);
  });
  it("true if any one matches, false if none", () => {
    assert.equal(hasAnyPermission("cashier", ["inventory:read", "pos:read"]), true);
    assert.equal(hasAnyPermission("cashier", ["inventory:read", "reports:read"]), false);
  });
});

describe("permissionForPath — prefix boundaries", () => {
  it("root and empty map to dashboard", () => {
    assert.equal(permissionForPath("/"), "dashboard:read");
    assert.equal(permissionForPath(""), "dashboard:read");
    assert.equal(permissionForPath("?tab=1"), "dashboard:read");
  });
  it("exact prefix and sub-path match", () => {
    assert.equal(permissionForPath("/pos"), "pos:read");
    assert.equal(permissionForPath("/inventory/low-stock"), "inventory:read");
  });
  it("query string is ignored", () => {
    assert.equal(permissionForPath("/reports?period=month"), "reports:read");
  });
  it("lookalike prefixes do NOT match (/posx, /settingsfoo)", () => {
    assert.equal(permissionForPath("/posx"), null);
    assert.equal(permissionForPath("/settingsfoo"), null);
  });
  it("unknown page → null; trailing slash still matches", () => {
    assert.equal(permissionForPath("/unknown"), null);
    assert.equal(permissionForPath("/pos/"), "pos:read");
  });
  it("is case-sensitive", () => {
    assert.equal(permissionForPath("/POS"), null);
  });
});

describe("permissionForApiPath", () => {
  it("maps each API family", () => {
    assert.equal(permissionForApiPath("/api/products/123"), "inventory:read");
    assert.equal(permissionForApiPath("/api/suppliers"), "purchases:read");
    assert.equal(permissionForApiPath("/api/sales?x=1"), "pos:read");
  });
  it("unknown and lookalike paths → null", () => {
    assert.equal(permissionForApiPath("/api/health"), null);
    assert.equal(permissionForApiPath("/api/salesman"), null);
    assert.equal(permissionForApiPath(""), null);
  });
});

describe("navAllowed — both branches", () => {
  it("path with no permission entry is always allowed", () => {
    assert.equal(navAllowed("/login", "cashier"), true);
  });
  it("allowed / denied by role", () => {
    assert.equal(navAllowed("/pos", "cashier"), true);
    assert.equal(navAllowed("/settings", "cashier"), false);
  });
});

describe("isUserRole — type guard, robust against non-strings", () => {
  it("accepts every assignable role", () => {
    for (const r of ASSIGNABLE_ROLES) assert.equal(isUserRole(r), true);
  });
  it("rejects wrong case, padding, non-strings", () => {
    for (const v of ["Owner", " owner", "owner ", "", null, undefined, 1, {}, ["owner"]]) {
      assert.equal(isUserRole(v), false, JSON.stringify(v));
    }
  });
});

describe("canAccessAllBranches / canViewCostPrices", () => {
  it("only owner sees all branches", () => {
    for (const r of ASSIGNABLE_ROLES) assert.equal(canAccessAllBranches(r), r === "owner", r);
  });
  it("only cashier is denied cost prices", () => {
    for (const r of ASSIGNABLE_ROLES) assert.equal(canViewCostPrices(r), r !== "cashier", r);
  });
});

describe("redactCostFields — state: input is not mutated", () => {
  it("removes listed fields from the copy only", () => {
    const src = { name: "Oud", sellPrice: 10, costFifo: 4, wholesalePrice: 7 };
    const out = redactCostFields(src, ["costFifo", "wholesalePrice"]);
    assert.deepEqual(out, { name: "Oud", sellPrice: 10 });
    assert.deepEqual(src, { name: "Oud", sellPrice: 10, costFifo: 4, wholesalePrice: 7 });
  });
  it("empty field list and missing fields are no-ops", () => {
    assert.deepEqual(redactCostFields({ a: 1 }, []), { a: 1 });
    assert.deepEqual(redactCostFields({ a: 1 }, ["zzz"]), { a: 1 });
  });
});

describe("password hashing", () => {
  const stored = hashPassword("Test-Admin#2026");

  it("hash has scrypt$salt$hash shape with a random salt", () => {
    assert.match(stored, /^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    assert.notEqual(hashPassword("x"), hashPassword("x"));
  });
  it("correct password verifies (sync + async)", async () => {
    assert.equal(verifyPassword("Test-Admin#2026", stored), true);
    assert.equal(await verifyPasswordAsync("Test-Admin#2026", stored), true);
  });
  it("wrong, case-changed, padded passwords fail", async () => {
    for (const pw of ["test-admin#2026", "Test-Admin#2026 ", " Test-Admin#2026", "Test-Admin#202"]) {
      assert.equal(verifyPassword(pw, stored), false, pw);
      assert.equal(await verifyPasswordAsync(pw, stored), false, pw);
    }
  });
  it("unicode and very long passwords round-trip", () => {
    for (const pw of ["کلمہ-سر🔑", "x".repeat(10_000)]) {
      assert.equal(verifyPassword(pw, hashPassword(pw)), true);
    }
  });

  // Each guard condition false on its own (condition coverage).
  const badStored: [string, string | null | undefined][] = [
    ["null stored", null],
    ["undefined stored", undefined],
    ["empty stored", ""],
    ["wrong algo", stored.replace(/^scrypt/, "bcrypt")],
    ["missing salt", "scrypt$$abc"],
    ["missing hash", "scrypt$salt$"],
    ["no separators", "scrypt"],
    ["hash of wrong length", "scrypt$salt$AAAA"],
  ];
  for (const [label, s] of badStored) {
    it(`rejects ${label}`, async () => {
      assert.equal(verifyPassword("Test-Admin#2026", s), false);
      assert.equal(await verifyPasswordAsync("Test-Admin#2026", s), false);
    });
  }
  it("rejects empty password even against a valid hash", async () => {
    assert.equal(verifyPassword("", stored), false);
    assert.equal(await verifyPasswordAsync("", stored), false);
  });
});

describe("withAuthTimeout — race states", () => {
  it("resolves with the work's value when it finishes first", async () => {
    assert.equal(await withAuthTimeout(Promise.resolve(42), "Login", 50), 42);
  });
  it("propagates the work's own rejection", async () => {
    await assert.rejects(withAuthTimeout(Promise.reject(new Error("boom")), "Login", 50), /boom/);
  });
  it("rejects with a labelled timeout when work is too slow", async () => {
    const never = new Promise<never>(() => {});
    await assert.rejects(withAuthTimeout(never, "Login", 10), /Login is taking too long \(>0s\)/);
  });
  it("rounds the seconds in the message", async () => {
    const never = new Promise<never>(() => {});
    await assert.rejects(withAuthTimeout(never, "Me", 1500), /\(>2s\)/);
  });
  it("uses the default label", async () => {
    await assert.rejects(withAuthTimeout(new Promise<never>(() => {}), undefined, 5), /^Error: Authentication is taking too long/);
  });
});
