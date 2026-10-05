/**
 * Local sales unit tests (npm run test).
 * Covers remix BOM roles, formula gate, oil-ml from labels (no client trust),
 * stock warning copy, and mixed-cart / FIFO error shapes.
 */
import assert from "node:assert/strict";
import {
  HALF_TOLA_ML,
  QUARTER_TOLA_ML,
  TOLA_ML,
  resolveDeductMlFromUnitLabel,
  resolveOilTolaMl,
} from "../format";
import {
  matchRemixRole,
  REMIX_REQUIRED_ROLES,
  OIL_BASE_PRODUCT_ID,
  REMIX_OIL_ML,
  REFILL_CUSTOMER_BOTTLE_ML,
  roleLabel,
} from "./constants";
import { validateFormulaInput } from "../formulas/validateFormula";
import { SaleError } from "./errors";
import { resolveSearchPick } from "./posSearch";
import {
  DISCOUNT_LIMIT_PCT,
  clampDiscount,
  computeDiscounts,
  exceedsDiscountLimit,
  parseDiscount,
} from "./discount";
import { cartFingerprint, resolveDiscountApproval } from "./discountApproval";
import {
  defaultLowStockAt,
  warnIfNegativeStock,
} from "../inventory/stockCheck";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

console.log("sales constants");

// Product name/SKU → remix BOM role (bottle, cap, atomizer, …)
test("matches required remix roles", () => {
  assert.equal(matchRemixRole("Glass Bottle 100ml", "BOT-100"), "bottle");
  assert.equal(matchRemixRole("Cap — Standard Gold", "CAP-STD"), "cap");
  assert.equal(matchRemixRole("Atomizer", "ATM-STD"), "atomizer");
  assert.equal(matchRemixRole("Collar", "COL-STD"), "collar");
  assert.equal(matchRemixRole("Label — Standard", "LBL-STD"), "label");
  assert.equal(matchRemixRole("Carton Box — Standard", "BOX-STD"), "box");
  assert.equal(matchRemixRole("Gift Box — Duo", "GB-001"), "box");
  assert.equal(matchRemixRole("Ethanol 96%", "ETH-96"), "ethanol");
  assert.equal(matchRemixRole("Fixative — Standard", "FIX-STD"), "fixative");
  assert.equal(matchRemixRole("Velvet Pouch", "PCH-STD"), "pouch");
});

// Oil blend / real oils must not map to a remix role
test("returns null for oil blend / oils", () => {
  assert.equal(matchRemixRole("Selected Oil Blend"), null);
  assert.equal(matchRemixRole("Amber Oud Oil", "OIL-AMB"), null);
});

// Display label for a role id (fixative → Fixative)
test("roleLabel capitalizes", () => {
  assert.equal(roleLabel("fixative"), "Fixative");
});

// Approved remix configuration: 20 ml oil + ethanol, bottle, cap, collar, atomizer, pouch
test("required roles = approved remix configuration", () => {
  assert.deepEqual([...REMIX_REQUIRED_ROLES], [
    "bottle",
    "cap",
    "atomizer",
    "collar",
    "pouch",
    "ethanol",
  ]);
});

console.log("formula validation (local)");

function validateFormulaRolesLocal(
  components: Array<{
    productId: string;
    productName: string;
    qty: number;
    sku?: string;
  }>,
) {
  if (!components.length) {
    throw new SaleError("FORMULA_MISSING", "Formula missing");
  }
  const found = new Set<string>();
  let oil: (typeof components)[number] | undefined;
  for (const c of components) {
    if (c.productId === OIL_BASE_PRODUCT_ID) {
      oil = c;
      continue;
    }
    const role = matchRemixRole(c.productName, c.sku);
    if (role) found.add(role);
  }
  const missing = REMIX_REQUIRED_ROLES.filter((r) => !found.has(r));
  if (missing.length) {
    throw new SaleError(
      "FORMULA_INCOMPLETE",
      `Formula incomplete: ${missing.map(roleLabel).join(", ")} missing`,
    );
  }
  if (!oil) {
    throw new SaleError(
      "FORMULA_INCOMPLETE",
      "Formula incomplete: oil quantity (oil-base) missing",
    );
  }
  if (oil.qty !== REMIX_OIL_ML) {
    throw new SaleError(
      "FORMULA_INCOMPLETE",
      `Formula incomplete: remix oil must be ${REMIX_OIL_ML} ml (BLD-02/03)`,
    );
  }
  return oil.qty;
}

const complete = [
  {
    productId: OIL_BASE_PRODUCT_ID,
    productName: "Selected Oil Blend",
    qty: REMIX_OIL_ML,
  },
  { productId: "1", productName: "Ethanol 96%", qty: 80, sku: "ETH-96" },
  { productId: "2", productName: "Fixative — Standard", qty: 2, sku: "FIX-STD" },
  { productId: "3", productName: "Glass Bottle 100ml", qty: 1, sku: "BOT-100" },
  { productId: "4", productName: "Cap — Standard Gold", qty: 1, sku: "CAP-STD" },
  { productId: "5", productName: "Atomizer", qty: 1, sku: "ATM-STD" },
  { productId: "6", productName: "Collar", qty: 1, sku: "COL-STD" },
  { productId: "7", productName: "Label — Standard", qty: 1, sku: "LBL-STD" },
  { productId: "8", productName: "Carton Box — Standard", qty: 1, sku: "BOX-STD" },
  { productId: "9", productName: "Velvet Pouch", qty: 1, sku: "PCH-STD" },
];

// Happy path: full remix BOM + oil-base → returns REMIX_OIL_ML (20)
test("complete formula returns oil ml 20", () => {
  assert.equal(REMIX_OIL_ML, 20);
  assert.equal(validateFormulaRolesLocal(complete), REMIX_OIL_ML);
});

// BLD-02/03: oil-base qty must be exactly 20 ml (local + validateFormulaInput)
test("remix oil-base must be exactly 20 ml", () => {
  const wrongOil = complete.map((c) =>
    c.productId === OIL_BASE_PRODUCT_ID ? { ...c, qty: 18 } : c,
  );
  assert.throws(
    () => validateFormulaRolesLocal(wrongOil),
    (err: unknown) =>
      err instanceof SaleError &&
      err.code === "FORMULA_INCOMPLETE" &&
      /remix oil must be 20 ml/i.test(err.message),
  );

  const errors = validateFormulaInput({
    name: "Remix Standard",
    type: "remix",
    yieldMl: 100,
    components: [
      {
        productId: OIL_BASE_PRODUCT_ID,
        productName: "Selected Oil Blend",
        qty: 18,
        unit: "ml",
      },
      {
        productId: "1",
        productName: "Ethanol 96%",
        qty: 82,
        unit: "ml",
      },
    ],
  });
  assert.ok(errors.some((e) => /oil-base must be 20 ml/i.test(e)));
});

// Empty component list → FORMULA_MISSING (block sale)
test("empty formula → Formula missing", () => {
  assert.throws(
    () => validateFormulaRolesLocal([]),
    (err: unknown) =>
      err instanceof SaleError &&
      err.code === "FORMULA_MISSING" &&
      err.message === "Formula missing",
  );
});

// Any required role absent (here Pouch) → FORMULA_INCOMPLETE
test("missing Pouch → Formula incomplete", () => {
  const withoutPouch = complete.filter((c) => c.sku !== "PCH-STD");
  assert.throws(
    () => validateFormulaRolesLocal(withoutPouch),
    (err: unknown) =>
      err instanceof SaleError &&
      err.code === "FORMULA_INCOMPLETE" &&
      /Pouch missing/i.test(err.message),
  );
});

// Label / box / fixative are optional in the approved configuration
test("approved 7-part BOM (no label / box / fixative) is complete", () => {
  const approved = complete.filter((c) => !["FIX-STD", "LBL-STD", "BOX-STD"].includes(c.sku ?? ""));
  assert.equal(validateFormulaRolesLocal(approved), REMIX_OIL_ML);
});

// Oil blend line required on remix formula
test("missing oil-base → Formula incomplete", () => {
  const withoutOil = complete.filter((c) => c.productId !== OIL_BASE_PRODUCT_ID);
  assert.throws(
    () => validateFormulaRolesLocal(withoutOil),
    (err: unknown) => err instanceof SaleError && err.code === "FORMULA_INCOMPLETE",
  );
});

// POS must fail clearly when cashier never picked an oil
test("Oil not selected error message", () => {
  const err = new SaleError("OIL_NOT_SELECTED", "Oil not selected");
  assert.equal(err.message, "Oil not selected");
  assert.equal(err.code, "OIL_NOT_SELECTED");
});

// Stock short → INSUFFICIENT_STOCK message shape
test("Insufficient stock error message", () => {
  const err = new SaleError("INSUFFICIENT_STOCK", "Insufficient stock for Cap");
  assert.match(err.message, /Insufficient stock/);
});

console.log("backend oil ml (no client trust)");

// Oil sale: unit label "1 Tola" → deduct 12 ml (server-side)
test("1 Tola → 12 ml", () => {
  assert.equal(resolveDeductMlFromUnitLabel("1 Tola"), TOLA_ML);
  assert.equal(TOLA_ML, 12);
});

// Oil sale: "½ Tola" / "1/2 Tola" → 6 ml
test("½ Tola → 6 ml", () => {
  assert.equal(resolveDeductMlFromUnitLabel("½ Tola"), HALF_TOLA_ML);
  assert.equal(resolveDeductMlFromUnitLabel("1/2 Tola"), HALF_TOLA_ML);
  assert.equal(HALF_TOLA_ML, 6);
});

// Oil sale: "¼ Tola" / "1/4 Tola" → 3 ml
test("¼ Tola → 3 ml", () => {
  assert.equal(resolveDeductMlFromUnitLabel("¼ Tola"), QUARTER_TOLA_ML);
  assert.equal(resolveDeductMlFromUnitLabel("1/4 Tola"), QUARTER_TOLA_ML);
  assert.equal(QUARTER_TOLA_ML, 3);
});

// Plain ml labels parse to a number (refill / custom sizes)
test("100ml refill label → 100", () => {
  assert.equal(resolveDeductMlFromUnitLabel("100ml refill"), 100);
  assert.equal(resolveDeductMlFromUnitLabel("50 ml"), 50);
});

// BLD-09: customer refill bottle is locked to 100ml; other sizes parse but must not pass sale gate
test("BLD-09 refill bottle size is hard-locked to 100ml", () => {
  assert.equal(REFILL_CUSTOMER_BOTTLE_ML, 100);
  const fifty = resolveDeductMlFromUnitLabel("50ml refill");
  const twoHundred = resolveDeductMlFromUnitLabel("200ml refill");
  assert.equal(fifty, 50);
  assert.equal(twoHundred, 200);
  // Sale path must reject anything other than REFILL_CUSTOMER_BOTTLE_ML
  assert.notEqual(fifty, REFILL_CUSTOMER_BOTTLE_ML);
  assert.notEqual(twoHundred, REFILL_CUSTOMER_BOTTLE_ML);
  assert.equal(
    resolveDeductMlFromUnitLabel("100ml refill"),
    REFILL_CUSTOMER_BOTTLE_ML,
  );
});

// INV-06: negative on-hand shows restock warning; zero/positive → no warn
test("INV-06 negative stock warning copy", () => {
  const w = warnIfNegativeStock("Oud Oil", -12);
  assert.ok(w);
  assert.match(w!, /Stock warning/);
  assert.match(w!, /restock or reorder/);
  assert.equal(warnIfNegativeStock("Oud Oil", 0), null);
  assert.equal(warnIfNegativeStock("Oud Oil", 5), null);
});

// ALT-01: default low-stock thresholds by unit / oil vs note
test("ALT-01 default low-stock thresholds", () => {
  assert.equal(defaultLowStockAt({ unit: "pcs" }), 5);
  assert.equal(defaultLowStockAt({ unit: "ml", name: "Oud Cambodi Oil" }), 100);
  assert.equal(
    defaultLowStockAt({ unit: "ml", itemType: "raw", name: "Rose Note" }),
    5,
  );
  assert.equal(
    defaultLowStockAt({ unit: "ml", category: "Notes", name: "Amber" }),
    5,
  );
});

// Unparseable unit label → null so sale cannot invent deduct ml
test("missing / garbage label → null (sale must stop)", () => {
  assert.equal(resolveDeductMlFromUnitLabel(undefined), null);
  assert.equal(resolveDeductMlFromUnitLabel(""), null);
  assert.equal(resolveDeductMlFromUnitLabel("pcs"), null);
  assert.equal(resolveDeductMlFromUnitLabel("bottle"), null);
});

// Client-sent deductMl without a label must not invent ml (label-only resolver)
test("client deductMl alone is not a label — must not invent ml", () => {
  // resolveDeductMlFromUnitLabel only reads labels; raw deductMl is ignored by design
  assert.equal(resolveDeductMlFromUnitLabel(undefined), null);
});

// POS-022..030: individual oil accepts ONLY the approved tola sizes
test("oil sizes: exact ¼ / ½ / 1 tola labels → 3 / 6 / 12 ml", () => {
  assert.equal(resolveOilTolaMl("¼ Tola"), 3);
  assert.equal(resolveOilTolaMl(" 1/4  tola "), 3);
  assert.equal(resolveOilTolaMl("½ Tola"), 6);
  assert.equal(resolveOilTolaMl("Half Tola"), 6);
  assert.equal(resolveOilTolaMl("1 Tola"), 12);
  assert.equal(resolveOilTolaMl("tola"), 12);
});

test("oil sizes: arbitrary ml / other tola amounts are not oil sizes", () => {
  for (const label of ["7 ml", "0.01 ml", "12 ml", "2 Tola", "3/4 Tola", "1½ Tola", "½", "¼ Tola extra", "", undefined]) {
    assert.equal(resolveOilTolaMl(label), null, `label ${JSON.stringify(label)}`);
  }
});

test("'1½ Tola' no longer partially matches ½ (→ null, not 6 ml)", () => {
  assert.equal(resolveDeductMlFromUnitLabel("1½ Tola"), null);
  assert.equal(resolveDeductMlFromUnitLabel("1 1/2 tola"), null);
  // ml labels (refill) still parse
  assert.equal(resolveDeductMlFromUnitLabel("100ml refill"), 100);
});

console.log("mixed-cart line type rules (local)");

// Cart can mix ready / remix / oil / refill / packaging as distinct line types
test("ready + remix + oil line types are distinct", () => {
  const types = new Set(["ready", "remix", "oil", "refill", "packaging"]);
  assert.ok(types.has("ready"));
  assert.ok(types.has("remix"));
  assert.ok(types.has("refill"));
});

// FIFO shortage error copy must include "FIFO need" + "short"
test("FIFO short message shape", () => {
  const err = new SaleError(
    "INSUFFICIENT_STOCK",
    "Insufficient stock for Cap (FIFO need 2, short 1)",
  );
  assert.match(err.message, /FIFO need/);
  assert.match(err.message, /short/);
});

console.log("POS-021 duplicate / similar product names (local)");

const blueA = { id: "P-101", name: "Blue Ocean", sku: "PERF-001" };
const blueB = { id: "P-205", name: "Blue Ocean", sku: "PERF-009" };
const blueMist = { id: "P-300", name: "Blue Ocean Mist", sku: "PERF-020" };

test("same name, two products → ambiguous, nothing picked", () => {
  const pick = resolveSearchPick([blueA, blueB], "Blue Ocean");
  assert.deepEqual(pick, { kind: "ambiguous", count: 2 });
});

test("same name is ambiguous regardless of result order or case", () => {
  assert.equal(resolveSearchPick([blueB, blueA], "blue ocean").kind, "ambiguous");
  assert.equal(resolveSearchPick([blueA, blueB, blueMist], " BLUE OCEAN ").kind, "ambiguous");
});

test("exact SKU picks that exact product (PERF-009 → P-205)", () => {
  const pick = resolveSearchPick([blueA, blueB], "perf-009");
  assert.equal(pick.kind, "pick");
  assert.equal(pick.kind === "pick" && pick.product.id, "P-205");
  const pickA = resolveSearchPick([blueB, blueA], "PERF-001");
  assert.equal(pickA.kind === "pick" && pickA.product.id, "P-101");
});

test("similar names, partial query → ambiguous, never first result", () => {
  const pick = resolveSearchPick([blueA, blueMist], "blue");
  assert.deepEqual(pick, { kind: "ambiguous", count: 2 });
});

test("unique exact name beats a longer similar name", () => {
  const pick = resolveSearchPick([blueA, blueMist], "Blue Ocean");
  assert.equal(pick.kind === "pick" && pick.product.id, "P-101");
});

test("single result is picked; no result is none", () => {
  const one = resolveSearchPick([blueMist], "mist");
  assert.equal(one.kind === "pick" && one.product.id, "P-300");
  assert.deepEqual(resolveSearchPick([], "Blue Ocean"), { kind: "none" });
});

console.log("\nPOS discounts (POS-068..075)");

// Two lines: 2 × 10.000 and 1 × 5.000 → gross 25.000
const discountCart = [{ gross: 2 * 10 }, { gross: 1 * 5 }];

test("POS-068: valid discount recalculates the total", () => {
  const b = computeDiscounts(discountCart, { type: "percent", value: 10 });
  assert.equal(b.subtotal, 25);
  assert.equal(b.discountTotal, 2.5);
  assert.equal(b.total, 22.5);
});

test("POS-069: item-level discount changes only that line", () => {
  const b = computeDiscounts([
    { ...discountCart[0], discount: { type: "percent", value: 25 } },
    discountCart[1],
  ]);
  assert.equal(b.lines[0].discountAmount, 5);
  assert.equal(b.lines[0].net, 15);
  assert.equal(b.lines[1].discountAmount, 0);
  assert.equal(b.lines[1].net, 5);
  assert.equal(b.total, 20);
  const fixed = computeDiscounts([
    discountCart[0],
    { ...discountCart[1], discount: { type: "amount", value: 1.25 } },
  ]);
  assert.equal(fixed.lines[0].net, 20);
  assert.equal(fixed.lines[1].net, 3.75);
  assert.equal(fixed.total, 23.75);
});

test("POS-070: invoice discount applies after line discounts", () => {
  const b = computeDiscounts(
    [{ ...discountCart[0], discount: { type: "amount", value: 5 } }, discountCart[1]],
    { type: "percent", value: 10 },
  );
  assert.equal(b.lineDiscountTotal, 5);
  assert.equal(b.invoiceDiscountAmount, 2); // 10% of 20.000
  assert.equal(b.discountTotal, 7);
  assert.equal(b.total, 18);
  // Refill packaging (charged outside qty × price) is reachable by the bill discount.
  const withExtra = computeDiscounts([{ gross: 10 }], { type: "percent", value: 50 }, 2);
  assert.equal(withExtra.subtotal, 12);
  assert.equal(withExtra.total, 6);
});

test("POS-071: discount over the cashier limit needs approval; within it does not", () => {
  const limit = DISCOUNT_LIMIT_PCT.cashier;
  const within = computeDiscounts(discountCart, { type: "percent", value: limit });
  const over = computeDiscounts(discountCart, { type: "percent", value: limit + 5 });
  assert.equal(exceedsDiscountLimit(within, "cashier"), false);
  assert.equal(exceedsDiscountLimit(over, "cashier"), true);
  assert.equal(exceedsDiscountLimit(over, "owner"), false);
  // A big discount on one line can't hide inside a small bill-level %.
  const lineHeavy = computeDiscounts([
    { gross: 100 },
    { gross: 2, discount: { type: "percent", value: 50 } },
  ]);
  assert.ok(lineHeavy.discountPct < limit);
  assert.equal(lineHeavy.maxDiscountPct, 50);
  assert.equal(exceedsDiscountLimit(lineHeavy, "cashier"), true);
});

async function expectSaleError(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof SaleError);
    assert.equal(err.code, code);
    return true;
  });
}

const asyncTests: Array<[string, () => Promise<void>]> = [
  [
    "POS-071: over-limit discount without approver → DISCOUNT_APPROVAL_REQUIRED",
    async () => {
      const over = computeDiscounts(discountCart, { type: "percent", value: 30 });
      await expectSaleError(
        resolveDiscountApproval(over, { role: "cashier" }, null),
        "DISCOUNT_APPROVAL_REQUIRED",
      );
      await expectSaleError(
        resolveDiscountApproval(over, { role: "cashier" }, { email: "boss@x.com", password: "" }),
        "DISCOUNT_APPROVAL_REQUIRED",
      );
      // No session at all is treated as a 0% limit, never as unlimited.
      await expectSaleError(
        resolveDiscountApproval(computeDiscounts(discountCart, { type: "percent", value: 1 }), null, null),
        "DISCOUNT_APPROVAL_REQUIRED",
      );
    },
  ],
  [
    "POS-071: within-limit / no discount passes without approval",
    async () => {
      const within = computeDiscounts(discountCart, { type: "percent", value: 5 });
      assert.equal(await resolveDiscountApproval(within, { role: "cashier" }, null), null);
      assert.equal(
        await resolveDiscountApproval(computeDiscounts(discountCart), { role: "accountant" }, null),
        null,
      );
    },
  ],
];

test("POS-073: discount lowers revenue, so profit and margin recalculate", () => {
  const cost = 15;
  const full = computeDiscounts(discountCart);
  const disc = computeDiscounts(discountCart, { type: "amount", value: 5 });
  // Profit report uses sale.total as revenue.
  assert.equal(full.total - cost, 10);
  assert.equal(disc.total - cost, 5);
  assert.equal(Math.round(((disc.total - cost) / disc.total) * 10000) / 100, 25);
});

test("POS-074: removing a discount restores the original price", () => {
  const withDisc = computeDiscounts(
    [{ ...discountCart[0], discount: { type: "percent", value: 10 } }, discountCart[1]],
    { type: "amount", value: 2 },
  );
  assert.notEqual(withDisc.total, 25);
  const removed = computeDiscounts([discountCart[0], discountCart[1]], null);
  assert.equal(removed.total, 25);
  assert.equal(removed.discountTotal, 0);
  assert.equal(removed.lines[0].net, 20);
});

test("POS-075: negative / invalid discount input is rejected", () => {
  const bad: unknown[] = [
    { type: "percent", value: -5 },
    { type: "amount", value: -1 },
    { type: "percent", value: 101 },
    { type: "amount", value: 25.001 },
    { type: "percent", value: "abc" },
    { type: "percent", value: Number.NaN },
    { type: "percent", value: Number.POSITIVE_INFINITY },
    { type: "free", value: 5 },
    "10%",
  ];
  for (const raw of bad) {
    assert.throws(
      () => parseDiscount(raw, 25, "Line 1"),
      (err: unknown) => err instanceof SaleError && err.code === "INVALID_DISCOUNT",
      `expected ${JSON.stringify(raw)} to be rejected`,
    );
  }
  assert.throws(() => computeDiscounts([{ gross: 5, discount: { type: "amount", value: 6 } }]));
  assert.throws(() => computeDiscounts(discountCart, { type: "percent", value: -1 }));
  // Valid edge cases
  assert.equal(parseDiscount({ type: "percent", value: 0 }, 25, "x"), null);
  assert.deepEqual(parseDiscount({ type: "amount", value: "2.5" }, 25, "x"), {
    type: "amount",
    value: 2.5,
  });
  assert.equal(computeDiscounts(discountCart, { type: "percent", value: 100 }).total, 0);
});

test("limit check uses the unrounded % (10.004% exceeds a 10% limit)", () => {
  for (const d of [
    { type: "percent", value: 10.004 },
    { type: "amount", value: 10.004 },
  ] as const) {
    const b = computeDiscounts([{ gross: 100, discount: d }]);
    assert.equal(b.maxDiscountPct, 10); // display stays 2 dp
    assert.equal(exceedsDiscountLimit(b, "cashier"), true, JSON.stringify(d));
  }
  // An exact 10% (float noise included) is still within the limit.
  assert.equal(exceedsDiscountLimit(computeDiscounts([{ gross: 0.3, discount: { type: "percent", value: 10 } }]), "cashier"), false);
  assert.equal(exceedsDiscountLimit(computeDiscounts([{ gross: 100, discount: { type: "amount", value: 10 } }]), "cashier"), false);
});

test("only plain decimal strings are numbers (no hex / exponent / Infinity)", () => {
  for (const value of ["0x5", "5e1", "1e2", "Infinity", "+5", ".5", "5.", " 5 5"]) {
    assert.throws(
      () => parseDiscount({ type: "percent", value }, 100, "L"),
      (err: unknown) => err instanceof SaleError && err.code === "INVALID_DISCOUNT",
      value,
    );
  }
  assert.deepEqual(parseDiscount({ type: "percent", value: " 7.5 " }, 100, "L"), { type: "percent", value: 7.5 });
  assert.throws(() => parseDiscount({ type: "percent", value: "-5" }, 100, "L"), /negative/);
});

test("values normalised to 3 dp; sub-baisa discounts become no discount", () => {
  assert.deepEqual(parseDiscount({ type: "amount", value: 1.23456 }, 100, "L"), { type: "amount", value: 1.235 });
  assert.equal(parseDiscount({ type: "amount", value: 0.0001 }, 100, "L"), null);
  const tiny = computeDiscounts([{ gross: 1, discount: { type: "percent", value: 0.01 } }], { type: "percent", value: 0.01 });
  assert.equal(tiny.lines[0].discount, null, "0.01% of OMR 1 takes nothing off");
  assert.equal(tiny.invoiceDiscount, null);
  assert.equal(tiny.discountTotal, 0);
});

test("approval fingerprint: stable for the same cart, changes with any priced input", () => {
  const cart = [
    { productId: "a", qty: 1, lineType: "ready", discount: { type: "percent", value: 30 } },
    { productId: "b", qty: 2, lineType: "ready" },
  ];
  const fp = cartFingerprint(cart, { type: "amount", value: 1 });
  assert.equal(cartFingerprint(structuredClone(cart), { type: "amount", value: "1" }), fp);
  assert.notEqual(cartFingerprint([{ ...cart[0], discount: { type: "percent", value: 31 } }, cart[1]], { type: "amount", value: 1 }), fp);
  assert.notEqual(cartFingerprint([cart[0], { ...cart[1], qty: 3 }], { type: "amount", value: 1 }), fp);
  assert.notEqual(cartFingerprint(cart, { type: "amount", value: 2 }), fp);
  assert.notEqual(cartFingerprint(cart, null), fp);
});

test("cart clamp: fixed discount larger than a reduced line is capped", () => {
  assert.deepEqual(clampDiscount({ type: "amount", value: 8 }, 5), { type: "amount", value: 5 });
  assert.deepEqual(clampDiscount({ type: "percent", value: 20 }, 5), { type: "percent", value: 20 });
  assert.equal(clampDiscount({ type: "amount", value: 3 }, 0), null);
});

void (async () => {
  for (const [name, fn] of asyncTests) {
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
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
