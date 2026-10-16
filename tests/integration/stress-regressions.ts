/**
 * Regression tests for defects found by the stress harness (tests/stress).
 * Deterministic, route-level, no load: each one fails on the code before its
 * fix (npm run test:stress-regressions).
 *
 *  - customer search returned every match (thousands) → capped, exact phone first
 *  - bell sync wrote one updateOne per alert → one bulkWrite
 *  - import upload over the 10 MB proxy limit failed as "file is required" → 413
 *  - a checkout whose till already disconnected was still committed → nothing written
 *  - stock adjustment answered 400 when the database was unreachable → 503
 *
 * Safety: refuses any non-local DATABASE_URL (e2eGuard). Never loads .env.
 * Drops its database at the end ONLY if the name starts with "unich_it_".
 *
 *   DATABASE_URL='mongodb://127.0.0.1:27520/unich_it_stressreg?replicaSet=rs0&directConnection=true' \
 *     npm run test:stress-regressions
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoClient } from "mongodb";
import { assertLocalDb } from "../../src/lib/e2eGuard";

assertLocalDb();
const env = process.env as Record<string, string | undefined>;
env.SESSION_SECRET ||= randomBytes(32).toString("hex");

/* eslint-disable @typescript-eslint/no-explicit-any */
let passed = 0;
let failed = 0;
let blocked = 0;
const failures: string[] = [];
class Blocked extends Error {}
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    if (err instanceof Blocked) {
      blocked += 1;
      console.log(`  ⊘ BLOCKED ${name} — ${err.message}`);
      return;
    }
    failed += 1;
    failures.push(name);
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message.split("\n").slice(0, 6).join("\n    ")}`);
  }
}

async function main() {
  const { connectDB } = await import("../../src/lib/db");
  const { AppSettings, Branch, Customer, FifoLayer, Product, Sale } = await import("../../src/lib/models");
  const { testSessionCookie } = await import("../../src/lib/auth/testSession");
  const customersRoute = await import("../../src/app/api/customers/route");
  const notificationsRoute = await import("../../src/app/api/notifications/route");
  const stageRoute = await import("../../src/app/api/products/import/stage/route");
  const salesRoute = await import("../../src/app/api/sales/route");
  const adjustmentsRoute = await import("../../src/app/api/inventory/adjustments/route");

  await connectDB();
  const dbName = mongoose.connection.db!.databaseName;
  console.log(`DB target: ${mongoose.connection.host}:${mongoose.connection.port}/${dbName}`);
  const oid = () => new mongoose.Types.ObjectId();
  const BASE = "http://localhost:3000";
  const req = (method: string, path: string, cookie: string, body?: unknown, init: RequestInit = {}) =>
    new Request(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers as Record<string, string> | undefined) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: init.signal,
    });

  const branch = await Branch.create({ name: "SR Branch", code: `SR${Date.now() % 1e6}` });
  const A = String(branch._id);
  const mk = (role: any) => testSessionCookie({ userId: String(oid()), name: `SR ${role}`, email: "sr@test.local", role, roleLabel: role, branchId: A, branchName: "SR" });
  const cashier = await mk("cashier");
  const inventory = await mk("inventory");
  await AppSettings.updateOne({ key: "default" }, { $set: { salespeople: ["SP SR"], activeSalesperson: "SP SR" } }, { upsert: true });

  console.log("\n— Customer search");
  await test("a short query returns at most 50 customers, not every match", async () => {
    await Customer.collection.insertMany(Array.from({ length: 180 }, (_, i) => ({ name: `Al Search ${String(i).padStart(3, "0")}`, phone: `+9687${String(1000000 + i)}`, creditBalance: 0, totalPurchases: 0 })));
    const r = await customersRoute.GET(req("GET", "/api/customers?q=Al", cashier));
    const list = (await r.json()) as any[];
    assert.equal(r.status, 200);
    assert.ok(list.length <= 50, `returned ${list.length}`);
    assert.ok(list.length > 0);
  });
  await test("the exact phone match is returned even when many phones contain the digits", async () => {
    // 120 phones that contain "91234567" somewhere, sorted before the exact one by name.
    await Customer.collection.insertMany(Array.from({ length: 120 }, (_, i) => ({ name: `A Decoy ${i}`, phone: `+968 91234567${String(i).padStart(3, "0")}`, creditBalance: 0, totalPurchases: 0 })));
    await Customer.create({ name: "Zz Exact", phone: "+968 9123 4567" });
    const r = await customersRoute.GET(req("GET", `/api/customers?q=${encodeURIComponent("91234567")}`, cashier));
    const list = (await r.json()) as any[];
    assert.ok(list.length <= 50, `returned ${list.length}`);
    assert.ok(list.some((c) => c.name === "Zz Exact"), "exact match cut off");
  });
  await test("no query still lists every customer (Customers page contract)", async () => {
    const total = await Customer.countDocuments();
    const r = await customersRoute.GET(req("GET", "/api/customers", cashier));
    assert.equal(((await r.json()) as any[]).length, total);
  });

  console.log("\n— Notification bell");
  await test("one bell load writes all alerts in one bulkWrite, not one updateOne each", async () => {
    await Product.collection.insertMany(Array.from({ length: 150 }, (_, i) => ({ sku: `SR-LOW-${i}`, name: `Low ${i}`, category: "Brands", unit: "pcs", sellPrice: 1, costFifo: 0, minMarginPct: 0, stockSellable: 1, stockTester: 0, stockSample: 0, stockPersonal: 0, lowStockAt: 10 })));
    const calls: string[] = [];
    mongoose.set("debug", (coll: string, method: string) => { if (coll === "notifications") calls.push(method); });
    try {
      const r = await notificationsRoute.GET(req("GET", "/api/notifications", inventory));
      assert.equal(r.status, 200);
      const body = (await r.json()) as any;
      assert.ok(body.unreadCount >= 150, `unread ${body.unreadCount}`);
    } finally {
      mongoose.set("debug", false);
    }
    const updateOnes = calls.filter((m) => m === "updateOne").length;
    assert.equal(updateOnes, 0, `${updateOnes} updateOne calls`);
    assert.equal(calls.filter((m) => m === "bulkWrite").length, 1, calls.join(","));
  });
  await test("reloading the bell does not duplicate alerts", async () => {
    const a = (await (await notificationsRoute.GET(req("GET", "/api/notifications", inventory))).json()) as any;
    const b = (await (await notificationsRoute.GET(req("GET", "/api/notifications", inventory))).json()) as any;
    assert.equal(b.unreadCount, a.unreadCount);
  });

  console.log("\n— Import upload size");
  await test("an upload over 10 MB is refused with 413 and a size message", async () => {
    const r = await stageRoute.POST(new Request(`${BASE}/api/products/import/stage`, {
      method: "POST",
      headers: { Cookie: await mk("owner"), "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(10 * 1024 * 1024 + 1) },
      body: "--x--",
    }));
    assert.equal(r.status, 413);
    assert.match(((await r.json()) as any).error, /too large/i);
  });

  console.log("\n— Abandoned checkout");
  const product = await Product.create({ sku: `SR-${Date.now()}`, name: "SR Perfume", category: "Brands", unit: "pcs", sellPrice: 20, costFifo: 5, stockSellable: 10 });
  await FifoLayer.create({ productId: product._id, supplierId: oid(), supplierName: "SR", purchaseDate: new Date(), qtyRemaining: 10, originalQty: 10, unitCost: 5, currency: "OMR" });
  const cart = (key: string) => ({ customerPhone: "+96890000009", salesperson: "SP SR", payment: "cash", lines: [{ productId: String(product._id), qty: 1, lineType: "ready" }], idempotencyKey: key });
  await test("a checkout whose till already disconnected writes nothing", async () => {
    const key = randomUUID();
    const ctl = new AbortController();
    ctl.abort();
    const r = await salesRoute.POST(req("POST", "/api/sales", cashier, cart(key), { signal: ctl.signal }));
    assert.equal(r.status, 503, `status ${r.status}`);
    assert.equal(await Sale.countDocuments({ idempotencyKey: { $regex: key } }), 0, "sale written");
    assert.equal((await Product.findById(product._id).lean<any>()).stockSellable, 10, "stock moved");
    const layers = await FifoLayer.find({ productId: product._id }).lean<any[]>();
    assert.equal(layers.reduce((s, l) => s + l.qtyRemaining, 0), 10, "layers moved");
  });
  await test("the till's retry with the same key then sells exactly once", async () => {
    const key = randomUUID();
    const ctl = new AbortController();
    ctl.abort();
    await salesRoute.POST(req("POST", "/api/sales", cashier, cart(key), { signal: ctl.signal }));
    const r1 = await salesRoute.POST(req("POST", "/api/sales", cashier, cart(key)));
    const r2 = await salesRoute.POST(req("POST", "/api/sales", cashier, cart(key)));
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 200, "second retry is the same sale");
    assert.equal(await Sale.countDocuments({ idempotencyKey: { $regex: key } }), 1);
    assert.equal((await Product.findById(product._id).lean<any>()).stockSellable, 9);
  });

  console.log("\n— Stock adjustment during a database outage");
  await test("adjustment answers 503 (retryable), not 400, when the database drops; nothing moves", async () => {
    const control = await MongoClient.connect(env.DATABASE_URL!, { appName: "sr-control" });
    const admin = control.db("admin");
    try {
      try {
        await admin.command({ configureFailPoint: "failCommand", mode: "off" });
      } catch {
        throw new Blocked("mongod without --setParameter enableTestCommands=1");
      }
      const before = (await Product.findById(product._id).lean<any>()).stockSellable;
      await admin.command({ configureFailPoint: "failCommand", mode: { times: 6 }, data: { failCommands: ["find"], closeConnection: true } });
      const r = await adjustmentsRoute.POST(req("POST", "/api/inventory/adjustments", inventory, { productId: String(product._id), qty: 1, direction: "in", idempotencyKey: randomUUID() }));
      await admin.command({ configureFailPoint: "failCommand", mode: "off" });
      assert.equal(r.status, 503, `status ${r.status}`);
      assert.equal((await Product.findById(product._id).lean<any>()).stockSellable, before);
    } finally {
      await admin.command({ configureFailPoint: "failCommand", mode: "off" }).catch(() => undefined);
      await control.close();
    }
  });

  await mongoose.disconnect();
  if (dbName.startsWith("unich_it_")) {
    const conn = await mongoose.createConnection(env.DATABASE_URL!).asPromise();
    await conn.dropDatabase();
    await conn.close();
  }
  console.log(`\n${passed} passed, ${failed} failed, ${blocked} blocked`);
  if (failures.length) console.log(`Failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
