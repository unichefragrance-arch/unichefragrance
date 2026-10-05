/* eslint-disable @typescript-eslint/no-explicit-any */
// QA suite: receipts — run via `npm run test:qa` (local throwaway DB only).
/**
 * POS-111..119 receipts. Server receipt = GET /api/sales/:id/receipt (?as=json).
 * WhatsApp = click-to-chat: the server/POS only builds a wa.me URL.
 * The POS prints/WhatsApps from its in-memory LastSale via buildReceiptDoc —
 * reproduced here with the real function to compare against the server.
 * Email/SMS providers are disabled for the test server — nothing is sent.
 */
import { assertLocalDb } from "../../src/lib/e2eGuard";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, Customer, FifoLayer, Product, Sale, User } from "../../src/lib/models";
import { createSessionToken } from "../../src/lib/auth/session";
import { buildReceiptDoc } from "../../src/lib/receipt/document";
import { receiptText } from "../../src/lib/receipt/text";
import { formatPaymentLabel } from "../../src/lib/receipt/document";

assertLocalDb();
const BASE = "http://localhost:3955";
type Res = boolean | "OBS" | "BLOCKED" | "NA";
const out: Res[] = [];
function rec(id: string, name: string, ok: Res, detail: string) {
  out.push(ok);
  const m = ok === "OBS" ? "  •" : ok === "BLOCKED" ? "  ■" : ok === "NA" ? "  –" : ok ? "  ✓" : "  ✗";
  console.log(`${m} [${id}] ${name} — ${detail}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type R = { status: number; ms: number; body: any; text?: string };
async function req(method: string, path: string, cookie?: string, body?: unknown): Promise<R> {
  const t = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, ms: performance.now() - t, body: json, text };
  } catch (e) { return { status: 0, ms: performance.now() - t, body: { error: String(e) } }; }
}
const pctl = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0); };
const decodeWa = (url: string) => decodeURIComponent(url.split("?text=")[1] ?? "");

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
  await AppSettings.updateOne({ key: "default" }, { $set: { salespeople: ["SP Alpha", "SP Bravo"], activeSalesperson: "SP Alpha", vatPercent: 0, currency: "OMR" } });
  const tag = Date.now();
  const mkP = async (name: string, price: number, stock = 500, cost = 1) => {
    const p = await Product.create({ sku: `RC-${name}-${tag}`, name: `RC ${name}`, category: "Perfume", unit: "pcs", sellPrice: price, costFifo: cost, stockSellable: stock });
    await FifoLayer.create({ productId: p._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 864e5), qtyRemaining: stock, originalQty: stock, unitCost: cost, currency: "OMR" });
    return p.toObject() as any;
  };
  const PA = await mkP("A", 12.5), PB = await mkP("B", 7.25), PC = await mkP("C", 30), PK = await mkP("K", 1000), PD = await mkP("D", 7.255);
  const ln = (p: any, qty: number, extra: Record<string, unknown> = {}) => ({ productId: String(p._id), name: p.name, qty, lineType: "ready", unitLabel: "pcs", unitPrice: p.sellPrice, ...extra });
  let ph = 82000000;
  const sell = (body: Record<string, unknown>, c = ck.cashier) => req("POST", "/api/sales", c, { customerPhone: String(++ph), customerName: "Receipt Customer", payment: "cash", salesperson: "SP Bravo", idempotencyKey: randomUUID(), ...body });
  const rjson = async (id: string, c = ck.cashier, qs = "") => (await req("GET", `/api/sales/${id}/receipt?as=json${qs}`, c)).body;
  const sale = (id: string) => Sale.findById(id).lean<any>();
  const stock = async (p: any) => (await Product.findById(p._id).lean<any>())!.stockSellable;

  const env = { ...process.env, EMAIL_PROVIDER: "none", RESEND_API_KEY: "disabled-for-tests", SMS_PROVIDER: "", TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "" };
  const server = spawn("npx", ["next", "start", "-p", "3955"], { cwd: process.cwd(), env, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 240 && (await req("GET", "/api/health")).status !== 200; i++) await sleep(500);

    console.log("\n== POS-111 / POS-114 / POS-117 generate receipt ==");
    const s1r = await sell({ lines: [ln(PA, 2), ln(PB, 5), ln(PC, 1)], customerName: "Aisha Receipt" });
    const s1 = await sale(s1r.body.id);
    const r1 = await rjson(s1r.body.id);
    rec("POS-111", "receipt generated for the completed sale", !!r1.receiptNo && r1.draft === false, `receiptNo ${r1.receiptNo}`);
    rec("POS-114", "products and quantities match (A×2, B×5, C×1), no extra/missing lines", r1.lines.length === 3 && r1.lines.map((l: any) => `${l.name}×${l.qty}@${l.unitPrice}`).join(",") === s1.lines.map((l: any) => `${l.name}×${l.qty}@${l.unitPrice}`).join(","), r1.lines.map((l: any) => `${l.name}×${l.qty}@${l.unitPrice}`).join(", "));
    rec("POS-115", "total matches the sale (25 + 36.25 + 30 = 91.25)", r1.total === s1.total && s1.total === 91.25, `receipt ${r1.total}, sale ${s1.total}`);
    rec("POS-117", "customer name and phone from the sale", r1.customer.name === "Aisha Receipt" && r1.customer.phone === s1.customerPhone, `${r1.customer.name} ${r1.customer.phone}`);
    rec("POS-111", "salesperson and payment from the sale", r1.salesperson === "SP Bravo" && /cash/i.test(r1.payment), `${r1.salesperson} · ${r1.payment}`);
    const html1 = (await req("GET", `/api/sales/${s1r.body.id}/receipt?format=thermal`, ck.cashier)).text ?? "";
    const htmlA4 = (await req("GET", `/api/sales/${s1r.body.id}/receipt?format=a4`, ck.cashier)).text ?? "";
    rec("POS-112", "printable HTML (thermal + A4) contains every product, quantity, total and payment", [html1, htmlA4].every((h) => h.includes("RC A") && h.includes("RC B") && h.includes("RC C") && h.includes("91.25") && /cash/i.test(h)), `thermal ${html1.length} bytes, A4 ${htmlA4.length} bytes`);
    rec("POS-112", "exact thermal/A4 layout", "BLOCKED", "layout requirements are TBD — not judged");
    const st0 = { a: await stock(PA), n: await Sale.countDocuments({}) };
    const many = await Promise.all(Array.from({ length: 20 }, () => rjson(s1r.body.id)));
    rec("POS-111", "20 receipt generations: identical, no new sale, no stock change", many.every((m) => JSON.stringify(m) === JSON.stringify(r1)) && (await stock(PA)) === st0.a && (await Sale.countDocuments({})) === st0.n, `identical ${many.every((m) => JSON.stringify(m) === JSON.stringify(r1))}, sales +${(await Sale.countDocuments({})) - st0.n}`);

    console.log("\n== POS-115 totals / discounts / VAT / rounding ==");
    const s2r = await sell({ lines: [ln(PA, 2, { discount: { type: "percent", value: 5 } }), ln(PB, 3)], invoiceDiscount: { type: "amount", value: 1 } });
    const s2 = await sale(s2r.body.id); const r2 = await rjson(s2r.body.id);
    const gross2 = r2.lines.reduce((a: number, l: any) => a + l.qty * l.unitPrice, 0);
    rec("POS-115", "discounted sale: lines − discount = total, discount and total match sale", r2.discountTotal === s2.discountTotal && r2.total === s2.total && Math.abs(gross2 - r2.discountTotal - r2.total) < 0.005, `lines ${gross2} − discount ${r2.discountTotal} = ${r2.total} (sale ${s2.total})`);
    rec("POS-115", "item-level vs invoice-level discount shown separately", "OBS", "receipt shows one combined Discount line; per-item discount display is a layout choice (TBD)");
    const s3r = await sell({ lines: [ln(PD, 1, { discount: { type: "percent", value: 5 } })] });
    const s3 = await sale(s3r.body.id); const r3 = await rjson(s3r.body.id);
    const h3 = (await req("GET", `/api/sales/${s3r.body.id}/receipt?format=thermal`, ck.cashier)).text ?? "";
    rec("POS-115", "3-decimal OMR (baisa) totals printed exactly", h3.includes(s3.total.toFixed(3)) && r3.total === s3.total, `sale total ${s3.total}; receipt total ${r3.total}; printed contains "${s3.total.toFixed(3)}": ${h3.includes(s3.total.toFixed(3))} (money() prints 2 dp: ${(Math.round(s3.total * 100) / 100).toFixed(2)})`);
    const setVat = async (v: number) => { const cur = (await req("GET", "/api/settings", ck.owner)).body; return req("PUT", "/api/settings", ck.owner, { ...cur, vatPercent: v }); };
    await setVat(5);
    const s4r = await sell({ lines: [ln(PC, 1)] });
    const r4 = await rjson(s4r.body.id);
    await setVat(0);
    rec("POS-115", "VAT 5% (prices VAT-inclusive): subtotal + VAT = total = sale", Math.abs(r4.subtotal + r4.vatAmount - r4.total) < 0.01 && r4.total === 30 && r4.vatPercent === 5, `subtotal ${r4.subtotal} + VAT ${r4.vatAmount} = ${r4.total}`);

    console.log("\n== POS-116 / POS-118 payment methods ==");
    for (const pay of ["cash", "card", "bank", "credit"]) {
      const s = await sell({ payment: pay, lines: [ln(PC, 1)] });
      const r = await rjson(s.body.id);
      rec("POS-116", `${pay} shown`, r.payment.toLowerCase().includes(pay), `"${r.payment}"`);
    }
    const mixes: Array<[string, Array<{ method: string; amount: number }>]> = [
      ["cash 500 + card 1500", [{ method: "cash", amount: 500 }, { method: "card", amount: 1500 }]],
      ["cash 1000 + bank 1000", [{ method: "cash", amount: 1000 }, { method: "bank", amount: 1000 }]],
      ["cash 500 + card 700 + credit 800", [{ method: "cash", amount: 500 }, { method: "card", amount: 700 }, { method: "credit", amount: 800 }]],
    ];
    for (const [label, split] of mixes) {
      const s = await sell({ payment: "mixed", paymentBreakdown: split, lines: [ln(PK, 2)] });
      const d = await sale(s.body.id); const r = await rjson(s.body.id);
      const ok = s.status === 201 && r.total === 2000 && split.every((p) => new RegExp(`${p.method}[^+]*${p.amount.toLocaleString("en")}|${p.method}[^+]*${p.amount}`, "i").test(r.payment)) && (r.payment.match(/\+/g) ?? []).length === split.length - 1;
      rec("POS-118", `mixed ${label}: total 2000, every component once`, ok, `"${r.payment}" (sale split ${JSON.stringify(d?.paymentBreakdown)})`);
    }

    console.log("\n== POS-119 reprint ==");
    const cust1 = await Customer.findById(s1.customerId).lean<any>();
    const before = { sale: JSON.stringify(await sale(s1r.body.id)), a: await stock(PA), n: await Sale.countDocuments({}), cust: JSON.stringify({ t: cust1.totalPurchases, c: cust1.creditBalance }) };
    await sell({ lines: [ln(PA, 1)] }); await sell({ lines: [ln(PB, 1)] }); // other sales in between
    const rp = await Promise.all(Array.from({ length: 10 }, () => rjson(s1r.body.id, ck.cashier, "&reprint=1")));
    const cust1b = await Customer.findById(s1.customerId).lean<any>();
    const sameData = rp.every((r) => r.reprint === true && r.receiptNo === r1.receiptNo && r.total === r1.total && JSON.stringify(r.lines) === JSON.stringify(r1.lines) && r.issuedAt === r1.issuedAt);
    rec("POS-119", "10 reprints after other sales: same receipt no/lines/total/date, marked REPRINT", sameData, `receiptNo ${rp[0].receiptNo}, reprint flag ${rp[0].reprint}`);
    rec("POS-119", "reprint changes nothing: sale doc, stock, sale count (only the 2 new sales), customer totals", JSON.stringify(await sale(s1r.body.id)) === before.sale && (await stock(PA)) === before.a - 1 && (await Sale.countDocuments({})) === before.n + 2 && JSON.stringify({ t: cust1b.totalPurchases, c: cust1b.creditBalance }) === before.cust, "unchanged");
    rec("POS-119", "reprint from sale history in the UI", "BLOCKED", "only the last sale of the current POS session can be reprinted; no history screen offers reprint (API supports ?reprint=1)");

    console.log("\n== POS-113 WhatsApp ==");
    rec("POS-113", "delivery mechanism", "OBS", "click-to-chat only: POS opens https://wa.me/<phone>?text=… (window.open); server 'whatsapp' channel also only returns a wa.me URL and logs status 'handoff'. No WhatsApp Business API / automated sending.");
    const wa = await req("POST", "/api/notifications/send", ck.cashier, { channels: ["whatsapp"], kind: "receipt", saleId: s1r.body.id, toPhone: s1.customerPhone });
    const waText = wa.body.whatsapp?.url ? decodeWa(wa.body.whatsapp.url) : "";
    rec("POS-113", "server-built WhatsApp link: customer's phone, this sale's receipt no, items, total, payment", wa.status === 200 && wa.body.whatsapp.url.startsWith(`https://wa.me/`) && waText.includes(r1.receiptNo) && waText.includes("RC A × 2") && waText.includes("91.25") && /cash/i.test(waText) && waText.includes("Aisha Receipt"),
      `${wa.body.whatsapp?.url?.split("?")[0]} · ${waText.split("\n").slice(0, 2).join(" | ")}`);
    const tam = await req("POST", "/api/notifications/send", ck.cashier, { channels: ["whatsapp"], kind: "receipt", saleId: s1r.body.id, toPhone: s1.customerPhone, customerName: "Someone Else", total: 1, payment: "card", lines: [{ name: "Fake item", qty: 99, unitLabel: "pcs", unitPrice: 0.01 }] });
    const tamText = tam.body.whatsapp?.url ? decodeWa(tam.body.whatsapp.url) : "";
    rec("POS-113/§11", "send with a real saleId but tampered lines/total/payment/customer → receipt uses the stored sale", !tamText.includes("Fake item") && tamText.includes("91.25"),
      `message: ${tamText.split("\n").filter((l) => /Fake|Total|Payment|Hi /.test(l)).join(" | ")}`);
    const ovr = await req("POST", "/api/notifications/send", ck.cashier, { channels: ["whatsapp"], kind: "receipt", saleId: s1r.body.id, toPhone: "70000000", message: "Your account is suspended, pay at http://evil.example" });
    rec("§19", "arbitrary 'message' override on a sale receipt is refused", !(ovr.body.whatsapp?.url && decodeWa(ovr.body.whatsapp.url).includes("evil.example")), `HTTP ${ovr.status}; text: ${ovr.body.whatsapp?.url ? decodeWa(ovr.body.whatsapp.url).slice(0, 60) : "-"}`);
    rec("POS-113", "recipient phone is the sale's customer phone", "OBS", `server accepts any toPhone (e.g. 70000000 above → ${ovr.status}); POS always sends the sale's captured phone`);

    console.log("\n== POS client print / WhatsApp path (LastSale snapshot) ==");
    // POS loaded the catalogue when RC E cost 20; the price changes before checkout.
    const PE = await mkP("E", 20);
    const cartLine = { ...ln(PE, 3) };               // what the POS cart holds (unitPrice 20)
    await Product.updateOne({ _id: PE._id }, { $set: { sellPrice: 25 } });
    const s5r = await sell({ lines: [cartLine], customerName: "Stale Price" });
    const s5 = await sale(s5r.body.id); const r5 = await rjson(s5r.body.id);
    // Exactly what pos/page.tsx builds after checkout (LastSale) and prints / WhatsApps.
    const posDoc = buildReceiptDoc({ saleId: s5r.body.id, customer: { name: "Stale Price", phone: s5.customerPhone }, salesperson: s5r.body.salesperson, payment: formatPaymentLabel("cash"), lines: s5r.body.lines.map((l: any) => ({ name: l.name, qty: l.qty, unitLabel: l.unitLabel, unitPrice: l.unitPrice })), total: s5r.body.total, discountTotal: s5r.body.discountTotal ?? 0, settings: { vatPercent: 0 } as any });
    const posText = receiptText(posDoc);
    rec("POS-112/115", "POS-printed / WhatsApp receipt uses the completed sale's prices (not the cart's)", posDoc.lines[0].unitPrice === s5.lines[0].unitPrice,
      `sale charged 3 × ${s5.lines[0].unitPrice} = ${s5.total}; POS receipt line "3 × ${posDoc.lines[0].unitPrice}" with Total ${posDoc.total}; server receipt line ${r5.lines[0].unitPrice}. WhatsApp text: ${posText.split("\n").filter((l) => /×|Total/.test(l)).join(" | ")}`);

    console.log("\n== Other sale types ==");
    const held = await req("POST", "/api/sales", ck.cashier, { customerPhone: String(++ph), status: "held", payment: "cash", salesperson: "SP Alpha", lines: [ln(PC, 1)] });
    const rh = await rjson(held.body.id);
    rec("Integration", "held bill receipt is a draft, not a final receipt", rh.draft === true, `draft=${rh.draft}`);
    const oil = await Product.findOne({ unit: "ml", name: /Oud Cambodi/ }).lean<any>();
    if (oil && oil.stockSellable > 12) {
      const so = await sell({ lines: [{ productId: String(oil._id), qty: 1, lineType: "oil", unitLabel: "1 Tola" }] });
      const ro = so.status === 201 ? await rjson(so.body.id) : null;
      rec("POS-114", "oil sold by tola shows as 1 × 1 Tola with the tola price", !!ro && ro.lines[0].qty === 1 && ro.lines[0].unitLabel === "1 Tola" && ro.total === (await sale(so.body.id)).total, ro ? `${ro.lines[0].name} ${ro.lines[0].qty} × ${ro.lines[0].unitLabel} @ ${ro.lines[0].unitPrice}` : `HTTP ${so.status} ${so.body.error}`);
    }

    console.log("\n== §11 / §19 security ==");
    const rid = s1r.body.id;
    const tq = await rjson(rid, ck.cashier, "&total=1&payment=card&customerId=x&qty=99&saleId=000000000000000000000000");
    rec("§11", "query tampering (total/payment/customerId/qty/saleId) ignored", tq.total === 91.25 && /cash/i.test(tq.payment) && tq.lines[0].qty === 2, `total ${tq.total}, payment ${tq.payment}`);
    const anon = await req("GET", `/api/sales/${rid}/receipt`, undefined);
    const acc = await req("GET", `/api/sales/${rid}/receipt?as=json`, ck.accountant);
    const oth = await req("GET", `/api/sales/${rid}/receipt?as=json`, ck.other);
    const othSend = await req("POST", "/api/notifications/send", ck.other, { channels: ["whatsapp"], kind: "receipt", saleId: rid, toPhone: "70000000" });
    const inv = await req("GET", "/api/sales/not-an-id/receipt", ck.cashier);
    const unk = await req("GET", `/api/sales/${new mongoose.Types.ObjectId()}/receipt`, ck.cashier);
    rec("§19", "no login 401; other branch 403 (view + send); invalid id 400; unknown 404", anon.status === 401 && oth.status === 403 && othSend.status === 403 && inv.status === 400 && unk.status === 404, `401?${anon.status} other ${oth.status}/${othSend.status} invalid ${inv.status} unknown ${unk.status}`);
    rec("§19", "accountant (reports role) can view receipts", "OBS", `HTTP ${acc.status}`);

    console.log("\n== §18 concurrency / load ==");
    const ids: string[] = [];
    const expected = new Map<string, number>();
    for (let i = 0; i < 20; i++) { const s = await sell({ customerName: `Load Cust ${i}`, lines: [ln(PC, 1 + (i % 4))] }); ids.push(s.body.id); expected.set(s.body.id, 30 * (1 + (i % 4))); }
    const n0 = await Sale.countDocuments({}); const c0 = await stock(PC);
    const t = performance.now();
    const rs = await Promise.all(Array.from({ length: 400 }, (_, i) => req("GET", `/api/sales/${ids[i % 20]}/receipt?as=json${i % 3 === 0 ? "&reprint=1" : ""}`, i % 2 ? ck.cashier : ck.cashier2).then((r) => ({ r, id: ids[i % 20], i }))));
    const wall = performance.now() - t;
    const ms = rs.map((x) => x.r.ms);
    const wrong = rs.filter((x) => x.r.status !== 200 || x.r.body.total !== expected.get(x.id) || x.r.body.customer.name !== `Load Cust ${ids.indexOf(x.id)}`).length;
    console.log(`    400 receipts: ${(400 / (wall / 1000)).toFixed(1)} req/s p50 ${pctl(ms, 50)}ms p95 ${pctl(ms, 95)}ms p99 ${pctl(ms, 99)}ms`);
    rec("§18", "400 concurrent receipt/reprint requests: each matches its own sale, no new sales, no stock change", wrong === 0 && (await Sale.countDocuments({})) === n0 && (await stock(PC)) === c0, `wrong ${wrong}, sales +${(await Sale.countDocuments({})) - n0}`);
    const t2 = performance.now();
    const ws = await Promise.all(Array.from({ length: 200 }, (_, i) => req("POST", "/api/notifications/send", i % 2 ? ck.cashier : ck.cashier2, { channels: ["whatsapp"], kind: "receipt", saleId: ids[i % 20], toPhone: "9" + String(70000000 + i) })));
    const ms2 = ws.map((r) => r.ms);
    const wsWrong = ws.filter((r, i) => r.status !== 200 || !decodeWa(r.body.whatsapp.url).includes(`Load Cust ${i % 20}`)).length;
    console.log(`    200 WhatsApp links: ${(200 / ((performance.now() - t2) / 1000)).toFixed(1)} req/s p50 ${pctl(ms2, 50)}ms p95 ${pctl(ms2, 95)}ms`);
    rec("§18", "200 concurrent WhatsApp link builds: each for the right sale/customer, no 5xx", wsWrong === 0, `wrong ${wsWrong}`);
  } finally {
    try { process.kill(-(server.pid as number), "SIGTERM"); } catch { /* */ }
    await sleep(1500);
  }
  const c = (v: Res) => out.filter((o) => o === v).length;
  console.log(`\n${c(true)} passed, ${c(false)} failed, ${c("BLOCKED")} blocked, ${c("OBS")} observations`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
