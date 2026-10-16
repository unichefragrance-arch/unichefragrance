/**
 * Cross-module integration suite (npm run test:integration).
 *
 * Drives the real code paths — createSale (POS), PUT /api/purchases/[id]
 * (receiving), completeProductionOrder — against a throwaway LOCAL MongoDB
 * replica set and checks every module the operation touches agrees afterwards:
 * sale ↔ product stock ↔ FIFO layers ↔ customer balance ↔ tender report ↔
 * purchase order ↔ production order.
 *
 * Failure injection uses MongoDB's own `failCommand` fail point (mongod must
 * run with `--setParameter enableTestCommands=1`), scoped to one namespace, so
 * a single write inside a workflow fails exactly where a real outage would.
 * Without test commands those cases are reported as BLOCKED, never as passed.
 *
 * Safety: refuses any non-local DATABASE_URL (e2eGuard). Never loads .env.
 * Uses its own database, which it drops at the end ONLY if the name starts
 * with "unich_it_".
 *
 *   DATABASE_URL='mongodb://127.0.0.1:27499/unich_it_run?replicaSet=rs0&directConnection=true' \
 *     npm run test:integration
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
class Blocked extends Error {}

async function main() {
  // Imported after the guard so nothing can connect before it runs.
  const { connectDB } = await import("../../src/lib/db");
  const { AppSettings, Customer, FifoLayer, Product, ProductionOrder, PurchaseOrder, Sale, Supplier } =
    await import("../../src/lib/models");
  const { addFifoLayer } = await import("../../src/lib/inventory");
  const { createSale } = await import("../../src/lib/sales/createSale");
  const { SaleError } = await import("../../src/lib/sales/errors");
  const { salesByTender } = await import("../../src/lib/reports/tenders");
  const { completeProductionOrder } = await import("../../src/lib/production/completeProduction");
  const { createSessionToken, SESSION_COOKIE } = await import("../../src/lib/auth/session");
  const purchaseRoute = await import("../../src/app/api/purchases/[id]/route");
  const salesRoute = await import("../../src/app/api/sales/route");

  await connectDB();
  const dbName = mongoose.connection.db!.databaseName;
  const control = await MongoClient.connect(env.DATABASE_URL!, { appName: "unich-it-control" });
  const admin = control.db("admin");

  /* ---------- fail points ---------- */
  let failPointsAvailable = true;
  try {
    await admin.command({ configureFailPoint: "failCommand", mode: "off" });
  } catch {
    failPointsAvailable = false;
  }
  async function failNext(command: string, collection: string, times = 1) {
    if (!failPointsAvailable) throw new Blocked("mongod not started with enableTestCommands=1");
    await admin.command({
      configureFailPoint: "failCommand",
      mode: { times },
      // errorCode 2 (BadValue) has no TransientTransactionError label, so the
      // driver does not silently retry it — the workflow sees a hard failure.
      data: { failCommands: [command], namespace: `${dbName}.${collection}`, errorCode: 2 },
    });
  }
  const failOff = () => admin.command({ configureFailPoint: "failCommand", mode: "off" }).catch(() => undefined);

  /* ---------- fixtures ---------- */
  const RUN = `IT${Date.now().toString(36)}`;
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
      sku: `${RUN}-${n}`,
      name: opts.name ?? `${RUN} Item ${n}`,
      category: opts.category ?? "Brands",
      unit: opts.unit ?? "pcs",
      sellPrice: opts.price ?? 10,
      stockSellable: 0,
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

  type Snap = { stock: number; layers: number[]; layerSum: number };
  async function snap(id: string): Promise<Snap> {
    const p = await Product.findById(id).lean<{ stockSellable: number }>();
    const layers = (await FifoLayer.find({ productId: id }).sort({ purchaseDate: 1, _id: 1 }).lean<{ qtyRemaining: number }[]>())
      .map((l) => l.qtyRemaining);
    return { stock: p!.stockSellable, layers, layerSum: round3(layers.reduce((a, b) => a + b, 0)) };
  }
  /** Core inventory invariant: sellable stock always equals what the FIFO layers hold. */
  async function assertStockMatchesLayers(id: string, label = "") {
    const s = await snap(id);
    assert.equal(round3(s.stock), s.layerSum, `${label} stockSellable ${s.stock} != sum(layers) ${s.layerSum}`);
    assert.ok(s.stock >= 0 && s.layers.every((q) => q >= 0), `${label} negative stock/layer: ${JSON.stringify(s)}`);
  }
  const customerOf = (p: string) => Customer.findOne({ phone: p }).lean<{ creditBalance?: number; totalPurchases?: number }>();
  const salesFor = (p: string) => Sale.countDocuments({ customerPhone: p });
  const sale = (lines: any[], extra: Record<string, unknown> = {}) =>
    createSale({ customerPhone: (extra.customerPhone as string) ?? phone(), payment: "cash", lines, idempotencyKey: randomUUID(), ...extra } as any);
  async function expectSaleError(p: Promise<unknown>, code: string) {
    await assert.rejects(p, (e: any) => {
      assert.ok(e instanceof SaleError, `expected SaleError ${code}, got ${e?.name}: ${e?.message}`);
      assert.equal(e.code, code, e.message);
      return true;
    });
  }

  const ownerCookie = `${SESSION_COOKIE}=${encodeURIComponent(createSessionToken({
    userId: String(new mongoose.Types.ObjectId()), name: "IT Owner", email: "it-owner@test.invalid",
    role: "owner", roleLabel: "Owner", branchId: null, branchName: null,
  }))}`;
  const cookieFor = (role: string, branchId: string | null) => `${SESSION_COOKIE}=${encodeURIComponent(createSessionToken({
    userId: String(new mongoose.Types.ObjectId()), name: `IT ${role}`, email: `it-${role}@test.invalid`,
    role: role as any, roleLabel: role, branchId, branchName: branchId ? "IT Branch" : null,
  }))}`;
  async function receive(poId: string, body: Record<string, unknown>, cookie = ownerCookie) {
    const req = new Request(`http://localhost/api/purchases/${poId}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const res = await purchaseRoute.PUT(req, { params: Promise.resolve({ id: poId }) } as any);
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function purchaseOrder(lines: Array<{ productId: string; qty: number; unitCost: number }>) {
    const po = await PurchaseOrder.create({
      supplierId: supplier._id, supplierName: supplier.name, date: new Date("2026-02-01"), status: "ordered", currency: "OMR",
      lines: lines.map((l) => ({ productId: l.productId, productName: "IT", qtyOrdered: l.qty, qtyReceived: 0, qtyFifoApplied: 0, unitCost: l.unitCost })),
    });
    return String(po._id);
  }
  const purchaseLayers = (poId: string) => FifoLayer.countDocuments({ purchaseOrderId: poId });

  try {
    /* ================= A. POS sale — every module agrees ================= */
    console.log("A. POS sale cross-module consistency");

    await test("cash sale across two FIFO layers: sale, stock, layers, cost and tender report agree", async () => {
      const id = await product({ layers: [[3, 4], [5, 6]], price: 10 });
      const p = phone();
      const r = await sale([{ productId: id, qty: 5, lineType: "ready" }], { customerPhone: p });
      const s: any = r.sale;
      assert.equal(s.total, 50);
      assert.equal(s.lines[0].unitPrice, 10, "price comes from the DB");
      const ded = s.inventoryDeductions[0];
      assert.deepEqual(ded.batches.map((b: any) => [b.qty, b.unitCost]), [[3, 4], [2, 6]]);
      assert.equal(ded.costTotal, 24, "COGS = 3×4 + 2×6");
      assert.deepEqual((await snap(id)).layers, [0, 3]);
      await assertStockMatchesLayers(id);
      const c = await customerOf(p);
      assert.equal(c?.totalPurchases, 50);
      assert.equal(c?.creditBalance ?? 0, 0, "cash sale adds no credit");
      const t = await salesByTender({ _id: s._id });
      assert.equal(t.grossSales, 50);
      assert.equal(t.byTender.cash.amount, 50);
    });

    await test("credit sale: customer creditBalance rises by exactly the sale total", async () => {
      const id = await product({ layers: [[10, 2]], price: 7.125 });
      const p = phone();
      const r: any = await sale([{ productId: id, qty: 3, lineType: "ready" }], { customerPhone: p, payment: "credit" });
      assert.equal(r.sale.total, 21.375);
      assert.equal((await customerOf(p))?.creditBalance, 21.375);
      assert.equal((await salesByTender({ _id: r.sale._id })).byTender.credit.amount, 21.375);
    });

    await test("mixed payment: tender split recorded, credit part only goes to the balance, report reconciles", async () => {
      const id = await product({ layers: [[10, 1]], price: 10 });
      const p = phone();
      const r: any = await sale([{ productId: id, qty: 3, lineType: "ready" }], {
        customerPhone: p, payment: "mixed",
        paymentBreakdown: [{ method: "cash", amount: 12.5 }, { method: "card", amount: 7.5 }, { method: "credit", amount: 10 }],
      });
      assert.equal((await customerOf(p))?.creditBalance, 10);
      const t = await salesByTender({ _id: r.sale._id });
      assert.deepEqual([t.byTender.cash.amount, t.byTender.card.amount, t.byTender.credit.amount], [12.5, 7.5, 10]);
      const tenderSum = round3(t.byTender.cash.amount + t.byTender.card.amount + t.byTender.bank.amount + t.byTender.credit.amount);
      assert.equal(tenderSum, r.sale.total, "tenders sum to the sale total");
    });

    await test("two credit sales for the same customer in parallel: no lost balance update", async () => {
      const id = await product({ layers: [[20, 1]], price: 5 });
      const p = phone();
      await sale([{ productId: id, qty: 1, lineType: "ready" }], { customerPhone: p });
      const rs = await Promise.allSettled(Array.from({ length: 6 }, () =>
        sale([{ productId: id, qty: 1, lineType: "ready" }], { customerPhone: p, payment: "credit" })));
      assert.equal(rs.filter((r) => r.status === "fulfilled").length, 6, JSON.stringify(rs.filter((r) => r.status === "rejected").map((r: any) => r.reason?.message)));
      const c = await customerOf(p);
      assert.equal(c?.creditBalance, 30);
      assert.equal(c?.totalPurchases, 35);
      assert.equal(await Customer.countDocuments({ phone: p }), 1, "one customer record, not duplicates");
    });

    /* ================= B. Sale boundaries ================= */
    console.log("B. Sale quantity, stock and payment boundaries");

    await test("qty exactly equal to stock sells; stock ends at 0 and layers drain", async () => {
      const id = await product({ layers: [[2, 1], [3, 1]] });
      await sale([{ productId: id, qty: 5, lineType: "ready" }]);
      assert.deepEqual(await snap(id), { stock: 0, layers: [0, 0], layerSum: 0 });
    });

    await test("qty one unit above stock → INSUFFICIENT_STOCK, nothing written", async () => {
      const id = await product({ layers: [[5, 1]] });
      const p = phone();
      await expectSaleError(sale([{ productId: id, qty: 6, lineType: "ready" }], { customerPhone: p }), "INSUFFICIENT_STOCK");
      assert.deepEqual((await snap(id)).layers, [5]);
      assert.equal(await salesFor(p), 0);
      assert.equal(await customerOf(p), null, "no customer created by a refused sale");
    });

    await test("two lines of the same product whose combined qty exceeds stock are refused", async () => {
      const id = await product({ layers: [[5, 1]] });
      await expectSaleError(sale([{ productId: id, qty: 3, lineType: "ready" }, { productId: id, qty: 3, lineType: "ready" }]), "INSUFFICIENT_STOCK");
      assert.deepEqual((await snap(id)).layers, [5]);
    });

    await test("zero, negative, fractional and non-numeric quantities are refused without side effects", async () => {
      const id = await product({ layers: [[5, 1]] });
      for (const qty of [0, -1, 1.5, "abc", null]) {
        const p = phone();
        await assert.rejects(sale([{ productId: id, qty, lineType: "ready" }], { customerPhone: p }), (e: any) => e instanceof SaleError, `qty ${qty}`);
        assert.equal(await salesFor(p), 0);
      }
      assert.deepEqual((await snap(id)).layers, [5]);
    });

    await test("empty cart, malformed and unknown product ids are refused", async () => {
      await assert.rejects(sale([]), (e: any) => e instanceof SaleError);
      await assert.rejects(sale([{ productId: "not-an-id", qty: 1, lineType: "ready" }]), (e: any) => e instanceof SaleError);
      await expectSaleError(sale([{ productId: String(new mongoose.Types.ObjectId()), qty: 1, lineType: "ready" }]), "PRODUCT_NOT_FOUND");
    });

    await test("oil sizes: ¼/½/1 tola deduct exactly 3/6/12 ml; the last 3 ml sell, 1 ml short is refused", async () => {
      const id = await product({ layers: [[24, 0.5]], unit: "ml", category: "Single Notes", price: 1 });
      for (const [label, ml] of [["¼ Tola", 3], ["½ Tola", 6], ["1 Tola", 12]] as const) {
        const before = (await snap(id)).stock;
        await sale([{ productId: id, qty: 1, lineType: "oil", unitLabel: label }]);
        assert.equal((await snap(id)).stock, before - ml, label);
      }
      assert.equal((await snap(id)).stock, 3);
      await sale([{ productId: id, qty: 1, lineType: "oil", unitLabel: "¼ Tola" }]);
      assert.equal((await snap(id)).stock, 0);
      await expectSaleError(sale([{ productId: id, qty: 1, lineType: "oil", unitLabel: "¼ Tola" }]), "INSUFFICIENT_STOCK");
      await assertStockMatchesLayers(id);
    });

    await test("mixed payment: existing 0.01 OMR tolerance — 0.010 off accepted, 0.011 off refused; negative/unknown refused", async () => {
      const id = await product({ layers: [[10, 1]], price: 10 });
      const mixed = (a: number, b: number) => sale([{ productId: id, qty: 1, lineType: "ready" }], {
        payment: "mixed", paymentBreakdown: [{ method: "cash", amount: a }, { method: "card", amount: b }],
      });
      // Policy in normalizePaymentBreakdown: |sum − total| > 0.01 is refused.
      await assert.rejects(mixed(5, 4.989), (e: any) => e instanceof SaleError, "0.011 short");
      await assert.rejects(mixed(5, 5.011), (e: any) => e instanceof SaleError, "0.011 over");
      const p = phone();
      const within: any = await sale([{ productId: id, qty: 1, lineType: "ready" }], {
        customerPhone: p, payment: "mixed", paymentBreakdown: [{ method: "cash", amount: 5 }, { method: "credit", amount: 4.99 }],
      });
      const tenders = within.sale.paymentBreakdown.reduce((a: number, e: any) => a + e.amount, 0);
      // FINDING (policy, not changed): recorded tenders may differ from the sale total by up to 0.01.
      assert.equal(round3(within.sale.total - tenders), 0.01, "documented gap between total and tenders");
      await assert.rejects(mixed(15, -5), (e: any) => e instanceof SaleError, "negative part that still sums to the total");
      await assert.rejects(sale([{ productId: id, qty: 1, lineType: "ready" }], { payment: "bitcoin" }), (e: any) => e instanceof SaleError);
      const before = (await snap(id)).stock;
      await mixed(5, 5);
      assert.equal((await snap(id)).stock, before - 1, "exact split sells");
      await assertStockMatchesLayers(id);
    });

    /* ================= C. Idempotency ================= */
    console.log("C. Idempotency and duplicate submissions");

    await test("lost response: same key retried returns the original sale; stock and balance change once", async () => {
      const id = await product({ layers: [[10, 1]], price: 4 });
      const p = phone();
      const key = randomUUID();
      const body = { customerPhone: p, payment: "credit", idempotencyKey: key, lines: [{ productId: id, qty: 2, lineType: "ready" }] };
      const first: any = await createSale(body as any);
      const retry: any = await createSale(body as any);
      assert.equal(String(retry.sale._id ?? retry.sale.id), String(first.sale._id ?? first.sale.id));
      assert.equal(retry.deduplicated, true);
      assert.equal(await salesFor(p), 1);
      assert.equal((await snap(id)).stock, 8);
      assert.equal((await customerOf(p))?.creditBalance, 8);
    });

    await test("double-click: 8 parallel submissions with one key → exactly one sale, one deduction", async () => {
      const id = await product({ layers: [[10, 1]] });
      const p = phone();
      const key = randomUUID();
      const body = { customerPhone: p, payment: "cash", idempotencyKey: key, lines: [{ productId: id, qty: 3, lineType: "ready" }] };
      const rs = await Promise.allSettled(Array.from({ length: 8 }, () => createSale(body as any)));
      assert.equal(rs.filter((r) => r.status === "fulfilled").length, 8, JSON.stringify(rs.filter((r) => r.status === "rejected").map((r: any) => r.reason?.message)));
      const ids = new Set(rs.map((r: any) => String(r.value.sale._id ?? r.value.sale.id)));
      assert.equal(ids.size, 1);
      assert.equal(await salesFor(p), 1);
      assert.equal((await snap(id)).stock, 7);
    });

    await test("same key with a different cart → rejected; the original sale is untouched", async () => {
      const id = await product({ layers: [[10, 1]] });
      const p = phone();
      const key = randomUUID();
      await createSale({ customerPhone: p, payment: "cash", idempotencyKey: key, lines: [{ productId: id, qty: 1, lineType: "ready" }] } as any);
      await assert.rejects(
        createSale({ customerPhone: p, payment: "cash", idempotencyKey: key, lines: [{ productId: id, qty: 4, lineType: "ready" }] } as any),
        (e: any) => e instanceof SaleError,
      );
      assert.equal(await salesFor(p), 1);
      assert.equal((await snap(id)).stock, 9);
    });

    await test("different keys for the same cart are two sales (documented contract: the key defines identity)", async () => {
      const id = await product({ layers: [[10, 1]] });
      const p = phone();
      await sale([{ productId: id, qty: 1, lineType: "ready" }], { customerPhone: p });
      await sale([{ productId: id, qty: 1, lineType: "ready" }], { customerPhone: p });
      assert.equal(await salesFor(p), 2);
      assert.equal((await snap(id)).stock, 8);
    });

    /* ================= D. Concurrency ================= */
    console.log("D. Concurrency");

    await test("10 cashiers race for the last 3 units: exactly 3 sales, stock 0, never negative", async () => {
      const id = await product({ layers: [[1, 1], [2, 2]] });
      const rs = await Promise.allSettled(Array.from({ length: 10 }, () => sale([{ productId: id, qty: 1, lineType: "ready" }])));
      const ok = rs.filter((r) => r.status === "fulfilled").length;
      const refused = rs.filter((r: any) => r.status === "rejected" && r.reason?.code === "INSUFFICIENT_STOCK").length;
      assert.equal(ok, 3);
      assert.equal(refused, 7, "every other request refused for stock, not crashed");
      assert.deepEqual(await snap(id), { stock: 0, layers: [0, 0], layerSum: 0 });
      assert.equal(await Sale.countDocuments({ "lines.productId": new mongoose.Types.ObjectId(id) }), 3);
    });

    await test("receiving stock while selling it: final stock = received − sold, layers agree", async () => {
      const id = await product({ layers: [[5, 1]] });
      const poId = await purchaseOrder([{ productId: id, qty: 10, unitCost: 2 }]);
      const ops = [
        receive(poId, { receiveAll: true }),
        ...Array.from({ length: 4 }, () => sale([{ productId: id, qty: 2, lineType: "ready" }])),
      ];
      const rs = await Promise.allSettled(ops);
      const sold = rs.slice(1).filter((r) => r.status === "fulfilled").length * 2;
      assert.equal((rs[0] as any).value.status, 200);
      assert.equal((await snap(id)).stock, 15 - sold);
      await assertStockMatchesLayers(id);
    });

    /* ================= E. Failure injection inside the sale transaction ================= */
    console.log("E. Partial failures during checkout (failCommand)");

    const atomicCase = (label: string, command: string, collection: string) =>
      test(`${label} → whole checkout rolls back; a retry with the same key then succeeds once`, async () => {
        const id = await product({ layers: [[4, 1], [4, 2]], price: 5 });
        const p = phone();
        const key = randomUUID();
        const body = { customerPhone: p, payment: "credit", idempotencyKey: key, lines: [{ productId: id, qty: 6, lineType: "ready" }] };
        const before = await snap(id);
        await failNext(command, collection);
        try {
          await assert.rejects(createSale(body as any));
        } finally {
          await failOff();
        }
        assert.deepEqual(await snap(id), before, "stock and layers unchanged");
        assert.equal(await salesFor(p), 0, "no sale");
        const c = await customerOf(p);
        assert.ok(!c || ((c.creditBalance ?? 0) === 0 && (c.totalPurchases ?? 0) === 0), `customer untouched: ${JSON.stringify(c)}`);
        await createSale(body as any);
        assert.equal(await salesFor(p), 1);
        assert.deepEqual((await snap(id)).layers, [0, 2]);
        assert.equal((await customerOf(p))?.creditBalance, 30);
      });
    await atomicCase("sale insert fails", "insert", "sales");
    await atomicCase("FIFO layer write fails after the sale insert", "update", "fifolayers");
    await atomicCase("product stock write fails", "update", "products");
    await atomicCase("customer upsert fails", "findAndModify", "customers");

    await test("transaction commit fails → nothing persisted", async () => {
      if (!failPointsAvailable) throw new Blocked("mongod not started with enableTestCommands=1");
      const id = await product({ layers: [[5, 1]] });
      const p = phone();
      const before = await snap(id);
      await admin.command({ configureFailPoint: "failCommand", mode: { times: 1 }, data: { failCommands: ["commitTransaction"], errorCode: 2 } });
      try {
        await assert.rejects(sale([{ productId: id, qty: 2, lineType: "ready" }], { customerPhone: p }));
      } finally {
        await failOff();
      }
      assert.deepEqual(await snap(id), before);
      assert.equal(await salesFor(p), 0);
    });

    /* ================= F. Purchase receiving ================= */
    console.log("F. Purchase receiving");

    await test("partial then full receive: layers per delta at PO cost, stock and status follow", async () => {
      const id = await product();
      const poId = await purchaseOrder([{ productId: id, qty: 10, unitCost: 3.5 }]);
      let r = await receive(poId, { receive: [{ productId: id, qty: 4 }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.status, "partial");
      assert.equal((await snap(id)).stock, 4);
      r = await receive(poId, { receive: [{ productId: id, qty: 6 }] });
      assert.equal(r.body.status, "received");
      const layers = await FifoLayer.find({ purchaseOrderId: poId }).sort({ _id: 1 }).lean<any[]>();
      assert.deepEqual(layers.map((l) => [l.originalQty, l.unitCost]), [[4, 3.5], [6, 3.5]]);
      await assertStockMatchesLayers(id);
    });

    await test("receiving the same PO twice (sequential) does not duplicate stock", async () => {
      const id = await product();
      const poId = await purchaseOrder([{ productId: id, qty: 5, unitCost: 1 }]);
      await receive(poId, { receiveAll: true });
      await receive(poId, { receiveAll: true });
      assert.equal((await snap(id)).stock, 5);
      assert.equal(await purchaseLayers(poId), 1);
    });

    await test("over-receiving is capped at the ordered quantity", async () => {
      const id = await product();
      const poId = await purchaseOrder([{ productId: id, qty: 5, unitCost: 1 }]);
      await receive(poId, { receive: [{ productId: id, qty: 50 }] });
      assert.equal((await snap(id)).stock, 5);
    });

    await test("non-owner without purchases:write cannot receive; nothing changes", async () => {
      const id = await product();
      const poId = await purchaseOrder([{ productId: id, qty: 5, unitCost: 1 }]);
      for (const role of ["cashier", "accountant", "inventory"]) {
        const r = await receive(poId, { receiveAll: true }, cookieFor(role, null));
        assert.equal(r.status, 403, `${role}: ${r.status}`);
      }
      assert.equal((await snap(id)).stock, 0);
    });

    await test("double-click: two concurrent receiveAll on the same PO add the stock once", async () => {
      const id = await product();
      const poId = await purchaseOrder([{ productId: id, qty: 5, unitCost: 1 }]);
      const rs = await Promise.all([receive(poId, { receiveAll: true }), receive(poId, { receiveAll: true })]);
      const s = await snap(id);
      assert.equal(s.stock, 5, `stock ${s.stock} after 2 parallel receives (statuses ${rs.map((r) => r.status)}), layers ${await purchaseLayers(poId)}`);
      assert.equal(await purchaseLayers(poId), 1);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], "the losing request is told to reload (409)");
    });

    await test("PO save fails after the layers were written; retry must not add the stock twice", async () => {
      const id = await product();
      const poId = await purchaseOrder([{ productId: id, qty: 5, unitCost: 1 }]);
      await failNext("update", "purchaseorders");
      let first;
      try {
        first = await receive(poId, { receiveAll: true });
      } finally {
        await failOff();
      }
      assert.notEqual(first.status, 200, "the failed save is reported as an error");
      assert.equal((await snap(id)).stock, 0, "nothing received while the save failed");
      assert.equal(await purchaseLayers(poId), 0, "no orphan FIFO layer left behind");
      await receive(poId, { receiveAll: true });
      const s = await snap(id);
      assert.equal(s.stock, 5, `stock ${s.stock}, purchase layers ${await purchaseLayers(poId)} — expected one receipt of 5`);
    });

    /* ================= G. Production ================= */
    console.log("G. Production (remix) orders");

    async function productionOrder(runs = 1) {
      const oil = await product({ layers: [[10, 2], [10 + 15 * (runs - 1), 3]], unit: "ml", category: "Single Notes", name: `${RUN} Oud Oil ${seq}` });
      const ethanol = await product({ layers: [[100, 0.1]], unit: "ml", category: "Packaging", name: `${RUN} Ethanol ${seq}` });
      const bottle = await product({ layers: [[3, 0.5]], category: "Packaging", name: `${RUN} Bottle ${seq}` });
      const output = await product({ category: "Remix", name: `${RUN} Remix Output ${seq}` });
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

    await test("completion consumes each component FIFO, creates one output layer at material cost", async () => {
      const o = await productionOrder();
      const done: any = await completeProductionOrder(o.orderId, { actualYieldMl: 50, completedBy: "IT" });
      assert.equal(done.status, "completed");
      assert.deepEqual((await snap(o.oil)).layers, [0, 5], "15 ml oil: 10 from the older layer, 5 from the newer");
      assert.equal((await snap(o.ethanol)).stock, 65);
      assert.equal((await snap(o.bottle)).stock, 2);
      const expectedCost = round3(10 * 2 + 5 * 3 + 35 * 0.1 + 1 * 0.5);
      assert.equal(done.batch.totalMaterialCost, expectedCost);
      const outLayers = await FifoLayer.find({ productId: o.output }).lean<any[]>();
      assert.equal(outLayers.length, 1);
      assert.equal(outLayers[0].unitCost, expectedCost);
      for (const id of [o.oil, o.ethanol, o.bottle, o.output]) await assertStockMatchesLayers(id);
    });

    await test("a missing / insufficient component refuses the whole order; nothing is consumed", async () => {
      const o = await productionOrder();
      await FifoLayer.updateMany({ productId: o.bottle }, { $set: { qtyRemaining: 0 } });
      await Product.updateOne({ _id: o.bottle }, { $set: { stockSellable: 0 } });
      const before = await Promise.all([o.oil, o.ethanol].map(snap));
      await assert.rejects(completeProductionOrder(o.orderId, { actualYieldMl: 50 }));
      assert.deepEqual(await Promise.all([o.oil, o.ethanol].map(snap)), before);
      assert.equal((await ProductionOrder.findById(o.orderId).lean<any>()).status, "draft");
      assert.equal((await snap(o.output)).stock, 0);
    });

    await test("two concurrent completions: exactly one consumes materials", async () => {
      const o = await productionOrder();
      const rs = await Promise.allSettled([1, 2].map(() => completeProductionOrder(o.orderId, { actualYieldMl: 50 })));
      assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal((await snap(o.ethanol)).stock, 65);
      assert.equal((await snap(o.output)).stock, 1);
    });

    await test("output layer insert fails → consumed materials are restored, order stays draft", async () => {
      const o = await productionOrder();
      const before = await Promise.all([o.oil, o.ethanol, o.bottle].map(snap));
      await failNext("insert", "fifolayers");
      try {
        await assert.rejects(completeProductionOrder(o.orderId, { actualYieldMl: 50 }));
      } finally {
        await failOff();
      }
      const after = await Promise.all([o.oil, o.ethanol, o.bottle].map(snap));
      assert.deepEqual(after.map((s) => s.stock), before.map((s) => s.stock));
      assert.equal((await snap(o.output)).stock, 0);
      assert.equal((await ProductionOrder.findById(o.orderId).lean<any>()).status, "draft");
      for (const id of [o.oil, o.ethanol, o.bottle]) await assertStockMatchesLayers(id);
    });

    await test("order save fails after materials and output moved: state stays consistent, retry consumes once", async () => {
      const o = await productionOrder(2); // enough stock for two runs, so a double consume would succeed and show
      await failNext("update", "productionorders");
      try {
        await assert.rejects(completeProductionOrder(o.orderId, { actualYieldMl: 50 }));
      } finally {
        await failOff();
      }
      const status = (await ProductionOrder.findById(o.orderId).lean<any>()).status;
      const ethAfterFail = (await snap(o.ethanol)).stock;
      const outAfterFail = (await snap(o.output)).stock;
      // Invariant: the order is completed  <=>  materials were consumed and output added.
      assert.ok(
        (status === "completed" && ethAfterFail === 65 && outAfterFail === 1) ||
        (status === "draft" && ethAfterFail === 100 && outAfterFail === 0),
        `after failed save: status=${status}, ethanol=${ethAfterFail} (100 untouched / 65 consumed), output=${outAfterFail}`,
      );
      await completeProductionOrder(o.orderId, { actualYieldMl: 50 }).catch(() => undefined);
      assert.equal((await snap(o.ethanol)).stock, 65, "consumed exactly once after retry");
      assert.equal((await snap(o.output)).stock, 1, "exactly one finished unit after retry");
      assert.equal((await ProductionOrder.findById(o.orderId).lean<any>()).status, "completed");
    });

    /* ================= H. Authorization through the sales route ================= */
    console.log("H. Authorization on POST /api/sales");

    const postSale = async (cookie: string | null, body: Record<string, unknown>) => {
      const res = await salesRoute.POST(new Request("http://localhost/api/sales", {
        method: "POST",
        headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json", "idempotency-key": randomUUID() },
        body: JSON.stringify(body),
      }));
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    await test("unauthenticated and accountant/inventory checkout refused; no stock moves", async () => {
      const id = await product({ layers: [[5, 1]] });
      const body = { customerPhone: phone(), payment: "cash", lines: [{ productId: id, qty: 1, lineType: "ready" }] };
      assert.equal((await postSale(null, body)).status, 401);
      for (const role of ["accountant", "inventory"]) {
        assert.equal((await postSale(cookieFor(role, null), body)).status, 403, role);
      }
      assert.equal((await snap(id)).stock, 5);
    });

    await test("client-supplied price is ignored: the sale is priced from the database", async () => {
      const id = await product({ layers: [[5, 1]], price: 12.5 });
      const r = await postSale(cookieFor("cashier", null), {
        customerPhone: phone(), payment: "cash", lines: [{ productId: id, qty: 1, lineType: "ready", unitPrice: 0.001 }],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.total ?? r.body.sale?.total, 12.5);
    });
    /* ================= I. Stock-bucket transfers ================= */
    console.log("I. Stock-bucket transfers (sellable ↔ tester/sample/personal)");

    const transferRoute = await import("../../src/app/api/inventory/transfers/route");
    const transfer = async (body: Record<string, unknown>) => {
      const res = await transferRoute.POST(new Request("http://localhost/api/inventory/transfers", {
        method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const buckets = async (id: string) => {
      const p = await Product.findById(id).lean<any>();
      return { sellable: p.stockSellable, tester: p.stockTester, total: round3(p.stockSellable + p.stockTester + p.stockSample + p.stockPersonal) };
    };

    await test("sellable → tester moves units and keeps stock = Σ layers", async () => {
      const id = await product({ layers: [[10, 1]] });
      const r = await transfer({ productId: id, qty: 3, from: "stockSellable", to: "stockTester" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(await buckets(id), { sellable: 7, tester: 3, total: 10 });
      await assertStockMatchesLayers(id);
    });

    for (const [from, to] of [["stockSellable", "stockTester"], ["stockTester", "stockSellable"]] as const) {
      await test(`${from} → ${to}: a failure on the second write never loses or invents units`, async () => {
        if (!failPointsAvailable) throw new Blocked("mongod not started with enableTestCommands=1");
        // Fail every write to products after the first one, one transfer at a time,
        // until the transfer succeeds — every intermediate state must conserve units.
        const id = await product({ layers: [[10, 1]] });
        if (from === "stockTester") await Product.updateOne({ _id: id }, { $set: { stockTester: 10 } });
        const start = (await buckets(id)).total;
        const broken: string[] = [];
        for (let skip = 0; skip < 4; skip++) {
          await admin.command({
            configureFailPoint: "failCommand", mode: { skip },
            data: { failCommands: ["update"], namespace: `${dbName}.products`, errorCode: 2 },
          });
          let r;
          try {
            r = await transfer({ productId: id, qty: 1, from, to });
          } finally {
            await failOff();
          }
          const b = await buckets(id);
          if (r.status !== 200 && b.total !== start) broken.push(`skip=${skip}: HTTP ${r.status}, total ${start} → ${b.total}`);
          if (r.status === 200) break;
        }
        assert.deepEqual(broken, [], `units lost/created on a failed transfer: ${broken.join("; ")}`);
      });
    }

    await test("tester → sellable adds a FIFO layer for the moved units (stock = Σ layers)", async () => {
      const id = await product({ layers: [[2, 1]] });
      await Product.updateOne({ _id: id }, { $set: { stockTester: 5 } });
      const r = await transfer({ productId: id, qty: 4, from: "stockTester", to: "stockSellable" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(await buckets(id), { sellable: 6, tester: 1, total: 7 });
      await assertStockMatchesLayers(id);
    });

    await test("transfer of more than the source holds is refused with nothing moved", async () => {
      const id = await product({ layers: [[2, 1]] });
      // Existing contract: 409 STOCK_WARNING first; acknowledged, it is a hard 400.
      const warn = await transfer({ productId: id, qty: 3, from: "stockSellable", to: "stockTester" });
      assert.deepEqual([warn.status, warn.body?.code], [409, "STOCK_WARNING"]);
      const acked = await transfer({ productId: id, qty: 3, from: "stockSellable", to: "stockTester", acknowledgeWarning: true });
      assert.deepEqual([acked.status, acked.body?.code], [400, "INSUFFICIENT_STOCK"]);
      assert.deepEqual(await buckets(id), { sellable: 2, tester: 0, total: 2 });
    });

    /* ================= J. Stock count correction (absolute target) ================= */
    console.log("J. Stock count correction via PUT /api/products/[id]");

    const productRoute = await import("../../src/app/api/products/[id]/route");
    const putProduct = async (id: string, body: Record<string, unknown>) => {
      const res = await productRoute.PUT(new Request(`http://localhost/api/products/${id}`, {
        method: "PUT", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ id }) } as any);
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    await test("count correction sets the absolute target (5 → 10) and books one adjustment", async () => {
      const id = await product({ layers: [[5, 1]] });
      const r = await putProduct(id, { stockSellable: 10 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await snap(id)).stock, 10);
      await assertStockMatchesLayers(id);
    });

    await test("two concurrent corrections to the same target (5 → 10) end at 10, not 15", async () => {
      const id = await product({ layers: [[5, 1]] });
      const rs = await Promise.all([putProduct(id, { stockSellable: 10 }), putProduct(id, { stockSellable: 10 })]);
      const s = (await snap(id)).stock;
      assert.equal(s, 10, `stock ${s} after two "set to 10" requests (statuses ${rs.map((r) => r.status)})`);
      await assertStockMatchesLayers(id);
    });

    await test("correction whose audit record fails to save leaves no unrecorded stock change", async () => {
      const id = await product({ layers: [[5, 1]] });
      await failNext("insert", "inventoryadjustments");
      let r;
      try {
        r = await putProduct(id, { stockSellable: 8 });
      } finally {
        await failOff();
      }
      const s = (await snap(id)).stock;
      const { InventoryAdjustment } = await import("../../src/lib/models");
      const records = await InventoryAdjustment.countDocuments({ productId: id });
      assert.ok(
        (r.status === 200 && s === 8 && records === 1) || (r.status !== 200 && s === 5 && records === 0),
        `HTTP ${r.status}: stock ${s} (5 → 8 requested), adjustment records ${records}`,
      );
    });

    await test("non-sellable buckets cannot be set negative or non-numeric through product edit", async () => {
      const id = await product();
      for (const v of [-5, "abc", null]) {
        const r = await putProduct(id, { stockTester: v });
        const p = await Product.findById(id).lean<any>();
        assert.ok(r.status === 400 || p.stockTester === 0, `stockTester ${JSON.stringify(v)} → HTTP ${r.status}, stored ${p.stockTester}`);
      }
    });

    await test("valid non-sellable quantities are still saved through product edit", async () => {
      const id = await product();
      const r = await putProduct(id, { stockTester: 3, stockSample: 0 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const p = await Product.findById(id).lean<any>();
      assert.deepEqual([p.stockTester, p.stockSample], [3, 0]);
    });

    await test("count correction downwards consumes FIFO and records the cost", async () => {
      const id = await product({ layers: [[3, 2], [4, 5]] });
      const r = await putProduct(id, { stockSellable: 2 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual((await snap(id)).layers, [0, 2]);
      assert.equal(r.body.stockAdjustment.delta, -5);
      const { InventoryAdjustment } = await import("../../src/lib/models");
      const adj = await InventoryAdjustment.findOne({ productId: id }).lean<any>();
      assert.equal(adj.costTotal, 3 * 2 + 2 * 5, "cost of the 5 units removed, oldest first");
    });

    /* ================= K. Product create: server-owned fields ================= */
    console.log("K. Product create (POST /api/products)");

    const productsRoute = await import("../../src/app/api/products/route");
    const postProduct = async (body: Record<string, unknown>) => {
      const res = await productsRoute.POST(new Request("http://localhost/api/products", {
        method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    await test("opening stock is booked as one FIFO layer (stock = Σ layers)", async () => {
      const r = await postProduct({ sku: `${RUN}-OPEN`, name: "Open", category: "Brands", unit: "pcs", sellPrice: 5, stockSellable: 4, costFifo: 2 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await snap(r.body.id)).stock, 4);
      await assertStockMatchesLayers(r.body.id);
    });

    await test("client cannot set negative non-sellable stock or forge _id / timestamps on create", async () => {
      const forgedId = String(new mongoose.Types.ObjectId());
      const r = await postProduct({
        sku: `${RUN}-MASS`, name: "Mass", category: "Brands", unit: "pcs", sellPrice: 5,
        _id: forgedId, stockTester: -7, createdAt: "2001-01-01T00:00:00.000Z",
      });
      const p = r.status === 201 ? await Product.findById(r.body.id).lean<any>() : null;
      const issues = p ? [
        String(p._id) === forgedId && "client-chosen _id accepted",
        p.stockTester < 0 && `negative stockTester ${p.stockTester} accepted`,
        new Date(p.createdAt).getUTCFullYear() === 2001 && "client createdAt accepted",
      ].filter(Boolean) : [];
      assert.deepEqual(issues, [], issues.join("; "));
    });

    await test("ordinary catalogue fields are still accepted on create", async () => {
      const r = await postProduct({ sku: `${RUN}-CAT`, name: "Cat", nameAr: "قط", category: "Brands", unit: "pcs", sellPrice: 9.5, brand: "B", stockTester: 2, tags: ["x"] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const p = await Product.findById(r.body.id).lean<any>();
      assert.deepEqual([p.nameAr, p.brand, p.stockTester, p.sellPrice], ["قط", "B", 2, 9.5]);
    });

    /* ================= L. Import undo ================= */
    console.log("L. Product import undo");

    const undoRoute = await import("../../src/app/api/products/import/[batchId]/undo/route");
    await test("undoing an import never deletes stock bought or sold after the import", async () => {
      const { ImportBatch } = await import("../../src/lib/models");
      const id = await product();
      const batchId = `${RUN}-BATCH`;
      await ImportBatch.create({
        batchId, userName: "IT", fileName: "it.xlsx", status: "committed",
        rows: [{ rowNumber: 2, action: "create", createdProductId: id }],
      });
      // After the import: goods are received and one is sold.
      const poId = await purchaseOrder([{ productId: id, qty: 4, unitCost: 2 }]);
      await receive(poId, { receiveAll: true });
      const sold: any = await sale([{ productId: id, qty: 1, lineType: "ready" }]);
      const res = await undoRoute.POST(new Request(`http://localhost/api/products/import/${batchId}/undo`, {
        method: "POST", headers: { cookie: ownerCookie },
      }), { params: Promise.resolve({ batchId }) } as any);
      const stillThere = await Product.exists({ _id: id });
      const layers = await FifoLayer.countDocuments({ productId: id });
      const saleRef = await Sale.exists({ _id: sold.sale._id, "lines.productId": new mongoose.Types.ObjectId(id) });
      assert.ok(
        res.status !== 200 || (stillThere && layers > 0),
        `undo HTTP ${res.status}: product exists=${!!stillThere}, FIFO layers left=${layers}, sale still references it=${!!saleRef} — 3 received units + their cost history deleted`,
      );
    });

    await test("undoing an import whose products were never used still removes them", async () => {
      const { ImportBatch } = await import("../../src/lib/models");
      const id = await product();
      const batchId = `${RUN}-BATCH2`;
      await ImportBatch.create({
        batchId, userName: "IT", fileName: "it2.xlsx", status: "committed",
        rows: [{ rowNumber: 2, action: "create", createdProductId: id }],
      });
      const res = await undoRoute.POST(new Request(`http://localhost/api/products/import/${batchId}/undo`, {
        method: "POST", headers: { cookie: ownerCookie },
      }), { params: Promise.resolve({ batchId }) } as any);
      assert.equal(res.status, 200, JSON.stringify(await res.json().catch(() => null)));
      assert.equal(await Product.exists({ _id: id }), null);
    });
    /* ================= M. Inventory & FIFO adversarial checks ================= */
    console.log("M. Inventory & FIFO — other stock entry points");
    const { InventoryAdjustment, ImportBatch } = await import("../../src/lib/models");
    const call = async (mod: any, method: string, url: string, body?: unknown, params?: Record<string, string>, cookie = ownerCookie) => {
      const res = await mod[method](new Request(`http://localhost${url}`, {
        method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), params ? ({ params: Promise.resolve(params) } as any) : undefined);
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const fifoLayersRoute = await import("../../src/app/api/fifo-layers/route");
    const adjustmentsRoute = await import("../../src/app/api/inventory/adjustments/route");
    const commitRoute = await import("../../src/app/api/products/import/commit/route");

    // --- M1: manual FIFO layer endpoint ---
    await test("POST /api/fifo-layers refuses negative / zero / NaN qty and negative cost; stock untouched", async () => {
      const id = await product({ layers: [[5, 1]] });
      const bad: Array<Record<string, unknown>> = [
        { qty: -3, unitCost: 1 }, { qty: 0, unitCost: 1 }, { qty: "abc", unitCost: 1 },
        { qty: 2, unitCost: -4 }, { qty: 2, unitCost: "x" }, { qty: Infinity, unitCost: 1 },
      ];
      const accepted: string[] = [];
      for (const b of bad) {
        const r = await call(fifoLayersRoute, "POST", "/api/fifo-layers", { productId: id, supplierId: String(supplier._id), supplierName: "IT", purchaseDate: "2026-03-01", ...b });
        if (r.status < 300) accepted.push(`${JSON.stringify(b)} → ${r.status}`);
      }
      const s = await snap(id);
      assert.deepEqual(accepted, [], `accepted invalid layers: ${accepted.join("; ")} — stock now ${s.stock}, layers ${JSON.stringify(s.layers)}`);
      assert.deepEqual(s.layers, [5]);
    });

    await test("POST /api/fifo-layers for a product that does not exist creates no orphan layer", async () => {
      const ghost = String(new mongoose.Types.ObjectId());
      const r = await call(fifoLayersRoute, "POST", "/api/fifo-layers", { productId: ghost, supplierId: String(supplier._id), supplierName: "IT", purchaseDate: "2026-03-01", qty: 4, unitCost: 1 });
      const orphans = await FifoLayer.countDocuments({ productId: ghost });
      assert.ok(r.status >= 400 && orphans === 0, `HTTP ${r.status}, orphan layers ${orphans}`);
    });

    await test("a manual FIFO layer that adds stock is recorded as an inventory adjustment", async () => {
      const id = await product({ layers: [[5, 1]] });
      const r = await call(fifoLayersRoute, "POST", "/api/fifo-layers", { productId: id, supplierId: String(supplier._id), supplierName: "IT", purchaseDate: "2026-03-01", qty: 3, unitCost: 2 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await snap(id)).stock, 8);
      await assertStockMatchesLayers(id);
      const recorded = await InventoryAdjustment.countDocuments({ productId: id, direction: "in" });
      assert.equal(recorded, 1, "stock +3 with no adjustment/audit record");
    });

    // --- M2: product delete ---
    await test("deleting a product with stock or sales history is refused; nothing is deleted", async () => {
      const id = await product({ layers: [[5, 1]] });
      await sale([{ productId: id, qty: 1, lineType: "ready" }]);
      const r = await call(productRoute, "DELETE", `/api/products/${id}`, undefined, { id });
      const exists = await Product.exists({ _id: id });
      const layers = await FifoLayer.countDocuments({ productId: id });
      assert.ok(r.status >= 400 && exists && layers > 0, `HTTP ${r.status}: product exists=${!!exists}, layers=${layers} (4 units on hand + a sale)`);
    });

    await test("deleting an unused product (no stock, no history) still works", async () => {
      const id = await product();
      const r = await call(productRoute, "DELETE", `/api/products/${id}`, undefined, { id });
      assert.ok(r.status < 300, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(await Product.exists({ _id: id }), null);
    });

    // --- M3: receiving whole units ---
    await test("receiving a fractional quantity of a pcs product is refused (no stranded half units)", async () => {
      const id = await product();
      const poId = await purchaseOrder([{ productId: id, qty: 5, unitCost: 1 }]);
      const r = await receive(poId, { receive: [{ productId: id, qty: 2.5 }] });
      const s = await snap(id);
      assert.ok(r.status >= 400 && s.stock === 0, `HTTP ${r.status}: pcs stock ${s.stock} after receiving 2.5`);
    });

    await test("receiving a fractional quantity of an ml product is fine", async () => {
      const id = await product({ unit: "ml", category: "Single Notes" });
      const poId = await purchaseOrder([{ productId: id, qty: 50, unitCost: 0.4 }]);
      const r = await receive(poId, { receive: [{ productId: id, qty: 12.5 }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await snap(id)).stock, 12.5);
    });

    // --- M4: import update rows recosting / changing unit of stocked products ---
    await test("import update cannot change the unit or overwrite FIFO cost of a product that holds stock", async () => {
      const id = await product({ layers: [[4, 3], [6, 5]] });
      const p0 = await Product.findById(id).lean<any>();
      const batchId = `${RUN}-UPD`;
      await ImportBatch.create({
        batchId, userName: "IT", fileName: "upd.xlsx", status: "staged",
        rows: [{ rowNumber: 2, action: "update", sku: p0.sku, payload: {
          sku: p0.sku, name: p0.name, category: p0.category, unit: "ml", costFifo: 99, sellPrice: 12, minMarginPct: 0, itemType: "finished",
        } }],
      });
      const r = await call(commitRoute, "POST", "/api/products/import/commit", { batchId, strictMode: false });
      const p1 = await Product.findById(id).lean<any>();
      const layerCost = round3((4 * 3 + 6 * 5) / 10);
      const issues = [
        p1.unit !== p0.unit && `unit ${p0.unit} → ${p1.unit} with 10 ${p0.unit} on hand`,
        p1.costFifo !== layerCost && `costFifo ${p1.costFifo} (layers say ${layerCost})`,
      ].filter(Boolean);
      assert.deepEqual(issues, [], `commit HTTP ${r.status}: ${issues.join("; ")}`);
    });

    // --- M5: write-off partial failures ---
    await test("write-off whose record fails to save (no key) leaves no unrecorded stock loss", async () => {
      const id = await product({ layers: [[5, 1]] });
      await failNext("insert", "inventoryadjustments");
      let r;
      try {
        r = await call(adjustmentsRoute, "POST", "/api/inventory/adjustments", { productId: id, qty: 2, direction: "out", reason: "wastage_cost" });
      } finally {
        await failOff();
      }
      const s = (await snap(id)).stock;
      const records = await InventoryAdjustment.countDocuments({ productId: id });
      assert.ok((r.status < 300 && s === 3 && records === 1) || (r.status >= 400 && s === 5 && records === 0),
        `HTTP ${r.status}: stock ${s} (5 − 2 requested), adjustment records ${records}`);
    });

    await test("write-off with a key whose finalize fails: retry with the same key completes it once", async () => {
      const id = await product({ layers: [[5, 1]] });
      const key = randomUUID();
      const body = { productId: id, qty: 2, direction: "out", reason: "wastage_cost", idempotencyKey: key };
      await failNext("update", "inventoryadjustments");
      let first;
      try {
        first = await call(adjustmentsRoute, "POST", "/api/inventory/adjustments", body);
      } finally {
        await failOff();
      }
      const retry = await call(adjustmentsRoute, "POST", "/api/inventory/adjustments", body);
      const s = (await snap(id)).stock;
      const recs = await InventoryAdjustment.find({ productId: id }).lean<any[]>();
      assert.ok(retry.status < 300 && s === 3 && recs.length === 1 && !recs[0].pending,
        `first HTTP ${first.status}, retry HTTP ${retry.status} ${retry.body?.code ?? ""}: stock ${s}, records ${recs.length}, pending=${recs.map((x) => !!x.pending)}`);
    });

    // --- M5b: legitimate adjustment paths still work ---
    await test("cost write-off books FIFO cost, an approved Wastage expense and links it to the adjustment", async () => {
      const id = await product({ layers: [[2, 3], [5, 4]] });
      const r = await call(adjustmentsRoute, "POST", "/api/inventory/adjustments", { productId: id, qty: 3, direction: "out", reason: "wastage_cost" });
      assert.ok(r.status < 300, JSON.stringify(r.body));
      assert.equal(r.body.costTotal, 2 * 3 + 1 * 4);
      const adj = await InventoryAdjustment.findById(r.body.adjustmentId).lean<any>();
      const { Expense } = await import("../../src/lib/models");
      const exp = await Expense.findById(r.body.expenseId).lean<any>();
      assert.equal(String(adj.expenseId), String(exp._id), "expense linked to the adjustment");
      assert.deepEqual([exp.amount, exp.category], [10, "Wastage"]);
      assert.deepEqual((await snap(id)).layers, [0, 4]);
    });

    await test("keyed restock: replaying the same key adds the stock once", async () => {
      const id = await product({ layers: [[1, 1]] });
      const body = { productId: id, qty: 4, direction: "in", unitCost: 2, idempotencyKey: randomUUID() };
      const a = await call(adjustmentsRoute, "POST", "/api/inventory/adjustments", body);
      const b = await call(adjustmentsRoute, "POST", "/api/inventory/adjustments", body);
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.ok(b.status < 300, `replay HTTP ${b.status} ${JSON.stringify(b.body)}`);
      assert.equal((await snap(id)).stock, 5);
      assert.equal(await InventoryAdjustment.countDocuments({ productId: id }), 1);
      await assertStockMatchesLayers(id);
    });

    await test("manual FIFO layer: fractional pcs refused; valid layer counted once in stock", async () => {
      const id = await product();
      const frac = await call(fifoLayersRoute, "POST", "/api/fifo-layers", { productId: id, supplierId: String(supplier._id), supplierName: "IT", purchaseDate: "2026-03-01", qty: 1.5, unitCost: 1 });
      assert.equal(frac.status, 400);
      assert.equal((await snap(id)).stock, 0);
    });

    // --- M3b: purchase creation ---
    const purchasesRoute = await import("../../src/app/api/purchases/route");
    const createPO = (lines: Array<{ productId: string; qty: number; unitCost: number }>, status = "received") =>
      call(purchasesRoute, "POST", "/api/purchases", {
        supplierId: String(supplier._id), supplierName: supplier.name, date: "2026-03-02", status, vatPercent: 0,
        lines: lines.map((l) => ({ productId: l.productId, productName: "IT", qtyOrdered: l.qty, unitCost: l.unitCost })),
      });

    await test("PO created as received whose FIFO layer write fails leaves no PO and no stock", async () => {
      const id = await product();
      await failNext("insert", "fifolayers");
      let r;
      try {
        r = await createPO([{ productId: id, qty: 5, unitCost: 2 }]);
      } finally {
        await failOff();
      }
      const pos = await PurchaseOrder.countDocuments({ "lines.productId": new mongoose.Types.ObjectId(id) });
      const s = (await snap(id)).stock;
      assert.ok((r.status === 201 && pos === 1 && s === 5) || (r.status >= 400 && pos === 0 && s === 0),
        `HTTP ${r.status}: purchase orders ${pos}, stock ${s}`);
    });

    await test("PO created as received: one receipt, then re-receiving it adds nothing", async () => {
      const id = await product();
      const r = await createPO([{ productId: id, qty: 5, unitCost: 2 }]);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      await receive(r.body.id ?? String(r.body._id), { receiveAll: true });
      assert.equal((await snap(id)).stock, 5);
      await assertStockMatchesLayers(id);
    });

    await test("PO lines: fractional pcs refused on create; fractional ml accepted", async () => {
      const pcs = await product();
      const ml = await product({ unit: "ml", category: "Single Notes" });
      const bad = await createPO([{ productId: pcs, qty: 2.5, unitCost: 1 }], "ordered");
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
      const good = await createPO([{ productId: ml, qty: 7.5, unitCost: 1 }]);
      assert.equal(good.status, 201, JSON.stringify(good.body));
      assert.equal((await snap(ml)).stock, 7.5);
    });

    // --- M4b: import update/undo keep working for legitimate edits ---
    await test("import update still changes price, and cost/unit of products with no stock", async () => {
      const stocked = await product({ layers: [[4, 3]] });
      const empty = await product();
      const [ps, pe] = await Promise.all([Product.findById(stocked).lean<any>(), Product.findById(empty).lean<any>()]);
      const batchId = `${RUN}-UPD2`;
      const row = (p: any, extra: Record<string, unknown>, n: number) => ({ rowNumber: n, action: "update", sku: p.sku, payload: {
        sku: p.sku, name: p.name, category: p.category, unit: p.unit, costFifo: p.costFifo, sellPrice: p.sellPrice, minMarginPct: 0, itemType: "finished", ...extra,
      } });
      await ImportBatch.create({ batchId, userName: "IT", fileName: "upd2.xlsx", status: "staged",
        rows: [row(ps, { sellPrice: 77, costFifo: 50 }, 2), row(pe, { unit: "ml", costFifo: 6, sellPrice: 9 }, 3)] });
      const r = await call(commitRoute, "POST", "/api/products/import/commit", { batchId, strictMode: false });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [s1, e1] = await Promise.all([Product.findById(stocked).lean<any>(), Product.findById(empty).lean<any>()]);
      assert.deepEqual([s1.sellPrice, s1.costFifo], [77, 3], "price updated, FIFO cost kept from layers");
      assert.deepEqual([e1.unit, e1.costFifo, e1.sellPrice], ["ml", 6, 9], "unstocked product fully updated");

      const undo = await call(undoRoute, "POST", `/api/products/import/${batchId}/undo`, undefined, { batchId });
      assert.equal(undo.status, 200, JSON.stringify(undo.body));
      const [s2, e2] = await Promise.all([Product.findById(stocked).lean<any>(), Product.findById(empty).lean<any>()]);
      assert.deepEqual([s2.sellPrice, s2.costFifo], [ps.sellPrice, 3], "undo restores price, keeps layer cost");
      assert.deepEqual([e2.unit, e2.costFifo], [pe.unit, pe.costFifo], "unstocked product fully restored");
    });

    // --- M6: transfers under concurrency and duplicate submission ---
    await test("12 concurrent transfers from the same sellable stock never overdraw or lose units", async () => {
      const id = await product({ layers: [[3, 1], [4, 2]] });
      const rs = await Promise.all(Array.from({ length: 12 }, () =>
        transfer({ productId: id, qty: 1, from: "stockSellable", to: "stockTester", acknowledgeWarning: true })));
      const ok = rs.filter((r) => r.status === 200).length;
      const b = await buckets(id);
      assert.equal(b.total, 7, `units conserved (statuses ${rs.map((r) => r.status).join(",")})`);
      assert.equal(b.sellable, 7 - ok);
      assert.ok(b.sellable >= 0);
      await assertStockMatchesLayers(id);
    });

    await test("FINDING: two identical transfer submissions move the quantity twice (no idempotency key)", async () => {
      const id = await product({ layers: [[10, 1]] });
      const body = { productId: id, qty: 2, from: "stockSellable", to: "stockTester" };
      await Promise.all([transfer(body), transfer(body)]);
      const b = await buckets(id);
      // Documents current behaviour; whether transfers need an idempotency key is a business/API decision.
      assert.deepEqual([b.sellable, b.tester], [6, 4], "each request is an independent transfer today");
    });

    // --- M7: FIFO history ---
    await test("a later purchase at a different cost never changes an earlier sale's recorded COGS", async () => {
      const id = await product({ layers: [[3, 2]], price: 10 });
      const s1: any = await sale([{ productId: id, qty: 2, lineType: "ready" }]);
      const poId = await purchaseOrder([{ productId: id, qty: 5, unitCost: 9 }]);
      await receive(poId, { receiveAll: true });
      await putProduct(id, { stockSellable: 4 });
      const stored = await Sale.findById(s1.sale._id).lean<any>();
      assert.equal(stored.inventoryDeductions[0].costTotal, 4, "2 × 2 at the time of sale");
      const layers = await FifoLayer.find({ productId: id }).lean<any[]>();
      assert.ok(layers.every((l) => l.qtyRemaining <= (l.originalQty ?? l.qtyRemaining) && l.qtyRemaining >= 0), JSON.stringify(layers.map((l) => [l.qtyRemaining, l.originalQty])));
    });

    await test("count corrections to different targets in parallel: final stock is one of the targets and the audit trail adds up", async () => {
      for (let round = 0; round < 3; round++) {
        const id = await product({ layers: [[5, 1]] });
        await Promise.all([putProduct(id, { stockSellable: 10 }), putProduct(id, { stockSellable: 8 })]);
        const s = (await snap(id)).stock;
        const recs = await InventoryAdjustment.find({ productId: id }).lean<any[]>();
        const net = recs.reduce((a, r) => a + (r.direction === "in" ? r.qty : -r.qty), 0);
        assert.ok(s === 8 || s === 10, `round ${round}: stock ${s}`);
        assert.equal(round3(5 + net), s, `round ${round}: audit net ${net} does not explain 5 → ${s}`);
        await assertStockMatchesLayers(id);
      }
    });
    /* ================= S. Security ================= */
    console.log("S. Security — injection, brute force, malformed input");
    const quotationsRoute = await import("../../src/app/api/quotations/route");
    const quotationRoute = await import("../../src/app/api/quotations/[id]/route");
    const quotationPrintRoute = await import("../../src/app/api/quotations/[id]/print/route");
    const publicPrintRoute = await import("../../src/app/api/quotations/public/[token]/print/route");
    const htmlOf = async (res: Response) => ({ status: res.status, html: await res.text() });
    // Harmless marker payloads: they only prove whether markup is emitted unescaped.
    const XSS_IMG = `<img src=x onerror="window.__unichXss=1">`;
    const XSS_SCRIPT = `</td><script>window.__unichXss=2</script>`;

    await test("quotation print (staff and public link) escapes line names — no stored XSS", async () => {
      const cashier = cookieFor("cashier", null);
      const created = await call(quotationsRoute, "POST", "/api/quotations", {
        customerName: `Ali ${XSS_IMG}`, customerPhone: phone(), vatPercent: 0,
        lines: [
          { name: XSS_IMG, qty: 1, unitPrice: 5, unitLabel: "pcs" },
          { name: XSS_SCRIPT, qty: 1, unitPrice: 5, unitLabel: "pcs", notes: XSS_IMG },
        ],
      }, undefined, cashier);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const qid = String(created.body.id ?? created.body._id);
      const shared = await call(quotationRoute, "POST", `/api/quotations/${qid}`, { action: "share" }, { id: qid }, cashier);
      assert.ok(shared.status < 300, JSON.stringify(shared.body));
      const token = shared.body.approvalToken ?? (await (await import("../../src/lib/models")).Quotation.findById(qid).lean<any>()).approvalToken;
      const pages = {
        staff: await htmlOf(await quotationPrintRoute.GET(new Request(`http://localhost/api/quotations/${qid}/print`, { headers: { cookie: cashier } }), { params: Promise.resolve({ id: qid }) } as any)),
        public: await htmlOf(await publicPrintRoute.GET(new Request(`http://localhost/api/quotations/public/${token}/print`), { params: Promise.resolve({ token }) } as any)),
      };
      const raw: string[] = [];
      for (const [which, page] of Object.entries(pages)) {
        assert.equal(page.status, 200, `${which} print HTTP ${page.status}`);
        if (page.html.includes("<img src=x")) raw.push(`${which}: raw <img onerror>`);
        if (page.html.includes("<script>window.__unichXss")) raw.push(`${which}: raw <script>`);
      }
      assert.deepEqual(raw, [], `unescaped markup in printed quotation: ${raw.join("; ")}`);
      assert.ok(pages.public.html.includes("&lt;img src=x"), "payload shown as text");
    });

    await test("formula-admin unlock is rate-limited like login (no unlimited owner-password guessing)", async () => {
      const formulaAdminRoute = await import("../../src/app/api/auth/formula-admin/route");
      const saved = { e: env.ADMIN_EMAIL, p: env.ADMIN_PASSWORD };
      env.ADMIN_EMAIL = `it-admin-${RUN.toLowerCase()}@test.invalid`;
      env.ADMIN_PASSWORD = randomBytes(9).toString("hex");
      try {
        const attempt = (password: string) => call(formulaAdminRoute, "POST", "/api/auth/formula-admin", { email: env.ADMIN_EMAIL, password }, undefined, "");
        const statuses: number[] = [];
        for (let i = 0; i < 12; i++) statuses.push((await attempt(`wrong-${i}`)).status);
        assert.ok(statuses.includes(429), `12 wrong passwords → ${statuses.join(",")} (login locks after 8)`);
        assert.equal((await attempt(env.ADMIN_PASSWORD!)).status, 429, "still locked out for the window, even with the right password");
      } finally {
        env.ADMIN_EMAIL = saved.e;
        env.ADMIN_PASSWORD = saved.p;
        if (saved.e === undefined) delete env.ADMIN_EMAIL;
        if (saved.p === undefined) delete env.ADMIN_PASSWORD;
      }
    });

    await test("login with non-string credentials is a clean 400, never a server error", async () => {
      const loginRoute = await import("../../src/app/api/auth/login/route");
      const bodies = [
        { email: { $ne: null }, password: "x" }, { email: ["a@b.c"], password: "x" }, { email: 5, password: "x" },
        { email: "a@test.invalid", password: { $gt: "" } }, { email: "a@test.invalid", password: ["x"] },
      ];
      const got: string[] = [];
      for (const b of bodies) {
        const r = await call(loginRoute, "POST", "/api/auth/login", b, undefined, "");
        if (r.status !== 400) got.push(`${JSON.stringify(b)} → ${r.status}`);
      }
      assert.deepEqual(got, [], got.join("; "));
    });

    await test("expense edit cannot move an expense to another branch via update operators", async () => {
      const expensesRoute = await import("../../src/app/api/expenses/route");
      const expenseRoute = await import("../../src/app/api/expenses/[id]/route");
      const { Expense } = await import("../../src/lib/models");
      const branchA = String(new mongoose.Types.ObjectId());
      const branchB = String(new mongoose.Types.ObjectId());
      const acct = cookieFor("accountant", branchA);
      const created = await call(expensesRoute, "POST", "/api/expenses", { category: "Rent", amount: 100, detail: "IT" }, undefined, acct);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const eid = String(created.body.id);
      const moved: string[] = [];
      for (const body of [{ $set: { branchId: branchB } }, { $unset: { branchId: 1 } }, { branchId: branchB }]) {
        await call(expenseRoute, "PUT", `/api/expenses/${eid}`, body, { id: eid }, acct);
        const e = await Expense.findById(eid).lean<any>();
        if (String(e.branchId ?? "") !== branchA) moved.push(`${JSON.stringify(body)} → branch ${e.branchId ?? "none"}`);
        await Expense.updateOne({ _id: eid }, { $set: { branchId: new mongoose.Types.ObjectId(branchA) } });
      }
      assert.deepEqual(moved, [], moved.join("; "));
      const ok = await call(expenseRoute, "PUT", `/api/expenses/${eid}`, { amount: 120, detail: "IT edited" }, { id: eid }, acct);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((await Expense.findById(eid).lean<any>()).amount, 120, "ordinary edits still work");
    });

    await test("supplier edit refuses update operators; ordinary edits still work", async () => {
      const supplierRoute = await import("../../src/app/api/suppliers/[id]/route");
      const sid = String(supplier._id);
      const bad = await call(supplierRoute, "PUT", `/api/suppliers/${sid}`, { $set: { avgLeadDays: 999 } }, { id: sid });
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
      assert.notEqual((await Supplier.findById(sid).lean<any>()).avgLeadDays, 999);
      const ok = await call(supplierRoute, "PUT", `/api/suppliers/${sid}`, { phone: "90000001" }, { id: sid });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((await Supplier.findById(sid).lean<any>()).phone, "90000001");
    });
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
