/**
 * Regression: no built-in credentials. Owner account for seed/bootstrap comes
 * from the environment only; the import price-floor override fails closed
 * without IMPORT_ADMIN_PASSWORD; no source file keeps a password fallback.
 * All values here are test-only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readOwnerCredentials, requireOwnerCredentials } from "../../scripts/lib/ownerCredentials";
import { importOverridePasswordValid } from "@/lib/excel/importOverride";

describe("readOwnerCredentials — environment only", () => {
  it("nothing set → both missing, no default owner", () => {
    assert.deepEqual(readOwnerCredentials({}), {
      ok: false,
      missing: ["SUPER_ADMIN_EMAIL or ADMIN_EMAIL", "SUPER_ADMIN_PASSWORD or ADMIN_PASSWORD"],
    });
  });
  it("each half missing on its own", () => {
    assert.deepEqual(readOwnerCredentials({ ADMIN_EMAIL: "o@test.invalid" }), { ok: false, missing: ["SUPER_ADMIN_PASSWORD or ADMIN_PASSWORD"] });
    assert.deepEqual(readOwnerCredentials({ ADMIN_PASSWORD: "pw-test" }), { ok: false, missing: ["SUPER_ADMIN_EMAIL or ADMIN_EMAIL"] });
  });
  it("whitespace-only values count as missing", () => {
    assert.equal(readOwnerCredentials({ ADMIN_EMAIL: "  ", ADMIN_PASSWORD: "\t" }).ok, false);
  });
  it("ADMIN_* works; email normalised; name defaults to Owner", () => {
    assert.deepEqual(readOwnerCredentials({ ADMIN_EMAIL: " O@Test.Invalid ", ADMIN_PASSWORD: "pw-test" }), {
      ok: true, owner: { name: "Owner", email: "o@test.invalid", password: "pw-test" },
    });
  });
  it("SUPER_ADMIN_* takes precedence; blank SUPER_ADMIN_* falls through to ADMIN_*", () => {
    const env = { SUPER_ADMIN_EMAIL: "s@test.invalid", SUPER_ADMIN_PASSWORD: "s-pw", ADMIN_EMAIL: "a@test.invalid", ADMIN_PASSWORD: "a-pw", ADMIN_NAME: "Boss" };
    assert.deepEqual(readOwnerCredentials(env), { ok: true, owner: { name: "Boss", email: "s@test.invalid", password: "s-pw" } });
    const blank = { ...env, SUPER_ADMIN_EMAIL: " ", SUPER_ADMIN_PASSWORD: "" };
    assert.deepEqual(readOwnerCredentials(blank), { ok: true, owner: { name: "Boss", email: "a@test.invalid", password: "a-pw" } });
  });
});

describe("requireOwnerCredentials", () => {
  it("exits 2 and names the missing variables without printing any value", (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (m: string) => logged.push(m));
    t.mock.method(process, "exit", ((code: number) => { throw new Error(`exit:${code}`); }) as never);
    assert.throws(() => requireOwnerCredentials("seed", { ADMIN_EMAIL: "o@test.invalid" }), /exit:2/);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^\[seed\] REFUSING TO RUN: set SUPER_ADMIN_PASSWORD or ADMIN_PASSWORD/);
    assert.ok(!logged[0].includes("o@test.invalid"), "value must not be printed");
  });
  it("returns the owner when configured", () => {
    assert.equal(requireOwnerCredentials("seed", { ADMIN_EMAIL: "o@test.invalid", ADMIN_PASSWORD: "pw-test" }).email, "o@test.invalid");
  });
});

describe("importOverridePasswordValid — fails closed", () => {
  it("regression: unset IMPORT_ADMIN_PASSWORD → no password works, including the old 'admin'", () => {
    for (const pw of ["admin", "", "anything"]) {
      assert.equal(importOverridePasswordValid(pw, undefined), false, pw);
      assert.equal(importOverridePasswordValid(pw, ""), false, pw);
    }
  });
  it("matches only the exact configured password", () => {
    assert.equal(importOverridePasswordValid("imp-test-1", "imp-test-1"), true);
    for (const pw of ["imp-test-", "imp-test-12", "IMP-TEST-1", " imp-test-1", undefined, ""]) {
      assert.equal(importOverridePasswordValid(pw, "imp-test-1"), false, String(pw));
    }
  });
  it("defaults to process.env.IMPORT_ADMIN_PASSWORD", () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = env.IMPORT_ADMIN_PASSWORD;
    try {
      delete env.IMPORT_ADMIN_PASSWORD;
      assert.equal(importOverridePasswordValid("admin"), false);
      env.IMPORT_ADMIN_PASSWORD = "imp-test-2";
      assert.equal(importOverridePasswordValid("imp-test-2"), true);
    } finally {
      if (saved === undefined) delete env.IMPORT_ADMIN_PASSWORD;
      else env.IMPORT_ADMIN_PASSWORD = saved;
    }
  });
});

describe("source guard — no password fallbacks for real accounts", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

  it("seed / bootstrap-rbac take the owner from requireOwnerCredentials, with no literal fallback", () => {
    for (const f of ["scripts/seed.ts", "scripts/bootstrap-rbac.ts"]) {
      const src = read(f);
      assert.ok(src.includes("requireOwnerCredentials("), `${f} must use requireOwnerCredentials`);
      assert.ok(!/env\(\s*"(SUPER_)?ADMIN_(PASSWORD|EMAIL)"\s*,\s*["'`]/.test(src), `${f} has a literal owner fallback`);
      assert.ok(!/"(SUPER_)?ADMIN_(PASSWORD|EMAIL)",\s*\n\s*env\(/.test(src), `${f} has a nested owner fallback`);
    }
  });
  it("app bootstrap and import override have no literal password default", () => {
    assert.ok(!/IMPORT_ADMIN_PASSWORD\s*\|\|\s*["'`]/.test(read("src/app/api/products/import/commit/route.ts")));
    const boot = read("src/lib/auth/bootstrap.ts");
    assert.ok(!/:\s*"admin"\)/.test(boot), "bootstrap.ts still falls back to \"admin\"");
    assert.ok(!/ADMIN_PASSWORD\s*\|\|\s*["'`]/.test(boot));
  });
});
