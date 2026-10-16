/**
 * Authorization / RBAC suite (npm run test:authz).
 *
 * Drives the real route handlers and the proxy with sessions for every role
 * the code defines (src/lib/auth/roles.ts) and checks, for each denied
 * request, that the persisted state did not change — not just the status.
 *
 * Covers: the role → operation matrix, anonymous / forged / expired / revoked
 * sessions, vertical escalation (users, branches, settings), branch isolation
 * on reads and writes, cost-price disclosure, per-user notification state,
 * logout of the formula-admin unlock, and server-owned fields on create.
 *
 * Safety: refuses any non-local DATABASE_URL (e2eGuard). Never loads .env.
 * Uses its own database, dropped at the end ONLY if its name starts with
 * "unich_authz_".
 *
 *   DATABASE_URL='mongodb://127.0.0.1:27499/unich_authz_run?replicaSet=rs0&directConnection=true' \
 *     npm run test:authz
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { assertLocalDb } from "../../src/lib/e2eGuard";

assertLocalDb();
const env = process.env as Record<string, string | undefined>;
// Signs test session cookies; never a real secret.
env.SESSION_SECRET ||= randomBytes(32).toString("hex");
env.FORMULA_ADMIN_SECRET ||= randomBytes(32).toString("hex");

/* eslint-disable @typescript-eslint/no-explicit-any */
let passed = 0;
let failed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(name);
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message.split("\n").slice(0, 6).join("\n    ")}`);
  }
}

const ROLES = ["owner", "manager", "cashier", "accountant", "inventory", "branch_manager"] as const;
type Role = (typeof ROLES)[number];

async function main() {
  // Imported after the guard so nothing can connect before it runs.
  const { connectDB } = await import("../../src/lib/db");
  const models = await import("../../src/lib/models");
  const { AppSettings, AuthSession, Branch, DeliveryLog, Expense, FifoLayer, Notification, Product, PurchaseOrder, Quotation, Sale, Supplier, User } = models;
  const { createSessionToken, SESSION_COOKIE } = await import("../../src/lib/auth/session");
  const { testSessionCookie } = await import("../../src/lib/auth/testSession");
  const { requireApiAccess, isAuthResponse } = await import("../../src/lib/auth/apiGuard");
  const { FORMULA_ADMIN_COOKIE, createFormulaAdminToken } = await import("../../src/lib/auth/formulaAdmin");
  const { proxy } = await import("../../src/proxy");
  const { NextRequest } = await import("next/server");

  const usersRoute = await import("../../src/app/api/users/route");
  const userRoute = await import("../../src/app/api/users/[id]/route");
  const branchesRoute = await import("../../src/app/api/branches/route");
  const settingsRoute = await import("../../src/app/api/settings/route");
  const salesRoute = await import("../../src/app/api/sales/route");
  const saleRoute = await import("../../src/app/api/sales/[id]/route");
  const quotationRoute = await import("../../src/app/api/quotations/[id]/route");
  const quotationPrintRoute = await import("../../src/app/api/quotations/[id]/print/route");
  const expensesRoute = await import("../../src/app/api/expenses/route");
  const expenseRoute = await import("../../src/app/api/expenses/[id]/route");
  const purchaseRoute = await import("../../src/app/api/purchases/[id]/route");
  const productsRoute = await import("../../src/app/api/products/route");
  const productRoute = await import("../../src/app/api/products/[id]/route");
  const productExportRoute = await import("../../src/app/api/products/export/route");
  const suppliersRoute = await import("../../src/app/api/suppliers/route");
  const customerRoute = await import("../../src/app/api/customers/[id]/route");
  const dashboardRoute = await import("../../src/app/api/dashboard/route");
  const notificationsRoute = await import("../../src/app/api/notifications/route");
  const deliveryLogRoute = await import("../../src/app/api/notifications/log/route");
  const logoutRoute = await import("../../src/app/api/auth/logout/route");

  await connectDB();
  const dbName = mongoose.connection.db!.databaseName;
  console.log(`DB target: ${mongoose.connection.host}:${mongoose.connection.port}/${dbName}`);

  /* ---------- helpers ---------- */
  const BASE = "http://localhost:3000";
  function request(method: string, path: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) {
    return new Request(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  }
  async function call(
    handler: (req: Request, ctx: any) => Promise<Response> | Response,
    method: string,
    path: string,
    cookie: string | null,
    body?: unknown,
    params?: Record<string, string>,
  ) {
    const res = await handler(request(method, path, cookie, body), { params: Promise.resolve(params ?? {}) });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* html / binary */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  const oid = () => new mongoose.Types.ObjectId();
  const snapshot = async (model: any, id: unknown) =>
    JSON.stringify(await model.findById(id).lean());

  /** Signed, well-formed cookie (not backed by a live server session). */
  const signedCookie = (role: Role, branchId: string | null, extra: Record<string, unknown> = {}) =>
    `${SESSION_COOKIE}=${encodeURIComponent(createSessionToken({
      userId: String(oid()), name: `AZ ${role}`, email: `az-${role}@test.invalid`,
      role, roleLabel: role, branchId, branchName: branchId ? "AZ" : null, sid: "x", ...extra,
    } as any))}`;

  /* ---------- fixtures ---------- */
  const branchA = await Branch.create({ name: "AZ Branch A", code: `AZA${Date.now() % 1e6}` });
  const branchB = await Branch.create({ name: "AZ Branch B", code: `AZB${Date.now() % 1e6}` });
  const A = String(branchA._id);
  const B = String(branchB._id);
  const live = async (role: Role, branchId: string | null) => {
    const cookie = await testSessionCookie({
      userId: String(oid()), name: `AZ ${role} ${branchId ? (branchId === A ? "A" : "B") : "none"}`,
      email: "x@test.local", role, roleLabel: role, branchId, branchName: branchId ? "AZ" : null,
    });
    const token = decodeURIComponent(cookie.split("=").slice(1).join("="));
    const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    return { cookie, userId: payload.userId as string, sid: payload.sid as string };
  };
  const ck = {
    owner: await live("owner", null),
    managerA: await live("manager", A),
    managerNone: await live("manager", null),
    cashierA: await live("cashier", A),
    cashierB: await live("cashier", B),
    accountantA: await live("accountant", A),
    accountantNone: await live("accountant", null),
    inventoryA: await live("inventory", A),
    bmA: await live("branch_manager", A),
  };

  const product = await Product.create({
    sku: `AZ-${Date.now()}`, name: "AZ Perfume", category: "Perfume", unit: "pcs",
    sellPrice: 20, wholesalePrice: 12, costFifo: 7.5, minMarginPct: 30, stockSellable: 10,
  });
  await FifoLayer.create({
    productId: product._id, supplierId: oid(), supplierName: "AZ", purchaseDate: new Date(),
    qtyRemaining: 10, originalQty: 10, unitCost: 7.5, currency: "OMR",
  });

  const saleDoc = (branchId: string, status: string) => ({
    _id: oid(), customerPhone: "+96890000000", customerName: "AZ Customer", salesperson: "AZ",
    payment: "cash", saleType: "Retail", status, subtotal: 20, total: 20, branchId: new mongoose.Types.ObjectId(branchId),
    lines: [{ productId: product._id, name: "AZ Perfume", qty: 1, unitLabel: "pcs", unitPrice: 20, lineType: "ready" }],
    inventoryDeductions: [{
      productId: product._id, productName: "AZ Perfume", qty: 1, reason: "sale", lineIndex: 0, costTotal: 7.5,
      batches: [{ layerId: oid(), qty: 1, unitCost: 7.5, purchaseDate: new Date() }],
    }],
    createdAt: new Date(), updatedAt: new Date(),
  });
  const saleA = saleDoc(A, "completed");
  const saleB = saleDoc(B, "completed");
  const heldB = saleDoc(B, "held");
  await Sale.collection.insertMany([saleA, saleB, heldB]);

  const quoteB = {
    _id: oid(), number: `AZ-Q-${Date.now()}`, customerName: "Branch B Secret Client", customerPhone: "+96891111111",
    date: new Date(), expiry: new Date(Date.now() + 864e6), status: "draft", version: 1,
    subtotal: 20, vatPercent: 0, vatAmount: 0, total: 20, branchId: branchB._id,
    lines: [{ productId: product._id, name: "AZ Perfume", qty: 1, unitLabel: "pcs", unitPrice: 20, lineType: "ready", charges: 0 }],
    history: [], versions: [], createdAt: new Date(), updatedAt: new Date(),
  };
  await Quotation.collection.insertOne(quoteB);

  const expenseA = await Expense.create({ date: new Date(), category: "AZ-A", detail: "a", amount: 11, branchId: branchA._id });
  const expenseB = await Expense.create({ date: new Date(), category: "AZ-B", detail: "b", amount: 22, branchId: branchB._id });

  const supplier = await Supplier.create({ name: "AZ Supplier", phone: "+96892222222" });
  const poB = await PurchaseOrder.create({
    supplierId: supplier._id, supplierName: supplier.name, date: new Date(), status: "draft",
    subtotal: 10, vatPercent: 0, vatAmount: 0, total: 10, itemCount: 1, branchId: branchB._id,
    lines: [{ productId: product._id, productName: product.name, qtyOrdered: 1, unitCost: 10 }],
  });

  await DeliveryLog.create({ channel: "whatsapp", kind: "receipt", status: "handoff", saleId: saleB._id, to: "+96893333333" });
  await AppSettings.updateOne({ key: "default" }, { $setOnInsert: { key: "default" } }, { upsert: true });

  /* ======================================================================
   * 1. Role → operation matrix (server-side guard, no UI involved).
   *    Expected sets come from roles.ts + apiGuard.ts as reviewed, written
   *    out explicitly so a silent permission change fails here.
   * ==================================================================== */
  console.log("\n— Permission matrix (requireApiAccess)");
  const ALL: Role[] = [...ROLES];
  const MATRIX: [string, string, Role[]][] = [
    ["GET", "/api/users", ["owner", "manager"]],
    ["POST", "/api/users", ["owner", "manager"]],
    ["GET", "/api/branches", ["owner", "manager"]],
    ["POST", "/api/branches", ["owner"]],
    ["GET", "/api/settings", ALL],
    ["PUT", "/api/settings", ["owner", "manager"]],
    ["GET", "/api/products", ALL],
    ["POST", "/api/products", ["owner", "manager", "inventory", "branch_manager"]],
    ["DELETE", "/api/products/x", ["owner", "manager", "inventory", "branch_manager"]],
    ["GET", "/api/products/export", ["owner", "manager", "inventory", "branch_manager"]],
    ["GET", "/api/products/import/template", ["owner", "manager", "inventory", "branch_manager"]],
    ["POST", "/api/fifo-layers", ["owner", "manager", "inventory", "branch_manager"]],
    ["GET", "/api/formulas", ["owner", "manager"]],
    ["POST", "/api/formulas", ["owner", "manager"]],
    ["GET", "/api/production", ["owner", "manager", "branch_manager"]],
    ["POST", "/api/production", ["owner", "manager"]],
    ["POST", "/api/inventory/adjustments", ["owner", "manager", "inventory", "branch_manager"]],
    ["POST", "/api/inventory/transfers", ["owner", "manager", "inventory", "branch_manager"]],
    ["GET", "/api/purchases", ["owner", "manager", "accountant", "inventory", "branch_manager"]],
    ["POST", "/api/purchases", ["owner", "manager", "branch_manager"]],
    ["PUT", "/api/purchases/x", ["owner", "manager", "branch_manager"]],
    ["POST", "/api/suppliers", ["owner", "manager", "branch_manager"]],
    ["GET", "/api/customers", ["owner", "manager", "cashier", "branch_manager"]],
    ["PUT", "/api/customers/x", ["owner", "manager", "cashier", "branch_manager"]],
    ["GET", "/api/quotations", ["owner", "manager", "cashier", "branch_manager"]],
    ["GET", "/api/quotations/x/print", ["owner", "manager", "cashier", "branch_manager"]],
    ["POST", "/api/sales", ["owner", "manager", "cashier", "branch_manager"]],
    ["PATCH", "/api/sales/x", ["owner", "manager", "cashier", "branch_manager"]],
    ["GET", "/api/reports/sales", ["owner", "manager", "accountant", "branch_manager"]],
    ["GET", "/api/reports/engine", ["owner", "manager", "accountant", "branch_manager"]],
    ["GET", "/api/expenses", ["owner", "manager", "accountant", "branch_manager"]],
    ["PUT", "/api/expenses/x", ["owner", "manager", "accountant", "branch_manager"]],
    ["GET", "/api/dashboard", ALL],
    ["GET", "/api/notifications", ALL],
    ["PATCH", "/api/notifications", ALL],
    ["POST", "/api/notifications/log", ["owner", "manager", "cashier", "accountant", "branch_manager"]],
    ["POST", "/api/receipts/preview", ["owner", "manager", "cashier", "accountant", "branch_manager"]],
  ];
  for (const [method, path, allowed] of MATRIX) {
    await test(`${method} ${path}: allowed = ${allowed.length === ALL.length ? "every role" : allowed.join(", ")}`, async () => {
      for (const role of ROLES) {
        const res = requireApiAccess(request(method, path, signedCookie(role, A)));
        const ok = res !== null && !isAuthResponse(res);
        assert.equal(ok, allowed.includes(role), `${role}: ${ok ? "allowed" : `denied (${(res as any)?.status})`}`);
      }
    });
  }

  /* ======================================================================
   * 2. Authentication: anonymous, forged, malformed, expired, revoked.
   * ==================================================================== */
  console.log("\n— Authentication");
  await test("every protected path answers 401 with no cookie", async () => {
    for (const [method, path] of MATRIX) {
      const res = requireApiAccess(request(method, path, null));
      assert.ok(res && isAuthResponse(res) && res.status === 401, `${method} ${path}`);
    }
  });
  await test("tampered, malformed and expired cookies are treated as no session (401)", async () => {
    const good = signedCookie("owner", null);
    const token = decodeURIComponent(good.split("=").slice(1).join("="));
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), role: "owner", userId: "x" })).toString("base64url");
    const bad = [
      `${SESSION_COOKIE}=${forged}.${sig}`,
      `${SESSION_COOKIE}=${payload}.AAAA`,
      `${SESSION_COOKIE}=garbage`,
      `${SESSION_COOKIE}=${payload}`,
      `${SESSION_COOKIE}=`,
      signedCookie("owner", null, { exp: Date.now() - 1000 }),
    ];
    for (const cookie of bad) {
      const res = requireApiAccess(request("GET", "/api/users", cookie));
      assert.ok(res && isAuthResponse(res) && res.status === 401, cookie.slice(0, 40));
    }
  });
  await test("a role claim the code does not define grants nothing", async () => {
    const res = requireApiAccess(request("GET", "/api/users", signedCookie("superadmin" as Role, null)));
    assert.ok(res && isAuthResponse(res) && res.status === 403);
  });

  const viaProxy = async (cookie: string, path = "/api/sales") =>
    (await proxy(new NextRequest(`${BASE}${path}`, { headers: { cookie } }))).status;

  await test("proxy: a signed cookie with no server-side session is refused (401)", async () => {
    assert.equal(await viaProxy(signedCookie("owner", null)), 401);
  });
  await test("proxy: a live session passes", async () => {
    const s = await live("cashier", A);
    assert.notEqual(await viaProxy(s.cookie), 401);
  });
  await test("proxy: logout revokes the session; reusing the cookie is refused", async () => {
    const s = await live("cashier", A);
    const r = await call(logoutRoute.POST, "POST", "/api/auth/logout", s.cookie);
    assert.equal(r.status, 200);
    assert.equal(await viaProxy(s.cookie), 401);
  });
  await test("proxy: demotion, branch move and deactivation end an existing session", async () => {
    const demoted = await live("manager", A);
    await User.updateOne({ _id: demoted.userId }, { $set: { role: "cashier" } });
    assert.equal(await viaProxy(demoted.cookie, "/api/users"), 401, "demoted");
    const moved = await live("cashier", A);
    await User.updateOne({ _id: moved.userId }, { $set: { branchId: branchB._id } });
    assert.equal(await viaProxy(moved.cookie), 401, "moved branch");
    const off = await live("cashier", A);
    await User.updateOne({ _id: off.userId }, { $set: { active: false } });
    assert.equal(await viaProxy(off.cookie), 401, "deactivated");
    const expired = await live("cashier", A);
    await AuthSession.updateOne({ sid: expired.sid }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await viaProxy(expired.cookie), 401, "server-side expiry");
  });
  await test("logout also drops the formula-admin unlock cookie", async () => {
    const s = await live("manager", A);
    const fa = `${FORMULA_ADMIN_COOKIE}=${encodeURIComponent(createFormulaAdminToken("AZ", "az@test.invalid"))}`;
    const r = await call(logoutRoute.POST, "POST", "/api/auth/logout", `${s.cookie}; ${fa}`);
    const setCookies = r.headers.getSetCookie().join("\n");
    assert.match(setCookies, new RegExp(`${FORMULA_ADMIN_COOKIE}=;[^\\n]*Max-Age=0`, "i"), setCookies || "(no Set-Cookie)");
  });

  /* ======================================================================
   * 3. Vertical escalation: users, branches, settings.
   * ==================================================================== */
  console.log("\n— Vertical escalation");
  const ownerUser = await User.findById(ck.owner.userId).lean<any>();
  const userCount = () => User.countDocuments();

  await test("cashier / accountant / inventory / branch_manager cannot list or create users", async () => {
    const before = await userCount();
    for (const s of [ck.cashierA, ck.accountantA, ck.inventoryA, ck.bmA]) {
      assert.equal((await call(usersRoute.GET, "GET", "/api/users", s.cookie)).status, 403);
      const r = await call(usersRoute.POST, "POST", "/api/users", s.cookie, { name: "x", email: `esc-${Date.now()}@t.invalid`, password: "secret123", role: "owner" });
      assert.equal(r.status, 403);
    }
    assert.equal(await userCount(), before);
  });
  await test("manager cannot create an Owner, nor a user in another branch", async () => {
    const before = await userCount();
    const r1 = await call(usersRoute.POST, "POST", "/api/users", ck.managerA.cookie, { name: "x", email: `own-${Date.now()}@t.invalid`, password: "secret123", role: "owner" });
    assert.equal(r1.status, 403);
    const r2 = await call(usersRoute.POST, "POST", "/api/users", ck.managerA.cookie, { name: "x", email: `bb-${Date.now()}@t.invalid`, password: "secret123", role: "cashier", branchId: B });
    assert.equal(r2.status, 403);
    assert.equal(await userCount(), before);
  });
  await test("manager cannot promote themself (or anyone) to Owner; nothing changes", async () => {
    const before = await snapshot(User, ck.managerA.userId);
    const r = await call(userRoute.PUT, "PUT", `/api/users/${ck.managerA.userId}`, ck.managerA.cookie, { role: "owner" }, { id: ck.managerA.userId });
    assert.equal(r.status, 403);
    assert.equal(await snapshot(User, ck.managerA.userId), before);
  });
  await test("manager cannot edit, reset the password of, or deactivate an Owner", async () => {
    const before = await snapshot(User, ownerUser._id);
    for (const body of [{ password: "takeover123" }, { email: "evil@t.invalid" }, { active: false }, { role: "cashier" }]) {
      const r = await call(userRoute.PUT, "PUT", `/api/users/${ownerUser._id}`, ck.managerA.cookie, body, { id: String(ownerUser._id) });
      assert.equal(r.status, 403, JSON.stringify(body));
    }
    assert.equal((await call(userRoute.DELETE, "DELETE", `/api/users/${ownerUser._id}`, ck.managerA.cookie, undefined, { id: String(ownerUser._id) })).status, 403);
    assert.equal(await snapshot(User, ownerUser._id), before);
  });
  await test("manager of branch A cannot edit a branch-B user or move a user into branch B", async () => {
    const before = await snapshot(User, ck.cashierB.userId);
    const r1 = await call(userRoute.PUT, "PUT", `/api/users/${ck.cashierB.userId}`, ck.managerA.cookie, { name: "hijacked" }, { id: ck.cashierB.userId });
    assert.equal(r1.status, 403);
    assert.equal(await snapshot(User, ck.cashierB.userId), before);
    const beforeA = await snapshot(User, ck.cashierA.userId);
    const r2 = await call(userRoute.PUT, "PUT", `/api/users/${ck.cashierA.userId}`, ck.managerA.cookie, { branchId: B }, { id: ck.cashierA.userId });
    assert.equal(r2.status, 403);
    assert.equal(await snapshot(User, ck.cashierA.userId), beforeA);
  });
  await test("user create ignores server-owned fields (passwordHash, lastLoginAt, _id)", async () => {
    const forcedId = String(oid());
    const r = await call(usersRoute.POST, "POST", "/api/users", ck.owner.cookie, {
      _id: forcedId, name: "Mass", email: `mass-${Date.now()}@t.invalid`, password: "secret123", role: "cashier",
      branchId: A, passwordHash: "plain", lastLoginAt: "2000-01-01",
    });
    assert.equal(r.status, 201);
    const u = await User.findById(r.json.id).lean<any>();
    assert.notEqual(String(u._id), forcedId);
    assert.notEqual(u.passwordHash, "plain");
    assert.equal(u.lastLoginAt ?? null, null);
    assert.equal(r.json.passwordHash, undefined, "hash must not be returned");
  });
  await test("users list never returns password hashes", async () => {
    const r = await call(usersRoute.GET, "GET", "/api/users", ck.owner.cookie);
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes("passwordHash") && !r.text.includes("scrypt"), "hash leaked");
  });
  await test("only Owner creates branches", async () => {
    const before = await Branch.countDocuments();
    for (const s of [ck.managerA, ck.bmA, ck.cashierA]) {
      assert.equal((await call(branchesRoute.POST, "POST", "/api/branches", s.cookie, { name: "Rogue", code: `R${Date.now()}` })).status, 403);
    }
    assert.equal(await Branch.countDocuments(), before);
  });
  await test("non-managers cannot change settings; repeated attempts change nothing", async () => {
    const before = JSON.stringify(await AppSettings.findOne({ key: "default" }).lean());
    for (const s of [ck.cashierA, ck.accountantA, ck.inventoryA, ck.bmA]) {
      for (let i = 0; i < 2; i++) {
        const r = await call(settingsRoute.PUT, "PUT", "/api/settings", s.cookie, { vatPercent: 99, receiptFooter: "pwned" });
        assert.equal(r.status, 403);
      }
    }
    assert.equal(JSON.stringify(await AppSettings.findOne({ key: "default" }).lean()), before);
  });

  /* ======================================================================
   * 4. Branch isolation (horizontal, by manipulated ids).
   * ==================================================================== */
  console.log("\n— Branch isolation");
  await test("cashier A cannot read a branch-B sale by id", async () => {
    const r = await call(saleRoute.GET, "GET", `/api/sales/${saleB._id}`, ck.cashierA.cookie, undefined, { id: String(saleB._id) });
    assert.equal(r.status, 403);
    assert.ok(!r.text.includes("AZ Customer"));
  });
  await test("cashier A cannot void a branch-B held bill; it stays held", async () => {
    for (let i = 0; i < 2; i++) {
      const r = await call(saleRoute.PATCH, "PATCH", `/api/sales/${heldB._id}`, ck.cashierA.cookie, { status: "void" }, { id: String(heldB._id) });
      assert.equal(r.status, 403);
    }
    assert.equal((await Sale.findById(heldB._id).lean<any>()).status, "held");
  });
  await test("sales list for cashier A excludes branch B, whatever the query says", async () => {
    for (const qs of ["", "?status=all", `?branchId=${B}`, "?status=all&limit=500"]) {
      const r = await call(salesRoute.GET, "GET", `/api/sales${qs}`, ck.cashierA.cookie);
      assert.equal(r.status, 200);
      const ids = (r.json as any[]).map((s) => String(s.id));
      assert.ok(!ids.includes(String(saleB._id)) && !ids.includes(String(heldB._id)), qs);
    }
  });
  await test("cashier A cannot read, edit or delete a branch-B quotation", async () => {
    const before = await snapshot(Quotation, quoteB._id);
    const p = { id: String(quoteB._id) };
    assert.equal((await call(quotationRoute.GET, "GET", `/api/quotations/${quoteB._id}`, ck.cashierA.cookie, undefined, p)).status, 403);
    assert.equal((await call(quotationRoute.PUT, "PUT", `/api/quotations/${quoteB._id}`, ck.cashierA.cookie, { customerName: "x", status: "approved" }, p)).status, 403);
    assert.equal((await call(quotationRoute.DELETE, "DELETE", `/api/quotations/${quoteB._id}`, ck.cashierA.cookie, undefined, p)).status, 403);
    assert.equal((await call(quotationRoute.POST, "POST", `/api/quotations/${quoteB._id}`, ck.cashierA.cookie, { action: "revise", lines: [] }, p)).status, 403);
    assert.equal(await snapshot(Quotation, quoteB._id), before);
  });
  await test("cashier A cannot print a branch-B quotation (customer data, prices)", async () => {
    const r = await call(quotationPrintRoute.GET, "GET", `/api/quotations/${quoteB._id}/print`, ck.cashierA.cookie, undefined, { id: String(quoteB._id) });
    assert.equal(r.status, 403, `status ${r.status}`);
    assert.ok(!r.text.includes("Branch B Secret Client"), "branch-B customer name leaked");
  });
  await test("branch-B quotation still prints for its own branch and for Owner", async () => {
    for (const s of [ck.cashierB, ck.owner]) {
      const r = await call(quotationPrintRoute.GET, "GET", `/api/quotations/${quoteB._id}/print`, s.cookie, undefined, { id: String(quoteB._id) });
      assert.equal(r.status, 200);
    }
  });
  await test("accountant A cannot edit or delete a branch-B expense; it is unchanged", async () => {
    const before = await snapshot(Expense, expenseB._id);
    const p = { id: String(expenseB._id) };
    assert.equal((await call(expenseRoute.PUT, "PUT", `/api/expenses/${expenseB._id}`, ck.accountantA.cookie, { amount: 0, status: "approved" }, p)).status, 403);
    assert.equal((await call(expenseRoute.DELETE, "DELETE", `/api/expenses/${expenseB._id}`, ck.accountantA.cookie, undefined, p)).status, 403);
    assert.equal(await snapshot(Expense, expenseB._id), before);
  });
  await test("expense edit cannot move an own-branch expense to branch B (plain field or $set)", async () => {
    const p = { id: String(expenseA._id) };
    await call(expenseRoute.PUT, "PUT", `/api/expenses/${expenseA._id}`, ck.accountantA.cookie, { branchId: B, branchName: "B" }, p);
    const r = await call(expenseRoute.PUT, "PUT", `/api/expenses/${expenseA._id}`, ck.accountantA.cookie, { $set: { branchId: B } }, p);
    assert.equal(r.status, 400);
    assert.equal(String((await Expense.findById(expenseA._id).lean<any>()).branchId), A);
  });
  await test("expense list for accountant A excludes branch B", async () => {
    const r = await call(expensesRoute.GET, "GET", "/api/expenses", ck.accountantA.cookie);
    const ids = (r.json as any[]).map((e) => String(e.id));
    assert.ok(ids.includes(String(expenseA._id)) && !ids.includes(String(expenseB._id)));
  });
  await test("expense create stamps the caller's branch, ignoring a client branchId", async () => {
    const r = await call(expensesRoute.POST, "POST", "/api/expenses", ck.accountantA.cookie, { category: "AZ", detail: "x", amount: 1, branchId: B });
    assert.equal(r.status, 201);
    assert.equal(String((await Expense.findById(r.json.id).lean<any>()).branchId), A);
  });
  await test("branch manager A cannot edit or delete a branch-B purchase order", async () => {
    const before = await snapshot(PurchaseOrder, poB._id);
    const p = { id: String(poB._id) };
    assert.equal((await call(purchaseRoute.PUT, "PUT", `/api/purchases/${poB._id}`, ck.bmA.cookie, { receiveAll: true }, p)).status, 403);
    assert.equal((await call(purchaseRoute.DELETE, "DELETE", `/api/purchases/${poB._id}`, ck.bmA.cookie, undefined, p)).status, 403);
    assert.equal(await snapshot(PurchaseOrder, poB._id), before);
    assert.equal((await Product.findById(product._id).lean<any>()).stockSellable, 10, "no stock received");
  });
  await test("delivery log: cashier A cannot read branch-B receipt recipients", async () => {
    const r1 = await call(deliveryLogRoute.GET, "GET", `/api/notifications/log?saleId=${saleB._id}`, ck.cashierA.cookie);
    assert.ok(r1.status === 403 || (Array.isArray(r1.json) && r1.json.length === 0), `status ${r1.status}`);
    const r2 = await call(deliveryLogRoute.GET, "GET", "/api/notifications/log", ck.cashierA.cookie);
    assert.ok(!r2.text.includes("+96893333333"), "branch-B recipient leaked in unfiltered list");
  });
  await test("non-owner with no branch: dashboard and expense list show no branch's money", async () => {
    const d = await call(dashboardRoute.GET, "GET", "/api/dashboard", ck.accountantNone.cookie);
    assert.equal(d.status, 200);
    assert.equal(d.json.stats.monthExpenseTotal ?? 0, 0, `month expenses ${d.json.stats.monthExpenseTotal}`);
    const e = await call(expensesRoute.GET, "GET", "/api/expenses", ck.accountantNone.cookie);
    const ids = (e.json as any[]).map((x) => String(x.id));
    assert.ok(!ids.includes(String(expenseA._id)) && !ids.includes(String(expenseB._id)), "branch expenses listed");
  });
  await test("dashboard for branch A counts branch-A money only", async () => {
    const d = await call(dashboardRoute.GET, "GET", "/api/dashboard", ck.accountantA.cookie);
    const own = await Expense.find({ branchId: branchA._id, date: { $gte: new Date(new Date().setDate(1)) } }).lean<any[]>();
    const expected = own.reduce((s, x) => s + x.amount, 0);
    assert.equal(Math.round(d.json.stats.monthExpenseTotal * 1000), Math.round(expected * 1000));
  });

  /* ======================================================================
   * 5. Sensitive reads: cost prices for the cashier role.
   *    Policy (roles.ts canViewCostPrices): cashier never sees cost/margin.
   * ==================================================================== */
  console.log("\n— Cost-price disclosure");
  const COSTS = ["wholesalePrice", "costFifo", "minMarginPct"];
  await test("product list hides cost fields from cashier (existing behaviour)", async () => {
    const r = await call(productsRoute.GET, "GET", "/api/products", ck.cashierA.cookie);
    const p = (r.json as any[]).find((x) => x.id === String(product._id));
    for (const f of COSTS) assert.equal(p[f], undefined, f);
  });
  await test("product detail hides cost fields from cashier too", async () => {
    const r = await call(productRoute.GET, "GET", `/api/products/${product._id}`, ck.cashierA.cookie, undefined, { id: String(product._id) });
    assert.equal(r.status, 200);
    for (const f of COSTS) assert.equal(r.json[f], undefined, `${f}=${r.json[f]}`);
  });
  await test("product detail keeps cost fields for inventory role", async () => {
    const r = await call(productRoute.GET, "GET", `/api/products/${product._id}`, ck.inventoryA.cookie, undefined, { id: String(product._id) });
    assert.equal(r.json.costFifo, 7.5);
  });
  await test("cashier cannot download the catalogue export (it carries cost columns)", async () => {
    const r = await call(productExportRoute.GET, "GET", "/api/products/export", ck.cashierA.cookie);
    assert.equal(r.status, 403, `status ${r.status}`);
  });
  await test("sales list / detail hide FIFO cost (inventoryDeductions) from cashier", async () => {
    const list = await call(salesRoute.GET, "GET", "/api/sales", ck.cashierA.cookie);
    const one = (list.json as any[]).find((s) => s.id === String(saleA._id));
    assert.ok(one, "own sale listed");
    assert.equal(JSON.stringify(one).includes("costTotal"), false, "costTotal in list");
    const d = await call(saleRoute.GET, "GET", `/api/sales/${saleA._id}`, ck.cashierA.cookie, undefined, { id: String(saleA._id) });
    assert.equal(d.text.includes("costTotal") || d.text.includes("unitCost"), false, "cost in detail");
  });
  await test("sales detail keeps FIFO cost for Owner", async () => {
    const d = await call(saleRoute.GET, "GET", `/api/sales/${saleA._id}`, ck.owner.cookie, undefined, { id: String(saleA._id) });
    assert.equal(d.json.inventoryDeductions?.[0]?.costTotal, 7.5);
  });

  /* ======================================================================
   * 6. Notification state is per user, and every role can open the bell.
   * ==================================================================== */
  console.log("\n— Notifications");
  await test("every role can load the notification bell", async () => {
    for (const s of [ck.owner, ck.managerA, ck.cashierA, ck.accountantA, ck.inventoryA, ck.bmA]) {
      const r = requireApiAccess(request("GET", "/api/notifications", s.cookie));
      assert.ok(r && !isAuthResponse(r), `denied: ${(r as any)?.status}`);
    }
  });
  await test("a cashier marking 'all read' does not mark the Owner's notifications read", async () => {
    const o1 = await call(notificationsRoute.GET, "GET", "/api/notifications", ck.owner.cookie);
    assert.equal(o1.status, 200);
    assert.ok(o1.json.unreadCount > 0, "owner should have alerts (weekly report)");
    const r = await call(notificationsRoute.PATCH, "PATCH", "/api/notifications", ck.cashierA.cookie, { all: true });
    assert.equal(r.status, 200);
    const ownerItem = o1.json.items[0];
    await call(notificationsRoute.PATCH, "PATCH", "/api/notifications", ck.cashierA.cookie, { id: ownerItem.id });
    const o2 = await call(notificationsRoute.GET, "GET", "/api/notifications", ck.owner.cookie);
    assert.equal(o2.json.unreadCount, o1.json.unreadCount, `owner unread ${o1.json.unreadCount} → ${o2.json.unreadCount}`);
  });
  await test("a cashier's bell never lists alerts computed for the Owner", async () => {
    await call(notificationsRoute.GET, "GET", "/api/notifications", ck.owner.cookie);
    const c = await call(notificationsRoute.GET, "GET", "/api/notifications", ck.cashierA.cookie);
    const types = (c.json.items as any[]).map((i) => i.type);
    assert.ok(!types.includes("report") && !types.includes("receivables") && !types.includes("low_stock"), types.join(","));
    // and the cashier's sync did not resolve the owner's alerts
    const ownerOpen = await Notification.countDocuments({ resolved: false, userId: ck.owner.userId });
    assert.ok(ownerOpen > 0, "owner alerts resolved by another user's sync");
  });

  /* ======================================================================
   * 7. Server-owned fields on create (mass assignment).
   * ==================================================================== */
  console.log("\n— Server-owned fields");
  await test("supplier create cannot forge _id or timestamps", async () => {
    const forcedId = String(oid());
    const r = await call(suppliersRoute.POST, "POST", "/api/suppliers", ck.owner.cookie, {
      _id: forcedId, name: "Forge", phone: "+96894444444", createdAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z",
    });
    assert.equal(r.status, 201);
    const s = await Supplier.findById(r.json.id).lean<any>();
    assert.notEqual(String(s._id), forcedId);
    assert.ok(new Date(s.createdAt).getFullYear() > 2000, "createdAt forged");
  });
  await test("expense create cannot forge _id or timestamps", async () => {
    const forcedId = String(oid());
    const r = await call(expensesRoute.POST, "POST", "/api/expenses", ck.accountantA.cookie, {
      _id: forcedId, category: "AZ", detail: "f", amount: 1, createdAt: "2000-01-01T00:00:00Z",
    });
    assert.equal(r.status, 201);
    const e = await Expense.findById(r.json.id).lean<any>();
    assert.notEqual(String(e._id), forcedId);
    assert.ok(new Date(e.createdAt).getFullYear() > 2000, "createdAt forged");
  });
  await test("customer edit cannot set balances (creditBalance / totals)", async () => {
    const c = await models.Customer.create({ name: "AZ Cust", phone: "+96895555555" });
    const before = await models.Customer.findById(c._id).lean<any>();
    const r = await call(customerRoute.PUT, "PUT", `/api/customers/${c._id}`, ck.cashierA.cookie, { creditBalance: -500, totalPurchases: 99999, name: "AZ Cust 2" }, { id: String(c._id) });
    assert.equal(r.status, 200);
    const after = await models.Customer.findById(c._id).lean<any>();
    assert.equal(after.creditBalance ?? 0, before.creditBalance ?? 0);
    assert.equal(after.totalPurchases ?? 0, before.totalPurchases ?? 0);
  });
  await test("cashier cannot delete a customer", async () => {
    const c = await models.Customer.create({ name: "AZ Keep", phone: "+96896666666" });
    const r = await call(customerRoute.DELETE, "DELETE", `/api/customers/${c._id}`, ck.cashierA.cookie, undefined, { id: String(c._id) });
    assert.equal(r.status, 403);
    assert.ok(await models.Customer.findById(c._id));
  });

  /* ---------- teardown ---------- */
  await mongoose.disconnect();
  if (dbName.startsWith("unich_authz_")) {
    const conn = await mongoose.createConnection(env.DATABASE_URL!).asPromise();
    await conn.dropDatabase();
    await conn.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`Failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
