/**
 * Sales API-level E2E (npm run test:e2e:sales):
 * - POS-021: two ready products with the SAME name stay separate through
 *   search → checkout → stock deduction → sale record.
 * - POS-022..030: individual oil sells only in approved tola sizes, deducted
 *   in ml; quantities are whole numbers.
 * - POS-068..075: item + invoice discounts, cashier limit, manager approval,
 *   unauthorized approver blocked, invalid input rejected.
 *
 * Boots a real `next dev` server and drives /api/products + /api/sales over
 * HTTP with a locally minted cashier session cookie, then checks the DB
 * directly. Every fixture it creates is deleted in `finally`.
 *
 * Safety: refuses to run unless DATABASE_URL points at localhost (e.g. a
 * throwaway `mongod --replSet` / mongodb-memory-server). Checkout uses a
 * Mongo transaction, so the DB must be a replica set. There is no override
 * for remote databases.
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
import { DISCOUNT_LIMIT_PCT } from "./discount";
import { assertLocalDb } from "../e2eGuard";
import { resolveSearchPick } from "./posSearch";

const PORT = Number(process.env.E2E_PORT || 3912);
const BASE = `http://localhost:${PORT}`;
const PHONE = "70000021";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await sleep(500);
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

function startServer(): ChildProcess {
  // Own process group so stopServer can kill npx AND the next-server child
  // (SIGTERM to npx alone leaves next-server orphaned on the port).
  const proc = spawn("npx", ["next", "dev", "-p", String(PORT)], {
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

type SaleResponse = {
  id: string;
  total: number;
  lines: Array<{ productId: string; name: string; unitPrice: number; qty: number }>;
  error?: string;
  code?: string;
};

async function main() {
  assertLocalDb();
  await connectDB();

  // Never clobber existing data: the spec SKUs must be free in this DB.
  const taken = await Product.exists({ sku: { $in: ["PERF-001", "PERF-009"] } });
  if (taken) throw new Error("PERF-001 / PERF-009 already exist in this DB — use a fresh DB");

  const supplierId = new mongoose.Types.ObjectId();
  const mk = async (sku: string, sellPrice: number, stock: number) => {
    const p = await Product.create({
      sku,
      name: "Blue Ocean",
      category: "Perfume",
      unit: "pcs",
      sellPrice,
      stockSellable: stock,
    });
    // Stock backed by a FIFO layer, as a received purchase would be.
    await FifoLayer.create({
      productId: p._id,
      supplierId,
      supplierName: "E2E POS-021 Supplier",
      purchaseDate: new Date(),
      qtyRemaining: stock,
      unitCost: 1,
      currency: "OMR",
    });
    return p;
  };
  const productA = await mk("PERF-001", 5000, 10); // "P-101"
  const productB = await mk("PERF-009", 6000, 7); // "P-205"
  const idA = String(productA._id);
  const idB = String(productB._id);
  const oil = await Product.create({
    sku: `OIL-E2E-${Date.now()}`,
    name: "E2E Oud Oil",
    category: "Oil",
    unit: "ml",
    sellPrice: 0.25,
    stockSellable: 100,
  });
  await FifoLayer.create({
    productId: oil._id,
    supplierId,
    supplierName: "E2E Oil Supplier",
    purchaseDate: new Date(),
    qtyRemaining: 100,
    unitCost: 0.1,
    currency: "OMR",
  });
  const idOil = String(oil._id);
  const oilMl = async () =>
    (await Product.findById(idOil).lean<{ stockSellable: number }>())!.stockSellable;

  // resolveSalesperson needs a configured team; only create (and later remove) if absent.
  const hadSettings = await AppSettings.exists({ key: "default" });
  if (!hadSettings) {
    await AppSettings.create({
      key: "default",
      salespeople: ["E2E Cashier"],
      activeSalesperson: "E2E Cashier",
    });
  }

  const cookie = (await testSessionCookie({
    userId: "000000000000000000000021",
    name: "E2E Cashier",
    email: "e2e-cashier@test.local",
    role: "cashier",
    roleLabel: "Cashier",
    branchId: null,
    branchName: null,
  }));

  const stockOf = async () => {
    const [a, b, la, lb] = await Promise.all([
      Product.findById(idA).lean<{ stockSellable: number }>(),
      Product.findById(idB).lean<{ stockSellable: number }>(),
      FifoLayer.find({ productId: idA }).lean<{ qtyRemaining: number }[]>(),
      FifoLayer.find({ productId: idB }).lean<{ qtyRemaining: number }[]>(),
    ]);
    const sum = (ls: { qtyRemaining: number }[]) => ls.reduce((s, l) => s + l.qtyRemaining, 0);
    return { A: a!.stockSellable, B: b!.stockSellable, layersA: sum(la), layersB: sum(lb) };
  };
  const salesCount = () => Sale.countDocuments({ customerPhone: PHONE });

  // Client sends the selected card's DB id. Name + price are deliberately
  // wrong to prove the server never trusts them. A fresh idempotency key per
  // checkout mirrors the POS UI (createIdempotencyKey in pos/page.tsx).
  const sell = async (
    lines: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ) => {
    const res = await fetch(`${BASE}/api/sales`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        customerPhone: PHONE,
        payment: "cash",
        lines,
        idempotencyKey: randomUUID(),
        ...extra,
      }),
    });
    return { status: res.status, body: (await res.json()) as SaleResponse };
  };

  // Discount approvers (POS-071/072). Unique emails so nothing real is touched.
  const tag = Date.now();
  const ownerEmail = `e2e-owner-${tag}@test.local`;
  const cashierEmail = `e2e-cashier-${tag}@test.local`;
  const approverPassword = "E2e-approve-123";
  const approvers = await User.create([
    {
      name: "E2E Owner",
      email: ownerEmail,
      passwordHash: hashPassword(approverPassword),
      role: "owner",
      roleLabel: "Owner",
    },
    {
      name: "E2E Other Cashier",
      email: cashierEmail,
      passwordHash: hashPassword(approverPassword),
      role: "cashier",
      roleLabel: "Cashier",
    },
  ]);

  const server = startServer();
  try {
    await waitForServer();

    await test("search 'Blue Ocean' returns both products distinctly; Enter does not auto-pick", async () => {
      const res = await fetch(`${BASE}/api/products?q=${encodeURIComponent("Blue Ocean")}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(res.status, 200);
      const list = (await res.json()) as Array<{ id: string; name: string; sku: string; sellPrice: number; stockSellable: number }>;
      const hits = list.filter((p) => p.name === "Blue Ocean");
      assert.equal(hits.length, 2);
      const a = hits.find((p) => p.id === idA)!;
      const b = hits.find((p) => p.id === idB)!;
      assert.deepEqual([a.sku, a.sellPrice, a.stockSellable], ["PERF-001", 5000, 10]);
      assert.deepEqual([b.sku, b.sellPrice, b.stockSellable], ["PERF-009", 6000, 7]);
      assert.equal(resolveSearchPick(hits, "Blue Ocean").kind, "ambiguous");
      const bySku = resolveSearchPick(hits, "PERF-009");
      assert.equal(bySku.kind === "pick" && bySku.product.id, idB);
    });

    await test("sell 1 × P-205 (PERF-009) → B 7→6, A stays 10, sale references B at DB price", async () => {
      const { status, body } = await sell([
        { productId: idB, name: "Blue Ocean", qty: 1, lineType: "ready", unitPrice: 1 },
      ]);
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.lines.length, 1);
      assert.equal(String(body.lines[0].productId), idB);
      assert.equal(body.lines[0].unitPrice, 6000);
      assert.equal(body.total, 6000);
      assert.deepEqual(await stockOf(), { A: 10, B: 6, layersA: 10, layersB: 6 });
      const sale = await Sale.findById(body.id).lean<{
        lines: Array<{ productId: unknown }>;
        inventoryDeductions: Array<{ productId: unknown; qty: number }>;
      }>();
      assert.ok(sale, "sale persisted");
      assert.deepEqual(sale.lines.map((l) => String(l.productId)), [idB]);
      assert.deepEqual(
        sale.inventoryDeductions.map((d) => [String(d.productId), d.qty]),
        [[idB, 1]],
      );
    });

    await test("sell 1 × P-101 (PERF-001) → A 10→9, B stays 6, sale references A at DB price", async () => {
      const { status, body } = await sell([
        { productId: idA, name: "Blue Ocean", qty: 1, lineType: "ready", unitPrice: 6000 },
      ]);
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(String(body.lines[0].productId), idA);
      assert.equal(body.total, 5000);
      assert.deepEqual(await stockOf(), { A: 9, B: 6, layersA: 9, layersB: 6 });
      const sale = await Sale.findById(body.id).lean<{
        inventoryDeductions: Array<{ productId: unknown }>;
      }>();
      assert.deepEqual(sale!.inventoryDeductions.map((d) => String(d.productId)), [idA]);
    });

    await test("two sales without an idempotency key both succeed (no null-key collision)", async () => {
      const keyless = () =>
        fetch(`${BASE}/api/sales`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({
            customerPhone: PHONE,
            payment: "cash",
            lines: [{ productId: idA, qty: 1, lineType: "ready" }],
          }),
        });
      const first = await keyless();
      const second = await keyless();
      assert.equal(first.status, 201, await first.text());
      assert.equal(second.status, 201, await second.text());
      assert.deepEqual(await stockOf(), { A: 7, B: 6, layersA: 7, layersB: 6 });
      assert.equal(
        await Sale.countDocuments({ customerPhone: PHONE, idempotencyKey: { $exists: true, $eq: null } }),
        0,
        "no sale stores idempotencyKey: null",
      );
    });

    await test("name-only line (no productId) is rejected — never resolved by name", async () => {
      const before = { stock: await stockOf(), sales: await salesCount() };
      const { status, body } = await sell([{ name: "Blue Ocean", qty: 1, lineType: "ready", unitPrice: 5000 }]);
      assert.equal(status, 400);
      assert.equal(body.code, "INVALID_LINE");
      assert.deepEqual({ stock: await stockOf(), sales: await salesCount() }, before);
    });

    await test("unknown productId with a matching name is rejected (no fallback to name)", async () => {
      const before = { stock: await stockOf(), sales: await salesCount() };
      const { status, body } = await sell([
        { productId: String(new mongoose.Types.ObjectId()), name: "Blue Ocean", qty: 1, lineType: "ready" },
      ]);
      assert.equal(status, 400);
      assert.equal(body.code, "PRODUCT_NOT_FOUND");
      assert.deepEqual({ stock: await stockOf(), sales: await salesCount() }, before);
    });

    await test("oil ¼ tola deducts exactly 3 ml; client deductMl/price ignored", async () => {
      const before = await oilMl();
      const { status, body } = await sell([
        { productId: idOil, qty: 1, lineType: "oil", unitLabel: "¼ Tola", deductMl: 12, unitPrice: 0.001 },
      ]);
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.total, 0.75);
      assert.equal(before - (await oilMl()), 3);
    });

    await test("oil with a non-approved size label is rejected (7 ml, 1½ Tola, 2 Tola)", async () => {
      for (const unitLabel of ["7 ml", "0.01 ml", "1½ Tola", "2 Tola"]) {
        const before = { ml: await oilMl(), sales: await salesCount() };
        const { status, body } = await sell([{ productId: idOil, qty: 1, lineType: "oil", unitLabel }]);
        assert.equal(status, 400, `${unitLabel}: ${JSON.stringify(body)}`);
        assert.equal(body.code, "INVALID_LINE");
        assert.deepEqual({ ml: await oilMl(), sales: await salesCount() }, before, unitLabel);
      }
    });

    await test("fractional quantities are rejected (ready, oil, held bill)", async () => {
      const before = { stock: await stockOf(), ml: await oilMl(), sales: await salesCount() };
      const cases = [
        [{ productId: idA, qty: 0.5, lineType: "ready" }],
        [{ productId: idOil, qty: 0.1, lineType: "oil", unitLabel: "¼ Tola" }],
      ];
      for (const lines of cases) {
        const { status, body } = await sell(lines);
        assert.equal(status, 400, JSON.stringify(body));
        assert.equal(body.code, "INVALID_LINE");
      }
      const held = await fetch(`${BASE}/api/sales`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          customerPhone: PHONE,
          payment: "cash",
          status: "held",
          lines: [{ productId: idA, qty: 1.5, lineType: "ready", unitPrice: 5000 }],
        }),
      });
      assert.equal(held.status, 400, await held.text());
      assert.deepEqual(
        { stock: await stockOf(), ml: await oilMl(), sales: await salesCount() },
        before,
      );
    });

    await test("over-stock on B is rejected without touching A (stock checked per product id)", async () => {
      const before = { stock: await stockOf(), sales: await salesCount() };
      const { status, body } = await sell([
        { productId: idA, qty: 1, lineType: "ready" },
        { productId: idB, qty: 7, lineType: "ready" }, // B has 6
      ]);
      assert.equal(status, 400);
      assert.equal(body.code, "INSUFFICIENT_STOCK");
      assert.deepEqual({ stock: await stockOf(), sales: await salesCount() }, before);
    });

    const overLimitPct = DISCOUNT_LIMIT_PCT.cashier + 20; // 30% with the default 10% cap

    await test("POS-068/069/070/073: item + bill discount → net total stored, profit uses it", async () => {
      const stockBefore = (await stockOf()).A;
      const { status, body } = await sell(
        [{ productId: idA, qty: 1, lineType: "ready", discount: { type: "percent", value: 5 } }],
        { invoiceDiscount: { type: "percent", value: 2 } },
      );
      assert.equal(status, 201, JSON.stringify(body));
      // 5000 − 5% (250) = 4750 → − 2% bill (95) = 4655
      assert.equal(body.total, 4655);
      assert.equal(stockBefore - (await stockOf()).A, 1);
      const sale = await Sale.findById(body.id).lean<{
        subtotal: number;
        total: number;
        discountTotal: number;
        invoiceDiscountAmount: number;
        lines: Array<{ discountType: string; discountValue: number; discountAmount: number }>;
        inventoryDeductions: Array<{ costTotal: number }>;
        discountApprovedBy?: unknown;
      }>();
      assert.ok(sale);
      assert.equal(sale.subtotal, 5000);
      assert.deepEqual(
        [sale.lines[0].discountType, sale.lines[0].discountValue, sale.lines[0].discountAmount],
        ["percent", 5, 250],
      );
      assert.equal(sale.invoiceDiscountAmount, 95);
      assert.equal(sale.discountTotal, 345);
      assert.equal(sale.discountApprovedBy, undefined, "within limit → no approver");
      // RPT-04 profit = total − FIFO cost (unit cost 1) — discount reduces it.
      const cost = sale.inventoryDeductions.reduce((s, d) => s + d.costTotal, 0);
      assert.equal(sale.total - cost, 4654);
    });

    await test("POS-071: cashier over-limit discount without approval → 403, nothing written", async () => {
      const before = { stock: await stockOf(), sales: await salesCount() };
      const { status, body } = await sell([
        { productId: idA, qty: 1, lineType: "ready", discount: { type: "percent", value: overLimitPct } },
      ]);
      assert.equal(status, 403, JSON.stringify(body));
      assert.equal(body.code, "DISCOUNT_APPROVAL_REQUIRED");
      // Bill-level discount is held to the same limit.
      const bill = await sell([{ productId: idA, qty: 1, lineType: "ready" }], {
        invoiceDiscount: { type: "percent", value: overLimitPct },
      });
      assert.equal(bill.status, 403);
      assert.equal(bill.body.code, "DISCOUNT_APPROVAL_REQUIRED");
      assert.deepEqual({ stock: await stockOf(), sales: await salesCount() }, before);
    });

    // POS-071/072: credentials go to the approval endpoint only; checkout carries
    // a single-use token bound to this cashier + cart.
    const overLine = [
      { productId: idA, qty: 1, lineType: "ready", discount: { type: "percent", value: overLimitPct } },
    ];
    const approve = async (
      lines: Array<Record<string, unknown>>,
      creds: { email: string; password: string },
      extra: Record<string, unknown> = {},
      asCookie = cookie,
    ) => {
      const res = await fetch(`${BASE}/api/sales/discount-approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: asCookie },
        body: JSON.stringify({ lines, ...creds, ...extra }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    await test("POS-072: unauthorized approver (cashier / wrong password / unknown) → no token", async () => {
      const before = { stock: await stockOf(), sales: await salesCount() };
      for (const creds of [
        { email: cashierEmail, password: approverPassword }, // valid login, role too low
        { email: ownerEmail, password: "wrong-password" },
        { email: `nobody-${tag}@test.local`, password: approverPassword },
      ]) {
        const { status, body } = await approve(overLine, creds);
        assert.equal(status, 403, `${creds.email}: ${JSON.stringify(body)}`);
        assert.equal(body.code, "DISCOUNT_NOT_AUTHORIZED");
        assert.equal(body.approvalToken, undefined);
      }
      assert.deepEqual({ stock: await stockOf(), sales: await salesCount() }, before);
    });

    await test("POS-072: manager password sent straight to checkout is ignored (token required)", async () => {
      const { status, body } = await sell(overLine, {
        discountApproval: { email: ownerEmail, password: approverPassword },
        approved: true,
      });
      assert.equal(status, 403, JSON.stringify(body));
      assert.equal(body.code, "DISCOUNT_APPROVAL_REQUIRED");
    });

    await test("POS-071: owner approves → token → sale saved with approver + applied-by user", async () => {
      const ok = await approve(overLine, { email: ownerEmail, password: approverPassword });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(typeof ok.body.approvalToken, "string");
      const { status, body } = await sell(overLine, { discountApprovalToken: ok.body.approvalToken });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.total, 5000 * (1 - overLimitPct / 100));
      const sale = await Sale.findById(body.id).lean<{
        discountApprovedBy: { name: string; role: string; userId: unknown };
        discountAppliedBy: { name: string; role: string; userId: unknown };
      }>();
      assert.equal(sale!.discountApprovedBy.name, "E2E Owner");
      assert.equal(sale!.discountApprovedBy.role, "owner");
      assert.equal(String(sale!.discountApprovedBy.userId), String(approvers[0]._id));
      assert.deepEqual(
        [String(sale!.discountAppliedBy.userId), sale!.discountAppliedBy.role],
        ["000000000000000000000021", "cashier"],
      );
    });

    await test("POS-072: approval token is single-use — replay with a new key is rejected, same key dedupes", async () => {
      const ok = await approve(overLine, { email: ownerEmail, password: approverPassword });
      const key = randomUUID();
      const first = await sell(overLine, { discountApprovalToken: ok.body.approvalToken, idempotencyKey: key });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const before = { stock: await stockOf(), sales: await salesCount() };
      const sameKey = await sell(overLine, { discountApprovalToken: ok.body.approvalToken, idempotencyKey: key });
      assert.equal(sameKey.status, 200, JSON.stringify(sameKey.body));
      assert.equal(sameKey.body.id, first.body.id);
      const replay = await sell(overLine, { discountApprovalToken: ok.body.approvalToken });
      assert.equal(replay.status, 403, JSON.stringify(replay.body));
      assert.equal(replay.body.code, "DISCOUNT_NOT_AUTHORIZED");
      assert.deepEqual({ stock: await stockOf(), sales: await salesCount() }, before);
    });

    await test("POS-072: token can't be used for a different cart, another user, or after expiry", async () => {
      const before = { stock: await stockOf(), sales: await salesCount() };
      const ok = await approve(overLine, { email: ownerEmail, password: approverPassword });
      const token = ok.body.approvalToken;
      // Bigger discount than approved
      const bigger = await sell(
        [{ productId: idA, qty: 1, lineType: "ready", discount: { type: "percent", value: overLimitPct + 10 } }],
        { discountApprovalToken: token },
      );
      assert.equal(bigger.status, 403, JSON.stringify(bigger.body));
      // Different qty
      const qty = await sell([{ ...overLine[0], qty: 2 }], { discountApprovalToken: token });
      assert.equal(qty.status, 403, JSON.stringify(qty.body));
      // Another cashier presenting the token
      const otherCookie = (await testSessionCookie({
        userId: "000000000000000000000022",
        name: "E2E Cashier 2",
        email: "e2e-cashier2@test.local",
        role: "cashier",
        roleLabel: "Cashier",
        branchId: null,
        branchName: null,
      }));
      const other = await fetch(`${BASE}/api/sales`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: otherCookie },
        body: JSON.stringify({ customerPhone: PHONE, payment: "cash", lines: overLine, discountApprovalToken: token }),
      });
      assert.equal(other.status, 403, await other.text());
      // Expired
      await DiscountApproval.updateOne({ token }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const expired = await sell(overLine, { discountApprovalToken: token });
      assert.equal(expired.status, 403, JSON.stringify(expired.body));
      assert.deepEqual({ stock: await stockOf(), sales: await salesCount() }, before);
    });

    await test("RPT: branch sale stores ObjectId branchId; branch-scoped + by-product reports are net of discount", async () => {
      const branchId = String(new mongoose.Types.ObjectId());
      const branchCookie = (await testSessionCookie({
        userId: "000000000000000000000023",
        name: "E2E Branch Cashier",
        email: "e2e-branch@test.local",
        role: "cashier",
        roleLabel: "Cashier",
        branchId,
        branchName: "E2E Branch",
      }));
      const res = await fetch(`${BASE}/api/sales`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: branchCookie },
        body: JSON.stringify({
          customerPhone: PHONE,
          payment: "cash",
          lines: [
            { productId: idA, qty: 1, lineType: "ready", discount: { type: "percent", value: 10 } },
            { productId: idB, qty: 1, lineType: "ready" },
          ],
          invoiceDiscount: { type: "amount", value: 100 },
        }),
      });
      const body = (await res.json()) as SaleResponse;
      assert.equal(res.status, 201, JSON.stringify(body));
      // 5000 − 500 = 4500, + 6000 = 10500, − 100 = 10400
      assert.equal(body.total, 10400);
      const raw = await Sale.collection.findOne({ _id: new mongoose.Types.ObjectId(body.id) });
      assert.ok(raw!.branchId instanceof mongoose.Types.ObjectId, `branchId type ${typeof raw!.branchId}`);
      const ownerCookie = (await testSessionCookie({
        userId: String(approvers[0]._id),
        name: "E2E Owner",
        email: ownerEmail,
        role: "owner",
        roleLabel: "Owner",
        branchId: null,
        branchName: null,
      }));
      const d = new Date();
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const report = async (id: string) =>
        (await (
          await fetch(`${BASE}/api/reports/engine/${id}?from=${day}&to=${day}&branchId=${branchId}`, {
            headers: { Cookie: ownerCookie },
          })
        ).json()) as { totals: { revenue: number }; rows: Array<{ product: string; revenue: number }> };
      const profit = await report("profit-margin-daily");
      assert.equal(profit.totals.revenue, 10400, "branch profit report");
      const byProduct = await report("sales-by-product");
      assert.equal(byProduct.totals.revenue, 10400, "sales-by-product total = net sales");
      // Bill discount 100 split pro rata over 4500 / 6000.
      const rev = Object.fromEntries(byProduct.rows.map((r) => [r.product, r.revenue]));
      assert.deepEqual(rev, { "Blue Ocean": 10400 }, "both products share the name 'Blue Ocean'");
    });

    await test("mixed payment split must add up to the DISCOUNTED total; credit part goes to balance", async () => {
      const lines = [{ productId: idA, qty: 1, lineType: "ready", discount: { type: "percent", value: 10 } }];
      // 5000 − 10% = 4500
      const before = { stock: await stockOf(), sales: await salesCount() };
      const gross = await sell(lines, {
        payment: "mixed",
        paymentBreakdown: [{ method: "cash", amount: 3000 }, { method: "credit", amount: 2000 }],
      });
      assert.equal(gross.status, 400, "split of the pre-discount 5000 is rejected");
      assert.deepEqual({ stock: await stockOf(), sales: await salesCount() }, before);
      const credit0 = (await Customer.findOne({ phone: PHONE }).lean<{ creditBalance?: number }>())?.creditBalance ?? 0;
      const ok = await sell(lines, {
        payment: "mixed",
        paymentBreakdown: [{ method: "cash", amount: 3000 }, { method: "credit", amount: 1500 }],
      });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.total, 4500);
      const sale = await Sale.findById(ok.body.id).lean<{ paymentBreakdown: { method: string; amount: number }[] }>();
      assert.deepEqual(
        sale!.paymentBreakdown.map((p) => [p.method, p.amount]),
        [["cash", 3000], ["credit", 1500]],
      );
      const credit1 = (await Customer.findOne({ phone: PHONE }).lean<{ creditBalance?: number }>())!.creditBalance ?? 0;
      assert.equal(credit1 - credit0, 1500, "only the credit part is added to the balance");
    });

    await test("POS-075: negative / >100% / over-amount / non-numeric discounts → 400", async () => {
      const before = { stock: await stockOf(), sales: await salesCount() };
      const bad: Array<[Record<string, unknown>, Record<string, unknown>]> = [
        [{ discount: { type: "percent", value: -10 } }, {}],
        [{ discount: { type: "percent", value: 150 } }, {}],
        [{ discount: { type: "amount", value: 5001 } }, {}],
        [{ discount: { type: "amount", value: "abc" } }, {}],
        [{}, { invoiceDiscount: { type: "amount", value: -1 } }],
      ];
      for (const [lineExtra, extra] of bad) {
        const { status, body } = await sell(
          [{ productId: idA, qty: 1, lineType: "ready", ...lineExtra }],
          extra,
        );
        assert.equal(status, 400, JSON.stringify({ lineExtra, extra, body }));
        assert.equal(body.code, "INVALID_DISCOUNT");
      }
      assert.deepEqual({ stock: await stockOf(), sales: await salesCount() }, before);
    });

    await test("held bill keeps its discounts for resume (approval deferred to checkout)", async () => {
      const res = await fetch(`${BASE}/api/sales`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          customerPhone: PHONE,
          payment: "cash",
          status: "held",
          lines: [
            { productId: idA, qty: 1, lineType: "ready", unitPrice: 5000, discount: { type: "amount", value: 100 } },
          ],
          invoiceDiscount: { type: "percent", value: 1 },
        }),
      });
      const body = (await res.json()) as SaleResponse & {
        invoiceDiscountType: string;
        invoiceDiscountValue: number;
        lines: Array<{ discountType: string; discountValue: number }>;
      };
      assert.equal(res.status, 201, JSON.stringify(body));
      assert.equal(body.total, 4851); // (5000 − 100) − 1%
      assert.deepEqual([body.lines[0].discountType, body.lines[0].discountValue], ["amount", 100]);
      assert.deepEqual([body.invoiceDiscountType, body.invoiceDiscountValue], ["percent", 1]);
    });

    // POS-097..103 hold / resume. Own product so stock maths is independent.
    const holdProduct = await Product.create({
      sku: `HOLD-E2E-${tag}`,
      name: "E2E Hold Item",
      category: "Perfume",
      unit: "pcs",
      sellPrice: 100,
      stockSellable: 20,
    });
    await FifoLayer.create({
      productId: holdProduct._id,
      supplierId,
      supplierName: "E2E Hold Supplier",
      purchaseDate: new Date(),
      qtyRemaining: 20,
      unitCost: 40,
      currency: "OMR",
    });
    const idH = String(holdProduct._id);
    const holdStock = async () =>
      (await Product.findById(idH).lean<{ stockSellable: number }>())!.stockSellable;
    const sessionFor = async (userId: string, branchId: string | null) =>
      (await testSessionCookie({
        userId,
        name: "E2E Till",
        email: `e2e-till-${userId}@test.local`,
        role: "cashier",
        roleLabel: "Cashier",
        branchId,
        branchName: branchId ? "E2E Branch" : null,
      }));
    const call = async (method: string, path: string, body?: unknown, asCookie = cookie) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Cookie: asCookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as SaleResponse & Record<string, unknown> };
    };
    const holdBill = (lines: unknown[], extra: Record<string, unknown> = {}, asCookie = cookie) =>
      call("POST", "/api/sales", { customerPhone: PHONE, payment: "cash", status: "held", lines, ...extra }, asCookie);

    try {
      await test("POS-097: hold prices on the server, rejects unknown products, takes no stock", async () => {
        const before = await holdStock();
        const held = await holdBill([{ productId: idH, qty: 2, lineType: "ready", unitPrice: 0.001 }]);
        assert.equal(held.status, 201, JSON.stringify(held.body));
        assert.equal(held.body.total, 200, "client unitPrice must not be stored");
        assert.equal(await holdStock(), before);
        const ghost = await holdBill([
          { productId: String(new mongoose.Types.ObjectId()), qty: 1, lineType: "ready", unitPrice: 5 },
        ]);
        assert.equal(ghost.status, 400);
      });

      await test("POS-098/§18: two tills complete one resumed bill at once → exactly one sale, linked", async () => {
        const held = await holdBill([{ productId: idH, qty: 1, lineType: "ready" }]);
        const before = await holdStock();
        const [a, b] = await Promise.all(
          [cookie, await sessionFor("000000000000000000000022", null)].map((c) =>
            call(
              "POST",
              "/api/sales",
              {
                customerPhone: PHONE,
                payment: "cash",
                lines: [{ productId: idH, qty: 1, lineType: "ready" }],
                resumedFromId: held.body.id,
                idempotencyKey: randomUUID(),
              },
              c,
            ),
          ),
        );
        const statuses = [a.status, b.status].sort();
        assert.deepEqual(statuses, [201, 409], JSON.stringify([a.body, b.body]));
        const sale = [a, b].find((r) => r.status === 201)!.body;
        const heldDoc = await Sale.findById(held.body.id).lean<{ status: string; completedSaleId?: unknown }>();
        assert.equal(heldDoc!.status, "void");
        assert.equal(String(heldDoc!.completedSaleId), String(sale.id));
        assert.equal(String(sale.resumedFromId), String(held.body.id));
        assert.equal(before - (await holdStock()), 1, "stock deducted once");
      });

      await test("POS-103/§11: failed checkout leaves the bill held; re-hold updates it in place", async () => {
        const held = await holdBill([{ productId: idH, qty: 50, lineType: "ready" }]);
        const failed = await call("POST", "/api/sales", {
          customerPhone: PHONE,
          payment: "cash",
          lines: [{ productId: idH, qty: 50, lineType: "ready" }],
          resumedFromId: held.body.id,
          idempotencyKey: randomUUID(),
        });
        assert.equal(failed.status, 400);
        assert.equal(failed.body.code, "INSUFFICIENT_STOCK");
        assert.equal((await Sale.findById(held.body.id).lean<{ status: string }>())!.status, "held");
        const reheld = await holdBill([{ productId: idH, qty: 3, lineType: "ready" }], { resumedFromId: held.body.id });
        assert.equal(reheld.status, 201);
        assert.equal(reheld.body.id, held.body.id, "same bill, not a copy");
        const doc = await Sale.findById(held.body.id).lean<{ status: string; lines: { qty: number }[] }>();
        assert.deepEqual([doc!.status, doc!.lines[0].qty], ["held", 3]);
      });

      await test("POS-101/§18: discard is atomic — two discards at once, exactly one succeeds", async () => {
        const held = await holdBill([{ productId: idH, qty: 1, lineType: "ready" }]);
        const rs = await Promise.all([1, 2].map(() => call("PATCH", `/api/sales/${held.body.id}`, { status: "void" })));
        // The loser sees 409 (raced) or 400 (already void by the time it read).
        assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
        assert.ok(rs.every((r) => [200, 400, 409].includes(r.status)));
      });

      await test("§14: another branch can't read, discard or complete a held bill", async () => {
        const branch1 = await sessionFor("000000000000000000000023", String(new mongoose.Types.ObjectId()));
        const branch2 = await sessionFor("000000000000000000000024", String(new mongoose.Types.ObjectId()));
        const held = await holdBill([{ productId: idH, qty: 1, lineType: "ready" }], {}, branch1);
        assert.equal(held.status, 201);
        assert.equal((await call("GET", `/api/sales/${held.body.id}`, undefined, branch2)).status, 403);
        assert.equal((await call("PATCH", `/api/sales/${held.body.id}`, { status: "void" }, branch2)).status, 403);
        const steal = await call(
          "POST",
          "/api/sales",
          {
            customerPhone: PHONE,
            payment: "cash",
            lines: [{ productId: idH, qty: 1, lineType: "ready" }],
            resumedFromId: held.body.id,
            idempotencyKey: randomUUID(),
          },
          branch2,
        );
        assert.equal(steal.status, 409);
        assert.equal((await call("GET", `/api/sales/${held.body.id}`, undefined, branch1)).status, 200);
      });

      await test("§14: another customer's id is ignored — no rename, no credit on their account", async () => {
        const victim = await Customer.create({ phone: `+968 9${String(tag).slice(-7)}`, name: "E2E Victim" });
        try {
          const r = await call("POST", "/api/sales", {
            customerPhone: PHONE,
            customerName: "Not The Victim",
            customerId: String(victim._id),
            payment: "credit",
            lines: [{ productId: idH, qty: 1, lineType: "ready" }],
            idempotencyKey: randomUUID(),
          });
          assert.equal(r.status, 201, JSON.stringify(r.body));
          const after = await Customer.findById(victim._id).lean<{ name: string; creditBalance?: number }>();
          assert.equal(after!.name, "E2E Victim");
          assert.ok(!(after!.creditBalance! > 0), `credit ${after!.creditBalance}`);
          const sale = await Sale.findById(r.body.id).lean<{ customerId: unknown }>();
          assert.notEqual(String(sale!.customerId), String(victim._id));
        } finally {
          await Customer.deleteOne({ _id: victim._id });
        }
      });
    } finally {
      await FifoLayer.deleteMany({ productId: holdProduct._id });
      await Product.deleteOne({ _id: holdProduct._id });
    }
  } finally {
    await DiscountApproval.deleteMany({ approverUserId: { $in: approvers.map((u: { _id: unknown }) => String(u._id)) } });
    await User.deleteMany({ _id: { $in: approvers.map((u: { _id: unknown }) => u._id) } });
    await RateLimit.deleteMany({
      key: { $in: [ownerEmail, cashierEmail, `nobody-${tag}@test.local`].map((e) => `email:${e}`) },
    });
    await Sale.deleteMany({ customerPhone: PHONE });
    await Customer.deleteMany({ phone: PHONE });
    await FifoLayer.deleteMany({ productId: { $in: [productA._id, productB._id, oil._id] } });
    await Product.deleteMany({ _id: { $in: [productA._id, productB._id, oil._id] } });
    if (!hadSettings) await AppSettings.deleteOne({ key: "default" });
    await stopServer(server);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
