/* eslint-disable @typescript-eslint/no-explicit-any */
// QA suite: hold-resume — run via `npm run test:qa` (local throwaway DB only).
/**
 * Hold/Resume after the fixes. Client flow now:
 *   resume = read held bill, rebuild cart at CURRENT prices (no server write)
 *   finish = POST /api/sales {resumedFromId}  → closes the held bill atomically
 *   rehold = POST /api/sales {status:"held", resumedFromId} → updates in place
 *   discard= PATCH {status:"void"} (atomic, branch-checked)
 */
import { assertLocalDb } from "../../src/lib/e2eGuard";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, Customer, FifoLayer, Product, Sale, User } from "../../src/lib/models";
import { createSessionToken } from "../../src/lib/auth/session";

assertLocalDb();
const BASE = "http://localhost:3953";
const A = "SP Alpha", B = "SP Bravo", C = "SP Charlie";
let pass = 0, fail = 0;
const rec = (id: string, n: string, ok: boolean, d: string) => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗"} [${id}] ${n} — ${d}`); };
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
  const otherBranch = String(new mongoose.Types.ObjectId());
  const mk = async (role: string, branchId: string | null, userId?: string) => {
    const u = (await User.findOne({ role }).lean<any>())!;
    return `unich_session=${createSessionToken({ userId: userId ?? String(u._id), name: u.name, email: u.email, role: role as any, roleLabel: role, branchId, branchName: branch.name })}`;
  };
  const ck = {
    cashier: await mk("cashier", String(branch._id)),
    cashier2: await mk("cashier", String(branch._id), String(new mongoose.Types.ObjectId())),
    owner: await mk("owner", String(branch._id)),
    other: await mk("cashier", otherBranch, String(new mongoose.Types.ObjectId())),
    accountant: await mk("accountant", String(branch._id)),
  };
  await AppSettings.updateOne({ key: "default" }, { $set: { salespeople: [A, B, C], activeSalesperson: A } });
  const tag = Date.now();
  const mkP = async (name: string, price: number, stock: number, cost = 10) => {
    const p = await Product.create({ sku: `HV-${name}-${tag}`, name: `HV ${name}`, category: "Perfume", unit: "pcs", sellPrice: price, costFifo: cost, stockSellable: stock });
    if (stock > 0) await FifoLayer.create({ productId: p._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 864e5), qtyRemaining: stock, originalQty: stock, unitCost: cost, currency: "OMR" });
    return p.toObject() as any;
  };
  const setStock = async (id: unknown, qty: number) => { await Product.updateOne({ _id: id }, { $set: { stockSellable: qty } }); await FifoLayer.updateMany({ productId: id }, { $set: { qtyRemaining: 0 } }); if (qty > 0) await FifoLayer.updateOne({ productId: id }, { $set: { qtyRemaining: qty } }); };
  const stockOf = async (p: any) => (await Product.findById(p._id).lean<any>())!.stockSellable;
  const line = (p: any, qty: number, extra: Record<string, unknown> = {}) => ({ productId: String(p._id), name: p.name, qty, lineType: "ready", unitLabel: "pcs", unitPrice: p.sellPrice, ...extra });
  let ph = 78000000;
  const hold = (c: string, body: Record<string, unknown>) => req("POST", "/api/sales", c, { payment: "cash", salesperson: A, status: "held", ...body });
  const complete = (c: string, body: Record<string, unknown>) => req("POST", "/api/sales", c, { payment: "cash", salesperson: A, idempotencyKey: randomUUID(), ...body });
  const heldIds = async (c: string) => ((await req("GET", "/api/sales?status=held&limit=500", c)).body as any[]).map((s) => s.id);
  const asLines = (h: any) => h.lines.map((l: any) => ({ productId: String(l.productId), name: l.name, qty: l.qty, unitLabel: l.unitLabel, unitPrice: l.unitPrice, lineType: l.lineType, ...(l.discountType ? { discount: { type: l.discountType, value: l.discountValue } } : {}) }));
  const getSale = (id: string) => Sale.findById(id).lean<any>();

  const server = spawn("npx", ["next", "start", "-p", "3953"], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 240 && (await req("GET", "/api/health")).status !== 200; i++) await sleep(500);
    const PA = await mkP("A", 1000, 2000, 400), PB = await mkP("B", 250, 2000, 100), PC = await mkP("C", 80, 2000, 30);

    console.log("Core flow (regression)");
    const phone1 = String(++ph);
    const sA0 = await stockOf(PA);
    const h1 = await hold(ck.cashier, { customerPhone: phone1, customerName: "Customer A", salesperson: B, payment: "card", lines: [line(PA, 2, { discount: { type: "percent", value: 5 } }), line(PB, 1)], invoiceDiscount: { type: "amount", value: 10 } });
    const d1 = await getSale(h1.body.id);
    rec("POS-097", "hold stores the cart, no stock, total 2140", h1.status === 201 && d1.status === "held" && d1.total === 2140 && d1.salesperson === B && (await stockOf(PA)) === sA0, `HTTP ${h1.status} total ${d1?.total}`);
    // "resume" is now read-only
    const g1 = (await req("GET", `/api/sales/${h1.body.id}`, ck.cashier)).body;
    rec("POS-098", "resume no longer voids: bill still held while being worked on", (await getSale(h1.body.id)).status === "held", "status held");
    const f1 = await complete(ck.cashier, { customerPhone: g1.customerPhone, customerName: g1.customerName, salesperson: g1.salesperson, payment: "card", lines: asLines(g1), invoiceDiscount: { type: g1.invoiceDiscountType, value: g1.invoiceDiscountValue }, resumedFromId: h1.body.id });
    const fs1 = await getSale(f1.body.id), hs1 = await getSale(h1.body.id);
    rec("POS-098", "completion closes the held bill and links both ways", f1.status === 201 && fs1.total === 2140 && String(fs1.resumedFromId) === h1.body.id && hs1.status === "void" && String(hs1.completedSaleId) === f1.body.id && (await stockOf(PA)) === sA0 - 2,
      `sale.resumedFromId=${fs1?.resumedFromId}, held→${hs1.status}/completedSaleId=${hs1.completedSaleId}, stock −${sA0 - (await stockOf(PA))}`);
    rec("§22", "held bill → final sale linked", String(fs1.resumedFromId) === h1.body.id && String(hs1.completedSaleId) === f1.body.id, "linked");
    const again = await complete(ck.cashier, { customerPhone: g1.customerPhone, salesperson: B, payment: "card", lines: asLines(g1), resumedFromId: h1.body.id });
    rec("§18", "completing the same held bill a second time → 409, no second sale", again.status === 409 && again.body.code === "HELD_BILL_UNAVAILABLE", `HTTP ${again.status} ${again.body.error}`);

    console.log("POS-099/100/101");
    const mkBill = async (n: string, p: any, q: number) => (await hold(ck.cashier, { customerPhone: String(++ph), customerName: n, lines: [line(p, q)] })).body.id as string;
    const bA = await mkBill("Customer A", PA, 2), bB = await mkBill("Customer B", PB, 3), bC = await mkBill("Customer C", PC, 1);
    const gB = (await req("GET", `/api/sales/${bB}`, ck.cashier)).body;
    rec("POS-100", "resume B returns only B", gB.lines.length === 1 && String(gB.lines[0].productId) === String(PB._id) && gB.customerName === "Customer B", `${gB.lines[0].name}×${gB.lines[0].qty}`);
    const dA = await req("PATCH", `/api/sales/${bA}`, ck.cashier, { status: "void" });
    const dA2 = await req("PATCH", `/api/sales/${bA}`, ck.cashier, { status: "void" });
    const ids = await heldIds(ck.cashier);
    rec("POS-101", "discard A; repeat refused; B and C still held", dA.status === 200 && dA2.status === 400 && !ids.includes(bA) && ids.includes(bB) && ids.includes(bC), `${dA.status}/${dA2.status}`);
    const discardedDoc = await getSale(bA);
    rec("POS-101", "discarded vs completed are distinguishable", discardedDoc.status === "void" && !discardedDoc.completedSaleId && !!hs1.completedSaleId, "void without completedSaleId");

    console.log("§11 / POS-103: bill survives cancel and failed checkout");
    const PS = await mkP("Stock", 50, 20), PT = await mkP("Other", 30, 20);
    const hs = await hold(ck.cashier, { customerPhone: String(++ph), lines: [line(PS, 5), line(PT, 2)] });
    // resume then cancel = client just drops the cart; nothing on the server changes
    rec("§11", "resume → cancel: bill is still held and can be resumed again", (await heldIds(ck.cashier)).includes(hs.body.id), "still listed");
    await setStock(PS._id, 3);
    const gs = (await req("GET", `/api/sales/${hs.body.id}`, ck.cashier)).body;
    const tB = await stockOf(PT);
    const fsB = await complete(ck.cashier, { customerPhone: gs.customerPhone, lines: asLines(gs), resumedFromId: hs.body.id });
    rec("POS-103", "insufficient stock: refused, no partial deduction, bill still held", fsB.status === 400 && fsB.body.code === "INSUFFICIENT_STOCK" && (await stockOf(PS)) === 3 && (await stockOf(PT)) === tB && (await getSale(hs.body.id)).status === "held",
      `HTTP ${fsB.status} "${fsB.body.error}", held=${(await getSale(hs.body.id)).status}`);
    await setStock(PS._id, 10);
    const fsA = await complete(ck.cashier, { customerPhone: gs.customerPhone, lines: asLines(gs), resumedFromId: hs.body.id });
    rec("POS-103", "after restock the same held bill completes", fsA.status === 201 && (await stockOf(PS)) === 5 && (await getSale(hs.body.id)).status === "void", `HTTP ${fsA.status}, stock ${await stockOf(PS)}`);

    console.log("Re-hold updates in place");
    const hr = await hold(ck.cashier, { customerPhone: String(++ph), customerName: "Rehold", lines: [line(PC, 1)] });
    const before = (await heldIds(ck.cashier)).length;
    const hr2 = await hold(ck.cashier, { customerPhone: String(++ph), customerName: "Rehold Changed", salesperson: C, lines: [line(PC, 3), line(PB, 1)], resumedFromId: hr.body.id });
    const hrd = await getSale(hr.body.id);
    rec("POS-098", "re-holding a resumed bill keeps one bill with the new contents", hr2.status === 201 && hr2.body.id === hr.body.id && (await heldIds(ck.cashier)).length === before && hrd.lines.length === 2 && hrd.customerName === "Rehold Changed" && hrd.salesperson === C,
      `same id ${hr2.body.id === hr.body.id}, held count ${before}→${(await heldIds(ck.cashier)).length}, lines ${hrd.lines.length}`);

    console.log("POS-102 pricing: server prices on hold, current price at completion");
    const PP = await mkP("Price", 100, 50);
    const hp = await hold(ck.cashier, { customerPhone: String(++ph), lines: [{ ...line(PP, 2), unitPrice: 0.001 }] });
    const hpd = await getSale(hp.body.id);
    rec("§14", "hold ignores the client price (server catalogue price)", hpd.lines[0].unitPrice === 100 && hpd.total === 200, `held unitPrice ${hpd.lines[0].unitPrice}, total ${hpd.total}`);
    await Product.updateOne({ _id: PP._id }, { $set: { sellPrice: 120 } });
    const fp = await complete(ck.cashier, { customerPhone: hpd.customerPhone, lines: asLines(hpd), resumedFromId: hp.body.id });
    rec("POS-102", "completion charges today's price (rule: current price)", fp.status === 201 && (await getSale(fp.body.id)).total === 240, `charged ${(await getSale(fp.body.id))?.total}`);

    console.log("§14 security");
    const ghost = await hold(ck.cashier, { customerPhone: String(++ph), lines: [{ productId: String(new mongoose.Types.ObjectId()), name: "Ghost", qty: 1, lineType: "ready", unitPrice: 5 }] });
    rec("§14", "hold with a non-existent product → 400", ghost.status === 400, `HTTP ${ghost.status} ${ghost.body.error}`);
    const tgt = await hold(ck.cashier, { customerPhone: String(++ph), customerName: "Branch1 Cust", lines: [line(PC, 1)] });
    const og = await req("GET", `/api/sales/${tgt.body.id}`, ck.other);
    const ov = await req("PATCH", `/api/sales/${tgt.body.id}`, ck.other, { status: "void" });
    const orc = await fetch(`${BASE}/api/sales/${tgt.body.id}/receipt`, { headers: { Cookie: ck.other } });
    const ons = await req("POST", "/api/notifications/send", ck.other, { kind: "receipt", saleId: tgt.body.id, channels: ["whatsapp"], toPhone: "70000000" });
    const ofin = await complete(ck.other, { customerPhone: "70000001", lines: [line(PC, 1)], resumedFromId: tgt.body.id });
    rec("§14", "other branch: read / discard / receipt / send / complete another branch's held bill all refused",
      og.status === 403 && ov.status === 403 && orc.status === 403 && ons.status === 403 && ofin.status === 409 && (await getSale(tgt.body.id)).status === "held",
      `GET ${og.status}, PATCH ${ov.status}, receipt ${orc.status}, send ${ons.status}, complete ${ofin.status}; bill ${(await getSale(tgt.body.id)).status}`);
    const own = await req("GET", `/api/sales/${tgt.body.id}`, ck.cashier);
    rec("§14", "own branch still reads it", own.status === 200, `HTTP ${own.status}`);
    const accV = await req("PATCH", `/api/sales/${tgt.body.id}`, ck.accountant, { status: "void" });
    rec("§14", "accountant cannot discard", accV.status === 403, `HTTP ${accV.status}`);
    const victim = await Customer.create({ phone: `6${tag}`.slice(0, 10), name: "Victim Original" });
    const vh = await hold(ck.cashier, { customerPhone: String(++ph), customerName: "Attacker Name", customerId: String(victim._id), lines: [line(PC, 1)] });
    const vc = await complete(ck.cashier, { customerPhone: String(++ph), customerName: "Attacker Name", customerId: String(victim._id), payment: "credit", lines: [line(PC, 2)] });
    await sleep(300);
    const v = await Customer.findById(victim._id).lean<any>();
    const vhd = await getSale(vh.body.id), vcd = await getSale(vc.body.id);
    rec("§14", "foreign customerId on hold/checkout: victim not renamed, not linked, no credit",
      v.name === "Victim Original" && !(v.creditBalance > 0) && !(v.totalPurchases > 0) && String(vhd.customerId) !== String(victim._id) && String(vcd.customerId) !== String(victim._id),
      `victim "${v.name}", credit ${v.creditBalance ?? 0}, purchases ${v.totalPurchases ?? 0}`);
    const realCust = await Customer.findOne({ phone: phone1 }).lean<any>();
    const rc = await complete(ck.cashier, { customerPhone: phone1, customerName: "Customer A", customerId: String(realCust._id), lines: [line(PC, 1)] });
    rec("§14", "matching customerId (same phone) is still used", String((await getSale(rc.body.id)).customerId) === String(realCust._id), "linked to the real customer");

    console.log("§18 concurrency");
    let doubles = 0, dupSales = 0;
    for (let i = 0; i < 30; i++) {
      const hb = await hold(ck.cashier, { customerPhone: `7900${String(i).padStart(4, "0")}`, lines: [line(PC, 1)] });
      const d = await getSale(hb.body.id);
      const rs = await Promise.all([
        req("PATCH", `/api/sales/${hb.body.id}`, ck.cashier, { status: "void" }),
        req("PATCH", `/api/sales/${hb.body.id}`, ck.cashier2, { status: "void" }),
      ]);
      if (rs.every((r) => r.status === 200)) doubles++;
      const hb2 = await hold(ck.cashier, { customerPhone: `7901${String(i).padStart(4, "0")}`, lines: [line(PC, 1)] });
      const d2 = await getSale(hb2.body.id);
      const fins = await Promise.all([ck.cashier, ck.cashier2].map((c) => complete(c, { customerPhone: d2.customerPhone, lines: asLines(d2), resumedFromId: hb2.body.id })));
      if (fins.filter((r) => r.status === 201).length !== 1) dupSales++;
      void d;
    }
    rec("§18", "discard vs discard at once (30 trials): never both succeed", doubles === 0, `${doubles}/30 double successes`);
    rec("§18", "two tills complete the same resumed bill at once (30 trials): exactly one sale each time", dupSales === 0, `${dupSales}/30 trials with ≠1 sale`);
    const hx = await hold(ck.cashier, { customerPhone: String(++ph), lines: [line(PC, 1)] });
    const dx = await getSale(hx.body.id);
    const [cRes, dRes] = await Promise.all([complete(ck.cashier, { customerPhone: dx.customerPhone, lines: asLines(dx), resumedFromId: hx.body.id }), req("PATCH", `/api/sales/${hx.body.id}`, ck.cashier2, { status: "void" })]);
    rec("§18", "complete vs discard at once → exactly one wins", [cRes.status === 201, dRes.status === 200].filter(Boolean).length === 1, `complete ${cRes.status}, discard ${dRes.status}`);

    console.log("Held list / search");
    for (let i = 0; i < 230; i++) await Sale.collection.insertOne({ customerPhone: `55500${String(i).padStart(3, "0")}`, customerName: `Old Bill ${i}`, salesperson: A, payment: "cash", status: "held", lines: [], subtotal: 1, total: 1, discountTotal: 0, inventoryDeductions: [], branchId: branch._id, createdAt: new Date(Date.now() - (i + 1) * 60_000), updatedAt: new Date() });
    const list = (await req("GET", "/api/sales?status=held&limit=200", ck.cashier)).body as any[];
    const found = (await req("GET", `/api/sales?status=held&limit=50&q=${encodeURIComponent("Old Bill 229")}`, ck.cashier)).body as any[];
    const byPhone = (await req("GET", "/api/sales?status=held&limit=50&q=55500229", ck.cashier)).body as any[];
    const otherSearch = (await req("GET", `/api/sales?status=held&limit=50&q=${encodeURIComponent("Old Bill")}`, ck.other)).body as any[];
    const huge = await req("GET", "/api/sales?status=held&limit=100000", ck.cashier);
    rec("POS-099", "oldest held bill (beyond the 200 list) is found by name and by phone", list.length === 200 && found.some((s) => s.customerName === "Old Bill 229") && byPhone.some((s) => s.customerName === "Old Bill 229"), `list ${list.length}, by name ${found.length}, by phone ${byPhone.length}`);
    rec("§14", "held search stays branch-isolated; list limit capped at 500", otherSearch.length === 0 && (huge.body as any[]).length <= 500, `other-branch hits ${otherSearch.length}, limit=100000 → ${(huge.body as any[]).length}`);
    const rx = await req("GET", `/api/sales?status=held&q=${encodeURIComponent(".*(a+)+$")}`, ck.cashier);
    rec("§14", "regex characters in search are escaped (no error)", rx.status === 200, `HTTP ${rx.status}`);

    console.log("Load / stress");
    const tH = performance.now();
    const holds = await Promise.all(Array.from({ length: 300 }, (_, i) => hold([ck.cashier, ck.cashier2][i % 2], { customerPhone: String(80000000 + i), customerName: `L ${i}`, lines: [line(PA, 1 + (i % 3)), line(PB, 1), line(PC, 2)] })));
    stat("hold ×300", holds, performance.now() - tH);
    rec("LOAD", "300 concurrent holds all stored", holds.every((r) => r.status === 201), `${holds.filter((r) => r.status === 201).length}/300`);
    const docs = await Sale.find({ _id: { $in: holds.map((r) => r.body.id) } }).lean<any[]>();
    const sPC = await stockOf(PC);
    const tF = performance.now();
    const fins = await Promise.all(docs.slice(0, 150).flatMap((d) => [ck.cashier, ck.cashier2].map((c) => complete(c, { customerPhone: d.customerPhone, lines: asLines(d), resumedFromId: String(d._id) }))));
    stat("complete 150 bills, each from 2 tills at once", fins, performance.now() - tF);
    const ok = fins.filter((r) => r.status === 201).length, conflict = fins.filter((r) => r.status === 409).length;
    const linked = await Sale.countDocuments({ resumedFromId: { $in: docs.slice(0, 150).map((d) => d._id) } });
    rec("STRESS", "300 racing completions of 150 bills → exactly 150 sales, 150 conflicts, stock once", ok === 150 && conflict === 150 && linked === 150 && sPC - (await stockOf(PC)) === 300 && fins.every((r) => r.status < 500),
      `201×${ok}, 409×${conflict}, linked ${linked}, PC stock −${sPC - (await stockOf(PC))} (expected −300)`);
    const big = await Promise.all(Array.from({ length: 100 }, (_, i) => mkP(`L${i}`, 5 + i, 50, 2)));
    const bh = await hold(ck.cashier, { customerPhone: String(++ph), lines: big.map((p) => line(p, 2)) });
    const bd = await getSale(bh.body.id);
    const bf = await complete(ck.cashier, { customerPhone: bd.customerPhone, lines: asLines(bd), resumedFromId: bh.body.id });
    const allOk = (await Promise.all(big.map(async (p) => (await stockOf(p)) === 48))).every(Boolean);
    rec("STRESS", "100-line held cart completes, every product −2 once", bh.status === 201 && bf.status === 201 && allOk, `hold ${bh.status}, complete ${bf.status}`);
  } finally {
    try { process.kill(-(server.pid as number), "SIGTERM"); } catch { /* */ }
    await sleep(1500);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
