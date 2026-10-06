/**
 * Unit tests (npm test) for the POS hardening fixes — no database:
 * request shape, payment, idempotency scope/fingerprint, checkout recovery,
 * safe API errors, remix selected-oil rule, and the destructive-script guards
 * (spawned against FAKE remote targets from a scratch dir, never the real .env).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { isDbUnavailable, safeErrorMessage } from "../auth/apiGuard";
import { isLocalDbUrl } from "../e2eGuard";
import { describeDbTarget } from "../../../scripts/lib/dbSafety";
import { checkoutFailureMessage, classifyCheckoutError, keepCheckoutKey } from "./checkoutRecovery";
import { checkoutFingerprint, normalizePayment, normalizePaymentBreakdown, scopedIdempotencyKey } from "./createSale";
import { SaleError } from "./errors";
import { parseCheckoutBody } from "./requestShape";
import { validateRemixSale } from "./validateSale";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
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
const isCode = (code: string) => (e: unknown) => e instanceof SaleError && e.code === code;
const LINE = { productId: String(new mongoose.Types.ObjectId()), qty: 1, lineType: "ready" };
const GOOD = { customerPhone: "+968 9000 0000", payment: "cash", lines: [LINE] };

(async () => {
  console.log("POS hardening (unit)");

  // ---- request shape / status (POS-142b, POS-163) ----
  for (const [label, body] of [
    ["null body", null], ["array body", []], ["string body", "x"], ["number body", 5],
    ["no lines", { ...GOOD, lines: undefined }], ["lines object", { ...GOOD, lines: {} }], ["lines []", { ...GOOD, lines: [] }],
    ["lines [null]", { ...GOOD, lines: [null] }], ["lines [[1]]", { ...GOOD, lines: [[1]] }],
    ["phone number", { ...GOOD, customerPhone: 1234567 }], ["phone object", { ...GOOD, customerPhone: {} }], ["phone blank", { ...GOOD, customerPhone: "  " }],
    ["customerName number", { ...GOOD, customerName: 42 }], ["customerId garbage", { ...GOOD, customerId: "garbage" }], ["customerId object", { ...GOOD, customerId: { $ne: null } }],
    ["salesperson object", { ...GOOD, salesperson: { $ne: null } }], ["resumedFromId bad", { ...GOOD, resumedFromId: "abc" }],
    ["idempotencyKey number", { ...GOOD, idempotencyKey: 123 }], ["idempotencyKey object", { ...GOOD, idempotencyKey: { $gt: "" } }], ["idempotencyKey 201 chars", { ...GOOD, idempotencyKey: "k".repeat(201) }],
    ["paymentBreakdown string", { ...GOOD, paymentBreakdown: "x" }], ["approval token number", { ...GOOD, discountApprovalToken: 1 }],
    ...["void", "VOID", "cancelled", "refunded-hack", "", null, 5, true, {}, { $ne: null }, ["void"], " completed", "Completed"].map((st) => [`status ${JSON.stringify(st)}`, { ...GOOD, status: st }]),
  ] as [string, unknown][]) {
    await test(`shape rejects ${label} (400 VALIDATION)`, () => assert.throws(() => parseCheckoutBody(body, null), isCode("VALIDATION")));
  }
  await test("shape accepts no status / completed / held; null optionals; ignores unknown fields", () => {
    for (const st of [undefined, "completed", "held"]) assert.equal(parseCheckoutBody({ ...GOOD, status: st }, null).status, st);
    const r = parseCheckoutBody({ ...GOOD, customerName: null, customerId: null, extra: { a: 1 }, total: 0 }, null);
    assert.equal(r.customerName, undefined);
    assert.equal((r as Record<string, unknown>).total, undefined);
  });
  await test("shape: body key wins over header; header used when body has none; header type-checked length", () => {
    assert.equal(parseCheckoutBody({ ...GOOD, idempotencyKey: " a " }, "b").idempotencyKey, "a");
    assert.equal(parseCheckoutBody(GOOD, "b").idempotencyKey, "b");
    assert.throws(() => parseCheckoutBody(GOOD, "h".repeat(201)), isCode("VALIDATION"));
  });

  // ---- payment (POS-160) ----
  await test("payment: cash/card/bank/credit/mixed accepted (case-insensitive); absent = cash", () => {
    for (const m of ["cash", "card", "bank", "credit", "mixed", "CARD", "Bank"]) assert.equal(normalizePayment(m), m.toLowerCase());
    assert.equal(normalizePayment(undefined), "cash");
  });
  for (const bad of ["bitcoin", "", " ", " card", "card ", "bank transfer", null, 5, {}, ["card"], { $ne: null }, true]) {
    await test(`payment ${JSON.stringify(bad)} rejected — never becomes cash`, () => assert.throws(() => normalizePayment(bad), isCode("VALIDATION")));
  }
  await test("mixed breakdown: null entry / bad method / string or negative amount / unbalanced rejected; balanced ok", () => {
    for (const b of [[null], [{ method: 5, amount: 10 }], [{ method: "crypto", amount: 10 }], [{ method: "cash", amount: "10" }], [{ method: "cash", amount: -1 }, { method: "card", amount: 11 }], [{ method: "cash", amount: 4 }]]) {
      assert.throws(() => normalizePaymentBreakdown("mixed", b, 10, true), isCode("VALIDATION"), JSON.stringify(b));
    }
    assert.deepEqual(normalizePaymentBreakdown("mixed", [{ method: "cash", amount: 4 }, { method: "Card", amount: 6 }], 10, true), [{ method: "cash", amount: 4 }, { method: "card", amount: 6 }]);
  });

  // ---- idempotency scope + fingerprint (POS-146b, POS-154) ----
  await test("idempotency key is scoped per user and per branch", () => {
    const a = scopedIdempotencyKey("K", "u1", "b1");
    assert.notEqual(a, scopedIdempotencyKey("K", "u2", "b1"));
    assert.notEqual(a, scopedIdempotencyKey("K", "u1", "b2"));
    assert.equal(a, scopedIdempotencyKey("K", "u1", "b1"));
    assert.equal(scopedIdempotencyKey(undefined, "u1", "b1"), undefined);
  });
  const base = {
    customerPhone: "+968 1", salesperson: "Sara", payment: "mixed",
    paymentBreakdown: [{ method: "cash", amount: 5 }, { method: "card", amount: 15 }],
    lines: [{ productId: new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"), qty: 2, lineType: "ready", unitLabel: "pcs", packagingProductIds: [] }],
  };
  await test("fingerprint: same bill (ObjectId vs string ids, split order) → equal", () => {
    const stored = { ...base, paymentBreakdown: [...base.paymentBreakdown].reverse(), lines: [{ ...base.lines[0], productId: "aaaaaaaaaaaaaaaaaaaaaaaa" }] };
    assert.equal(checkoutFingerprint(base), checkoutFingerprint(stored));
  });
  for (const [label, change] of [
    ["qty", { lines: [{ ...base.lines[0], qty: 3 }] }], ["extra line", { lines: [...base.lines, { ...base.lines[0], productId: "bbbbbbbbbbbbbbbbbbbbbbbb" }] }],
    ["payment", { payment: "cash", paymentBreakdown: [] }], ["split", { paymentBreakdown: [{ method: "cash", amount: 10 }, { method: "card", amount: 10 }] }],
    ["phone", { customerPhone: "+968 2" }], ["salesperson", { salesperson: "Ali" }], ["line discount", { lines: [{ ...base.lines[0], discountType: "percent", discountValue: 5 }] }],
    ["invoice discount", { invoiceDiscountType: "amount", invoiceDiscountValue: 1 }], ["held bill", { resumedFromId: "cccccccccccccccccccccccc" }],
  ] as [string, object][]) {
    await test(`fingerprint: changed ${label} → different`, () => assert.notEqual(checkoutFingerprint(base), checkoutFingerprint({ ...base, ...change })));
  }

  // ---- checkout recovery (POS-154, POS-166) ----
  await test("recovery: network error online → unknown (key kept); offline → offline (key kept)", () => {
    assert.equal(classifyCheckoutError(new TypeError("Failed to fetch"), true), "unknown");
    assert.equal(classifyCheckoutError(new TypeError("Failed to fetch"), false), "offline");
    assert.equal(classifyCheckoutError(Object.assign(new Error("x"), { name: "AbortError" }), true), "unknown");
    assert.ok(keepCheckoutKey("unknown") && keepCheckoutKey("offline") && keepCheckoutKey("rejected"));
  });
  await test("recovery: 5xx/503 → unknown; 409 IDEMPOTENCY_CONFLICT → conflict (new key); 4xx → rejected", () => {
    assert.equal(classifyCheckoutError({ status: 503, data: {} }, true), "unknown");
    assert.equal(classifyCheckoutError({ status: 500, data: {} }, true), "unknown");
    assert.equal(classifyCheckoutError({ status: 409, data: { code: "IDEMPOTENCY_CONFLICT" } }, true), "conflict");
    assert.equal(classifyCheckoutError({ status: 409, data: { code: "HELD_BILL_UNAVAILABLE" } }, true), "rejected");
    assert.equal(classifyCheckoutError({ status: 400, data: { code: "INSUFFICIENT_STOCK" } }, true), "rejected");
    assert.equal(keepCheckoutKey("conflict"), false);
  });
  await test("recovery messages: never claim success; offline/unknown say what to do", () => {
    assert.match(checkoutFailureMessage("offline", "Failed to fetch"), /offline.*NOT completed/i);
    assert.match(checkoutFailureMessage("unknown", "Failed to fetch"), /couldn't confirm.*not be charged twice/i);
    assert.match(checkoutFailureMessage("conflict", "", "6ac400000000000000abcdef"), /already completed.*abcdef.*NOT charged/i);
    assert.equal(checkoutFailureMessage("rejected", "Insufficient stock"), "Insufficient stock");
  });

  // ---- safe errors + logging ----
  await test("safeErrorMessage hides runtime/driver errors behind a ref and logs them redacted", () => {
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      const m1 = safeErrorMessage(new TypeError("Cannot read properties of null (reading 'lines')"), "Failed to create sale");
      assert.match(m1, /^Failed to create sale\. Something went wrong — please try again \(ref [0-9a-f]{8}\)\.$/);
      const ref = m1.match(/ref ([0-9a-f]{8})/)![1];
      assert.ok(logs.some((l) => l.includes(`ref=${ref}`) && l.includes("TypeError") && l.includes("reading 'lines'")), "logged with ref");
      const dup = Object.assign(new Error('E11000 duplicate key error collection: unich.users index: email_1 dup key: { email: "x@y.com" } via mongodb+srv://u:secret@c.example.net/db'), { name: "MongoServerError", code: 11000 });
      const m2 = safeErrorMessage(dup, "Failed");
      assert.doesNotMatch(m2, /E11000|email|secret|mongodb/);
      const last = logs.at(-1)!;
      assert.doesNotMatch(last, /x@y\.com|secret|u:secret/);
      assert.match(last, /dup key: \{<redacted>\}/);
      assert.match(last, /mongodb:\/\/<redacted>/);
      const dbDown = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:27017"), { name: "MongooseServerSelectionError" });
      assert.doesNotMatch(safeErrorMessage(dbDown, "Failed"), /ECONNREFUSED|127\.0\.0\.1/);
      assert.ok(isDbUnavailable(dbDown) && !isDbUnavailable(new TypeError("x")));
    } finally {
      console.error = orig;
    }
  });
  await test("safeErrorMessage keeps business messages; JSON / schema errors get safe text", () => {
    assert.equal(safeErrorMessage(new SaleError("INSUFFICIENT_STOCK", "Insufficient stock for X"), "f"), "Insufficient stock for X");
    assert.equal(safeErrorMessage(new Error("Customer phone is required"), "f"), "Customer phone is required");
    assert.equal(safeErrorMessage(new SyntaxError("Unexpected token } in JSON at position 1"), "f"), "Request body must be valid JSON");
    const ve = Object.assign(new Error("Sale validation failed: payment: `x` is not a valid enum value for path `payment`."), { name: "ValidationError", errors: { payment: {} } });
    assert.equal(safeErrorMessage(ve, "f"), "Invalid data: payment");
  });

  // ---- remix: selected oil is the oil consumed (BLD-02/03) ----
  const mk = (name: string, unit: string, sku: string, category = "Packaging") => ({ _id: String(new mongoose.Types.ObjectId()), name, sku, unit, category, sellPrice: 1 });
  const R = { eth: mk("Ethanol 96%", "ml", "ETH-96"), bot: mk("Glass Bottle 100ml", "pcs", "BOT-100"), cap: mk("Cap — Standard Gold", "pcs", "CAP-STD"), col: mk("Collar — Standard", "pcs", "COL-STD"), atm: mk("Atomizer — Standard", "pcs", "ATM-STD"), pch: mk("Velvet Pouch", "pcs", "PCH-STD"), oudOil: mk("Oud Oil", "ml", "OIL-OUD", "Oil"), roseOil: mk("Rose Oil", "ml", "OIL-ROSE", "Oil") };
  const byId = () => new Map(Object.values(R).map((p) => [p._id, p])) as unknown as Parameters<typeof validateRemixSale>[1]["productsById"];
  const c = (p: { _id: string; name: string; unit: string }, qty: number) => ({ productId: p._id, productName: p.name, qty, unit: p.unit });
  const parts = [c(R.eth, 80), c(R.bot, 1), c(R.cap, 1), c(R.col, 1), c(R.atm, 1), c(R.pch, 1)];
  const blend = { name: "Fixed Oud Blend", type: "remix", status: "approved", components: [c(R.oudOil, 20), ...parts] } as unknown as Parameters<typeof validateRemixSale>[0];
  const placeholder = { name: "Remix Standard", type: "remix", status: "approved", components: [{ productId: "oil-base", productName: "Selected Oil Blend", qty: 20, unit: "ml" }, ...parts] } as unknown as Parameters<typeof validateRemixSale>[0];
  await test("oil-base formula: the selected oil (Rose) is exactly what is consumed", async () => {
    const r = await validateRemixSale(placeholder, { oilProductId: R.roseOil._id, lineQty: 2, lineIndex: 0, productsById: byId() });
    const oil = r.componentDeductions.filter((d) => d.reason === "remix:oil");
    assert.deepEqual(oil.map((d) => [d.productId, d.qty]), [[R.roseOil._id, 40]]);
    assert.equal(r.oilProductId, R.roseOil._id);
  });
  await test("saved blend + a DIFFERENT selected oil → OIL_NOT_SELECTED (no silent substitution)", async () => {
    await assert.rejects(() => validateRemixSale(blend, { oilProductId: R.roseOil._id, lineQty: 1, lineIndex: 0, productsById: byId() }), isCode("OIL_NOT_SELECTED"));
  });
  await test("saved blend with its own oil selected, or none → consumes the blend's oil", async () => {
    for (const sel of [R.oudOil._id, undefined]) {
      const r = await validateRemixSale(blend, { oilProductId: sel, lineQty: 1, lineIndex: 0, productsById: byId() });
      assert.deepEqual(r.componentDeductions.filter((d) => d.productId === R.oudOil._id).map((d) => d.qty), [20]);
      assert.ok(!r.componentDeductions.some((d) => d.productId === R.roseOil._id));
    }
  });

  // ---- destructive-script guards ----
  await test("describeDbTarget: only explicit localhost/127.0.0.1/::1 mongodb:// is LOCAL", () => {
    for (const u of ["mongodb://127.0.0.1:27017/a", "mongodb://localhost/a", "mongodb://[::1]:27017/a", "mongodb://127.0.0.1:1,localhost:2/a?replicaSet=rs"]) assert.equal(describeDbTarget(u).hostCategory, "LOCAL", u);
    for (const u of ["mongodb+srv://u:p@cluster0.x.mongodb.net/unich", "mongodb+srv://localhost/a", "mongodb://10.0.0.5/a", "mongodb://127.0.0.1.evil.net/a", "mongodb://127.0.0.1:1,db.example.net:2/a", "garbage"]) assert.equal(describeDbTarget(u).hostCategory, "REMOTE", u);
    assert.equal(describeDbTarget("").hostCategory, "UNSET");
    assert.doesNotMatch(JSON.stringify(describeDbTarget("mongodb+srv://user:pw@cluster0.abc.mongodb.net/unich")), /pw|user|cluster0/);
  });
  const root = process.cwd();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "unich-guard-"));
  // A fake .env in the sandbox stands in for the real one (the incident's fallback path).
  fs.writeFileSync(path.join(sandbox, ".env"), "DATABASE_URL=mongodb+srv://qa:fake@cluster0.invalid-qa.mongodb.net/unich\n");
  const runScript = (script: string, url: string | undefined, args: string[] = [], extraEnv: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv };
    if (url !== undefined) env.DATABASE_URL = url;
    return spawnSync(path.join(root, "node_modules/.bin/tsx"), ["--tsconfig", path.join(root, "tsconfig.json"), path.join(root, "scripts", script), ...args], { cwd: sandbox, env: env as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });
  };
  const destructive = ["seed.ts", "wipe-database.ts", "reset-catalog-stock.ts", "seed-packaging.ts", "seed-accountant-reports.ts", "bootstrap-rbac.ts"];
  const remotes: [string, string | undefined, Record<string, string>?][] = [
    ["Atlas SRV", "mongodb+srv://qa:fake@cluster0.invalid-qa.mongodb.net/unich"],
    ["remote IP", "mongodb://10.255.255.1:27017/unich"],
    ["lookalike host", "mongodb://127.0.0.1.invalid-qa.net:27017/x"],
    ["mixed hosts", "mongodb://127.0.0.1:27099,db.invalid-qa.net:27017/x"],
    ["unset → .env fallback (fake Atlas)", undefined],
    ["E2E_ALLOW_REMOTE_DB=1 bypass attempt", "mongodb+srv://qa:fake@cluster0.invalid-qa.mongodb.net/unich", { E2E_ALLOW_REMOTE_DB: "1" }],
  ];
  for (const script of destructive) {
    await test(`${script} refuses every non-local target before connecting (exit 2)`, () => {
      for (const [label, url, extra] of remotes) {
        const r = runScript(script, url, script === "wipe-database.ts" ? ["--yes"] : [], extra);
        assert.equal(r.status, 2, `${label}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
        assert.match(r.stderr, /REFUSING TO RUN/, label);
        assert.doesNotMatch(r.stdout + r.stderr, /Connected|Clearing|Seed complete|deleted/i, label);
        assert.doesNotMatch(r.stdout + r.stderr, /qa:fake/, `${label}: credentials printed`);
      }
    });
  }
  for (const script of ["migrate-roles.ts", "migrate-currency-omr.ts", "migrate-sale-branch-ids.ts"]) {
    await test(`${script}: --apply without / with wrong --confirm-db refuses (exit 2); no credentials printed`, () => {
      const url = "mongodb+srv://qa:fake@cluster0.invalid-qa.mongodb.net/unich";
      for (const args of [["--apply"], ["--apply", "--confirm-db=other"]]) {
        const r = runScript(script, url, args);
        assert.equal(r.status, 2, `${args.join(" ")}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
        assert.doesNotMatch(r.stdout + r.stderr, /qa:fake|cluster0/);
      }
    });
  }
  await test("QA/e2e guard: SRV never local; E2E_ALLOW_REMOTE_DB=1 no longer bypasses it", () => {
    assert.equal(isLocalDbUrl("mongodb+srv://localhost/a"), false);
    assert.equal(isLocalDbUrl("mongodb://127.0.0.1:27099/a"), true);
    const r = spawnSync(path.join(root, "node_modules/.bin/tsx"), ["--tsconfig", path.join(root, "tsconfig.json"), path.join(root, "tests/qa/pos-142b-status.ts")], {
      cwd: sandbox, encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: "mongodb+srv://qa:fake@cluster0.invalid-qa.mongodb.net/unich", E2E_ALLOW_REMOTE_DB: "1" } as unknown as NodeJS.ProcessEnv,
    });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Refusing to run/);
  });
  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
