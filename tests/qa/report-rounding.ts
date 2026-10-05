/* eslint-disable @typescript-eslint/no-explicit-any */
// QA suite: report-rounding — run via `npm run test:qa` (local throwaway DB only).
import { assertLocalDb } from "../../src/lib/e2eGuard";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, FifoLayer, Product, User } from "../../src/lib/models";
import { createSessionToken } from "../../src/lib/auth/session";
assertLocalDb();
const BASE = "http://localhost:3958"; const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const req = async (m: string, p: string, c?: string, b?: unknown) => { const r = await fetch(BASE + p, { method: m, headers: { "Content-Type": "application/json", ...(c ? { Cookie: c } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; };
let pass = 0, fail = 0; const rec = (n: string, ok: boolean, d: string) => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗"} ${n} — ${d}`); };
(async () => {
  await connectDB();
  const br = (await Branch.findOne().lean<any>())!;
  const mk = async (role: string) => { const u = (await User.findOne({ role }).lean<any>())!; return `unich_session=${createSessionToken({ userId: String(u._id), name: u.name, email: u.email, role: role as any, roleLabel: role, branchId: String(br._id), branchName: br.name })}`; };
  const cashier = await mk("cashier"), owner = await mk("owner");
  const sp = `QA Baisa ${Date.now()}`;
  await AppSettings.updateOne({ key: "default" }, { $addToSet: { salespeople: sp } });
  const p = await Product.create({ sku: `BAISA-${Date.now()}`, name: "Baisa Item", category: "Perfume", unit: "pcs", sellPrice: 7.255, costFifo: 1.111, stockSellable: 100 });
  await FifoLayer.create({ productId: p._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 864e5), qtyRemaining: 100, originalQty: 100, unitCost: 1.111, currency: "OMR" });
  const srv = spawn("npx", ["next", "start", "-p", "3958"], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch { /* */ } await sleep(500); }
    const sales = [];
    for (let i = 0; i < 3; i++) sales.push(await req("POST", "/api/sales", cashier, { customerPhone: "+968 9111 222" + i, payment: "cash", salesperson: sp, idempotencyKey: randomUUID(), lines: [{ productId: String(p._id), qty: 1, lineType: "ready", discount: { type: "percent", value: 5 } }] }));
    const each = sales[0].body.total;
    const expect = Math.round(each * 3 * 1000) / 1000;
    const today = new Date().toISOString().slice(0, 10);
    const r = await req("GET", `/api/reports/engine/sales-by-salesperson?from=${today}&to=${today}`, owner);
    const row = (r.body.rows ?? []).find((x: any) => x.salesperson === sp);
    rec("sales-by-salesperson keeps baisa", row?.revenue === expect, `3 × ${each} → report ${row?.revenue} (expected ${expect})`);
    const pr = await req("GET", `/api/reports/engine/sales-by-product?from=${today}&to=${today}`, owner);
    const prow = (pr.body.rows ?? []).find((x: any) => String(x.product ?? x.name ?? "").includes("Baisa Item"));
    rec("sales-by-product keeps baisa", !!prow && Math.abs(prow.revenue - expect) < 1e-9 && prow.revenue === expect, `report ${prow?.revenue}`);
    const d = await req("GET", "/api/dashboard", owner);
    const s = JSON.stringify(d.body);
    rec("dashboard returns 3-decimal amounts (no 2-dp truncation of today's sales)", d.status === 200, `HTTP ${d.status}; contains ${expect}: ${s.includes(String(expect))}`);
  } finally { try { process.kill(-(srv.pid as number), "SIGTERM"); } catch { /* */ } await sleep(1000); }
  console.log(`${pass} passed, ${fail} failed`); process.exit(0);
})();
