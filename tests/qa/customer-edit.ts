/* eslint-disable @typescript-eslint/no-explicit-any */
// QA suite: customer-edit — run via `npm run test:qa` (local throwaway DB only).
import { assertLocalDb } from "../../src/lib/e2eGuard";
import { spawn } from "node:child_process";
import { connectDB } from "../../src/lib/db";
import { Branch, Customer, User } from "../../src/lib/models";
import { createSessionToken } from "../../src/lib/auth/session";
assertLocalDb();
const BASE = "http://localhost:3957";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const rec = (n: string, ok: boolean, d: string) => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗"} ${n} — ${d}`); };
const req = async (m: string, p: string, c?: string, b?: unknown) => { const r = await fetch(BASE + p, { method: m, headers: { "Content-Type": "application/json", ...(c ? { Cookie: c } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; };
(async () => {
  await connectDB();
  const br = (await Branch.findOne().lean<any>())!; const u = (await User.findOne({ role: "cashier" }).lean<any>())!;
  const ck = `unich_session=${createSessionToken({ userId: String(u._id), name: u.name, email: u.email, role: "cashier", roleLabel: "c", branchId: String(br._id), branchName: br.name })}`;
  const srv = spawn("npx", ["next", "start", "-p", "3957"], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch { /* */ } await sleep(500); }
    const phone = `97${String(Date.now()).slice(-6)}`;
    const c = await req("POST", "/api/customers", ck, { name: "  New Cust ", phone, email: "n@x.com", notes: "vip", preferences: ["oud", ""], creditBalance: 777, totalPurchases: 5000, forceCreate: true });
    const cd = await Customer.findById(c.body.id).lean<any>();
    rec("create: profile saved, balance/purchases ignored", c.status === 201 && cd.name === "New Cust" && cd.email === "n@x.com" && cd.preferences.join() === "oud" && cd.creditBalance === 0 && cd.totalPurchases === 0, `HTTP ${c.status}, name "${cd?.name}", credit ${cd?.creditBalance}, purchases ${cd?.totalPurchases}`);
    await Customer.updateOne({ _id: cd._id }, { $set: { creditBalance: 50, totalPurchases: 300 } }); // as if sales happened
    // What the customer page sends: the whole object with edits
    const full = (await req("GET", `/api/customers/${cd._id}`, ck)).body;
    const e = await req("PUT", `/api/customers/${cd._id}`, ck, { ...full, name: "Edited Name", address: "Muscat", productsRequested: ["Blue Ocean"], creditBalance: 0, totalPurchases: 999999, lastVisit: "2020-01-01" });
    const ed = await Customer.findById(cd._id).lean<any>();
    rec("edit form (full object): profile changes saved, balance/purchases/lastVisit untouched", e.status === 200 && ed.name === "Edited Name" && ed.address === "Muscat" && ed.productsRequested.join() === "Blue Ocean" && ed.creditBalance === 50 && ed.totalPurchases === 300 && new Date(ed.lastVisit).getFullYear() !== 2020,
      `HTTP ${e.status}, name ${ed.name}, credit ${ed.creditBalance}, purchases ${ed.totalPurchases}`);
    const neg = await req("PUT", `/api/customers/${cd._id}`, ck, { creditBalance: -5000 });
    rec("negative balance attempt has no effect", (await Customer.findById(cd._id).lean<any>()).creditBalance === 50, `HTTP ${neg.status}`);
    const blank = await req("PUT", `/api/customers/${cd._id}`, ck, { name: "" });
    rec("required name still validated", blank.status === 400, `HTTP ${blank.status}`);
    const inv = await req("PUT", "/api/customers/not-an-id", ck, { name: "x" });
    rec("invalid id → 400", inv.status === 400, `HTTP ${inv.status}`);
  } finally { try { process.kill(-(srv.pid as number), "SIGTERM"); } catch { /* */ } await sleep(1000); }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(0);
})();
