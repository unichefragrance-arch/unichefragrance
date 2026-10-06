/* eslint-disable @typescript-eslint/no-explicit-any */
// QA suite: product Excel import → MongoDB → API → UI.
// Excel is only an input: staging writes an ImportBatch (no products), Commit
// writes the products collection, and every screen reads products back from
// MongoDB through GET /api/products. Verified over HTTP, in the DB and in
// headless Chrome (Inventory page + POS search, before/after reload).
// LOCAL DB only. Run via `npm run test:qa` (after `npm run build`).
import { assertLocalDb } from "../../src/lib/e2eGuard";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { connectDB } from "../../src/lib/db";
import { Branch, ImportBatch, Product } from "../../src/lib/models";
import { testSessionCookie } from "../../src/lib/auth/testSession";

assertLocalDb();
const PORT = 3967;
const DEBUG_PORT = Number(process.env.QA_CDP_PORT || 9341);
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
let passed = 0, failed = 0;
const fails: string[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  if (ok) passed++; else { failed++; fails.push(`${id} ${name} — ${detail}`); }
  console.log(`  ${ok ? "✓" : "✗"} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function req(method: string, p: string, cookie: string, body?: unknown): Promise<{ status: number; body: any }> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), Cookie: cookie },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Minimal Chrome DevTools Protocol client (same approach as pos-browser.ts). */
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
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
  close() { this.ws.close(); }
}

async function main() {
  await connectDB();
  const branch = (await Branch.findOne({ active: true }).lean<any>())!;
  const owner = await testSessionCookie({ userId: String(new mongoose.Types.ObjectId()), name: "QA Import Owner", email: `qa-import-owner-${Date.now()}@test.local`, role: "owner", roleLabel: "Owner", branchId: null, branchName: null });
  const cashier = await testSessionCookie({ userId: String(new mongoose.Types.ObjectId()), name: "QA Import Cashier", email: `qa-import-cashier-${Date.now()}@test.local`, role: "cashier", roleLabel: "Cashier", branchId: String(branch._id), branchName: branch.name });
  const tag = Date.now() % 1_000_000;
  const names = { rose: `QA Rose Perfume ${tag}`, oud: `QA Oud Oil ${tag}`, musk: `QA Musk Spray ${tag}` };

  const server = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: process.cwd(), env: process.env, stdio: "ignore", detached: true });
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "unich-import-chrome-"));
  try {
    for (let i = 0; i < 240; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ } await sleep(500); }

    // Build workbooks from the official template (its headers), as the owner would.
    const tplRes = await fetch(`${BASE}/api/products/import/template`, { headers: { Cookie: owner } });
    const tplBuf = Buffer.from(await tplRes.arrayBuffer());
    const headerOf = async () => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(tplBuf as any);
      return (wb.worksheets[0].getRow(1).values as any[]).slice(1).map((h) => String(h ?? "").trim());
    };
    const headers = await headerOf();
    type Row = { code?: string; name: string; category: string; unit: string; cost: number | ""; retail: number | ""; wholesale?: number; itemType?: string };
    const cell = (h: string, r: Row): unknown => {
      const k = h.toLowerCase();
      if (k.includes("code")) return r.code ?? "";
      if (k.includes("name")) return r.name;
      if (k.includes("category")) return r.category;
      if (k === "unit") return r.unit;
      if (k.includes("cost")) return r.cost;
      if (k.includes("retail")) return r.retail;
      if (k.includes("wholesale")) return r.wholesale ?? "";
      if (k.includes("item type")) return r.itemType ?? "finished";
      return "";
    };
    const xlsx = async (rows: Row[]) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(tplBuf as any);
      const ws = wb.worksheets[0];
      for (let r = ws.rowCount; r >= 2; r--) ws.spliceRows(r, 1);
      for (const row of rows) ws.addRow(headers.map((h) => cell(h, row)));
      const fd = new FormData();
      fd.append("file", new Blob([Buffer.from(await wb.xlsx.writeBuffer())]), "products.xlsx");
      return fd;
    };
    const stage = async (rows: Row[]) => req("POST", "/api/products/import/stage", owner, await xlsx(rows));
    const apiList = async (cookie = owner) => (await req("GET", "/api/products", cookie)).body as any[];
    const inApi = async (name: string) => (await apiList()).find((p) => p.name === name);

    console.log("\n== stage ==");
    const good: Row[] = [
      { name: names.rose, category: "Brands", unit: "pcs", cost: 2000, retail: 5000, wholesale: 4000 },
      { name: names.oud, category: "Single Notes", unit: "ml", cost: 1, retail: 3, wholesale: 2 },
      { name: names.musk, category: "Brands", unit: "pcs", cost: 4, retail: 9 },
    ];
    const bad: Row[] = [
      { name: `QA Bad Category ${tag}`, category: "NotARealCategory", unit: "pcs", cost: 1, retail: 2 },
      { name: `QA Missing Price ${tag}`, category: "Brands", unit: "pcs", cost: 1, retail: "" },
    ];
    const st = await stage([...good, ...bad]);
    const batchId = st.body.batchId as string;
    check("IMP-1", "valid rows staged (3 new)", st.status === 200 && st.body.created === 3, `HTTP ${st.status}; created=${st.body.created}`);
    const errs = (st.body.rows ?? []).filter((r: any) => r.action === "error");
    check("IMP-2", "invalid rows reported with reasons (bad category, missing price)", st.body.failed === 2 && errs.length === 2 && errs.every((e: any) => String(e.errorReason || "").length > 0),
      errs.map((e: any) => `row ${e.rowNumber}: ${String(e.errorReason).slice(0, 60)}`).join(" | "));
    const stagedInDb = await Product.countDocuments({ name: { $in: Object.values(names) } });
    const stagedInApi = (await apiList()).filter((p) => Object.values(names).includes(p.name)).length;
    const batchDoc = await ImportBatch.findOne({ batchId }).lean<any>();
    check("IMP-3", "staging writes only an ImportBatch — no products in DB or API", stagedInDb === 0 && stagedInApi === 0 && batchDoc?.status === "staged",
      `products in DB ${stagedInDb}, in API ${stagedInApi}, batch ${batchDoc?.status}`);

    const blocked = await req("POST", "/api/products/import/commit", owner, { batchId });
    check("IMP-3b", "Safe Mode refuses to commit a batch that has error rows (nothing written)", blocked.status === 400 && (await Product.countDocuments({ name: { $in: Object.values(names) } })) === 0, `HTTP ${blocked.status}`);

    console.log("\n== commit → MongoDB ==");
    const st2 = await stage(good);
    const batch2 = st2.body.batchId as string;
    const cm = await req("POST", "/api/products/import/commit", owner, { batchId: batch2 });
    const docs = await Product.find({ name: { $in: Object.values(names) } }).lean<any[]>();
    const rose = docs.find((d) => d.name === names.rose);
    const oud = docs.find((d) => d.name === names.oud);
    check("IMP-4", "commit writes all 3 to the products collection", cm.status === 200 && cm.body.created === 3 && docs.length === 3, `HTTP ${cm.status}; created ${cm.body.created}; in DB ${docs.length}`);
    check("IMP-4b", "stored like a normal product: category/unit/prices, generated SKU, stock 0",
      !!rose && rose.category === "Brands" && rose.unit === "pcs" && rose.sellPrice === 5000 && rose.costFifo === 2000 && rose.wholesalePrice === 4000 && /\S/.test(rose.sku) && rose.stockSellable === 0 && oud?.unit === "ml",
      rose ? `sku ${rose.sku}, price ${rose.sellPrice}, cost ${rose.costFifo}, unit ${rose.unit}, stock ${rose.stockSellable}` : "missing");
    const manual = await req("POST", "/api/products", owner, { sku: `QA-MAN-${tag}`, name: `QA Manual ${tag}`, category: "Brands", unit: "pcs", sellPrice: 9, costFifo: 4, itemType: "finished" });
    const manualOud = await req("POST", "/api/products", owner, { sku: `QA-MANML-${tag}`, name: `QA Manual Oil ${tag}`, category: "Single Notes", unit: "ml", sellPrice: 3, costFifo: 1, itemType: "finished" });
    check("IMP-4c", "same low-stock default as a manually created product (pcs and ml)",
      manual.status === 201 && rose?.lowStockAt === manual.body.lowStockAt && oud?.lowStockAt === manualOud.body.lowStockAt,
      `imported pcs ${rose?.lowStockAt} vs manual ${manual.body.lowStockAt}; imported ml ${oud?.lowStockAt} vs manual ${manualOud.body.lowStockAt}`);

    if (!rose || !oud) throw new Error("commit did not create the products — later checks need them");

    console.log("\n== existing product APIs ==");
    const viaList = await inApi(names.rose);
    const viaSearch = (await req("GET", `/api/products?q=${encodeURIComponent(names.rose)}`, owner)).body as any[];
    const viaId = await req("GET", `/api/products/${rose._id}`, owner);
    const asCashier = (await apiList(cashier)).find((p) => p.name === names.rose);
    check("IMP-5", "returned by GET /api/products, ?q= search and /api/products/:id", !!viaList && viaSearch.some((p) => p.name === names.rose) && viaId.status === 200 && viaId.body.name === names.rose,
      `list ${!!viaList}, search ${viaSearch.length}, by id ${viaId.status}`);
    check("IMP-5b", "cashier sees it too, with cost fields redacted like any product", !!asCashier && asCashier.costFifo === undefined && asCashier.sellPrice === 5000, `costFifo ${asCashier?.costFifo}, sellPrice ${asCashier?.sellPrice}`);

    console.log("\n== search text is literal ==");
    const odd = `QA (Ltd) 50% Oud+ [${tag}]`;
    await req("POST", "/api/products", owner, { sku: `QA-ODD-${tag}`, name: odd, category: "Brands", unit: "pcs", sellPrice: 9, costFifo: 4, itemType: "finished" });
    const qs = ["(", "[", "*", "+", "\\", "?"];
    const crashes = [];
    for (const q of qs) { const r = await req("GET", `/api/products?q=${encodeURIComponent(q)}`, owner); if (r.status !== 200) crashes.push(`${q}→${r.status}`); }
    check("IMP-5c", "search with regex characters ( [ * + \\ ? does not error", crashes.length === 0, crashes.join(", ") || "all 200");
    const lit = (await req("GET", `/api/products?q=${encodeURIComponent(`(Ltd) 50% Oud+ [${tag}]`)}`, owner)).body as any[];
    const dotStar = (await req("GET", `/api/products?q=${encodeURIComponent(".*")}`, owner)).body as any[];
    check("IMP-5d", "special characters match literally; \".*\" is not a match-everything pattern", Array.isArray(lit) && lit.length === 1 && lit[0].name === odd && Array.isArray(dotStar) && dotStar.length === 0,
      `literal hits ${Array.isArray(lit) ? lit.length : lit}, ".*" hits ${Array.isArray(dotStar) ? dotStar.length : dotStar}`);
    const fq = await req("GET", `/api/formulas?q=${encodeURIComponent("(")}`, owner);
    check("IMP-5e", "formula search with \"(\" does not error", fq.status === 200, `HTTP ${fq.status}`);

    console.log("\n== duplicates ==");
    const dupNoCode = await stage([{ name: names.rose, category: "Brands", unit: "pcs", cost: 2000, retail: 5000 }]);
    check("IMP-6", "same Name + Category without Internal Code → row error (no duplicate product)", dupNoCode.body.created === 0 && dupNoCode.body.failed === 1, String(dupNoCode.body.rows?.[0]?.errorReason ?? "").slice(0, 100));
    const upd = await stage([{ code: rose.sku, name: names.rose, category: "Brands", unit: "pcs", cost: 2000, retail: 5500, wholesale: 4000 }]);
    const updCommit = await req("POST", "/api/products/import/commit", owner, { batchId: upd.body.batchId });
    const roseAfter = await Product.findById(rose._id).lean<any>();
    const roseCount = await Product.countDocuments({ name: names.rose });
    check("IMP-7", "Internal Code row updates the existing product in place (no duplicate)", upd.body.updated === 1 && updCommit.status === 200 && roseAfter.sellPrice === 5500 && roseCount === 1, `price ${roseAfter.sellPrice}, copies ${roseCount}`);
    const manualDup = await req("POST", "/api/products", owner, { sku: rose.sku, name: "QA clash", category: "Brands", unit: "pcs", sellPrice: 1, costFifo: 1 });
    check("IMP-8", "a manual product can't reuse an imported SKU (shared unique rule)", manualDup.status === 400, `HTTP ${manualDup.status}`);

    console.log("\n== normal flow on imported products ==");
    const edit = await req("PUT", `/api/products/${rose._id}`, owner, { name: `${names.rose} Deluxe`, sellPrice: 6000 });
    const edited = await inApi(`${names.rose} Deluxe`);
    check("IMP-9", "imported product edited via the normal product API; API returns the new value", edit.status === 200 && edited?.sellPrice === 6000, `PUT ${edit.status}; API price ${edited?.sellPrice}`);
    const manualInApi = await inApi(`QA Manual ${tag}`);
    check("IMP-10", "manually created products still listed alongside imported ones", !!manualInApi, `manual ${!!manualInApi}`);

    // Prove nothing reads products from the import batch: rewrite the batch's
    // stored rows to junk. The API must keep serving the products collection.
    await ImportBatch.updateMany({ batchId: { $in: [batch2, upd.body.batchId] } }, { $set: { "rows.$[].payload.name": "JUNK-FROM-BATCH", "rows.$[].payload.sellPrice": 1 } });
    const afterJunk = await apiList();
    check("IMP-11", "API serves the products collection, not the import batch", afterJunk.some((p) => p.name === `${names.rose} Deluxe` && p.sellPrice === 6000) && !afterJunk.some((p) => p.name === "JUNK-FROM-BATCH"), "batch rows rewritten to junk; API unaffected");

    console.log("\n== UI (headless Chrome) ==");
    if (!fs.existsSync(CHROME)) {
      console.log(`  ■ BLOCKED: Chrome not found at ${CHROME} (set CHROME_BIN) — UI checks skipped`);
    } else {
      chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1440,1000", "about:blank"], { stdio: "ignore", detached: true });
      let wsUrl = "";
      for (let i = 0; i < 100 && !wsUrl; i++) {
        try { wsUrl = ((await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as any[]).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? ""; } catch { /* starting */ }
        if (!wsUrl) await sleep(200);
      }
      cdp = await Cdp.connect(wsUrl);
      const c = cdp;
      await c.send("Page.enable");
      await c.send("Runtime.enable");
      await c.send("Network.enable");
      await c.send("Network.setCookie", { name: "unich_session", value: owner.split("=").slice(1).join("="), url: BASE, httpOnly: true });
      const evaluate = async (expr: string) => (await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
      const waitFor = async (expr: string, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evaluate(expr)) return true; await sleep(150); } return false; };
      const productOption = (name: string) => `[...document.querySelectorAll('select[aria-label="Filter by product"] option')].some(o => o.textContent.trim() === ${JSON.stringify(name)})`;

      await c.send("Page.navigate", { url: `${BASE}/inventory` });
      const listed = await waitFor(productOption(`${names.rose} Deluxe`));
      const others = await evaluate(`${productOption(names.oud)} && ${productOption(names.musk)} && ${productOption(`QA Manual ${tag}`)}`);
      check("IMP-12", "Inventory page lists the imported products (and manual ones) from the API", listed && !!others, `rose ${listed}, oud+musk+manual ${others}`);

      // Change it through the normal flow, then reload the page: the new DB value shows.
      await req("PUT", `/api/products/${rose._id}`, owner, { name: `${names.rose} Gold` });
      await c.send("Page.reload");
      const refreshed = await waitFor(productOption(`${names.rose} Gold`));
      const stale = await evaluate(productOption(`${names.rose} Deluxe`));
      check("IMP-13", "after a normal edit + page reload, the Inventory page shows the latest MongoDB value", refreshed && !stale, `new name ${refreshed}, old name still shown ${stale}`);

      // POS: search the imported product by name.
      await c.send("Page.navigate", { url: `${BASE}/pos` });
      await waitFor(`!!document.querySelector('input[placeholder^="Search name, SKU"]')`);
      await sleep(1200); // catalogue load
      await evaluate(`(() => { const el = document.querySelector('input[placeholder^="Search name, SKU"]'); el.focus(); return true; })()`);
      await c.send("Input.insertText", { text: names.musk });
      const posFound = await waitFor(`document.body.innerText.includes(${JSON.stringify(names.musk)})`, 8000);
      check("IMP-14", "POS search finds the imported product", posFound, `searched "${names.musk}"`);

      // Where did the page get products from? The browser's own request log.
      await c.send("Page.navigate", { url: `${BASE}/inventory` });
      await waitFor(productOption(`${names.rose} Gold`));
      const perf: string[] = (await evaluate(`performance.getEntriesByType('resource').map(e => e.name)`)) ?? [];
      const all = perf.map((u) => { try { return new URL(u, BASE).pathname; } catch { return u; } });
      const productsApi = all.some((p) => p === "/api/products");
      const importReads = all.filter((p) => p.startsWith("/api/products/import") || /\.xlsx?$/i.test(p));
      check("IMP-15", "Inventory page loads products from /api/products — no import-batch or Excel reads", productsApi && importReads.length === 0, `products API ${productsApi}; import/Excel requests [${importReads.join(", ")}]`);
      const storage = await evaluate(`JSON.stringify(Object.keys(localStorage).concat(Object.keys(sessionStorage)).filter(k => { const v = localStorage.getItem(k) ?? sessionStorage.getItem(k) ?? ""; return v.includes(${JSON.stringify(names.musk)}); }))`);
      check("IMP-16", "no imported product data kept in localStorage/sessionStorage", storage === "[]", `keys holding product data: ${storage}`);
    }

    // Static guard: no UI/server consumer reads products from ImportBatch or Excel.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        if (p.includes(`${path.sep}api${path.sep}products${path.sep}import`) || p.includes(`${path.sep}lib${path.sep}excel`) || p.endsWith(`${path.sep}models.ts`)) continue;
        const src = fs.readFileSync(p, "utf8");
        if (/\bImportBatch\b/.test(src) && !/import type/.test(src.split("\n").find((l) => /\bImportBatch\b/.test(l)) ?? "")) offenders.push(path.relative(process.cwd(), p));
      }
    };
    walk(path.join(process.cwd(), "src"));
    const uiImportCalls = fs.readdirSync(path.join(process.cwd(), "src", "app", "(app)"), { recursive: true, withFileTypes: false } as any)
      .map(String).filter((f) => /\.tsx?$/.test(f))
      .filter((f) => fs.readFileSync(path.join(process.cwd(), "src", "app", "(app)", f), "utf8").includes("/api/products/import"));
    check("IMP-17", "only the import endpoints touch ImportBatch; only the Inventory import dialog calls them",
      offenders.length === 0 && uiImportCalls.every((f) => f.startsWith(`inventory${path.sep}`)),
      `ImportBatch used in: [${offenders.join(", ")}]; UI calling import API: [${uiImportCalls.join(", ")}]`);
  } finally {
    try { cdp?.close(); } catch { /* */ }
    try { if (chrome?.pid) process.kill(-chrome.pid, "SIGTERM"); } catch { /* */ }
    try { process.kill(-(server.pid as number), "SIGTERM"); } catch { /* */ }
    await sleep(1500);
    fs.rmSync(profile, { recursive: true, force: true });
  }
  if (fails.length) console.log(`\nFailures:\n  ${fails.join("\n  ")}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
