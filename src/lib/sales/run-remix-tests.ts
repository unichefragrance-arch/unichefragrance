/**
 * Remix BOM unit tests (npm run test) — the REAL validateRemixSale, no DB:
 * every product it needs is pre-loaded in the productsById map.
 * Approved remix: 20 ml oil + 80 ml ethanol + bottle, cap, collar, atomizer, pouch.
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { validateRemixSale } from "./validateSale";
import { SaleError } from "./errors";

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

type P = { _id: string; name: string; sku: string; unit: string; category: string; sellPrice: number };
const mk = (sku: string, name: string, unit: string, category = "Packaging"): P => ({
  _id: String(new mongoose.Types.ObjectId()),
  name,
  sku,
  unit,
  category,
  sellPrice: 1,
});
const P_ = {
  eth: mk("ETH-96", "Ethanol 96%", "ml"),
  fix: mk("FIX-STD", "Fixative — Standard", "ml"),
  bot: mk("BOT-100", "Glass Bottle 100ml", "pcs"),
  cap: mk("CAP-STD", "Cap — Standard Gold", "pcs"),
  atm: mk("ATM-STD", "Atomizer — Standard", "pcs"),
  col: mk("COL-STD", "Collar — Standard", "pcs"),
  lbl: mk("LBL-STD", "Label — Standard", "pcs"),
  box: mk("BOX-STD", "Carton Box — Standard", "pcs"),
  pch: mk("PCH-STD", "Velvet Pouch", "pcs"),
  oil: mk("OIL-AMB", "Amber Oud Oil", "ml", "Oil"),
  gift: mk("GIFT-1", "Some Gift Set", "pcs", "Perfume"),
};
// validateRemixSale only reads name/sku/unit/category from these.
const products = () =>
  new Map(Object.values(P_).map((p) => [p._id, p])) as unknown as Parameters<
    typeof validateRemixSale
  >[1]["productsById"];
const comp = (p: P, qty: number) => ({ productId: p._id, productName: p.name, qty, unit: p.unit });
const OIL_BASE = { productId: "oil-base", productName: "Selected Oil Blend", qty: 20, unit: "ml" };
const APPROVED = [OIL_BASE, comp(P_.eth, 80), comp(P_.bot, 1), comp(P_.cap, 1), comp(P_.col, 1), comp(P_.atm, 1), comp(P_.pch, 1)];
// scripts/seed.ts default: approved + optional fixative / label / box
const SEEDED = [...APPROVED, comp(P_.fix, 2), comp(P_.lbl, 1), comp(P_.box, 1)];

const formula = (components: unknown[]) =>
  ({ name: "Remix Standard 100ml", type: "remix", status: "approved", components }) as unknown as Parameters<
    typeof validateRemixSale
  >[0];
const run = (components: unknown[], lineQty = 1, oilProductId: string | undefined = P_.oil._id) =>
  validateRemixSale(formula(components), { oilProductId, lineQty, lineIndex: 0, productsById: products() });
const totals = (ds: { productId: string; qty: number }[]) => {
  const m: Record<string, number> = {};
  for (const d of ds) m[d.productId] = (m[d.productId] ?? 0) + d.qty;
  return m;
};
async function rejects(fn: () => Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof SaleError, String(e));
    assert.equal(e.code, code, e.message);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

(async () => {
  console.log("remix BOM (validateRemixSale, local)");

  await test("approved BOM, 1 remix: oil 20, ethanol 80, bottle/cap/collar/atomizer/pouch 1", async () => {
    const r = await run(APPROVED);
    const d = totals(r.componentDeductions);
    assert.equal(r.oilMl, 20);
    assert.deepEqual(
      [d[P_.oil._id], d[P_.eth._id], d[P_.bot._id], d[P_.cap._id], d[P_.col._id], d[P_.atm._id], d[P_.pch._id]],
      [20, 80, 1, 1, 1, 1, 1],
    );
    assert.equal(Object.keys(d).length, 7, "nothing else consumed");
  });

  await test("approved BOM, 5 remixes: oil 100, ethanol 400, each part 5", async () => {
    const d = totals((await run(APPROVED, 5)).componentDeductions);
    assert.deepEqual(
      [d[P_.oil._id], d[P_.eth._id], d[P_.bot._id], d[P_.cap._id], d[P_.col._id], d[P_.atm._id], d[P_.pch._id]],
      [100, 400, 5, 5, 5, 5, 5],
    );
  });

  await test("optional fixative / label / box are consumed when the formula lists them", async () => {
    const d = totals((await run(SEEDED, 2)).componentDeductions);
    assert.deepEqual([d[P_.fix._id], d[P_.lbl._id], d[P_.box._id]], [4, 2, 2]);
    assert.equal(d[P_.pch._id], 2);
  });

  await test("each deduction is tagged with its role", async () => {
    const reasons = (await run(APPROVED)).componentDeductions.map((x) => x.reason).sort();
    assert.deepEqual(reasons, [
      "remix:atomizer", "remix:bottle", "remix:cap", "remix:collar", "remix:ethanol", "remix:oil", "remix:pouch",
    ]);
  });

  for (const [label, p] of [["ethanol", P_.eth], ["bottle", P_.bot], ["cap", P_.cap], ["collar", P_.col], ["atomizer", P_.atm], ["pouch", P_.pch]] as const) {
    await test(`missing ${label} → FORMULA_INCOMPLETE`, async () => {
      await rejects(() => run(APPROVED.filter((c) => c.productId !== p._id)), "FORMULA_INCOMPLETE", new RegExp(`${label} missing`, "i"));
    });
  }

  await test("no formula → FORMULA_MISSING", async () => {
    await rejects(
      () => validateRemixSale(null, { oilProductId: P_.oil._id, lineQty: 1, lineIndex: 0, productsById: products() }),
      "FORMULA_MISSING",
    );
  });

  await test("oil-base ≠ 20 ml → FORMULA_INCOMPLETE", async () => {
    await rejects(() => run([{ ...OIL_BASE, qty: 25 }, ...APPROVED.slice(1)]), "FORMULA_INCOMPLETE", /must be 20 ml/);
  });

  await test("component qty 0 / negative / bad id → FORMULA_INCOMPLETE", async () => {
    await rejects(() => run([OIL_BASE, comp(P_.eth, 0), ...APPROVED.slice(2)]), "FORMULA_INCOMPLETE", /invalid qty/);
    await rejects(() => run([OIL_BASE, comp(P_.eth, -80), ...APPROVED.slice(2)]), "FORMULA_INCOMPLETE", /invalid qty/);
    await rejects(() => run([...APPROVED, { productId: "bad", productName: "Bad", qty: 1, unit: "pcs" }]), "FORMULA_INCOMPLETE", /invalid product/);
  });

  await test("oil not selected → OIL_NOT_SELECTED", async () => {
    await rejects(
      () => validateRemixSale(formula(APPROVED), { oilProductId: undefined, lineQty: 1, lineIndex: 0, productsById: products() }),
      "OIL_NOT_SELECTED",
    );
  });

  await test("non-oil chosen as the remix oil → OIL_NOT_SELECTED (pcs item, ethanol, fixative)", async () => {
    await rejects(() => run(APPROVED, 1, P_.gift._id), "OIL_NOT_SELECTED", /sold by ml/);
    await rejects(() => run(APPROVED, 1, P_.eth._id), "OIL_NOT_SELECTED", /not an oil/);
    await rejects(() => run(APPROVED, 1, P_.fix._id), "OIL_NOT_SELECTED", /not an oil/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
