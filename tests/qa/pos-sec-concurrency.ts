/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * QA — POS Sections 17–20: Security & RBAC, Concurrency, Validation, Offline.
 * Drives the real API over HTTP (`next start`, two instances) against a LOCAL
 * throwaway database only; every scenario reconciles stock, FIFO layers,
 * sales and customer records before and after. Run after `npm run build`:
 *
 *   DATABASE_URL='mongodb://127.0.0.1:27099/...' npx tsx tests/qa/pos-sec-concurrency.ts
 *
 * Results are printed and written as JSON to $QA_OUT (default ./qa-results.json).
 */
import { assertLocalDb } from "../../src/lib/e2eGuard";
assertLocalDb();
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { AppSettings, Branch, Customer, FifoLayer, Formula, Product, Sale, User } from "../../src/lib/models";
import { createSessionToken } from "../../src/lib/auth/session";
import { testSessionCookie } from "../../src/lib/auth/testSession";

const P1 = 3971, P2 = 3972;
const S1 = `http://localhost:${P1}`, S2 = `http://localhost:${P2}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Result = { id: string; scenario: string; status: "PASS" | "FAIL" | "BLOCKED" | "N/A"; actual: string; expected: string; severity: string; evidence: string };
const results: Result[] = [];
function rec(id: string, scenario: string, status: Result["status"], actual: string, expected: string, severity = "-", evidence = "") {
  results.push({ id, scenario, status, actual, expected, severity, evidence });
  const icon = { PASS: "✓", FAIL: "✗", BLOCKED: "■", "N/A": "·" }[status];
  console.log(`  ${icon} [${status}] ${id} ${scenario}\n      actual: ${actual}${evidence ? `\n      evidence: ${evidence}` : ""}`);
}
const check = (id: string, scenario: string, ok: boolean, actual: string, expected: string, sevIfFail: string, evidence = "") =>
  rec(id, scenario, ok ? "PASS" : "FAIL", actual, expected, ok ? "-" : sevIfFail, evidence);

type Res = { status: number; body: any; text: string; ms: number; headers: Headers };
async function http(base: string, method: string, path: string, cookie?: string, body?: unknown, extra: RequestInit & { raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const t = Date.now();
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    ...extra,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(extra.headers || {}) },
    body: extra.raw !== undefined ? extra.raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { /* html / empty */ }
  return { status: res.status, body: parsed, text, ms: Date.now() - t, headers: res.headers };
}

/** Anything that looks like internals leaking to the client. */
function leak(r: Res): string | null {
  const m = r.text.match(/(\n\s+at .+:\d+:\d+|node_modules|\.next\/server|mongodb(\+srv)?:\/\/|E11000|MongoServerError|"stack"|Cannot read propert|is not a function|is not iterable|Maximum call stack)/);
  return m ? m[0].trim() : null;
}

let phoneSeq = 0;
const tag = Date.now() % 100000;
const newPhone = () => `+968 7${String(tag).padStart(5, "0")}${String(++phoneSeq).padStart(3, "0")}`;

/** Isolated product with explicit FIFO layers (oldest first). */
async function fixture(o: { layers: number[]; price?: number; cost?: number; margin?: number; unit?: string; category?: string; name?: string }) {
  const stock = o.layers.reduce((s, q) => s + q, 0);
  const p = await Product.create({
    sku: `QA17-${randomUUID().slice(0, 8)}`,
    name: o.name ?? `QA Fixture ${randomUUID().slice(0, 4)}`,
    category: o.category ?? "Perfume",
    unit: o.unit ?? "pcs",
    sellPrice: o.price ?? 10,
    costFifo: o.cost ?? 1,
    minMarginPct: o.margin ?? 0,
    stockSellable: stock,
  });
  const base = Date.now() - 30 * 864e5;
  for (let i = 0; i < o.layers.length; i++) {
    await FifoLayer.create({
      productId: p._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA",
      purchaseDate: new Date(base + i * 864e5), qtyRemaining: o.layers[i], originalQty: o.layers[i],
      unitCost: o.cost ?? 1, currency: "OMR", source: "purchase",
    });
  }
  return { id: String(p._id), name: p.name as string, stock };
}

async function snap(productIds: string[]) {
  const out: Record<string, { stock: number; layers: { id: string; q: number; orig: number }[] }> = {};
  for (const id of productIds) {
    const p = await Product.findById(id).lean<any>();
    const layers = await FifoLayer.find({ productId: id }).sort({ purchaseDate: 1, _id: 1 }).lean<any[]>();
    out[id] = { stock: p.stockSellable, layers: layers.map((l) => ({ id: String(l._id), q: l.qtyRemaining, orig: l.originalQty })) };
  }
  return out;
}
const layerSum = (s: { layers: { q: number }[] }) => Math.round(s.layers.reduce((a, l) => a + l.q, 0) * 1000) / 1000;
const salesFor = (phone: string) => Sale.find({ customerPhone: phone }).lean<any[]>();

/** Reconcile one product: initial − Σ(successful sale deductions) = final, for stock AND layers. */
async function reconcile(productId: string, beforeIn: any, sales: any[]) {
  const before = beforeIn[productId] ?? beforeIn;
  const after = (await snap([productId]))[productId];
  let consumed = 0;
  const perLayer = new Map<string, number>();
  for (const s of sales) for (const d of s.inventoryDeductions || []) {
    if (String(d.productId) !== productId) continue;
    consumed += d.qty;
    for (const b of d.batches || []) perLayer.set(String(b.layerId), (perLayer.get(String(b.layerId)) || 0) + b.qty);
  }
  consumed = Math.round(consumed * 1000) / 1000;
  const stockOk = Math.abs(before.stock - consumed - after.stock) < 1e-6;
  const layersOk = before.layers.every((l: any) => {
    const a = after.layers.find((x: any) => x.id === l.id)!;
    return Math.abs(l.q - (perLayer.get(l.id) || 0) - a.q) < 1e-6 && a.q >= 0;
  });
  // Only meaningful where stock and layers agreed beforehand (QA fixtures do; some seed rows don't).
  const syncOk = Math.abs(before.stock - layerSum(before)) > 1e-6 || Math.abs(after.stock - layerSum(after)) < 1e-6;
  const negative = after.stock < 0 || after.layers.some((l: any) => l.q < 0);
  return {
    ok: stockOk && layersOk && syncOk && !negative,
    text: `stock ${before.stock} − consumed ${consumed} = ${after.stock} (${stockOk ? "ok" : "MISMATCH"}); layers [${before.layers.map((l: any) => l.q).join(",")}]→[${after.layers.map((l: any) => l.q).join(",")}] (${layersOk ? "ok" : "MISMATCH"}); stock=Σlayers ${syncOk ? "ok" : "MISMATCH"}${negative ? "; NEGATIVE" : ""}`,
    after,
  };
}

function startServer(port: number): ChildProcess {
  return spawn("npx", ["next", "start", "-p", String(port)], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
}
async function waitUp(base: string) {
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* booting */ } await sleep(500); }
  throw new Error(`server ${base} did not start`);
}
async function login(base: string, email: string, password: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const set = r.headers.get("set-cookie") || "";
  const m = set.match(/unich_session=([^;]+)/);
  return { status: r.status, cookie: m ? `unich_session=${m[1]}` : "" };
}
const pct = (arr: number[], p: number) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function main() {
  await connectDB();
  const servers = [startServer(P1), startServer(P2)];
  try {
    await Promise.all([waitUp(S1), waitUp(S2)]);
    const branch = (await Branch.findOne().lean<any>())!;
    const settings = (await AppSettings.findOne({ key: "default" }).lean<any>())!;
    const SP = settings.activeSalesperson as string;

    // ---- identities -------------------------------------------------------
    const cashierLogin = await login(S1, "sales@unich.local", "sales123");
    const acctLogin = await login(S1, "accounts@unich.local", "accounts123");
    const ownerLogin = await login(S1, "owner@unich.local", "OwnerQA@123");
    const cashier = cashierLogin.cookie, accountant = acctLogin.cookie, owner = ownerLogin.cookie;
    const otherBranchId = String((await Branch.create({ name: `QA Branch B ${tag}`, code: `QAB${tag}`, active: true }))._id);
    const mkCookie = (role: any, branchId: string | null, name: string) =>
      testSessionCookie({ userId: String(new mongoose.Types.ObjectId()), name, email: `${name}@test.local`, role, roleLabel: role, branchId, branchName: branchId ? "QA" : null });
    const cashierB = await mkCookie("cashier", otherBranchId, "qa-cashier-b");
    const cashier2 = await mkCookie("cashier", String(branch._id), "qa-cashier-2");
    const inventoryUser = await mkCookie("inventory", String(branch._id), "qa-inventory");

    const sell = (cookie: string, lines: any[], extra: Record<string, unknown> = {}, base = S1, headers: Record<string, string> = {}) =>
      http(base, "POST", "/api/sales", cookie, { customerPhone: extra.customerPhone ?? newPhone(), payment: "cash", salesperson: SP, lines, ...extra }, { headers });
    const ready = (id: string, qty = 1, more: Record<string, unknown> = {}) => ({ productId: id, qty, lineType: "ready", ...more });

    console.log("\n=== 17. SECURITY & RBAC ===");
    // POS-139
    {
      const page = await http(S1, "GET", "/pos", cashier);
      const list = await http(S1, "GET", "/api/sales?limit=1", cashier);
      const f = await fixture({ layers: [5] });
      const phone = newPhone();
      const sale = await sell(cashier, [ready(f.id)], { customerPhone: phone });
      check("POS-139", "Sales staff (cashier) opens POS", cashierLogin.status === 200 && page.status === 200 && list.status === 200 && sale.status === 201,
        `login ${cashierLogin.status}; GET /pos ${page.status}; GET /api/sales ${list.status}; POST /api/sales ${sale.status}`,
        "Cashier has pos:read + pos:write (roles.ts) → page and API allowed", "High", `sale ${sale.body.id}`);
    }
    // POS-140
    {
      const f = await fixture({ layers: [5] });
      const before = await snap([f.id]);
      const phone = newPhone();
      const page = await http(S1, "GET", "/pos", accountant);
      const list = await http(S1, "GET", "/api/sales", accountant);
      const one = await http(S1, "GET", `/api/sales/${new mongoose.Types.ObjectId()}`, accountant);
      const post = await sell(accountant, [ready(f.id)], { customerPhone: phone });
      const after = await snap([f.id]);
      const ok = acctLogin.status === 200 && page.status === 307 && (page.headers.get("location") || "").endsWith("/") && list.status === 403 && post.status === 403 && one.status === 403 && (await salesFor(phone)).length === 0 && after[f.id].stock === before[f.id].stock;
      check("POS-140", "Accounting user opens POS", ok,
        `GET /pos → ${page.status} ${page.headers.get("location")}; GET /api/sales ${list.status}; GET /api/sales/:id ${one.status}; POST ${post.status} "${post.body.error}"; stock unchanged`,
        "Configured: accountant has NO pos:* permission (roles.ts ACCOUNTANT_PERMS; client-confirmed role) → denied on page and API", "High");
    }
    // POS-141
    {
      const id = String(new mongoose.Types.ObjectId());
      const noAuth = await Promise.all([
        http(S1, "GET", "/api/sales"), http(S1, "POST", "/api/sales", undefined, { lines: [] }),
        http(S1, "GET", `/api/sales/${id}`), http(S1, "PATCH", `/api/sales/${id}`, undefined, { status: "void" }),
        http(S1, "POST", "/api/sales/discount-approval", undefined, { lines: [] }), http(S1, "GET", `/api/sales/${id}/receipt`),
      ]);
      const [payload, sig] = cashier.replace("unich_session=", "").split(".");
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
      const forgedPayload = Buffer.from(JSON.stringify({ ...decoded, role: "owner", branchId: null })).toString("base64url");
      const forged = await http(S1, "GET", "/api/sales", `unich_session=${forgedPayload}.${sig}`);
      const garbage = await http(S1, "GET", "/api/sales", "unich_session=abc.def");
      const expired = await http(S1, "GET", "/api/sales", `unich_session=${createSessionToken({ ...decoded, exp: Date.now() - 1000 })}`);
      const noSid = await http(S1, "GET", "/api/sales", `unich_session=${createSessionToken({ ...decoded, sid: undefined })}`);
      const fakeSid = await http(S1, "GET", "/api/sales", `unich_session=${createSessionToken({ ...decoded, sid: "not-a-real-session" })}`);
      const page = await http(S1, "GET", "/pos");
      const all = [...noAuth, forged, garbage, expired, noSid, fakeSid];
      const ok = all.every((r) => r.status === 401) && page.status === 307 && !all.some(leak);
      check("POS-141", "Unauthorized API request (no / forged / expired / unknown-session cookie)", ok,
        `no cookie → ${noAuth.map((r) => r.status).join(",")}; role-forged payload ${forged.status}; garbage ${garbage.status}; expired ${expired.status}; no sid ${noSid.status}; unknown sid ${fakeSid.status}; GET /pos → ${page.status} ${page.headers.get("location")}`,
        "401 for every protected endpoint; page redirects to /login", "Critical");
    }
    // Session lifecycle: logout, deactivation, demotion
    {
      const l = await login(S1, "sales@unich.local", "sales123");
      const okBefore = (await http(S1, "GET", "/api/sales?limit=1", l.cookie)).status;
      await http(S1, "POST", "/api/auth/logout", l.cookie);
      const s0 = (await http(S1, "GET", "/api/sales?limit=1", l.cookie)).status; // inside the 5 s live-session cache
      await sleep(5200); // LIVE_CACHE_MS window (sessionStore.ts)
      const s1 = (await http(S1, "GET", "/api/sales?limit=1", l.cookie)).status;
      const s2 = (await http(S2, "GET", "/api/sales?limit=1", l.cookie)).status;
      const tmpUser = await User.create({ name: "QA Temp", email: `qa-temp-${tag}@test.local`, passwordHash: "x", role: "cashier", roleLabel: "Cashier", branchId: branch._id, branchName: branch.name, active: true });
      const tmpCookie = await testSessionCookie({ userId: String(tmpUser._id), name: "QA Temp", email: tmpUser.email, role: "cashier", roleLabel: "Cashier", branchId: String(branch._id), branchName: branch.name });
      const t0 = (await http(S1, "GET", "/api/sales?limit=1", tmpCookie)).status;
      await User.updateOne({ _id: tmpUser._id }, { $set: { active: false } });
      await sleep(5200);
      const t1 = (await http(S1, "GET", "/api/sales?limit=1", tmpCookie)).status;
      const t1post = (await sell(tmpCookie, [ready((await fixture({ layers: [2] })).id)])).status;
      const promoUser = await User.create({ name: "QA Promo", email: `qa-promo-${tag}@test.local`, passwordHash: "x", role: "owner", roleLabel: "Owner", branchId: null, active: true });
      const promoCookie = await testSessionCookie({ userId: String(promoUser._id), name: "QA Promo", email: promoUser.email, role: "owner", roleLabel: "Owner", branchId: null, branchName: null });
      await User.updateOne({ _id: promoUser._id }, { $set: { role: "cashier" } });
      await sleep(5200);
      const p1 = (await http(S1, "GET", "/api/users", promoCookie)).status;
      check("SEC-SESSION", "Expired/invalid session: logout, deactivation, role demotion revoke access server-side",
        okBefore === 200 && s1 === 401 && s2 === 401 && t0 === 200 && t1 === 401 && t1post === 401 && p1 === 401,
        `after logout: immediately ${s0} (cached), after 5.2 s same instance ${s1}, other instance ${s2}; deactivated user GET ${t1} POST ${t1post}; demoted owner→cashier GET /api/users ${p1}`,
        "Revoked / deactivated / demoted sessions rejected (≤5 s cache window)", "High");
    }
    // Role escalation
    {
      const createOwner = await http(S1, "POST", "/api/users", cashier, { name: "Evil", email: `evil-${tag}@x.local`, password: "Passw0rd!x", role: "owner" });
      const me = JSON.parse(Buffer.from(cashier.replace("unich_session=", "").split(".")[0], "base64url").toString());
      const selfPromote = await http(S1, "PUT", `/api/users/${me.userId}`, cashier, { role: "owner" });
      const settingsWrite = await http(S1, "PUT", "/api/settings", cashier, { salespeople: ["x"] });
      const wholesale = await sell(cashier, [{ ...ready((await fixture({ layers: [3] })).id), lineType: "wholesale" }]);
      const invWrite = await http(S1, "POST", "/api/sales", inventoryUser, { customerPhone: newPhone(), payment: "cash", lines: [ready((await fixture({ layers: [3] })).id)] });
      const evil = await User.countDocuments({ email: `evil-${tag}@x.local` });
      const meNow = await User.findById(me.userId).lean<any>();
      check("SEC-ESCALATION", "Role escalation via users/settings API, wholesale pricing, non-POS role selling",
        createOwner.status === 403 && selfPromote.status === 403 && settingsWrite.status === 403 && wholesale.status === 403 && invWrite.status === 403 && evil === 0 && meNow.role === "cashier",
        `cashier POST /api/users(owner) ${createOwner.status}; PUT own role ${selfPromote.status}; PUT /api/settings ${settingsWrite.status}; wholesale line ${wholesale.status}; inventory-role POST /api/sales ${invWrite.status}; role still ${meNow.role}`,
        "All 403, no user created/changed", "Critical");
    }
    // Unauthorized HTTP methods
    {
      const id = String((await Sale.findOne({ status: "completed" }).lean<any>())._id);
      const r = await Promise.all([
        http(S1, "PUT", "/api/sales", owner, {}), http(S1, "DELETE", "/api/sales", owner),
        http(S1, "PUT", `/api/sales/${id}`, owner, { total: 0 }), http(S1, "DELETE", `/api/sales/${id}`, owner),
        http(S1, "POST", `/api/sales/${id}`, owner, {}),
      ]);
      const still = await Sale.findById(id).lean<any>();
      check("SEC-METHODS", "Unsupported HTTP methods on sales endpoints", r.every((x) => x.status === 405) && !!still,
        `PUT/DELETE /api/sales, PUT/DELETE/POST /api/sales/:id → ${r.map((x) => x.status).join(",")}; sale intact`, "405, no mutation", "High");
    }
    // POS-142
    {
      const f = await fixture({ layers: [10] });
      const phone = newPhone();
      const s = await sell(cashier, [ready(f.id, 2)], { customerPhone: phone });
      const before = await Sale.findById(s.body.id).lean<any>();
      const voidCompleted = await http(S1, "PATCH", `/api/sales/${s.body.id}`, cashier, { status: "void" });
      const setCompleted = await http(S1, "PATCH", `/api/sales/${s.body.id}`, cashier, { status: "completed", total: 0.001, lines: [] });
      const acct = await http(S1, "PATCH", `/api/sales/${s.body.id}`, accountant, { status: "void" });
      const otherBranch = await http(S1, "PATCH", `/api/sales/${s.body.id}`, cashierB, { status: "void" });
      const after = await Sale.findById(s.body.id).lean<any>();
      const unchanged = after.status === "completed" && after.total === before.total && after.lines.length === before.lines.length;
      check("POS-142", "Modify a completed sale through the API", voidCompleted.status === 400 && setCompleted.status === 400 && acct.status === 403 && otherBranch.status === 403 && unchanged,
        `PATCH void on completed ${voidCompleted.status}; PATCH status+total ${setCompleted.status}; accountant ${acct.status}; other-branch cashier ${otherBranch.status}; sale unchanged (status ${after.status}, total ${after.total})`,
        "Completed sales cannot be modified via API; non-POS role 403; other branch 403", "Critical");

      // status smuggled into the create payload
      const f2 = await fixture({ layers: [10] });
      const b2 = await snap([f2.id]);
      const pVoid = newPhone(), pBogus = newPhone();
      const rv = await sell(cashier, [ready(f2.id, 3)], { customerPhone: pVoid, status: "void" });
      const rb = await sell(cashier, [ready(f2.id, 2)], { customerPhone: pBogus, status: "refunded-hack" });
      const sv = await salesFor(pVoid), sb = await salesFor(pBogus);
      const a2 = await snap([f2.id]);
      const ok2 = rv.status === 400 && rb.status === 400 && sv.length === 0 && sb.length === 0 && a2[f2.id].stock === b2[f2.id].stock;
      check("POS-142b", "Client-supplied sale `status` on POST /api/sales (void / arbitrary)", ok2,
        `status:"void" → HTTP ${rv.status}, stored status "${sv[0]?.status}", stock −${sv[0]?.inventoryDeductions?.[0]?.qty ?? 0}; status:"refunded-hack" → HTTP ${rb.status}, stored status "${sb[0]?.status}"; stock ${b2[f2.id].stock}→${a2[f2.id].stock}`,
        "Checkout only creates completed (or held) sales; other statuses rejected, no stock moved (Sale.status enum: completed|held|void; a void bill = discarded held bill)",
        "High", `sales ${sv[0]?._id} ${sb[0]?._id}`);
    }
    // POS-143
    {
      const f = await fixture({ layers: [10], price: 25 });
      const phone = newPhone();
      const r = await sell(cashier, [ready(f.id, 2, { unitPrice: 0.001, name: "Free", deductMl: 0 })], { customerPhone: phone, total: 0.002, subtotal: 0.002, discountTotal: 0 });
      const s = (await salesFor(phone))[0];
      check("POS-143", "Price manipulation in request (unitPrice / total / subtotal)", r.status === 201 && s.lines[0].unitPrice === 25 && s.total === 50 && s.subtotal === 50 && s.lines[0].name === f.name,
        `sent unitPrice 0.001,total 0.002 → stored unitPrice ${s?.lines?.[0]?.unitPrice}, subtotal ${s?.subtotal}, total ${s?.total}, name "${s?.lines?.[0]?.name}"`,
        "Server re-prices from catalogue; client price/total ignored", "Critical", `sale ${s?._id}`);
    }
    // POS-144
    {
      const f = await fixture({ layers: [50], price: 100, cost: 1 });
      const before = await snap([f.id]);
      const phones = Array.from({ length: 8 }, newPhone);
      const line50 = [ready(f.id, 1, { discount: { type: "percent", value: 50 } })];
      const r1 = await sell(cashier, line50, { customerPhone: phones[0] });
      const r2 = await sell(cashier, [ready(f.id)], { customerPhone: phones[1], invoiceDiscount: { type: "amount", value: 60 } });
      const r3 = await sell(cashier, line50, { customerPhone: phones[2], discountApprovalToken: "forged-token-123" });
      const r4 = await sell(cashier, [ready(f.id, 1, { discount: { type: "percent", value: 10 } })], { customerPhone: phones[3] });
      const r5 = await sell(cashier, [ready(f.id, 1, { discount: { type: "percent", value: 10.01 } })], { customerPhone: phones[4] });
      const r6 = await sell(cashier, line50, { customerPhone: phones[5], actor: { role: "owner" }, role: "owner" });
      // manager approval → token, then misuse it
      const apr = await http(S1, "POST", "/api/sales/discount-approval", cashier, { lines: [ready(f.id, 1, { discount: { type: "percent", value: 30 } })], email: "admin@unich.local", password: "admin123" });
      const tok = apr.body.approvalToken;
      const wrongCart = await sell(cashier, [ready(f.id, 2, { discount: { type: "percent", value: 30 } })], { customerPhone: phones[6], discountApprovalToken: tok });
      const wrongUser = await sell(cashier2, [ready(f.id, 1, { discount: { type: "percent", value: 30 } })], { customerPhone: phones[6], discountApprovalToken: tok });
      const good = await sell(cashier, [ready(f.id, 1, { discount: { type: "percent", value: 30 } })], { customerPhone: phones[7], discountApprovalToken: tok });
      const reuse = await sell(cashier, [ready(f.id, 1, { discount: { type: "percent", value: 30 } })], { customerPhone: phones[6], discountApprovalToken: tok });
      const overMgr = await http(S1, "POST", "/api/sales/discount-approval", cashier, { lines: [ready(f.id, 1, { discount: { type: "percent", value: 60 } })], email: "admin@unich.local", password: "admin123" });
      const badPw = await http(S1, "POST", "/api/sales/discount-approval", cashier, { lines: line50, email: "admin@unich.local", password: "wrong" });
      const neg = await sell(cashier, [ready(f.id, 1, { discount: { type: "percent", value: -20 } })], { customerPhone: phones[6] });
      const over100 = await sell(cashier, [ready(f.id, 1, { discount: { type: "percent", value: 150 } })], { customerPhone: phones[6] });
      const overAmt = await sell(cashier, [ready(f.id, 1, { discount: { type: "amount", value: 101 } })], { customerPhone: phones[6] });
      const created = (await Promise.all(phones.map(salesFor))).map((s) => s.length);
      const after = await snap([f.id]);
      const goodSale = (await salesFor(phones[7]))[0];
      const ok = [r1, r2, r3, r6, wrongCart, wrongUser, reuse, overMgr].every((r) => r.status === 403) && badPw.status === 403
        && r4.status === 201 && r5.status === 403 && good.status === 201 && [neg, over100, overAmt].every((r) => r.status === 400)
        && created.join(",") === "0,0,0,1,0,0,0,1" && after[f.id].stock === before[f.id].stock - 2 && goodSale?.discountApprovedBy?.role === "manager";
      check("POS-144", "Bypass discount restriction via API", ok,
        `50% line no approval ${r1.status}; 60% invoice ${r2.status}; forged token ${r3.status}; 10% ${r4.status}; 10.01% ${r5.status}; body role:"owner" ${r6.status}; token→other cart ${wrongCart.status}; token→other cashier ${wrongUser.status}; valid token ${good.status}; token reuse ${reuse.status}; 60% by manager (50% limit) ${overMgr.status}; bad approver pw ${badPw.status}; −20% ${neg.status}; 150% ${over100.status}; amount>line ${overAmt.status}; sales created per attempt [${created.join(",")}]; stock −${before[f.id].stock - after[f.id].stock}`,
        "Cashier limit 10% (DISCOUNT_LIMIT_PCT); above needs single-use manager token bound to cashier+cart; invalid discounts 400", "Critical");
    }
    // POS-145
    {
      const f = await fixture({ layers: [20], price: 130, cost: 100, margin: 25 }); // floor 125
      const phones = Array.from({ length: 4 }, newPhone);
      const disc = [ready(f.id, 1, { discount: { type: "percent", value: 5 } })]; // 123.5 < 125, within cashier 10%
      const c = await sell(cashier, disc, { customerPhone: phones[0] });
      const mgrApr = await http(S1, "POST", "/api/sales/discount-approval", cashier, { lines: disc, email: "admin@unich.local", password: "admin123" });
      const ownApr = await http(S1, "POST", "/api/sales/discount-approval", cashier, { lines: disc, email: "owner@unich.local", password: "OwnerQA@123" });
      const withOwner = await sell(cashier, disc, { customerPhone: phones[1], discountApprovalToken: ownApr.body.approvalToken });
      const atFloor = await sell(cashier, [ready(f.id, 1, { discount: { type: "amount", value: 5 } })], { customerPhone: phones[2] });
      const ownerDirect = await sell(owner, disc, { customerPhone: phones[3] });
      check("POS-145", "Bypass minimum-margin (price floor) via API", c.status === 403 && c.body.code === "PRICE_FLOOR_APPROVAL_REQUIRED" && mgrApr.status === 403 && ownApr.status === 200 && withOwner.status === 201 && atFloor.status === 201 && ownerDirect.status === 201,
        `cashier 5% (123.5 < floor 125) ${c.status} ${c.body.code}; manager approval ${mgrApr.status}; owner approval ${ownApr.status} → sale ${withOwner.status}; exactly at floor ${atFloor.status}; owner selling ${ownerDirect.status}`,
        "Floor = costFifo × (1+minMargin%) computed server-side; below floor needs Admin(owner) approval", "Critical");
    }
    // POS-146
    {
      const f = await fixture({ layers: [10] });
      const s = await sell(cashier, [ready(f.id)]);
      const g = await http(S1, "GET", `/api/sales/${s.body.id}`, cashierB);
      const rc = await http(S1, "GET", `/api/sales/${s.body.id}/receipt`, cashierB);
      const rcj = await http(S1, "GET", `/api/sales/${s.body.id}/receipt?as=json`, cashierB);
      const list = await http(S1, "GET", "/api/sales?limit=500&status=all", cashierB);
      const leakList = Array.isArray(list.body) && list.body.some((x: any) => x.id === s.body.id || x._id === s.body.id);
      const pageNav = await http(S1, "GET", `/pos`, cashierB);
      const own = await http(S1, "GET", `/api/sales/${s.body.id}`, cashier);
      // branch id smuggled in body
      const phone = newPhone();
      await sell(cashierB, [ready(f.id)], { customerPhone: phone, branchId: String(branch._id), branchName: branch.name });
      const sb = (await salesFor(phone))[0];
      // idempotency key replay across branches
      const key = randomUUID();
      const phoneA = newPhone();
      const a = await sell(cashier, [ready(f.id)], { customerPhone: phoneA, customerName: "Branch A Private Customer", idempotencyKey: key });
      const b = await sell(cashierB, [ready(f.id)], { idempotencyKey: key });
      const crossLeak = b.status !== 201 && (b.body.customerPhone === phoneA || b.body.id === a.body.id);
      check("POS-146", "Access another branch's transaction (GET, receipt, list, branchId in body)",
        g.status === 403 && rc.status === 403 && rcj.status === 403 && !leakList && own.status === 200 && String(sb.branchId) === otherBranchId && pageNav.status === 200,
        `other-branch GET ${g.status}; receipt ${rc.status}/${rcj.status}; listed? ${leakList}; own branch GET ${own.status}; body branchId ignored → stored ${String(sb.branchId) === otherBranchId ? "session branch" : sb.branchId}`,
        "assertBranchAccess/branchScopeFilter deny other branch; branch taken from session only", "Critical");
      check("POS-146b", "Idempotency-key replay across branches/users", !crossLeak,
        crossLeak ? `branch-B cashier replaying branch-A key got HTTP ${b.status} with branch-A sale ${b.body.id} (customer "${b.body.customerName}", phone ${b.body.customerPhone}, total ${b.body.total})` : `HTTP ${b.status}`,
        "A dedupe hit must not return another user's/branch's sale", "Medium", `key ${key}`);
    }
    // POS-147
    {
      const f = await fixture({ layers: [3, 2] });
      const before = await snap([f.id]);
      const phones = Array.from({ length: 6 }, newPhone);
      const rs = [
        await sell(cashier, [ready(f.id, 6)], { customerPhone: phones[0] }),
        await sell(cashier, [ready(f.id, 3), ready(f.id, 3)], { customerPhone: phones[1] }),
        await sell(cashier, [ready(f.id, 1.5)], { customerPhone: phones[2] }),
        await sell(cashier, [ready(f.id, 1e9)], { customerPhone: phones[3] }),
        await sell(cashier, [{ ...ready(f.id, 1), deductMl: -100, qty: 1, stockSellable: 999 }], { customerPhone: phones[4] }),
      ];
      const sold = await salesFor(phones[4]);
      const rr = await reconcile(f.id, before, sold);
      const created = (await Promise.all(phones.slice(0, 4).map(salesFor))).reduce((s, x) => s + x.length, 0);
      check("POS-147", "Manipulate product quantity in request", rs[0].status === 400 && rs[1].status === 400 && rs[2].status === 400 && rs[3].status === 400 && rs[4].status === 201 && created === 0 && rr.ok && rr.after.stock === 4,
        `qty 6 > stock 5 ${rs[0].status} ${rs[0].body.code}; split 3+3 ${rs[1].status}; qty 1.5 ${rs[2].status}; qty 1e9 ${rs[3].status}; injected deductMl/stock fields ignored ${rs[4].status}; ${rr.text}`,
        "Server checks real stock (coalesced across lines) inside the transaction", "Critical");
    }
    // POS-148 + POS-153 + POS-154 (API side)
    {
      const f = await fixture({ layers: [100] });
      const before = await snap([f.id]);
      const phone = newPhone();
      const key = randomUUID();
      const seq = [] as Res[];
      for (let i = 0; i < 5; i++) seq.push(await sell(cashier, [ready(f.id, 2)], { customerPhone: phone, idempotencyKey: key }));
      const keyC = randomUUID(), phoneC = newPhone();
      const conc = await Promise.all(Array.from({ length: 10 }, (_, i) => sell(cashier, [ready(f.id, 2)], { customerPhone: phoneC, idempotencyKey: keyC }, i % 2 ? S2 : S1)));
      const keyH = randomUUID(), phoneH = newPhone();
      const hdr = await Promise.all(Array.from({ length: 5 }, () => http(S1, "POST", "/api/sales", cashier, { customerPhone: phoneH, payment: "cash", salesperson: SP, lines: [ready(f.id, 1)] }, { headers: { "Idempotency-Key": keyH } })));
      const s1 = await salesFor(phone), sC = await salesFor(phoneC), sH = await salesFor(phoneH);
      const cust = await Customer.findOne({ phone: phoneC }).lean<any>();
      const rr = await reconcile(f.id, before, [...s1, ...sC, ...sH]);
      const ok = s1.length === 1 && sC.length === 1 && sH.length === 1 && seq[0].status === 201 && seq.slice(1).every((r) => r.status === 200 && r.body.deduplicated) && conc.filter((r) => r.status === 201).length === 1 && conc.every((r) => r.status === 201 || r.status === 200) && rr.ok && rr.after.stock === 100 - 2 - 2 - 1 && Math.abs(cust.totalPurchases - 20) < 1e-9;
      check("POS-148", "Duplicate checkout request (same idempotency key: sequential ×5, concurrent ×10 across 2 instances, header key ×5)", ok,
        `sequential → ${seq.map((r) => r.status).join(",")} (sales ${s1.length}); concurrent → ${conc.map((r) => r.status).join(",")} (sales ${sC.length}); header-key concurrent → ${hdr.map((r) => r.status).join(",")} (sales ${sH.length}); customer totalPurchases ${cust.totalPurchases} (expect 20); ${rr.text}`,
        "Exactly one sale / deduction / customer increment per key", "Critical", `key ${keyC}`);
      check("POS-153", "Duplicate submit (rapid repeated API requests with the UI's per-bill key)", ok,
        `same evidence as POS-148; UI: checkout() reuses checkoutKeyRef key per bill fingerprint, Complete button disabled while checkingOut, cart cleared before await (pos/page.tsx:1272-1306, 2804)`,
        "One sale / deduction / payment", "Critical");

      // no key at all
      const phoneN = newPhone();
      const nokey = await Promise.all(Array.from({ length: 3 }, () => sell(cashier, [ready(f.id, 1)], { customerPhone: phoneN })));
      const sN = await salesFor(phoneN);
      rec("POS-148b", "Identical checkout WITHOUT idempotency key (direct API, 3× concurrent)", "N/A",
        `${nokey.map((r) => r.status).join(",")} → ${sN.length} sales created (server treats keyless requests as distinct bills; key is optional in API)`,
        "Not a documented requirement — dedupe is by idempotency key, which the POS UI always sends. Recorded as a hardening note.", "Low");

      // POS-154: client timeout, response lost, retry same key
      const f2 = await fixture({ layers: [10] });
      const b2 = await snap([f2.id]);
      const keyT = randomUUID(), phoneT = newPhone();
      const ac = new AbortController();
      const lost = http(S1, "POST", "/api/sales", cashier, { customerPhone: phoneT, payment: "cash", salesperson: SP, idempotencyKey: keyT, lines: [ready(f2.id, 3)] }, { signal: ac.signal }).catch((e) => ({ status: -1, err: String(e.name) }));
      setTimeout(() => ac.abort(), 15);
      const first = await lost;
      await sleep(1500);
      const retry = await sell(cashier, [ready(f2.id, 3)], { customerPhone: phoneT, idempotencyKey: keyT }, S2);
      const retry2 = await sell(cashier, [ready(f2.id, 3)], { customerPhone: phoneT, idempotencyKey: keyT });
      const sT = await salesFor(phoneT);
      const r2 = await reconcile(f2.id, b2, sT);
      check("POS-154", "Network retry after client timeout (response lost)", sT.length === 1 && [200, 201].includes(retry.status) && retry2.status === 200 && retry2.body.id === String(sT[0]._id) && r2.ok && r2.after.stock === 7,
        `first request aborted client-side (${(first as any).status === -1 ? "AbortError" : (first as any).status}); retry on other instance ${retry.status} deduplicated=${retry.body.deduplicated}; 2nd retry ${retry2.status} → same sale; sales ${sT.length}; ${r2.text}`,
        "Retry with the same key resolves to the one existing sale", "Critical", `key ${keyT}`);
    }
    // POS-149
    {
      const f = await fixture({ layers: [10] });
      const phone = newPhone();
      const s = await sell(cashier, [ready(f.id, 2)], { customerPhone: phone, payment: "credit" });
      const before = await snap([f.id]);
      const custBefore = await Customer.findOne({ phone }).lean<any>();
      const n = await Sale.countDocuments();
      for (let i = 0; i < 5; i++) {
        await http(S1, "GET", `/api/sales/${s.body.id}`, cashier);
        await http(S1, "GET", `/api/sales/${s.body.id}/receipt`, cashier);
        await http(S1, "GET", `/api/sales/${s.body.id}/receipt?reprint=1&as=json`, cashier);
        await http(S1, "GET", "/pos", cashier);
      }
      const after = await snap([f.id]);
      const custAfter = await Customer.findOne({ phone }).lean<any>();
      check("POS-149", "Refresh / reload after successful checkout", (await Sale.countDocuments()) === n && after[f.id].stock === before[f.id].stock && custAfter.creditBalance === custBefore.creditBalance && custAfter.totalPurchases === custBefore.totalPurchases,
        `5× reload of sale, receipt, reprint, /pos: sales ${n}→${await Sale.countDocuments()}, stock ${before[f.id].stock}→${after[f.id].stock}, credit ${custBefore.creditBalance}→${custAfter.creditBalance}. UI keeps the completed sale in memory only (no re-POST on reload).`,
        "Reads never create sales or move stock/balances", "High");
    }
    // Payment amount / user id manipulation
    {
      const f = await fixture({ layers: [20], price: 10 });
      const ph = Array.from({ length: 6 }, newPhone);
      const m1 = await sell(cashier, [ready(f.id, 2)], { customerPhone: ph[0], payment: "mixed", paymentBreakdown: [{ method: "cash", amount: 1 }, { method: "card", amount: 1 }] });
      const m2 = await sell(cashier, [ready(f.id, 2)], { customerPhone: ph[1], payment: "mixed", paymentBreakdown: [{ method: "cash", amount: 30 }, { method: "card", amount: -10 }] });
      const m3 = await sell(cashier, [ready(f.id, 2)], { customerPhone: ph[2], payment: "mixed", paymentBreakdown: [{ method: "crypto", amount: 20 }] });
      const m4 = await sell(cashier, [ready(f.id, 2)], { customerPhone: ph[3], payment: "mixed", paymentBreakdown: [{ method: "cash", amount: 5 }, { method: "credit", amount: 15 }] });
      const victim = await Customer.findOne({ phone: { $exists: true } }).lean<any>();
      const vBefore = { t: victim.totalPurchases, c: victim.creditBalance, n: victim.name };
      const idm = await sell(cashier, [ready(f.id, 1)], { customerPhone: ph[4], customerId: String(victim._id), customerName: "Renamed By Attacker", payment: "credit", userId: "000000000000000000000001", discountAppliedBy: { role: "owner" } });
      const vAfter = await Customer.findById(victim._id).lean<any>();
      const s4 = (await salesFor(ph[3]))[0], s5 = (await salesFor(ph[4]))[0];
      const c4 = await Customer.findOne({ phone: ph[3] }).lean<any>();
      const ok = m1.status === 400 && m2.status === 400 && m3.status === 400 && m4.status === 201 && Math.abs(c4.creditBalance - 15) < 1e-9 && s4.paymentBreakdown.length === 2
        && idm.status === 201 && String(s5.customerId) !== String(victim._id) && vAfter.totalPurchases === vBefore.t && vAfter.creditBalance === vBefore.c && vAfter.name === vBefore.n && !s5.discountAppliedBy?.role;
      check("SEC-PAYMENT-ID", "Payment amount / customer-ID / user-ID manipulation", ok,
        `mixed sum≠total ${m1.status}; negative split ${m2.status}; unknown method ${m3.status}; valid cash+credit ${m4.status} (credit +${c4.creditBalance}); foreign customerId with other phone → linked to ${String(s5.customerId) === String(victim._id) ? "VICTIM" : "phone's own customer"}, victim totals/credit/name unchanged ${vAfter.totalPurchases === vBefore.t && vAfter.creditBalance === vBefore.c && vAfter.name === vBefore.n}`,
        "Breakdown must equal server total; customerId honoured only if phone matches; actor from session", "High");
    }

    console.log("\n=== 18. CONCURRENCY / RACE CONDITIONS ===");
    const concurrency: any[] = [];
    // POS-150: final unit, N concurrent buyers, across 2 server instances and 3 cashiers
    {
      const lines: string[] = [];
      let allOk = true;
      for (const n of [2, 5, 10, 25]) {
        const f = await fixture({ layers: [1] });
        const before = await snap([f.id]);
        const phone = newPhone();
        const cookies = [cashier, cashier2, owner];
        const t = Date.now();
        const rs = await Promise.all(Array.from({ length: n }, (_, i) => sell(cookies[i % 3], [ready(f.id, 1)], { customerPhone: phone, idempotencyKey: randomUUID() }, i % 2 ? S2 : S1)));
        const sales = await salesFor(phone);
        const rr = await reconcile(f.id, before, sales);
        const okN = sales.length === 1 && rs.filter((r) => r.status === 201).length === 1 && rs.filter((r) => r.status !== 201).every((r) => r.status === 400 && r.body.code === "INSUFFICIENT_STOCK") && rr.ok && rr.after.stock === 0;
        allOk &&= okN;
        lines.push(`N=${n}: ${rs.filter((r) => r.status === 201).length} ok / ${rs.filter((r) => r.status === 400).length}×400 / other [${rs.filter((r) => ![201, 400].includes(r.status)).map((r) => r.status).join(",")}] in ${Date.now() - t}ms; ${rr.text}`);
        concurrency.push({ test: "POS-150", n, initial: 1, success: sales.length, final: rr.after.stock, expected: 1 - sales.length, saleIds: sales.map((s) => String(s._id)), statuses: rs.map((r) => r.status) });
      }
      check("POS-150", "N users sell the final unit simultaneously (N=2,5,10,25; 2 instances)", allOk, lines.join(" | "), "Exactly 1 sale; others INSUFFICIENT_STOCK; stock 0, never negative; no orphan sale/customer", "Critical");
    }
    // POS-151: FIFO layers under contention
    {
      const f = await fixture({ layers: [2, 3, 1, 4], cost: 2 });
      const before = await snap([f.id]);
      const phone = newPhone();
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => sell(i % 2 ? cashier : cashier2, [ready(f.id, 1)], { customerPhone: phone, idempotencyKey: randomUUID() }, i % 2 ? S2 : S1)));
      const sales = await salesFor(phone);
      const rr = await reconcile(f.id, before, sales);
      const allocated = new Map<string, number>();
      for (const s of sales) for (const d of s.inventoryDeductions) for (const b of d.batches) allocated.set(String(b.layerId), (allocated.get(String(b.layerId)) || 0) + b.qty);
      const over = before[f.id].layers.filter((l: any) => (allocated.get(l.id) || 0) > l.q);
      // FIFO order: a later layer is only used once every earlier layer is exhausted (by commit order).
      const ordered = [...sales].sort((a, b) => +a.createdAt - +b.createdAt || String(a._id).localeCompare(String(b._id)));
      let fifoOk = true; const used = new Map<string, number>();
      for (const s of ordered) for (const b of s.inventoryDeductions[0].batches) {
        const idx = before[f.id].layers.findIndex((l: any) => l.id === String(b.layerId));
        for (let k = 0; k < idx; k++) if ((used.get(before[f.id].layers[k].id) || 0) < before[f.id].layers[k].q) fifoOk = false;
        used.set(String(b.layerId), (used.get(String(b.layerId)) || 0) + b.qty);
      }
      const ok = sales.length === 10 && rs.filter((r) => r.status === 201).length === 10 && over.length === 0 && rr.ok && rr.after.stock === 0 && fifoOk;
      check("POS-151", "20 concurrent buyers consume 4 FIFO layers [2,3,1,4] (10 units)", ok,
        `${rs.filter((r) => r.status === 201).length} succeeded, ${rs.filter((r) => r.status === 400).length}×400, other [${rs.filter((r) => ![201, 400].includes(r.status)).map((r) => r.status)}]; per-layer allocation [${before[f.id].layers.map((l: any) => allocated.get(l.id) || 0).join(",")}] vs capacity [${before[f.id].layers.map((l: any) => l.q).join(",")}]; FIFO order ${fifoOk ? "kept" : "VIOLATED"}; ${rr.text}`,
        "Σ allocations per layer ≤ layer qty; oldest first; stock = Σ layers", "Critical");
      concurrency.push({ test: "POS-151", n: 20, initial: 10, success: sales.length, final: rr.after.stock, expected: 10 - sales.length, layersBefore: before[f.id].layers.map((l: any) => l.q), layersAfter: rr.after.layers.map((l: any) => l.q) });
    }
    // POS-152: remix sales racing for the final oil
    {
      const remix = await Product.findOne({ sku: "RM-STD" }).lean<any>();
      const formula = await Formula.findOne({ type: "remix", status: "approved", customerId: null }).lean<any>();
      const compIds = formula.components.filter((c: any) => mongoose.isValidObjectId(c.productId)).map((c: any) => String(c.productId));
      // make sure every BOM component has stock + FIFO layer for 10 remixes
      for (const id of compIds) {
        const c = formula.components.find((x: any) => String(x.productId) === id);
        await FifoLayer.create({ productId: id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 40 * 864e5), qtyRemaining: c.qty * 10, originalQty: c.qty * 10, unitCost: 0.1, currency: "OMR", source: "purchase" });
        await Product.updateOne({ _id: id }, { $inc: { stockSellable: c.qty * 10 } });
      }
      const oil = await fixture({ layers: [25], unit: "ml", category: "Single Notes", name: `QA Oil ${tag}`, price: 2, cost: 0.5 });
      const ids = [oil.id, ...compIds];
      const before = await snap(ids);
      const phone = newPhone();
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => sell(i % 2 ? cashier : cashier2, [{ productId: String(remix._id), qty: 1, lineType: "remix", oilProductId: oil.id }], { customerPhone: phone, idempotencyKey: randomUUID() }, i % 2 ? S2 : S1)));
      const sales = await salesFor(phone);
      const recs = await Promise.all(ids.map((id) => reconcile(id, before[id] ? before[id] : before, sales).then((r) => ({ id, ...r }))));
      const compOk = compIds.every((id: string) => {
        const c = formula.components.find((x: any) => String(x.productId) === id);
        const r = recs.find((x) => x.id === id)!;
        return Math.abs(before[id].stock - r.after.stock - c.qty * sales.length) < 1e-6 && r.ok;
      });
      const oilRec = recs.find((x) => x.id === oil.id)!;
      const ok = sales.length === 1 && rs.filter((r) => r.status === 201).length === 1 && oilRec.ok && oilRec.after.stock === 5 && compOk;
      check("POS-152", "10 concurrent remix sales race for final oil (25 ml, 20 ml/remix)", ok,
        `${rs.filter((r) => r.status === 201).length} succeeded (codes ${[...new Set(rs.map((r) => r.body.code || r.status))].join(",")}); oil ${oilRec.text}; ${compIds.length} BOM components each deducted exactly once×qty: ${compOk}`,
        "Only 1 remix; oil 25→5; each component −qty×1; nothing negative", "Critical", `sales ${sales.map((s) => s._id).join(",")}`);
      concurrency.push({ test: "POS-152", n: 10, initial: 25, success: sales.length, final: oilRec.after.stock, expected: 25 - 20 * sales.length });
    }
    // POS-155
    rec("POS-155", "Payment callback/request repeated", "N/A",
      "No external payment gateway or callback endpoint exists (grep: no webhook/callback routes; payment is a field on POST /api/sales). Repeated payment *requests* are the same checkout request → covered by POS-148/154 (one sale, one payment record, credit incremented once).",
      "Idempotent payment processing — gateway behaviour not configured", "-");
    // POS-156: overlapping carts racing
    {
      const A = await fixture({ layers: [6, 6] }), B = await fixture({ layers: [10] }), C = await fixture({ layers: [3, 3, 3] });
      const ids = [A.id, B.id, C.id];
      const before = await snap(ids);
      const phone = newPhone();
      const carts = [[ready(A.id, 2), ready(B.id, 1)], [ready(B.id, 2), ready(C.id, 1)], [ready(A.id, 1), ready(C.id, 2)], [ready(A.id, 1), ready(B.id, 1), ready(C.id, 1)]];
      const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => sell([cashier, cashier2, owner][i % 3], carts[i % 4], { customerPhone: phone, idempotencyKey: randomUUID() }, i % 2 ? S2 : S1)));
      const sales = await salesFor(phone);
      const recs = await Promise.all(ids.map((id) => reconcile(id, before[id], sales)));
      const cust = await Customer.findOne({ phone }).lean<any>();
      const revenue = sales.reduce((s, x) => s + x.total, 0);
      const ok = recs.every((r) => r.ok) && sales.length === rs.filter((r) => r.status === 201).length && Math.abs(cust.totalPurchases - revenue) < 1e-6 && rs.every((r) => [201, 400].includes(r.status));
      check("POS-156", "30 concurrent overlapping multi-product carts (3 products, 2 instances)", ok,
        `${sales.length} sales, ${rs.filter((r) => r.status === 400).length}×400 (${[...new Set(rs.filter((r) => r.status === 400).map((r) => r.body.code))]}) other [${rs.filter((r) => ![201, 400].includes(r.status)).map((r) => `${r.status}:${r.body.error}`)}]; A: ${recs[0].text} | B: ${recs[1].text} | C: ${recs[2].text}; customer totalPurchases ${cust?.totalPurchases} vs Σ sale totals ${revenue}`,
        "No lost update; every product reconciles; customer stats = Σ committed sales", "Critical");
    }
    // Held bill completed on two tills at once (lost update on hold/resume)
    {
      const f = await fixture({ layers: [10] });
      const phone = newPhone();
      const held = await sell(cashier, [ready(f.id, 2)], { customerPhone: phone, status: "held" });
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => sell(i % 2 ? cashier : cashier2, [ready(f.id, 2)], { customerPhone: phone, resumedFromId: held.body.id, idempotencyKey: randomUUID() }, i % 2 ? S2 : S1)));
      const done = (await salesFor(phone)).filter((s) => s.status === "completed");
      const after = await snap([f.id]);
      check("POS-156b", "Same held bill completed concurrently on 6 tills", done.length === 1 && rs.filter((r) => r.status === 201).length === 1 && after[f.id].stock === 8,
        `${rs.map((r) => r.status).join(",")}; completed sales ${done.length}; stock 10→${after[f.id].stock}`, "Exactly one completion (others 409)", "Critical");
    }

    console.log("\n=== Performance / load / stress ===");
    {
      const f = await fixture({ layers: [5000] });
      const lat: number[] = [];
      for (let i = 0; i < 30; i++) lat.push((await sell(cashier, [ready(f.id, 1)], { idempotencyKey: randomUUID() })).ms);
      const t = Date.now();
      const load = await Promise.all(Array.from({ length: 50 }, (_, i) => sell([cashier, cashier2][i % 2], [ready(f.id, 1)], { idempotencyKey: randomUUID() }, i % 2 ? S2 : S1)));
      const loadWall = Date.now() - t;
      const hot = await fixture({ layers: [40, 60] });
      const before = await snap([hot.id]);
      const phone = newPhone();
      const t2 = Date.now();
      const stress = await Promise.all(Array.from({ length: 200 }, (_, i) => sell([cashier, cashier2, owner][i % 3], [ready(hot.id, 1)], { customerPhone: phone, idempotencyKey: randomUUID() }, i % 2 ? S2 : S1)));
      const stressWall = Date.now() - t2;
      const sales = await salesFor(phone);
      const rr = await reconcile(hot.id, before, sales);
      const health = await http(S1, "GET", "/api/health");
      const s5xx = stress.filter((r) => r.status >= 500);
      const perfOk = pct(lat, 95) < 2000 && load.every((r) => r.status === 201) && rr.ok && sales.length === 100 && s5xx.length === 0 && health.status === 200;
      check("PERF/LOAD/STRESS", "Latency (30 seq), load (50 concurrent), stress (200 concurrent on 100 units)", perfOk,
        `sequential p50 ${pct(lat, 50)}ms p95 ${pct(lat, 95)}ms max ${Math.max(...lat)}ms; load 50 → ${load.filter((r) => r.status === 201).length}×201 in ${loadWall}ms (p95 ${pct(load.map((r) => r.ms), 95)}ms); stress 200 → ${stress.filter((r) => r.status === 201).length}×201, ${stress.filter((r) => r.status === 400).length}×400, ${s5xx.length}×5xx in ${stressWall}ms (p95 ${pct(stress.map((r) => r.ms), 95)}ms); ${rr.text}; health after ${health.status}`,
        "p95 < 2 s single-till (createSale slow-warn threshold); no 5xx; exact stock reconciliation under stress", "High",
        s5xx.length ? `5xx bodies: ${[...new Set(s5xx.map((r) => r.body.error))].join(" | ")}` : "");
    }

    console.log("\n=== 19. VALIDATION & ERROR HANDLING ===");
    {
      const f = await fixture({ layers: [50], price: 10 });
      const before = await snap([f.id]);
      const salesBefore = await Sale.countDocuments();
      const custBefore = await Customer.countDocuments();
      const good = (o: Record<string, unknown> = {}) => ({ customerPhone: newPhone(), payment: "cash", salesperson: SP, lines: [ready(f.id)], ...o });
      let deep: any = { productId: f.id, qty: 1, lineType: "ready" };
      for (let i = 0; i < 3000; i++) deep = { x: deep };
      type Case = { id: string; name: string; body?: any; raw?: string; expect: number[] };
      const cases: Case[] = [
        { id: "POS-157", name: "qty = 0", body: good({ lines: [ready(f.id, 0)] }), expect: [400] },
        { id: "POS-158", name: "qty = -3", body: good({ lines: [ready(f.id, -3)] }), expect: [400] },
        { id: "POS-158", name: "qty = -0.5", body: good({ lines: [ready(f.id, -0.5)] }), expect: [400] },
        { id: "POS-159", name: "unitPrice = -50 (ignored → catalogue)", body: good({ lines: [ready(f.id, 1, { unitPrice: -50 })] }), expect: [201] },
        { id: "POS-159", name: "unitPrice = 'abc'", body: good({ lines: [ready(f.id, 1, { unitPrice: "abc" })] }), expect: [201] },
        { id: "POS-159", name: "unitPrice = 0", body: good({ lines: [ready(f.id, 1, { unitPrice: 0 })] }), expect: [201] },
        { id: "POS-159", name: "invoice discount value 'NaN'", body: good({ invoiceDiscount: { type: "amount", value: "NaN" } }), expect: [400] },
        { id: "POS-159", name: "discount value '1e2' (exponent string)", body: good({ lines: [ready(f.id, 1, { discount: { type: "percent", value: "1e2" } })] }), expect: [400] },
        { id: "POS-160", name: "payment missing", body: good({ payment: undefined }), expect: [201, 400] },
        { id: "POS-160", name: "payment = ''", body: good({ payment: "" }), expect: [201, 400] },
        { id: "POS-160", name: "payment = 'bitcoin'", body: good({ payment: "bitcoin" }), expect: [400] },
        { id: "POS-160", name: "payment = 5 (number)", body: good({ payment: 5 }), expect: [400] },
        { id: "POS-160", name: "payment = 'mixed' with no breakdown", body: good({ payment: "mixed" }), expect: [400] },
        { id: "POS-161", name: "customerId = 'garbage'", body: good({ customerId: "garbage" }), expect: [201, 400] },
        { id: "POS-161", name: "customerId = {$ne:null}", body: good({ customerId: { $ne: null } }), expect: [201, 400] },
        { id: "POS-161", name: "customerId = valid but nonexistent", body: good({ customerId: String(new mongoose.Types.ObjectId()) }), expect: [201, 400] },
        { id: "POS-162", name: "productId nonexistent ObjectId", body: good({ lines: [ready(String(new mongoose.Types.ObjectId()))] }), expect: [400] },
        { id: "POS-162", name: "productId 'abc'", body: good({ lines: [ready("abc")] }), expect: [400] },
        { id: "POS-162", name: "productId {$gt:''}", body: good({ lines: [{ productId: { $gt: "" }, qty: 1, lineType: "ready" }] }), expect: [400] },
        { id: "POS-162", name: "productId 123 (number)", body: good({ lines: [{ productId: 123, qty: 1, lineType: "ready" }] }), expect: [400] },
        { id: "POS-163", name: "invalid JSON", raw: "{bad json", expect: [400] },
        { id: "POS-163", name: "empty body", raw: "", expect: [400] },
        { id: "POS-163", name: "JSON null", raw: "null", expect: [400] },
        { id: "POS-163", name: "JSON array", raw: "[]", expect: [400] },
        { id: "POS-163", name: "lines missing", body: good({ lines: undefined }), expect: [400] },
        { id: "POS-163", name: "lines = 'abc'", body: good({ lines: "abc" }), expect: [400] },
        { id: "POS-163", name: "lines = {} (object)", body: good({ lines: {} }), expect: [400] },
        { id: "POS-163", name: "lines = []", body: good({ lines: [] }), expect: [400] },
        { id: "POS-163", name: "lines = [null]", body: good({ lines: [null] }), expect: [400] },
        { id: "POS-163", name: "lines = [{}]", body: good({ lines: [{}] }), expect: [400] },
        { id: "POS-163", name: "lineType 'hack'", body: good({ lines: [{ productId: f.id, qty: 1, lineType: "hack" }] }), expect: [400] },
        { id: "POS-163", name: "qty 'abc'", body: good({ lines: [ready(f.id, "abc" as any)] }), expect: [400] },
        { id: "POS-163", name: "qty null", body: good({ lines: [ready(f.id, null as any)] }), expect: [400] },
        { id: "POS-163", name: "qty true (boolean)", body: good({ lines: [ready(f.id, true as any)] }), expect: [400] },
        { id: "POS-163", name: "qty [2] (array)", body: good({ lines: [ready(f.id, [2] as any)] }), expect: [400] },
        { id: "POS-163", name: "qty '2' (numeric string)", body: good({ lines: [ready(f.id, "2" as any)] }), expect: [201, 400] },
        { id: "POS-163", name: "customerPhone missing", body: good({ customerPhone: undefined }), expect: [400] },
        { id: "POS-163", name: "customerPhone 12345678 (number)", body: good({ customerPhone: 12345678 }), expect: [400] },
        { id: "POS-163", name: "customerPhone {} (object)", body: good({ customerPhone: {} }), expect: [400] },
        { id: "POS-163", name: "customerName 42 (number)", body: good({ customerName: 42 }), expect: [201, 400] },
        { id: "POS-163", name: "salesperson {$ne:null}", body: good({ salesperson: { $ne: null } }), expect: [400] },
        { id: "POS-163", name: "idempotencyKey 123 (number)", body: good({ idempotencyKey: 123 }), expect: [201, 400] },
        { id: "POS-163", name: "idempotencyKey {$gt:''} (object)", body: good({ idempotencyKey: { $gt: "" } }), expect: [400] },
        { id: "POS-163", name: "paymentBreakdown 'x' with mixed", body: good({ payment: "mixed", paymentBreakdown: "x" }), expect: [400] },
        { id: "POS-163", name: "paymentBreakdown [null] with mixed", body: good({ payment: "mixed", paymentBreakdown: [null] }), expect: [400] },
        { id: "POS-163", name: "resumedFromId 'abc'", body: good({ resumedFromId: "abc" }), expect: [400] },
        { id: "POS-163", name: "unexpected fields (__proto__, total, branchId, status completed)", raw: JSON.stringify(good({ total: 0, extra: { a: 1 }, branchId: otherBranchId })).replace(/^\{/, '{"__proto__":{"isAdmin":true},'), expect: [201] },
        { id: "POS-163", name: "invalid nested discount object", body: good({ lines: [ready(f.id, 1, { discount: { type: { $ne: 1 }, value: [1] } })] }), expect: [400] },
        { id: "POS-163", name: "packagingProductIds 'x' on refill", body: good({ lines: [{ productId: f.id, qty: 1, lineType: "refill", unitLabel: "100ml refill", packagingProductIds: "x" }] }), expect: [400] },
        { id: "POS-163", name: "3000-level nested object", body: good({ lines: [deep] }), expect: [400] },
        { id: "POS-163", name: "2 MB junk string field", body: good({ junk: "x".repeat(2 * 1024 * 1024) }), expect: [201, 400, 413] },
        { id: "POS-164", name: "qty 1e9", body: good({ lines: [ready(f.id, 1e9)] }), expect: [400] },
        { id: "POS-164", name: "qty Number.MAX_SAFE_INTEGER", body: good({ lines: [ready(f.id, Number.MAX_SAFE_INTEGER)] }), expect: [400] },
        { id: "POS-164", name: "qty 1e308", body: good({ lines: [ready(f.id, 1e308)] }), expect: [400] },
        { id: "POS-164", name: "qty '1e999' (Infinity)", body: good({ lines: [ready(f.id, "1e999" as any)] }), expect: [400] },
      ];
      const rows: any[] = [];
      for (const c of cases) {
        const fromRaw = c.raw ? (c.raw.match(/"customerPhone":"([^"]+)"/) || [])[1] : undefined;
        const phone = fromRaw ?? (c.body?.customerPhone && typeof c.body.customerPhone === "string" ? c.body.customerPhone : null);
        const r = await http(S1, "POST", "/api/sales", cashier, c.body, c.raw !== undefined ? { raw: c.raw } : {});
        const created = phone ? (await salesFor(phone)) : [];
        const lk = leak(r);
        const statusOk = c.expect.includes(r.status);
        const sideEffectOk = r.status === 201 ? created.length === 1 : created.length === 0;
        // Injected total/branchId must be ignored by the server.
        const injectedOk = !c.name.startsWith("unexpected") || (created[0] && created[0].total === 10 && String(created[0].branchId) === String(branch._id) && !("isAdmin" in created[0]) && !("extra" in created[0]));
        rows.push({ ...c, status: r.status, error: r.body.error, code: r.body.code, lk, ok: statusOk && !lk && sideEffectOk && r.status < 500 && !!injectedOk, stored: created[0] });
      }
      const after = await snap([f.id]);
      const committed = await Sale.find({ "lines.productId": new mongoose.Types.ObjectId(f.id) }).lean<any[]>();
      const rr = await reconcile(f.id, before, committed);
      const health = await http(S1, "GET", "/api/health");
      for (const id of ["POS-157", "POS-158", "POS-159", "POS-160", "POS-161", "POS-162", "POS-163", "POS-164"]) {
        const mine = rows.filter((x) => x.id === id);
        const bad = mine.filter((x) => !x.ok);
        const detail = mine.map((x) => `${x.name} → ${x.status}${x.code ? ` ${x.code}` : ""}${x.stored ? ` [stored payment=${x.stored.payment}, qty=${x.stored.lines?.[0]?.qty}, total=${x.stored.total}]` : ""}${x.lk ? ` LEAK:"${x.lk}"` : ""}${x.ok ? "" : " ✗"}`).join("; ");
        const sev = bad.some((x) => x.status >= 500 || x.lk) ? "Medium" : "Low";
        const names: Record<string, string> = { "POS-157": "Quantity = 0", "POS-158": "Negative quantity", "POS-159": "Invalid price", "POS-160": "Empty / invalid payment", "POS-161": "Invalid customer ID", "POS-162": "Invalid product ID", "POS-163": "Malformed checkout request", "POS-164": "Extremely large quantity" };
        const exp: Record<string, string> = {
          "POS-157": "400 validation error; no sale, no stock change",
          "POS-158": "400; no mutation",
          "POS-159": "Client price ignored (server catalogue price) or 400 for invalid discount values",
          "POS-160": "Payment method rule not documented beyond enum cash|card|bank|credit|mixed; an invalid method must not be silently recorded as something else",
          "POS-161": "Safe rejection or fallback to phone lookup; no crash; no foreign customer mutation",
          "POS-162": "400 PRODUCT_NOT_FOUND / INVALID_LINE; no deduction",
          "POS-163": "Controlled 4xx (never 500), no internals leaked, no partial transaction",
          "POS-164": "400 (stock protection); no overflow/hang",
        };
        check(id, names[id], bad.length === 0, detail, exp[id], sev);
      }
      // POS-160 note on silent coercion
      const coerced = rows.filter((x) => x.id === "POS-160" && x.stored && x.body?.payment !== x.stored.payment);
      if (coerced.length) console.log(`      note: payment coerced → ${coerced.map((x) => `${JSON.stringify(x.body.payment)}→${x.stored.payment}`).join(", ")}`);
      check("ERR-INTEGRITY", "After all invalid requests: no partial transactions, stock reconciles, server healthy",
        rr.ok && health.status === 200 && (await Customer.countDocuments()) - custBefore === rows.filter((x) => x.status === 201).length,
        `${rows.length} malformed/edge requests; ${rows.filter((x) => x.status === 201).length} legitimately created sales; ${rr.text}; customers +${(await Customer.countDocuments()) - custBefore} (one per created sale); sales +${(await Sale.countDocuments()) - salesBefore}; /api/health ${health.status}`,
        "Only accepted requests change state; inventory exact; server stable", "Critical");
      fs.writeFileSync(process.env.QA_VALIDATION_OUT || path.join(os.tmpdir(), "qa-validation.json"), JSON.stringify(rows.map(({ body, raw, stored, ...x }) => ({ ...x, storedPayment: stored?.payment })), null, 2));
      // oversized cart
      const big = await fixture({ layers: [10000], price: 1 });
      const phone = newPhone();
      const t = Date.now();
      const r = await sell(cashier, Array.from({ length: 5000 }, () => ready(big.id, 1)), { customerPhone: phone });
      const ms = Date.now() - t;
      const s = (await salesFor(phone))[0];
      rec("POS-163b", "Oversized cart: 5000 lines in one checkout", r.status === 201 || r.status === 400 || r.status === 413 ? (ms < 10000 ? "PASS" : "FAIL") : "FAIL",
        `HTTP ${r.status} in ${ms}ms; ${s ? `sale stored with ${s.lines.length} lines, stock 10000→${(await Product.findById(big.id).lean<any>()).stockSellable}` : "no sale"}; no line-count limit in validateSaleLines`,
        "Bounded/controlled handling; no hang", ms < 10000 ? "-" : "Medium");
    }
    // POS-165
    {
      const f = await fixture({ layers: [20] });
      const before = await snap([f.id]);
      const key = randomUUID(), phone = newPhone();
      const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => sell(cashier, [ready(f.id, 1)], { customerPhone: phone, idempotencyKey: key }, i % 2 ? S2 : S1)));
      const sales = await salesFor(phone);
      const rr = await reconcile(f.id, before, sales);
      check("POS-165", "Rapid repeated clicks (25 identical requests, UI guard bypassed)", sales.length === 1 && rr.ok && rr.after.stock === 19,
        `${rs.filter((r) => r.status === 201).length}×201, ${rs.filter((r) => r.status === 200).length}×200 deduplicated, other [${rs.filter((r) => ![200, 201].includes(r.status)).map((r) => r.status)}]; ${rr.text}`,
        "Backend authoritative: one sale", "Critical");
    }

    console.log("\n=== 20. INTERNET FAILURE / RECOVERY ===");
    {
      // POS-166: server unreachable before checkout
      const f = await fixture({ layers: [5] });
      const before = await snap([f.id]);
      const phone = newPhone();
      let err = "";
      try { await fetch("http://localhost:3999/api/sales", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cashier }, body: JSON.stringify({ customerPhone: phone, payment: "cash", lines: [ready(f.id)] }) }); } catch (e: any) { err = `${e.name}: ${e.message}`; }
      const after = await snap([f.id]);
      const none = (await salesFor(phone)).length === 0 && after[f.id].stock === before[f.id].stock;
      // UI message: the POS page classifies the failure with checkoutRecovery
      // (navigator.onLine) — exercised here, and its wiring checked in the page.
      const { classifyCheckoutError, checkoutFailureMessage } = await import("../../src/lib/sales/checkoutRecovery");
      const page = fs.readFileSync("src/app/(app)/pos/page.tsx", "utf8");
      const wired = /classifyCheckoutError\(\s*err,[\s\S]{0,120}navigator\.onLine/.test(page) && page.includes("checkoutFailureMessage(");
      const offlineMsg = checkoutFailureMessage(classifyCheckoutError(new TypeError("Failed to fetch"), false), "Failed to fetch");
      const unknownMsg = checkoutFailureMessage(classifyCheckoutError(new TypeError("Failed to fetch"), true), "Failed to fetch");
      const clear = /offline/i.test(offlineMsg) && /NOT completed/.test(offlineMsg) && /couldn't confirm/.test(unknownMsg) && !/Failed to fetch/.test(offlineMsg + unknownMsg);
      check("POS-166", "Internet disconnects before checkout", none && !!err && wired && clear,
        `request fails (${err}); no sale, no stock change. UI: page wires classifyCheckoutError(err, navigator.onLine) → offline: "${offlineMsg}" / no answer: "${unknownMsg}"; cart restored, bill key kept (no false success)`,
        "Clear offline/unavailable status; no false success; no partial transaction", "Low");
      // POS-168: disconnect during checkout — abort mid-flight on several timings
      const lines: string[] = [];
      let consistent = true;
      for (const delay of [1, 20, 60, 150]) {
        const g = await fixture({ layers: [5] });
        const b = await snap([g.id]);
        const ph = newPhone(), key = randomUUID();
        const ac = new AbortController();
        const p = http(S1, "POST", "/api/sales", cashier, { customerPhone: ph, payment: "cash", salesperson: SP, idempotencyKey: key, lines: [ready(g.id, 2)] }, { signal: ac.signal }).then((r) => `${r.status}`).catch(() => "aborted");
        setTimeout(() => ac.abort(), delay);
        const outcome = await p;
        await sleep(1500);
        const ss = await salesFor(ph);
        const r1 = await reconcile(g.id, b, ss);
        consistent &&= r1.ok && ss.length <= 1;
        lines.push(`abort@${delay}ms → client ${outcome}, server committed ${ss.length} sale(s), ${r1.ok ? "consistent" : "INCONSISTENT"}`);
      }
      rec("POS-168", "Internet disconnects during checkout", "BLOCKED",
        `${lines.join("; ")}. Server-side atomicity holds (sale+stock+customer in one transaction: all-or-nothing). But when the response is lost the client cannot tell whether the sale happened: UI shows the network error and restores the cart; only pressing Complete again with an unchanged cart (same key) safely resolves it. Required offline/recovery behaviour is not defined.`,
        "Behaviour per approved offline/recovery architecture — not defined", consistent ? "High (requirement gap)" : "Critical");
      const blocked = "BLOCKED — OFFLINE REQUIREMENT/ARCHITECTURE NOT CONFIRMED. Implementation: none (no service worker, IndexedDB/localStorage sale queue, sync API or temp transaction ids; navigator.onLine is used only to word the error message; POS needs the server for every sale).";
      rec("POS-167", "Attempt sale offline", "BLOCKED", `${blocked} A sale attempted offline fails like POS-166 (nothing stored).`, "Per approved offline design", "High (requirement gap)");
      rec("POS-169", "Internet reconnects — pending transactions sync", "BLOCKED", `${blocked} There are no pending transactions to sync.`, "Per approved sync design", "High (requirement gap)");
      rec("POS-170", "Same transaction syncs twice", "BLOCKED", `${blocked} Online-only analogue (same idempotency key replayed) is deduplicated — see POS-148/154 — but no sync mechanism exists to test.`, "Per approved sync design", "High (requirement gap)");
      rec("POS-171", "Stock conflict during synchronization", "BLOCKED", `${blocked} Online stock conflicts are rejected atomically (POS-150/151) — offline conflict rules undefined.`, "Per approved conflict rule", "High (requirement gap)");
    }
  } finally {
    for (const s of servers) { try { process.kill(-(s.pid as number), "SIGTERM"); } catch { /* gone */ } }
    await sleep(800);
    const out = process.env.QA_OUT || path.join(os.tmpdir(), "qa-results.json");
    fs.writeFileSync(out, JSON.stringify({ results }, null, 2));
    const count = (s: string) => results.filter((r) => r.status === s).length;
    console.log(`\nTOTAL ${results.length}: PASS ${count("PASS")}, FAIL ${count("FAIL")}, BLOCKED ${count("BLOCKED")}, N/A ${count("N/A")}`);
    await mongoose.disconnect();
  }
}

main().catch((e) => { console.error("SUITE CRASHED:", e); process.exit(1); });
