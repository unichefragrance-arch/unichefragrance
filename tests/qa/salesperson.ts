/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// QA suite: salesperson — run via `npm run test:qa` (local throwaway DB only).
/** Re-verifies POS-093..096 after the per-bill salesperson fix + remix floor fix. Local DB only. */
import { assertLocalDb } from "../../src/lib/e2eGuard";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, Formula, Product, Sale, User, FifoLayer } from "../../src/lib/models";
import { testSessionCookie } from "../../src/lib/auth/testSession";

assertLocalDb();
const BASE = "http://localhost:3951";
const A = "SP Alpha", B = "SP Bravo", C = "SP Charlie", D = "SP Delta";
let pass = 0, fail = 0;
function rec(name: string, ok: boolean, detail: string) {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name} — ${detail}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type R = { status: number; ms: number; body: Record<string, any> };
async function req(method: string, path: string, cookie?: string, body?: unknown): Promise<R> {
  const t = performance.now();
  const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, ms: performance.now() - t, body: (await res.json().catch(() => ({}))) as any };
}
const pctl = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0); };

async function main() {
  await connectDB();
  const branch = await Branch.findOne().lean<any>();
  const u = async (role: string) => (await User.findOne({ role }).lean<any>())!;
  const cookie = async (role: string, userId?: string) => {
    const x = await u(role);
    return (await testSessionCookie({ userId: userId ?? String(x._id), name: x.name, email: x.email, role: role as any, roleLabel: role, branchId: String(branch._id), branchName: branch.name }));
  };
  const ck = { owner: await cookie("owner"), manager: await cookie("manager"), cashier: await cookie("cashier"), cashier2: await cookie("cashier", String(new mongoose.Types.ObjectId())), bm: await cookie("branch_manager"), acc: await cookie("accountant") };
  await AppSettings.updateOne({ key: "default" }, { $set: { salespeople: [A, B, C], activeSalesperson: A, vatPercent: 0 } });
  const ready = [(await (async () => { const p = await Product.create({ sku: `FIX-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, name: "Fixture Perfume", category: "Perfume", unit: "pcs", sellPrice: 50, costFifo: 10, stockSellable: 5000 }); await FifoLayer.create({ productId: p._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 864e5), qtyRemaining: 5000, originalQty: 5000, unitCost: 10, currency: "OMR" }); return p.toObject() as any; })())];
  const p0 = ready[0];
  let ph = 72000000;
  const sell = (c: string, salesperson: unknown, extra: Record<string, unknown> = {}) =>
    req("POST", "/api/sales", c, { customerPhone: String(++ph), payment: "cash", lines: [{ productId: String(p0._id), qty: 1, lineType: "ready" }], idempotencyKey: randomUUID(), ...(salesperson === undefined ? {} : { salesperson }), ...extra });
  const sp = async (r: R) => (r.status < 300 ? (await Sale.findById(r.body.id).lean<any>())?.salesperson : `HTTP ${r.status} ${r.body.code ?? ""} ${r.body.error ?? ""}`);

  const server = spawn("npx", ["next", "start", "-p", "3951"], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 240 && (await req("GET", "/api/health").catch(() => ({ status: 0 }) as R)).status !== 200; i++) await sleep(500);

    console.log("POS-093/094 per-bill salesperson");
    const s1 = await sell(ck.cashier, A);
    const s2 = await sell(ck.cashier, B);
    const s3 = await sell(ck.cashier, C);
    rec("A then B then C on one till, back-to-back", (await sp(s1)) === A && (await sp(s2)) === B && (await sp(s3)) === C, `${await sp(s1)} / ${await sp(s2)} / ${await sp(s3)}`);
    const seq = [A, B, A, B];
    const last = await sell(ck.cashier, seq[seq.length - 1]);
    rec("rapid A→B→A→B, final B stored", (await sp(last)) === B, String(await sp(last)));
    rec("response carries the stored salesperson (receipt source)", s2.body.salesperson === B, `response.salesperson=${s2.body.salesperson}`);
    const lc = await sell(ck.cashier, "sp bravo");
    rec("case-insensitive match stores the canonical name", (await sp(lc)) === B, String(await sp(lc)));
    const none = await sell(ck.cashier, undefined);
    rec("no salesperson on the bill → store default (Settings active)", (await sp(none)) === A, String(await sp(none)));
    const [t1, t2] = await Promise.all([sell(ck.cashier, A), sell(ck.cashier2, B)]);
    rec("two tills pick A and B and check out together", (await sp(t1)) === A && (await sp(t2)) === B, `${await sp(t1)} / ${await sp(t2)}`);
    const bmS = await sell(ck.bm, C);
    rec("branch manager can assign (no settings permission needed)", (await sp(bmS)) === C, String(await sp(bmS)));

    console.log("POS-096 / validation");
    for (const [label, val] of [["unknown name", "Mallory"], ["whitespace", "   "], ["number", 42], ["object", { $ne: "" }], ["array", [A]], ["5000-char name", "x".repeat(5000)]] as const) {
      const r = await sell(ck.cashier, val);
      const expectReject = label !== "whitespace";
      rec(`salesperson = ${label}`, expectReject ? r.status === 400 && r.body.code === "VALIDATION" : r.status === 201 && (await sp(r)) === A, `HTTP ${r.status} ${expectReject ? String(r.body.error).slice(0, 60) : `stored ${await sp(r)}`}`);
    }
    const sid = await sell(ck.cashier, B, { salespersonId: "unauthorized-user-id" });
    rec("extra salespersonId field has no effect", (await sp(sid)) === B, String(await sp(sid)));
    const accR = await sell(ck.acc, A);
    const anon = await sell(undefined as unknown as string, A);
    rec("accountant 403, unauthenticated 401", accR.status === 403 && anon.status === 401, `${accR.status}/${anon.status}`);
    const before = (await AppSettings.findOne({ key: "default" }).lean<any>())!;
    rec("selling under different salespeople never writes Settings", before.activeSalesperson === A, `active still ${before.activeSalesperson}`);

    console.log("Settings changes take effect immediately");
    const st = (await req("GET", "/api/settings", ck.manager)).body;
    await req("PUT", "/api/settings", ck.manager, { ...st, salespeople: [A, B, C, D] });
    const dS = await sell(ck.cashier, D);
    rec("salesperson added in Settings is usable on the very next sale", (await sp(dS)) === D, String(await sp(dS)));
    const st2 = (await req("GET", "/api/settings", ck.manager)).body;
    await req("PUT", "/api/settings", ck.manager, { ...st2, salespeople: [A, B, C] });
    const gone = await sell(ck.cashier, D);
    rec("removed salesperson is rejected on the next sale", gone.status === 400, `HTTP ${gone.status} ${gone.body.error}`);

    console.log("Hold / resume");
    const h = await req("POST", "/api/sales", ck.cashier, { customerPhone: String(++ph), payment: "cash", status: "held", salesperson: C, lines: [{ productId: String(p0._id), name: p0.name, qty: 1, lineType: "ready", unitPrice: p0.sellPrice }] });
    rec("held bill keeps its own salesperson", (await sp(h)) === C, String(await sp(h)));
    const hBad = await req("POST", "/api/sales", ck.cashier, { customerPhone: String(++ph), payment: "cash", status: "held", salesperson: "Mallory", lines: [{ productId: String(p0._id), name: p0.name, qty: 1, lineType: "ready", unitPrice: p0.sellPrice }] });
    rec("held bill with unknown salesperson rejected", hBad.status === 400, `HTTP ${hBad.status}`);
    await req("PATCH", `/api/sales/${h.body.id}`, ck.cashier, { status: "void" });

    console.log("Duplicate checkout");
    {
      const key = randomUUID();
      const phone = String(++ph);
      const rs = await Promise.all(Array.from({ length: 20 }, () => req("POST", "/api/sales", ck.cashier, { customerPhone: phone, payment: "cash", salesperson: C, lines: [{ productId: String(p0._id), qty: 1, lineType: "ready" }], idempotencyKey: key })));
      // Stored keys are scoped per user + branch (POS-146b): match on the client key part.
      const docs = await Sale.find({ idempotencyKey: { $regex: `\\|k:${key}$` } }).lean<any[]>();
      rec("same bill fired 20× → one sale under C", docs.length === 1 && docs[0].salesperson === C && rs.every((r) => r.status < 300), `sales=${docs.length} salesperson=${docs[0]?.salesperson}`);
    }

    console.log("Load / stress — every request names its own salesperson");
    for (const conc of [50, 100, 200]) {
      const names = [A, B, C];
      const t = performance.now();
      const rs = await Promise.all(Array.from({ length: conc }, async (_, i) => {
        const want = i % 10 === 9 ? "Mallory" : names[i % 3];
        const r = await sell([ck.cashier, ck.cashier2, ck.bm, ck.manager][i % 4], want);
        return { r, want };
      }));
      const wall = performance.now() - t;
      const ok = rs.filter((x) => x.r.status === 201);
      const docs = await Sale.find({ _id: { $in: ok.map((x) => x.r.body.id) } }).select("salesperson").lean<any[]>();
      const byId = new Map(docs.map((d) => [String(d._id), d.salesperson]));
      const wrong = ok.filter((x) => byId.get(String(x.r.body.id)) !== x.want).length;
      const rejected = rs.filter((x) => x.want === "Mallory" && x.r.status === 400).length;
      const ms = rs.map((x) => x.r.ms);
      console.log(`    conc ${conc}: ${(conc / (wall / 1000)).toFixed(1)} req/s p50 ${pctl(ms, 50)}ms p95 ${pctl(ms, 95)}ms p99 ${pctl(ms, 99)}ms`);
      rec(`conc ${conc}: every sale stored under the salesperson it named; unknown names rejected; no 5xx`,
        wrong === 0 && rejected === rs.filter((x) => x.want === "Mallory").length && rs.every((x) => x.r.status < 500) && docs.length === ok.length,
        `ok ${ok.length}, wrong ${wrong}, rejected ${rejected}`);
    }

    console.log("Remix minimum price uses the Remix product's margin");
    {
      const remix = await Product.findOne({ category: "Remix" }).lean<any>();
      const oil = await Product.findOne({ name: "Oud Cambodi Oil" }).lean<any>();
      const r = await req("POST", "/api/sales", ck.cashier, { customerPhone: String(++ph), payment: "cash", salesperson: A, lines: [{ productId: String(remix._id), qty: 1, lineType: "remix", unitLabel: "pcs", oilProductId: String(oil._id) }], idempotencyKey: randomUUID() });
      const msg = String(r.body.error ?? "");
      const floor = Number(/minimum of ([\d.]+)/.exec(msg)?.[1] ?? NaN);
      console.log(`    remix price ${remix.sellPrice}, Remix minMarginPct ${remix.minMarginPct}; checkout HTTP ${r.status} ${msg}`);
      rec("Oud remix blocked: priced below the Remix product's own 45% margin", r.status === 403 && r.body.code === "PRICE_FLOOR_APPROVAL_REQUIRED", `HTTP ${r.status}${Number.isFinite(floor) ? `, floor ${floor}` : ""}`);
      const cheapOil = await Product.findOne({ unit: "ml", category: { $nin: ["Packaging"] }, stockSellable: { $gte: 40 }, name: { $not: /ethanol|alcohol|fixative|oud/i } }).sort({ costFifo: 1 }).lean<any>();
      const r2 = await req("POST", "/api/sales", ck.cashier, { customerPhone: String(++ph), payment: "cash", salesperson: B, lines: [{ productId: String(remix._id), qty: 1, lineType: "remix", unitLabel: "pcs", oilProductId: String(cheapOil._id) }], idempotencyKey: randomUUID() });
      rec(`cashier remix with a cheaper oil (${cheapOil.name}, cost ${cheapOil.costFifo}/ml) sells without approval, salesperson B`, r2.status === 201 && (await sp(r2)) === B, `HTTP ${r2.status} ${r2.body.error ?? `stored ${await sp(r2)}`}`);
    }
  } finally {
    try { process.kill(-(server.pid as number), "SIGTERM"); } catch { /* */ }
    await sleep(1000);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
