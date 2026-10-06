/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * POS-142b regression — checkout must not accept a client-chosen sale status.
 * Only no status / "completed" / "held" are valid on POST /api/sales; anything
 * else is rejected with 400 and must leave sales, stock, FIFO layers, recipe
 * components and customer balances untouched. LOCAL throwaway DB only.
 *
 *   DATABASE_URL='mongodb://127.0.0.1:27099/...' npx tsx tests/qa/pos-142b-status.ts
 */
import { assertLocalDb } from "../../src/lib/e2eGuard";
assertLocalDb();
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, Customer, FifoLayer, Formula, Product, Sale } from "../../src/lib/models";
import { testSessionCookie } from "../../src/lib/auth/testSession";

const PORT = Number(process.env.QA_PORT || 3991);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const rec = (n: string, ok: boolean, d: string) => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗"} ${n} — ${d}`); };
async function post(cookie: string, body: unknown, raw?: string) {
  const r = await fetch(`${BASE}/api/sales`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: raw ?? JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
let n = 0;
const tag = Date.now() % 100000;
const phone = () => `+968 5${String(tag).padStart(5, "0")}${String(++n).padStart(3, "0")}`;
async function fixture(qty: number, o: { unit?: string; category?: string; name?: string } = {}) {
  const p = await Product.create({ sku: `QA142B-${randomUUID().slice(0, 8)}`, name: o.name ?? `QA 142b ${randomUUID().slice(0, 4)}`, category: o.category ?? "Perfume", unit: o.unit ?? "pcs", sellPrice: 10, costFifo: 1, minMarginPct: 0, stockSellable: qty });
  await FifoLayer.create({ productId: p._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 864e5), qtyRemaining: qty, originalQty: qty, unitCost: 1, currency: "OMR", source: "purchase" });
  return String(p._id);
}
const state = async (ids: string[]) => Promise.all(ids.map(async (id) => {
  const p = await Product.findById(id).lean<any>();
  const l = await FifoLayer.find({ productId: id }).lean<any[]>();
  return `${p.stockSellable}/${l.map((x) => x.qtyRemaining).join("+")}`;
}));

(async () => {
  await connectDB();
  const srv = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 240; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ } await sleep(500); }
    const branch = (await Branch.findOne({ code: "MAIN" }).lean<any>())!;
    const SP = (await AppSettings.findOne({ key: "default" }).lean<any>()).activeSalesperson;
    const ck = await testSessionCookie({ userId: String(new mongoose.Types.ObjectId()), name: "QA 142b", email: "qa-142b@test.local", role: "cashier", roleLabel: "Cashier", branchId: String(branch._id), branchName: branch.name });
    const sale = (ph: string, id: string, extra: Record<string, unknown>) => ({ customerPhone: ph, payment: "credit", salesperson: SP, lines: [{ productId: id, qty: 2, lineType: "ready" }], ...extra });

    // Allowed
    for (const [label, extra, want, stockDelta] of [["no status", {}, "completed", 2], ["completed", { status: "completed" }, "completed", 2], ["held", { status: "held" }, "held", 0]] as const) {
      const id = await fixture(10), ph = phone();
      const r = await post(ck, sale(ph, id, extra));
      const s = await Sale.findOne({ customerPhone: ph }).lean<any>();
      const left = (await Product.findById(id).lean<any>()).stockSellable;
      rec(`allowed: ${label}`, r.status === 201 && s?.status === want && 10 - left === stockDelta, `HTTP ${r.status}, stored "${s?.status}", stock −${10 - left}`);
    }

    // Rejected — nothing may change
    const bad: [string, unknown][] = [["void", "void"], ["VOID", "VOID"], ["cancelled", "cancelled"], ["refunded-hack", "refunded-hack"], ['""', ""], ["null", null], ["5", 5], ["true", true], ["{}", {}], ['{"$ne":null}', { $ne: null }], ['["void"]', ["void"]], ["' completed'", " completed"], ["Completed", "Completed"]];
    for (const [label, status] of bad) {
      const id = await fixture(10), ph = phone();
      const before = await state([id]);
      const r = await post(ck, sale(ph, id, { status }));
      const sales = await Sale.countDocuments({ customerPhone: ph });
      const cust = await Customer.findOne({ phone: ph }).lean<any>();
      const after = await state([id]);
      rec(`rejected: status ${label}`, r.status === 400 && r.body.code === "VALIDATION" && sales === 0 && !cust && before[0] === after[0],
        `HTTP ${r.status} ${r.body.code ?? ""}; sales ${sales}; customer ${cust ? `+${cust.totalPurchases} credit +${cust.creditBalance}` : "untouched"}; stock/FIFO ${before[0]} → ${after[0]}`);
    }

    // Remix with status void — recipe components untouched
    {
      const remix = await Product.findOne({ sku: "RM-STD" }).lean<any>();
      const formula = await Formula.findOne({ type: "remix", status: "approved", customerId: null }).sort({ updatedAt: -1 }).lean<any>();
      const compIds = formula.components.filter((c: any) => mongoose.isValidObjectId(c.productId)).map((c: any) => String(c.productId));
      const oil = await fixture(100, { unit: "ml", category: "Single Notes", name: `QA142b Oil ${tag}` });
      const ids = [oil, ...compIds];
      const before = await state(ids);
      const ph = phone();
      const r = await post(ck, { customerPhone: ph, payment: "cash", salesperson: SP, status: "void", lines: [{ productId: String(remix._id), qty: 1, lineType: "remix", oilProductId: oil }] });
      const after = await state(ids);
      rec("rejected: remix sale with status void", r.status === 400 && (await Sale.countDocuments({ customerPhone: ph })) === 0 && JSON.stringify(before) === JSON.stringify(after), `HTTP ${r.status}; ${ids.length} products (oil + recipe) unchanged: ${JSON.stringify(before) === JSON.stringify(after)}`);
    }

    // Concurrent void attempts on the last units
    {
      const id = await fixture(3), ph = phone();
      const rs = await Promise.all(Array.from({ length: 6 }, () => post(ck, { ...sale(ph, id, { status: "void", idempotencyKey: randomUUID() }), lines: [{ productId: id, qty: 1, lineType: "ready" }] })));
      const after = await state([id]);
      rec("rejected: 6 concurrent void checkouts on last 3 units", rs.every((r) => r.status === 400) && after[0] === "3/3" && (await Sale.countDocuments({ customerPhone: ph })) === 0, `${rs.map((r) => r.status)}; stock/FIFO ${after[0]}`);
    }

    // A rejected void must not "use up" the idempotency key — a normal retry still completes once.
    {
      const id = await fixture(5), ph = phone(), key = randomUUID();
      const r1 = await post(ck, sale(ph, id, { status: "void", idempotencyKey: key }));
      const r2 = await post(ck, sale(ph, id, { idempotencyKey: key }));
      const r3 = await post(ck, sale(ph, id, { idempotencyKey: key }));
      const sales = await Sale.find({ customerPhone: ph }).lean<any[]>();
      const after = await state([id]);
      rec("same key: rejected void, then normal checkout + retry", r1.status === 400 && r2.status === 201 && r3.status === 200 && sales.length === 1 && sales[0].status === "completed" && after[0] === "3/3", `${r1.status} → ${r2.status} → ${r3.status}; sales ${sales.length} "${sales[0]?.status}"; stock/FIFO ${after[0]}`);
    }

    // Legitimate void path is unaffected: hold → discard via PATCH
    {
      const id = await fixture(5), ph = phone();
      const held = await post(ck, sale(ph, id, { status: "held" }));
      const r = await fetch(`${BASE}/api/sales/${held.body.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: ck }, body: JSON.stringify({ status: "void" }) });
      const s = await Sale.findById(held.body.id).lean<any>();
      const after = await state([id]);
      rec("held bill can still be discarded (PATCH void)", held.status === 201 && r.status === 200 && s.status === "void" && after[0] === "5/5", `hold ${held.status}, discard ${r.status}, stored "${s?.status}", stock/FIFO ${after[0]}`);
    }
  } finally {
    try { process.kill(-(srv.pid as number), "SIGTERM"); } catch { /* gone */ }
    await sleep(800);
    console.log(`${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail > 0 ? 1 : 0);
  }
})();
