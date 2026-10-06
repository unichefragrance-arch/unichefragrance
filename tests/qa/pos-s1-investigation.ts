/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * QA investigation — S1 (void status consumes stock), duplicate lookup scope,
 * payment/qty type validation, error leakage, lost-response + edited-cart
 * duplicates. LOCAL throwaway DB only; reads/writes only QA fixtures.
 *
 *   DATABASE_URL='mongodb://127.0.0.1:27099/...' npx tsx tests/qa/pos-s1-investigation.ts
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
import { AppSettings, Branch, Customer, DiscountApproval, FifoLayer, Formula, Product, Sale, User } from "../../src/lib/models";
import { testSessionCookie } from "../../src/lib/auth/testSession";

const S1 = "http://localhost:3981", S2 = "http://localhost:3982", SDOWN = "http://localhost:3983";
const LOG = process.env.QA_SERVER_LOG || path.join(os.tmpdir(), "qa-server.log");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: Record<string, any> = {};
const section = (t: string) => console.log(`\n=== ${t} ===`);
const line = (s: string) => console.log(`  ${s}`);

async function http(base: string, method: string, path: string, cookie?: string, body?: unknown, extra: any = {}) {
  const res = await fetch(`${base}${path}`, {
    method, redirect: "manual", ...extra,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(extra.headers || {}) },
    body: extra.raw !== undefined ? extra.raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { /* */ }
  return { status: res.status, body: parsed, text, setCookie: res.headers.get("set-cookie") || "" };
}
let seq = 0;
const tag = Date.now() % 100000;
const phone = () => `+968 6${String(tag).padStart(5, "0")}${String(++seq).padStart(3, "0")}`;
async function fixture(layers: number[], o: { price?: number; unit?: string; category?: string; name?: string } = {}) {
  const p = await Product.create({ sku: `QAS1-${randomUUID().slice(0, 8)}`, name: o.name ?? `QA S1 ${randomUUID().slice(0, 4)}`, category: o.category ?? "Perfume", unit: o.unit ?? "pcs", sellPrice: o.price ?? 10, costFifo: 1, minMarginPct: 0, stockSellable: layers.reduce((a, b) => a + b, 0) });
  for (let i = 0; i < layers.length; i++) await FifoLayer.create({ productId: p._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - (40 - i) * 864e5), qtyRemaining: layers[i], originalQty: layers[i], unitCost: 1, currency: "OMR", source: "purchase" });
  return String(p._id);
}
const stock = async (id: string) => (await Product.findById(id).lean<any>()).stockSellable as number;
const layers = async (id: string) => (await FifoLayer.find({ productId: id }).sort({ purchaseDate: 1 }).lean<any[]>()).map((l) => l.qtyRemaining);
const salesFor = (ph: string) => Sale.find({ customerPhone: ph }).lean<any[]>();
const leak = (t: string) => (t.match(/(\n\s+at .+:\d+:\d+|node_modules|\.next\/server|mongodb(\+srv)?:\/\/|E11000|Mongo\w*Error|"stack"|Cannot read propert|is not a function|is not iterable|ECONNREFUSED|127\.0\.0\.1:\d+)/) || [])[0] || null;

function start(port: number, env: NodeJS.ProcessEnv, logFd?: number): ChildProcess {
  return spawn("npx", ["next", "start", "-p", String(port)], { cwd: process.cwd(), env, stdio: logFd ? ["ignore", logFd, logFd] : "ignore", detached: true });
}
async function up(base: string) { for (let i = 0; i < 240; i++) { try { const r = await fetch(`${base}/api/health`); if (r.status < 600) return; } catch { /* */ } await sleep(500); } throw new Error(`${base} down`); }

async function main() {
  await connectDB();
  const logFd = fs.openSync(LOG, "w");
  const servers = [start(3981, process.env, logFd), start(3982, process.env)];
  // Third instance: unreachable database (dead port) — controlled DB-outage behaviour.
  const deadUrl = "mongodb://127.0.0.1:27199/unich_dead?directConnection=true&serverSelectionTimeoutMS=1500";
  servers.push(start(3983, { ...process.env, DATABASE_URL: deadUrl }));
  try {
    await Promise.all([up(S1), up(S2), up(SDOWN)]);
    const branch = (await Branch.findOne({ code: "MAIN" }).lean<any>())!;
    const SP = (await AppSettings.findOne({ key: "default" }).lean<any>()).activeSalesperson;
    const mk = (role: any, branchId: string | null, name: string) => testSessionCookie({ userId: String(new mongoose.Types.ObjectId()), name, email: `${name}@test.local`, role, roleLabel: role, branchId, branchName: branchId ? "QA" : null });
    const cashier = await mk("cashier", String(branch._id), "s1-cashier");
    const cashier2 = await mk("cashier", String(branch._id), "s1-cashier2");
    const otherBranch = String((await Branch.create({ name: `S1 Branch ${tag}`, code: `S1B${tag}`, active: true }))._id);
    const cashierB = await mk("cashier", otherBranch, "s1-cashier-b");
    const owner = await mk("owner", null, "s1-owner");
    const sell = (ck: string, lines: any[], extra: any = {}, base = S1) => http(base, "POST", "/api/sales", ck, { customerPhone: phone(), payment: "cash", salesperson: SP, lines, ...extra });
    const ready = (id: string, qty: any = 1, more: any = {}) => ({ productId: id, qty, lineType: "ready", ...more });

    // ---------------- PHASE 4/5: status matrix ----------------
    section("PHASE 4/5 — client-supplied status on POST /api/sales");
    const statuses: [string, any, boolean][] = [
      ["(absent)", undefined, false], ["completed", "completed", false], ["held", "held", false], ["void", "void", true],
      ["VOID", "VOID", true], ["cancelled", "cancelled", true], ["refunded-hack", "refunded-hack", true], ["null", null, false],
      ["5 (number)", 5, true], ["{} (object)", {}, true], ['{"$ne":null}', { $ne: null }, true], ['["void"]', ["void"], true], ['"" (empty)', "", false],
    ];
    const statusRows: any[] = [];
    for (const [label, value, _bad] of statuses) {
      const id = await fixture([10]);
      const ph = phone();
      const s0 = await stock(id);
      const body: any = { customerPhone: ph, payment: "credit", salesperson: SP, lines: [ready(id, 2)] };
      if (value !== undefined) body.status = value;
      const r = await http(S1, "POST", "/api/sales", cashier, body);
      const s = (await salesFor(ph))[0];
      const c = await Customer.findOne({ phone: ph }).lean<any>();
      const listed = s ? (await http(S1, "GET", `/api/sales?status=completed&phone=${encodeURIComponent(ph)}`, owner)).body.length : 0;
      const row = { label, http: r.status, storedStatus: s ? JSON.stringify(s.status) : "-", stockDelta: s0 - (await stock(id)), fifo: (await layers(id)).join(","), customerTotal: c?.totalPurchases ?? 0, customerCredit: c?.creditBalance ?? 0, inCompletedReports: listed > 0, error: r.body.error };
      statusRows.push(row);
      line(`${label.padEnd(16)} → HTTP ${r.status}  stored status ${row.storedStatus.padEnd(18)} stock −${row.stockDelta}  FIFO [${row.fifo}]  customer +${row.customerTotal} (credit +${row.customerCredit})  in completed-sales view: ${row.inCompletedReports}${r.status >= 400 ? `  "${r.body.error}"` : ""}`);
    }
    out.statusMatrix = statusRows;

    // Remix sold with status void — BOM consumed
    {
      const remix = await Product.findOne({ sku: "RM-STD" }).lean<any>();
      const formula = await Formula.findOne({ type: "remix", status: "approved", customerId: null }).lean<any>();
      const comps = formula.components.filter((c: any) => mongoose.isValidObjectId(c.productId));
      for (const c of comps) {
        await FifoLayer.create({ productId: c.productId, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 50 * 864e5), qtyRemaining: c.qty * 4, originalQty: c.qty * 4, unitCost: 0.1, currency: "OMR", source: "purchase" });
        await Product.updateOne({ _id: c.productId }, { $inc: { stockSellable: c.qty * 4 } });
      }
      const oil = await fixture([40], { unit: "ml", category: "Single Notes", name: `S1 Oil ${tag}`, price: 2 });
      const before = await Promise.all(comps.map((c: any) => stock(String(c.productId))));
      const ph = phone();
      const r = await http(S1, "POST", "/api/sales", cashier, { customerPhone: ph, payment: "cash", salesperson: SP, status: "void", lines: [{ productId: String(remix._id), qty: 1, lineType: "remix", oilProductId: oil }] });
      const after = await Promise.all(comps.map((c: any) => stock(String(c.productId))));
      const s = (await salesFor(ph))[0];
      out.remixVoid = { http: r.status, storedStatus: s?.status, oil: `${40}→${await stock(oil)}`, components: comps.map((c: any, i: number) => `${c.productName} −${before[i] - after[i]}`), deductionsRecorded: s?.inventoryDeductions?.length };
      line(`remix with status "void" → HTTP ${r.status}, stored "${s?.status}", oil 40→${await stock(oil)} ml, ${comps.length} BOM components consumed: ${out.remixVoid.components.join(", ")}`);
    }

    // Failure after inventory planning → rollback (scenario 4/7)
    section("PHASE 4 — failures after partial work roll back atomically");
    {
      const id = await fixture([10]);
      const done = await sell(cashier, [ready(id, 1)]);
      const ph = phone();
      const s0 = await stock(id), l0 = (await layers(id)).join(",");
      const r = await http(S1, "POST", "/api/sales", cashier, { customerPhone: ph, payment: "cash", salesperson: SP, resumedFromId: done.body.id, lines: [ready(id, 3)] });
      const c = await Customer.findOne({ phone: ph }).lean<any>();
      out.rollbackHeld = { http: r.status, code: r.body.code, salesCreated: (await salesFor(ph)).length, stock: `${s0}→${await stock(id)}`, fifo: `[${l0}]→[${(await layers(id)).join(",")}]`, customerCreated: !!c };
      line(`resumedFromId = a completed sale (fails AFTER sale insert, before stock write) → HTTP ${r.status} ${r.body.code}; sales ${out.rollbackHeld.salesCreated}; stock ${out.rollbackHeld.stock}; FIFO ${out.rollbackHeld.fifo}; customer row created: ${!!c}`);

      // approval token consumed by twin request (fails after insert)
      const f = await fixture([20], { price: 100 });
      const cart = [ready(f, 1, { discount: { type: "percent", value: 30 } })];
      const apr = await http(S1, "POST", "/api/sales/discount-approval", cashier, { lines: cart, email: "admin@unich.local", password: "admin123" });
      const s1 = await stock(f);
      const phs = [phone(), phone(), phone()];
      const twins = await Promise.all(phs.map((p, i) => http(i % 2 ? S2 : S1, "POST", "/api/sales", cashier, { customerPhone: p, payment: "cash", salesperson: SP, discountApprovalToken: apr.body.approvalToken, idempotencyKey: randomUUID(), lines: cart })));
      const created = (await Promise.all(phs.map(salesFor))).reduce((a, s) => a + s.length, 0);
      const used = await DiscountApproval.findOne({ token: apr.body.approvalToken }).lean<any>();
      out.rollbackApproval = { approval: apr.status, statuses: twins.map((t) => t.status), salesCreated: created, stockDelta: s1 - (await stock(f)), tokenUsedBy: String(used?.saleId) };
      line(`3 concurrent checkouts sharing one single-use approval → ${twins.map((t) => t.status)}; sales ${created}; stock −${s1 - (await stock(f))} (expect 1); token bound to the one sale: ${twins.some((t) => t.body.id === String(used?.saleId))}`);

      // concurrent void-status sales on final units
      const g = await fixture([3]);
      const ph2 = phone();
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => http(i % 2 ? S2 : S1, "POST", "/api/sales", i % 2 ? cashier : cashier2, { customerPhone: ph2, payment: "cash", salesperson: SP, status: "void", idempotencyKey: randomUUID(), lines: [ready(g, 1)] })));
      const ss = await salesFor(ph2);
      out.concurrentVoid = { statuses: rs.map((r) => r.status), voidSales: ss.filter((s) => s.status === "void").length, stock: await stock(g), fifo: await layers(g) };
      line(`6 concurrent "void" checkouts for the last 3 units → ${rs.map((r) => r.status)}; ${out.concurrentVoid.voidSales} void sales; stock 3→${out.concurrentVoid.stock}; FIFO [${out.concurrentVoid.fifo}] — stock gone, zero completed sales`);

      // retry after timeout with status void
      const h = await fixture([5]);
      const key = randomUUID(), ph3 = phone();
      const ac = new AbortController();
      const p = http(S1, "POST", "/api/sales", cashier, { customerPhone: ph3, payment: "cash", salesperson: SP, status: "void", idempotencyKey: key, lines: [ready(h, 2)] }, { signal: ac.signal }).catch(() => ({ status: "aborted" }));
      setTimeout(() => ac.abort(), 15);
      await p; await sleep(1200);
      const retry = await http(S2, "POST", "/api/sales", cashier, { customerPhone: ph3, payment: "cash", salesperson: SP, idempotencyKey: key, lines: [ready(h, 2)] });
      out.voidRetry = { retry: retry.status, deduplicated: retry.body.deduplicated, returnedStatus: retry.body.status, stock: await stock(h) };
      line(`aborted "void" checkout, then a normal retry with the same key → HTTP ${retry.status} deduplicated=${retry.body.deduplicated}, returned status "${retry.body.status}"; stock 5→${await stock(h)} — the retry cannot turn it into a completed sale`);
    }

    // ---------------- PHASE 6: duplicate lookup scope ----------------
    section("PHASE 6 — idempotency duplicate lookup scope");
    {
      const id = await fixture([50]);
      const cases: [string, string, string][] = [["same cashier", cashier, S1], ["another cashier, same branch", cashier2, S1], ["another branch", cashierB, S2], ["owner (all branches)", owner, S1]];
      const rows: any[] = [];
      for (const [label, ck, base] of cases.slice(1)) {
        const key = randomUUID(), phA = phone();
        const a = await sell(cashier, [ready(id, 1)], { customerPhone: phA, customerName: "Private Customer A", idempotencyKey: key, payment: "credit" });
        const phB = phone();
        const s0 = await stock(id);
        const b = await sell(ck, [ready(id, 3)], { customerPhone: phB, idempotencyKey: key }, base);
        const bSales = (await salesFor(phB)).length;
        rows.push({ label, http: b.status, deduplicated: b.body.deduplicated, returnedOtherSale: b.body.id === a.body.id, exposed: b.body.id === a.body.id ? { customerName: b.body.customerName, customerPhone: b.body.customerPhone, total: b.body.total, payment: b.body.payment, salesperson: b.body.salesperson } : null, theirSaleCreated: bSales, stockDelta: s0 - (await stock(id)) });
        line(`${label.padEnd(30)} reuses cashier A's key with a DIFFERENT cart → HTTP ${b.status} dedup=${b.body.deduplicated}; got A's sale: ${b.body.id === a.body.id}${b.body.id === a.body.id ? ` (exposes ${b.body.customerName}, ${b.body.customerPhone}, total ${b.body.total})` : ""}; their own sale created: ${bSales}; stock −${s0 - (await stock(id))}`);
      }
      // same cashier, different cart, same key
      const key = randomUUID(), ph = phone();
      await sell(cashier, [ready(id, 1)], { customerPhone: ph, idempotencyKey: key });
      const diff = await sell(cashier, [ready(id, 4), ready(await fixture([5]), 1)], { customerPhone: ph, idempotencyKey: key, payment: "card" });
      rows.push({ label: "same cashier, different cart", http: diff.status, deduplicated: diff.body.deduplicated, returnedLines: diff.body.lines?.map((l: any) => l.qty) });
      line(`same cashier, same key, DIFFERENT cart+payment → HTTP ${diff.status} dedup=${diff.body.deduplicated}; returned original lines qty [${diff.body.lines?.map((l: any) => l.qty)}] payment ${diff.body.payment} — no mismatch signal`);
      out.duplicateScope = rows;
    }

    // ---------------- PHASE 7: payment + qty ----------------
    section("PHASE 7 — payment method & quantity validation");
    {
      const id = await fixture([500]);
      const pays: [string, any, any?][] = [["cash", "cash"], ["card", "card"], ["bank", "bank"], ["credit", "credit"], ["mixed (balanced)", "mixed", [{ method: "cash", amount: 5 }, { method: "card", amount: 5 }]], ["CARD (upper)", "CARD"], [" card (space)", " card"], ["unknown 'bitcoin'", "bitcoin"], ["empty ''", ""], ["null", null], ["absent", undefined], ["5 (number)", 5], ["{} (object)", {}], ['["card"]', ["card"]], ['{"$ne":null}', { $ne: null }]];
      const payRows: any[] = [];
      for (const [label, v, br] of pays) {
        const ph = phone();
        const body: any = { customerPhone: ph, salesperson: SP, lines: [ready(id, 1)] };
        if (v !== undefined) body.payment = v;
        if (br) body.paymentBreakdown = br;
        const r = await http(S1, "POST", "/api/sales", cashier, body);
        const s = (await salesFor(ph))[0];
        payRows.push({ label, http: r.status, stored: s?.payment ?? "-", silentlyChanged: !!s && typeof v === "string" && v.trim().toLowerCase() !== s.payment, leak: leak(r.text), error: r.body.error });
        line(`payment ${label.padEnd(18)} → HTTP ${r.status}  stored ${String(s?.payment ?? "-").padEnd(6)}${payRows.at(-1).silentlyChanged ? "  ⚠ silently recorded as a different method" : ""}${r.status >= 500 ? `  500 body: ${r.text.slice(0, 120)}` : ""}`);
      }
      out.payment = payRows;
      const qtys: [string, any][] = [["1", 1], ["3", 3], ["0", 0], ["-1", -1], ["1.5", 1.5], ['"2"', "2"], ['" 2 "', " 2 "], ['"abc"', "abc"], ["null", null], ["absent", undefined], ["true", true], ["[2]", [2]], ['"0x2"', "0x2"], ['"2e0"', "2e0"], ["1e9", 1e9], ["1e308", 1e308], ['"1e999"', "1e999"]];
      const qRows: any[] = [];
      for (const [label, q] of qtys) {
        const ph = phone();
        const ln: any = { productId: id, lineType: "ready" };
        if (q !== undefined) ln.qty = q;
        const s0 = await stock(id);
        const r = await http(S1, "POST", "/api/sales", cashier, { customerPhone: ph, payment: "cash", salesperson: SP, lines: [ln] });
        const s = (await salesFor(ph))[0];
        qRows.push({ label, http: r.status, code: r.body.code, storedQty: s?.lines?.[0]?.qty, stockDelta: s0 - (await stock(id)) });
        line(`qty ${label.padEnd(9)} → HTTP ${r.status} ${String(r.body.code ?? "").padEnd(18)} stored qty ${s?.lines?.[0]?.qty ?? "-"}  stock −${s0 - (await stock(id))}`);
      }
      out.quantity = qRows;
    }

    // ---------------- PHASE 8: error leakage + server logging ----------------
    section("PHASE 8 — error leakage (client) vs diagnostics (server log)");
    {
      const id = await fixture([10]);
      const probes: [string, any, any?][] = [["JSON null", undefined, "null"], ["lines [null]", { customerPhone: phone(), lines: [null] }], ["customerPhone number", { customerPhone: 1234567, lines: [ready(id)] }], ["idempotencyKey object", { customerPhone: phone(), idempotencyKey: { a: 1 }, lines: [ready(id)] }], ["payment number", { customerPhone: phone(), payment: 7, lines: [ready(id)] }], ["paymentBreakdown [null]", { customerPhone: phone(), payment: "mixed", paymentBreakdown: [null], lines: [ready(id)] }]];
      const rows: any[] = [];
      for (const [label, body, raw] of probes) {
        const r = await http(S1, "POST", "/api/sales", cashier, body, raw !== undefined ? { raw } : {});
        rows.push({ label, http: r.status, body: r.text.slice(0, 160), leak: leak(r.text) });
        line(`${label.padEnd(24)} → HTTP ${r.status} body ${r.text.slice(0, 110)}`);
      }
      // other routes
      const other = await Promise.all([
        http(S1, "GET", "/api/sales/not-an-id", cashier), http(S1, "PATCH", `/api/sales/${new mongoose.Types.ObjectId()}`, cashier, undefined, { raw: "{bad" }),
        http(S1, "POST", "/api/sales/discount-approval", cashier, undefined, { raw: "null" }), http(S1, "POST", "/api/customers", owner, undefined, { raw: "null" }),
        http(S1, "POST", "/api/quotations", owner, undefined, { raw: "null" }),
      ]);
      ["GET /api/sales/not-an-id", "PATCH /api/sales/:id bad JSON", "POST discount-approval null", "POST /api/customers null", "POST /api/quotations null"].forEach((n, i) => {
        rows.push({ label: n, http: other[i].status, body: other[i].text.slice(0, 160), leak: leak(other[i].text) });
        line(`${n.padEnd(30)} → HTTP ${other[i].status} body ${other[i].text.slice(0, 100)}`);
      });
      await sleep(500);
      const log = fs.readFileSync(LOG, "utf8");
      const logged = ["Cannot read properties", "is not a function"].map((m) => ({ m, inServerLog: log.includes(m) }));
      out.errorLeak = { rows, serverLog: logged, serverLogBytes: log.length };
      line(`server log (stdout/stderr of instance 1, ${log.length} bytes) contains the 500 causes: ${logged.map((x) => `"${x.m}": ${x.inServerLog}`).join(", ")}`);

      // DB outage instance
      const h = await http(SDOWN, "GET", "/api/health");
      const ses = await http(SDOWN, "GET", "/api/sales", cashier);
      const lg = await http(SDOWN, "POST", "/api/auth/login", undefined, { email: "sales@unich.local", password: "sales123" });
      out.dbDown = { health: { status: h.status, body: h.text.slice(0, 200), leak: leak(h.text) }, authedRequest: { status: ses.status, body: ses.text.slice(0, 120), clearsCookie: /unich_session=;/.test(ses.setCookie) || /Max-Age=0/i.test(ses.setCookie) }, login: { status: lg.status, body: lg.text.slice(0, 200), leak: leak(lg.text) } };
      line(`DB unreachable: /api/health → ${h.status} ${h.text.slice(0, 140)}`);
      line(`DB unreachable: logged-in GET /api/sales → ${ses.status} ${ses.text.slice(0, 80)}; session cookie cleared: ${out.dbDown.authedRequest.clearsCookie}`);
      line(`DB unreachable: login → ${lg.status} ${lg.text.slice(0, 140)}`);
    }

    // ---------------- PHASE 9: lost response + edited cart ----------------
    section("PHASE 9 — lost response, then resubmit (unchanged vs edited cart)");
    {
      const lostThen = async (label: string, first: any, second: (k: string) => any, waitMs = 1200) => {
        const ids = [...new Set([...first.lines, ...second("x").lines].map((l: any) => [l.productId, l.oilProductId]).flat().filter(Boolean))] as string[];
        const before = await Promise.all(ids.map(stock));
        const ph = phone();
        const key1 = randomUUID();
        const ac = new AbortController();
        const p = http(S1, "POST", "/api/sales", cashier, { customerPhone: ph, salesperson: SP, ...first, idempotencyKey: key1 }, { signal: ac.signal }).then((r) => String(r.status)).catch(() => "aborted (response lost)");
        setTimeout(() => ac.abort(), 20);
        const firstOutcome = await p;
        await sleep(waitMs);
        const committedAfterLoss = (await salesFor(ph)).length;
        const r2 = await http(S2, "POST", "/api/sales", cashier, { customerPhone: ph, salesperson: SP, ...second(key1) });
        const sales = await salesFor(ph);
        const after = await Promise.all(ids.map(stock));
        const c = await Customer.findOne({ phone: ph }).lean<any>();
        const row = { label, firstOutcome, committedAfterLoss, resubmit: r2.status, deduplicated: r2.body.deduplicated, sales: sales.length, totals: sales.map((s) => s.total), customerTotal: c?.totalPurchases, customerCredit: c?.creditBalance, stockDeltas: ids.map((id, i) => before[i] - after[i]), fifoBatches: sales.map((s) => s.inventoryDeductions.map((d: any) => d.batches.length).reduce((a: number, b: number) => a + b, 0)) };
        line(`${label}\n      1st: client ${firstOutcome}, server committed ${committedAfterLoss}; resubmit → HTTP ${r2.status} dedup=${!!r2.body.deduplicated}; SALES ${sales.length} totals [${row.totals}]; customer +${row.customerTotal} credit +${row.customerCredit}; stock −[${row.stockDeltas}]`);
        return row;
      };
      const a = await fixture([20], { price: 10 }), b = await fixture([20], { price: 7 });
      const base = { payment: "credit", lines: [ready(a, 2)] };
      const rows = [
        await lostThen("A) unchanged cart → UI reuses the key", base, (k) => ({ ...base, idempotencyKey: k })),
        await lostThen("B) cashier adds an item → UI fingerprint changes → NEW key", base, () => ({ ...base, lines: [ready(a, 2), ready(b, 1)], idempotencyKey: randomUUID() })),
        await lostThen("C) cashier changes qty 2→3 → NEW key", base, () => ({ ...base, lines: [ready(a, 3)], idempotencyKey: randomUUID() })),
        await lostThen("D) cashier switches payment credit→cash → NEW key", base, () => ({ payment: "cash", lines: [ready(a, 2)], idempotencyKey: randomUUID() })),
        await lostThen("E) edited cart but SAME key (if the key were kept per bill)", base, (k) => ({ ...base, lines: [ready(a, 2), ready(b, 1)], idempotencyKey: k })),
      ];
      // remix variant
      const remix = await Product.findOne({ sku: "RM-STD" }).lean<any>();
      const oil = await fixture([100], { unit: "ml", category: "Single Notes", name: `S1 Oil9 ${tag}`, price: 2 });
      const rl = { payment: "cash", lines: [{ productId: String(remix._id), qty: 1, lineType: "remix", oilProductId: oil }] };
      rows.push(await lostThen("F) remix, lost response, then qty 1→2 → NEW key", rl, () => ({ ...rl, lines: [{ ...rl.lines[0], qty: 2 }], idempotencyKey: randomUUID() })));
      out.lostResponse = rows;
    }
  } finally {
    for (const s of servers) { try { process.kill(-(s.pid as number), "SIGTERM"); } catch { /* */ } }
    await sleep(800);
    fs.writeFileSync(process.env.QA_OUT || path.join(os.tmpdir(), "qa-s1-investigation.json"), JSON.stringify(out, null, 2));
    await mongoose.disconnect();
  }
}
main().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
