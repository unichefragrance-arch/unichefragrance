/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// QA suite: seed-data — run via `npm run test:qa` (local throwaway DB only).
import { assertLocalDb } from "../../src/lib/e2eGuard";
import { spawn } from "node:child_process";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Product, Quotation, Sale, User } from "../../src/lib/models";
import { testSessionCookie } from "../../src/lib/auth/testSession";
assertLocalDb();
const BASE = "http://localhost:3950"; const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const req = async (m: string, p: string, c?: string, b?: unknown) => { const r = await fetch(BASE + p, { method: m, headers: { "Content-Type": "application/json", ...(c ? { Cookie: c } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; };
let pass = 0, fail = 0; const rec = (n: string, ok: boolean, d: string) => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗"} ${n} — ${d}`); };
(async () => {
  await connectDB();
  const u = (await User.findOne({ role: "cashier" }).lean<any>())!;
  const ck = (await testSessionCookie({ userId: String(u._id), name: u.name, email: u.email, role: "cashier", roleLabel: "Cashier", branchId: String(u.branchId), branchName: u.branchName }));
  const srv = spawn("npx", ["next", "start", "-p", "3950"], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch { /* */ } await sleep(500); }
    const st = await AppSettings.findOne({ key: "default" }).lean<any>();
    rec("sales team seeded", st.salespeople.length === 3 && st.activeSalesperson === "Ahmad Ibrahim", st.salespeople.join(", "));
    const users = await User.find().lean<any[]>();
    rec("6 role accounts, all with a branch", users.length === 6 && users.every((x) => x.branchId), users.map((x) => x.role).join(", "));
    const rej = await Quotation.findOne({ number: "QT-2026-020" }).lean<any>();
    const r1 = await req("POST", `/api/quotations/${rej._id}`, ck, { action: "convert", payment: "cash", salesperson: "Sara Al Balushi" });
    rec("rejected quotation QT-2026-020 cannot be converted", r1.status === 400, `HTTP ${r1.status} ${r1.body.error}`);
    const blend = await Quotation.findOne({ number: "QT-2026-021" }).lean<any>();
    rec("custom-blend quotation linked to Fatima + her formula", !!blend.customerId && !!blend.lines[0].formulaId && blend.total === 530, `total ${blend.total}, formula ${blend.lines[0].formulaName}`);
    const oud = await Product.findOne({ sku: "PO-012" }).lean<any>();
    const r2 = await req("POST", `/api/quotations/${blend._id}`, ck, { action: "convert", payment: "card", salesperson: "Sara Al Balushi" });
    const sale = r2.status === 200 ? await Sale.findById(r2.body.sale.id ?? r2.body.sale._id).lean<any>() : null;
    const oudAfter = await Product.findOne({ sku: "PO-012" }).lean<any>();
    rec("cashier converts it without Admin (priced above minimum); BOM consumed; charges line; salesperson kept", r2.status === 200 && !!sale && sale.inventoryDeductions.length >= 10 && oud.stockSellable - oudAfter.stockSellable === 24 && sale.lines.length === 2 && sale.salesperson === "Sara Al Balushi",
      r2.status === 200 ? `total ${sale.total}, ${sale.inventoryDeductions.length} components, Oud −${oud.stockSellable - oudAfter.stockSellable} ml, lines ${sale.lines.map((l: any) => l.name).join(" / ")}` : `HTTP ${r2.status} ${r2.body.error}`);
    const ok3 = await req("POST", "/api/sales", ck, { customerPhone: "+968 9000 0001", payment: "cash", salesperson: "Khalid Al Harthy", idempotencyKey: String(Date.now()), lines: [{ productId: String((await Product.findOne({ sku: "SG-001" }).lean<any>())._id), qty: 1, lineType: "ready" }] });
    rec("normal POS sale with a seeded salesperson", ok3.status === 201 && ok3.body.salesperson === "Khalid Al Harthy", `HTTP ${ok3.status} ${ok3.body.salesperson ?? ok3.body.error}`);
  } finally { try { process.kill(-(srv.pid as number), "SIGTERM"); } catch { /* */ } await sleep(1000); }
  console.log(`${pass} passed, ${fail} failed`); process.exit(0);
})();
