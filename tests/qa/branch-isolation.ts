/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// QA suite: branch-isolation — run via `npm run test:qa` (local throwaway DB only).
/** Verifies the 3 remaining fixes: quotation salesperson, branch isolation, no stale salesperson across instances. Local DB only. */
import { assertLocalDb } from "../../src/lib/e2eGuard";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, Product, Quotation, Sale, User, FifoLayer } from "../../src/lib/models";
import { testSessionCookie } from "../../src/lib/auth/testSession";

assertLocalDb();
const S1 = "http://localhost:3952", S2 = "http://localhost:3959";
const A = "SP Alpha", B = "SP Bravo", C = "SP Charlie", D = "SP Delta";
let pass = 0, fail = 0;
const rec = (n: string, ok: boolean, d: string) => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗"} ${n} — ${d}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function req(base: string, method: string, path: string, cookie?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}
function start(port: number): ChildProcess {
  return spawn("npx", ["next", "start", "-p", String(port)], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
}

async function main() {
  await connectDB();
  const branch = await Branch.findOne().lean<any>();
  const other = String(new mongoose.Types.ObjectId());
  const mk = async (role: string, branchId: string | null) => {
    const u = (await User.findOne({ role }).lean<any>())!;
    return (await testSessionCookie({ userId: String(u._id), name: u.name, email: u.email, role: role as any, roleLabel: role, branchId, branchName: branchId ? branch.name : null }));
  };
  const ck = {
    owner: await mk("owner", String(branch._id)),
    manager: await mk("manager", String(branch._id)),
    cashier: await mk("cashier", String(branch._id)),
    bmOther: await mk("branch_manager", other),
    bmNone: await mk("branch_manager", null),
    accNone: await mk("accountant", null),
  };
  await AppSettings.updateOne({ key: "default" }, { $set: { salespeople: [A, B, C], activeSalesperson: A } });
  const p0 = (await (async () => { const p = await Product.create({ sku: `FIX-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, name: "Fixture Perfume", category: "Perfume", unit: "pcs", sellPrice: 50, costFifo: 10, stockSellable: 5000 }); await FifoLayer.create({ productId: p._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 864e5), qtyRemaining: 5000, originalQty: 5000, unitCost: 10, currency: "OMR" }); return p.toObject() as any; })());

  // Fresh approved quotations (clones of a seeded one, test DB only).
  const tmpl = (await Quotation.findOne({ "lines.0": { $exists: true } }).lean<any>())!;
  const qIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { _id, approvalToken, approvalTokenExpiresAt, convertedToSaleId, convertedAt, ...rest } = tmpl;
    const q = await Quotation.collection.insertOne({
      ...rest,
      _id: new mongoose.Types.ObjectId(),
      number: `${tmpl.number}-QA${Date.now()}-${i}`,
      status: "approved",
      branchId: branch._id,
      lines: [{ productId: p0._id, name: p0.name, qty: 1, unitLabel: "pcs", unitPrice: p0.sellPrice, lineType: "ready", charges: 0 }],
      subtotal: p0.sellPrice,
      total: p0.sellPrice,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    qIds.push(String(q.insertedId));
  }

  const servers = [start(3952), start(3959)];
  try {
    for (const base of [S1, S2]) {
      for (let i = 0; i < 240 && (await req(base, "GET", "/api/health").catch(() => ({ status: 0 }))).status !== 200; i++) await sleep(500);
    }

    console.log("Quotation → sale salesperson");
    const conv = async (id: string, salesperson?: unknown) => {
      const r = await req(S1, "POST", `/api/quotations/${id}`, ck.manager, { action: "convert", payment: "cash", ...(salesperson === undefined ? {} : { salesperson }) });
      const sid = r.body.sale?.id;
      return { r, sp: sid ? (await Sale.findById(sid).lean<any>())?.salesperson : undefined };
    };
    const c1 = await conv(qIds[0], B);
    rec("convert with the till's salesperson (B)", c1.r.status === 200 && c1.sp === B, `HTTP ${c1.r.status}, stored "${c1.sp}"`);
    const c2 = await conv(qIds[1], "Mallory");
    const q2 = await Quotation.findById(qIds[1]).lean<any>();
    rec("convert with unknown salesperson → 400, quotation not converted", c2.r.status === 400 && !q2.convertedToSaleId, `HTTP ${c2.r.status} ${c2.r.body.error}; convertedToSaleId=${q2.convertedToSaleId ?? null}`);
    const c3 = await conv(qIds[1]);
    rec("convert with no salesperson → store default (A), not the user's name", c3.r.status === 200 && c3.sp === A, `HTTP ${c3.r.status}, stored "${c3.sp}"`);

    console.log("Branch isolation");
    const today = new Date().toISOString().slice(0, 10);
    const eng = await req(S1, "GET", `/api/reports/engine/sales-by-salesperson?from=${today}&to=${today}`, ck.bmNone);
    rec("report engine: branch manager with no branch → 403", eng.status === 403, `HTTP ${eng.status} ${eng.body.error ?? ""}`);
    const engAcc = await req(S1, "GET", `/api/reports/engine/sales-by-salesperson?from=${today}&to=${today}`, ck.accNone);
    rec("report engine: accountant with no branch → 403", engAcc.status === 403, `HTTP ${engAcc.status}`);
    const engOwner = await req(S1, "GET", `/api/reports/engine/sales-by-salesperson?from=${today}&to=${today}`, ck.owner);
    rec("report engine: owner still sees all", engOwner.status === 200 && (engOwner.body.rows ?? []).length > 0, `HTTP ${engOwner.status} rows=${(engOwner.body.rows ?? []).length}`);

    const ownerListPre = ((await req(S1, "GET", "/api/reports/sales?period=month&limit=2000", ck.owner)).body.sales ?? []) as any[];
    const branchSales = await Sale.countDocuments({ status: "completed", branchId: branch._id });
    const listFor = async (c: string) => ((await req(S1, "GET", "/api/reports/sales?period=month&limit=2000", c)).body.sales ?? []) as any[];
    const ownerList = await listFor(ck.owner);
    const otherList = await listFor(ck.bmOther);
    const noneList = await listFor(ck.bmNone);
    const branchIds = new Set((await Sale.find({ branchId: branch._id }).select("_id").lean<any[]>()).map((x) => String(x._id)));
    const leaks = (xs: any[]) => xs.filter((s) => branchIds.has(String(s.id ?? s._id))).length;
    rec("leak check is meaningful: owner's list contains this branch's sales", leaks(ownerListPre) > 0, `owner rows from this branch: ${leaks(ownerListPre)}`);
    rec("sales report list: other-branch manager sees none of this branch's sales", leaks(otherList) === 0, `owner sees ${ownerList.length}, other-branch ${otherList.length} (leaked ${leaks(otherList)}), DB has ${branchSales} for this branch`);
    rec("sales report list: branchless manager sees no branch's sales", leaks(noneList) === 0, `branchless sees ${noneList.length} (leaked ${leaks(noneList)})`);
    const xls = await fetch(`${S1}/api/reports/sales/export?period=month`, { headers: { Cookie: ck.bmOther } });
    const xlsOwner = await fetch(`${S1}/api/reports/sales/export?period=month`, { headers: { Cookie: ck.owner } });
    const [lenOther, lenOwner] = [(await xls.arrayBuffer()).byteLength, (await xlsOwner.arrayBuffer()).byteLength];
    rec("sales export: other-branch manager's file is smaller than the owner's", xls.status === 200 && lenOther < lenOwner, `bytes other=${lenOther} owner=${lenOwner}`);
    const apiList = (await req(S1, "GET", "/api/sales?limit=500", ck.bmNone)).body;
    const apiRows = (Array.isArray(apiList) ? apiList : apiList.sales ?? []) as any[];
    rec("/api/sales list: branchless manager sees no branch's sales", leaks(apiRows) === 0, `rows ${apiRows.length}, leaked ${leaks(apiRows)}`);

    console.log("Salesperson list changes across server instances (no cache)");
    const sell = (base: string, sp: string) => req(base, "POST", "/api/sales", ck.cashier, { customerPhone: String(73000000 + Math.floor(Math.random() * 1e5)), payment: "cash", salesperson: sp, lines: [{ productId: String(p0._id), qty: 1, lineType: "ready" }], idempotencyKey: randomUUID() });
    await sell(S2, A); // warm instance 2
    const st = (await req(S1, "GET", "/api/settings", ck.manager)).body;
    await req(S1, "PUT", "/api/settings", ck.manager, { ...st, salespeople: [A, B, C, D] });
    const addOn2 = await sell(S2, D);
    rec("added via instance 1 → accepted at once on instance 2", addOn2.status === 201, `HTTP ${addOn2.status}`);
    const st2 = (await req(S1, "GET", "/api/settings", ck.manager)).body;
    await req(S1, "PUT", "/api/settings", ck.manager, { ...st2, salespeople: [A, B, C] });
    const rmOn2 = await sell(S2, D);
    rec("removed via instance 1 → refused at once on instance 2", rmOn2.status === 400, `HTTP ${rmOn2.status} ${rmOn2.body.error ?? ""}`);
    const defOn2 = await req(S2, "POST", "/api/sales", ck.cashier, { customerPhone: "73999999", payment: "cash", lines: [{ productId: String(p0._id), qty: 1, lineType: "ready" }], idempotencyKey: randomUUID() });
    await req(S1, "PUT", "/api/settings", ck.manager, { ...(await req(S1, "GET", "/api/settings", ck.manager)).body, activeSalesperson: C });
    const defOn2b = await req(S2, "POST", "/api/sales", ck.cashier, { customerPhone: "73999998", payment: "cash", lines: [{ productId: String(p0._id), qty: 1, lineType: "ready" }], idempotencyKey: randomUUID() });
    const [d1, d2] = [await Sale.findById(defOn2.body.id).lean<any>(), await Sale.findById(defOn2b.body.id).lean<any>()];
    rec("store default changed via instance 1 → used at once on instance 2", d1?.salesperson === A && d2?.salesperson === C, `before "${d1?.salesperson}", after "${d2?.salesperson}"`);
  } finally {
    for (const s of servers) { try { process.kill(-(s.pid as number), "SIGTERM"); } catch { /* */ } }
    await sleep(1500);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
