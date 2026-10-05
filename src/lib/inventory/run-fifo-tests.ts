/**
 * FIFO costing tests against a real (local, throwaway) MongoDB replica set
 * (npm run test:e2e:fifo). FIFO allocation lives inside DB-backed functions,
 * so these exercise the real code paths: planFifoDeductions/applyFifoPlan
 * (POS checkout) and deductFifoMany (quotation convert, adjustments, production).
 *
 * Safety: refuses to run unless DATABASE_URL is localhost (see e2eGuard).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../db";
import { assertLocalDb } from "../e2eGuard";
import { AppSettings, FifoLayer, Product } from "../models";
import { addFifoLayer, applyFifoPlan, deductFifoMany, planFifoDeductions } from "../inventory";
import { createSale } from "../sales/createSale";
import { SaleError } from "../sales/errors";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
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

const RUN = `FIFOT-${Date.now()}`;
const supplierId = String(new mongoose.Types.ObjectId());
const created: string[] = [];
let n = 0;

async function product(layers: Array<[qty: number, cost: number, date: string]>, unit = "pcs") {
  const p = await Product.create({
    sku: `${RUN}-${++n}`,
    name: `${RUN} ${n}`,
    category: unit === "ml" ? "Oil" : "Perfume",
    unit,
    sellPrice: 20,
    stockSellable: 0,
  });
  const id = String(p._id);
  created.push(id);
  for (const [qty, unitCost, date] of layers) {
    await addFifoLayer({ productId: id, supplierId, supplierName: "T", purchaseDate: new Date(date), qty, unitCost, currency: "OMR" });
  }
  return id;
}
const layersOf = async (id: string) =>
  FifoLayer.find({ productId: id }).sort({ purchaseDate: 1, _id: 1 }).lean<{ qtyRemaining: number; unitCost: number; originalQty?: number; purchaseOrderId?: unknown }[]>();
const qtys = async (id: string) => (await layersOf(id)).map((l) => l.qtyRemaining);
const stock = async (id: string) => (await Product.findById(id).lean<{ stockSellable: number }>())!.stockSellable;

/** POS path: plan + apply in one transaction, as createSale does. */
async function posDeduct(id: string, qty: number) {
  const session = await mongoose.startSession();
  try {
    let result: { costTotal: number; batches: { qty: number; unitCost: number }[] } | undefined;
    await session.withTransaction(async () => {
      const plan = await planFifoDeductions([{ productId: id, qty }], session);
      await applyFifoPlan(plan, session);
      result = plan.results.get(id);
    });
    return result!;
  } finally {
    await session.endSession();
  }
}
const legacyDeduct = async (id: string, qty: number) => (await deductFifoMany([{ productId: id, qty }]))!.get(id)!;

const A = "2026-09-01";
const B = "2026-09-10";
const C = "2026-09-20";

async function main() {
  assertLocalDb();
  await connectDB();
  const hadSettings = await AppSettings.exists({ key: "default" });
  if (!hadSettings) await AppSettings.create({ key: "default", salespeople: ["FIFO Test"], activeSalesperson: "FIFO Test" });

  try {
    for (const [label, deduct] of [["POS path", posDeduct], ["deductFifoMany", legacyDeduct]] as const) {
      console.log(label);
      await test("sell 5 of A10@10,B10@15 → 5@10 = 50; A=5, B=10", async () => {
        const id = await product([[10, 10, A], [10, 15, B]]);
        const r = await deduct(id, 5);
        assert.deepEqual(r.batches.map((b) => [b.qty, b.unitCost]), [[5, 10]]);
        assert.equal(r.costTotal, 50);
        assert.deepEqual(await qtys(id), [5, 10]);
      });
      await test("25 across A10@10,B10@15,C10@20 → 10/10/5 = 350", async () => {
        const id = await product([[10, 10, A], [10, 15, B], [10, 20, C]]);
        const r = await deduct(id, 25);
        assert.deepEqual(r.batches.map((b) => [b.qty, b.unitCost]), [[10, 10], [10, 15], [5, 20]]);
        assert.equal(r.costTotal, 350);
        assert.deepEqual(await qtys(id), [0, 0, 5]);
      });
      await test("same purchase date: earlier-entered layer is consumed first", async () => {
        const id = await product([[10, 10, A], [10, 15, A]]);
        const r = await deduct(id, 12);
        assert.deepEqual(r.batches.map((b) => b.unitCost), [10, 15]);
        assert.equal(r.costTotal, 130);
      });
      await test("insufficient / zero stock → INSUFFICIENT_STOCK, nothing written", async () => {
        const id = await product([[10, 10, A], [10, 15, B]]);
        await assert.rejects(() => deduct(id, 21), (e: unknown) => e instanceof SaleError && e.code === "INSUFFICIENT_STOCK");
        assert.deepEqual(await qtys(id), [10, 10]);
        const zero = await product([]);
        await assert.rejects(() => deduct(zero, 1), (e: unknown) => e instanceof SaleError && e.code === "INSUFFICIENT_STOCK");
      });
      await test("decimals: 0.3 over 0.1 + 0.2 leaves exact zeros (no float dust)", async () => {
        const id = await product([[0.1, 10, A], [0.2, 15, B], [1, 20, C]], "ml");
        const r = await deduct(id, 0.3);
        assert.ok(Math.abs(r.costTotal - 4) < 1e-9);
        assert.deepEqual(await qtys(id), [0, 0, 1]);
      });
      await test("precision: 30 × 0.1 ml drains 3 ml exactly; stock = Σ layers = 0", async () => {
        const id = await product([[3, 10, A]], "ml");
        for (let i = 0; i < 30; i++) await deduct(id, 0.1);
        assert.deepEqual(await qtys(id), [0]);
        assert.equal(await stock(id), 0);
      });
      await test("concurrency: 4 × 6 vs 20 units → exactly 3 succeed, layers = stock, no phantom", async () => {
        for (let run = 0; run < 5; run++) {
          const id = await product([[10, 10, A], [10, 15, B]]);
          const rs = await Promise.allSettled(Array.from({ length: 4 }, () => deduct(id, 6)));
          const ok = rs.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ costTotal: number }>[];
          assert.equal(ok.length, 3, `run ${run}: ${ok.length} succeeded`);
          assert.deepEqual(await qtys(id), [0, 2]);
          assert.equal(await stock(id), 2);
          assert.equal(ok.reduce((s, r) => s + r.value.costTotal, 0), 220);
        }
      });
    }

    console.log("mixed + audit");
    await test("POS sales racing deductFifoMany: layers stay = stock (no phantom inventory)", async () => {
      for (let run = 0; run < 5; run++) {
        const id = await product([[10, 10, A], [10, 15, B]]);
        const sale = () => createSale({ customerPhone: "70000061", payment: "cash", lines: [{ productId: id, qty: 6, lineType: "ready" }], idempotencyKey: randomUUID() });
        const rs = await Promise.allSettled([sale(), legacyDeduct(id, 6), sale(), legacyDeduct(id, 6)]);
        const ok = rs.filter((r) => r.status === "fulfilled").length;
        const left = (await qtys(id)).reduce((a, b) => a + b, 0);
        assert.equal(ok, 3, `run ${run}: ${ok} succeeded`);
        assert.equal(left, 2);
        assert.equal(await stock(id), 2);
      }
    });
    await test("new layers record originalQty (and keep it after consumption)", async () => {
      const id = await product([[10, 10, A]]);
      await legacyDeduct(id, 4);
      const [l] = await layersOf(id);
      assert.equal(l.originalQty, 10);
      assert.equal(l.qtyRemaining, 6);
    });
  } finally {
    const ids = created.map((id) => new mongoose.Types.ObjectId(id));
    await FifoLayer.deleteMany({ productId: { $in: ids } });
    await Product.deleteMany({ _id: { $in: ids } });
    await mongoose.connection.db!.collection("sales").deleteMany({ customerPhone: "70000061" });
    await mongoose.connection.db!.collection("customers").deleteMany({ phone: "70000061" });
    if (!hadSettings) await AppSettings.deleteOne({ key: "default" });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
