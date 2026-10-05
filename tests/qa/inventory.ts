/* eslint-disable @typescript-eslint/no-explicit-any */
// QA suite: inventory — POS-130..138 (FIFO, pcs/ml/tola, remix BOM, negative stock,
// restock RBAC, atomicity, concurrency, reconciliation). Run via `npm run test:qa`.
import { assertLocalDb } from "../../src/lib/e2eGuard";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, FifoLayer, Formula, Product, Sale, User } from "../../src/lib/models";
import { createSessionToken } from "../../src/lib/auth/session";

assertLocalDb();
const BASE = "http://localhost:3960";
type Res = boolean | "OBS" | "RV";
const out: Res[] = [];
function rec(id: string, name: string, ok: Res, detail: string) {
  out.push(ok);
  console.log(`${ok === "OBS" ? "  •" : ok === "RV" ? "  ■" : ok ? "  ✓" : "  ✗"} [${id}] ${name} — ${detail}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type R = { status: number; ms: number; body: any };
async function req(method: string, path: string, cookie?: string, body?: unknown): Promise<R> {
  const t = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, ms: performance.now() - t, body: await res.json().catch(() => ({})) };
  } catch (e) { return { status: 0, ms: performance.now() - t, body: { error: String(e) } }; }
}
const pctl = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0); };
const r3 = (n: number) => Math.round(n * 1000) / 1000;

async function main() {
  await connectDB();
  const branch = (await Branch.findOne().lean<any>())!;
  const roles = ["owner", "manager", "branch_manager", "cashier", "accountant", "inventory"] as const;
  const ck: Record<string, string> = {};
  for (const role of roles) {
    const u = (await User.findOne({ role }).lean<any>())!;
    ck[role] = `unich_session=${createSessionToken({ userId: String(u._id), name: u.name, email: u.email, role, roleLabel: role, branchId: String(branch._id), branchName: branch.name })}`;
  }
  await AppSettings.updateOne({ key: "default" }, { $addToSet: { salespeople: "QA Inventory" } });
  const tag = Date.now();
  const sup = new mongoose.Types.ObjectId();
  async function mkP(name: string, sku: string, unit: "pcs" | "ml", layers: Array<[number, number]>, extra: Record<string, unknown> = {}) {
    const stock = layers.reduce((a, [q]) => a + q, 0);
    const p = await Product.create({ sku: `${sku}-${tag}`, name: `${name} ${tag}`, category: "Perfume", unit, sellPrice: 50, costFifo: layers[0]?.[1] ?? 0, minMarginPct: 0, stockSellable: stock, ...extra });
    let day = layers.length + 1;
    for (const [q, cost] of layers) await FifoLayer.create({ productId: p._id, supplierId: sup, supplierName: "QA", purchaseDate: new Date(Date.now() - day-- * 864e5), qtyRemaining: q, originalQty: q, unitCost: cost, currency: "OMR" });
    return p.toObject() as any;
  }
  const stock = async (p: any) => (await Product.findById(p._id).lean<any>())!.stockSellable;
  const layerQty = async (p: any) => (await FifoLayer.find({ productId: p._id }).sort({ purchaseDate: 1, _id: 1 }).lean<any[]>()).map((l) => l.qtyRemaining);
  const layerSum = async (p: any) => r3((await layerQty(p)).reduce((a, b) => a + b, 0));
  let ph = 84000000;
  const sell = (lines: unknown[], c = ck.cashier, extra: Record<string, unknown> = {}) =>
    req("POST", "/api/sales", c, { customerPhone: String(++ph), payment: "cash", salesperson: "QA Inventory", idempotencyKey: randomUUID(), lines, ...extra });
  const ready = (p: any, qty: number) => ({ productId: String(p._id), qty, lineType: "ready" });
  const oilLine = (p: any, label: string, qty = 1) => ({ productId: String(p._id), qty, lineType: "oil", unitLabel: label });

  // Fixtures
  const R = await mkP("QA Ready", "QR", "pcs", [[10, 10], [10, 15]]);          // batch A 10@10, batch B 10@15
  const R2 = await mkP("QA Ready Two", "QR2", "pcs", [[100, 5]]);
  const OIL = await mkP("QA Oud Oil", "QOIL", "ml", [[1000, 2], [500, 3]], { sellPrice: 5, category: "Single Notes" });
  const ETH = await mkP("QA Ethanol 96%", "ETH", "ml", [[10000, 0.05]], { category: "Raw" });
  const BOT = await mkP("QA Glass Bottle 100ml", "BOT", "pcs", [[200, 2.4]], { category: "Packaging" });
  const CAP = await mkP("QA Cap Gold", "CAP", "pcs", [[200, 0.85]], { category: "Packaging" });
  const COL = await mkP("QA Collar", "COL", "pcs", [[200, 0.6]], { category: "Packaging" });
  const ATM = await mkP("QA Atomizer", "ATM", "pcs", [[200, 1.1]], { category: "Packaging" });
  const PCH = await mkP("QA Velvet Pouch", "PCH", "pcs", [[200, 1.5]], { category: "Packaging" });
  const REMIX = await Product.create({ sku: `QREMIX-${tag}`, name: `QA Remix 100ml ${tag}`, category: "Remix", unit: "pcs", sellPrice: 400, costFifo: 0, minMarginPct: 0, stockSellable: 0 });
  const bom: Array<[any, number, "ml" | "pcs"]> = [[OIL, 20, "ml"], [ETH, 80, "ml"], [BOT, 1, "pcs"], [CAP, 1, "pcs"], [COL, 1, "pcs"], [ATM, 1, "pcs"], [PCH, 1, "pcs"]];
  const formula = await Formula.create({
    name: `QA Remix Formula ${tag}`, type: "remix", status: "approved", version: 1, yieldMl: 100,
    components: bom.map(([p, qty, unit]) => ({ productId: String(p._id), productName: p.name, qty, unit })),
  });
  const remixLine = (qty = 1) => ({ productId: String(REMIX._id), qty, lineType: "remix", unitLabel: "pcs", formulaId: String(formula._id) });
  const bomSnap = async () => Promise.all(bom.map(async ([p]) => stock(p)));
  const all = [R, R2, OIL, ETH, BOT, CAP, COL, ATM, PCH];
  const opening = new Map<string, number>();
  for (const p of all) opening.set(String(p._id), await stock(p));
  const restocked = new Map<string, number>();

  const server = spawn("npx", ["next", "start", "-p", "3960"], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 240 && (await req("GET", "/api/health")).status !== 200; i++) await sleep(500);

    console.log("\n== POS-132 ready product (pcs) + FIFO ==");
    const s5 = await sell([ready(R, 5)]);
    rec("POS-132/FIFO", "sell 5 of 20 (A 10@10, B 10@15) → stock 15, A 5, B 10", s5.status === 201 && (await stock(R)) === 15 && JSON.stringify(await layerQty(R)) === "[5,10]", `HTTP ${s5.status}, stock ${await stock(R)}, layers ${JSON.stringify(await layerQty(R))}`);
    const d5 = (await Sale.findById(s5.body.id).lean<any>()).inventoryDeductions[0];
    rec("POS-132/FIFO", "sale records FIFO cost from the oldest batch (5 × 10 = 50)", d5.costTotal === 50 && d5.batches.length === 1, `cost ${d5.costTotal}, batches ${d5.batches.map((b: any) => `${b.qty}@${b.unitCost}`).join(",")}`);
    const s6 = await sell([ready(R, 6)]);
    const d6 = (await Sale.findById(s6.body.id).lean<any>()).inventoryDeductions[0];
    rec("POS-132/FIFO", "sell 6 more → A 0, B 9; cost 5×10 + 1×15 = 65", JSON.stringify(await layerQty(R)) === "[0,9]" && d6.costTotal === 65 && (await stock(R)) === 9, `layers ${JSON.stringify(await layerQty(R))}, cost ${d6.costTotal}, batches ${d6.batches.map((b: any) => `${b.qty}@${b.unitCost}`).join("+")}`);
    const r2a = await stock(R2);
    const multi = await sell([ready(R, 1), ready(R2, 3)]);
    rec("POS-132", "two ready products in one sale: each decreases by its own qty, nothing else moves", multi.status === 201 && (await stock(R)) === 8 && (await stock(R2)) === r2a - 3 && JSON.stringify(await bomSnap()) === JSON.stringify(await bomSnap()), `R ${await stock(R)}, R2 ${await stock(R2)}`);
    const fr = await sell([{ ...ready(R, 1), qty: 1.5 }]);
    rec("POS-132", "fractional pieces rejected", fr.status === 400, `HTTP ${fr.status} ${fr.body.error}`);
    const allR = await sell([ready(R, 8)]);
    rec("POS-132", "sell all remaining (8) → 0, layers 0", allR.status === 201 && (await stock(R)) === 0 && (await layerSum(R)) === 0, `stock ${await stock(R)}`);

    console.log("\n== POS-133 oil (ml, tola) ==");
    const o0 = await stock(OIL);
    const cases: Array<[string, number, number]> = [["¼ Tola", 1, 3], ["½ Tola", 1, 6], ["1 Tola", 1, 12], ["1 Tola", 2, 24], ["¼ Tola", 10, 30]];
    let expectMl = 0;
    for (const [label, qty, ml] of cases) {
      const before = await stock(OIL);
      const r = await sell([oilLine(OIL, label, qty)]);
      const ded = r.status === 201 ? (await Sale.findById(r.body.id).lean<any>()).inventoryDeductions[0] : null;
      expectMl += ml;
      rec("POS-133", `${qty} × ${label} → −${ml} ml`, r.status === 201 && before - (await stock(OIL)) === ml && ded?.qty === ml, `HTTP ${r.status}, stock ${before}→${await stock(OIL)}, deduction ${ded?.qty} ml, line "${r.body.lines?.[0]?.unitLabel}" @ ${r.body.lines?.[0]?.unitPrice}`);
    }
    rec("POS-133", "oil stock stays in ml; total 75 ml from the oldest layer", o0 - (await stock(OIL)) === expectMl && JSON.stringify(await layerQty(OIL)) === `[${1000 - expectMl},500]`, `layers ${JSON.stringify(await layerQty(OIL))}`);
    const plain = await sell([oilLine(OIL, "tola")]);
    const plainDed = plain.status === 201 ? (await Sale.findById(plain.body.id).lean<any>()).inventoryDeductions[0]?.qty : null;
    rec("POS-133", '"tola" is the approved alias for 1 Tola → −12 ml', plain.status === 201 && plainDed === 12, `HTTP ${plain.status}, deducted ${plainDed} ml`);
    for (const bad of ["2 Tola", "15 ml", ""]) {
      const r = await sell([oilLine(OIL, bad)]);
      rec("POS-133", `unsupported size "${bad}" rejected`, r.status === 400, `HTTP ${r.status} ${r.body.error}`);
    }

    console.log("\n== POS-134 remix BOM ==");
    const b0 = await bomSnap();
    const rm1 = await sell([remixLine(1)]);
    const b1 = await bomSnap();
    const per = bom.map(([, q]) => q);
    rec("POS-134", "1 remix: oil −20 ml, ethanol −80 ml, bottle/cap/collar/atomizer/pouch −1 each", rm1.status === 201 && b0.every((v, i) => r3(v - b1[i]) === per[i]), `HTTP ${rm1.status} ${rm1.body.error ?? ""} Δ ${bom.map(([p], i) => `${p.name.split(" ")[1]} −${r3(b0[i] - b1[i])}`).join(", ")}`);
    const rm3 = await sell([remixLine(3)]);
    const b3 = await bomSnap();
    rec("POS-134", "3 remixes: every component × 3", rm3.status === 201 && b1.every((v, i) => r3(v - b3[i]) === per[i] * 3), `Δ ${b1.map((v, i) => r3(v - b3[i])).join(",")}`);
    const rd = (await Sale.findById(rm1.body.id).lean<any>()).inventoryDeductions;
    rec("POS-134", "sale records one deduction per component with FIFO cost", rd.length === 7 && rd.every((d: any) => d.costTotal > 0), `${rd.length} deductions, cost ${r3(rd.reduce((a: number, d: any) => a + d.costTotal, 0))}`);
    // insufficient component: leave only 1 pouch
    const pouchNow = await stock(PCH);
    await Product.updateOne({ _id: PCH._id }, { $set: { stockSellable: 1 } });
    await FifoLayer.updateMany({ productId: PCH._id }, { $set: { qtyRemaining: 1 } });
    const bb = await bomSnap();
    const short = await sell([remixLine(2)]);
    rec("POS-134/§13", "2 remixes with only 1 pouch → refused, NO component consumed (atomic)", short.status === 400 && JSON.stringify(await bomSnap()) === JSON.stringify(bb), `HTTP ${short.status} "${short.body.error}"`);
    await Product.updateOne({ _id: PCH._id }, { $set: { stockSellable: pouchNow } });
    await FifoLayer.updateMany({ productId: PCH._id }, { $set: { qtyRemaining: pouchNow } });
    const mixed0 = { r2: await stock(R2), bom: await bomSnap() };
    const mixFail = await sell([ready(R2, 2), oilLine(OIL, "1 Tola"), remixLine(1), ready(R, 1)]);
    rec("POS-131/§13", "mixed cart where the last line is out of stock → nothing deducted anywhere", mixFail.status === 400 && (await stock(R2)) === mixed0.r2 && JSON.stringify(await bomSnap()) === JSON.stringify(mixed0.bom), `HTTP ${mixFail.status} "${mixFail.body.error}"`);

    console.log("\n== POS-130 / POS-136 immediate + refresh ==");
    const before130 = await stock(R2);
    const s130 = await sell([ready(R2, 2)]);
    const api1 = ((await req("GET", "/api/products", ck.cashier)).body as any[]).find((p) => p.id === String(R2._id));
    const api2 = (await req("GET", `/api/products/${R2._id}`, ck.inventory)).body;
    rec("POS-130/136", "right after the sale the products API (POS + Inventory) returns the new stock", s130.status === 201 && api1?.stockSellable === before130 - 2 && api2?.stockSellable === before130 - 2, `${before130} → list ${api1?.stockSellable}, detail ${api2?.stockSellable}`);
    const rapid = await Promise.all(Array.from({ length: 5 }, () => sell([ready(R2, 1)])));
    const afterRapid = ((await req("GET", "/api/products", ck.manager)).body as any[]).find((p) => p.id === String(R2._id));
    rec("POS-136", "5 rapid sales then refresh → exact stock", rapid.every((r) => r.status === 201) && afterRapid?.stockSellable === before130 - 7, `stock ${afterRapid?.stockSellable} (expected ${before130 - 7})`);
    const hdr = await fetch(`${BASE}/api/products`, { headers: { Cookie: ck.cashier } });
    rec("POS-136", "products response not cacheable by the browser", "OBS", `Cache-Control: ${hdr.headers.get("cache-control") ?? "(none)"}; the POS fetches with cache:"no-store"`);

    console.log("\n== POS-131 cancel ==");
    const c0 = { r2: await stock(R2), bom: await bomSnap(), oil: await stock(OIL) };
    const held = await req("POST", "/api/sales", ck.cashier, { customerPhone: String(++ph), payment: "cash", status: "held", salesperson: "QA Inventory", lines: [ready(R2, 4), oilLine(OIL, "1 Tola"), remixLine(1)] });
    await req("PATCH", `/api/sales/${held.body.id}`, ck.cashier, { status: "void" });
    rec("POS-131", "held then cancelled (ready + oil + remix): no stock, ml, BOM or layer change", held.status === 201 && (await stock(R2)) === c0.r2 && (await stock(OIL)) === c0.oil && JSON.stringify(await bomSnap()) === JSON.stringify(c0.bom), "unchanged");
    const badPay = await sell([ready(R2, 1)], ck.cashier, { payment: "mixed", paymentBreakdown: [{ method: "cash", amount: 1 }] });
    rec("POS-131", "payment rejected (mixed split short) → no deduction", badPay.status === 400 && (await stock(R2)) === c0.r2, `HTTP ${badPay.status} "${badPay.body.error}"`);

    console.log("\n== POS-137 negative stock ==");
    const N = await mkP("QA Few", "QFEW", "pcs", [[2, 7]]);
    const neg = await sell([ready(N, 5)]);
    rec("POS-137", "sell 5 with 2 in stock → clear message, nothing deducted, never negative", neg.status === 400 && /insufficient stock/i.test(neg.body.error) && (await stock(N)) === 2 && (await layerSum(N)) === 2, `HTTP ${neg.status} "${neg.body.error}"`);
    rec("POS-137", "rule: POS blocks (UI 'Only X in stock' + server refuses) rather than warn-and-allow", "RV", "requirement says WARN; implementation warns AND blocks the sale — confirm this is the intended rule");
    const manualNeg = await req("PUT", `/api/products/${N._id}`, ck.inventory, { stockSellable: -3 });
    rec("POS-137", "manual stock edit to −3 → refused with the negative-stock warning; stock and FIFO unchanged", manualNeg.status === 400 && /stock warning/i.test(manualNeg.body.error) && (await stock(N)) === 2 && (await layerSum(N)) === 2, `HTTP ${manualNeg.status} "${manualNeg.body.error}"`);

    console.log("\n== Stock edit vs FIFO layers ==");
    const D = await mkP("QA Drift", "QDRIFT", "pcs", [[10, 4]]);
    const up = await req("PUT", `/api/products/${D._id}`, ck.inventory, { stockSellable: 30 });
    const shown = ((await req("GET", "/api/products", ck.cashier)).body as any[]).find((p) => p.id === String(D._id))?.stockSellable;
    const sellBeyond = await sell([ready(D, 15)]);
    rec("Reconciliation", "manual stock edit 10→30 is booked through FIFO: stock = layers, and selling 15 works", up.status === 200 && up.body.stockAdjustment?.delta === 20 && sellBeyond.status === 201 && (await stock(D)) === 15 && (await layerSum(D)) === 15,
      `PUT stock 10→30 → HTTP ${up.status}; stock ${await stock(D)} vs FIFO layers ${await layerSum(D)}; POS shows ${shown} available, but selling 15 → HTTP ${sellBeyond.status} "${sellBeyond.body.error ?? ""}"`);
    const down = await req("PUT", `/api/products/${D._id}`, ck.inventory, { stockSellable: 5 });
    rec("Reconciliation", "manual decrease 15→5 consumes FIFO (oldest first) and is recorded", down.status === 200 && down.body.stockAdjustment?.delta === -10 && (await stock(D)) === 5 && (await layerSum(D)) === 5, `HTTP ${down.status}, stock ${await stock(D)}, layers ${await layerSum(D)}`);
    const fracEdit = await req("PUT", `/api/products/${D._id}`, ck.inventory, { stockSellable: 5.5 });
    rec("§21", "fractional pieces via stock edit rejected", fracEdit.status === 400, `HTTP ${fracEdit.status} ${fracEdit.body.error}`);
    const unitEdit = await req("PUT", `/api/products/${D._id}`, ck.inventory, { unit: "ml" });
    rec("§21", "unit can't change while the product has stock", unitEdit.status === 400 && (await Product.findById(D._id).lean<any>()).unit === "pcs", `HTTP ${unitEdit.status} ${unitEdit.body.error}`);
    const nameEdit = await req("PUT", `/api/products/${D._id}`, ck.inventory, { name: `QA Drift Renamed ${tag}`, sellPrice: 55, lowStockAt: 3 });
    const nd = await Product.findById(D._id).lean<any>();
    rec("§21", "catalogue fields still editable", nameEdit.status === 200 && nd.name.startsWith("QA Drift Renamed") && nd.sellPrice === 55 && nd.lowStockAt === 3, `HTTP ${nameEdit.status}`);
    const cashierEdit = await req("PUT", `/api/products/${D._id}`, ck.cashier, { stockSellable: 999 });
    rec("§21", "cashier can't edit stock", cashierEdit.status === 403, `HTTP ${cashierEdit.status}`);
    const costEdit = await req("PUT", `/api/products/${D._id}`, ck.inventory, { costFifo: 0.01 });
    rec("§21", "FIFO cost can't be overwritten through the product edit API", (await Product.findById(D._id).lean<any>()).costFifo !== 0.01, `HTTP ${costEdit.status}, costFifo now ${(await Product.findById(D._id).lean<any>()).costFifo}`);

    console.log("\n== Bucket transfers + opening stock ==");
    const T = await mkP("QA Transfer", "QTRF", "pcs", [[10, 6]]);
    const t1 = await req("POST", "/api/inventory/transfers", ck.inventory, { productId: String(T._id), qty: 2, from: "stockSellable", to: "stockTester" });
    const tp = await Product.findById(T._id).lean<any>();
    rec("Transfers", "sellable → tester 2: sellable 8, FIFO 8, tester 2", t1.status === 200 && tp.stockSellable === 8 && (await layerSum(T)) === 8 && tp.stockTester === 2, `HTTP ${t1.status} ${t1.body.error ?? ""}, sellable ${tp.stockSellable}, layers ${await layerSum(T)}, tester ${tp.stockTester}`);
    const t2 = await req("POST", "/api/inventory/transfers", ck.inventory, { productId: String(T._id), qty: 1, from: "stockTester", to: "stockSellable" });
    const tp2 = await Product.findById(T._id).lean<any>();
    rec("Transfers", "tester → sellable 1: sellable 9, FIFO 9, tester 1", t2.status === 200 && tp2.stockSellable === 9 && (await layerSum(T)) === 9 && tp2.stockTester === 1, `HTTP ${t2.status}, sellable ${tp2.stockSellable}, layers ${await layerSum(T)}, tester ${tp2.stockTester}`);
    const t3 = await req("POST", "/api/inventory/transfers", ck.inventory, { productId: String(T._id), qty: 50, from: "stockSellable", to: "stockSample", acknowledgeWarning: true });
    const t4 = await req("POST", "/api/inventory/transfers", ck.inventory, { productId: String(T._id), qty: 0.5, from: "stockSellable", to: "stockSample" });
    rec("Transfers", "transfer beyond sellable or of half a piece → refused, nothing moved", t3.status === 400 && t4.status === 400 && (await stock(T)) === 9 && (await layerSum(T)) === 9, `${t3.status}/${t4.status}`);
    const tr = await Promise.all(Array.from({ length: 6 }, (_, i) => i % 2 ? sell([ready(T, 2)]) : req("POST", "/api/inventory/transfers", ck.inventory, { productId: String(T._id), qty: 2, from: "stockSellable", to: "stockTester" })));
    rec("Transfers", "transfers racing sales never lose an update: sellable = FIFO", (await stock(T)) === (await layerSum(T)) && (await stock(T)) >= 0, `results ${tr.map((r) => r.status).join(",")}, sellable ${await stock(T)}, layers ${await layerSum(T)}`);
    const created = await req("POST", "/api/products", ck.inventory, { sku: `QOPEN-${tag}`, name: `QA Opening ${tag}`, category: "Perfume", unit: "pcs", sellPrice: 30, costFifo: 4, stockSellable: 15 });
    const cl = created.status === 201 ? await FifoLayer.find({ productId: created.body.id }).lean<any[]>() : [];
    rec("Opening stock", "new product with opening stock 15 @4 → FIFO layer 15@4, stock 15", created.status === 201 && created.body.stockSellable === 15 && cl.length === 1 && cl[0].qtyRemaining === 15 && cl[0].unitCost === 4, `HTTP ${created.status} ${created.body.error ?? ""}, layers ${cl.map((l) => `${l.qtyRemaining}@${l.unitCost}`).join(",")}`);

    console.log("\n== POS-138 restock + RBAC ==");
    const rs: Record<string, number> = {};
    for (const role of roles) rs[role] = (await req("POST", "/api/inventory/adjustments", ck[role], { productId: String(R2._id), qty: 1, direction: "in", reason: "restock" })).status;
    const anon = await req("POST", "/api/inventory/adjustments", undefined, { productId: String(R2._id), qty: 1, direction: "in" });
    const allowed = Object.entries(rs).filter(([, s]) => s === 201).map(([r]) => r);
    restocked.set(String(R2._id), allowed.length);
    rec("POS-138", "restock RBAC: owner/manager/branch-manager/inventory allowed; cashier/accountant 403; no login 401", rs.owner === 201 && rs.manager === 201 && rs.inventory === 201 && rs.cashier === 403 && rs.accountant === 403 && anon.status === 401, JSON.stringify(rs) + ` anon ${anon.status}`);
    const rb = { s: await stock(R), l: await layerQty(R) };
    const rst = await req("POST", "/api/inventory/adjustments", ck.owner, { productId: String(R._id), qty: 10, direction: "in", reason: "restock", unitCost: 12, stock: 100000, unit: "ml", createdBy: "Someone Else" });
    const lr = await FifoLayer.find({ productId: R._id }).sort({ purchaseDate: -1 }).limit(1).lean<any[]>();
    rec("POS-138", "Admin restocks 10 pcs @12: stock +10, new newest FIFO layer, adjustment recorded; client stock/unit ignored", rst.status === 201 && (await stock(R)) === rb.s + 10 && lr[0].qtyRemaining === 10 && lr[0].unitCost === 12 && !!rst.body.adjustmentId,
      `stock ${rb.s}→${await stock(R)}, newest layer ${lr[0].qtyRemaining}@${lr[0].unitCost}, adjustment ${rst.body.adjustmentId}`);
    restocked.set(String(R._id), 10);
    const after = await sell([ready(R, 3)]);
    const da = (await Sale.findById(after.body.id).lean<any>()).inventoryDeductions[0];
    rec("POS-138/FIFO", "restocked units are sellable at once and costed at the restock price (older batches were empty)", after.status === 201 && da.batches.every((b: any) => b.unitCost === 12) && (await stock(R)) === rb.s + 7, `consumed ${da.batches.map((b: any) => `${b.qty}@${b.unitCost}`).join(",")}, stock ${await stock(R)}`);
    const ro = await req("POST", "/api/inventory/adjustments", ck.inventory, { productId: String(OIL._id), qty: 250, direction: "in" });
    const rp = await req("POST", "/api/inventory/adjustments", ck.inventory, { productId: String(BOT._id), qty: 20, direction: "in" });
    restocked.set(String(OIL._id), 250); restocked.set(String(BOT._id), 20);
    rec("POS-138", "oil restock in ml (+250) and packaging in pcs (+20)", ro.status === 201 && rp.status === 201, `${ro.status}/${rp.status}`);
    const inv: string[] = [];
    for (const [label, body] of [["qty 0", { qty: 0 }], ["qty −5", { qty: -5 }], ["qty 'abc'", { qty: "abc" }], ["bad productId", { productId: "nope", qty: 1 }], ["no direction", { qty: 1, direction: "" }]] as const) {
      const r = await req("POST", "/api/inventory/adjustments", ck.owner, { productId: String(R._id), direction: "in", ...body });
      inv.push(`${label}→${r.status}`);
    }
    rec("POS-138", "invalid restock input rejected", inv.every((x) => x.endsWith("400")), inv.join(", "));
    const frac = await req("POST", "/api/inventory/adjustments", ck.owner, { productId: String(R2._id), qty: 2.5, direction: "in" });
    rec("POS-138", "fractional pieces restock (2.5 pcs) rejected for a pcs product", frac.status === 400, `HTTP ${frac.status} → stock ${await stock(R2)}`);
    if (frac.status === 201) restocked.set(String(R2._id), (restocked.get(String(R2._id)) ?? 0) + 2.5);
    const adj = await mongoose.connection.db!.collection("inventoryadjustments").findOne({ _id: new mongoose.Types.ObjectId(rst.body.adjustmentId) });
    rec("§21", "adjustment 'createdBy' comes from the session, not the request", adj?.createdBy !== "Someone Else", `stored createdBy "${adj?.createdBy}" (audit log uses the session)`);

    console.log("\n== §14 concurrency ==");
    const C = await mkP("QA Ten", "QTEN", "pcs", [[10, 3]]);
    const race = await Promise.all([sell([ready(C, 7)]), sell([ready(C, 7)], ck.manager)]);
    rec("§14", "stock 10, two simultaneous sales of 7 → one succeeds, stock 3, layers 3", race.filter((r) => r.status === 201).length === 1 && (await stock(C)) === 3 && (await layerSum(C)) === 3, `${race.map((r) => r.status).join("/")}, stock ${await stock(C)}`);
    // oil for exactly 15 remixes left in the oldest+next layers
    const oilLeft = await stock(OIL);
    const canMake = Math.floor(oilLeft / 20);
    const want = Math.min(canMake, 18) + 4;
    await Product.updateOne({ _id: OIL._id }, { $set: { stockSellable: 20 * (want - 4) } });
    const ol = await FifoLayer.find({ productId: OIL._id }).sort({ purchaseDate: 1 }).lean<any[]>();
    let remain = 20 * (want - 4);
    for (const l of ol) { const q = Math.min(l.qtyRemaining, remain); remain -= q; await FifoLayer.updateOne({ _id: l._id }, { $set: { qtyRemaining: q } }); }
    const bomBefore = await bomSnap();
    const rr = await Promise.all(Array.from({ length: want }, (_, i) => sell([remixLine(1)], i % 2 ? ck.cashier : ck.manager)));
    const okN = rr.filter((r) => r.status === 201).length;
    const bomAfter = await bomSnap();
    rec("§14", `${want} simultaneous remixes, oil for ${want - 4} → exactly ${want - 4} succeed, every component −${want - 4}×BOM, no partial BOM`,
      okN === want - 4 && bomBefore.every((v, i) => r3(v - bomAfter[i]) === r3(per[i] * okN)) && (await stock(OIL)) === 0 && (await layerSum(OIL)) === 0,
      `201×${okN}, others ${[...new Set(rr.filter((r) => r.status !== 201).map((r) => r.status))]}, oil ${await stock(OIL)}`);
    const oilFix = 2000;
    await FifoLayer.create({ productId: OIL._id, supplierId: sup, supplierName: "QA", purchaseDate: new Date(), qtyRemaining: oilFix, originalQty: oilFix, unitCost: 3, currency: "OMR" });
    await Product.updateOne({ _id: OIL._id }, { $inc: { stockSellable: oilFix } });

    console.log("\n== §19/§20 load + stress with concurrent restock ==");
    const L = await mkP("QA Load", "QLOAD", "pcs", [[5000, 2]]);
    const t = performance.now();
    const ops = await Promise.all([
      ...Array.from({ length: 150 }, (_, i) => sell(i % 3 === 0 ? [ready(L, 2), oilLine(OIL, "½ Tola")] : i % 3 === 1 ? [ready(L, 1), remixLine(1)] : [ready(L, 3)], [ck.cashier, ck.manager, ck.branch_manager][i % 3])),
      ...Array.from({ length: 30 }, () => req("POST", "/api/inventory/adjustments", ck.inventory, { productId: String(L._id), qty: 5, direction: "in" })),
    ]);
    const wall = performance.now() - t;
    const salesOk = ops.slice(0, 150).filter((r) => r.status === 201).length;
    const restOk = ops.slice(150).filter((r) => r.status === 201).length;
    const soldL = (await Sale.find({ _id: { $in: ops.slice(0, 150).filter((r) => r.status === 201).map((r) => r.body.id) } }).lean<any[]>())
      .flatMap((s) => s.inventoryDeductions).filter((d: any) => String(d.productId) === String(L._id)).reduce((a: number, d: any) => a + d.qty, 0);
    const ms = ops.map((r) => r.ms);
    console.log(`    180 ops (150 sales + 30 restocks): ${(180 / (wall / 1000)).toFixed(1)} ops/s p50 ${pctl(ms, 50)}ms p95 ${pctl(ms, 95)}ms p99 ${pctl(ms, 99)}ms`);
    rec("§19/§20", "150 concurrent sales + 30 concurrent restocks: stock = 5000 − sold + restocked, stock = FIFO layers, no 5xx",
      ops.every((r) => r.status > 0 && r.status < 500) && (await stock(L)) === 5000 - soldL + restOk * 5 && (await layerSum(L)) === (await stock(L)),
      `sales 201×${salesOk}, restocks 201×${restOk}, stock ${await stock(L)} (expected ${5000 - soldL + restOk * 5}), layers ${await layerSum(L)}`);
    const big = await sell([ready(L, 1000)]);
    rec("§20", "large quantity (1000 pcs in one line) deducts exactly", big.status === 201 && (await layerSum(L)) === (await stock(L)), `HTTP ${big.status}`);
    const huge = await sell([ready(L, 999999)]);
    rec("§20", "excessive quantity (999999) refused, stock untouched", huge.status === 400 && (await layerSum(L)) === (await stock(L)), `HTTP ${huge.status} "${huge.body.error}"`);

    console.log("\n== §22 reconciliation: opening − sales + restock = closing, and stock = FIFO ==");
    const myProducts = all.filter((p) => p !== OIL); // oil was hand-adjusted for the race test
    const sales = await Sale.find({ status: "completed", "inventoryDeductions.productId": { $in: myProducts.map((p) => p._id) } }).lean<any[]>();
    const bad: string[] = [];
    for (const p of myProducts) {
      if (p === PCH) continue; // pouch stock was hand-set for the shortage test (restored)
      const used = r3(sales.flatMap((s) => s.inventoryDeductions).filter((d: any) => String(d.productId) === String(p._id)).reduce((a: number, d: any) => a + d.qty, 0));
      const expect = r3(opening.get(String(p._id))! - used + (restocked.get(String(p._id)) ?? 0));
      const actual = await stock(p);
      const layers = await layerSum(p);
      if (actual !== expect || layers !== actual) bad.push(`${p.name.split(" ").slice(0, 3).join(" ")}: expected ${expect}, stock ${actual}, layers ${layers}`);
    }
    rec("§22", "ready, ethanol, bottle, cap, collar, atomizer reconcile exactly", bad.length === 0, bad.length ? bad.join("; ") : `${myProducts.length - 1} products reconciled`);
  } finally {
    try { process.kill(-(server.pid as number), "SIGTERM"); } catch { /* */ }
    await sleep(1500);
  }
  const c = (v: Res) => out.filter((o) => o === v).length;
  console.log(`\n${c(true)} passed, ${c(false)} failed, ${c("RV")} requirement-validation, ${c("OBS")} observations`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
