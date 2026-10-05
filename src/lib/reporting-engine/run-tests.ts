/**
 * Local reporting-engine unit tests (npm run test).
 * Covers query-param → filter parsing, previous-period window math, and the
 * two things that must never regress silently: role → report-category access
 * and branch isolation (a non-owner must never see another branch's data,
 * no matter what branchId the client asks for).
 */
import assert from "node:assert/strict";
import {
  canAccessReportCategory,
  reportCategoriesForRole,
  resolveBranchScope,
} from "./access";
import { ReportAccessDeniedError, ReportNotFoundError } from "./errors";
import { parseReportFilters, previousPeriodFilters } from "./filters";
import { registerReport } from "./registry";
import { executeReport } from "./runner";
import type { ReportContext, ReportDefinition, ReportFilters } from "./types";
import type { AppSession } from "@/lib/auth/session";
import type { UserRole } from "@/lib/types";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

function session(overrides: Partial<AppSession> = {}): AppSession {
  return {
    userId: "u1",
    name: "Test User",
    email: "test@example.com",
    role: "cashier",
    roleLabel: "Cashier",
    branchId: "branch-a",
    branchName: "Branch A",
    exp: Date.now() + 60_000,
    ...overrides,
  };
}

function fakeDefinition(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
  return {
    id: `test-report-${Math.random().toString(36).slice(2)}`,
    label: "Test Report",
    description: "for tests only",
    category: "sales",
    branchScoped: false,
    columns: [],
    run: async () => ({ rows: [], totals: { total: 42 } }),
    ...overrides,
  };
}

function ctxFor(s: AppSession): ReportContext {
  return { session: s };
}

function baseFilters(overrides: Partial<ReportFilters> = {}): ReportFilters {
  return {
    from: new Date(2026, 0, 1),
    to: new Date(2026, 0, 1, 23, 59, 59, 999),
    branchId: "requested-branch",
    compare: false,
    extra: {},
    ...overrides,
  };
}

// tsx compiles this as CommonJS (no top-level await), so all `await test(...)`
// calls live inside this async main() instead.
async function main() {
  console.log("reporting-engine filters");

  await test("from/to explicit range overrides period/date", () => {
    const params = new URLSearchParams({
      from: "2026-03-01",
      to: "2026-03-05",
      period: "yearly", // must be ignored
      date: "2020-01-01", // must be ignored
    });
    const f = parseReportFilters(params);
    assert.equal(f.from.getFullYear(), 2026);
    assert.equal(f.from.getMonth(), 2);
    assert.equal(f.from.getDate(), 1);
    assert.deepEqual([f.from.getHours(), f.from.getMinutes(), f.from.getSeconds()], [0, 0, 0]);
    assert.deepEqual(
      [f.to.getHours(), f.to.getMinutes(), f.to.getSeconds(), f.to.getMilliseconds()],
      [23, 59, 59, 999],
    );
  });

  await test("without from/to, falls back to period+date (matches getPeriodRange)", () => {
    const params = new URLSearchParams({ period: "monthly", date: "2026-02-15" });
    const f = parseReportFilters(params);
    assert.equal(f.from.getDate(), 1);
    assert.equal(f.to.getDate(), 28); // 2026 is not a leap year
  });

  await test("unknown query params land in extra; known ones never leak into it", () => {
    const params = new URLSearchParams({
      period: "daily",
      date: "2026-01-01",
      branchId: "b1",
      compare: "1",
      salesperson: "Ahmad",
      tag: "vip",
    });
    const f = parseReportFilters(params);
    assert.deepEqual(f.extra, { salesperson: "Ahmad", tag: "vip" });
    for (const known of ["period", "date", "branchId", "compare", "from", "to"]) {
      assert.ok(!(known in f.extra), `"${known}" should not appear in extra`);
    }
  });

  await test('compare is true only for the exact string "1"', () => {
    for (const value of ["true", "0", "yes", "", null]) {
      const params = new URLSearchParams();
      if (value !== null) params.set("compare", value);
      assert.equal(parseReportFilters(params).compare, false, `compare=${value} should be false`);
    }
    assert.equal(parseReportFilters(new URLSearchParams({ compare: "1" })).compare, true);
  });

  await test("branchId is null when absent from the query", () => {
    assert.equal(parseReportFilters(new URLSearchParams()).branchId, null);
  });

  await test("previousPeriodFilters: contiguous, same-length window immediately before `from`, with compare reset", () => {
    const filters: ReportFilters = {
      from: new Date(2026, 5, 10, 0, 0, 0, 0),
      to: new Date(2026, 5, 10, 23, 59, 59, 999),
      branchId: null,
      compare: true,
      extra: {},
    };
    const prev = previousPeriodFilters(filters);
    assert.equal(prev.compare, false);
    assert.equal(prev.to.getTime(), filters.from.getTime() - 1, "no gap or overlap at the boundary");
    assert.equal(
      prev.to.getTime() - prev.from.getTime(),
      filters.to.getTime() - filters.from.getTime(),
      "previous window must be the same length as the original",
    );
  });

  console.log("reporting-engine role access");

  await test("cashier cannot see finance/profit/inventory/purchase/production/hr/branch reports", () => {
    const forbidden: Array<Parameters<typeof canAccessReportCategory>[1]> = [
      "finance",
      "profit",
      "inventory",
      "purchase",
      "production",
      "hr",
      "branch",
    ];
    for (const category of forbidden) {
      assert.equal(canAccessReportCategory("cashier", category), false, category);
    }
    assert.equal(canAccessReportCategory("cashier", "sales"), true);
    assert.equal(canAccessReportCategory("cashier", "customer"), true);
  });

  await test("inventory role is scoped to inventory/production only", () => {
    assert.deepEqual(reportCategoriesForRole("inventory"), ["inventory", "production"]);
    assert.equal(canAccessReportCategory("inventory", "sales"), false);
    assert.equal(canAccessReportCategory("inventory", "finance"), false);
  });

  await test("only owner sees the branch category", () => {
    const roles: UserRole[] = ["owner", "manager", "accountant", "inventory", "cashier", "branch_manager"];
    for (const role of roles) {
      assert.equal(canAccessReportCategory(role, "branch"), role === "owner", role);
    }
  });

  await test("an unknown/corrupted role string never crashes and grants nothing", () => {
    const bogus = "not-a-real-role" as UserRole;
    assert.deepEqual(reportCategoriesForRole(bogus), []);
    assert.equal(canAccessReportCategory(bogus, "sales"), false);
  });

  console.log("reporting-engine branch isolation");

  await test('owner may request any branch, including null for "all branches"', () => {
    const owner = session({ role: "owner", branchId: "hq" });
    assert.equal(resolveBranchScope(owner, "branch-x"), "branch-x");
    assert.equal(resolveBranchScope(owner, null), null);
  });

  await test("non-owner is pinned to their own branch regardless of what they request", () => {
    const roles: UserRole[] = ["manager", "accountant", "inventory", "cashier", "branch_manager"];
    for (const role of roles) {
      const s = session({ role, branchId: "branch-a" });
      assert.equal(resolveBranchScope(s, "branch-b"), "branch-a", `${role} leaked into branch-b`);
      assert.equal(resolveBranchScope(s, null), "branch-a", `${role} escaped to all-branch scope`);
    }
  });

  await test("non-owner with no assigned branch still never inherits the requested branch", () => {
    const s = session({ role: "manager", branchId: null });
    assert.equal(resolveBranchScope(s, "branch-b"), null);
  });

  console.log("reporting-engine runner (executeReport)");

  await test("unknown report id throws ReportNotFoundError", async () => {
    await assert.rejects(
      () => executeReport("does-not-exist", ctxFor(session()), baseFilters()),
      ReportNotFoundError,
    );
  });

  await test("role without category access is denied and the report never runs", async () => {
    let ran = false;
    const def = fakeDefinition({
      category: "finance",
      run: async () => {
        ran = true;
        return { rows: [], totals: {} };
      },
    });
    registerReport(def);
    await assert.rejects(
      () => executeReport(def.id, ctxFor(session({ role: "cashier" })), baseFilters()),
      ReportAccessDeniedError,
    );
    assert.equal(ran, false, "run() must not execute for a denied report");
  });

  await test("branchScoped=true pins a non-owner to their session branch, ignoring the request", async () => {
    let seenBranchId: string | null | undefined;
    const def = fakeDefinition({
      branchScoped: true,
      run: async (_ctx, filters) => {
        seenBranchId = filters.branchId;
        return { rows: [], totals: {} };
      },
    });
    registerReport(def);
    const manager = session({ role: "manager", branchId: "own-branch" });
    await executeReport(def.id, ctxFor(manager), baseFilters({ branchId: "someone-elses-branch" }));
    assert.equal(seenBranchId, "own-branch");
  });

  await test("branchScoped=true refuses a non-owner with no branch (never every branch)", async () => {
    let ran = false;
    const def = fakeDefinition({
      branchScoped: true,
      run: async () => {
        ran = true;
        return { rows: [], totals: {} };
      },
    });
    registerReport(def);
    await assert.rejects(
      () => executeReport(def.id, ctxFor(session({ role: "manager", branchId: null })), baseFilters()),
      ReportAccessDeniedError,
    );
    assert.equal(ran, false);
    // The owner without a branch still sees every branch.
    await executeReport(def.id, ctxFor(session({ role: "owner", branchId: null })), baseFilters());
    assert.equal(ran, true);
  });

  await test("branchScoped=false passes the requested branchId through untouched", async () => {
    let seenBranchId: string | null | undefined;
    const def = fakeDefinition({
      branchScoped: false,
      run: async (_ctx, filters) => {
        seenBranchId = filters.branchId;
        return { rows: [], totals: {} };
      },
    });
    registerReport(def);
    const manager = session({ role: "manager", branchId: "own-branch" });
    await executeReport(def.id, ctxFor(manager), baseFilters({ branchId: "any-branch" }));
    assert.equal(seenBranchId, "any-branch");
  });

  await test("compare=false: run() executes once, compareTotals is null", async () => {
    let calls = 0;
    const def = fakeDefinition({
      run: async () => {
        calls += 1;
        return { rows: [], totals: { total: 10 } };
      },
    });
    registerReport(def);
    const result = await executeReport(def.id, ctxFor(session()), baseFilters({ compare: false }));
    assert.equal(calls, 1);
    assert.equal(result.compareTotals, null);
  });

  await test("compare=true: run() executes twice, once for the immediately-preceding window", async () => {
    const seenRanges: Array<{ from: number; to: number }> = [];
    const def = fakeDefinition({
      run: async (_ctx, filters) => {
        seenRanges.push({ from: filters.from.getTime(), to: filters.to.getTime() });
        return { rows: [], totals: { total: seenRanges.length === 1 ? 100 : 80 } };
      },
    });
    registerReport(def);
    const filters = baseFilters({ compare: true });
    const result = await executeReport(def.id, ctxFor(session()), filters);

    assert.equal(seenRanges.length, 2);
    assert.equal(result.totals.total, 100);
    assert.equal(result.compareTotals?.total, 80);
    // second call's window ends exactly 1ms before the first call's window starts
    assert.equal(seenRanges[1].to, seenRanges[0].from - 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
