/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression: a temporary database outage must not log anyone out.
 * Starts a throwaway local mongod, signs in against it, STOPS it, checks the
 * session survives (503 + cookie kept, /api/auth/me degraded, pages still
 * served), restarts it and checks the same cookie works again. Control: a
 * revoked session is still logged out once the database answers.
 *
 *   MONGOD_BIN=/path/to/mongod npx tsx tests/qa/db-outage-session.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MongoClient, ObjectId } from "mongodb";
import { createSessionToken } from "../../src/lib/auth/session";

const MONGOD = process.env.MONGOD_BIN || "";
const DB_PORT = Number(process.env.QA_OUTAGE_DB_PORT || 27097);
const APP_PORT = Number(process.env.QA_PORT || 3986);
const URL = `mongodb://127.0.0.1:${DB_PORT}/unich_outage?directConnection=true`;
const BASE = `http://localhost:${APP_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const rec = (n: string, ok: boolean, d: string) => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗"} ${n} — ${d}`); };

if (!MONGOD || !fs.existsSync(MONGOD)) {
  console.log("BLOCKED: set MONGOD_BIN to a local mongod binary (this suite starts and stops its own throwaway database).");
  process.exit(3);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unich-outage-"));
const startDb = () => {
  const r = spawnSync(MONGOD, ["--port", String(DB_PORT), "--dbpath", dir, "--bind_ip", "127.0.0.1", "--fork", "--logpath", path.join(dir, "mongod.log"), "--pidfilepath", path.join(dir, "mongod.pid")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`mongod failed to start: ${r.stdout}${r.stderr}`);
};
const stopDb = async () => {
  const pid = Number(fs.readFileSync(path.join(dir, "mongod.pid"), "utf8").trim());
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); await sleep(200); } catch { return; } }
};
type Res = { status: number; body: any; setCookie: string; location: string | null };
async function get(p: string, cookie: string, method = "GET", body?: unknown): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, { method, redirect: "manual", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, body: parsed, setCookie: r.headers.get("set-cookie") || "", location: r.headers.get("location") };
}
const clearsSession = (r: Res) => /unich_session=;|unich_session=[^;]*;[^,]*(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(r.setCookie);

(async () => {
  let app: ChildProcess | null = null;
  try {
    startDb();
    const client = new MongoClient(URL);
    await client.connect();
    const db = client.db();
    const mkSession = async (role: string) => {
      const userId = new ObjectId();
      await db.collection("users").insertOne({ _id: userId, name: `Outage ${role}`, email: `outage-${role}-${userId}@test.local`, passwordHash: "x", role, roleLabel: role, branchId: null, active: true, createdAt: new Date() });
      const sid = randomBytes(18).toString("base64url");
      const exp = Date.now() + 3600_000;
      await db.collection("authsessions").insertOne({ sid, userId: String(userId), expiresAt: new Date(exp), revokedAt: null, createdAt: new Date() });
      return { sid, cookie: `unich_session=${createSessionToken({ userId: String(userId), name: `Outage ${role}`, email: `outage-${role}@test.local`, role: role as any, roleLabel: role, branchId: null, branchName: null, sid, exp })}` };
    };
    const owner = await mkSession("owner");
    const revoked = await mkSession("cashier");
    await client.close();

    const logPath = path.join(dir, "app.log");
    const logFd = fs.openSync(logPath, "w");
    app = spawn("npx", ["next", "start", "-p", String(APP_PORT)], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: URL }, stdio: ["ignore", logFd, logFd], detached: true });
    for (let i = 0; i < 240; i++) { try { await fetch(`${BASE}/api/health`); break; } catch { await sleep(500); } }

    const ok0 = await get("/api/sales?limit=1", owner.cookie);
    rec("database up: signed-in request works", ok0.status === 200, `HTTP ${ok0.status}`);

    await stopDb();
    await sleep(5_500); // past the 5 s live-session cache
    const t = Date.now();
    const api = await get("/api/sales?limit=1", owner.cookie);
    const ms = Date.now() - t;
    rec("database DOWN: API answers 503 (retryable), not 401 — within 4 s", api.status === 503 && api.body.code === "SERVICE_UNAVAILABLE" && ms < 4_000, `HTTP ${api.status} in ${ms} ms: ${JSON.stringify(api.body)}`);
    rec("database DOWN: session cookie is NOT cleared", !clearsSession(api), api.setCookie ? `set-cookie: ${api.setCookie.slice(0, 60)}` : "no set-cookie");
    const post = await get("/api/sales", owner.cookie, "POST", { customerPhone: "+968 1", lines: [{ productId: String(new ObjectId()), qty: 1, lineType: "ready" }] });
    rec("database DOWN: checkout answers 503, cookie kept", post.status === 503 && !clearsSession(post), `HTTP ${post.status}`);
    const me = await get("/api/auth/me", owner.cookie);
    rec("database DOWN: /api/auth/me still authenticated (degraded)", me.status === 200 && me.body.authenticated === true && me.body.degraded === true && !clearsSession(me), `HTTP ${me.status} ${JSON.stringify({ authenticated: me.body.authenticated, degraded: me.body.degraded })}`);
    const page = await get("/pos", owner.cookie);
    rec("database DOWN: POS page → 503 'temporarily unavailable' (auto-retry), not /login, cookie kept", page.status === 503 && !page.location && !clearsSession(page), `HTTP ${page.status}${page.location ? ` → ${page.location}` : ""}`);
    const revokedPage = await get("/pos", revoked.cookie);
    rec("database DOWN: no page is served on an unverified session (any signed cookie → 503, no app HTML)", revokedPage.status === 503, `HTTP ${revokedPage.status}`);
    const none = await get("/api/sales?limit=1", "");
    rec("database DOWN: no cookie is still 401", none.status === 401, `HTTP ${none.status}`);

    startDb();
    let back: Res | null = null;
    for (let i = 0; i < 40; i++) { back = await get("/api/sales?limit=1", owner.cookie); if (back.status === 200) break; await sleep(1000); }
    rec("database BACK: the same cookie works again (no re-login)", back?.status === 200, `HTTP ${back?.status}`);

    // Control: a session revoked during the outage is logged out once the DB answers.
    const c2 = new MongoClient(URL);
    await c2.connect();
    await c2.db().collection("authsessions").updateOne({ sid: revoked.sid }, { $set: { revokedAt: new Date() } });
    await c2.close();
    await sleep(5_500);
    const rv = await get("/api/sales?limit=1", revoked.cookie);
    rec("control: revoked session → 401 and cookie cleared", rv.status === 401 && clearsSession(rv), `HTTP ${rv.status}`);

    await sleep(300);
    const log = fs.readFileSync(logPath, "utf8");
    rec("server log records the failed session check (no credentials)", /\[session\] live-session check failed/.test(log) && !/mongodb:\/\/[^<]/.test(log), `${(log.match(/\[session\]/g) || []).length} entries`);
  } finally {
    if (app) { try { process.kill(-(app.pid as number), "SIGTERM"); } catch { /* */ } }
    await sleep(800);
    try { await stopDb(); } catch { /* already down */ }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  }
})();
