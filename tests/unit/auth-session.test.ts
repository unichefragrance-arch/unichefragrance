/**
 * Unit tests: src/lib/auth/session.ts, src/lib/auth/formulaAdmin.ts,
 * src/lib/auth/guards.ts, src/lib/auth/apiGuard.ts (pure parts), src/lib/cors.ts
 *
 * State-based: a session token moves through issued → parsed → tampered/expired;
 * a cookie response moves through set → cleared.
 * Branch/condition: every early-return guard in the token parsers, the
 * formula-admin resolution order (cookie → owner session → headers), CORS allow-list.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import {
  applySessionCookie,
  clearSessionCookie,
  clearSessionCookieHeader,
  cookieFromRequest,
  createSessionToken,
  getSessionFromRequest,
  parseSessionToken,
  SESSION_COOKIE,
  sessionCookieHeader,
  type AppSession,
} from "@/lib/auth/session";
import {
  clearFormulaAdminCookieHeader,
  createFormulaAdminToken,
  FORMULA_ADMIN_COOKIE,
  formulaAdminCookieHeader,
  getConfiguredAdminEmail,
  getFormulaAdmin,
  isFormulaAdminResponse,
  parseFormulaAdminToken,
  requireFormulaAdmin,
  verifyFormulaAdminCredentials,
  verifyFormulaAdminPassword,
} from "@/lib/auth/formulaAdmin";
import {
  assertBranchAccess,
  branchScopeFilter,
  isAuthResponse,
  requireAuth,
  requirePermission,
  requireRole,
  sessionBranchId,
} from "@/lib/auth/guards";
import { isDbUnavailable, logServerError, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import {
  applyCorsHeaders,
  corsPreflightResponse,
  getAllowedOrigins,
  resolveCorsOrigin,
} from "@/lib/cors";
import { fakeCookieResponse, withEnv } from "./_env";

const env = process.env as Record<string, string | undefined>;
const SAVED = { ...env };
const KEYS = [
  "SESSION_SECRET", "FORMULA_ADMIN_SECRET", "ADMIN_EMAIL", "admin_email", "ADMIN_PASSWORD",
  "FORMULA_ADMIN_PASSWORD", "IMPORT_ADMIN_PASSWORD", "NODE_ENV",
  "CORS_ALLOWED_ORIGINS", "APP_URL", "NEXT_PUBLIC_APP_URL",
];
beforeEach(() => {
  for (const k of KEYS) delete env[k];
  env.SESSION_SECRET = "unit-test-session-secret";
  env.FORMULA_ADMIN_SECRET = "unit-test-formula-secret";
  env.ADMIN_EMAIL = "owner@test.invalid";
  env.ADMIN_PASSWORD = "Test-Admin#2026";
});
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete env[k];
    else env[k] = SAVED[k];
  }
});

const base: Omit<AppSession, "exp"> = {
  userId: "u1",
  name: "Sara",
  email: "  Sara@Example.COM ",
  role: "cashier",
  roleLabel: "Cashier",
  branchId: "b1",
  branchName: "Muscat",
};

function reqWith(headers: Record<string, string> = {}, url = "http://localhost/api/x", method = "GET") {
  return new Request(url, { headers, method });
}
function sessionReq(session: Partial<AppSession> = {}, url?: string, method?: string) {
  const token = createSessionToken({ ...base, ...session });
  return reqWith({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` }, url, method);
}
/** Sign a hand-made payload with the test secret, to reach the checks after the signature. */
function signRaw(payload: unknown): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b64}.${createHmac("sha256", env.SESSION_SECRET!).update(b64).digest("base64url")}`;
}

describe("session token — state transitions", () => {
  it("issued token parses back with normalised email and default exp (~12h)", () => {
    const before = Date.now();
    const s = parseSessionToken(createSessionToken(base));
    assert.ok(s);
    assert.equal(s.email, "sara@example.com");
    assert.equal(s.branchId, "b1");
    assert.ok(s.exp >= before + 12 * 3600 * 1000 - 1000 && s.exp <= Date.now() + 12 * 3600 * 1000);
    assert.equal("sid" in s, false);
  });
  it("sid is carried only when present", () => {
    const s = parseSessionToken(createSessionToken({ ...base, sid: "abc" }));
    assert.equal(s?.sid, "abc");
  });
  it("tampered payload → null", () => {
    const [p, sig] = createSessionToken(base).split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), role: "owner" })).toString("base64url");
    assert.equal(parseSessionToken(`${forged}.${sig}`), null);
  });
  it("token signed with another secret → null (secret rotation logs everyone out)", () => {
    const token = createSessionToken(base);
    env.SESSION_SECRET = "rotated";
    assert.equal(parseSessionToken(token), null);
  });
  it("expiry boundary: exp in the past → null; exp in the future → valid", () => {
    assert.equal(parseSessionToken(createSessionToken({ ...base, exp: Date.now() - 1 })), null);
    assert.ok(parseSessionToken(createSessionToken({ ...base, exp: Date.now() + 60_000 })));
  });
});

describe("parseSessionToken — every guard branch", () => {
  for (const t of [undefined, null, "", "nodot", ".sig", "payload.", "a.b.c"]) {
    it(`rejects malformed token ${JSON.stringify(t)}`, () => {
      assert.equal(parseSessionToken(t as string), null);
    });
  }
  it("signature of different length → null (no timingSafeEqual throw)", () => {
    const [p] = createSessionToken(base).split(".");
    assert.equal(parseSessionToken(`${p}.x`), null);
  });
  it("valid signature but non-JSON payload → null (catch branch)", () => {
    const b64 = Buffer.from("not json").toString("base64url");
    const sig = createHmac("sha256", env.SESSION_SECRET!).update(b64).digest("base64url");
    assert.equal(parseSessionToken(`${b64}.${sig}`), null);
  });
  const future = Date.now() + 60_000;
  const cases: [string, unknown][] = [
    ["missing userId", { role: "owner", exp: future }],
    ["missing role", { userId: "u", exp: future }],
    ["exp as string", { userId: "u", role: "owner", exp: String(future) }],
    ["null payload", null],
  ];
  for (const [label, payload] of cases) {
    it(`signed but ${label} → null`, () => {
      assert.equal(parseSessionToken(signRaw(payload)), null);
    });
  }
  it("fills defaults for optional fields (name, roleLabel, branch)", () => {
    const s = parseSessionToken(signRaw({ userId: 7, role: "owner", exp: future }));
    assert.deepEqual(s, {
      userId: "7", name: "", email: "", role: "owner", roleLabel: "owner",
      branchId: null, branchName: null, exp: future,
    });
  });
});

describe("session secret", () => {
  it("falls back to FORMULA_ADMIN_SECRET when SESSION_SECRET is unset", () => {
    delete env.SESSION_SECRET;
    assert.ok(parseSessionToken(createSessionToken(base)));
  });
  it("dev fallback secret works outside production", () => {
    delete env.SESSION_SECRET;
    delete env.FORMULA_ADMIN_SECRET;
    assert.ok(parseSessionToken(createSessionToken(base)));
  });
  it("throws in production with no secret", () => {
    delete env.SESSION_SECRET;
    delete env.FORMULA_ADMIN_SECRET;
    env.NODE_ENV = "production";
    assert.throws(() => createSessionToken(base), /SESSION_SECRET is not set/);
  });
});

describe("cookieFromRequest — string robustness", () => {
  it("finds the cookie among others, with spaces", () => {
    assert.equal(cookieFromRequest(reqWith({ cookie: "a=1;  unich_session=tok ; b=2" }), SESSION_COOKIE), "tok");
  });
  it("keeps '=' inside the value and URL-decodes it", () => {
    assert.equal(cookieFromRequest(reqWith({ cookie: "k=a%3Db=c" }), "k"), "a=b=c");
  });
  it("no cookie header / no match / prefix-only name → null", () => {
    assert.equal(cookieFromRequest(reqWith(), "k"), null);
    assert.equal(cookieFromRequest(reqWith({ cookie: "x=1" }), "k"), null);
    assert.equal(cookieFromRequest(reqWith({ cookie: "kk=1" }), "k"), null);
  });
  it("empty value returns empty string", () => {
    assert.equal(cookieFromRequest(reqWith({ cookie: "k=" }), "k"), "");
  });
  it("regression: malformed percent-encoding returns null instead of throwing", () => {
    for (const v of ["%E0", "%", "%ZZ", "abc%", "%E0%A4%A"]) {
      assert.doesNotThrow(() => cookieFromRequest(reqWith({ cookie: `k=${v}` }), "k"), v);
      assert.equal(cookieFromRequest(reqWith({ cookie: `k=${v}` }), "k"), null, v);
    }
  });
  it("regression: a malformed session cookie means no session, not a crash or a login", () => {
    const req = reqWith({ cookie: `${SESSION_COOKIE}=%E0%A4` });
    assert.equal(getSessionFromRequest(req), null);
    assert.equal((requireAuth(req) as NextResponse).status, 401);
  });
  it("regression: a malformed formula-admin cookie falls through to the other checks", () => {
    assert.equal(getFormulaAdmin(reqWith({ cookie: `${FORMULA_ADMIN_COOKIE}=%E0` })), null);
    const owner = sessionReq({ role: "owner" });
    const cookie = `${FORMULA_ADMIN_COOKIE}=%E0; ${owner.headers.get("cookie")}`;
    assert.equal(getFormulaAdmin(reqWith({ cookie }))?.name, "Sara", "owner session still accepted");
  });
  it("a valid encoded cookie elsewhere in the header is still read", () => {
    assert.equal(cookieFromRequest(reqWith({ cookie: "bad=%E0; k=ok%20yes" }), "k"), "ok yes");
  });
});

describe("getSessionFromRequest", () => {
  it("returns the session from a valid cookie, null otherwise", () => {
    assert.equal(getSessionFromRequest(sessionReq())?.userId, "u1");
    assert.equal(getSessionFromRequest(reqWith()), null);
    assert.equal(getSessionFromRequest(reqWith({ cookie: `${SESSION_COOKIE}=garbage` })), null);
  });
});

describe("session cookie set/clear — state on the response", () => {
  it("apply then clear: value set with 12h, then emptied with maxAge 0", () => {
    const res = fakeCookieResponse();
    applySessionCookie(res, "tok");
    clearSessionCookie(res);
    assert.equal(res.calls.length, 2);
    assert.deepEqual(res.calls[0], {
      name: SESSION_COOKIE, value: "tok",
      opts: { httpOnly: true, sameSite: "lax", path: "/", secure: false, maxAge: 43200 },
    });
    assert.equal(res.calls[1].value, "");
    assert.equal(res.calls[1].opts.maxAge, 0);
  });
  it("legacy header strings encode the token", () => {
    assert.equal(
      sessionCookieHeader("a b;c"),
      "unich_session=a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200",
    );
    assert.equal(clearSessionCookieHeader(), "unich_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  });
});

describe("formula admin — credentials (condition coverage)", () => {
  it("correct email (case/space-insensitive) + password → true", () => {
    assert.equal(verifyFormulaAdminCredentials({ email: "  OWNER@Test.invalid ", password: "Test-Admin#2026" }), true);
  });
  const falseCases: [string, { email?: string; password?: string }, Record<string, string | undefined>][] = [
    ["wrong password", { email: "owner@test.invalid", password: "x" }, {}],
    ["wrong email", { email: "x@gmail.com", password: "Test-Admin#2026" }, {}],
    ["password with trailing space", { email: "owner@test.invalid", password: "Test-Admin#2026 " }, {}],
    ["empty input email", { password: "Test-Admin#2026" }, {}],
    ["empty input password", { email: "owner@test.invalid" }, {}],
    ["no configured email", { email: "owner@test.invalid", password: "Test-Admin#2026" }, { ADMIN_EMAIL: undefined }],
    ["no configured password", { email: "owner@test.invalid", password: "Test-Admin#2026" }, { ADMIN_PASSWORD: undefined }],
  ];
  for (const [label, input, patch] of falseCases) {
    it(`${label} → false`, () => {
      withEnv(patch, () => assert.equal(verifyFormulaAdminCredentials(input), false));
    });
  }
  it("password source precedence: ADMIN_PASSWORD > FORMULA_ADMIN_PASSWORD > IMPORT_ADMIN_PASSWORD", () => {
    withEnv({ ADMIN_PASSWORD: undefined, FORMULA_ADMIN_PASSWORD: "f", IMPORT_ADMIN_PASSWORD: "i" }, () => {
      assert.equal(verifyFormulaAdminPassword("f"), true);
      assert.equal(verifyFormulaAdminPassword("i"), false);
    });
    withEnv({ ADMIN_PASSWORD: undefined, IMPORT_ADMIN_PASSWORD: "i" }, () => {
      assert.equal(verifyFormulaAdminPassword("i"), true);
    });
  });
  it("verifyFormulaAdminPassword: undefined / empty / nothing configured → false", () => {
    assert.equal(verifyFormulaAdminPassword(undefined), false);
    assert.equal(verifyFormulaAdminPassword(""), false);
    withEnv({ ADMIN_PASSWORD: undefined }, () => assert.equal(verifyFormulaAdminPassword("x"), false));
  });
  it("getConfiguredAdminEmail normalises and falls back to admin_email", () => {
    withEnv({ ADMIN_EMAIL: " OWNER@Test.invalid " }, () => assert.equal(getConfiguredAdminEmail(), "owner@test.invalid"));
    withEnv({ ADMIN_EMAIL: undefined, admin_email: "low@x.y" }, () => assert.equal(getConfiguredAdminEmail(), "low@x.y"));
    withEnv({ ADMIN_EMAIL: undefined }, () => assert.equal(getConfiguredAdminEmail(), ""));
  });
});

describe("formula admin token", () => {
  it("round-trips; blank name becomes 'Admin'", () => {
    const s = parseFormulaAdminToken(createFormulaAdminToken("   ", " A@B.c "));
    assert.equal(s?.name, "Admin");
    assert.equal(s?.email, "a@b.c");
  });
  it("malformed / tampered / wrong secret → null", () => {
    const tok = createFormulaAdminToken("Ali", "a@b.c");
    for (const t of [null, undefined, "", "x", "x.", ".y", tok.slice(0, -2) + "zz"]) {
      assert.equal(parseFormulaAdminToken(t as string), null, String(t));
    }
    env.FORMULA_ADMIN_SECRET = "other";
    assert.equal(parseFormulaAdminToken(tok), null);
  });
  it("throws in production with no secret of any kind", () => {
    withEnv({ NODE_ENV: "production", FORMULA_ADMIN_SECRET: undefined, ADMIN_PASSWORD: undefined, SESSION_SECRET: undefined }, () => {
      assert.throws(() => createFormulaAdminToken("a", "b"), /FORMULA_ADMIN_SECRET is not set/);
    });
  });
  it("cookie headers add Secure only in production", () => {
    assert.equal(formulaAdminCookieHeader("t"), `${FORMULA_ADMIN_COOKIE}=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`);
    withEnv({ NODE_ENV: "production" }, () => {
      assert.ok(formulaAdminCookieHeader("t").endsWith("; Secure"));
      assert.ok(clearFormulaAdminCookieHeader().endsWith("Max-Age=0; Secure"));
    });
    assert.equal(clearFormulaAdminCookieHeader(), `${FORMULA_ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  });
});

describe("getFormulaAdmin — resolution order (branch coverage)", () => {
  it("1) valid formula-admin cookie wins", () => {
    const tok = createFormulaAdminToken("Ali", "ali@x.y");
    const a = getFormulaAdmin(reqWith({ cookie: `${FORMULA_ADMIN_COOKIE}=${encodeURIComponent(tok)}` }));
    assert.equal(a?.name, "Ali");
  });
  it("2) owner app session is accepted without a password", () => {
    const a = getFormulaAdmin(sessionReq({ role: "owner", name: "" }));
    assert.equal(a?.name, "Owner");
    assert.equal(a?.email, "sara@example.com");
  });
  it("2b) non-owner app session falls through and is refused", () => {
    assert.equal(getFormulaAdmin(sessionReq({ role: "manager" })), null);
  });
  it("3) x-formula-admin-* headers with correct credentials", () => {
    const a = getFormulaAdmin(reqWith({
      "x-formula-admin-email": "OWNER@Test.invalid",
      "x-formula-admin-password": "Test-Admin#2026",
      "x-formula-admin-name": "  Boss ",
    }));
    assert.deepEqual([a?.name, a?.email], ["Boss", "owner@test.invalid"]);
  });
  it("3b) x-admin-* aliases, name defaults to email", () => {
    const a = getFormulaAdmin(reqWith({ "x-admin-email": "owner@test.invalid", "x-admin-password": "Test-Admin#2026" }));
    assert.equal(a?.name, "owner@test.invalid");
  });
  it("4) wrong header password / nothing at all → null", () => {
    assert.equal(getFormulaAdmin(reqWith({ "x-admin-email": "owner@test.invalid", "x-admin-password": "nope" })), null);
    assert.equal(getFormulaAdmin(reqWith()), null);
  });
  it("requireFormulaAdmin returns 403 response vs. the session", async () => {
    const denied = requireFormulaAdmin(reqWith());
    assert.equal(isFormulaAdminResponse(denied), true);
    assert.equal((denied as NextResponse).status, 403);
    const ok = requireFormulaAdmin(sessionReq({ role: "owner" }));
    assert.equal(isFormulaAdminResponse(ok), false);
  });
});

describe("guards", () => {
  it("requireAuth: 401 without session, session with one", () => {
    const r = requireAuth(reqWith());
    assert.ok(isAuthResponse(r));
    assert.equal((r as NextResponse).status, 401);
    assert.equal((requireAuth(sessionReq()) as AppSession).userId, "u1");
  });
  it("requireRole: 401 / 403 / pass", () => {
    assert.equal((requireRole(reqWith(), ["owner"]) as NextResponse).status, 401);
    assert.equal((requireRole(sessionReq(), ["owner", "manager"]) as NextResponse).status, 403);
    assert.equal(isAuthResponse(requireRole(sessionReq(), ["cashier"])), false);
    assert.equal((requireRole(sessionReq(), []) as NextResponse).status, 403);
  });
  it("requirePermission: 401 / 403 / pass", () => {
    assert.equal((requirePermission(reqWith(), "pos:read") as NextResponse).status, 401);
    assert.equal((requirePermission(sessionReq(), "settings:write") as NextResponse).status, 403);
    assert.equal(isAuthResponse(requirePermission(sessionReq(), "pos:write")), false);
  });

  const s = (o: Partial<AppSession>): AppSession => ({ ...base, exp: Date.now() + 1000, ...o });
  it("assertBranchAccess: every branch of the decision", () => {
    assert.equal(assertBranchAccess(s({ role: "owner", branchId: null }), "b2"), null, "owner sees all");
    assert.equal(assertBranchAccess(s({}), null), null, "shared resource");
    assert.equal(assertBranchAccess(s({}), ""), null, "empty id treated as shared");
    assert.equal(assertBranchAccess(s({ branchId: null }), "b1")?.status, 403, "no branch assigned");
    assert.equal(assertBranchAccess(s({}), "b2")?.status, 403, "other branch");
    assert.equal(assertBranchAccess(s({}), "b1"), null, "same branch");
  });
  it("branchScopeFilter: owner / no branch / branch", () => {
    assert.equal(branchScopeFilter(s({ role: "owner" })), null);
    assert.deepEqual(branchScopeFilter(s({ branchId: null })), { branchId: { $in: [null, undefined] } });
    assert.deepEqual(branchScopeFilter(s({})), {
      $or: [{ branchId: "b1" }, { branchId: null }, { branchId: { $exists: false } }],
    });
  });
  it("sessionBranchId returns the branch or null", () => {
    assert.equal(sessionBranchId(s({})), "b1");
    assert.equal(sessionBranchId(s({ branchId: null })), null);
  });
});

describe("apiGuard — error classification", () => {
  const named = (name: string, message = "m") => Object.assign(new Error(message), { name });

  it("isDbUnavailable only for driver connection errors", () => {
    assert.equal(isDbUnavailable(named("MongoServerSelectionError")), true);
    assert.equal(isDbUnavailable(named("MongoServerError")), false);
    assert.equal(isDbUnavailable({ name: "MongoNetworkError" }), false, "plain object is not an Error");
    assert.equal(isDbUnavailable(null), false);
  });

  it("safeErrorMessage branches", (t) => {
    t.mock.method(console, "error", () => {});
    assert.equal(safeErrorMessage(new SyntaxError("x"), "F"), "Request body must be valid JSON");
    assert.equal(safeErrorMessage(Object.assign(named("ValidationError"), { errors: { a: 1, b: 2 } }), "F"), "Invalid data: a, b");
    assert.equal(safeErrorMessage(named("ValidationError"), "F"), "Invalid data");
    assert.equal(safeErrorMessage(new Error("Out of stock"), "F"), "Out of stock", "business error keeps message");
    assert.equal(safeErrorMessage(new Error(""), "F"), "F", "empty message → fallback");
    for (const e of [new TypeError("x"), named("MongoServerError"), named("MongoWhatever"), "a string", null]) {
      assert.match(safeErrorMessage(e, "Login failed"), /^Login failed\. Something went wrong — please try again \(ref [0-9a-f]{8}\)\.$/);
    }
  });

  it("logServerError redacts connection strings and key values", (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (msg: string) => logged.push(msg));
    logServerError("r1", Object.assign(new Error(
      'bad auth mongodb+srv://user:pw@host/db dup key: { email: "a@b.c" } for value "secret"',
    ), { name: "MongoServerError", code: 11000 }));
    logServerError("r2", "plain string");
    assert.match(logged[0], /^\[api-error ref=r1\] MongoServerError \(code 11000\): /);
    assert.ok(!logged[0].includes("user:pw"));
    assert.ok(!logged[0].includes("a@b.c"));
    assert.ok(!logged[0].includes("secret"));
    assert.match(logged[1], /\[api-error ref=r2\] Error: plain string/);
  });

  it("requireApiAccess: public paths skip auth", () => {
    for (const p of ["/api/health", "/api/auth/login", "/api/auth/me", "/api/auth/formula-admin/x", "/api/quotations/public/tok"]) {
      assert.equal(requireApiAccess(reqWith({}, `http://h${p}`)), null, p);
    }
  });
  it("requireApiAccess: 401 without session on a private path", () => {
    assert.equal((requireApiAccess(reqWith({}, "http://h/api/sales")) as NextResponse).status, 401);
  });
  it("requireApiAccess: settings GET ok for anyone, POST needs settings:write", () => {
    assert.equal(isAuthResponse(requireApiAccess(sessionReq({}, "http://h/api/settings")) as AppSession), false);
    assert.equal((requireApiAccess(sessionReq({}, "http://h/api/settings", "POST")) as NextResponse).status, 403);
    assert.equal(isAuthResponse(requireApiAccess(sessionReq({ role: "owner" }, "http://h/api/settings", "PATCH")) as AppSession), false);
  });
  it("requireApiAccess: products read vs write", () => {
    assert.equal(isAuthResponse(requireApiAccess(sessionReq({}, "http://h/api/products")) as AppSession), false, "cashier reads catalog via pos:read");
    assert.equal((requireApiAccess(sessionReq({}, "http://h/api/products", "POST")) as NextResponse).status, 403);
    assert.equal(isAuthResponse(requireApiAccess(sessionReq({ role: "accountant" }, "http://h/api/products")) as AppSession), false, "accountant via purchases:read");
    // No real role lacks every catalog permission — only an unknown role reaches the deny branch.
    assert.equal((requireApiAccess(sessionReq({ role: "ghost" as never }, "http://h/api/products")) as NextResponse).status, 403);
  });
});

describe("CORS", () => {
  const origin = (o?: string, method = "GET") => new Request("http://h/api/x", { method, headers: o ? { origin: o } : {} });

  it("default origins, env list (trimmed, deduped) and APP_URL extras", () => {
    withEnv({ CORS_ALLOWED_ORIGINS: " https://a.com , ,http://localhost:3000", APP_URL: "https://app.com " }, () => {
      assert.deepEqual(getAllowedOrigins(), ["http://localhost:3000", "http://127.0.0.1:3000", "https://a.com", "https://app.com"]);
    });
  });
  it("resolveCorsOrigin: no origin / allowed / not allowed / wildcard reflects", () => {
    assert.equal(resolveCorsOrigin(origin()), null);
    assert.equal(resolveCorsOrigin(origin("http://localhost:3000")), "http://localhost:3000");
    assert.equal(resolveCorsOrigin(origin("http://localhost:3000/")), null, "trailing slash is a different origin");
    assert.equal(resolveCorsOrigin(origin("https://evil.com")), null);
    withEnv({ CORS_ALLOWED_ORIGINS: "*" }, () => {
      assert.equal(resolveCorsOrigin(origin("https://evil.com")), "https://evil.com");
    });
  });
  it("applyCorsHeaders sets headers only for allowed origins", () => {
    const ok = applyCorsHeaders(NextResponse.json({}), origin("http://localhost:3000"));
    assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "http://localhost:3000");
    assert.equal(ok.headers.get("Access-Control-Allow-Credentials"), "true");
    assert.equal(ok.headers.get("Vary"), "Origin");
    const no = applyCorsHeaders(NextResponse.json({}), origin("https://evil.com"));
    assert.equal(no.headers.get("Access-Control-Allow-Origin"), null);
  });
  it("corsPreflightResponse: non-OPTIONS → null, bad origin → 403, good → 204", () => {
    assert.equal(corsPreflightResponse(origin("http://localhost:3000")), null);
    assert.equal(corsPreflightResponse(origin("https://evil.com", "OPTIONS"))?.status, 403);
    const pre = corsPreflightResponse(origin("http://localhost:3000", "OPTIONS"));
    assert.equal(pre?.status, 204);
    assert.equal(pre?.headers.get("Access-Control-Max-Age"), "86400");
  });
});
