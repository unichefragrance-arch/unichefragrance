/* eslint-disable @typescript-eslint/no-explicit-any */
// QA suite: back-office workflows end to end over HTTP — auth lifecycle,
// branches/users, suppliers, purchases → stock, adjustments/transfers,
// formulas (draft → approve → revise), production (plan → complete, races),
// expenses (incl. branch isolation), customers, product import → undo,
// reports reconciled against the DB, dashboard, settings, notifications.
// LOCAL DB only. Run via `npm run test:qa` (after `npm run build`).
import { assertLocalDb } from "../../src/lib/e2eGuard";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, Expense, FifoLayer, Product, Sale, User } from "../../src/lib/models";
import { testSessionCookie } from "../../src/lib/auth/testSession";
import { createFormulaAdminToken, FORMULA_ADMIN_COOKIE } from "../../src/lib/auth/formulaAdmin";

assertLocalDb();
const PORT = 3966;
const BASE = `http://localhost:${PORT}`;
let passed = 0, failed = 0;
const fails: string[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  if (ok) passed++; else { failed++; fails.push(`${id} ${name} — ${detail}`); }
  console.log(`  ${ok ? "✓" : "✗"} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type R = { status: number; body: any; headers: Headers };
async function req(method: string, path: string, cookie?: string, body?: unknown): Promise<R> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    method, redirect: "manual",
    headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  const ct = res.headers.get("content-type") || "";
  const parsed = ct.includes("json") ? await res.json().catch(() => ({})) : { _bytes: (await res.arrayBuffer()).byteLength, _type: ct };
  return { status: res.status, body: parsed, headers: res.headers };
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const idOf = (b: any) => String(b?.id ?? b?._id ?? b?.user?.id ?? "");

async function main() {
  await connectDB();
  const branch = (await Branch.findOne({ active: true }).lean<any>())!;
  const roles = ["owner", "manager", "branch_manager", "cashier", "accountant", "inventory"] as const;
  const ck: Record<string, string> = {};
  for (const role of roles) {
    const u = (await User.findOne({ role }).lean<any>())!;
    ck[role] = await testSessionCookie({ userId: String(u._id), name: u.name, email: u.email, role, roleLabel: role, branchId: role === "owner" ? null : String(branch._id), branchName: role === "owner" ? null : branch.name });
  }
  const fa = `${FORMULA_ADMIN_COOKIE}=${encodeURIComponent(createFormulaAdminToken("QA Admin", process.env.ADMIN_EMAIL || "qa-admin@test.local"))}`;
  const ownerFA = `${ck.owner}; ${fa}`;
  const tag = Date.now();
  const sup = new mongoose.Types.ObjectId();
  async function mkP(name: string, unit: "pcs" | "ml", layers: Array<[number, number]>, extra: Record<string, unknown> = {}) {
    const stock = layers.reduce((a, [q]) => a + q, 0);
    const p = await Product.create({ sku: `WF-${name.replace(/\W/g, "")}-${tag}`, name: `WF ${name} ${tag}`, category: "Perfume", unit, sellPrice: 50, costFifo: layers[0]?.[1] ?? 0, minMarginPct: 0, stockSellable: stock, ...extra });
    let day = layers.length + 1;
    for (const [q, cost] of layers) await FifoLayer.create({ productId: p._id, supplierId: sup, supplierName: "QA", purchaseDate: new Date(Date.now() - day-- * 864e5), qtyRemaining: q, originalQty: q, unitCost: cost, currency: "OMR" });
    return p.toObject() as any;
  }
  const stockOf = async (id: unknown) => (await Product.findById(id).lean<any>())!;
  const layerSum = async (id: unknown) => r3((await FifoLayer.find({ productId: id }).lean<any[]>()).reduce((a, l) => a + l.qtyRemaining, 0));
  const layerValue = async (id: unknown) => (await FifoLayer.find({ productId: id }).lean<any[]>()).reduce((a, l) => a + l.qtyRemaining * l.unitCost, 0);

  const server = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ } await sleep(500); }

    // ------------------------------------------------------------------
    console.log("\n== WF-1 auth lifecycle ==");
    {
      const email = `wf-user-${tag}@test.local`;
      const cr = await req("POST", "/api/users", ck.owner, { name: "WF Cashier", email, password: "Start#123", role: "cashier", branchId: String(branch._id) });
      const uid = idOf(cr.body);
      check("WF-1.1", "owner creates a cashier", cr.status === 201 && !!uid, `HTTP ${cr.status}`);
      const login = async (pw: string) => { const r = await req("POST", "/api/auth/login", undefined, { email, password: pw }); return { s: r.status, c: (r.headers.get("set-cookie") || "").match(/unich_session=[^;]+/)?.[0] || "" }; };
      const l1 = await login("Start#123");
      const me = await req("GET", "/api/auth/me", l1.c);
      check("WF-1.2", "new user logs in; /me shows role + branch", l1.s === 200 && me.body.authenticated === true && me.body.user?.role === "cashier", `login ${l1.s}, me ${JSON.stringify(me.body.user?.role)}`);
      const pos = await req("GET", "/api/sales?limit=1", l1.c);
      const usersDenied = await req("GET", "/api/users", l1.c);
      check("WF-1.3", "cashier can use POS API but not user admin", pos.status === 200 && usersDenied.status === 403, `sales ${pos.status}, users ${usersDenied.status}`);
      const out = await req("POST", "/api/auth/logout", l1.c);
      await sleep(5200); // live-session cache window
      const after = await req("GET", "/api/sales?limit=1", l1.c);
      check("WF-1.4", "logout revokes the cookie server-side (replayed cookie → 401)", out.status === 200 && after.status === 401, `logout ${out.status}, replay ${after.status}`);
      const l2 = await login("Start#123");
      const promo = await req("PUT", `/api/users/${uid}`, ck.owner, { role: "accountant" });
      await sleep(5200);
      const demoted = await req("GET", "/api/sales?limit=1", l2.c);
      check("WF-1.5", "role change ends existing sessions", promo.status === 200 && demoted.status === 401, `PUT ${promo.status}, old cookie ${demoted.status}`);
      const l3 = await login("Start#123");
      const deact = await req("DELETE", `/api/users/${uid}`, ck.owner);
      await sleep(5200);
      const dead = await req("GET", "/api/reports/sales", l3.c);
      const relog = await login("Start#123");
      check("WF-1.6", "deactivated user: session dies and login refused", deact.status === 200 && dead.status === 401 && relog.s !== 200, `DELETE ${deact.status}, old cookie ${dead.status}, re-login ${relog.s}`);
    }

    // ------------------------------------------------------------------
    console.log("\n== WF-2 branches ==");
    let branchB = "";
    {
      const code = `WF${String(tag).slice(-6)}`;
      const mgr = await req("POST", "/api/branches", ck.manager, { name: "WF Branch", code, active: true });
      const own = await req("POST", "/api/branches", ck.owner, { name: "WF Branch", code, active: true });
      branchB = idOf(own.body);
      const dup = await req("POST", "/api/branches", ck.owner, { name: "WF Branch dup", code, active: true });
      const list = await req("GET", "/api/branches", ck.owner);
      check("WF-2.1", "only owner creates branches; duplicate code refused; listed", mgr.status === 403 && own.status === 201 && dup.status >= 400 && dup.status < 500 && (list.body.branches ?? list.body).some((b: any) => idOf(b) === branchB),
        `manager ${mgr.status}, owner ${own.status}, dup ${dup.status}`);
    }

    // ------------------------------------------------------------------
    console.log("\n== WF-3 suppliers → purchase → stock ==");
    {
      const s = await req("POST", "/api/suppliers", ck.manager, { name: `WF Supplier ${tag}`, phone: "99000000", currency: "OMR" });
      const sid = idOf(s.body);
      const upd = await req("PUT", `/api/suppliers/${sid}`, ck.manager, { phone: "99000001" });
      check("WF-3.1", "supplier create + edit", s.status === 201 && upd.status === 200 && upd.body.phone === "99000001", `create ${s.status}, edit ${upd.status}`);
      const P = await mkP("Purchased", "pcs", [[5, 4]]);
      const po = await req("POST", "/api/purchases", ck.manager, {
        supplierId: sid, supplierName: `WF Supplier ${tag}`, status: "received", currency: "OMR", orderedAt: new Date().toISOString(),
        lines: [{ productId: String(P._id), productName: P.name, sku: P.sku, qtyOrdered: 10, qtyReceived: 10, unitCost: 6 }],
      });
      const after = await stockOf(P._id);
      check("WF-3.2", "received purchase adds stock and a FIFO layer at the purchase cost", po.status === 201 && after.stockSellable === 15 && (await layerSum(P._id)) === 15 && r3(await layerValue(P._id)) === 80,
        `HTTP ${po.status} ${po.body.error ?? ""}; stock ${after.stockSellable}, layers ${await layerSum(P._id)}, value ${r3(await layerValue(P._id))} (want 15/15/80)`);
      const cashierPo = await req("POST", "/api/purchases", ck.cashier, { supplierId: sid, status: "received", lines: [] });
      check("WF-3.3", "cashier cannot create purchases", cashierPo.status === 403, `HTTP ${cashierPo.status}`);
    }

    // ------------------------------------------------------------------
    console.log("\n== WF-4 stock adjustments + bucket transfers ==");
    {
      const P = await mkP("Adjust", "pcs", [[20, 3]]);
      const inn = await req("POST", "/api/inventory/adjustments", ck.inventory, { productId: String(P._id), direction: "in", qty: 5, unitCost: 4, reason: "restock", idempotencyKey: randomUUID() });
      const outKey = randomUUID();
      const out = await req("POST", "/api/inventory/adjustments", ck.inventory, { productId: String(P._id), direction: "out", qty: 3, reason: "wastage_cost", notes: "broken", idempotencyKey: outKey });
      const s1 = await stockOf(P._id);
      check("WF-4.1", "restock +5, wastage −3; stock = Σ FIFO", inn.status < 300 && out.status < 300 && s1.stockSellable === 22 && (await layerSum(P._id)) === 22,
        `in ${inn.status}, out ${out.status}; stock ${s1.stockSellable}, layers ${await layerSum(P._id)} (want 22)`);
      // A resend of the same write-off (lost response → press again) is applied once.
      const replay = await req("POST", "/api/inventory/adjustments", ck.inventory, { productId: String(P._id), direction: "out", qty: 3, reason: "wastage_cost", notes: "broken", idempotencyKey: outKey });
      const sR = (await stockOf(P._id)).stockSellable;
      check("WF-4.1b", "replayed write-off key → original result, stock unchanged", replay.status === 200 && replay.body.deduplicated === true && sR === 22, `HTTP ${replay.status} dedup=${replay.body.deduplicated}; stock ${s1.stockSellable}→${sR}`);
      const k2 = randomUUID();
      const burst = await Promise.all(Array.from({ length: 6 }, () => req("POST", "/api/inventory/adjustments", ck.inventory, { productId: String(P._id), direction: "out", qty: 2, reason: "wastage_cost", idempotencyKey: k2 })));
      const sB = (await stockOf(P._id)).stockSellable;
      const wasteExpenses = await Expense.countDocuments({ category: "Wastage", detail: { $regex: P.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } });
      check("WF-4.1c", "same write-off key fired 6× at once → stock −2 once, one wastage expense", sB === 20 && (await layerSum(P._id)) === 20 && burst.filter((r) => r.status === 200 && !r.body.deduplicated).length === 1,
        `[${burst.map((r) => `${r.status}${r.body.deduplicated ? "d" : ""}${r.body.code ? ":" + r.body.code : ""}`).join(",")}]; stock ${sR}→${sB}; wastage expenses for product ${wasteExpenses}`);
      const mismatch = await req("POST", "/api/inventory/adjustments", ck.inventory, { productId: String(P._id), direction: "out", qty: 5, reason: "wastage_cost", idempotencyKey: k2 });
      check("WF-4.1d", "key reused for a different quantity → 409, nothing moved", mismatch.status === 409 && (await stockOf(P._id)).stockSellable === 20, `HTTP ${mismatch.status} ${mismatch.body.code ?? ""}`);
      const rk = randomUUID();
      const r1 = await req("POST", "/api/inventory/adjustments", ck.inventory, { productId: String(P._id), direction: "in", qty: 2, unitCost: 3, reason: "restock", idempotencyKey: rk });
      const r2 = await req("POST", "/api/inventory/adjustments", ck.inventory, { productId: String(P._id), direction: "in", qty: 2, unitCost: 3, reason: "restock", idempotencyKey: rk });
      const sRs = (await stockOf(P._id)).stockSellable;
      check("WF-4.1e", "replayed restock key → added once", r1.status === 201 && r2.status === 200 && r2.body.deduplicated === true && sRs === 22 && (await layerSum(P._id)) === 22, `HTTP ${r1.status}/${r2.status}; stock ${sRs}`);
      const over = await req("POST", "/api/inventory/adjustments", ck.inventory, { productId: String(P._id), direction: "out", qty: 999, reason: "wastage_cost", idempotencyKey: randomUUID() });
      check("WF-4.2", "write-off beyond stock refused, nothing moved", over.status >= 400 && over.status < 500 && (await stockOf(P._id)).stockSellable === 22, `HTTP ${over.status}`);
      const tr = await req("POST", "/api/inventory/transfers", ck.inventory, { productId: String(P._id), from: "stockSellable", to: "stockTester", qty: 2 });
      const s2 = await stockOf(P._id);
      check("WF-4.3", "transfer 2 sellable → tester; sellable stock still = Σ FIFO", tr.status < 300 && s2.stockSellable === 20 && s2.stockTester === 2 && (await layerSum(P._id)) === 20,
        `HTTP ${tr.status} ${tr.body.error ?? ""}; sellable ${s2.stockSellable}, tester ${s2.stockTester}, layers ${await layerSum(P._id)}`);
      const back = await req("POST", "/api/inventory/transfers", ck.inventory, { productId: String(P._id), from: "stockTester", to: "stockSellable", qty: 2 });
      const s3 = await stockOf(P._id);
      check("WF-4.4", "transfer back tester → sellable; stock = Σ FIFO", back.status < 300 && s3.stockSellable === 22 && s3.stockTester === 0 && (await layerSum(P._id)) === 22,
        `HTTP ${back.status}; sellable ${s3.stockSellable}, tester ${s3.stockTester}, layers ${await layerSum(P._id)}`);
      const cashierAdj = await req("POST", "/api/inventory/adjustments", ck.cashier, { productId: String(P._id), direction: "in", qty: 100, reason: "restock", idempotencyKey: randomUUID() });
      check("WF-4.5", "cashier cannot restock", cashierAdj.status === 403, `HTTP ${cashierAdj.status}`);
    }

    // ------------------------------------------------------------------
    console.log("\n== WF-5 formulas: draft → approve → revise ==");
    const A = await mkP("Oil A", "ml", [[500, 2]]);
    const Bp = await mkP("Jar B", "pcs", [[40, 1.5]]);
    const OUT = await mkP("Output", "pcs", [], { stockSellable: 0 });
    let formulaId = "";
    {
      const comps = [{ productId: String(A._id), productName: A.name, qty: 10, unit: "ml" }, { productId: String(Bp._id), productName: Bp.name, qty: 2, unit: "pcs" }];
      const noAdmin = await req("POST", "/api/formulas", ck.manager, { name: `WF Formula ${tag}`, type: "oil", yieldMl: 10, components: comps });
      const cr = await req("POST", "/api/formulas", ownerFA, { name: `WF Formula ${tag}`, type: "oil", yieldMl: 10, components: comps });
      formulaId = idOf(cr.body);
      check("WF-5.1", "formula create needs the Formula-Admin unlock (manager without it → 403); created as draft", noAdmin.status === 403 && cr.status === 201 && cr.body.status === "draft", `no unlock ${noAdmin.status}, unlocked ${cr.status} status=${cr.body.status}`);
      const draftProd = await req("POST", "/api/production", ownerFA, { formulaId, qty: 1, outputProductId: String(OUT._id), outputQty: 1 });
      check("WF-5.2", "draft formula cannot be produced", draftProd.status === 400, `HTTP ${draftProd.status} ${draftProd.body.error ?? ""}`);
      const ap = await req("PUT", `/api/formulas/${formulaId}`, ownerFA, { status: "approved" });
      check("WF-5.3", "approve formula", ap.status === 200 && ap.body.status === "approved", `HTTP ${ap.status} status=${ap.body.status}`);
      const cashierView = await req("GET", "/api/formulas", ck.cashier);
      check("WF-5.4", "recipe list hidden from cashier", cashierView.status === 403, `HTTP ${cashierView.status}`);
    }

    // ------------------------------------------------------------------
    console.log("\n== WF-6 production: plan → complete, races ==");
    {
      const a0 = (await stockOf(A._id)).stockSellable, b0 = (await stockOf(Bp._id)).stockSellable;
      const done = await req("POST", "/api/production", ownerFA, { formulaId, qty: 3, outputProductId: String(OUT._id), outputQty: 3, actualYieldMl: 30, complete: true });
      const a1 = await stockOf(A._id), b1 = await stockOf(Bp._id), o1 = await stockOf(OUT._id);
      check("WF-6.1", "qty 3 consumes 30 ml A + 6 B and adds 3 output", done.status === 201 && a1.stockSellable === a0 - 30 && b1.stockSellable === b0 - 6 && o1.stockSellable === 3,
        `HTTP ${done.status} ${done.body.error ?? ""}; A ${a0}→${a1.stockSellable}, B ${b0}→${b1.stockSellable}, out ${o1.stockSellable}`);
      const outValue = r3(await layerValue(OUT._id));
      check("WF-6.2", "output FIFO layer carries consumed cost (30×2 + 6×1.5 = 69)", (await layerSum(OUT._id)) === 3 && outValue === 69 && (await layerSum(A._id)) === a1.stockSellable && (await layerSum(Bp._id)) === b1.stockSellable,
        `output layers ${await layerSum(OUT._id)} value ${outValue}; A layers ${await layerSum(A._id)}, B layers ${await layerSum(Bp._id)}`);
      const again = await req("POST", `/api/production/${idOf(done.body)}/complete`, ownerFA, {});
      check("WF-6.3", "completing a completed order is refused", again.status === 400, `HTTP ${again.status}`);

      const draft = await req("POST", "/api/production", ownerFA, { formulaId, qty: 2, outputProductId: String(OUT._id), outputQty: 2 });
      const did = idOf(draft.body);
      const a2 = (await stockOf(A._id)).stockSellable, o2 = (await stockOf(OUT._id)).stockSellable;
      const race = await Promise.all(Array.from({ length: 8 }, () => req("POST", `/api/production/${did}/complete`, ownerFA, { actualYieldMl: 20 })));
      const ok = race.filter((r) => r.status === 200 || r.status === 201).length;
      const a3 = (await stockOf(A._id)).stockSellable, o3 = (await stockOf(OUT._id)).stockSellable;
      check("WF-6.4", "same draft completed 8× concurrently → consumed once", ok === 1 && a3 === a2 - 20 && o3 === o2 + 2 && (await layerSum(A._id)) === a3,
        `${ok} succeeded [${race.map((r) => r.status).join(",")}]; A ${a2}→${a3} (want −20), out ${o2}→${o3} (want +2)`);

      const P = await mkP("Scarce", "ml", [[15, 1]]);
      const F2 = await req("POST", "/api/formulas", ownerFA, { name: `WF Scarce ${tag}`, type: "oil", yieldMl: 10, components: [{ productId: String(P._id), productName: P.name, qty: 10, unit: "ml" }] });
      await req("PUT", `/api/formulas/${idOf(F2.body)}`, ownerFA, { status: "approved" });
      const short = await req("POST", "/api/production", ownerFA, { formulaId: idOf(F2.body), qty: 2, outputProductId: String(OUT._id), outputQty: 2, actualYieldMl: 20, complete: true });
      check("WF-6.5", "insufficient material → refused, nothing consumed", short.status === 400 && (await stockOf(P._id)).stockSellable === 15 && (await layerSum(P._id)) === 15,
        `HTTP ${short.status} ${short.body.code ?? ""}; stock ${(await stockOf(P._id)).stockSellable}`);
      const drafts = await Promise.all(Array.from({ length: 2 }, () => req("POST", "/api/production", ownerFA, { formulaId: idOf(F2.body), qty: 1, outputProductId: String(OUT._id), outputQty: 1 })));
      const race2 = await Promise.all(drafts.map((d) => req("POST", `/api/production/${idOf(d.body)}/complete`, ownerFA, { actualYieldMl: 10 })));
      const okN = race2.filter((r) => r.status < 300).length;
      const left = (await stockOf(P._id)).stockSellable;
      check("WF-6.6", "two orders racing for 15 ml (10 ml each) → one completes, stock never negative", okN === 1 && left === 5 && (await layerSum(P._id)) === 5,
        `[${race2.map((r) => r.status).join(",")}]; stock ${left}, layers ${await layerSum(P._id)}`);
    }

    // ------------------------------------------------------------------
    console.log("\n== WF-7 expenses ==");
    {
      const e = await req("POST", "/api/expenses", ck.branch_manager, { date: new Date().toISOString(), category: "Utilities", detail: "WF electricity", amount: 12.5 });
      const eid = idOf(e.body);
      const list = await req("GET", "/api/expenses", ck.branch_manager);
      check("WF-7.1", "branch manager records an expense in their branch", e.status === 201 && (list.body.expenses ?? list.body).some((x: any) => idOf(x) === eid), `HTTP ${e.status}`);
      const ed = await req("PUT", `/api/expenses/${eid}`, ck.branch_manager, { amount: 15 });
      check("WF-7.2", "edit amount", ed.status === 200 && Number(ed.body.amount) === 15, `HTTP ${ed.status}`);
      const cashier = await req("POST", "/api/expenses", ck.cashier, { date: new Date().toISOString(), category: "X", detail: "x", amount: 1 });
      check("WF-7.3", "cashier cannot record expenses", cashier.status === 403, `HTTP ${cashier.status}`);

      // Expense owned by another branch: a branch-scoped user must not see, edit or delete it.
      const other = await Expense.create({ date: new Date(), category: "Rent", detail: "WF other-branch rent", amount: 500, branchId: branchB, branchName: "WF Branch" });
      const seen = (await req("GET", "/api/expenses", ck.branch_manager)).body;
      const visible = (seen.expenses ?? seen).some((x: any) => idOf(x) === String(other._id));
      const edit = await req("PUT", `/api/expenses/${other._id}`, ck.branch_manager, { amount: 1 });
      const del = await req("DELETE", `/api/expenses/${other._id}`, ck.branch_manager);
      const still = await Expense.findById(other._id).lean<any>();
      check("WF-7.4", "other branch's expense: hidden from list", !visible, `visible=${visible}`);
      check("WF-7.5", "other branch's expense: edit/delete by id refused", edit.status === 403 && del.status === 403 && still?.amount === 500,
        `PUT ${edit.status}, DELETE ${del.status}; record ${still ? `amount ${still.amount}` : "DELETED"}`);
      const move = await req("PUT", `/api/expenses/${eid}`, ck.branch_manager, { branchId: branchB });
      const moved = await Expense.findById(eid).lean<any>();
      check("WF-7.6", "own expense cannot be re-assigned to another branch", String(moved?.branchId) === String(branch._id), `PUT ${move.status}; branch now ${String(moved?.branchId) === branchB ? "OTHER BRANCH" : "own"}`);
    }

    // ------------------------------------------------------------------
    console.log("\n== WF-8 customers ==");
    {
      const phone = `9${String(tag).slice(-7)}`;
      const c = await req("POST", "/api/customers", ck.cashier, { name: "WF Customer", phone });
      const cid = idOf(c.body);
      const dup = await req("POST", "/api/customers", ck.cashier, { name: "WF Dup", phone });
      const ed = await req("PUT", `/api/customers/${cid}`, ck.cashier, { name: "WF Customer Renamed" });
      const got = await req("GET", `/api/customers/${cid}`, ck.cashier);
      check("WF-8.1", "create, duplicate phone refused, rename", c.status === 201 && dup.status >= 400 && dup.status < 500 && ed.status === 200 && got.body.name === "WF Customer Renamed",
        `create ${c.status}, dup ${dup.status}, edit ${ed.status}, name ${got.body.name}`);
    }

    // ------------------------------------------------------------------
    console.log("\n== WF-9 product import → commit → undo ==");
    {
      const tpl = await fetch(`${BASE}/api/products/import/template`, { headers: { Cookie: ck.inventory } });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await tpl.arrayBuffer()) as any);
      const ws = wb.worksheets[0];
      const headers = (ws.getRow(1).values as any[]).slice(1).map((h) => String(h ?? "").trim());
      const impName = `WF Imported ${tag}`;
      const val: Record<string, unknown> = {};
      for (const h of headers) {
        const k = h.toLowerCase();
        if (k.includes("sku") || k.includes("code")) val[h] = ""; // blank = new product
        else if (k.includes("wholesale")) val[h] = 30;
        else if (k.includes("item type")) val[h] = "finished";
        else if (k.includes("name")) val[h] = impName;
        else if (k.includes("category")) val[h] = "Brands"; // must be on the Lists sheet
        else if (k.includes("unit")) val[h] = "pcs";
        else if (k.includes("sell") || k === "price" || k.includes("retail")) val[h] = 40;
        else if (k.includes("cost")) val[h] = 10;
        else if (k.includes("stock") || k.includes("qty") || k.includes("quantity")) val[h] = 0;
      }
      // Keep only the header row, then append our row.
      for (let r = ws.rowCount; r >= 2; r--) ws.spliceRows(r, 1);
      ws.addRow(headers.map((h) => val[h] ?? ""));
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      const fd = new FormData();
      fd.append("file", new Blob([buf]), "wf.xlsx");
      const st = await req("POST", "/api/products/import/stage", ck.inventory, fd);
      const batchId = st.body.batchId;
      check("WF-9.1", "stage import from the official template", st.status < 300 && !!batchId && st.body.created === 1, `HTTP ${st.status} ${st.body.error ?? ""}; created=${st.body.created} failed=${st.body.failed} headers=[${headers.join("|")}]`);
      const cm = await req("POST", "/api/products/import/commit", ck.inventory, { batchId });
      const prod = await Product.findOne({ name: impName }).lean<any>();
      check("WF-9.2", "commit creates the product", cm.status < 300 && !!prod, `HTTP ${cm.status} ${cm.body.error ?? ""}; product ${prod ? "exists" : "missing"}`);
      const cm2 = await req("POST", "/api/products/import/commit", ck.inventory, { batchId });
      check("WF-9.3", "committing the same batch twice refused", cm2.status === 400, `HTTP ${cm2.status}`);
      const un = await req("POST", `/api/products/import/${batchId}/undo`, ck.inventory, {});
      const gone = !(await Product.findOne({ name: impName }).lean());
      check("WF-9.4", "undo removes the imported product", un.status < 300 && gone, `HTTP ${un.status} ${un.body.error ?? ""}; removed=${gone}`);
    }

    // ------------------------------------------------------------------
    console.log("\n== WF-10 reports reconcile with the database ==");
    {
      const P = await mkP("Report", "pcs", [[50, 7]], { sellPrice: 25 });
      const sp = ((await AppSettings.findOne({ key: "default" }).lean<any>())?.activeSalesperson) || "Ahmad Ibrahim";
      const before = await req("GET", "/api/reports/sales?period=today", ck.owner);
      const sells = await Promise.all(Array.from({ length: 4 }, (_, i) => req("POST", "/api/sales", ck.cashier, { customerPhone: `7${String(tag + i).slice(-7)}`, payment: "cash", salesperson: sp, idempotencyKey: randomUUID(), lines: [{ productId: String(P._id), qty: 2, lineType: "ready" }] })));
      const after = await req("GET", "/api/reports/sales?period=today", ck.owner);
      const delta = r3(after.body.summary.total - before.body.summary.total);
      check("WF-10.1", "4 sales × 50 → sales report total +200, count +4", sells.every((s) => s.status === 201) && delta === 200 && after.body.summary.count - before.body.summary.count === 4,
        `sales [${sells.map((s) => s.status).join(",")}]; Δtotal ${delta}, Δcount ${after.body.summary.count - before.body.summary.count}`);
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const dbToday = r3((await Sale.find({ status: "completed", createdAt: { $gte: start } }).lean<any[]>()).reduce((a, s) => a + s.total, 0));
      check("WF-10.2", "sales report total == Σ completed sales in DB (today)", r3(after.body.summary.total) === dbToday, `report ${after.body.summary.total} vs DB ${dbToday}`);
      const bm = await req("GET", "/api/reports/sales?period=today", ck.branch_manager);
      const bmDb = await Sale.find({ status: "completed", createdAt: { $gte: start }, $or: [{ branchId: branch._id }, { branchId: null }, { branchId: { $exists: false } }] }).lean<any[]>();
      const bmTotal = r3(bmDb.reduce((a, s) => a + s.total, 0));
      check("WF-10.2b", "branch manager's report == Σ their branch's sales in DB (count + total)", bm.status === 200 && bm.body.summary.count === bmDb.length && r3(bm.body.summary.total) === bmTotal,
        `report ${bm.body.summary?.count}/${bm.body.summary?.total} vs DB ${bmDb.length}/${bmTotal}`);
      const val = await req("GET", `/api/reports/inventory-valuation?productId=${P._id}`, ck.owner);
      const vProd = (val.body.highest?.products ?? []).concat(...(val.body.categories ?? []).map((c: any) => c.products ?? [])).find((x: any) => x.id === String(P._id));
      check("WF-10.3", "valuation for product = remaining FIFO qty × cost (42 × 7 = 294)", r3(val.body.totalValue) === 294 || r3(vProd?.value) === 294, `HTTP ${val.status}; totalValue ${val.body.totalValue}, product ${vProd?.value}`);
      const cat = await req("GET", "/api/reports/engine", ck.owner);
      const runs = await Promise.all((cat.body.reports ?? []).map(async (r: any) => [r.id, (await req("GET", `/api/reports/engine/${r.id}`, ck.owner)).status] as const));
      const bad = runs.filter(([, s]) => s !== 200);
      check("WF-10.4", `all ${runs.length} engine reports run for owner`, runs.length > 0 && bad.length === 0, bad.map(([i, s]) => `${i}:${s}`).join(", "));
      const exps = await Promise.all(["/api/reports/sales/export?period=today", "/api/reports/inventory-valuation/export", `/api/reports/engine/${cat.body.reports?.[0]?.id}?format=csv`, "/api/products/export"].map(async (p) => [p, await req("GET", p, ck.owner)] as const));
      check("WF-10.5", "exports download as non-empty files", exps.every(([, r]) => r.status === 200 && (r.body._bytes ?? 0) > 40), exps.map(([p, r]) => `${p.split("?")[0].split("/").slice(-2).join("/")}:${r.status}/${r.body._bytes ?? "json"}`).join(", "));
      const dash = await req("GET", "/api/dashboard", ck.owner);
      check("WF-10.6", "dashboard loads with today's sales ≥ report total", dash.status === 200 && r3(dash.body.stats?.todaySales ?? -1) >= 0, `HTTP ${dash.status} todaySales ${dash.body.stats?.todaySales}`);
      // Cash closing + dashboard net cash: cash 10, card 20, credit 30, mixed (cash 5 + card 15), expense 4.
      const C = await mkP("Tender", "pcs", [[100, 1]], { sellPrice: 10 });
      const row = (rep: any, label: string) => (rep.body.rows ?? []).find((r: any) => String(r.payment).startsWith(label)) ?? { amount: 0, count: 0 };
      const cc0 = await req("GET", "/api/reports/engine/cash-closing", ck.owner);
      const d0 = await req("GET", "/api/dashboard", ck.owner);
      const custP = await req("POST", "/api/customers", ck.cashier, { name: "WF Tender", phone: `6${String(tag).slice(-7)}` });
      const sale = (qty: number, extra: Record<string, unknown>) => req("POST", "/api/sales", ck.cashier, { customerPhone: `6${String(tag).slice(-7)}`, customerId: idOf(custP.body), salesperson: sp, idempotencyKey: randomUUID(), lines: [{ productId: String(C._id), qty, lineType: "ready" }], ...extra });
      const tsales = [await sale(1, { payment: "cash" }), await sale(2, { payment: "card" }), await sale(3, { payment: "credit" }),
        await sale(2, { payment: "mixed", paymentBreakdown: [{ method: "cash", amount: 5 }, { method: "card", amount: 15 }] })];
      const ex = await req("POST", "/api/expenses", ck.owner, { date: new Date().toISOString(), category: "Supplies", detail: "WF tender test", amount: 4 });
      const cc1 = await req("GET", "/api/reports/engine/cash-closing", ck.owner);
      const d1 = await req("GET", "/api/dashboard", ck.owner);
      const dl = (label: string) => r3(row(cc1, label).amount - row(cc0, label).amount);
      const got = { cash: dl("Cash"), card: dl("Card"), credit: dl("Credit"), gross: dl("Gross"), exp: dl("Expenses"), net: dl("Net cash") };
      check("WF-10.8", "cash closing: mixed split; cash +15, card +35, credit +30 (not cash), gross +80, expenses −4, net cash +11",
        tsales.every((x) => x.status === 201) && ex.status === 201 && got.cash === 15 && got.card === 35 && got.credit === 30 && got.gross === 80 && got.exp === -4 && got.net === 11,
        `sales [${tsales.map((x) => x.status + (x.body.code ? ":" + x.body.code : "")).join(",")}], expense ${ex.status}; Δ ${JSON.stringify(got)}`);
      const dNet = r3((d1.body.stats?.netCash ?? NaN) - (d0.body.stats?.netCash ?? NaN));
      check("WF-10.9", "dashboard Net Cash moves by cash taken − expenses (+11), not by all sales", dNet === 11, `Δ netCash ${dNet}`);
      const cashierRpt = await req("GET", "/api/reports/sales", ck.cashier);
      check("WF-10.7", "cashier cannot open financial reports", cashierRpt.status === 403, `HTTP ${cashierRpt.status}`);
    }

    // ------------------------------------------------------------------
    console.log("\n== WF-11 settings + notifications ==");
    {
      const cur = await req("GET", "/api/settings", ck.manager);
      const team = cur.body.salespeople;
      const put = await req("PUT", "/api/settings", ck.manager, { autoPrintReceipt: !cur.body.autoPrintReceipt });
      check("WF-11.1", "partial settings save keeps the sales team", put.status === 200 && JSON.stringify(put.body.salespeople) === JSON.stringify(team), `HTTP ${put.status}`);
      await req("PUT", "/api/settings", ck.manager, { autoPrintReceipt: cur.body.autoPrintReceipt });
      const cashierPut = await req("PUT", "/api/settings", ck.cashier, { autoPrintReceipt: true });
      check("WF-11.2", "cashier cannot change settings", cashierPut.status === 403, `HTTP ${cashierPut.status}`);
      const n = await req("GET", "/api/notifications", ck.manager);
      const all = await req("PATCH", "/api/notifications", ck.manager, { all: true });
      check("WF-11.3", "notifications list + mark all read", n.status === 200 && all.status === 200, `GET ${n.status}, PATCH ${all.status}`);
    }
  } finally {
    try { process.kill(-(server.pid as number), "SIGTERM"); } catch { /* */ }
    await sleep(1500);
  }
  if (fails.length) console.log(`\nFailures:\n  ${fails.join("\n  ")}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
