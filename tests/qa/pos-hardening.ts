/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * POS hardening regression suite — idempotency (replay / 409 / concurrency /
 * cross-user & cross-branch / lost response + edited cart), payment & quantity
 * validation, malformed bodies, remix selected oil, and a full data-integrity
 * check (sale ↔ payment ↔ customer ↔ stock ↔ FIFO ↔ branch ↔ salesperson ↔
 * reports). Drives the real API on two `next start` instances. LOCAL DB only.
 *
 *   DATABASE_URL='mongodb://127.0.0.1:27099/...' npx tsx tests/qa/pos-hardening.ts
 */
import { assertLocalDb } from "../../src/lib/e2eGuard";
assertLocalDb();
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, Customer, FifoLayer, Formula, Product, Sale } from "../../src/lib/models";
import { testSessionCookie } from "../../src/lib/auth/testSession";

const P1 = Number(process.env.QA_PORT || 3961), P2 = P1 + 1;
const S1 = `http://localhost:${P1}`, S2 = `http://localhost:${P2}`;
const LOG = process.env.QA_SERVER_LOG || path.join(os.tmpdir(), "qa-hardening-server.log");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const rec = (n: string, ok: boolean, d: string) => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗"} ${n} — ${d}`); };
const section = (t: string) => console.log(`\n${t}`);

type Res = { status: number; body: any; text: string };
async function http(base: string, method: string, path: string, cookie?: string, body?: unknown, opts: { raw?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Res> {
  const r = await fetch(`${base}${path}`, { method, redirect: "manual", signal: opts.signal, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) }, body: opts.raw !== undefined ? opts.raw : body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: parsed, text };
}
const LEAK = /(\n\s+at .+:\d+:\d+|node_modules|\.next\/|mongodb(\+srv)?:\/\/|E11000|Mongo\w*Error|"stack"|Cannot read propert|is not a function|is not iterable|ECONNREFUSED)/;
let n = 0;
const tag = Date.now() % 100000;
const phone = () => `+968 4${String(tag).padStart(5, "0")}${String(++n).padStart(3, "0")}`;
async function fixture(layers: number[], o: { price?: number; unit?: string; category?: string; name?: string; cost?: number } = {}) {
  const p = await Product.create({ sku: `QAH-${randomUUID().slice(0, 8)}`, name: o.name ?? `QA H ${randomUUID().slice(0, 4)}`, category: o.category ?? "Perfume", unit: o.unit ?? "pcs", sellPrice: o.price ?? 10, costFifo: o.cost ?? 1, minMarginPct: 0, stockSellable: layers.reduce((a, b) => a + b, 0) });
  for (let i = 0; i < layers.length; i++) await FifoLayer.create({ productId: p._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - (60 - i) * 864e5), qtyRemaining: layers[i], originalQty: layers[i], unitCost: o.cost ?? 1, currency: "OMR", source: "purchase" });
  return String(p._id);
}
async function snap(ids: string[]) {
  const out: Record<string, { stock: number; layers: Record<string, number> }> = {};
  for (const id of ids) {
    const p = await Product.findById(id).lean<any>();
    const ls = await FifoLayer.find({ productId: id }).lean<any[]>();
    out[id] = { stock: p.stockSellable, layers: Object.fromEntries(ls.map((l) => [String(l._id), l.qtyRemaining])) };
  }
  return out;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const salesFor = (ph: string) => Sale.find({ customerPhone: ph }).lean<any[]>();
/** initial − Σ committed sale deductions = final, for stock and every FIFO layer. */
async function reconciles(before: Awaited<ReturnType<typeof snap>>, sales: any[]) {
  const after = await snap(Object.keys(before));
  for (const [id, b] of Object.entries(before)) {
    let used = 0;
    const perLayer: Record<string, number> = {};
    for (const s of sales) for (const d of s.inventoryDeductions || []) {
      if (String(d.productId) !== id) continue;
      used += d.qty;
      for (const x of d.batches) perLayer[String(x.layerId)] = (perLayer[String(x.layerId)] || 0) + x.qty;
    }
    if (Math.abs(b.stock - used - after[id].stock) > 1e-6) return false;
    for (const [lid, q] of Object.entries(b.layers)) if (Math.abs(q - (perLayer[lid] || 0) - after[id].layers[lid]) > 1e-6 || after[id].layers[lid] < 0) return false;
  }
  return true;
}

function start(port: number, logFd?: number): ChildProcess {
  return spawn("npx", ["next", "start", "-p", String(port)], { cwd: process.cwd(), env: process.env, stdio: logFd ? ["ignore", logFd, logFd] : "ignore", detached: true });
}
async function up(base: string) { for (let i = 0; i < 240; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* */ } await sleep(500); } throw new Error(`${base} down`); }

async function main() {
  await connectDB();
  const logFd = fs.openSync(LOG, "w");
  const servers = [start(P1, logFd), start(P2, logFd)];
  try {
    await Promise.all([up(S1), up(S2)]);
    const branch = (await Branch.findOne({ code: "MAIN" }).lean<any>())!;
    const settings = (await AppSettings.findOne({ key: "default" }).lean<any>())!;
    const SP = settings.activeSalesperson as string;
    const SP2 = (settings.salespeople as string[]).find((s) => s !== SP)!;
    const otherBranch = String((await Branch.create({ name: `QA H Branch ${tag}`, code: `QAH${tag}`, active: true }))._id);
    const mk = (role: any, branchId: string | null, name: string) => testSessionCookie({ userId: String(new mongoose.Types.ObjectId()), name, email: `${name}-${tag}@test.local`, role, roleLabel: role, branchId, branchName: branchId ? (branchId === otherBranch ? "QA H Branch" : branch.name) : null });
    const A = await mk("cashier", String(branch._id), "qah-a");
    const A2 = await mk("cashier", String(branch._id), "qah-a2");
    const B = await mk("cashier", otherBranch, "qah-b");
    const OWNER = await mk("owner", null, "qah-owner");
    const sale = (ph: string, lines: any[], extra: Record<string, unknown> = {}) => ({ customerPhone: ph, payment: "cash", salesperson: SP, lines, ...extra });
    const ready = (id: string, qty: unknown = 1, more: Record<string, unknown> = {}) => ({ productId: id, qty, lineType: "ready", ...more });
    const post = (ck: string, body: unknown, base = S1, headers?: Record<string, string>) => http(base, "POST", "/api/sales", ck, body, { headers });

    section("Idempotency — replay, conflict, concurrency");
    {
      const p = await fixture([50]), q = await fixture([50]);
      const before = await snap([p, q]);
      const ph = phone(), key = randomUUID();
      const body = sale(ph, [ready(p, 2)], { idempotencyKey: key, payment: "credit" });
      const rs: Res[] = [];
      for (let i = 0; i < 5; i++) rs.push(await post(A, body, i % 2 ? S2 : S1));
      const sales = await salesFor(ph);
      const cust = await Customer.findOne({ phone: ph }).lean<any>();
      rec("same key + same cart ×5 → one sale, retries return it (200)", rs[0].status === 201 && rs.slice(1).every((r) => r.status === 200 && r.body.deduplicated && r.body.id === rs[0].body.id) && sales.length === 1 && cust.totalPurchases === 20 && cust.creditBalance === 20 && (await reconciles(before, sales)),
        `${rs.map((r) => r.status)}; sales ${sales.length}; customer +${cust.totalPurchases} credit +${cust.creditBalance}`);

      const variants: [string, any][] = [
        ["qty 2→3", sale(ph, [ready(p, 3)], { idempotencyKey: key, payment: "credit" })],
        ["item added", sale(ph, [ready(p, 2), ready(q, 1)], { idempotencyKey: key, payment: "credit" })],
        ["payment credit→cash", sale(ph, [ready(p, 2)], { idempotencyKey: key, payment: "cash" })],
        ["salesperson changed", sale(ph, [ready(p, 2)], { idempotencyKey: key, payment: "credit", salesperson: SP2 })],
        ["discount added", sale(ph, [ready(p, 2, { discount: { type: "percent", value: 5 } })], { idempotencyKey: key, payment: "credit" })],
        ["phone changed", sale(phone(), [ready(p, 2)], { idempotencyKey: key, payment: "credit" })],
      ];
      const stockMid = await snap([p, q]);
      for (const [label, b] of variants) {
        const r = await post(A, b);
        const noLeak = !("customerPhone" in r.body) && !("total" in r.body) && !("lines" in r.body) && !("customerName" in r.body);
        rec(`same key + ${label} → 409 IDEMPOTENCY_CONFLICT, nothing charged`, r.status === 409 && r.body.code === "IDEMPOTENCY_CONFLICT" && r.body.saleId === rs[0].body.id && noLeak && (await salesFor(ph)).length === 1 && same(await snap([p, q]), stockMid),
          `HTTP ${r.status} ${r.body.code}; saleId ${r.body.saleId === rs[0].body.id ? "= original" : r.body.saleId}; body keys [${Object.keys(r.body)}]`);
      }
      const hdr = await post(A, sale(ph, [ready(p, 9)], { payment: "credit" }), S1, { "Idempotency-Key": key });
      rec("header Idempotency-Key with changed cart → 409 too", hdr.status === 409 && (await salesFor(ph)).length === 1, `HTTP ${hdr.status}`);

      // concurrent retries of the same bill (2 instances)
      const p2 = await fixture([30]);
      const b2 = await snap([p2]);
      const ph2 = phone(), k2 = randomUUID();
      const conc = await Promise.all(Array.from({ length: 10 }, (_, i) => post(A, sale(ph2, [ready(p2, 1)], { idempotencyKey: k2 }), i % 2 ? S2 : S1)));
      const s2 = await salesFor(ph2);
      rec("10 concurrent retries, same key + cart → 1 sale, 9×200", s2.length === 1 && conc.filter((r) => r.status === 201).length === 1 && conc.filter((r) => r.status === 200).length === 9 && (await reconciles(b2, s2)), `${conc.map((r) => r.status)}`);

      // concurrent same key, different carts
      const p3 = await fixture([30]);
      const b3 = await snap([p3]);
      const ph3 = phone(), k3 = randomUUID();
      const carts = [1, 2, 3, 1, 2, 3, 1, 2, 3, 1].map((qty) => sale(ph3, [ready(p3, qty)], { idempotencyKey: k3 }));
      const mix = await Promise.all(carts.map((c, i) => post(A, c, i % 2 ? S2 : S1)));
      const s3 = await salesFor(ph3);
      const winnerQty = s3[0]?.lines?.[0]?.qty;
      const consistent = mix.every((r, i) => r.status === 201 || (r.status === 200 && carts[i].lines[0].qty === winnerQty) || (r.status === 409 && carts[i].lines[0].qty !== winnerQty));
      rec("10 concurrent, same key, 3 different carts → exactly 1 sale; same-cart 200, others 409", s3.length === 1 && consistent && (await reconciles(b3, s3)) && (await snap([p3]))[p3].stock === 30 - winnerQty,
        `${mix.map((r) => r.status)}; sale qty ${winnerQty}; stock 30→${(await snap([p3]))[p3].stock}`);
    }

    section("Idempotency — cross-user / cross-branch (POS-146b)");
    {
      const p = await fixture([40]);
      // A uses two keys; every other user reuses each of them exactly once.
      const phA = phone();
      const keyFor = { identical: randomUUID(), different: randomUUID() };
      const a = await post(A, sale(phA, [ready(p, 1)], { idempotencyKey: keyFor.identical, customerName: "Private Customer A", payment: "credit" }));
      await post(A, sale(phA, [ready(p, 1)], { idempotencyKey: keyFor.different, customerName: "Private Customer A", payment: "credit" }));
      for (const [label, ck, base] of [["same-branch cashier", A2, S1], ["other-branch cashier", B, S2], ["owner", OWNER, S1]] as const) {
        for (const sameCart of [false, true]) {
          const ph = sameCart ? phA : phone();
          const before = (await salesFor(ph)).length;
          const key = sameCart ? keyFor.identical : keyFor.different;
          const r = await post(ck, sale(ph, [ready(p, sameCart ? 1 : 2)], { idempotencyKey: key, payment: "credit" }), base);
          const leaked = r.text.includes("Private Customer A") || (r.body.id === a.body.id) || (!sameCart && r.text.includes(phA));
          rec(`${label} reuses A's key (${sameCart ? "identical cart" : "different cart"}) → own sale, no A data`, r.status === 201 && !leaked && r.body.id !== a.body.id && (await salesFor(ph)).length === before + 1,
            `HTTP ${r.status}; own sale ${r.body.id !== a.body.id}; leaked A's data: ${leaked}`);
        }
      }
      const aNow = await Sale.findById(a.body.id).lean<any>();
      rec("A's original sale untouched", aNow.status === "completed" && aNow.customerName === "Private Customer A" && aNow.total === 10, `status ${aNow.status}, total ${aNow.total}`);
    }

    section("Retry spanning the deploy (sale stored under the raw, unscoped key)");
    {
      const p = await fixture([40]);
      const legacyKey = `legacy-${randomUUID()}`;
      const ph = phone();
      const first = await post(A, sale(ph, [ready(p, 2)], { idempotencyKey: randomUUID(), payment: "credit" }));
      // Simulate a pre-deploy sale: same document, raw client key (local test DB only).
      await Sale.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.body.id) }, { $set: { idempotencyKey: legacyKey } });
      const before = await snap([p]);
      const retry = await post(A, sale(ph, [ready(p, 2)], { idempotencyKey: legacyKey, payment: "credit" }), S2);
      rec("same branch + identical bill → 200, the legacy sale (no duplicate)", retry.status === 200 && retry.body.id === first.body.id && (await salesFor(ph)).length === 1 && same(before, await snap([p])), `HTTP ${retry.status}; same sale ${retry.body.id === first.body.id}`);
      const other = await post(B, sale(ph, [ready(p, 2)], { idempotencyKey: legacyKey, payment: "credit" }), S2);
      rec("other branch, same key + bill → its own new sale; legacy sale not revealed", other.status === 201 && other.body.id !== first.body.id, `HTTP ${other.status}; own sale ${other.body.id !== first.body.id}`);
      const ph2 = phone();
      const diff = await post(A, sale(ph2, [ready(p, 3)], { idempotencyKey: legacyKey }));
      rec("same branch, different bill → new sale; legacy data not revealed", diff.status === 201 && diff.body.id !== first.body.id && !diff.text.includes(ph), `HTTP ${diff.status}`);
    }

    section("Lost response + edited cart (UI keeps the bill's key until confirmed)");
    {
      const lost = async (label: string, first: any, second: any, ids: string[]) => {
        const before = await snap(ids);
        const ph = first.customerPhone;
        const key = randomUUID();
        // The server commits; the client never sees the reply (response lost).
        await post(A, { ...first, idempotencyKey: key }, S1);
        const committed = (await salesFor(ph)).length;
        const r = await post(A, { ...second, idempotencyKey: key }, S2);
        const sales = await salesFor(ph);
        const ok = committed === 1 && sales.length === 1 && (await reconciles(before, sales)) && (second === first ? r.status === 200 : r.status === 409);
        rec(`${label}`, ok, `committed ${committed}; resubmit HTTP ${r.status} ${r.body.code ?? (r.body.deduplicated ? "deduplicated" : "")}; sales ${sales.length}; stock/FIFO reconcile`);
        return { r, ph, key, before };
      };
      const x = await fixture([30], { price: 10 }), y = await fixture([30], { price: 7 });
      const ph = phone();
      const base = sale(ph, [ready(x, 2)], { payment: "credit" });
      await lost("unchanged cart → 200 original", base, base, [x]);
      const ph2 = phone();
      const b2 = sale(ph2, [ready(x, 2)], { payment: "credit" });
      await lost("cashier adds an item → 409, no second sale", b2, sale(ph2, [ready(x, 2), ready(y, 1)], { payment: "credit" }), [x, y]);
      const ph3 = phone();
      const b3 = sale(ph3, [ready(x, 2)], { payment: "credit" });
      const c = await lost("cashier changes qty → 409, no second sale", b3, sale(ph3, [ready(x, 3)], { payment: "credit" }), [x]);
      const ph4 = phone();
      const b4 = sale(ph4, [ready(x, 2)], { payment: "credit" });
      await lost("cashier switches payment → 409, no second sale", b4, sale(ph4, [ready(x, 2)], { payment: "cash" }), [x]);
      // After the 409 the UI issues a new key; a deliberate second press is a new, separate sale.
      const again = await post(A, sale(ph3, [ready(x, 3)], { payment: "credit", idempotencyKey: randomUUID() }));
      rec("after 409 the cashier's deliberate new checkout (new key) is its own sale", again.status === 201 && (await salesFor(ph3)).length === 2, `HTTP ${again.status}; sales ${(await salesFor(ph3)).length}`);
      void c;
      // remix
      const remix = await Product.findOne({ sku: "RM-STD" }).lean<any>();
      const oil = await fixture([100], { unit: "ml", category: "Single Notes", name: `QAH Oil L ${tag}`, price: 2 });
      const def = await Formula.findOne({ type: "remix", status: "approved", customerId: null, "components.productId": "oil-base" }).sort({ updatedAt: -1 }).lean<any>();
      const compIds = def.components.filter((cc: any) => mongoose.isValidObjectId(cc.productId)).map((cc: any) => String(cc.productId));
      for (const cc of def.components.filter((z: any) => mongoose.isValidObjectId(z.productId))) {
        await FifoLayer.create({ productId: cc.productId, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 90 * 864e5), qtyRemaining: cc.qty * 10, originalQty: cc.qty * 10, unitCost: 0.1, currency: "OMR", source: "purchase" });
        await Product.updateOne({ _id: cc.productId }, { $inc: { stockSellable: cc.qty * 10 } });
      }
      const ph5 = phone();
      const rl = (qty: number) => sale(ph5, [{ productId: String(remix._id), qty, lineType: "remix", oilProductId: oil }]);
      await lost("remix: lost response, then qty 1→2 → 409, recipe consumed once", rl(1), rl(2), [oil, ...compIds]);
    }

    section("Discount approval + retry after the token was used");
    {
      const p = await fixture([20], { price: 100 });
      const cart = [ready(p, 1, { discount: { type: "percent", value: 30 } })];
      const apr = await http(S1, "POST", "/api/sales/discount-approval", A, { lines: cart, email: "admin@unich.local", password: "admin123" });
      const ph = phone(), key = randomUUID();
      const r1 = await post(A, sale(ph, cart, { idempotencyKey: key, discountApprovalToken: apr.body.approvalToken }));
      const r2 = await post(A, sale(ph, cart, { idempotencyKey: key, discountApprovalToken: apr.body.approvalToken }), S2);
      rec("approved-discount sale retried after its token was consumed → 200 original (not 403)", apr.status === 200 && r1.status === 201 && r2.status === 200 && r2.body.id === r1.body.id && (await salesFor(ph)).length === 1, `approval ${apr.status}; ${r1.status} → ${r2.status}`);
    }

    section("Payment method validation (POS-160)");
    {
      const p = await fixture([100]);
      for (const m of ["cash", "card", "bank", "credit"]) {
        const ph = phone();
        const r = await post(A, sale(ph, [ready(p)], { payment: m }));
        const s = (await salesFor(ph))[0];
        rec(`payment "${m}" → 201, stored ${m}`, r.status === 201 && s?.payment === m, `HTTP ${r.status}, stored ${s?.payment}`);
      }
      { const ph = phone(); const r = await post(A, sale(ph, [ready(p, 2)], { payment: "mixed", paymentBreakdown: [{ method: "cash", amount: 5 }, { method: "credit", amount: 15 }] })); const s = (await salesFor(ph))[0]; const c = await Customer.findOne({ phone: ph }).lean<any>();
        rec("payment mixed (cash 5 + credit 15) → 201, split stored, credit +15", r.status === 201 && s.payment === "mixed" && s.paymentBreakdown.length === 2 && c.creditBalance === 15, `HTTP ${r.status}`); }
      { const ph = phone(); const b: any = sale(ph, [ready(p)]); delete b.payment; const r = await post(A, b); rec("payment absent → existing default cash (PO decision pending)", r.status === 201 && (await salesFor(ph))[0].payment === "cash", `HTTP ${r.status}`); }
      const before = await snap([p]);
      const bad: [string, unknown][] = [["bitcoin", "bitcoin"], ['""', ""], ['" "', " "], ['" card"', " card"], ['"card "', "card "], ['"bank transfer"', "bank transfer"], ["null", null], ["5", 5], ["{}", {}], ['["card"]', ["card"]], ['{"$ne":null}', { $ne: null }], ["true", true]];
      for (const [label, v] of bad) {
        const ph = phone();
        const r = await post(A, sale(ph, [ready(p)], { payment: v }));
        rec(`payment ${label} → 400, no sale/customer/stock change`, r.status === 400 && r.body.code === "VALIDATION" && (await salesFor(ph)).length === 0 && !(await Customer.findOne({ phone: ph })) && !LEAK.test(r.text), `HTTP ${r.status} ${r.body.code}`);
      }
      for (const [label, br] of [["breakdown [null]", [null]], ["amount as string", [{ method: "cash", amount: "10" }]], ["unknown split method", [{ method: "crypto", amount: 10 }]], ["sum ≠ total", [{ method: "cash", amount: 1 }]]] as [string, unknown][]) {
        const ph = phone();
        const r = await post(A, sale(ph, [ready(p)], { payment: "mixed", paymentBreakdown: br }));
        rec(`mixed ${label} → 400`, r.status === 400 && (await salesFor(ph)).length === 0 && !LEAK.test(r.text), `HTTP ${r.status} ${r.body.code}`);
      }
      rec("rejected payments moved no stock", same(before, await snap([p])), "stock/FIFO unchanged");
    }

    section("Quantity validation (POS-157/158/164)");
    {
      const p = await fixture([100]);
      for (const [label, q, want] of [["1", 1, 201], ["3", 3, 201], ["0", 0, 400], ["-1", -1, 400], ["1.5", 1.5, 400], ['"2"', "2", 400], ['" 2 "', " 2 ", 400], ['"abc"', "abc", 400], ["null", null, 400], ["true", true, 400], ["[2]", [2], 400], ['"0x2"', "0x2", 400], ['"2e0"', "2e0", 400], ["1e9 (beyond stock)", 1e9, 400], ["1e308", 1e308, 400], ['"1e999"', "1e999", 400]] as [string, unknown, number][]) {
        const ph = phone();
        const s0 = (await snap([p]))[p];
        const r = await post(A, sale(ph, [ready(p, q)]));
        const s1 = (await snap([p]))[p];
        const sales = await salesFor(ph);
        const ok = r.status === want && (want === 201 ? sales.length === 1 && s0.stock - s1.stock === q : sales.length === 0 && same(s0, s1)) && !LEAK.test(r.text);
        rec(`qty ${label} → ${want}`, ok, `HTTP ${r.status} ${r.body.code ?? ""}; stock −${s0.stock - s1.stock}`);
      }
      const ph = phone();
      const r = await post(A, sale(ph, [{ productId: p, lineType: "ready" }]));
      rec("qty missing → 400", r.status === 400 && (await salesFor(ph)).length === 0, `HTTP ${r.status}`);
    }

    section("Malformed bodies — controlled 400, nothing leaked or written");
    {
      const p = await fixture([10]);
      const before = await snap([p]);
      const salesBefore = await Sale.countDocuments();
      const ph = phone();
      const raws: [string, string][] = [["invalid JSON", "{bad"], ["empty", ""], ["null", "null"], ["array", "[]"], ["string", '"x"'], ["number", "5"],
        ["lines [null]", JSON.stringify(sale(ph, [null]))], ["lines [[1]]", JSON.stringify(sale(ph, [[1]]))], ["lines object", JSON.stringify(sale(ph, {} as any))],
        ["phone number", JSON.stringify({ ...sale(ph, [ready(p)]), customerPhone: 12345678 })], ["phone object", JSON.stringify({ ...sale(ph, [ready(p)]), customerPhone: {} })],
        ["customerName number", JSON.stringify(sale(ph, [ready(p)], { customerName: 42 }))], ["customerId object", JSON.stringify(sale(ph, [ready(p)], { customerId: { $ne: null } }))],
        ["customerId malformed", JSON.stringify(sale(ph, [ready(p)], { customerId: "garbage" }))], ["idempotencyKey number", JSON.stringify(sale(ph, [ready(p)], { idempotencyKey: 123 }))],
        ["idempotencyKey object", JSON.stringify(sale(ph, [ready(p)], { idempotencyKey: { $gt: "" } }))], ["paymentBreakdown [null]", JSON.stringify(sale(ph, [ready(p)], { payment: "mixed", paymentBreakdown: [null] }))],
        ["salesperson object", JSON.stringify(sale(ph, [ready(p)], { salesperson: { $ne: null } }))], ["productId object", JSON.stringify(sale(ph, [{ productId: { $gt: "" }, qty: 1, lineType: "ready" }]))],
        ["productId malformed", JSON.stringify(sale(ph, [ready("abc")]))], ["lineType hack", JSON.stringify(sale(ph, [{ productId: p, qty: 1, lineType: "hack" }]))],
        ["status void", JSON.stringify(sale(ph, [ready(p)], { status: "void" }))], ["discount nested junk", JSON.stringify(sale(ph, [ready(p, 1, { discount: { type: { a: 1 }, value: [1] } })]))]];
      const results = [] as string[];
      let allOk = true;
      for (const [label, raw] of raws) {
        const r = await http(S1, "POST", "/api/sales", A, undefined, { raw });
        const ok = r.status === 400 && !LEAK.test(r.text);
        allOk &&= ok;
        results.push(`${label} ${r.status}${ok ? "" : ` ✗ ${r.text.slice(0, 80)}`}`);
      }
      const approval = await Promise.all([["null", "null"], ["array", "[]"], ["lines [null]", '{"lines":[null]}']].map(([, raw]) => http(S1, "POST", "/api/sales/discount-approval", A, undefined, { raw })));
      const apOk = approval.every((r) => r.status === 400 && !LEAK.test(r.text));
      rec(`POST /api/sales: ${raws.length} malformed bodies → all 400, no internals in responses`, allOk, results.join("; "));
      rec("POST /api/sales/discount-approval malformed → 400", apOk, approval.map((r) => r.status).join(","));
      rec("no sale, stock or FIFO change from any malformed request", (await Sale.countDocuments()) === salesBefore && same(before, await snap([p])), `sales ${salesBefore}→${await Sale.countDocuments()}`);
    }

    section("Remix — selected oil is the oil consumed (BLD-02/03)");
    {
      const remix = await Product.findOne({ sku: "RM-STD" }).lean<any>();
      const def = await Formula.findOne({ type: "remix", status: "approved", customerId: null, "components.productId": "oil-base" }).sort({ updatedAt: -1 }).lean<any>();
      const rose = await fixture([60], { unit: "ml", category: "Single Notes", name: `QAH Rose ${tag}`, price: 2 });
      const oud = await fixture([60], { unit: "ml", category: "Single Notes", name: `QAH Oud ${tag}`, price: 2 });
      // A NEWER approved non-customer formula WITHOUT the oil-base placeholder (the incident setup).
      const fixedParts = def.components.filter((cc: any) => cc.productId !== "oil-base");
      const blend = await Formula.create({ name: `QAH Fixed Oud ${tag}`, type: "remix", status: "approved", version: 1, yieldMl: 100, components: [{ productId: oud, productName: `QAH Oud ${tag}`, qty: 20, unit: "ml" }, ...fixedParts] });
      await sleep(61_000); // let the 60 s default-BOM cache expire on both instances
      const compIds = fixedParts.filter((cc: any) => mongoose.isValidObjectId(cc.productId)).map((cc: any) => String(cc.productId));
      for (const cc of fixedParts.filter((z: any) => mongoose.isValidObjectId(z.productId))) {
        await FifoLayer.create({ productId: cc.productId, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 95 * 864e5), qtyRemaining: cc.qty * 10, originalQty: cc.qty * 10, unitCost: 0.1, currency: "OMR", source: "purchase" });
        await Product.updateOne({ _id: cc.productId }, { $inc: { stockSellable: cc.qty * 10 } });
      }
      const ids = [rose, oud, ...compIds];
      let before = await snap(ids);
      const ph = phone();
      const r = await post(A, sale(ph, [{ productId: String(remix._id), qty: 2, lineType: "remix", oilProductId: rose }]), S2);
      let after = await snap(ids);
      const s = (await salesFor(ph))[0];
      const partsOk = fixedParts.filter((cc: any) => mongoose.isValidObjectId(cc.productId)).every((cc: any) => Math.abs(before[String(cc.productId)].stock - after[String(cc.productId)].stock - cc.qty * 2) < 1e-6);
      rec("plain remix with Rose selected (newer fixed-oil formula exists) → Rose −40 ml, Oud untouched, recipe ×2", r.status === 201 && before[rose].stock - after[rose].stock === 40 && before[oud].stock === after[oud].stock && partsOk && String(s.lines[0].oilProductId) === rose && (await reconciles(before, [s])),
        `HTTP ${r.status}; Rose −${before[rose].stock - after[rose].stock}; Oud −${before[oud].stock - after[oud].stock}; line oil = ${String(s?.lines?.[0]?.oilProductId) === rose ? "Rose" : "other"}`);
      before = await snap(ids);
      const ph2 = phone();
      const bad = await post(A, sale(ph2, [{ productId: String(remix._id), qty: 1, lineType: "remix", oilProductId: rose, formulaId: String(blend._id) }]));
      rec("saved fixed-Oud formula + Rose selected → 400 OIL_NOT_SELECTED, nothing consumed", bad.status === 400 && bad.body.code === "OIL_NOT_SELECTED" && (await salesFor(ph2)).length === 0 && same(before, await snap(ids)), `HTTP ${bad.status} ${bad.body.code}`);
      const ph3 = phone();
      const ok = await post(A, sale(ph3, [{ productId: String(remix._id), qty: 1, lineType: "remix", oilProductId: oud, formulaId: String(blend._id) }]));
      after = await snap(ids);
      rec("saved fixed-Oud formula + its own Oud → 201, Oud −20", ok.status === 201 && before[oud].stock - after[oud].stock === 20 && before[rose].stock === after[rose].stock, `HTTP ${ok.status}; Oud −${before[oud].stock - after[oud].stock}`);
      const empty = await fixture([10], { unit: "ml", category: "Single Notes", name: `QAH Empty ${tag}` });
      const ph4 = phone();
      const short = await post(A, sale(ph4, [{ productId: String(remix._id), qty: 1, lineType: "remix", oilProductId: empty }]));
      rec("selected oil short of 20 ml → 400 INSUFFICIENT_STOCK (never substituted)", short.status === 400 && short.body.code === "INSUFFICIENT_STOCK" && (await salesFor(ph4)).length === 0, `HTTP ${short.status} ${short.body.code}`);
      await Formula.deleteOne({ _id: blend._id });
    }

    section("Data integrity — sale ↔ payment ↔ customer ↔ stock ↔ FIFO ↔ branch ↔ salesperson ↔ reports");
    {
      const p = await fixture([3, 5], { price: 20, cost: 2 }), q = await fixture([10], { price: 8, cost: 1 });
      const before = await snap([p, q]);
      const ph = phone();
      const dash0 = await http(S1, "GET", "/api/dashboard", A);
      const today0 = JSON.stringify(dash0.body).match(/"todaySales":([\d.]+)/)?.[1];
      const r = await post(A, sale(ph, [ready(p, 4, { discount: { type: "percent", value: 5 } }), ready(q, 2)], { payment: "mixed", paymentBreakdown: [{ method: "cash", amount: 50 }, { method: "credit", amount: 42 }], salesperson: SP2, customerName: "Integrity Check" }));
      const s = await Sale.findById(r.body.id).lean<any>();
      const c = await Customer.findOne({ phone: ph }).lean<any>();
      const dash1 = await http(S1, "GET", "/api/dashboard", A);
      const today1 = JSON.stringify(dash1.body).match(/"todaySales":([\d.]+)/)?.[1];
      const listed = await http(S1, "GET", `/api/sales?status=completed&phone=${encodeURIComponent(ph)}`, A);
      const expectTotal = 4 * 20 * 0.95 + 2 * 8; // 76 + 16 = 92
      const fifoP = s.inventoryDeductions.find((d: any) => String(d.productId) === p);
      const checks: [string, boolean][] = [
        ["total = Σ lines − discount", Math.abs(s.total - expectTotal) < 1e-9 && Math.abs(s.subtotal - 96) < 1e-9 && Math.abs(s.discountTotal - 4) < 1e-9],
        ["payment split = total", s.payment === "mixed" && Math.abs(s.paymentBreakdown.reduce((a: number, e: any) => a + e.amount, 0) - s.total) < 1e-9],
        ["customer totalPurchases = total; credit = credit split", Math.abs(c.totalPurchases - expectTotal) < 1e-9 && c.creditBalance === 42 && String(s.customerId) === String(c._id)],
        ["stock + FIFO reconcile (oldest layer first: 3 then 1)", (await reconciles(before, [s])) && same(fifoP.batches.map((b: any) => b.qty), [3, 1])],
        ["FIFO cost recorded = Σ batch qty × unit cost", Math.abs(fifoP.costTotal - 8) < 1e-9],
        ["branch = session branch", String(s.branchId) === String(branch._id)],
        ["salesperson = requested (on Sales Team)", s.salesperson === SP2],
        ["status completed", s.status === "completed"],
        ["listed in completed sales", Array.isArray(listed.body) && listed.body.some((x: any) => x.id === r.body.id)],
        ["dashboard today's sales +92", today0 !== undefined && today1 !== undefined && Math.abs(Number(today1) - Number(today0) - expectTotal) < 1e-6],
      ];
      for (const [label, ok] of checks) rec(`integrity: ${label}`, r.status === 201 && ok, ok ? "ok" : JSON.stringify({ total: s?.total, sub: s?.subtotal, disc: s?.discountTotal, credit: c?.creditBalance, today0, today1 }));
    }

    await sleep(500);
    const log = fs.readFileSync(LOG, "utf8");
    rec("server log: no unexpected API errors during the suite", !/\[api-error ref=/.test(log), `${(log.match(/\[api-error ref=/g) || []).length} api-error entries`);
  } finally {
    for (const s of servers) { try { process.kill(-(s.pid as number), "SIGTERM"); } catch { /* */ } }
    await sleep(800);
    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail > 0 ? 1 : 0);
  }
}
main().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
