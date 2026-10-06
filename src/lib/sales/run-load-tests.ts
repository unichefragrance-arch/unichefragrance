/**
 * POS checkout load + stress test (npm run test:load:sales).
 *
 * Boots `next start` (production build — run `npm run build` first) or
 * `next dev` with LOAD_SERVER=dev, then drives /api/sales over HTTP with a
 * locally minted cashier session and checks the DB afterwards:
 *
 *  1. Load     — sustained mixed checkouts (none / item % / bill amount /
 *                both discounts) at LOAD_CONCURRENCY for LOAD_DURATION_S.
 *                Reports throughput + latency percentiles, then verifies
 *                stock == FIFO layers == start − sold, and every sale's
 *                total == subtotal − discountTotal == expected.
 *  2. Ramp     — short bursts at rising concurrency to find where latency
 *                or errors break down.
 *  3. Oversell — many concurrent buyers for a product with little stock:
 *                exactly `stock` sales may succeed, never negative stock.
 *  4. Idempotency — one key fired concurrently → exactly one sale.
 *  5. Approvals — concurrent approve → checkout with single-use tokens; one
 *                token fired at many checkouts at once → exactly one sale.
 *  6. Lockout  — parallel wrong-password approvals: how many reach the
 *                password check before the 8-attempt lockout engages.
 *  7. Login    — same lockout on /api/auth/login: parallel brute force,
 *                sequential countdown, success clears the counter.
 *  8. Price floor (POS-060..067) — concurrent below-minimum checkouts with
 *                no / forged tokens and manager approvals are all refused
 *                with no stock moved; Admin-approved ones all succeed at the
 *                approved price; changed carts, cross-cashier and reused
 *                tokens are refused.
 *  9. POS page — concurrent GET /pos at rising user counts (server render
 *                only; no browser CPU / memory / JS errors).
 *
 * Same safety guard as the E2E suites: refuses unless DATABASE_URL is local
 * (no override for remote databases).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "../db";
import {
  AppSettings,
  Customer,
  DiscountApproval,
  FifoLayer,
  Product,
  RateLimit,
  Sale,
  User,
} from "../models";
import { testSessionCookie } from "../auth/testSession";
import { hashPassword } from "../auth/password";
import { RATE_LIMIT } from "../auth/rateLimitConfig";
import { assertLocalDb } from "../e2eGuard";
import { DISCOUNT_LIMIT_PCT, computeDiscounts, type DiscountInput } from "./discount";

const PORT = Number(process.env.E2E_PORT || 3913);
const BASE = `http://localhost:${PORT}`;
const PHONE = "70000099";
const DURATION_S = Number(process.env.LOAD_DURATION_S || 20);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY || 20);
const RAMP = (process.env.LOAD_RAMP || "10,25,50,100").split(",").map(Number);
const RAMP_REQUESTS_PER_WORKER = 5;

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startServer(): ChildProcess {
  const mode = process.env.LOAD_SERVER === "dev" ? "dev" : "start";
  const proc = spawn("npx", ["next", mode, "-p", String(PORT)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", () => {});
  return proc;
}

async function stopServer(proc: ChildProcess) {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 5000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function waitForServer(timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

type Result = { status: number; ms: number; code?: string; body: Record<string, unknown> };

function pctl(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(label: string, results: Result[], wallMs: number) {
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const byStatus = new Map<string, number>();
  for (const r of results) {
    const k = `${r.status}${r.code ? ` ${r.code}` : ""}`;
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }
  const row = {
    label,
    requests: results.length,
    rps: Math.round((results.length / (wallMs / 1000)) * 10) / 10,
    p50: Math.round(pctl(ms, 50)),
    p95: Math.round(pctl(ms, 95)),
    p99: Math.round(pctl(ms, 99)),
    max: Math.round(ms[ms.length - 1] ?? 0),
    statuses: [...byStatus.entries()].map(([k, v]) => `${k}×${v}`).join(", "),
  };
  console.log(
    `    ${row.label.padEnd(18)} ${String(row.requests).padStart(5)} req  ${String(row.rps).padStart(6)} req/s  ` +
      `p50 ${row.p50}ms  p95 ${row.p95}ms  p99 ${row.p99}ms  max ${row.max}ms  [${row.statuses}]`,
  );
  return row;
}

async function main() {
  assertLocalDb();
  await connectDB();

  const tag = Date.now();
  const supplierId = new mongoose.Types.ObjectId();
  const BIG_STOCK = 1_000_000;
  const mkProduct = async (sku: string, sellPrice: number, stock: number, unitCost: number) => {
    const p = await Product.create({
      sku,
      name: `Load ${sku}`,
      category: "Perfume",
      unit: "pcs",
      sellPrice,
      stockSellable: stock,
    });
    // Several layers so FIFO walks across layer boundaries under load.
    const layers = 4;
    for (let i = 0; i < layers; i++) {
      await FifoLayer.create({
        productId: p._id,
        supplierId,
        supplierName: "Load Supplier",
        purchaseDate: new Date(Date.now() - (layers - i) * 86_400_000),
        qtyRemaining: stock / layers,
        originalQty: stock / layers,
        unitCost: unitCost + i,
        currency: "OMR",
      });
    }
    return p;
  };
  const hot = [
    await mkProduct(`LOAD-A-${tag}`, 12.5, BIG_STOCK, 4),
    await mkProduct(`LOAD-B-${tag}`, 30, BIG_STOCK, 10),
    await mkProduct(`LOAD-C-${tag}`, 7.25, BIG_STOCK, 2),
  ];
  const SCARCE_STOCK = 30;
  const scarce = await mkProduct(`LOAD-S-${tag}`, 50, SCARCE_STOCK * 1, 20);
  // mkProduct splits into 4 layers; 30/4 is fractional — fix to whole layers.
  await FifoLayer.deleteMany({ productId: scarce._id });
  await FifoLayer.create(
    [10, 10, 10].map((q, i) => ({
      productId: scarce._id,
      supplierId,
      supplierName: "Load Supplier",
      purchaseDate: new Date(Date.now() - (3 - i) * 86_400_000),
      qtyRemaining: q,
      originalQty: q,
      unitCost: 20 + i,
      currency: "OMR",
    })),
  );
  // POS-060..067: thin margin — shelf 100, cost 95, so a 10% (cashier-limit)
  // discount lands at 90, below the minimum, with no discount approval needed.
  const FLOOR_STOCK = 10_000;
  const floorProduct = await Product.create({
    sku: `LOAD-F-${tag}`,
    name: `Load LOAD-F-${tag}`,
    category: "Perfume",
    unit: "pcs",
    sellPrice: 100,
    costFifo: 95,
    minMarginPct: 0,
    stockSellable: FLOOR_STOCK,
  });
  await FifoLayer.create({
    productId: floorProduct._id,
    supplierId,
    supplierName: "Load Supplier",
    purchaseDate: new Date(Date.now() - 86_400_000),
    qtyRemaining: FLOOR_STOCK,
    originalQty: FLOOR_STOCK,
    unitCost: 95,
    currency: "OMR",
  });
  const allProductIds = [...hot.map((p) => p._id), scarce._id, floorProduct._id];

  const hadSettings = await AppSettings.exists({ key: "default" });
  if (!hadSettings) {
    await AppSettings.create({
      key: "default",
      salespeople: ["Load Cashier"],
      activeSalesperson: "Load Cashier",
    });
  }

  const ownerEmail = `load-owner-${tag}@test.local`;
  const victimEmail = `load-victim-${tag}@test.local`;
  const loginVictimEmail = `load-login-victim-${tag}@test.local`;
  const loginUserEmail = `load-login-user-${tag}@test.local`;
  const password = "Load-approve-123";
  // 5 managers on shift: each approval reserves a lockout slot, so one account
  // can't have more than RATE_LIMIT.account.maxAttempts approvals in flight.
  const approverEmails = Array.from({ length: 5 }, (_, i) =>
    i === 0 ? ownerEmail : `load-owner${i}-${tag}@test.local`,
  );
  const managerEmails = Array.from({ length: 5 }, (_, i) => `load-manager${i}-${tag}@test.local`);
  const users = await User.create([
    ...managerEmails.map((email) => ({
      name: "Load Manager",
      email,
      passwordHash: hashPassword(password),
      role: "manager",
      roleLabel: "Manager",
    })),
    ...approverEmails.map((email) => ({
      name: "Load Owner",
      email,
      passwordHash: hashPassword(password),
      role: "owner",
      roleLabel: "Owner",
    })),
    { name: "Load Victim", email: victimEmail, passwordHash: hashPassword(password), role: "owner", roleLabel: "Owner" },
    { name: "Login Victim", email: loginVictimEmail, passwordHash: hashPassword(password), role: "cashier", roleLabel: "Cashier" },
    { name: "Login User", email: loginUserEmail, passwordHash: hashPassword(password), role: "cashier", roleLabel: "Cashier" },
  ]);

  const sessionCookie = async (userId: string, name: string, role: "cashier" | "owner") =>
    (await testSessionCookie({
      userId,
      name,
      email: `${name.toLowerCase().replace(/\s+/g, "-")}@test.local`,
      role,
      roleLabel: role === "owner" ? "Owner" : "Cashier",
      branchId: null,
      branchName: null,
    }));
  const cookie = await sessionCookie("000000000000000000000099", "Load Cashier", "cashier");
  const cookieB = await sessionCookie("000000000000000000000098", "Load Cashier B", "cashier");
  const ownerCookie = await sessionCookie("000000000000000000000097", "Load Admin", "owner");

  async function post(
    body: Record<string, unknown>,
    path = "/api/sales",
    as = cookie,
  ): Promise<Result> {
    const t = performance.now();
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: as },
        body: JSON.stringify({ customerPhone: PHONE, payment: "cash", ...body }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, ms: performance.now() - t, code: json.code as string | undefined, body: json };
    } catch (err) {
      return { status: 0, ms: performance.now() - t, code: "NETWORK", body: { error: String(err) } };
    }
  }

  // Mixed, always within the cashier limit, so every request should succeed.
  const cashierLimit = DISCOUNT_LIMIT_PCT.cashier;
  function randomSale(i: number) {
    const lineCount = 1 + (i % 3);
    const lines = Array.from({ length: lineCount }, (_, k) => {
      const p = hot[(i + k) % hot.length];
      const qty = 1 + ((i + k) % 3);
      const discount: DiscountInput | undefined =
        (i + k) % 4 === 1 ? { type: "percent", value: Math.min(cashierLimit, 5 + (k % 5)) } : undefined;
      return { productId: String(p._id), qty, lineType: "ready", discount, price: p.sellPrice as number };
    });
    const invoiceDiscount: DiscountInput | undefined =
      i % 3 === 0 ? { type: "amount", value: 0.5 } : undefined;
    const expected = computeDiscounts(
      lines.map((l) => ({ gross: l.qty * l.price, discount: l.discount })),
      invoiceDiscount,
    );
    // Keep the whole bill inside the cashier limit (no approval needed).
    const ok = expected.maxDiscountPct <= cashierLimit;
    return {
      body: {
        lines: lines.map(({ price: _price, ...l }) => l),
        invoiceDiscount: ok ? invoiceDiscount : undefined,
        idempotencyKey: randomUUID(),
      },
      expectedTotal: ok
        ? expected.total
        : computeDiscounts(lines.map((l) => ({ gross: l.qty * l.price, discount: l.discount }))).total,
    };
  }

  const server = startServer();
  const report: Record<string, unknown> = {};
  try {
    await waitForServer();
    // Warm route compilation / caches so the first sample isn't an outlier.
    for (let i = 0; i < 3; i++) await post(randomSale(i).body);

    console.log(`\n1. Sustained load — ${CONCURRENCY} concurrent cashiers for ${DURATION_S}s`);
    const stockBefore = await Product.find({ _id: { $in: hot.map((p) => p._id) } })
      .select("stockSellable")
      .lean<{ _id: unknown; stockSellable: number }[]>();
    const saleIdsBefore = new Set(
      (await Sale.find({ customerPhone: PHONE }).select("_id").lean()).map((s) => String(s._id)),
    );
    const loadResults: Result[] = [];
    const expectedById = new Map<string, number>();
    let seq = 0;
    const deadline = Date.now() + DURATION_S * 1000;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (Date.now() < deadline) {
          const { body, expectedTotal } = randomSale(seq++);
          const r = await post(body);
          loadResults.push(r);
          if (r.status === 201) expectedById.set(String(r.body.id), expectedTotal);
        }
      }),
    );
    report.load = summarize("mixed checkout", loadResults, performance.now() - t0);

    await check("load: no 5xx / network errors", () => {
      const bad = loadResults.filter((r) => r.status === 0 || r.status >= 500);
      assert.equal(bad.length, 0, JSON.stringify(bad.slice(0, 3).map((r) => r.body)));
    });
    await check("load: every checkout succeeded (201)", () => {
      const non = loadResults.filter((r) => r.status !== 201);
      assert.equal(non.length, 0, JSON.stringify(non.slice(0, 3).map((r) => [r.status, r.body])));
    });

    const newSales = (
      await Sale.find({ customerPhone: PHONE })
        .select("subtotal total discountTotal lines inventoryDeductions")
        .lean<
          {
            _id: unknown;
            subtotal: number;
            total: number;
            discountTotal: number;
            lines: { productId: unknown; qty: number }[];
            inventoryDeductions: { productId: unknown; qty: number; costTotal: number }[];
          }[]
        >()
    ).filter((s) => !saleIdsBefore.has(String(s._id)));

    await check("load: every sale's total == subtotal − discountTotal == client-computed total", () => {
      let mismatches = 0;
      for (const s of newSales) {
        const exp = expectedById.get(String(s._id));
        const selfOk = Math.abs(s.subtotal - s.discountTotal - s.total) < 1e-6;
        if (!selfOk || (exp !== undefined && Math.abs(exp - s.total) > 1e-6)) mismatches++;
      }
      assert.equal(mismatches, 0, `${mismatches}/${newSales.length} sales mismatched`);
    });

    await check("load: stock, FIFO layers and sold qty agree (no lost / double deductions)", async () => {
      for (const p of hot) {
        const sold = newSales.reduce(
          (s, sale) =>
            s +
            sale.inventoryDeductions
              .filter((d) => String(d.productId) === String(p._id))
              .reduce((a, d) => a + d.qty, 0),
          0,
        );
        const soldLines = newSales.reduce(
          (s, sale) =>
            s +
            sale.lines
              .filter((l) => String(l.productId) === String(p._id))
              .reduce((a, l) => a + l.qty, 0),
          0,
        );
        const before = stockBefore.find((x) => String(x._id) === String(p._id))!.stockSellable;
        const now = (await Product.findById(p._id).lean<{ stockSellable: number }>())!.stockSellable;
        const layers = (await FifoLayer.find({ productId: p._id }).lean<{ qtyRemaining: number }[]>()).reduce(
          (s, l) => s + l.qtyRemaining,
          0,
        );
        assert.equal(sold, soldLines, `${p.sku}: deductions ${sold} != line qty ${soldLines}`);
        assert.equal(before - now, sold, `${p.sku}: stock dropped ${before - now}, sold ${sold}`);
        assert.equal(layers, now, `${p.sku}: layers ${layers} != stock ${now}`);
      }
    });

    console.log(`\n2. Ramp — ${RAMP.join(" → ")} concurrent, ${RAMP_REQUESTS_PER_WORKER} sales each`);
    const ramp: unknown[] = [];
    for (const c of RAMP) {
      const results: Result[] = [];
      const t = performance.now();
      await Promise.all(
        Array.from({ length: c }, async () => {
          for (let k = 0; k < RAMP_REQUESTS_PER_WORKER; k++) results.push(await post(randomSale(seq++).body));
        }),
      );
      ramp.push(summarize(`concurrency ${c}`, results, performance.now() - t));
      await check(`ramp ${c}: no 5xx / network errors`, () => {
        const bad = results.filter((r) => r.status === 0 || r.status >= 500);
        assert.equal(bad.length, 0, JSON.stringify(bad.slice(0, 2).map((r) => r.body)));
      });
    }
    report.ramp = ramp;

    console.log(`\n3. Oversell race — 100 concurrent buyers, ${SCARCE_STOCK} units`);
    const race = await Promise.all(
      Array.from({ length: 100 }, () =>
        post({
          lines: [{ productId: String(scarce._id), qty: 1, lineType: "ready", discount: { type: "percent", value: 5 } }],
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    summarize("oversell race", race, Math.max(...race.map((r) => r.ms)));
    await check(`oversell: exactly ${SCARCE_STOCK} sold, rest INSUFFICIENT_STOCK, stock 0`, async () => {
      const ok = race.filter((r) => r.status === 201).length;
      const short = race.filter((r) => r.code === "INSUFFICIENT_STOCK").length;
      const s = (await Product.findById(scarce._id).lean<{ stockSellable: number }>())!.stockSellable;
      const layers = (await FifoLayer.find({ productId: scarce._id }).lean<{ qtyRemaining: number }[]>()).reduce(
        (a, l) => a + l.qtyRemaining,
        0,
      );
      assert.equal(ok, SCARCE_STOCK, `succeeded ${ok}`);
      assert.equal(short, 100 - SCARCE_STOCK, `insufficient ${short}`);
      assert.equal(s, 0, `stock ${s}`);
      assert.equal(layers, 0, `layers ${layers}`);
    });

    console.log("\n4. Idempotency — same key fired 25× concurrently");
    const key = randomUUID();
    const before4 = (await Product.findById(hot[0]._id).lean<{ stockSellable: number }>())!.stockSellable;
    const dup = await Promise.all(
      Array.from({ length: 25 }, () =>
        post({
          lines: [{ productId: String(hot[0]._id), qty: 2, lineType: "ready", discount: { type: "amount", value: 1 } }],
          idempotencyKey: key,
        }),
      ),
    );
    summarize("duplicate key", dup, Math.max(...dup.map((r) => r.ms)));
    await check("idempotency: one sale, stock deducted once, all callers get it", async () => {
      // Stored keys are scoped per user + branch (POS-146b): match on the client key part.
      assert.equal(await Sale.countDocuments({ idempotencyKey: { $regex: `\\|k:${key}$` } }), 1);
      const after = (await Product.findById(hot[0]._id).lean<{ stockSellable: number }>())!.stockSellable;
      assert.equal(before4 - after, 2);
      const ids = new Set(dup.filter((r) => r.status < 300).map((r) => String(r.body.id)));
      assert.equal(ids.size, 1, `distinct ids ${[...ids].join(",")}`);
      const errs = dup.filter((r) => r.status >= 300);
      assert.equal(errs.length, 0, JSON.stringify(errs.slice(0, 2).map((r) => [r.status, r.body])));
    });

    console.log("\n5. Approvals — 30 concurrent over-limit discounts, 5 managers approving");
    const overPct = cashierLimit + 15;
    const overLines = [
      { productId: String(hot[1]._id), qty: 1, lineType: "ready", discount: { type: "percent", value: overPct } },
    ];
    const approveFor = (email: string, pw = password) =>
      post({ lines: overLines, email, password: pw }, "/api/sales/discount-approval");
    const approved = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const t0 = performance.now();
        const a = await approveFor(approverEmails[i % approverEmails.length]);
        if (a.status !== 200) return a;
        const r = await post({
          lines: overLines,
          discountApprovalToken: a.body.approvalToken,
          idempotencyKey: randomUUID(),
        });
        return { ...r, ms: performance.now() - t0 };
      }),
    );
    report.approvals = summarize("approved discount", approved, Math.max(...approved.map((r) => r.ms)));
    await check("approvals: all 30 succeed with the owner recorded", async () => {
      const ok = approved.filter((r) => r.status === 201);
      assert.equal(ok.length, 30, JSON.stringify(approved.filter((r) => r.status !== 201).slice(0, 2).map((r) => r.body)));
      const stored = await Sale.countDocuments({
        _id: { $in: ok.map((r) => new mongoose.Types.ObjectId(String(r.body.id))) },
        "discountApprovedBy.name": "Load Owner",
      });
      assert.equal(stored, 30);
    });

    for (const sameKey of [false, true]) {
      const label = sameKey ? "same idempotency key" : "different keys";
      const a = await approveFor(approverEmails[0]);
      const key = randomUUID();
      const before5 = await Sale.countDocuments({ customerPhone: PHONE });
      const burst = await Promise.all(
        Array.from({ length: 15 }, () =>
          post({
            lines: overLines,
            discountApprovalToken: a.body.approvalToken,
            idempotencyKey: sameKey ? key : randomUUID(),
          }),
        ),
      );
      summarize(`1 token ×15 (${sameKey ? "same key" : "new keys"})`, burst, Math.max(...burst.map((r) => r.ms)));
      await check(`approvals: one token fired 15× concurrently (${label}) → exactly one sale`, async () => {
        assert.equal((await Sale.countDocuments({ customerPhone: PHONE })) - before5, 1);
        const ok = burst.filter((r) => r.status === 201 || r.status === 200);
        if (sameKey) {
          // Every duplicate gets the original sale back — no lockout / "already used" errors.
          assert.equal(ok.length, 15, JSON.stringify(burst.filter((r) => r.status >= 300).slice(0, 2).map((r) => r.body)));
          assert.equal(new Set(ok.map((r) => String(r.body.id))).size, 1);
        } else {
          assert.equal(ok.length, 1);
          assert.ok(burst.filter((r) => r.status !== 201).every((r) => r.code === "DISCOUNT_NOT_AUTHORIZED"));
        }
      });
    }

    console.log(`\n6. Lockout — 40 parallel wrong-password approvals (limit ${RATE_LIMIT.account.maxAttempts})`);
    const before6 = await Sale.countDocuments({ customerPhone: PHONE });
    const brute = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        approveFor(victimEmail, `guess-${i}`),
      ),
    );
    summarize("wrong password", brute, Math.max(...brute.map((r) => r.ms)));
    const evaluated = brute.filter((r) => String(r.body.error).startsWith("Approval failed")).length;
    const locked = brute.filter((r) => String(r.body.error).startsWith("Too many")).length;
    console.log(`    passwords actually checked: ${evaluated}, rejected by lockout: ${locked}`);
    report.lockout = { evaluated, locked, limit: RATE_LIMIT.account.maxAttempts };
    await check("lockout: every wrong-password attempt blocked, no sale written", async () => {
      assert.equal(brute.filter((r) => r.status !== 403).length, 0);
      assert.equal(await Sale.countDocuments({ customerPhone: PHONE }), before6);
    });
    await check(`lockout: at most ${RATE_LIMIT.account.maxAttempts} passwords checked under parallel attack`, () => {
      assert.ok(
        evaluated <= RATE_LIMIT.account.maxAttempts,
        `${evaluated} passwords were checked before lockout engaged (limit ${RATE_LIMIT.account.maxAttempts})`,
      );
    });
    await check("lockout: account is locked afterwards even for the right password", async () => {
      const r = await approveFor(victimEmail);
      assert.equal(r.status, 403);
      assert.match(String(r.body.error), /Too many/);
    });

    console.log(`\n7. Login lockout — /api/auth/login (limit ${RATE_LIMIT.account.maxAttempts})`);
    const login = async (email: string, pw: string): Promise<Result> => {
      const t = performance.now();
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: pw }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, ms: performance.now() - t, body: json };
    };
    const maxAttempts = RATE_LIMIT.account.maxAttempts;
    const loginBrute = await Promise.all(
      Array.from({ length: 40 }, (_, i) => login(loginVictimEmail, `guess-${i}`)),
    );
    summarize("login brute force", loginBrute, Math.max(...loginBrute.map((r) => r.ms)));
    await check(`login: 40 parallel guesses → exactly ${maxAttempts}× 401, rest 429`, () => {
      const s401 = loginBrute.filter((r) => r.status === 401).length;
      const s429 = loginBrute.filter((r) => r.status === 429).length;
      assert.equal(s401, maxAttempts, `401×${s401}`);
      assert.equal(s429, 40 - maxAttempts, `429×${s429}`);
    });
    await check("login: locked even with the right password; attempts list stays bounded", async () => {
      const r = await login(loginVictimEmail, password);
      assert.equal(r.status, 429);
      const doc = await RateLimit.findOne({ key: `email:${loginVictimEmail}` }).lean<{ attempts: Date[] }>();
      assert.ok(doc && doc.attempts.length <= maxAttempts, `attempts stored: ${doc?.attempts.length}`);
    });
    await check("login: sequential countdown, then correct password succeeds and clears the counter", async () => {
      for (let i = 1; i < maxAttempts; i++) {
        const r = await login(loginUserEmail, `nope-${i}`);
        assert.equal(r.status, 401, `attempt ${i}`);
        if (maxAttempts - i <= 2) assert.equal(r.body.attemptsRemaining, maxAttempts - i, `attempt ${i}`);
      }
      const ok = await login(loginUserEmail, password);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      await sleep(200); // clear is fire-and-forget
      assert.equal(await RateLimit.countDocuments({ key: `email:${loginUserEmail}` }), 0);
      const again = await login(loginUserEmail, "nope-again");
      assert.equal(again.status, 401, "fresh window after success");
    });

    console.log("\n8. Price floor (POS-060..067) — shelf 100, cost 95, cashier sells at 90");
    const floorId = String(floorProduct._id);
    const floorLines = (pct: number) => [
      { productId: floorId, qty: 1, lineType: "ready", discount: { type: "percent", value: pct } },
    ];
    const floorStock = async () =>
      (await Product.findById(floorProduct._id).lean<{ stockSellable: number }>())!.stockSellable;
    const floorSales = () => Sale.countDocuments({ customerPhone: PHONE, "lines.productId": floorProduct._id });
    const floorLayers = async () =>
      (await FifoLayer.find({ productId: floorProduct._id }).lean<{ qtyRemaining: number }[]>()).reduce(
        (a, l) => a + l.qtyRemaining,
        0,
      );

    const above = await Promise.all(
      Array.from({ length: 50 }, () => post({ lines: floorLines(4), idempotencyKey: randomUUID() })),
    );
    report.floorAbove = summarize("above min ×50", above, Math.max(...above.map((r) => r.ms)));
    await check("POS-060: 50 concurrent sales above the minimum (96) → all 201, no prompt", () => {
      const non = above.filter((r) => r.status !== 201);
      assert.equal(non.length, 0, JSON.stringify(non.slice(0, 2).map((r) => r.body)));
    });
    const atMin = await post({ lines: floorLines(5), idempotencyKey: randomUUID() });
    await check("POS-061: exactly at the minimum (95) → 201", () => {
      assert.equal(atMin.status, 201, JSON.stringify(atMin.body));
    });

    const stock8 = await floorStock();
    const sales8 = await floorSales();
    const noToken = await Promise.all(
      Array.from({ length: 50 }, () => post({ lines: floorLines(10), idempotencyKey: randomUUID() })),
    );
    report.floorBlocked = summarize("below min ×50", noToken, Math.max(...noToken.map((r) => r.ms)));
    const forged = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        post({
          lines: [{ ...floorLines(10)[0], unitPrice: 100, approved: true }],
          approved: true,
          authorized: true,
          priceApproved: true,
          adminApproved: true,
          role: "owner",
          actor: { userId: "000000000000000000000097", role: "owner" },
          discountApprovalToken: i % 2 ? "forged-token" : randomUUID(),
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    summarize("forged ×50", forged, Math.max(...forged.map((r) => r.ms)));
    await check("POS-062/066: 100 concurrent below-minimum checkouts (no token / forged flags) → all 403, nothing written", async () => {
      const all = [...noToken, ...forged];
      const bad = all.filter((r) => r.status !== 403 || r.code !== "PRICE_FLOOR_APPROVAL_REQUIRED");
      assert.equal(bad.length, 0, JSON.stringify(bad.slice(0, 2).map((r) => [r.status, r.body])));
      assert.equal(await floorSales(), sales8, "sales written");
      assert.equal(await floorStock(), stock8, "stock moved");
      assert.equal(await floorLayers(), stock8, "FIFO layers moved");
    });

    const mgr = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(
          { lines: floorLines(10), email: managerEmails[i % managerEmails.length], password },
          "/api/sales/discount-approval",
        ),
      ),
    );
    summarize("manager approve ×20", mgr, Math.max(...mgr.map((r) => r.ms)));
    await check("POS-063 (authz): 20 concurrent manager approvals of a below-minimum price → all 403", () => {
      const bad = mgr.filter((r) => r.status !== 403 || !/Admin approval/.test(String(r.body.error)));
      assert.equal(bad.length, 0, JSON.stringify(bad.slice(0, 2).map((r) => [r.status, r.body])));
    });
    const wrongPw = await post(
      { lines: floorLines(10), email: approverEmails[4], password: "wrong-password" },
      "/api/sales/discount-approval",
    );
    await check("POS-064: wrong Admin password → 403, no token", () => {
      assert.equal(wrongPw.status, 403);
      assert.equal(wrongPw.body.approvalToken, undefined);
    });

    const APPROVED = 30;
    const stockA = await floorStock();
    const approvedFloor = await Promise.all(
      Array.from({ length: APPROVED }, async (_, i) => {
        const t0 = performance.now();
        const a = await post(
          { lines: floorLines(10), email: approverEmails[i % approverEmails.length], password },
          "/api/sales/discount-approval",
        );
        if (a.status !== 200) return a;
        const r = await post({
          lines: floorLines(10),
          discountApprovalToken: a.body.approvalToken,
          idempotencyKey: randomUUID(),
        });
        return { ...r, ms: performance.now() - t0 };
      }),
    );
    report.floorApproved = summarize("admin approve ×30", approvedFloor, Math.max(...approvedFloor.map((r) => r.ms)));
    await check(`POS-063: ${APPROVED} concurrent Admin-approved sales → all 201 at 90, Admin recorded, stock −${APPROVED}`, async () => {
      const ok = approvedFloor.filter((r) => r.status === 201);
      assert.equal(ok.length, APPROVED, JSON.stringify(approvedFloor.filter((r) => r.status !== 201).slice(0, 2).map((r) => r.body)));
      const docs = await Sale.find({ _id: { $in: ok.map((r) => new mongoose.Types.ObjectId(String(r.body.id))) } })
        .lean<{ total: number; discountApprovedBy?: { role: string }; inventoryDeductions: { costTotal: number }[] }[]>();
      assert.equal(docs.length, APPROVED);
      for (const d of docs) {
        assert.equal(d.total, 90);
        assert.equal(d.discountApprovedBy?.role, "owner");
        // Financial integrity: revenue 90, FIFO cost 95 → gross profit −5.
        assert.equal(d.inventoryDeductions.reduce((a, x) => a + x.costTotal, 0), 95);
      }
      assert.equal(stockA - (await floorStock()), APPROVED);
      assert.equal(await floorLayers(), await floorStock());
    });

    const ownerSelf = await post({ lines: floorLines(10), idempotencyKey: randomUUID() }, "/api/sales", ownerCookie);
    await check("Admin at the till sells below minimum without a prompt", () => {
      assert.equal(ownerSelf.status, 201, JSON.stringify(ownerSelf.body));
    });

    const sales67 = await floorSales();
    const changed = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const a = await post(
          { lines: floorLines(10), email: approverEmails[i % approverEmails.length], password },
          "/api/sales/discount-approval",
        );
        return post({ lines: floorLines(10 - (i % 2 ? 0.5 : -0.5)), discountApprovalToken: a.body.approvalToken, idempotencyKey: randomUUID() });
      }),
    );
    summarize("changed after ×20", changed, Math.max(...changed.map((r) => r.ms)));
    await check("POS-067: 20 concurrent carts changed after Admin approval (9.5% / 10.5%) → all 403", async () => {
      const bad = changed.filter((r) => r.status !== 403 || r.code !== "PRICE_FLOOR_APPROVAL_REQUIRED");
      assert.equal(bad.length, 0, JSON.stringify(bad.slice(0, 2).map((r) => [r.status, r.body])));
      assert.equal(await floorSales(), sales67);
    });

    const forA = await post(
      { lines: floorLines(10), email: approverEmails[1], password },
      "/api/sales/discount-approval",
    );
    const crossUser = await Promise.all(
      Array.from({ length: 10 }, () =>
        post({ lines: floorLines(10), discountApprovalToken: forA.body.approvalToken, idempotencyKey: randomUUID() }, "/api/sales", cookieB),
      ),
    );
    await check("concurrency: cashier A's Admin token used ×10 by cashier B → all 403", async () => {
      assert.equal(crossUser.filter((r) => r.status !== 403).length, 0);
      assert.equal(await floorSales(), sales67);
    });
    const reuse = await Promise.all(
      Array.from({ length: 15 }, () =>
        post({ lines: floorLines(10), discountApprovalToken: forA.body.approvalToken, idempotencyKey: randomUUID() }),
      ),
    );
    summarize("1 admin token ×15", reuse, Math.max(...reuse.map((r) => r.ms)));
    await check("duplicate: one Admin token fired 15× concurrently → exactly one sale", async () => {
      assert.equal(reuse.filter((r) => r.status === 201).length, 1);
      assert.equal((await floorSales()) - sales67, 1);
    });

    console.log("\n9. POS page — concurrent GET /pos (server render only)");
    const pageLoad: unknown[] = [];
    for (const users of [1, 5, 10, 25, 50, 100]) {
      const results: Result[] = [];
      const t = performance.now();
      await Promise.all(
        Array.from({ length: users }, async () => {
          const t1 = performance.now();
          try {
            const res = await fetch(`${BASE}/pos`, { headers: { Cookie: cookie } });
            await res.text();
            results.push({ status: res.status, ms: performance.now() - t1, body: {} });
          } catch (err) {
            results.push({ status: 0, ms: performance.now() - t1, code: "NETWORK", body: { error: String(err) } });
          }
        }),
      );
      pageLoad.push(summarize(`GET /pos ×${users}`, results, performance.now() - t));
      await check(`page ${users}: no 5xx / network errors`, () => {
        assert.equal(results.filter((r) => r.status === 0 || r.status >= 500).length, 0);
      });
    }
    report.pageLoad = pageLoad;
  } finally {
    await stopServer(server);
    await Sale.deleteMany({ customerPhone: PHONE });
    await Customer.deleteMany({ phone: PHONE });
    await FifoLayer.deleteMany({ productId: { $in: allProductIds } });
    await Product.deleteMany({ _id: { $in: allProductIds } });
    await DiscountApproval.deleteMany({ approverUserId: { $in: users.map((u: { _id: unknown }) => String(u._id)) } });
    await User.deleteMany({ _id: { $in: users.map((u: { _id: unknown }) => u._id) } });
    await RateLimit.deleteMany({
      key: {
        $in: [...approverEmails, ...managerEmails, victimEmail, loginVictimEmail, loginUserEmail].map(
          (e) => `email:${e}`,
        ),
      },
    });
    if (!hadSettings) await AppSettings.deleteOne({ key: "default" });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (process.env.LOAD_REPORT_JSON) {
    console.log(JSON.stringify(report));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
