/**
 * Staged stress / breaking-point harness (npm run test:stress).
 *
 * Drives an ALREADY RUNNING, isolated `next start` (STRESS_BASE) that points
 * at the same throwaway local MongoDB as DATABASE_URL, with synthetic data
 * only. Every phase is bounded (concurrency, duration, request count) and the
 * run stops a stage early on any hard limit (error rate, p95, server RSS).
 * After each stage it re-checks business invariants and a short baseline.
 *
 *   STRESS_BASE=http://127.0.0.1:3971 STRESS_METRICS_FILE=<server metrics jsonl> \
 *   SESSION_SECRET=<same as server> \
 *   DATABASE_URL='mongodb://127.0.0.1:27520/unich_stress?replicaSet=rs0&directConnection=true' \
 *     npm run test:stress -- seed,baseline,mixed,rate,lists,reports,cart,body,import,auth,dbfault
 *
 * Safety: refuses any non-local DATABASE_URL / STRESS_BASE, and any database
 * whose name does not start with "unich_stress".
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import mongoose from "mongoose";
import * as XLSX from "xlsx";
import { assertLocalDb } from "../../src/lib/e2eGuard";

assertLocalDb();
const env = process.env as Record<string, string | undefined>;
const BASE = env.STRESS_BASE || "http://127.0.0.1:3971";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) {
  console.error("Refusing to run: STRESS_BASE must be a local http://127.0.0.1:<port> server.");
  process.exit(2);
}
const METRICS_FILE = env.STRESS_METRICS_FILE || "";
const OUT = env.STRESS_OUT || "";
/** The server's DATABASE_URL carries ?appName=<this>, so fail points hit only the server, not this harness. */
const SERVER_APP = env.STRESS_SERVER_APPNAME || "unich-stress-server";

/* ---------- hard limits (never exceeded) ---------- */
const LIMIT = {
  maxConcurrency: Number(env.STRESS_MAX_CONCURRENCY || 96),
  stageSeconds: Number(env.STRESS_STAGE_S || 20),
  maxRequestsPerStage: 40_000,
  stopErrorRate: 0.05, // 5xx + network errors / all
  stopP95Ms: 10_000,
  stopRssMb: Number(env.STRESS_STOP_RSS_MB || 1400),
  requestTimeoutMs: 30_000,
};
const DATA = {
  products: Number(env.STRESS_PRODUCTS || 3000),
  hotProducts: 6,
  hotLayers: 400, // FIFO layers per hot product
  customers: Number(env.STRESS_CUSTOMERS || 5000),
  historicSales: Number(env.STRESS_SALES || 20000),
  expenses: 2000,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let checksPassed = 0;
let checksFailed = 0;
const failures: string[] = [];
const report: Record<string, unknown> = { base: BASE, limits: LIMIT, data: DATA, phases: {} };
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    checksPassed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    checksFailed += 1;
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${(err as Error).message.split("\n").slice(0, 4).join("\n    ")}`);
  }
}

/* ---------- HTTP ---------- */
type Res = { status: number; ms: number; bytes: number; body: any; op: string; t: number };
async function http(op: string, method: string, path: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIMIT.requestTimeoutMs);
  try {
    const isForm = body instanceof FormData;
    const res = await fetch(`${BASE}${path}`, {
      method,
      signal: ctl.signal,
      headers: { ...(isForm || body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : isForm ? (body as FormData) : typeof body === "string" ? body : JSON.stringify(body),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    if ((res.headers.get("content-type") || "").includes("json")) {
      try { json = JSON.parse(buf.toString("utf8")); } catch { /* keep null */ }
    }
    return { status: res.status, ms: performance.now() - t0, bytes: buf.length, body: json, op, t: Date.now() };
  } catch (err) {
    return { status: 0, ms: performance.now() - t0, bytes: 0, body: { error: (err as Error).name }, op, t: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- stats ---------- */
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
function summarize(label: string, rs: Res[], wallMs: number, extra: Record<string, unknown> = {}) {
  const ms = rs.map((r) => r.ms);
  const codes: Record<string, number> = {};
  for (const r of rs) codes[r.status] = (codes[r.status] || 0) + 1;
  const serverErr = rs.filter((r) => r.status === 0 || r.status >= 500).length;
  const s = {
    label,
    requests: rs.length,
    rps: +(rs.length / (wallMs / 1000)).toFixed(1),
    p50: Math.round(pct(ms, 50)), p90: Math.round(pct(ms, 90)), p95: Math.round(pct(ms, 95)), p99: Math.round(pct(ms, 99)), max: Math.round(Math.max(0, ...ms)),
    errorRate: +(serverErr / Math.max(1, rs.length)).toFixed(4),
    timeouts: rs.filter((r) => r.status === 0).length,
    codes,
    ...extra,
  };
  console.log(`    ${label}: n=${s.requests} rps=${s.rps} p50=${s.p50} p90=${s.p90} p95=${s.p95} p99=${s.p99} max=${s.max}ms err=${(s.errorRate * 100).toFixed(2)}% codes=${JSON.stringify(codes)}${Object.keys(extra).length ? " " + JSON.stringify(extra) : ""}`);
  return s;
}
function perOp(rs: Res[]) {
  const by: Record<string, Res[]> = {};
  for (const r of rs) (by[r.op] ||= []).push(r);
  return Object.fromEntries(Object.entries(by).map(([op, list]) => {
    const ms = list.map((r) => r.ms);
    const codes: Record<string, number> = {};
    for (const r of list) codes[r.status] = (codes[r.status] || 0) + 1;
    return [op, { n: list.length, p50: Math.round(pct(ms, 50)), p95: Math.round(pct(ms, 95)), max: Math.round(Math.max(...ms)), err5xx: list.filter((r) => r.status === 0 || r.status >= 500).length, codes }];
  }));
}

/* ---------- server metrics (from the preload in the server process) ---------- */
let metricsOffset = 0;
function serverMetricsSince(fromT: number) {
  if (!METRICS_FILE || !fs.existsSync(METRICS_FILE)) return null;
  const lines = fs.readFileSync(METRICS_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  metricsOffset = lines.length;
  const win = lines.filter((l) => l.t >= fromT);
  if (!win.length) return null;
  // `next start` may run more than one node process; the request server is the biggest.
  const byPid: Record<number, any[]> = {};
  for (const l of win) (byPid[l.pid] ||= []).push(l);
  const main = Object.values(byPid).sort((a, b) => Math.max(...b.map((x) => x.rssMb)) - Math.max(...a.map((x) => x.rssMb)))[0];
  return {
    rssMbMax: Math.max(...main.map((l) => l.rssMb)),
    rssMbEnd: main[main.length - 1].rssMb,
    heapMbMax: Math.max(...main.map((l) => l.heapMb)),
    eldP99Max: Math.max(...main.map((l) => l.eldP99)),
    eldMax: Math.max(...main.map((l) => l.eldMax)),
    cpuPctAvg: +(main.reduce((s, l) => s + l.cpuPct, 0) / main.length).toFixed(0),
  };
}
function latestRssMb(): number {
  if (!METRICS_FILE || !fs.existsSync(METRICS_FILE)) return 0;
  const lines = fs.readFileSync(METRICS_FILE, "utf8").trim().split("\n").slice(-6).map((l) => JSON.parse(l));
  return Math.max(0, ...lines.map((l) => l.rssMb));
}
void metricsOffset;

/* ---------- bounded load generators ---------- */
type Op = { name: string; weight: number; run: () => Promise<Res> };
/** Closed loop: `concurrency` workers, each issues the next request when the last returns. */
async function closedLoop(label: string, ops: Op[], concurrency: number, seconds: number) {
  const c = Math.min(concurrency, LIMIT.maxConcurrency);
  const total = ops.reduce((s, o) => s + o.weight, 0);
  const pick = () => { let x = Math.random() * total; for (const o of ops) { x -= o.weight; if (x <= 0) return o; } return ops[0]; };
  const results: Res[] = [];
  const t0 = performance.now();
  const startT = Date.now();
  const deadline = t0 + Math.min(seconds, LIMIT.stageSeconds) * 1000;
  let stopReason = "";
  const watchdog = setInterval(() => {
    const rss = latestRssMb();
    if (rss > LIMIT.stopRssMb) stopReason ||= `server RSS ${rss} MB > ${LIMIT.stopRssMb}`;
    const recent = results.slice(-500);
    if (recent.length >= 200) {
      const bad = recent.filter((r) => r.status === 0 || r.status >= 500).length / recent.length;
      if (bad > LIMIT.stopErrorRate) stopReason ||= `error rate ${(bad * 100).toFixed(1)}% > ${LIMIT.stopErrorRate * 100}%`;
      const p95 = pct(recent.map((r) => r.ms), 95);
      if (p95 > LIMIT.stopP95Ms) stopReason ||= `p95 ${Math.round(p95)} ms > ${LIMIT.stopP95Ms}`;
    }
  }, 250);
  await Promise.all(Array.from({ length: c }, async () => {
    while (performance.now() < deadline && !stopReason && results.length < LIMIT.maxRequestsPerStage) {
      results.push(await pick().run());
    }
  }));
  clearInterval(watchdog);
  const wall = performance.now() - t0;
  const s = summarize(`${label} c=${c}`, results, wall, stopReason ? { STOPPED: stopReason } : {});
  return { ...s, perOp: perOp(results), server: serverMetricsSince(startT), stopReason, results };
}
/** Open loop: fixed arrival rate, independent of response time, with an in-flight cap. */
async function openLoop(label: string, op: Op, rps: number, seconds: number, maxInFlight = 256) {
  const results: Res[] = [];
  const startT = Date.now();
  const t0 = performance.now();
  const n = Math.min(Math.round(rps * Math.min(seconds, LIMIT.stageSeconds)), LIMIT.maxRequestsPerStage);
  let inFlight = 0;
  let shed = 0;
  const pending: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    const due = t0 + (i * 1000) / rps;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    if (latestRssMb() > LIMIT.stopRssMb) break;
    if (inFlight >= maxInFlight) { shed++; continue; }
    inFlight++;
    pending.push(op.run().then((r) => { results.push(r); inFlight--; }));
  }
  await Promise.all(pending);
  const wall = performance.now() - t0;
  const s = summarize(`${label} target=${rps}rps`, results, wall, { offered: n, notSentInFlightCap: shed });
  return { ...s, server: serverMetricsSince(startT), results };
}
const strip = (x: any) => { const { results, ...rest } = x; void results; return rest; };

async function main() {
  const phases = (process.argv[2] || "seed,baseline,mixed").split(",");
  const { connectDB } = await import("../../src/lib/db");
  const M = await import("../../src/lib/models");
  const { testSessionCookie } = await import("../../src/lib/auth/testSession");
  const { hashPassword } = await import("../../src/lib/auth/password");
  await connectDB();
  const db = mongoose.connection.db!;
  const dbName = db.databaseName;
  if (!dbName.startsWith("unich_stress")) {
    console.error(`Refusing to run: database "${dbName}" is not a unich_stress* throwaway DB.`);
    process.exit(2);
  }
  console.log(`DB target: ${mongoose.connection.host}:${mongoose.connection.port}/${dbName} · server ${BASE}`);
  const health = await http("health", "GET", "/api/health", null);
  assert.equal(health.status, 200, `server not healthy at ${BASE}`);

  /* ======================= seed ======================= */
  const oid = () => new mongoose.Types.ObjectId();
  if (phases.includes("seed") || !(await M.Branch.findOne({ code: "STRA" }))) {
    console.log("\n— Seeding synthetic data");
    const t = performance.now();
    await db.dropDatabase();
    await connectDB();
    for (const m of Object.values(M)) if ((m as any)?.syncIndexes) await (m as any).syncIndexes().catch(() => undefined);
    const [bA, bB] = await M.Branch.insertMany([{ name: "Stress A", code: "STRA" }, { name: "Stress B", code: "STRB" }]);
    await M.AppSettings.create({ key: "default", salespeople: ["SP Stress"], activeSalesperson: "SP Stress" });
    const supplierId = oid();
    const products: any[] = [];
    for (let i = 0; i < DATA.products; i++) {
      products.push({ _id: oid(), sku: `ST-${String(i).padStart(6, "0")}`, name: `Stress Perfume ${i} ${["Oud", "Rose", "Amber", "Musk", "Citrus"][i % 5]}`, category: "Brands", unit: "pcs", sellPrice: 10 + (i % 40), wholesalePrice: 8, costFifo: 5, minMarginPct: 0, stockSellable: 1000, lowStockAt: i % 10 === 0 ? 2000 : 0 });
    }
    const hot = products.slice(0, DATA.hotProducts);
    for (const p of hot) p.stockSellable = DATA.hotLayers * 50;
    await M.Product.collection.insertMany(products);
    const layers: any[] = [];
    for (const p of products) {
      const n = hot.includes(p) ? DATA.hotLayers : 1;
      const q = p.stockSellable / n;
      for (let k = 0; k < n; k++) layers.push({ productId: p._id, supplierId, supplierName: "Synthetic", purchaseDate: new Date(Date.now() - (n - k) * 3600e3), qtyRemaining: q, originalQty: q, unitCost: 4 + (k % 3), currency: "OMR", source: "purchase", createdAt: new Date(), updatedAt: new Date() });
    }
    for (let i = 0; i < layers.length; i += 5000) await M.FifoLayer.collection.insertMany(layers.slice(i, i + 5000));
    const customers: any[] = [];
    for (let i = 0; i < DATA.customers; i++) customers.push({ _id: oid(), name: `Customer ${i} ${["Al Balushi", "Al Harthy", "Al Said", "Smith"][i % 4]}`, phone: `+9689${String(1000000 + i)}`, creditBalance: 0, totalPurchases: 0, createdAt: new Date(), updatedAt: new Date() });
    await M.Customer.collection.insertMany(customers);
    const sales: any[] = [];
    for (let i = 0; i < DATA.historicSales; i++) {
      const p = products[(i * 7) % products.length];
      const qty = 1 + (i % 3);
      const at = new Date(Date.now() - (i % 60) * 864e5 - (i % 1000) * 1000);
      sales.push({ customerPhone: customers[i % customers.length].phone, customerName: customers[i % customers.length].name, salesperson: "SP Stress", payment: ["cash", "card", "bank"][i % 3], saleType: "Retail", status: "completed", subtotal: p.sellPrice * qty, total: p.sellPrice * qty, discountTotal: 0, branchId: i % 2 ? bA._id : bB._id, lines: [{ productId: p._id, name: p.name, qty, unitLabel: "pcs", unitPrice: p.sellPrice, lineType: "ready" }], inventoryDeductions: [{ productId: p._id, productName: p.name, qty, reason: "sale", lineIndex: 0, costTotal: 5 * qty, batches: [] }], createdAt: at, updatedAt: at });
    }
    for (let i = 0; i < sales.length; i += 5000) await M.Sale.collection.insertMany(sales.slice(i, i + 5000));
    const expenses: any[] = [];
    for (let i = 0; i < DATA.expenses; i++) expenses.push({ date: new Date(Date.now() - (i % 60) * 864e5), category: ["Rent", "Utilities", "Salaries", "Supplies"][i % 4], detail: `Synthetic ${i}`, amount: 5 + (i % 50), status: "approved", branchId: i % 2 ? bA._id : bB._id, createdAt: new Date(), updatedAt: new Date() });
    await M.Expense.collection.insertMany(expenses);
    console.log(`  seeded ${DATA.products} products (${layers.length} FIFO layers), ${DATA.customers} customers, ${DATA.historicSales} sales, ${DATA.expenses} expenses in ${Math.round(performance.now() - t)} ms`);
  }
  const bA = (await M.Branch.findOne({ code: "STRA" }).lean<any>())!;
  const bB = (await M.Branch.findOne({ code: "STRB" }).lean<any>())!;
  const A = String(bA._id);
  const B = String(bB._id);
  const hot = await M.Product.find({ sku: { $regex: "^ST-00000[0-5]$" } }).sort({ sku: 1 }).lean<any[]>();
  const mk = async (role: any, branchId: string | null) => testSessionCookie({ userId: String(oid()), name: `Stress ${role}`, email: "s@test.local", role, roleLabel: role, branchId, branchName: branchId ? "Stress" : null });
  const ck = {
    owner: await mk("owner", null),
    cashierA: await mk("cashier", A),
    cashierB: await mk("cashier", B),
    accountantA: await mk("accountant", A),
    inventoryA: await mk("inventory", A),
  };
  const creditCustomers = await M.Customer.find().sort({ _id: 1 }).limit(20).lean<any[]>();

  /* ---------- invariants ---------- */
  async function invariants(label: string) {
    const rows = await M.FifoLayer.aggregate([{ $match: { productId: { $in: hot.map((h) => h._id) } } }, { $group: { _id: "$productId", sum: { $sum: "$qtyRemaining" }, neg: { $sum: { $cond: [{ $lt: ["$qtyRemaining", 0] }, 1, 0] } } } }]);
    const prods = await M.Product.find({ _id: { $in: hot.map((h) => h._id) } }).lean<any[]>();
    await check(`[${label}] hot products: stock = Σ FIFO layers, nothing negative`, () => {
      for (const p of prods) {
        const r = rows.find((x) => String(x._id) === String(p._id));
        assert.ok(p.stockSellable >= 0, `${p.sku} stock ${p.stockSellable}`);
        assert.equal(r?.neg ?? 0, 0, `${p.sku} negative layer`);
        assert.ok(Math.abs((r?.sum ?? 0) - p.stockSellable) < 1e-6, `${p.sku} stock ${p.stockSellable} vs layers ${r?.sum}`);
      }
    });
    await check(`[${label}] stress sales: total = Σ lines; deducted qty = sold qty; one sale per idempotency key`, async () => {
      const sales = await M.Sale.find({ salesperson: "SP Stress", idempotencyKey: { $exists: true } }).lean<any[]>();
      for (const s of sales) {
        const lineSum = s.lines.reduce((t: number, l: any) => t + l.qty * l.unitPrice - (l.discountAmount || 0), 0) - (s.invoiceDiscountAmount || 0);
        assert.ok(Math.abs(Math.round(lineSum * 1000) / 1000 - s.total) < 0.0011 || (s.discountTotal ?? 0) > 0, `sale ${s._id} total ${s.total} vs lines ${lineSum}`);
        const sold = s.lines.reduce((t: number, l: any) => t + l.qty, 0);
        const ded = (s.inventoryDeductions || []).reduce((t: number, d: any) => t + d.qty, 0);
        if (s.status === "completed") assert.equal(ded, sold, `sale ${s._id} deducted ${ded} sold ${sold}`);
      }
      const dup = await M.Sale.aggregate([{ $match: { idempotencyKey: { $exists: true, $ne: null } } }, { $group: { _id: "$idempotencyKey", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 3 }]);
      assert.equal(dup.length, 0, `duplicate keys ${JSON.stringify(dup)}`);
    });
    await check(`[${label}] credit balances = Σ credit sales per customer`, async () => {
      for (const c of creditCustomers) {
        const cur = await M.Customer.findById(c._id).lean<any>();
        const agg = await M.Sale.aggregate([{ $match: { customerId: c._id, status: "completed" } }, { $group: { _id: null, credit: { $sum: { $cond: [{ $eq: ["$payment", "credit"] }, "$total", 0] } } } }]);
        const expected = agg[0]?.credit ?? 0;
        assert.ok(Math.abs((cur.creditBalance || 0) - expected) < 0.0011, `${c.name}: balance ${cur.creditBalance} vs credit sales ${expected}`);
      }
    });
  }

  /* ---------- workload ---------- */
  const terms = ["Oud", "Rose", "Perfume 12", "ST-0001", "Amber", "Musk 3"];
  const rnd = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  const checkout = (cookie = ck.cashierA, lines = 1 + Math.floor(Math.random() * 3)) => {
    const credit = Math.random() < 0.2;
    const cust = rnd(creditCustomers);
    const body: any = {
      customerPhone: credit ? cust.phone : "+96890000001",
      ...(credit ? { customerId: String(cust._id), customerName: cust.name } : {}),
      salesperson: "SP Stress",
      payment: credit ? "credit" : rnd(["cash", "card", "bank"]),
      lines: Array.from({ length: lines }, () => ({ productId: String(rnd(hot)._id), qty: 1, lineType: "ready" })),
      idempotencyKey: randomUUID(),
    };
    return http("checkout", "POST", "/api/sales", cookie, body);
  };
  const OPS: Op[] = [
    { name: "search", weight: 30, run: () => http("product-search", "GET", `/api/products?q=${encodeURIComponent(rnd(terms))}`, ck.cashierA) },
    { name: "checkout", weight: 25, run: () => checkout() },
    { name: "held", weight: 10, run: () => http("held-bills", "GET", "/api/sales?status=held&limit=20", ck.cashierA) },
    { name: "customers", weight: 10, run: () => http("customer-search", "GET", `/api/customers?q=${encodeURIComponent(rnd(["Al", "Smith", "+96891000", "Customer 4"]))}`, ck.cashierA) },
    { name: "dashboard", weight: 5, run: () => http("dashboard", "GET", "/api/dashboard", rnd([ck.owner, ck.cashierA, ck.accountantA])) },
    { name: "report", weight: 5, run: () => http("report", "GET", `/api/reports/engine/${rnd(["sales-by-product", "cash-closing", "sales-by-payment-method", "profit-margin-daily"])}`, ck.accountantA) },
    { name: "adjust", weight: 5, run: () => http("adjustment", "POST", "/api/inventory/adjustments", ck.inventoryA, { productId: String(rnd(hot)._id), qty: 1, direction: rnd(["in", "out"]), idempotencyKey: randomUUID() }) },
    { name: "bell", weight: 5, run: () => http("notifications", "GET", "/api/notifications", rnd([ck.owner, ck.cashierA, ck.inventoryA])) },
    { name: "isolation", weight: 5, run: async () => {
      // Cross-branch read under load must stay 403 / filtered.
      const r = await http("cross-branch", "GET", "/api/sales?status=all&limit=50", ck.cashierB);
      if (r.status === 200 && Array.isArray(r.body) && r.body.some((s: any) => String(s.branchId) === A)) r.status = 599; // flag a leak
      return r;
    } },
  ];

  const phasesOut = report.phases as Record<string, unknown>;

  /* ======================= baseline ======================= */
  let baseline: any = null;
  if (phases.includes("baseline") || phases.includes("mixed")) {
    console.log("\n— Baseline (mixed workload, 2 concurrent users, 20 s)");
    baseline = await closedLoop("baseline", OPS, 2, 20);
    phasesOut.baseline = strip(baseline);
    await invariants("baseline");
  }

  /* ======================= staged mixed ======================= */
  if (phases.includes("mixed")) {
    console.log("\n— Staged mixed workload (closed loop): 2× 3× 5× 10× 20× 40× baseline users");
    const stages: any[] = [];
    for (const mult of [2, 3, 5, 10, 20, 40]) {
      const s = await closedLoop(`stage ${mult}×`, OPS, 2 * mult, LIMIT.stageSeconds);
      stages.push(strip(s));
      await invariants(`after ${mult}×`);
      const leak = s.results.filter((r: Res) => r.op === "cross-branch" && r.status === 599).length;
      await check(`[${mult}×] no cross-branch sale leaked under load`, () => assert.equal(leak, 0));
      // recovery: back to baseline for 8 s
      const rec = await closedLoop(`recovery after ${mult}×`, OPS, 2, 8);
      stages[stages.length - 1].recovery = { p50: rec.p50, p95: rec.p95, errorRate: rec.errorRate, server: rec.server };
      if (s.stopReason) { console.log(`    stopping escalation: ${s.stopReason}`); break; }
    }
    phasesOut.mixed = stages;
  }

  /* ======================= each operation alone ======================= */
  if (phases.includes("isolate")) {
    console.log("\n— Each operation alone (closed loop, 4 users, 8 s) — attributes event-loop / CPU cost");
    const out: any[] = [];
    for (const op of OPS) {
      const tx0 = (await db.admin().command({ serverStatus: 1 })).transactions;
      const s = await closedLoop(`only ${op.name}`, [op], 4, 8);
      const tx1 = (await db.admin().command({ serverStatus: 1 })).transactions;
      const tx = { committed: tx1.totalCommitted - tx0.totalCommitted, aborted: tx1.totalAborted - tx0.totalAborted, started: tx1.totalStarted - tx0.totalStarted };
      console.log(`      server ${JSON.stringify(s.server)} tx ${JSON.stringify(tx)}`);
      out.push({ ...strip(s), tx });
    }
    phasesOut.isolate = out;
    await invariants("after isolate");
  }

  /* ======================= soak: memory growth ======================= */
  if (phases.includes("soak")) {
    console.log("\n— Soak: 10 consecutive 20 s stages at 5× (10 users) — server memory trend");
    const out: any[] = [];
    for (let i = 0; i < 10; i++) {
      const s = await closedLoop(`soak ${i + 1}/10`, OPS, 10, 20);
      out.push({ i: i + 1, rps: s.rps, p95: s.p95, errorRate: s.errorRate, rssMbEnd: s.server?.rssMbEnd, heapMbMax: s.server?.heapMbMax });
      if (s.stopReason) break;
    }
    await sleep(10_000);
    const idle = serverMetricsSince(Date.now() - 3000);
    console.log(`    RSS per stage end: ${out.map((o) => o.rssMbEnd).join(" → ")} MB; idle 10 s later: ${idle?.rssMbEnd ?? "?"} MB`);
    phasesOut.soak = { stages: out, idleAfter: idle };
    await invariants("after soak");
  }

  /* ======================= open-loop checkout rate ======================= */
  if (phases.includes("rate")) {
    console.log("\n— Checkout at fixed arrival rates (open loop, 15 s each)");
    const out: any[] = [];
    for (const rps of [5, 10, 20, 40, 80]) {
      const s = await openLoop("checkout", { name: "checkout", weight: 1, run: () => checkout() }, rps, 15);
      out.push(strip(s));
      await invariants(`after ${rps} rps`);
      if (s.errorRate > LIMIT.stopErrorRate || s.p95 > LIMIT.stopP95Ms) { console.log("    stopping escalation"); break; }
    }
    phasesOut.rate = out;
  }

  /* ======================= unbounded list payloads ======================= */
  if (phases.includes("lists")) {
    console.log("\n— List endpoints over the synthetic dataset (single request each, then 8 concurrent)");
    const lists: [string, string, string][] = [
      ["products (all)", "/api/products", ck.cashierA],
      ["customers (all)", "/api/customers", ck.cashierA],
      ["fifo-layers (all)", "/api/fifo-layers", ck.inventoryA],
      ["expenses (all)", "/api/expenses", ck.accountantA],
      ["sales limit=500", "/api/sales?limit=500", ck.owner],
      ["dashboard", "/api/dashboard", ck.owner],
      ["notifications", "/api/notifications", ck.inventoryA],
      ["product export xlsx", "/api/products/export", ck.inventoryA],
    ];
    const out: any[] = [];
    for (const [label, path, cookie] of lists) {
      const startT = Date.now();
      const one = await http(label, "GET", path, cookie);
      const conc = await Promise.all(Array.from({ length: 8 }, () => http(label, "GET", path, cookie)));
      const row = { label, status: one.status, bytes: one.bytes, items: Array.isArray(one.body) ? one.body.length : one.body?.items?.length, singleMs: Math.round(one.ms), conc8P95: Math.round(pct(conc.map((r) => r.ms), 95)), conc8Statuses: [...new Set(conc.map((r) => r.status))], server: serverMetricsSince(startT) };
      console.log(`    ${label}: ${row.status} ${(row.bytes / 1024).toFixed(0)} KB items=${row.items ?? "-"} single=${row.singleMs}ms 8×p95=${row.conc8P95}ms eldMax=${row.server?.eldMax ?? "?"}ms rssMax=${row.server?.rssMbMax ?? "?"}MB`);
      out.push(row);
    }
    phasesOut.lists = out;
  }

  /* ======================= reports concurrency ======================= */
  if (phases.includes("reports")) {
    console.log("\n— Reports over 20k sales, rising concurrency (closed loop, 15 s)");
    const ids = ["sales-by-product", "cash-closing", "profit-margin-daily", "sales-by-payment-method", "expenses-by-category", "inventory-status", "inventory-ageing", "customers-overview"];
    const out: any[] = [];
    for (const c of [1, 4, 8, 16]) {
      const s = await closedLoop("reports", [{ name: "r", weight: 1, run: () => { const id = rnd(ids); return http(`report:${id}`, "GET", `/api/reports/engine/${id}?from=2000-01-01`, ck.owner); } }], c, 15);
      out.push(strip(s));
      if (s.stopReason) break;
    }
    phasesOut.reports = out;
  }

  /* ======================= large carts ======================= */
  if (phases.includes("cart")) {
    console.log("\n— Large carts (each line 1 unit of a hot product)");
    const out: any[] = [];
    for (const n of [10, 50, 100, 250, 500, 1000]) {
      const startT = Date.now();
      const r = await checkout(ck.cashierA, n);
      const row = { lines: n, status: r.status, ms: Math.round(r.ms), code: r.body?.code, server: serverMetricsSince(startT) };
      console.log(`    ${n} lines → ${r.status} in ${row.ms} ms ${r.body?.code ?? ""} eldMax=${row.server?.eldMax ?? "?"}ms`);
      out.push(row);
      if (r.ms > LIMIT.stopP95Ms) break;
    }
    phasesOut.cart = out;
    await invariants("after large carts");
  }

  /* ======================= oversized bodies ======================= */
  if (phases.includes("body")) {
    console.log("\n— Oversized JSON bodies on POST /api/sales (bounded at 32 MB)");
    const out: any[] = [];
    const before = await M.Sale.countDocuments();
    for (const mb of [1, 4, 16, 32]) {
      const pad = "x".repeat(mb * 1024 * 1024);
      const startT = Date.now();
      const r = await http("big-body", "POST", "/api/sales", ck.cashierA, JSON.stringify({ customerPhone: "+96890000001", salesperson: "SP Stress", payment: "cash", lines: [{ productId: String(hot[0]._id), qty: 1, lineType: "ready" }], idempotencyKey: randomUUID(), notes: pad }));
      const row = { mb, status: r.status, ms: Math.round(r.ms), server: serverMetricsSince(startT) };
      console.log(`    ${mb} MB → ${r.status} in ${row.ms} ms rssMax=${row.server?.rssMbMax ?? "?"}MB`);
      out.push(row);
    }
    // the same, concurrently, at the size the app accepts
    const startT = Date.now();
    const pad = "x".repeat(8 * 1024 * 1024);
    const conc = await Promise.all(Array.from({ length: 8 }, () => http("big-body-8x", "POST", "/api/sales", ck.cashierA, JSON.stringify({ customerPhone: "+96890000001", salesperson: "SP Stress", payment: "cash", lines: [{ productId: String(hot[0]._id), qty: 1, lineType: "ready" }], idempotencyKey: randomUUID(), notes: pad }))));
    const row = { concurrent: 8, mbEach: 8, statuses: conc.map((r) => r.status), p95: Math.round(pct(conc.map((r) => r.ms), 95)), server: serverMetricsSince(startT) };
    console.log(`    8 × 8 MB concurrently → ${JSON.stringify(row.statuses)} p95=${row.p95}ms rssMax=${row.server?.rssMbMax ?? "?"}MB`);
    out.push(row);
    phasesOut.body = { results: out, salesCreated: (await M.Sale.countDocuments()) - before };
    await invariants("after big bodies");
  }

  /* ======================= imports ======================= */
  if (phases.includes("import")) {
    console.log("\n— Product import staging at rising row counts");
    const out: any[] = [];
    for (const rows of [500, 2000, 5000, 10000, 20000]) {
      const data = Array.from({ length: rows }, (_, i) => ({ "Internal Code": `IMP-${rows}-${i}`, "Product Name": `Imported ${rows} ${i} ${"Lorem ipsum dolor sit amet ".repeat(2)}`, Category: "Brands", Brand: "Synthetic", Concentration: "EDP", Unit: "pcs", "Cost Price": 5, "Retail Price": 12, "Wholesale Price": 9, Gender: "Unisex", Size: "100ml", Collection: "Stress", Notes: "synthetic row for stress test", "Item Type": "finished" }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "Products");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
      const fd = new FormData();
      fd.append("file", new Blob([new Uint8Array(buf)]), `stress-${rows}.xlsx`);
      const startT = Date.now();
      const r = await http("import-stage", "POST", "/api/products/import/stage", ck.owner, fd);
      const row = { rows, fileKb: Math.round(buf.length / 1024), status: r.status, ms: Math.round(r.ms), error: r.status >= 400 ? r.body?.error : undefined, server: serverMetricsSince(startT) };
      console.log(`    ${rows} rows (${row.fileKb} KB) → ${r.status} in ${row.ms} ms ${row.error ?? ""} eldMax=${row.server?.eldMax ?? "?"}ms rssMax=${row.server?.rssMbMax ?? "?"}MB`);
      out.push(row);
      if (r.ms > 60_000) break;
    }
    phasesOut.import = out;
  }

  /* ======================= auth under load ======================= */
  if (phases.includes("auth")) {
    console.log("\n— Authentication under load");
    // distinct users, correct passwords, logging in at the same time
    const pw = "Stress-Pass-1";
    const users = [];
    for (let i = 0; i < 30; i++) users.push({ name: `Login ${i}`, email: `login-${i}-${Date.now()}@stress.invalid`, passwordHash: hashPassword(pw), role: "cashier", roleLabel: "Cashier", branchId: bA._id, branchName: "Stress A", active: true });
    await M.User.insertMany(users);
    let t = performance.now();
    const logins = await Promise.all(users.map((u) => http("login", "POST", "/api/auth/login", null, { email: u.email, password: pw })));
    const ls = summarize("30 concurrent valid logins", logins, performance.now() - t);
    await check("concurrent valid logins all succeed", () => assert.deepEqual([...new Set(logins.map((r) => r.status))], [200]));
    // malformed / forged sessions at volume — must all be 401, never 200/500
    const forged = ["unich_session=garbage", "unich_session=eyJ1c2VySWQiOiJ4In0.AAAA", "unich_session=", `unich_session=${"A".repeat(4096)}`];
    t = performance.now();
    const bad = await closedLoop("forged sessions", [{ name: "f", weight: 1, run: () => http("forged", "GET", rnd(["/api/sales", "/api/users", "/api/dashboard", "/api/products"]), rnd(forged)) }], 50, 10);
    await check("forged/malformed sessions under load: all 401", () => assert.deepEqual(Object.keys(bad.codes), ["401"]));
    // repeated unauthorized (valid session, wrong role) — all 403
    const deny = await closedLoop("cashier → owner-only", [{ name: "d", weight: 1, run: () => http("deny", "GET", rnd(["/api/users", "/api/branches", "/api/reports/engine/branch-performance"]), ck.cashierA) }], 50, 10);
    await check("wrong-role requests under load: all 403", () => assert.deepEqual(Object.keys(deny.codes), ["403"]));
    phasesOut.auth = { logins: ls, forged: strip(bad), wrongRole: strip(deny) };
  }

  /* ======================= DB faults ======================= */
  if (phases.includes("dbfault")) {
    console.log("\n— Database faults during a steady 4-user mixed load");
    const { MongoClient } = await import("mongodb");
    const control = await MongoClient.connect(env.DATABASE_URL!, { appName: "stress-control" });
    const admin = control.db("admin");
    const out: Record<string, unknown> = {};
    // (a) slow database: every find / aggregate on sales & products blocks 2.5 s for 10 s
    try {
      await admin.command({ configureFailPoint: "failCommand", mode: "alwaysOn", data: { failCommands: ["find", "aggregate"], blockConnection: true, blockTimeMS: 2500, appName: SERVER_APP } });
    } catch (e) {
      console.log(`    fail points unavailable (${(e as Error).message}) — slow-DB case BLOCKED`);
    }
    const slowStart = Date.now();
    const slowP = closedLoop("slow DB (2.5 s per read)", OPS, 4, 10);
    await sleep(10_500);
    await admin.command({ configureFailPoint: "failCommand", mode: "off" }).catch(() => undefined);
    const slow = await slowP;
    out.slowDb = strip(slow);
    const afterSlow = await closedLoop("recovery after slow DB", OPS, 2, 8);
    out.recoveryAfterSlow = strip(afterSlow);
    void slowStart;
    await invariants("after slow DB");
    // (b) reads fail outright (network-style errors) for 6 s
    await admin.command({ configureFailPoint: "failCommand", mode: "alwaysOn", data: { failCommands: ["find", "aggregate", "insert", "update", "findAndModify"], closeConnection: true, appName: SERVER_APP } }).catch(() => undefined);
    const downP = closedLoop("DB connections dropped", OPS, 4, 6);
    await sleep(6_200);
    await admin.command({ configureFailPoint: "failCommand", mode: "off" }).catch(() => undefined);
    const down = await downP;
    out.dbDropped = strip(down);
    await check("DB dropped: no response leaks internals (no stack / connection string)", () => {
      for (const r of down.results) {
        const txt = JSON.stringify(r.body || "");
        assert.ok(!/mongodb:\/\/|at \w+ \(|MongoNetworkError|stack/i.test(txt), txt.slice(0, 200));
      }
    });
    const t0 = performance.now();
    let firstOk = -1;
    while (performance.now() - t0 < 30_000) {
      const r = await http("probe", "GET", "/api/products?q=Oud", ck.cashierA);
      if (r.status === 200) { firstOk = Math.round(performance.now() - t0); break; }
      await sleep(200);
    }
    out.recoveryMsAfterDrop = firstOk;
    console.log(`    first successful request after the fault cleared: ${firstOk} ms`);
    const afterDown = await closedLoop("recovery after dropped connections", OPS, 2, 8);
    out.recoveryAfterDrop = strip(afterDown);
    await invariants("after dropped connections");
    await control.close();
    phasesOut.dbfault = out;
  }

  /* ======================= pool saturation ======================= */
  if (phases.includes("pool")) {
    console.log("\n— Connection-pool saturation: 96 concurrent checkouts while reads are slowed");
    const { MongoClient } = await import("mongodb");
    const control = await MongoClient.connect(env.DATABASE_URL!, { appName: "stress-control" });
    const admin = control.db("admin");
    await admin.command({ configureFailPoint: "failCommand", mode: "alwaysOn", data: { failCommands: ["find"], blockConnection: true, blockTimeMS: 400, appName: SERVER_APP } });
    const salesBefore = await M.Sale.countDocuments({ salesperson: "SP Stress" });
    const s = await closedLoop("pool saturation", [{ name: "c", weight: 1, run: () => checkout() }], 96, 12);
    await admin.command({ configureFailPoint: "failCommand", mode: "off" });
    await control.close();
    // Requests the client gave up on (status 0) may still be queued in the server.
    await sleep(15_000);
    const created = (await M.Sale.countDocuments({ salesperson: "SP Stress" })) - salesBefore;
    const ok = s.results.filter((r: Res) => r.status === 201).length;
    const abandoned = s.results.filter((r: Res) => r.status === 0).length;
    console.log(`    sales answered 201: ${ok}; client timeouts: ${abandoned}; sales actually created: ${created} (→ ${created - ok} completed after the client gave up)`);
    phasesOut.pool = { ...strip(s), answered201: ok, clientTimeouts: abandoned, salesCreated: created };
    await invariants("after pool saturation");
  }

  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  await mongoose.disconnect();
  console.log(`\nchecks: ${checksPassed} passed, ${checksFailed} failed`);
  if (failures.length) console.log(`Failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(checksFailed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
