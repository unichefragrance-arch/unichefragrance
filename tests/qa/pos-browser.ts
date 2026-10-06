/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Browser E2E for checkout recovery (POS-153/154/166) — the real POS page in
 * headless Chrome, driven over the DevTools protocol (no extra dependencies):
 *  - response lost AFTER the server committed (response paused + connection
 *    reset), cart edited, Complete again → 409 message, still one sale;
 *  - response lost, unchanged bill, Complete again → the original sale;
 *  - browser offline → clear "offline" message, nothing written;
 *  - rapid double Complete → one sale.
 * LOCAL DB only.
 *
 *   CHROME_BIN=/usr/bin/google-chrome DATABASE_URL='mongodb://127.0.0.1:27099/...' npx tsx tests/qa/pos-browser.ts
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
import { AppSettings, Branch, FifoLayer, Product, Sale } from "../../src/lib/models";
import { testSessionCookie } from "../../src/lib/auth/testSession";

const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const PORT = Number(process.env.QA_PORT || 3975);
const DEBUG_PORT = Number(process.env.QA_CDP_PORT || 9339);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const rec = (n: string, ok: boolean, d: string) => { ok ? pass++ : fail++; console.log(`${ok ? "  ✓" : "  ✗"} ${n} — ${d}`); };

if (!fs.existsSync(CHROME)) {
  console.log(`BLOCKED: Chrome not found at ${CHROME} (set CHROME_BIN).`);
  process.exit(3);
}

/** Minimal Chrome DevTools Protocol client over the built-in WebSocket. */
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((p: any) => void)[]>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${msg.error.message}`)) : p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    };
  }
  static async connect(url: string) {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("CDP connect failed")); });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method: string, fn: (p: any) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn]);
  }
  close() { this.ws.close(); }
}

async function main() {
  await connectDB();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "unich-chrome-"));
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    for (let i = 0; i < 240; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* */ } await sleep(500); }
    const branch = (await Branch.findOne({ code: "MAIN" }).lean<any>())!;
    const SP = (await AppSettings.findOne({ key: "default" }).lean<any>()).activeSalesperson as string;
    const tag = Date.now() % 100000;
    const sku = `QAUI-${tag}`;
    const prod = await Product.create({ sku, name: `QA UI Product ${tag}`, category: "Perfume", unit: "pcs", sellPrice: 10, costFifo: 1, minMarginPct: 0, stockSellable: 100 });
    await FifoLayer.create({ productId: prod._id, supplierId: new mongoose.Types.ObjectId(), supplierName: "QA", purchaseDate: new Date(Date.now() - 864e5), qtyRemaining: 100, originalQty: 100, unitCost: 1, currency: "OMR", source: "purchase" });
    const cookie = await testSessionCookie({ userId: String(new mongoose.Types.ObjectId()), name: "QA UI Cashier", email: `qa-ui-${tag}@test.local`, role: "cashier", roleLabel: "Cashier", branchId: String(branch._id), branchName: branch.name });
    const stock = async () => (await Product.findById(prod._id).lean<any>()).stockSellable as number;
    const salesFor = (ph: string) => Sale.find({ customerPhone: ph }).lean<any[]>();

    chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1440,1000", "about:blank"], { stdio: "ignore", detached: true });
    let wsUrl = "";
    for (let i = 0; i < 100 && !wsUrl; i++) {
      try { wsUrl = ((await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as any[]).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? ""; } catch { /* starting */ }
      if (!wsUrl) await sleep(200);
    }
    cdp = await Cdp.connect(wsUrl);
    const c = cdp;
    await c.send("Page.enable");
    await c.send("Network.enable");
    await c.send("Runtime.enable");
    await c.send("Network.setCookie", { name: "unich_session", value: cookie.split("=").slice(1).join("="), url: BASE, httpOnly: true });

    const evaluate = async (expr: string) => (await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
    const waitFor = async (expr: string, ms = 20_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await evaluate(expr)) return true; await sleep(150); }
      return false;
    };
    const bodyText = () => evaluate("document.body.innerText") as Promise<string>;
    const typeInto = async (placeholderPrefix: string, text: string) => {
      await evaluate(`(() => { const el = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').startsWith(${JSON.stringify(placeholderPrefix)})); el.focus(); el.select && el.select(); return !!el; })()`);
      await c.send("Input.insertText", { text });
    };
    const pressEnter = async () => {
      for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    };
    const addProduct = async () => { await typeInto("Search name, SKU", sku); await pressEnter(); await sleep(250); };
    const clickComplete = (times = 1) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('Complete Sale')); for (let i = 0; i < ${times}; i++) b.click(); return !!b; })()`);
    const cartQty = () => evaluate(`document.body.innerText.includes(${JSON.stringify(prod.name)})`);
    const freshBill = async (phone: string) => {
      await c.send("Page.navigate", { url: `${BASE}/pos` });
      await waitFor(`!!document.querySelector('input[placeholder^="Search name, SKU"]')`);
      await waitFor(`!!window.localStorage`);
      await evaluate(`window.localStorage.setItem('unich.pos.salesperson', ${JSON.stringify(SP)})`);
      await c.send("Page.reload");
      await waitFor(`!!document.querySelector('input[placeholder^="Search name, SKU"]')`);
      await sleep(1200); // catalogue load
      await addProduct();
      await typeInto("+971", phone);
    };

    // "Lose" the response of the next POST /api/sales: let the server answer, then reset the connection.
    let dropNext = false;
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/sales*", requestStage: "Response" }] });
    c.on("Fetch.requestPaused", async (p) => {
      const isCheckout = p.request.method === "POST" && /\/api\/sales$/.test(new URL(p.request.url).pathname);
      if (isCheckout && dropNext) {
        dropNext = false;
        await c.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionReset" });
      } else {
        await c.send("Fetch.continueResponse", { requestId: p.requestId }).catch(() => c.send("Fetch.continueRequest", { requestId: p.requestId }));
      }
    });

    console.log("Browser: lost response, then the cashier edits the cart");
    {
      const phone = `+968 3${String(tag).padStart(5, "0")}01`;
      await freshBill(phone);
      const s0 = await stock();
      dropNext = true;
      await clickComplete();
      const unknownShown = await waitFor(`document.body.innerText.includes("couldn't confirm this sale")`);
      const committed = (await salesFor(phone)).length;
      rec("server committed, browser lost the reply → 'couldn't confirm' message, cart kept", unknownShown && committed === 1 && (await cartQty()), `message ${unknownShown}; sales in DB ${committed}; cart kept ${await cartQty()}`);
      await addProduct(); // cashier edits: qty 1 → 2
      await clickComplete();
      const conflictShown = await waitFor(`document.body.innerText.includes("already completed earlier")`);
      const after = await salesFor(phone);
      rec("edited cart + Complete → 'already completed earlier, NOT charged'; still ONE sale", conflictShown && after.length === 1 && s0 - (await stock()) === 1, `message ${conflictShown}; sales ${after.length}; stock −${s0 - (await stock())}`);
      await clickComplete();
      const okShown = await waitFor(`document.body.innerText.includes("Sale completed")`);
      const final = await salesFor(phone);
      rec("pressing Complete again after that notice is a deliberate new sale", okShown && final.length === 2 && s0 - (await stock()) === 3, `sales ${final.length}; stock −${s0 - (await stock())}`);
    }

    console.log("Browser: lost response, unchanged bill");
    {
      const phone = `+968 3${String(tag).padStart(5, "0")}02`;
      await freshBill(phone);
      const s0 = await stock();
      dropNext = true;
      await clickComplete();
      await waitFor(`document.body.innerText.includes("couldn't confirm this sale")`);
      await clickComplete();
      const okShown = await waitFor(`document.body.innerText.includes("Sale completed")`);
      const sales = await salesFor(phone);
      rec("Complete again → shows the original sale; one sale, stock −1", okShown && sales.length === 1 && s0 - (await stock()) === 1, `sales ${sales.length}; stock −${s0 - (await stock())}`);
    }

    console.log("Browser: offline");
    {
      const phone = `+968 3${String(tag).padStart(5, "0")}03`;
      await freshBill(phone);
      const s0 = await stock();
      await c.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await waitFor(`navigator.onLine === false`, 5000);
      await clickComplete();
      const offlineShown = await waitFor(`document.body.innerText.includes("You're offline") && document.body.innerText.includes("NOT completed")`);
      const text = await bodyText();
      rec("offline → 'You're offline — this sale was NOT completed'; nothing written; no raw 'Failed to fetch'", offlineShown && (await salesFor(phone)).length === 0 && (await stock()) === s0 && !/Failed to fetch/.test(text), `message ${offlineShown}; sales ${(await salesFor(phone)).length}`);
      await c.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await clickComplete();
      const okShown = await waitFor(`document.body.innerText.includes("Sale completed")`);
      rec("back online → Complete creates exactly one sale", okShown && (await salesFor(phone)).length === 1 && s0 - (await stock()) === 1, `sales ${(await salesFor(phone)).length}`);
    }

    console.log("Browser: rapid double Complete");
    {
      const phone = `+968 3${String(tag).padStart(5, "0")}04`;
      await freshBill(phone);
      const s0 = await stock();
      await clickComplete(5);
      await waitFor(`document.body.innerText.includes("Sale completed")`);
      await sleep(1500);
      rec("5 clicks in one tick → one sale", (await salesFor(phone)).length === 1 && s0 - (await stock()) === 1, `sales ${(await salesFor(phone)).length}; stock −${s0 - (await stock())}`);
    }
  } finally {
    try { cdp?.close(); } catch { /* */ }
    if (chrome) { try { process.kill(-(chrome.pid as number), "SIGTERM"); } catch { /* */ } }
    try { process.kill(-(server.pid as number), "SIGTERM"); } catch { /* */ }
    await sleep(1000);
    fs.rmSync(profile, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail > 0 ? 1 : 0);
  }
}
main().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
