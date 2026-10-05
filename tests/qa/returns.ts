/* eslint-disable @typescript-eslint/no-explicit-any */
// QA suite: returns — run via `npm run test:qa` (local throwaway DB only).
/**
 * POS-120..129 Cancellation / returns / refunds — discovery + verification of
 * what exists. Local throwaway DB only; repo untouched.
 */
import { assertLocalDb } from "../../src/lib/e2eGuard";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, Customer, FifoLayer, Formula, Product, Sale, User } from "../../src/lib/models";
import { createSessionToken } from "../../src/lib/auth/session";

assertLocalDb();
const BASE = "http://localhost:3956";
type Res = boolean | "RV" | "OBS" | "NA";
const out: Res[] = [];
function rec(id: string, name: string, ok: Res, detail: string) {
  out.push(ok);
  const m = ok === "RV" ? "  ■" : ok === "OBS" ? "  •" : ok === "NA" ? "  –" : ok ? "  ✓" : "  ✗";
  console.log(`${m} [${id}] ${name} — ${detail}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function req(method: string, path: string, cookie?: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function main() {
  await connectDB();
  const branch = (await Branch.findOne().lean<any>())!;
  const mk = async (role: string) => {
    const u = (await User.findOne({ role }).lean<any>())!;
    return `unich_session=${createSessionToken({ userId: String(u._id), name: u.name, email: u.email, role: role as any, roleLabel: role, branchId: String(branch._id), branchName: branch.name })}`;
  };
  const roles = ["owner", "manager", "branch_manager", "cashier", "accountant", "inventory"] as const;
  const ck = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, await mk(r)]))) as Record<(typeof roles)[number], string>;
  await AppSettings.updateOne({ key: "default" }, { $set: { salespeople: ["SP Alpha"], activeSalesperson: "SP Alpha", vatPercent: 0 } });
  const tag = Date.now();
  const mkP = async (name: string, price: number, stock: number) => {
    const p = await Product.create({ sku: `RT-${name}-${tag}`, name: `RT ${name}`, category: "Perfume", unit: "pcs", sellPrice: price, costFifo: 4, stockSellable: stock });
    await FifoLayer.create({ productId: p._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 864e5), qtyRemaining: stock, originalQty: stock, unitCost: 4, currency: "OMR" });
    return p.toObject() as any;
  };
  const PA = await mkP("A", 10, 100), PB = await mkP("B", 20, 3);
  const stock = async (p: any) => (await Product.findById(p._id).lean<any>())!.stockSellable;
  const layers = async (p: any) => (await FifoLayer.find({ productId: p._id }).lean<any[]>()).reduce((a, l) => a + l.qtyRemaining, 0);
  const ln = (p: any, qty: number, extra: Record<string, unknown> = {}) => ({ productId: String(p._id), name: p.name, qty, lineType: "ready", unitLabel: "pcs", unitPrice: p.sellPrice, ...extra });
  const formula = await Formula.findOne({ name: "Fatima — Amber Oud Remix" }).lean<any>();
  const remix = await Product.findOne({ category: "Remix" }).lean<any>();
  const comps = (formula?.components ?? []).filter((c: any) => mongoose.isValidObjectId(c.productId));
  const compSnap = async () => JSON.stringify(await Promise.all(comps.map(async (c: any) => (await Product.findById(c.productId).lean<any>())?.stockSellable)));
  let ph = 83000000;

  const server = spawn("npx", ["next", "start", "-p", "3956"], { cwd: process.cwd(), env: { ...process.env, EMAIL_PROVIDER: "none", RESEND_API_KEY: "disabled-for-tests" }, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 240; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await sleep(500); }

    console.log("\n== POS-120 cancel unpaid ==");
    const phone = String(++ph);
    const cust0 = { n: await Sale.countDocuments({ status: "completed" }), a: await stock(PA), la: await layers(PA), comps: await compSnap() };
    rec("POS-120", "unpaid POS cart lives only in the browser (no API call until hold/checkout)", "OBS", "pos/page.tsx keeps the cart in React state; removing lines / leaving the page writes nothing");
    const held = await req("POST", "/api/sales", ck.cashier, { customerPhone: phone, customerName: "Cancel Cust", payment: "card", status: "held", salesperson: "SP Alpha",
      lines: [ln(PA, 3, { discount: { type: "percent", value: 5 } }), ...(remix && formula ? [{ productId: String(remix._id), name: remix.name, qty: 1, lineType: "remix", unitLabel: "pcs", formulaId: String(formula._id) }] : [])] });
    const disc = await req("PATCH", `/api/sales/${held.body.id}`, ck.cashier, { status: "void" });
    const c1 = await Customer.findOne({ phone }).lean<any>();
    rec("POS-120", "held cart (ready + remix, discounted, customer) cancelled: no sale, stock, FIFO, BOM or customer impact",
      held.status === 201 && disc.status === 200 && (await Sale.countDocuments({ status: "completed" })) === cust0.n && (await stock(PA)) === cust0.a && (await layers(PA)) === cust0.la && (await compSnap()) === cust0.comps && !(c1?.totalPurchases > 0) && !(c1?.creditBalance > 0),
      `hold ${held.status}, discard ${disc.status}, completed +${(await Sale.countDocuments({ status: "completed" })) - cust0.n}, A ${cust0.a}→${await stock(PA)}, BOM unchanged ${(await compSnap()) === cust0.comps}`);
    const before2 = { a: await stock(PA), comps: await compSnap(), n: await Sale.countDocuments({}) };
    const fail = await req("POST", "/api/sales", ck.owner, { customerPhone: String(++ph), payment: "cash", salesperson: "SP Alpha", idempotencyKey: randomUUID(),
      lines: [ln(PA, 2), ...(remix && formula ? [{ productId: String(remix._id), name: remix.name, qty: 1, lineType: "remix", unitLabel: "pcs", formulaId: String(formula._id) }] : []), ln(PB, 10)] });
    rec("POS-120", "checkout that fails (B short, run as owner so the price check passes) leaves nothing behind: no sale, A/BOM untouched", fail.status === 400 && fail.body.code === "INSUFFICIENT_STOCK" && (await stock(PA)) === before2.a && (await compSnap()) === before2.comps && (await Sale.countDocuments({})) === before2.n,
      `HTTP ${fail.status} ${fail.body.code}; sales +${(await Sale.countDocuments({})) - before2.n}`);

    console.log("\n== POS-121..128 does any return / refund function exist? ==");
    const sold = await req("POST", "/api/sales", ck.cashier, { customerPhone: String(++ph), customerName: "Return Cust", payment: "credit", salesperson: "SP Alpha", idempotencyKey: randomUUID(), lines: [ln(PA, 5)] });
    const saleBefore = JSON.stringify(await Sale.findById(sold.body.id).lean());
    const aAfterSale = await stock(PA);
    const probes = [
      ["POST", `/api/sales/${sold.body.id}/return`, { lines: [{ productId: String(PA._id), qty: 2 }], reason: "damaged" }],
      ["POST", `/api/sales/${sold.body.id}/refund`, { amount: 20, method: "cash" }],
      ["POST", "/api/returns", { saleId: sold.body.id, returnQuantity: 1000, refundAmount: 999999, approved: true }],
      ["POST", "/api/refunds", { saleId: sold.body.id, amount: 50 }],
      ["PATCH", `/api/sales/${sold.body.id}`, { status: "void" }],
      ["PATCH", `/api/sales/${sold.body.id}`, { status: "returned" }],
      ["PATCH", `/api/sales/${sold.body.id}`, { status: "refunded", refundAmount: 50 }],
      ["DELETE", `/api/sales/${sold.body.id}`, undefined],
    ] as const;
    const results: string[] = [];
    for (const [m, p, b] of probes) { const r = await req(m, p, ck.owner, b); results.push(`${m} ${p.replace(sold.body.id, ":id")} → ${r.status}`); }
    const unchanged = JSON.stringify(await Sale.findById(sold.body.id).lean()) === saleBefore && (await stock(PA)) === aAfterSale;
    rec("POS-121", "return / refund / cancel-completed endpoints", "RV", `none exist — ${results.join("; ")}. Completed sale, stock untouched: ${unchanged}`);
    for (const [id, name] of [["POS-122", "partial return"], ["POS-123", "full return"], ["POS-124", "remix return (component reversal)"], ["POS-125", "cash refund"], ["POS-126", "card refund"], ["POS-127", "return without original sale"], ["POS-128", "return reason"]] as const) {
      rec(id, name, "RV", "no implementation and POS-06 policy is TBD — nothing to accept or reject");
    }
    rec("POS-121", "a completed sale can't be voided, edited or deleted (no silent reversal path)", unchanged, "PATCH void/returned/refunded → 400, DELETE → 405, sale + stock unchanged");

    console.log("\n== Workarounds staff could use today ==");
    const restockAs = async (role: keyof typeof ck) => req("POST", "/api/inventory/adjustments", ck[role], { productId: String(PA._id), qty: 2, direction: "in", reason: "restock", notes: "customer returned 2 (manual)" });
    const rs = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, (await restockAs(r)).status])));
    rec("POS-129", "manual 'return' via inventory restock: who can do it", "OBS", `restock HTTP by role ${JSON.stringify(rs)}; adjustment has no sale reference and the sale still counts full revenue`);
    const cust = await Customer.findById((await Sale.findById(sold.body.id).lean<any>()).customerId).lean<any>();
    rec("Financial", "credit sale put 50 on the customer's balance", cust.creditBalance >= 50, `creditBalance ${cust.creditBalance}`);
    const edits: Record<string, number> = {};
    for (const r of roles) {
      const e = await req("PUT", `/api/customers/${cust._id}`, ck[r], { creditBalance: 0, totalPurchases: 999999 });
      edits[r] = e.status;
    }
    const after = await Customer.findById(cust._id).lean<any>();
    rec("POS-129 / Financial", "customer credit balance can't be rewritten through the customer edit API (unaudited 'refund')",
      after.creditBalance === cust.creditBalance && after.totalPurchases === cust.totalPurchases,
      `PUT {creditBalance:0,totalPurchases:999999} by role → ${JSON.stringify(edits)}; balance now ${after.creditBalance} (was ${cust.creditBalance}), totalPurchases ${after.totalPurchases}`);
    const neg = await req("PUT", `/api/customers/${cust._id}`, ck.cashier, { creditBalance: -5000 });
    rec("Financial", "negative credit balance attempt has no effect (field ignored)", (await Customer.findById(cust._id).lean<any>()).creditBalance === after.creditBalance, `HTTP ${neg.status}, balance ${(await Customer.findById(cust._id).lean<any>()).creditBalance}`);
    const otherBranchCk = `unich_session=${createSessionToken({ userId: String(new mongoose.Types.ObjectId()), name: "Other", email: "o@x", role: "cashier", roleLabel: "cashier", branchId: String(new mongoose.Types.ObjectId()), branchName: "Other" })}`;
    const ob = await req("PUT", `/api/customers/${cust._id}`, otherBranchCk, { creditBalance: 1 });
    rec("Security", "customer edit from another branch", "OBS", `HTTP ${ob.status} (customers are shared across branches — no rule defined)`);
    const un = await req("PUT", `/api/customers/${cust._id}`, undefined, { creditBalance: 1 });
    rec("Security", "unauthenticated customer edit → 401", un.status === 401, `HTTP ${un.status}`);
  } finally {
    try { process.kill(-(server.pid as number), "SIGTERM"); } catch { /* */ }
    await sleep(1500);
  }
  const c = (v: Res) => out.filter((o) => o === v).length;
  console.log(`\n${c(true)} passed, ${c(false)} failed, ${c("RV")} requirement-validation, ${c("OBS")} observations`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
