/**
 * Concurrency / race-condition / idempotency suite (npm run test:concurrency).
 *
 * Every race here is driven deterministically: a one-shot pause hook stops
 * the first request at the exact read → write step being attacked (inside or
 * outside its transaction), the competing request runs to completion, then
 * the first one resumes. Assertions check the persisted end state — stock,
 * FIFO layers, balances, document status, audit records — never just HTTP
 * codes. Transient-error / commit-retry cases use MongoDB's failCommand fail
 * point (mongod needs `--setParameter enableTestCommands=1`; without it those
 * cases are BLOCKED, never passed).
 *
 * Safety: refuses any non-local DATABASE_URL (e2eGuard), never loads .env,
 * drops its database at the end only if the name starts with "unich_it_".
 *
 *   DATABASE_URL='mongodb://127.0.0.1:27611/unich_it_conc?replicaSet=rs0&directConnection=true' \
 *     npm run test:concurrency
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoClient } from "mongodb";
import { assertLocalDb } from "../../src/lib/e2eGuard";

assertLocalDb();
const env = process.env as Record<string, string | undefined>;
// Signs test session cookies for route-level calls; never a real secret.
env.SESSION_SECRET ||= randomBytes(32).toString("hex");

/* eslint-disable @typescript-eslint/no-explicit-any */
let passed = 0;
let failed = 0;
let blocked = 0;
const failures: string[] = [];
class Blocked extends Error {}
async function test(name: string, fn: () => Promise<void>, repeat = 1) {
  try {
    for (let i = 0; i < repeat; i++) await fn();
    passed += 1;
    console.log(`  ✓ ${name}${repeat > 1 ? ` (×${repeat})` : ""}`);
  } catch (err) {
    if (err instanceof Blocked) {
      blocked += 1;
      console.log(`  ⊘ BLOCKED ${name} — ${err.message}`);
      return;
    }
    failed += 1;
    failures.push(name);
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message.split("\n").slice(0, 8).join("\n    ")}`);
  }
}

/* ---------- deterministic interleaving ---------- */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}
/**
 * One-shot hook on obj[method]: the first call for which `match` holds stops
 * BEFORE running (when = "before") or AFTER its result is ready ("after"),
 * signals `reached`, and waits for `release()`. Later calls run untouched.
 */
function pause(obj: any, method: string, when: "before" | "after", match: (self: any, args: any[]) => boolean = () => true) {
  const own = Object.prototype.hasOwnProperty.call(obj, method);
  const orig = obj[method];
  const reached = gate();
  const release = gate();
  let fired = false;
  const restore = () => {
    if (own) obj[method] = orig;
    else delete obj[method];
  };
  obj[method] = function (this: any, ...args: any[]) {
    if (fired || !match(this, args)) return orig.apply(this, args);
    fired = true;
    restore();
    return (async () => {
      if (when === "before") {
        reached.open();
        await release.promise;
        return orig.apply(this, args);
      }
      const value = await orig.apply(this, args);
      reached.open();
      await release.promise;
      return value;
    })();
  };
  // A hook that never fires must fail the test, not hang the run.
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`pause on ${method} never reached`)), 15_000).unref());
  return { reached: Promise.race([reached.promise, timeout]), release: release.open, restore };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait for a persisted condition (not an arbitrary delay). */
async function until(cond: () => Promise<boolean>, label: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(15);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function main() {
  // Imported after the guard so nothing can connect before it runs.
  const { connectDB } = await import("../../src/lib/db");
  const models = await import("../../src/lib/models");
  const {
    AppSettings, Customer, FifoLayer, ImportBatch, InventoryAdjustment, Product, ProductionOrder,
    PurchaseOrder, Quotation, Sale, Supplier,
  } = models;
  const { addFifoLayer } = await import("../../src/lib/inventory");
  const { createSale } = await import("../../src/lib/sales/createSale");
  const { SaleError } = await import("../../src/lib/sales/errors");
  const { completeProductionOrder } = await import("../../src/lib/production/completeProduction");
  const { setSellableStock } = await import("../../src/lib/inventory/stockAdjustment");
  const { createSessionToken, SESSION_COOKIE } = await import("../../src/lib/auth/session");
  const purchaseRoute = await import("../../src/app/api/purchases/[id]/route");
  const purchasesRoute = await import("../../src/app/api/purchases/route");
  const salesRoute = await import("../../src/app/api/sales/route");
  const transfersRoute = await import("../../src/app/api/inventory/transfers/route");
  const adjustmentsRoute = await import("../../src/app/api/inventory/adjustments/route");
  const productionRoute = await import("../../src/app/api/production/[id]/route");
  const quotationRoute = await import("../../src/app/api/quotations/[id]/route");
  const publicQuotationRoute = await import("../../src/app/api/quotations/public/[token]/route");
  const undoRoute = await import("../../src/app/api/products/import/[batchId]/undo/route");
  const commitRoute = await import("../../src/app/api/products/import/commit/route");

  await connectDB();
  const dbName = mongoose.connection.db!.databaseName;
  console.log(`target: LOCAL ${mongoose.connection.host}:${mongoose.connection.port}/${dbName}`);
  const control = await MongoClient.connect(env.DATABASE_URL!, { appName: "unich-conc-control" });
  const admin = control.db("admin");

  let failPointsAvailable = true;
  try {
    await admin.command({ configureFailPoint: "failCommand", mode: "off" });
  } catch {
    failPointsAvailable = false;
  }
  async function failNext(data: Record<string, unknown>, times = 1) {
    if (!failPointsAvailable) throw new Blocked("mongod not started with enableTestCommands=1");
    await admin.command({ configureFailPoint: "failCommand", mode: { times }, data });
  }
  const failOff = () => admin.command({ configureFailPoint: "failCommand", mode: "off" }).catch(() => undefined);

  /* ---------- fixtures ---------- */
  const RUN = `CC${Date.now().toString(36)}`;
  let seq = 0;
  const supplier = await Supplier.create({ name: `${RUN} Supplier`, phone: "90000000" });
  await AppSettings.updateOne(
    { key: "default" },
    { $setOnInsert: { key: "default", salespeople: ["IT Cashier"], activeSalesperson: "IT Cashier" } },
    { upsert: true },
  );
  async function product(opts: { layers?: Array<[number, number]>; unit?: string; category?: string; price?: number; name?: string } = {}) {
    const n = ++seq;
    const p = await Product.create({
      sku: `${RUN}-${n}`, name: opts.name ?? `${RUN} Item ${n}`, category: opts.category ?? "Brands",
      unit: opts.unit ?? "pcs", sellPrice: opts.price ?? 10, stockSellable: 0,
    });
    const id = String(p._id);
    let day = 1;
    for (const [qty, unitCost] of opts.layers ?? []) {
      await addFifoLayer({
        productId: id, supplierId: String(supplier._id), supplierName: "IT",
        purchaseDate: new Date(Date.UTC(2026, 0, day++)), qty, unitCost, currency: "OMR",
      });
    }
    return id;
  }
  const phone = () => `9${String(Date.now()).slice(-6)}${++seq % 10}`;
  const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
  async function snap(id: string) {
    const p = await Product.findById(id).lean<any>();
    const layers = (await FifoLayer.find({ productId: id }).sort({ purchaseDate: 1, _id: 1 }).lean<any[]>()).map((l) => l.qtyRemaining);
    return {
      exists: !!p, stock: p?.stockSellable ?? 0, tester: p?.stockTester ?? 0,
      layers, layerSum: round3(layers.reduce((a: number, b: number) => a + b, 0)),
    };
  }
  /** Core inventory invariant: sellable stock == Σ FIFO layers, nothing negative. */
  async function assertStockMatchesLayers(id: string, label = "") {
    const s = await snap(id);
    assert.equal(round3(s.stock), s.layerSum, `${label} stockSellable ${s.stock} != Σ layers ${s.layerSum}`);
    assert.ok(s.stock >= 0 && s.tester >= 0 && s.layers.every((q: number) => q >= 0), `${label} negative stock/layer: ${JSON.stringify(s)}`);
  }
  const sale = (lines: any[], extra: Record<string, unknown> = {}) =>
    createSale({ customerPhone: (extra.customerPhone as string) ?? phone(), payment: "cash", lines, idempotencyKey: randomUUID(), ...extra } as any);
  const ready = (productId: string, qty: number) => ({ productId, qty, lineType: "ready" });

  const ownerUserId = String(new mongoose.Types.ObjectId());
  const ownerCookie = `${SESSION_COOKIE}=${encodeURIComponent(createSessionToken({
    userId: ownerUserId, name: "IT Owner", email: "it-owner@test.invalid",
    role: "owner", roleLabel: "Owner", branchId: null, branchName: null,
  }))}`;
  async function call(mod: any, method: string, url: string, body?: unknown, params?: Record<string, string>, headers: Record<string, string> = {}) {
    const res = await mod[method](new Request(`http://localhost${url}`, {
      method, headers: { cookie: ownerCookie, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }), params ? ({ params: Promise.resolve(params) } as any) : undefined);
    return { status: res.status as number, body: await res.json().catch(() => null) };
  }
  const transfer = (body: Record<string, unknown>) => call(transfersRoute, "POST", "/api/inventory/transfers", body);
  const adjust = (body: Record<string, unknown>) => call(adjustmentsRoute, "POST", "/api/inventory/adjustments", body);
  const receive = (poId: string, body: Record<string, unknown>) => call(purchaseRoute, "PUT", `/api/purchases/${poId}`, body, { id: poId });
  async function purchaseOrder(lines: Array<{ productId: string; qty: number; unitCost: number }>) {
    const po = await PurchaseOrder.create({
      supplierId: supplier._id, supplierName: supplier.name, date: new Date("2026-02-01"), status: "ordered", currency: "OMR",
      lines: lines.map((l) => ({ productId: l.productId, productName: "IT", qtyOrdered: l.qty, qtyReceived: 0, qtyFifoApplied: 0, unitCost: l.unitCost })),
    });
    return String(po._id);
  }
  async function productionOrder(runs = 1) {
    const oil = await product({ layers: [[10, 2], [10 + 15 * (runs - 1), 3]], unit: "ml", category: "Single Notes" });
    const ethanol = await product({ layers: [[35 * runs, 0.1]], unit: "ml", category: "Packaging" });
    const bottle = await product({ layers: [[runs, 0.5]], category: "Packaging" });
    const output = await product({ category: "Remix" });
    const order = await ProductionOrder.create({
      orderNumber: `${RUN}-PO-${++seq}`, formulaId: new mongoose.Types.ObjectId(), formulaName: "IT Remix", formulaType: "remix",
      qty: 1, yieldMl: 50, outputProductId: output, outputProductName: "IT Remix", outputUnit: "pcs", outputQty: 1, status: "draft",
      plannedLines: [
        { productId: oil, productName: "Oud", qty: 15, unit: "ml", reason: "oil" },
        { productId: ethanol, productName: "Ethanol", qty: 35, unit: "ml", reason: "ethanol" },
        { productId: bottle, productName: "Bottle", qty: 1, unit: "pcs", reason: "bottle" },
      ],
    });
    return { orderId: String(order._id), oil, ethanol, bottle, output };
  }
  const orderDoc = (id: string) => ProductionOrder.findById(id).lean<any>();
  /** Production invariant: completed ⇔ a batch + consumption exist; cancelled/draft ⇔ neither. */
  function assertOrderConsistent(o: any, outputStock: number) {
    const hasBatch = !!o.batch && (o.consumption?.length ?? 0) > 0;
    if (o.status === "completed") assert.ok(hasBatch && outputStock > 0, `completed order without batch/output (output ${outputStock})`);
    else assert.ok(!hasBatch && outputStock === 0, `order is "${o.status}" but materials were consumed and ${outputStock} output added`);
  }

  try {
    /* ================= 0. Constraints really exist ================= */
    console.log("0. Unique constraints the idempotency logic depends on");
    await test("declared unique indexes are built on a fresh database (not just declared in the schema)", async () => {
      await Promise.all([Sale, InventoryAdjustment, Product, ImportBatch, ProductionOrder, Quotation].map((m: any) => m.init()));
      const idx = async (m: any) => (await m.collection.indexes()) as any[];
      const has = (list: any[], key: Record<string, number>, check: (i: any) => boolean) =>
        list.some((i) => JSON.stringify(i.key) === JSON.stringify(key) && check(i));
      assert.ok(has(await idx(Sale), { idempotencyKey: 1 }, (i) => i.unique && i.sparse), "sales.idempotencyKey unique+sparse");
      assert.ok(has(await idx(InventoryAdjustment), { idempotencyOwner: 1, idempotencyKey: 1 }, (i) => i.unique && !!i.partialFilterExpression), "inventoryadjustments (owner,key) unique partial");
      assert.ok(has(await idx(Product), { sku: 1 }, (i) => i.unique), "products.sku unique");
      assert.ok(has(await idx(ImportBatch), { batchId: 1 }, (i) => i.unique), "importbatches.batchId unique");
      assert.ok(has(await idx(ProductionOrder), { orderNumber: 1 }, (i) => i.unique), "productionorders.orderNumber unique");
      assert.ok(has(await idx(Quotation), { number: 1 }, (i) => i.unique), "quotations.number unique");
    });

    /* ================= A. POS checkout ================= */
    console.log("A. POS checkout");
    await test("two checkouts that each fit but together exceed stock: exactly one succeeds", async () => {
      const id = await product({ layers: [[3, 1], [2, 2]] });
      const rs = await Promise.allSettled([sale([ready(id, 3)]), sale([ready(id, 4)])]);
      const ok = rs.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
      assert.equal(ok.length, 1, `statuses ${rs.map((r) => r.status)}`);
      const sold = ok[0].value.sale.lines[0].qty;
      const s = await snap(id);
      assert.equal(s.stock, 5 - sold);
      await assertStockMatchesLayers(id);
      const rej = rs.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.ok(rej.reason instanceof SaleError && rej.reason.code === "INSUFFICIENT_STOCK", rej.reason?.message);
    }, 5);

    await test("same key, different carts, submitted simultaneously: one sale, the other is a conflict; stock moves once", async () => {
      const id = await product({ layers: [[10, 1]] });
      const ph = phone();
      const key = randomUUID();
      const rs = await Promise.allSettled([
        sale([ready(id, 1)], { customerPhone: ph, idempotencyKey: key }),
        sale([ready(id, 2)], { customerPhone: ph, idempotencyKey: key }),
      ]);
      assert.equal(await Sale.countDocuments({ customerPhone: ph }), 1);
      const winner = await Sale.findOne({ customerPhone: ph }).lean<any>();
      assert.equal((await snap(id)).stock, 10 - winner.lines[0].qty, "only the winning cart deducted");
      const rej = rs.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      assert.equal(rej.length, 1);
      assert.equal(rej[0].reason?.code, "IDEMPOTENCY_CONFLICT", rej[0].reason?.message);
      await assertStockMatchesLayers(id);
    }, 3);

    await test("blank / whitespace keys are 'no key': two submissions are two legitimate sales", async () => {
      const id = await product({ layers: [[10, 1]] });
      const ph = phone();
      await sale([ready(id, 1)], { customerPhone: ph, idempotencyKey: "   " });
      await sale([ready(id, 1)], { customerPhone: ph, idempotencyKey: "" });
      assert.equal(await Sale.countDocuments({ customerPhone: ph }), 2);
      assert.equal((await snap(id)).stock, 8);
    });

    await test("malformed keys (number, >200 chars) are refused by the route before anything is written", async () => {
      const id = await product({ layers: [[5, 1]] });
      const ph = phone();
      const body = { customerPhone: ph, payment: "cash", lines: [ready(id, 1)] };
      const r1 = await call(salesRoute, "POST", "/api/sales", { ...body, idempotencyKey: 12345 });
      const r2 = await call(salesRoute, "POST", "/api/sales", body, undefined, { "idempotency-key": "k".repeat(201) });
      assert.deepEqual([r1.status, r2.status], [400, 400], JSON.stringify([r1.body, r2.body]));
      assert.equal(await Sale.countDocuments({ customerPhone: ph }), 0);
      assert.equal((await snap(id)).stock, 5);
    });

    await test("checkout paused after its stock read; a transfer out commits; checkout re-plans on fresh stock", async () => {
      const id = await product({ layers: [[4, 1], [4, 2]] });
      const ph = phone();
      const p = pause(Sale.collection, "insertOne", "before", (_s, a) => a[0]?.customerPhone === ph);
      const checkout = sale([ready(id, 3)], { customerPhone: ph });
      await p.reached; // inside the sale transaction, stock + FIFO plan already read (8 units)
      const t = await transfer({ productId: id, qty: 4, from: "stockSellable", to: "stockTester" });
      assert.equal(t.status, 200, JSON.stringify(t.body));
      p.release();
      const done: any = await checkout;
      const s = await snap(id);
      assert.equal(s.stock, 1, "8 − 4 transferred − 3 sold");
      assert.equal(s.tester, 4);
      await assertStockMatchesLayers(id);
      const ded = done.sale.inventoryDeductions[0];
      assert.equal(round3(ded.batches.reduce((a: number, b: any) => a + b.qty, 0)), 3, "audit batches = qty sold");
      assert.equal(round3(ded.costTotal), 3 * 2, "the 4 cheap units left with the transfer, so the sale costs 3 × 2");
    });

    await test("checkout paused after its stock read; a transfer takes the units it needed → checkout fails cleanly", async () => {
      const id = await product({ layers: [[5, 1]] });
      const ph = phone();
      const p = pause(Sale.collection, "insertOne", "before", (_s, a) => a[0]?.customerPhone === ph);
      const checkout = sale([ready(id, 3)], { customerPhone: ph });
      await p.reached;
      assert.equal((await transfer({ productId: id, qty: 4, from: "stockSellable", to: "stockTester" })).status, 200);
      p.release();
      await assert.rejects(checkout, (e: any) => e?.code === "INSUFFICIENT_STOCK");
      assert.equal(await Sale.countDocuments({ customerPhone: ph }), 0);
      assert.equal(await Customer.countDocuments({ phone: ph }), 0, "no customer stats from the rolled-back checkout");
      const s = await snap(id);
      assert.deepEqual([s.stock, s.tester], [1, 4]);
      await assertStockMatchesLayers(id);
    });

    await test("checkout paused mid-transaction; a count correction to 10 commits; checkout resumes: 10 − sold", async () => {
      const id = await product({ layers: [[6, 1]] });
      const ph = phone();
      const p = pause(Sale.collection, "insertOne", "before", (_s, a) => a[0]?.customerPhone === ph);
      const checkout = sale([ready(id, 2)], { customerPhone: ph });
      await p.reached;
      const prod = await Product.findById(id).lean<any>();
      await setSellableStock({ product: prod, target: 10, createdBy: "IT" });
      p.release();
      await checkout;
      assert.equal((await snap(id)).stock, 8);
      await assertStockMatchesLayers(id);
      const adj = await InventoryAdjustment.find({ productId: id }).lean<any[]>();
      const net = adj.reduce((s, a) => s + (a.direction === "in" ? a.qty : -a.qty), 0);
      assert.equal(6 + net - 2, 8, `ledger: 6 + adjustments ${net} − 2 sold must equal stock`);
    });

    await test("transient write error inside the sale transaction is retried: exactly one sale, one deduction", async () => {
      const id = await product({ layers: [[5, 1]] });
      const ph = phone();
      await failNext({ failCommands: ["insert"], namespace: `${dbName}.sales`, errorCode: 112, errorLabels: ["TransientTransactionError"] });
      try {
        await sale([ready(id, 2)], { customerPhone: ph });
      } finally {
        await failOff();
      }
      assert.equal(await Sale.countDocuments({ customerPhone: ph }), 1);
      assert.equal((await snap(id)).stock, 3);
      await assertStockMatchesLayers(id);
    });

    await test("commitTransaction fails with UnknownTransactionCommitResult: retried commit applies the sale once", async () => {
      const id = await product({ layers: [[5, 1]] });
      const ph = phone();
      await failNext({ failCommands: ["commitTransaction"], errorCode: 91, errorLabels: ["UnknownTransactionCommitResult"] });
      try {
        await sale([ready(id, 2)], { customerPhone: ph, payment: "credit" });
      } finally {
        await failOff();
      }
      assert.equal(await Sale.countDocuments({ customerPhone: ph }), 1);
      assert.equal((await snap(id)).stock, 3);
      assert.equal((await Customer.findOne({ phone: ph }).lean<any>()).creditBalance, 20, "credit added once");
    });

    await test("8 parallel credit / mixed sales for one customer: balance = Σ credit parts, purchases = Σ totals", async () => {
      const id = await product({ layers: [[50, 1]], price: 7.5 });
      const ph = phone();
      await sale([ready(id, 1)], { customerPhone: ph, payment: "cash" }); // creates the customer
      const jobs = Array.from({ length: 8 }, (_, i) => {
        const qty = 1 + (i % 3);
        const total = qty * 7.5;
        return i % 2 === 0
          ? sale([ready(id, qty)], { customerPhone: ph, payment: "credit" })
          : sale([ready(id, qty)], { customerPhone: ph, payment: "mixed", paymentBreakdown: [{ method: "cash", amount: 1 }, { method: "credit", amount: total - 1 }] });
      });
      await Promise.all(jobs);
      const sales = await Sale.find({ customerPhone: ph }).lean<any[]>();
      const credit = sales.reduce((s, x) => s + (x.payment === "credit" ? x.total : x.paymentBreakdown?.find((e: any) => e.method === "credit")?.amount ?? 0), 0);
      const totals = sales.reduce((s, x) => s + x.total, 0);
      const c = await Customer.findOne({ phone: ph }).lean<any>();
      assert.equal(round3(c.creditBalance), round3(credit));
      assert.equal(round3(c.totalPurchases), round3(totals));
      assert.equal(await Customer.countDocuments({ phone: ph }), 1, "no duplicate customer profile");
    });

    /* ================= B. Production ================= */
    console.log("B. Production orders");
    await test("cancel loaded the draft, completion commits, cancel saves: never a 'cancelled' order with consumed stock", async () => {
      const o = await productionOrder();
      const p = pause(ProductionOrder, "findById", "after", (_s, a) => String(a[0]) === o.orderId);
      const cancel = call(productionRoute, "DELETE", `/api/production/${o.orderId}`, undefined, { id: o.orderId });
      await p.reached; // cancel has read status "draft"
      await completeProductionOrder(o.orderId, { actualYieldMl: 50 });
      p.release();
      const c = await cancel;
      const doc = await orderDoc(o.orderId);
      const out = (await snap(o.output)).stock;
      assertOrderConsistent(doc, out);
      assert.equal(doc.status, "completed", `cancel (HTTP ${c.status}) overwrote a completed order`);
      assert.notEqual(c.status, 200, "the cancel must be refused");
    });

    await test("cancel while a completion holds its claim is refused; the completion stands", async () => {
      const o = await productionOrder();
      const p = pause(ProductionOrder.prototype, "save", "before", (self, a) => String(self._id) === o.orderId && !!a[0]?.session);
      const done = completeProductionOrder(o.orderId, { actualYieldMl: 50 });
      await p.reached; // claim taken, materials + output written in the open transaction
      const c = await call(productionRoute, "DELETE", `/api/production/${o.orderId}`, undefined, { id: o.orderId });
      p.release();
      await done.catch(() => undefined);
      const doc = await orderDoc(o.orderId);
      assertOrderConsistent(doc, (await snap(o.output)).stock);
      assert.equal(doc.status, "completed", `cancel answered ${c.status}`);
      assert.notEqual(c.status, 200);
      for (const id of [o.oil, o.ethanol, o.bottle, o.output]) await assertStockMatchesLayers(id);
    });

    await test("slow completion whose claim went stale + a takeover: materials consumed once, one output", async () => {
      const o = await productionOrder(2); // enough stock for two runs, so a double consume would succeed and show
      const p = pause(ProductionOrder.prototype, "save", "before", (self, a) => String(self._id) === o.orderId && !!a[0]?.session);
      const first = completeProductionOrder(o.orderId, { actualYieldMl: 50 });
      await p.reached; // first request: inside its transaction, about to save the order
      const staleAt = new Date(Date.now() - 10 * 60 * 1000);
      await ProductionOrder.collection.updateOne({ _id: new mongoose.Types.ObjectId(o.orderId) }, { $set: { completingAt: staleAt } });
      const second = completeProductionOrder(o.orderId, { actualYieldMl: 50 });
      await until(async () => +(await orderDoc(o.orderId)).completingAt !== +staleAt, "takeover claim");
      p.release();
      const rs = await Promise.allSettled([first, second]);
      const eth = (await snap(o.ethanol)).stock;
      const out = (await snap(o.output)).stock;
      assert.equal(eth, 35, `ethanol ${eth}: 70 − 35 once (statuses ${rs.map((r) => r.status)})`);
      assert.equal(out, 1, `output ${out}`);
      const doc = await orderDoc(o.orderId);
      assert.equal(doc.status, "completed");
      assert.equal(await FifoLayer.countDocuments({ productionOrderId: o.orderId }), 1, "one output layer");
      for (const id of [o.oil, o.ethanol, o.bottle, o.output]) await assertStockMatchesLayers(id);
    });

    await test("two orders share a component that covers only one: exactly one completes", async () => {
      const a = await productionOrder();
      const b = await ProductionOrder.create({
        ...(await orderDoc(a.orderId)), _id: new mongoose.Types.ObjectId(), orderNumber: `${RUN}-PO-${++seq}`,
      });
      const rs = await Promise.allSettled([a.orderId, String(b._id)].map((id) => completeProductionOrder(id, { actualYieldMl: 50 })));
      assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1, rs.map((r) => (r as any).reason?.message ?? "ok").join(" | "));
      assert.equal((await snap(a.bottle)).stock, 0);
      assert.equal((await snap(a.output)).stock, 1);
      const docs = await ProductionOrder.find({ _id: { $in: [a.orderId, b._id] } }).lean<any[]>();
      assert.deepEqual(docs.map((d) => d.status).sort(), ["completed", "draft"]);
      assert.ok(docs.every((d) => d.completingAt == null), "the losing order's claim is released");
      for (const id of [a.oil, a.ethanol, a.bottle, a.output]) await assertStockMatchesLayers(id);
    });

    await test("completion and a POS checkout race for the last bottle: one wins, nothing oversold", async () => {
      const o = await productionOrder();
      const rs = await Promise.allSettled([
        completeProductionOrder(o.orderId, { actualYieldMl: 50 }),
        sale([ready(o.bottle, 1)]),
      ]);
      assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal((await snap(o.bottle)).stock, 0);
      assertOrderConsistent(await orderDoc(o.orderId), (await snap(o.output)).stock);
      for (const id of [o.oil, o.ethanol, o.bottle, o.output]) await assertStockMatchesLayers(id);
    });

    /* ================= C. Quotations ================= */
    console.log("C. Quotation status transitions");
    async function approvedQuotation(id: string, qty = 2, extra: Record<string, unknown> = {}) {
      const q = await Quotation.create({
        number: `${RUN}-Q-${++seq}`, customerName: "IT Customer", customerPhone: phone(), status: "approved",
        date: new Date(), expiry: new Date(Date.now() + 7 * 864e5),
        lines: [{ productId: id, name: "IT", qty, unitLabel: "pcs", unitPrice: 10, lineType: "wholesale" }],
        subtotal: qty * 10, total: qty * 10, ...extra,
      });
      return String(q._id);
    }
    const convert = (qid: string) => call(quotationRoute, "POST", `/api/quotations/${qid}`, { action: "convert", payment: "cash", salesperson: "IT Cashier" }, { id: qid });
    const qDoc = (qid: string) => Quotation.findById(qid).lean<any>();

    for (const [label, body] of [
      ["status edit (→ rejected)", { status: "rejected" }],
      ["revise", { action: "revise", notes: "rev" }],
    ] as const) {
      await test(`${label} loaded the approved quotation, convert commits, the edit saves: quotation stays converted`, async () => {
        const id = await product({ layers: [[5, 1]] });
        const qid = await approvedQuotation(id);
        const p = pause(Quotation, "findById", "after", (_s, a) => String(a[0]) === qid);
        const edit = "action" in body
          ? call(quotationRoute, "POST", `/api/quotations/${qid}`, body, { id: qid })
          : call(quotationRoute, "PUT", `/api/quotations/${qid}`, body, { id: qid });
        await p.reached;
        const c = await convert(qid);
        assert.equal(c.status, 200, JSON.stringify(c.body));
        p.release();
        const e = await edit;
        const q = await qDoc(qid);
        assert.equal(q.status, "converted", `edit answered ${e.status}; status now "${q.status}" while sale ${q.convertedToSaleId} exists`);
        assert.notEqual(e.status, 200);
        assert.equal(await Sale.countDocuments({ quotationId: q._id }), 1);
        assert.equal((await snap(id)).stock, 3);
      });
    }

    await test("two simultaneous converts: one sale, stock deducted once", async () => {
      const id = await product({ layers: [[5, 1]] });
      const qid = await approvedQuotation(id);
      const rs = await Promise.all([convert(qid), convert(qid), convert(qid)]);
      assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
      assert.equal(await Sale.countDocuments({ quotationId: new mongoose.Types.ObjectId(qid) }), 1);
      assert.equal((await snap(id)).stock, 3);
      await assertStockMatchesLayers(id);
    });

    await test("customer link decision after the quotation was converted is refused (status stays converted)", async () => {
      const id = await product({ layers: [[5, 1]] });
      const token = randomBytes(12).toString("base64url");
      const qid = await approvedQuotation(id, 2, { approvalToken: token, approvalTokenExpiresAt: new Date(Date.now() + 864e5) });
      assert.equal((await convert(qid)).status, 200);
      const r = await call(publicQuotationRoute, "POST", `/api/quotations/public/${token}`, { decision: "rejected" }, { token });
      const q = await qDoc(qid);
      assert.equal(q.status, "converted", `public decision answered ${r.status}, status now "${q.status}"`);
      assert.notEqual(r.status, 200);
    });

    await test("two simultaneous customer decisions (approve + reject) record exactly one", async () => {
      const id = await product({ layers: [[5, 1]] });
      const token = randomBytes(12).toString("base64url");
      const qid = await approvedQuotation(id, 2, { status: "sent", approvalToken: token, approvalTokenExpiresAt: new Date(Date.now() + 864e5) });
      const p = pause(Quotation, "findOne", "after", (_s, a) => a[0]?.approvalToken === token);
      const first = call(publicQuotationRoute, "POST", `/api/quotations/public/${token}`, { decision: "approved" }, { token });
      await p.reached;
      const second = await call(publicQuotationRoute, "POST", `/api/quotations/public/${token}`, { decision: "rejected" }, { token });
      p.release();
      const r1 = await first;
      const q = await qDoc(qid);
      const decisions = q.history.filter((h: any) => h.action === "customer_decision");
      assert.equal(decisions.length, 1, `two decisions recorded (HTTP ${r1.status}/${second.status}); final ${q.status}/${q.customerDecision}`);
      assert.equal(q.customerDecision === "approved" ? "approved" : "rejected", q.status);
    });

    /* ================= D. Product import ================= */
    console.log("D. Product import commit / undo");
    await test("undo passed its in-use check, a purchase receipt commits, undo deletes: received stock survives", async () => {
      const id = await product();
      const batchId = `${RUN}-B${++seq}`;
      await ImportBatch.create({ batchId, userName: "IT", fileName: "it.xlsx", status: "committed", rows: [{ rowNumber: 2, action: "create", createdProductId: id }] });
      const p = pause(FifoLayer, "deleteMany", "before", (_s, a) => String(a[0]?.productId) === id);
      const undo = call(undoRoute, "POST", `/api/products/import/${batchId}/undo`, undefined, { batchId });
      await p.reached; // undo found the product unused and is about to delete it
      // Meanwhile purchasing orders and receives the product.
      const poId = await purchaseOrder([{ productId: id, qty: 4, unitCost: 2 }]);
      const r = await receive(poId, { receiveAll: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      p.release();
      const u = await undo;
      const s = await snap(id);
      const layers = await FifoLayer.countDocuments({ purchaseOrderId: poId });
      assert.ok(s.exists && s.stock === 4 && layers === 1, `undo HTTP ${u.status}: product exists=${s.exists}, stock=${s.stock}, receipt layers=${layers} — received goods destroyed`);
      assert.equal((await ImportBatch.findOne({ batchId }).lean<any>()).status, "committed", "a refused undo leaves the batch committed");
    });

    await test("undo commits after a PO for the product was created; receiving that PO leaves no orphan FIFO layer", async () => {
      const id = await product();
      const batchId = `${RUN}-B${++seq}`;
      await ImportBatch.create({ batchId, userName: "IT", fileName: "it.xlsx", status: "committed", rows: [{ rowNumber: 2, action: "create", createdProductId: id }] });
      const p = pause(FifoLayer, "deleteMany", "before", (_s, a) => String(a[0]?.productId) === id);
      const undo = call(undoRoute, "POST", `/api/products/import/${batchId}/undo`, undefined, { batchId });
      await p.reached;
      const poId = await purchaseOrder([{ productId: id, qty: 4, unitCost: 2 }]); // an insert: no write conflict with the undo
      p.release();
      assert.equal((await undo).status, 200);
      const r = await receive(poId, { receiveAll: true });
      assert.notEqual(r.status, 200, "receiving goods for a product that no longer exists must fail");
      assert.equal(await FifoLayer.countDocuments({ productId: id }), 0, "orphan FIFO layer for a deleted product");
      assert.equal((await PurchaseOrder.findById(poId).lean<any>()).lines[0].qtyFifoApplied, 0);
    });

    await test("product delete passed its in-use check, a receipt commits, delete runs: product and stock survive", async () => {
      const productRoute = await import("../../src/app/api/products/[id]/route");
      const id = await product();
      const p = pause(Product, "deleteOne", "before", (_s, a) => String(a[0]?._id) === id);
      const del = call(productRoute, "DELETE", `/api/products/${id}`, undefined, { id });
      await p.reached;
      const poId = await purchaseOrder([{ productId: id, qty: 4, unitCost: 2 }]);
      assert.equal((await receive(poId, { receiveAll: true })).status, 200);
      p.release();
      const d = await del;
      const s = await snap(id);
      assert.ok(s.exists && s.stock === 4 && (await FifoLayer.countDocuments({ productId: id })) === 1,
        `delete HTTP ${d.status}: product exists=${s.exists}, stock=${s.stock} — received goods destroyed`);
      assert.equal(d.status, 409);
    });

    await test("two simultaneous undos of the same import: applied once, batch undone once", async () => {
      const ids = [await product(), await product()];
      const batchId = `${RUN}-B${++seq}`;
      await ImportBatch.create({ batchId, userName: "IT", fileName: "it.xlsx", status: "committed", rows: ids.map((id, i) => ({ rowNumber: i + 2, action: "create", createdProductId: id })) });
      const rs = await Promise.all([1, 2].map(() => call(undoRoute, "POST", `/api/products/import/${batchId}/undo`, undefined, { batchId })));
      const ok = rs.filter((r) => r.status === 200);
      assert.ok(ok.length >= 1);
      assert.equal(ok.reduce((s, r) => s + r.body.deleted, 0), 2, `deleted counts ${rs.map((r) => JSON.stringify(r.body)).join(" ")}`);
      assert.equal(await Product.countDocuments({ _id: { $in: ids } }), 0);
    });

    await test("two simultaneous commits of one staged batch: one product per row, batch records every created id", async () => {
      const batchId = `${RUN}-B${++seq}`;
      const skus = [1, 2, 3].map((i) => `${RUN}-IMP-${seq}-${i}`);
      await ImportBatch.create({
        batchId, userName: "IT", fileName: "it.xlsx", status: "staged",
        rows: skus.map((sku, i) => ({ rowNumber: i + 2, action: "create", sku, payload: { sku, name: `Imp ${sku}`, category: "Brands", unit: "pcs", sellPrice: 10, costFifo: 1, minMarginPct: 0 } })),
      });
      const rs = await Promise.all([1, 2].map(() => call(commitRoute, "POST", "/api/products/import/commit", { batchId, strictMode: false })));
      const counts = await Promise.all(skus.map((sku) => Product.countDocuments({ sku })));
      assert.deepEqual(counts, [1, 1, 1], `products per sku (HTTP ${rs.map((r) => r.status)})`);
      const b = await ImportBatch.findOne({ batchId }).lean<any>();
      assert.equal(b.status, "committed");
      const recorded = b.rows.map((r: any) => String(r.createdProductId ?? ""));
      const actual = await Promise.all(skus.map(async (sku) => String((await Product.findOne({ sku }).lean<any>())._id)));
      assert.deepEqual(recorded, actual, "undo would miss products the batch does not record");
    });

    /* ================= E. Purchases ================= */
    console.log("E. Purchase receiving");
    async function assertReceiptLedger(poId: string) {
      const po = await PurchaseOrder.findById(poId).lean<any>();
      for (const l of po.lines) {
        const layers = await FifoLayer.find({ purchaseOrderId: poId, productId: l.productId }).lean<any[]>();
        const inLayers = round3(layers.reduce((s, x) => s + x.originalQty, 0));
        assert.equal(l.qtyFifoApplied, inLayers, `qtyFifoApplied ${l.qtyFifoApplied} != Σ receipt layers ${inLayers}`);
        assert.equal(l.qtyReceived, l.qtyFifoApplied, `qtyReceived ${l.qtyReceived} != qtyFifoApplied ${l.qtyFifoApplied}`);
      }
    }
    await test("two users receive parts of the same line simultaneously: no lost or doubled receipt", async () => {
      const id = await product();
      const poId = await purchaseOrder([{ productId: id, qty: 10, unitCost: 2 }]);
      const rs = await Promise.all([receive(poId, { receive: [{ productId: id, qty: 2 }] }), receive(poId, { receive: [{ productId: id, qty: 3 }] })]);
      const okQty = [2, 3].filter((_, i) => rs[i].status === 200).reduce((a, b) => a + b, 0);
      assert.ok(rs.every((r) => r.status === 200 || r.status === 409), rs.map((r) => r.status).join(","));
      assert.equal((await snap(id)).stock, okQty, `stock = Σ accepted receipts (statuses ${rs.map((r) => r.status)})`);
      await assertReceiptLedger(poId);
      await assertStockMatchesLayers(id);
    }, 3);

    await test("receive and a stale full-line edit race: the edit can't erase the receipt", async () => {
      const a = await product();
      const b = await product();
      const poId = await purchaseOrder([{ productId: a, qty: 5, unitCost: 2 }, { productId: b, qty: 5, unitCost: 3 }]);
      const p = pause(PurchaseOrder, "findById", "after", (_s, args) => String(args[0]) === poId);
      const edit = receive(poId, { notes: "edited", lines: [
        { productId: a, qtyOrdered: 5, qtyReceived: 0, unitCost: 2 }, { productId: b, qtyOrdered: 6, qtyReceived: 0, unitCost: 3 },
      ] });
      await p.reached; // edit holds the PO as it was before the receipt
      assert.equal((await receive(poId, { receive: [{ productId: a, qty: 5 }] })).status, 200);
      p.release();
      const e = await edit;
      assert.equal(e.status, 409, `stale edit answered ${e.status}`);
      await assertReceiptLedger(poId);
      assert.equal((await snap(a)).stock, 5);
    });

    await test("FINDING (policy): deleting a received PO keeps its stock and FIFO layers, now pointing at no PO", async () => {
      const id = await product();
      const poId = await purchaseOrder([{ productId: id, qty: 3, unitCost: 2 }]);
      await receive(poId, { receiveAll: true });
      const d = await call(purchaseRoute, "DELETE", `/api/purchases/${poId}`, undefined, { id: poId });
      assert.equal(d.status, 200);
      assert.equal((await snap(id)).stock, 3, "documents current behaviour");
      assert.equal(await FifoLayer.countDocuments({ purchaseOrderId: poId }), 1);
      assert.equal(await PurchaseOrder.exists({ _id: poId }), null);
    });

    await test("FINDING (policy): two identical 'create as received' submissions create two POs and receive twice", async () => {
      const id = await product();
      const body = { supplierId: String(supplier._id), supplierName: supplier.name, status: "received", vatPercent: 0, lines: [{ productId: id, productName: "IT", qtyOrdered: 2, unitCost: 1 }] };
      const rs = await Promise.all([1, 2].map(() => call(purchasesRoute, "POST", "/api/purchases", body)));
      assert.deepEqual(rs.map((r) => r.status), [201, 201]);
      assert.equal((await snap(id)).stock, 4, "documents current behaviour (no duplicate-submission key on PO create)");
    });

    /* ================= F. Inventory adjustments & transfers ================= */
    console.log("F. Inventory adjustments & transfers");
    await test("6 simultaneous keyed restocks with one key: stock rises once, one adjustment record", async () => {
      const id = await product({ layers: [[2, 1]] });
      const key = randomUUID();
      const rs = await Promise.all(Array.from({ length: 6 }, () => adjust({ productId: id, qty: 3, direction: "in", idempotencyKey: key })));
      assert.equal((await snap(id)).stock, 5, rs.map((r) => r.status).join(","));
      assert.equal(await InventoryAdjustment.countDocuments({ productId: id }), 1);
      assert.equal(await InventoryAdjustment.countDocuments({ productId: id, pending: true }), 0);
      await assertStockMatchesLayers(id);
    });

    await test("same adjustment key with a different qty is refused (IDEMPOTENCY_MISMATCH); nothing more moves", async () => {
      const id = await product({ layers: [[5, 1]] });
      const key = randomUUID();
      assert.equal((await adjust({ productId: id, qty: 1, direction: "out", reason: "adjustment", idempotencyKey: key })).status, 200);
      const r = await adjust({ productId: id, qty: 2, direction: "out", reason: "adjustment", idempotencyKey: key });
      assert.deepEqual([r.status, r.body?.code], [409, "IDEMPOTENCY_MISMATCH"]);
      assert.equal((await snap(id)).stock, 4);
    });

    await test("8 simultaneous unkeyed restocks are all applied (additive, no lost update)", async () => {
      const id = await product({ layers: [[1, 1]] });
      await Promise.all(Array.from({ length: 8 }, (_, i) => adjust({ productId: id, qty: i + 1, direction: "in" })));
      assert.equal((await snap(id)).stock, 1 + 36);
      await assertStockMatchesLayers(id);
    });

    await test("opposing transfers (sellable⇄tester) in parallel conserve units and keep stock = Σ layers", async () => {
      const id = await product({ layers: [[5, 1]] });
      await Product.updateOne({ _id: id }, { $set: { stockTester: 5 } });
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => transfer(i % 2
        ? { productId: id, qty: 1, from: "stockSellable", to: "stockTester" }
        : { productId: id, qty: 1, from: "stockTester", to: "stockSellable" })));
      const s = await snap(id);
      assert.equal(s.stock + s.tester, 10, `statuses ${rs.map((r) => r.status)}`);
      await assertStockMatchesLayers(id);
    });

    await test("a write-off and a production completion race for the last bottle: exactly one gets it", async () => {
      const o = await productionOrder();
      const rs = await Promise.all([
        adjust({ productId: o.bottle, qty: 1, direction: "out", reason: "wastage_cost" }),
        completeProductionOrder(o.orderId, { actualYieldMl: 50 }).then(() => ({ status: 200 }), () => ({ status: 400 })),
      ]);
      assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
      assert.equal((await snap(o.bottle)).stock, 0);
      assertOrderConsistent(await orderDoc(o.orderId), (await snap(o.output)).stock);
      await assertStockMatchesLayers(o.bottle);
    });

    for (const mode of ["sequential retry", "4 simultaneous submissions"] as const) {
      await test(`keyed customer-wastage replacement, ${mode}: one sale, one deduction, one adjustment record`, async () => {
        const id = await product({ layers: [[5, 1]] });
        const ph = phone();
        const cust = await Customer.create({ name: "IT Leak", phone: ph });
        const key = randomUUID();
        const body = { productId: id, qty: 1, direction: "out", reason: "wastage_customer", customerId: String(cust._id), idempotencyKey: key };
        const rs = mode === "sequential retry"
          ? [await adjust(body), await adjust(body)]
          : await Promise.all(Array.from({ length: 4 }, () => adjust(body)));
        assert.ok(rs.some((r) => r.status === 201 || r.status === 200), rs.map((r) => `${r.status} ${r.body?.error ?? ""}`).join(" | "));
        assert.equal(await Sale.countDocuments({ customerPhone: ph }), 1);
        assert.equal((await snap(id)).stock, 4);
        const adjs = await InventoryAdjustment.find({ productId: id, reason: "wastage_customer" }).lean<any[]>();
        assert.equal(adjs.length, 1, `${adjs.length} wastage_customer records for one replacement (HTTP ${rs.map((r) => r.status)})`);
        assert.ok(adjs[0].saleId && !adjs[0].pending, "the record links the sale and is final");
        const okIds = new Set(rs.filter((r) => r.status < 300).map((r) => r.body.adjustmentId));
        assert.equal(okIds.size, 1, "every successful answer names the same adjustment");
      });
    }
  } finally {
    await failOff();
    await control.close().catch(() => undefined);
    if (/^unich_it_/.test(dbName)) {
      await mongoose.connection.db!.dropDatabase();
      console.log(`\n(dropped throwaway database ${dbName})`);
    } else {
      console.log(`\n(left database ${dbName} in place: only unich_it_* databases are dropped)`);
    }
    await mongoose.disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed, ${blocked} blocked`);
  if (failures.length) console.log(`Failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
