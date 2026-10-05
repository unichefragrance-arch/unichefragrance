/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// QA suite: quotations — run via `npm run test:qa` (local throwaway DB only).
/**
 * POS-104..110 Quotation → sale conversion. Black-box HTTP against `next start`
 * + throwaway local replica set. Quotations are created exactly like the
 * Quotation editor does (catalog lines = "wholesale" with productId; custom
 * blends = "custom_blend" with formulaId and NO productId) and approved through
 * the customer's public link. Local DB only; repo untouched.
 */
import { assertLocalDb } from "../../src/lib/e2eGuard";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, Customer, FifoLayer, Formula, Product, Quotation, Sale, User } from "../../src/lib/models";
import { createSessionToken } from "../../src/lib/auth/session";

assertLocalDb();
const BASE = "http://localhost:3954";
const A = "SP Alpha", B = "SP Bravo";
type Res = boolean | "OBS" | "BLOCKED";
const out: Array<{ id: string; ok: Res }> = [];
function rec(id: string, name: string, ok: Res, detail: string) {
  out.push({ id, ok });
  const mark = ok === "OBS" ? "  •" : ok === "BLOCKED" ? "  ■" : ok ? "  ✓" : "  ✗";
  console.log(`${mark} [${id}] ${name} — ${detail}`);
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
const stat = (label: string, rs: R[], wall: number) => { const by = new Map<number, number>(); for (const r of rs) by.set(r.status, (by.get(r.status) ?? 0) + 1); const ms = rs.map((r) => r.ms); console.log(`    ${label}: ${rs.length} req ${(rs.length / (wall / 1000)).toFixed(1)} req/s p50 ${pctl(ms, 50)}ms p95 ${pctl(ms, 95)}ms [${[...by].map(([k, v]) => `${k}×${v}`).join(", ")}]`); };

async function main() {
  await connectDB();
  const branch = (await Branch.findOne().lean<any>())!;
  const mk = async (role: string, branchId: string | null, userId?: string) => {
    const u = (await User.findOne({ role }).lean<any>())!;
    return `unich_session=${createSessionToken({ userId: userId ?? String(u._id), name: u.name, email: u.email, role: role as any, roleLabel: role, branchId, branchName: branch.name })}`;
  };
  const ck = {
    cashier: await mk("cashier", String(branch._id)),
    cashier2: await mk("cashier", String(branch._id), String(new mongoose.Types.ObjectId())),
    owner: await mk("owner", String(branch._id)),
    accountant: await mk("accountant", String(branch._id)),
    other: await mk("cashier", String(new mongoose.Types.ObjectId()), String(new mongoose.Types.ObjectId())),
  };
  await AppSettings.updateOne({ key: "default" }, { $set: { salespeople: [A, B], activeSalesperson: A } });
  const tag = Date.now();
  const mkP = async (name: string, price: number, stock: number, cost: number, extra: Record<string, unknown> = {}) => {
    const p = await Product.create({ sku: `QQ-${name}-${tag}`, name: `QQ ${name}`, category: "Perfume", unit: "pcs", sellPrice: price, wholesalePrice: price * 0.8, costFifo: cost, minMarginPct: 0, stockSellable: stock, ...extra });
    if (stock > 0) await FifoLayer.create({ productId: p._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 864e5), qtyRemaining: stock, originalQty: stock, unitCost: cost, currency: "OMR" });
    return p.toObject() as any;
  };
  const stockOf = async (p: any) => (await Product.findById(p._id).lean<any>())!.stockSellable;
  const layersOf = async (p: any) => (await FifoLayer.find({ productId: p._id }).lean<any[]>()).reduce((a, l) => a + l.qtyRemaining, 0);
  const PA = await mkP("A", 100, 1000, 40), PB = await mkP("B", 50, 1000, 20), PC = await mkP("C", 30, 1000, 10);
  // Editor-shaped lines
  const wl = (p: any, qty: number, price: number, extra: Record<string, unknown> = {}) => ({ productId: String(p._id), name: p.name, qty, unitLabel: "pcs", unitPrice: price, lineType: "wholesale", ...extra });
  let ph = 79000000;
  async function makeQuote(lines: unknown[], extra: Record<string, unknown> = {}, cookie = ck.cashier) {
    const r = await req("POST", "/api/quotations", cookie, { customerName: "Customer A", customerPhone: String(++ph), lines, vatPercent: 0, ...extra });
    return r;
  }
  async function customerApprove(id: string, decision: "approved" | "rejected" = "approved") {
    const share = await req("POST", `/api/quotations/${id}`, ck.cashier, { action: "share" });
    const token = share.body.approvalToken;
    return req("POST", `/api/quotations/public/${token}`, undefined, { decision, signedByName: "Customer A" });
  }
  const convert = (id: string, body: Record<string, unknown> = {}, cookie = ck.cashier) => req("POST", `/api/quotations/${id}`, cookie, { action: "convert", payment: "cash", salesperson: A, ...body });
  const quoteDoc = (id: string) => Quotation.findById(id).lean<any>();
  const saleDoc = (id: string) => Sale.findById(id).lean<any>();
  const salesOf = (qid: string) => Sale.countDocuments({ quotationId: new mongoose.Types.ObjectId(qid) });
  const sid = (r: R) => String(r.body.sale?.id ?? r.body.sale?._id ?? "");

  const server = spawn("npx", ["next", "start", "-p", "3954"], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 240 && (await req("GET", "/api/health")).status !== 200; i++) await sleep(500);

    console.log("\n== POS-104 / POS-105 / POS-106 convert approved multi-item quotation ==");
    const q1 = await makeQuote([wl(PA, 2, 90), wl(PB, 3, 45), wl(PC, 1, 28)]);
    rec("POS-104", "quotation created (draft) by a cashier", q1.status === 201 && q1.body.status === "draft", `HTTP ${q1.status} status=${q1.body.status} total=${q1.body.total}`);
    const s0 = { a: await stockOf(PA), b: await stockOf(PB), c: await stockOf(PC) };
    const ap = await customerApprove(q1.body.id);
    rec("POS-106", "customer approves through the public link", ap.status === 200 && (await quoteDoc(q1.body.id)).status === "approved", `HTTP ${ap.status}`);
    rec("POS-105", "no stock moved by creating / approving", (await stockOf(PA)) === s0.a && (await stockOf(PB)) === s0.b, "unchanged");
    await Product.updateOne({ _id: PA._id }, { $set: { sellPrice: 150, wholesalePrice: 120 } }); // catalogue changes after approval
    const c1 = await convert(q1.body.id, { salesperson: B, payment: "card" });
    const sale1 = c1.status === 200 ? await saleDoc(sid(c1)) : null;
    const qd1 = await quoteDoc(q1.body.id);
    rec("POS-104", "convert in one step: sale created, quotation → converted and linked", c1.status === 200 && !!sale1 && qd1.status === "converted" && String(qd1.convertedToSaleId) === String(sale1._id),
      `HTTP ${c1.status} ${c1.body.error ?? ""} sale=${sale1?._id} quotation=${qd1.status}`);
    if (sale1) {
      const ln = sale1.lines.map((l: any) => `${l.name}×${l.qty}@${l.unitPrice}`).join(", ");
      rec("POS-105", "all 3 items, same order, same qty, no duplicates", sale1.lines.length === 3 && sale1.lines[0].qty === 2 && sale1.lines[1].qty === 3 && sale1.lines[2].qty === 1 && String(sale1.lines[0].productId) === String(PA._id) && String(sale1.lines[2].productId) === String(PC._id), ln);
      rec("POS-106", "approved prices kept even after catalogue price change (90/45/28), total 343", sale1.lines[0].unitPrice === 90 && sale1.lines[1].unitPrice === 45 && sale1.total === 343 && sale1.subtotal === 343, `total ${sale1.total}, subtotal ${sale1.subtotal}`);
      rec("POS-108", "customer name/phone/id carried, salesperson and payment as chosen", sale1.customerName === "Customer A" && sale1.customerPhone === qd1.customerPhone && !!sale1.customerId && sale1.salesperson === B && sale1.payment === "card", `${sale1.customerName} ${sale1.customerPhone} id=${sale1.customerId} sp=${sale1.salesperson} pay=${sale1.payment}`);
      rec("POS-105", "inventory deducted once at conversion (A −2, B −3, C −1), FIFO layers match", s0.a - (await stockOf(PA)) === 2 && s0.b - (await stockOf(PB)) === 3 && s0.c - (await stockOf(PC)) === 1 && (await layersOf(PA)) === (await stockOf(PA)), `A −${s0.a - (await stockOf(PA))}, B −${s0.b - (await stockOf(PB))}, C −${s0.c - (await stockOf(PC))}`);
      rec("POS-104", "sale links back to its quotation (id + number)", String(sale1.quotationId) === q1.body.id && sale1.quotationNumber === qd1.number, `quotationId ${sale1.quotationId}, number ${sale1.quotationNumber}`);
      const rcpt = await fetch(`${BASE}/api/sales/${sale1._id}/receipt?as=json`, { headers: { Cookie: ck.cashier } });
      rec("Integration", "receipt for the converted sale", rcpt.status === 200, `HTTP ${rcpt.status}`);
    }
    const again = await convert(q1.body.id);
    rec("§10", "convert again → refused, no second sale", again.status === 400 && (await salesOf(q1.body.id)) === 1, `HTTP ${again.status} ${again.body.error}, sales ${await salesOf(q1.body.id)}`);

    console.log("\n== Tampered convert payload ==");
    const q2 = await makeQuote([wl(PA, 1, 90)]);
    const tDraft = await convert(q2.body.id, { status: "approved", quotationStatus: "approved", approved: true });
    rec("POS-106", "draft + client says approved → refused (server reads real status)", tDraft.status === 400 && /approved/i.test(tDraft.body.error), `HTTP ${tDraft.status} ${tDraft.body.error}`);
    await customerApprove(q2.body.id);
    const victim0 = await Customer.create({ phone: `5${tag}`.slice(0, 10), name: "Bystander" });
    const tam = await convert(q2.body.id, { customerId: String(victim0._id), discount: 100, total: 1, subtotal: 1, lines: [{ ...wl(PA, 1, 0.01) }], unitPrice: 0.01, status: "approved" });
    const tsale = tam.status === 200 ? await saleDoc(sid(tam)) : null;
    const bys = await Customer.findById(victim0._id).lean<any>();
    rec("§9", "payload customerId/discount/total/lines/prices ignored", !!tsale && tsale.total === 90 && tsale.lines[0].unitPrice === 90 && String(tsale.customerId) !== String(victim0._id) && bys.name === "Bystander", `sale total ${tsale?.total}, price ${tsale?.lines[0].unitPrice}, bystander untouched ${bys.name === "Bystander"}`);

    console.log("\n== POS-107 rejected ==");
    const q3 = await makeQuote([wl(PB, 2, 45)]);
    const rj = await customerApprove(q3.body.id, "rejected");
    const sB = await stockOf(PB);
    const c3 = await convert(q3.body.id, { status: "approved" });
    rec("POS-107", "customer-rejected quotation → convert blocked, no sale, no stock", rj.status === 200 && c3.status === 400 && /approved/i.test(c3.body.error) && (await stockOf(PB)) === sB && (await salesOf(q3.body.id)) === 0, `decision ${rj.status}; convert HTTP ${c3.status} "${c3.body.error}"`);
    for (const st of ["draft", "sent", "revised", "expired"]) {
      const q = await makeQuote([wl(PC, 1, 28)]);
      if (st !== "draft") await req("PUT", `/api/quotations/${q.body.id}`, ck.cashier, { status: st });
      const c = await convert(q.body.id);
      rec("POS-107", `status ${st} → convert blocked`, c.status === 400, `HTTP ${c.status}`);
    }
    const flip = await req("PUT", `/api/quotations/${q3.body.id}`, ck.cashier, { status: "approved" });
    const q3d = await quoteDoc(q3.body.id);
    const c3b = await convert(q3.body.id);
    rec("POS-107", "cashier overrides the CUSTOMER's rejection to approved via the status dropdown/API, then converts", "OBS",
      `PUT ${flip.status} → status ${q3d.status} while customerDecision="${q3d.customerDecision}"; convert HTTP ${c3b.status} (no approval rule defines who may approve)`);

    console.log("\n== POS-108 customer ==");
    const q4 = await makeQuote([wl(PC, 2, 28)], { customerName: "Walk-in Quote", customerPhone: String(++ph) });
    await customerApprove(q4.body.id);
    const c4 = await convert(q4.body.id);
    const s4 = await saleDoc(sid(c4));
    const cust4 = await Customer.findById(s4.customerId).lean<any>();
    rec("POS-108", "quotation without customerId → customer found/created by phone and linked both ways", !!cust4 && cust4.phone === s4.customerPhone && String((await quoteDoc(q4.body.id)).customerId) === String(cust4._id), `customer ${cust4?.name} ${cust4?.phone}`);
    const victim = await Customer.create({ phone: `4${tag}`.slice(0, 10), name: "Victim Customer", creditBalance: 0, totalPurchases: 0 });
    const q5 = await makeQuote([wl(PA, 3, 90)], { customerName: "Attacker Co", customerPhone: String(++ph), customerId: String(victim._id) });
    await customerApprove(q5.body.id);
    const c5 = await convert(q5.body.id, { payment: "credit" });
    await sleep(200);
    const v5 = await Customer.findById(victim._id).lean<any>();
    const s5 = c5.status === 200 ? await saleDoc(sid(c5)) : null;
    rec("POS-108", "quotation saved with another customer's id (different phone) → that customer is NOT renamed or charged", v5.name === "Victim Customer" && !(v5.creditBalance > 0) && String(s5?.customerId) !== String(victim._id),
      `victim now "${v5.name}", credit ${v5.creditBalance}, purchases ${v5.totalPurchases}; sale linked to victim ${String(s5?.customerId) === String(victim._id)}, sale phone ${s5?.customerPhone}`);
    rec("POS-108", "foreign customerId is not even stored on the quotation", !(await quoteDoc(q5.body.id)).customerId || String((await quoteDoc(q5.body.id)).customerId) !== String(victim._id), `stored customerId ${(await quoteDoc(q5.body.id)).customerId ?? "none"} (victim ${victim._id})`);
    const real = await Customer.create({ phone: `3${tag}`.slice(0, 10), name: "Real Name" });
    const q6 = await makeQuote([wl(PC, 1, 28)], { customerName: "Typo Name", customerPhone: real.phone, customerId: String(real._id) });
    await customerApprove(q6.body.id);
    await convert(q6.body.id);
    const r6 = await Customer.findById(real._id).lean<any>();
    rec("POS-108", "converting renames the matching customer to the quotation's name", "OBS", `customer "Real Name" → "${r6.name}" (same behaviour as POS checkout with a typed name)`);
    rec("POS-108", "change customer before final checkout", "OBS", "POS quotation mode makes customer fields read-only; change requires revising the quotation (not supported at conversion)");

    console.log("\n== POS-109 discounts ==");
    const q7 = await makeQuote([wl(PA, 1, 100, { discount: { type: "percent", value: 10 } })], { discount: 10, invoiceDiscount: { type: "amount", value: 5 } });
    const q7d = await quoteDoc(q7.body.id);
    rec("POS-109", "quotation model has no discount fields (line or invoice)", "BLOCKED", `discount sent on create was dropped: total ${q7d.total}, line keys ${Object.keys(q7d.lines[0]).join(",")}`);

    console.log("\n== Minimum price (POS-060..067 rule) at conversion ==");
    const PF = await mkP("Floor", 100, 100, 60, { minMarginPct: 20 });
    const q8 = await makeQuote([wl(PF, 2, 1)]);
    await customerApprove(q8.body.id);
    const c8 = await convert(q8.body.id);
    const s8 = c8.status === 200 ? await saleDoc(sid(c8)) : null;
    rec("Cross-feature", "cashier converts a quotation priced at 1 (min 72) → 403 Admin approval required, nothing written",
      c8.status === 403 && c8.body.code === "PRICE_FLOOR_APPROVAL_REQUIRED" && !s8 && (await salesOf(q8.body.id)) === 0 && (await quoteDoc(q8.body.id)).status === "approved", `HTTP ${c8.status} ${c8.body.code}: ${c8.body.error}`);
    const ownerU = (await User.findOne({ role: "owner" }).lean<any>())!;
    const mgrU = (await User.findOne({ role: "manager" }).lean<any>())!;
    const pw = "Qa-Admin-123";
    const { hashPassword } = await import("../../src/lib/auth/password");
    const adminTmp = await User.create({ name: "QA Admin", email: `qa-admin-${tag}@test.local`, passwordHash: hashPassword(pw), role: "owner", roleLabel: "Owner" });
    const mgrTmp = await User.create({ name: "QA Manager", email: `qa-mgr-${tag}@test.local`, passwordHash: hashPassword(pw), role: "manager", roleLabel: "Manager" });
    void ownerU; void mgrU;
    const wrongPw = await convert(q8.body.id, { approverEmail: adminTmp.email, approverPassword: "nope" });
    const mgrOk = await convert(q8.body.id, { approverEmail: mgrTmp.email, approverPassword: pw });
    rec("Cross-feature", "wrong Admin password / manager credentials → refused", wrongPw.status === 403 && mgrOk.status === 403 && (await salesOf(q8.body.id)) === 0, `${wrongPw.status} "${wrongPw.body.error}" / ${mgrOk.status} "${mgrOk.body.error}"`);
    const adminOk = await convert(q8.body.id, { approverEmail: adminTmp.email, approverPassword: pw });
    const s8b = adminOk.status === 200 ? await saleDoc(sid(adminOk)) : null;
    rec("Cross-feature", "with Admin credentials → converts at the quoted price, approver recorded", !!s8b && s8b.total === 2 && s8b.discountApprovedBy?.role === "owner", `HTTP ${adminOk.status}, total ${s8b?.total}, approver ${s8b?.discountApprovedBy?.name}`);
    const q8o = await makeQuote([wl(PF, 1, 1)]);
    await customerApprove(q8o.body.id);
    const ownConv = await convert(q8o.body.id, {}, ck.owner);
    rec("Cross-feature", "Admin converting it themselves needs no extra prompt", ownConv.status === 200, `HTTP ${ownConv.status}`);

    console.log("\n== POS-110 custom blend ==");
    const formula = await Formula.findOne({ name: "Fatima — Amber Oud Remix", status: "approved" }).lean<any>();
    const comps = (formula?.components ?? []).filter((c: any) => mongoose.isValidObjectId(c.productId));
    const snap = async () => Promise.all(comps.map(async (c: any) => (await Product.findById(c.productId).lean<any>())?.stockSellable));
    const before9 = await snap();
    const q9 = await makeQuote([
      { name: "Custom blend for Customer A", qty: 2, unitLabel: "bottle", unitPrice: 400, lineType: "custom_blend", formulaId: String(formula._id), formulaName: formula.name, bottleNote: "gold cap", designNote: "logo" },
      wl(PC, 1, 28),
    ]);
    await customerApprove(q9.body.id);
    const c9 = await convert(q9.body.id);
    const s9 = c9.status === 200 ? await saleDoc(sid(c9)) : null;
    const after9 = await snap();
    const consumed = comps.map((c: any, i: number) => `${c.productName} −${(before9[i] ?? 0) - (after9[i] ?? 0)}`);
    rec("POS-110", "custom-blend identity + formula reference kept", !!s9 && s9.lines[0].lineType === "remix" && String(s9.lines[0].formulaId) === String(formula._id) && s9.lines[0].qty === 2, s9 ? `type ${s9.lines[0].lineType}, formula kept, qty ${s9.lines[0].qty}, product ${s9.lines[0].productId ? "Remix" : "none"}` : `HTTP ${c9.status} ${c9.body.error}`);
    rec("POS-110", "bottle/design notes kept on the sale line", s9?.lines[0].bottleNote === "gold cap" && s9?.lines[0].designNote === "logo", `${s9?.lines[0].bottleNote}/${s9?.lines[0].designNote}`);
    const expectOk = comps.every((c: any, i: number) => (before9[i] ?? 0) - (after9[i] ?? 0) > 0);
    rec("POS-110", "every formula component consumed on conversion (×2 blends)", expectOk, consumed.join(", ") + `; BOM note: ${s9?.lines[0].bomNote ?? "-"}`);
    const q9b = await makeQuote([{ name: "Blend, no formula", qty: 1, unitLabel: "bottle", unitPrice: 300, lineType: "custom_blend" }]);
    await customerApprove(q9b.body.id);
    const c9b = await convert(q9b.body.id);
    rec("POS-110", "custom blend without a formula → refused with a clear message, nothing written", c9b.status === 400 && /formula/i.test(c9b.body.error) && (await salesOf(q9b.body.id)) === 0, `HTTP ${c9b.status} "${c9b.body.error}"`);
    const generic = await Formula.findOne({ name: "Remix Standard 100ml" }).lean<any>();
    const q9c = await makeQuote([{ name: "Blend generic", qty: 1, unitLabel: "bottle", unitPrice: 300, lineType: "custom_blend", formulaId: String(generic._id) }]);
    await customerApprove(q9c.body.id);
    const c9c = await convert(q9c.body.id);
    rec("POS-110", "generic remix formula (oil chosen at sale time) → clear refusal, not a crash", c9c.status === 400 && (await salesOf(q9c.body.id)) === 0, `HTTP ${c9c.status} "${c9c.body.error}"`);

    console.log("\n== Totals / VAT / charges / payment ==");
    const q11 = await makeQuote([wl(PA, 1, 100, { charges: 15 })], { vatPercent: 5 });
    await customerApprove(q11.body.id);
    const c11 = await convert(q11.body.id);
    const s11 = await saleDoc(sid(c11));
    const lineSum = s11.lines.reduce((a: number, l: any) => a + l.qty * l.unitPrice, 0);
    const rc11 = (await (await fetch(`${BASE}/api/sales/${s11._id}/receipt?as=json`, { headers: { Cookie: ck.cashier } })).json()) as any;
    rec("Integrity", "charges as own line, VAT stored: Σ lines = subtotal, subtotal + VAT = total, receipt agrees",
      Math.abs(lineSum - s11.subtotal) < 1e-6 && Math.abs(s11.subtotal + s11.vatAmount - s11.total) < 1e-6 && s11.vatPercent === 5 && rc11.vatPercent === 5 && Math.abs(rc11.vatAmount - 5.75) < 0.01 && Math.abs(rc11.total - 120.75) < 0.01,
      `lines ${s11.lines.map((l: any) => `${l.name}=${l.qty * l.unitPrice}`).join(" + ")} = ${lineSum}; subtotal ${s11.subtotal}; VAT ${s11.vatAmount}; total ${s11.total}; receipt VAT ${rc11.vatPercent}% ${rc11.vatAmount}, total ${rc11.total}`);
    const q12 = await makeQuote([wl(PB, 2, 45)]);
    await customerApprove(q12.body.id);
    const c12 = await convert(q12.body.id, { payment: "mixed" });
    const s12 = c12.status === 200 ? await saleDoc(sid(c12)) : null;
    rec("Payment", "mixed payment without a split → refused, nothing written", c12.status === 400 && !s12 && (await quoteDoc(q12.body.id)).status === "approved", `HTTP ${c12.status} "${c12.body.error}"`);
    const custBefore = await Customer.findOne({ phone: (await quoteDoc(q12.body.id)).customerPhone }).lean<any>();
    const c12b = await convert(q12.body.id, { payment: "mixed", paymentBreakdown: [{ method: "cash", amount: 50 }, { method: "credit", amount: 40 }] });
    const s12b = c12b.status === 200 ? await saleDoc(sid(c12b)) : null;
    const custAfter = await Customer.findById(s12b?.customerId).lean<any>();
    rec("Payment", "balanced mixed split stored; only the credit part goes to the balance", !!s12b && s12b.paymentBreakdown.length === 2 && (custAfter?.creditBalance ?? 0) - (custBefore?.creditBalance ?? 0) === 40, `HTTP ${c12b.status}, split ${JSON.stringify(s12b?.paymentBreakdown)}, credit +${(custAfter?.creditBalance ?? 0) - (custBefore?.creditBalance ?? 0)}`);
    const c12c = await convert((await makeQuote([wl(PB, 1, 45)])).body.id, { payment: "mixed", paymentBreakdown: [{ method: "cash", amount: 1 }] });
    rec("Payment", "split that doesn't add up → refused", c12c.status === 400, `HTTP ${c12c.status} ${c12c.body.error}`);
    const q13 = await makeQuote([wl(PB, 1, 45)]);
    await customerApprove(q13.body.id);
    const c13 = await req("POST", `/api/quotations/${q13.body.id}`, ck.cashier, { action: "convert", salesperson: A });
    const s13 = c13.status === 200 ? await saleDoc(sid(c13)) : null;
    rec("Payment", "no payment given → defaults to credit (adds to customer balance)", "OBS", `stored payment=${s13?.payment}`);
    const q14 = await makeQuote([wl(PB, 1, 45)]);
    await customerApprove(q14.body.id);
    const c14 = await convert(q14.body.id, { salesperson: "Mallory" });
    rec("Salesperson", "unknown salesperson rejected at conversion", c14.status === 400, `HTTP ${c14.status} ${c14.body.error}`);

    console.log("\n== Backend / RBAC ==");
    const q15 = await makeQuote([wl(PC, 1, 28)]);
    await customerApprove(q15.body.id);
    const u401 = await req("POST", `/api/quotations/${q15.body.id}`, undefined, { action: "convert", payment: "cash", salesperson: A });
    const acc = await convert(q15.body.id, {}, ck.accountant);
    const oth = await convert(q15.body.id, {}, ck.other);
    const bad = await convert("not-an-id");
    const badGet = await req("GET", "/api/quotations/not-an-id", ck.cashier);
    const badPut = await req("PUT", "/api/quotations/not-an-id", ck.cashier, { notes: "x" });
    const badDel = await req("DELETE", "/api/quotations/not-an-id", ck.cashier);
    rec("§9", "invalid id on GET/PUT/DELETE → 400", badGet.status === 400 && badPut.status === 400 && badDel.status === 400, `${badGet.status}/${badPut.status}/${badDel.status}`);
    const none = await convert(String(new mongoose.Types.ObjectId()));
    rec("§9", "unauthenticated 401, accountant 403, other branch 403", u401.status === 401 && acc.status === 403 && oth.status === 403, `${u401.status}/${acc.status}/${oth.status}`);
    rec("§9", "invalid id → 4xx, unknown id → 404", bad.status >= 400 && bad.status < 500 && none.status === 404, `invalid ${bad.status} ${bad.body.error ?? ""}, unknown ${none.status}`);
    const conv = await quoteDoc(q1.body.id);
    const back = await req("PUT", `/api/quotations/${q1.body.id}`, ck.cashier, { status: "draft" });
    const edit = await req("PUT", `/api/quotations/${q1.body.id}`, ck.cashier, { lines: [wl(PA, 99, 1)] });
    const after = await quoteDoc(q1.body.id);
    const meta = await req("PUT", `/api/quotations/${q1.body.id}`, ck.cashier, { notes: "delivered", customerPoNumber: "PO-9" });
    const rev = await req("POST", `/api/quotations/${q1.body.id}`, ck.cashier, { action: "revise", lines: [wl(PA, 99, 1)] });
    rec("Integrity", "converted quotation: notes/PO still editable; revise refused", meta.status === 200 && rev.status === 400, `notes PUT ${meta.status}, revise ${rev.status} ${rev.body.error ?? ""}`);
    rec("Integrity", "a converted quotation cannot be reopened and edited away from its sale", back.status === 400 && edit.status === 400 && after.status === "converted" && after.lines[0].qty === conv.lines[0].qty,
      `PUT status draft → ${back.status} (now ${after.status}); PUT lines → ${edit.status}; quotation now ${after.lines.map((l: any) => `${l.name}×${l.qty}@${l.unitPrice}`).join(",")} vs sale ${conv.lines.length} lines; convertedToSaleId still ${after.convertedToSaleId ? "set" : "unset"}`);
    const q16 = await makeQuote([wl(PC, 1, 28)]);
    const fakeConv = await req("PUT", `/api/quotations/${q16.body.id}`, ck.cashier, { status: "converted" });
    rec("Integrity", "status 'converted' cannot be set without a sale", fakeConv.status >= 400, `PUT → ${fakeConv.status}, status ${(await quoteDoc(q16.body.id)).status}, convertedToSaleId ${(await quoteDoc(q16.body.id)).convertedToSaleId ?? null}`);

    console.log("\n== §10 / §14 concurrency, load ==");
    const q17 = await makeQuote([wl(PA, 1, 90), wl(PB, 1, 45)]);
    await customerApprove(q17.body.id);
    const sa = await stockOf(PA);
    const races = await Promise.all(Array.from({ length: 15 }, (_, i) => convert(q17.body.id, {}, i % 2 ? ck.cashier : ck.cashier2)));
    const won = races.filter((r) => r.status === 200).length;
    rec("§10", "same quotation converted 15× at once → one sale, stock once", won === 1 && sa - (await stockOf(PA)) === 1 && (await salesOf(q17.body.id)) === 1 && races.every((r) => r.status < 500),
      `200×${won}, others ${[...new Set(races.filter((r) => r.status !== 200).map((r) => r.status))]}, stock −${sa - (await stockOf(PA))}`);
    const N = 60;
    const qs: string[] = [];
    for (let i = 0; i < N; i++) { const q = await makeQuote([wl(PA, 1, 90), wl(PB, 2, 45), wl(PC, 1, 28)]); await customerApprove(q.body.id); qs.push(q.body.id); }
    const s0b = { a: await stockOf(PA), b: await stockOf(PB) };
    const t = performance.now();
    const many = await Promise.all(qs.flatMap((id) => [convert(id, {}, ck.cashier), convert(id, {}, ck.cashier2)]));
    stat(`${N} quotations × 2 tills`, many, performance.now() - t);
    const ok = many.filter((r) => r.status === 200).length;
    rec("§14", `${N} quotations converted from 2 tills at once → exactly ${N} sales, stock exact, no 5xx`, ok === N && s0b.a - (await stockOf(PA)) === N && s0b.b - (await stockOf(PB)) === 2 * N && (await layersOf(PB)) === (await stockOf(PB)) && many.every((r) => r.status < 500),
      `200×${ok}, A −${s0b.a - (await stockOf(PA))}, B −${s0b.b - (await stockOf(PB))}`);
    const bigP = await Promise.all(Array.from({ length: 100 }, (_, i) => mkP(`L${i}`, 10 + i, 50, 2)));
    const qb = await makeQuote(bigP.map((p) => wl(p, 2, p.sellPrice)));
    await customerApprove(qb.body.id);
    const tb = performance.now();
    const cb = await convert(qb.body.id);
    const sb = cb.status === 200 ? await saleDoc(sid(cb)) : null;
    const allMinus2 = (await Promise.all(bigP.map(async (p) => (await stockOf(p)) === 48))).every(Boolean);
    rec("§14", "100-item quotation converts, every item −2", !!sb && sb.lines.length === 100 && allMinus2, `HTTP ${cb.status} in ${Math.round(performance.now() - tb)}ms`);
    const tI = performance.now();
    const invalid = await Promise.all(Array.from({ length: 100 }, (_, i) => convert(i % 2 ? q3.body.id : String(new mongoose.Types.ObjectId()), {}, i % 3 ? ck.cashier : ck.accountant)));
    stat("invalid/unauthorized converts ×100", invalid, performance.now() - tI);
    rec("§14", "invalid / unauthorized conversions under load: all refused, no 5xx", invalid.every((r) => r.status >= 400 && r.status < 500), `statuses ${[...new Set(invalid.map((r) => r.status))]}`);
  } finally {
    try { process.kill(-(server.pid as number), "SIGTERM"); } catch { /* */ }
    await sleep(1500);
  }
  const c = (v: Res) => out.filter((o) => o.ok === v).length;
  console.log(`\n${c(true)} passed, ${c(false)} failed, ${c("BLOCKED")} blocked, ${c("OBS")} observations`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
