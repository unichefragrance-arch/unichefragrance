/**
 * API-level E2E tests for the purchases flow (npm run test:e2e).
 *
 * Boots a real `next dev` server and drives it over HTTP (POST/GET
 * /api/purchases) against the DB configured in DATABASE_URL, verifying the
 * full route → applyFifoFromPurchase → FifoLayer/Product → supplier
 * avg-lead-days chain end to end. Auth is a real signed session cookie
 * minted locally with the app's own SESSION_SECRET (no login endpoint
 * needed). All fixtures this script creates are deleted in a `finally`
 * block, and the child server process is always killed on exit.
 *
 * Requires: DATABASE_URL + SESSION_SECRET in the environment (loaded via
 * `tsx --env-file=.env`). This writes and deletes real documents, so it
 * refuses to run unless DATABASE_URL points at localhost (see e2eGuard);
 * set E2E_ALLOW_REMOTE_DB=1 only for a dedicated dev/staging DB.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { connectDB } from "../db";
import { Product, Supplier, PurchaseOrder, FifoLayer } from "../models";
import { createSessionToken } from "../auth/session";
import { assertLocalDb } from "../e2eGuard";

const PORT = Number(process.env.E2E_PORT || 3911);
const BASE = `http://localhost:${PORT}`;

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

async function waitForServer(timeoutMs = 60_000) {
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

async function main() {
  assertLocalDb();
  await connectDB();

  const supplier = await Supplier.create({
    name: "E2E Test Supplier",
    phone: "0000000000",
    currency: "OMR",
  });
  const product = await Product.create({
    sku: `E2E-${Date.now()}`,
    name: "E2E Test Product",
    category: "Test",
    unit: "pcs",
    stockSellable: 0,
  });

  const token = createSessionToken({
    userId: "000000000000000000000000",
    name: "E2E Test Runner",
    email: "e2e-runner@test.local",
    role: "owner",
    roleLabel: "Owner",
    branchId: null,
    branchName: null,
  });
  const cookie = `unich_session=${token}`;

  const server = startServer();
  let createdPurchaseId: string | null = null;

  // Ordered 3 days before "now" so avgLeadDays lands on a distinguishable
  // non-zero value (default Supplier.avgLeadDays is also 0).
  const orderedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  try {
    await waitForServer();

    await test("POST /api/purchases (received) → 201, FIFO applied, stock updated", async () => {
      const res = await fetch(`${BASE}/api/purchases`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          supplierId: String(supplier._id),
          supplierName: supplier.name,
          currency: "OMR",
          date: orderedAt.toISOString(),
          status: "received",
          lines: [
            {
              productId: String(product._id),
              productName: product.name,
              qtyOrdered: 20,
              qtyReceived: 20,
              unitCost: 3,
            },
          ],
        }),
      });
      const rawBody = await res.text();
      assert.equal(res.status, 201, `expected 201, got ${res.status}: ${rawBody}`);
      const body = JSON.parse(rawBody);
      createdPurchaseId = body.id;
      assert.ok(createdPurchaseId, "response must include an id");
      assert.equal(body.status, "received");
      assert.equal(body.lines[0].qtyFifoApplied, 20);

      const layer = await FifoLayer.findOne({ productId: product._id }).lean();
      assert.ok(layer, "FifoLayer must be created for the received line");
      assert.equal(layer!.qtyRemaining, 20);
      assert.equal(layer!.unitCost, 3);
      assert.equal(layer!.supplierId.toString(), String(supplier._id));

      const refreshedProduct = await Product.findById(product._id).lean();
      assert.equal(refreshedProduct!.stockSellable, 20);
    });

    await test("supplier avgLeadDays recalculated from order→receipt gap", async () => {
      // recalcSupplierAvgLeadDays is fired-and-forgotten by the route, so poll.
      let avgLeadDays: number | undefined;
      for (let i = 0; i < 20; i++) {
        const s = await Supplier.findById(supplier._id).lean();
        avgLeadDays = s?.avgLeadDays;
        if (avgLeadDays && avgLeadDays > 0) break;
        await sleep(300);
      }
      assert.equal(avgLeadDays, 3);
    });

    await test("GET /api/purchases includes the created purchase", async () => {
      const res = await fetch(`${BASE}/api/purchases`, {
        headers: { Cookie: cookie },
      });
      assert.equal(res.status, 200);
      const list = (await res.json()) as Array<{ id: string }>;
      assert.ok(
        list.some((p) => p.id === createdPurchaseId),
        "created purchase must appear in the list",
      );
    });

    await test("POST /api/purchases without session cookie → 401", async () => {
      const res = await fetch(`${BASE}/api/purchases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: String(supplier._id), lines: [] }),
      });
      assert.equal(res.status, 401);
    });
  } finally {
    if (createdPurchaseId) {
      await PurchaseOrder.deleteOne({ _id: createdPurchaseId });
    }
    await FifoLayer.deleteMany({ productId: product._id });
    await Product.deleteOne({ _id: product._id });
    await Supplier.deleteOne({ _id: supplier._id });
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
