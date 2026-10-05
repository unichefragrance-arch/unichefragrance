/**
 * Local reports unit tests (npm run test).
 * Covers period range math (week/month/year boundaries, leap years),
 * anchor-date parsing of bad input, and FIFO inventory valuation edge cases
 * (empty catalog, zero-value stock, filters that match nothing, CSV escaping).
 */
import assert from "node:assert/strict";
import {
  formatPeriodLabel,
  getPeriodRange,
  parseAnchorDate,
  parseReportPeriod,
  toDateInputValue,
} from "./period";
import {
  buildInventoryValuation,
  buildInventoryValuationCsv,
  parseValuationBucket,
  type ValuationProductInput,
} from "./inventoryValuation";
import { moneyText, roundMoney, roundQty } from "../money";
import { computeQuotationTotals } from "../quotation/calc";

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

console.log("period parsing");

test("parseReportPeriod: unknown/garbage/null falls back to daily", () => {
  assert.equal(parseReportPeriod("weekly"), "weekly");
  assert.equal(parseReportPeriod("monthly"), "monthly");
  assert.equal(parseReportPeriod("yearly"), "yearly");
  assert.equal(parseReportPeriod("daily"), "daily");
  assert.equal(parseReportPeriod("quarterly"), "daily");
  assert.equal(parseReportPeriod(""), "daily");
  assert.equal(parseReportPeriod(null), "daily");
});

test("parseAnchorDate: valid YYYY-MM-DD parses as local noon", () => {
  const d = parseAnchorDate("2026-08-25");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7); // 0-indexed August
  assert.equal(d.getDate(), 25);
  assert.equal(d.getHours(), 12);
});

test("parseAnchorDate: malformed strings fall back to today, not a crash", () => {
  const now = Date.now();
  for (const bad of [null, undefined, "", "25-08-2026", "2026/08/25", "not-a-date"]) {
    const d = parseAnchorDate(bad as string | null | undefined);
    assert.ok(!Number.isNaN(d.getTime()), `${String(bad)} produced an invalid Date`);
    assert.ok(Math.abs(d.getTime() - now) < 5000, `${String(bad)} did not fall back to "today"`);
  }
});

test("parseAnchorDate: out-of-range but regex-matching values silently overflow (no validation)", () => {
  // Documents current behavior: the regex only checks shape, not calendar
  // validity, so month 13 / day 45 roll over via native Date arithmetic
  // instead of being rejected.
  const d = parseAnchorDate("2026-13-45");
  assert.equal(d.getTime(), new Date(2026, 12, 45, 12, 0, 0, 0).getTime());
});

test("toDateInputValue: zero-pads single-digit month/day", () => {
  assert.equal(toDateInputValue(new Date(2026, 2, 5, 9, 0, 0)), "2026-03-05");
  assert.equal(toDateInputValue(new Date(2026, 11, 31, 23, 59, 59)), "2026-12-31");
});

test("toDateInputValue + parseAnchorDate round-trip", () => {
  const original = "2026-01-09";
  assert.equal(toDateInputValue(parseAnchorDate(original)), original);
});

console.log("period range boundaries");

test("daily: collapses any time-of-day to 00:00:00.000–23:59:59.999", () => {
  const anchor = new Date(2026, 5, 15, 17, 42, 3, 250);
  const { start, end } = getPeriodRange("daily", anchor);
  assert.equal(start.getDate(), 15);
  assert.deepEqual([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()], [0, 0, 0, 0]);
  assert.deepEqual([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()], [23, 59, 59, 999]);
});

test("weekly: always spans Monday 00:00 → Sunday 23:59:59.999, for every weekday anchor", () => {
  // Walk 8 consecutive days so every possible getDay() (0..6) is exercised
  // as the anchor at least once, including the Sunday wrap-around case.
  const base = new Date(2026, 0, 1); // arbitrary start
  for (let i = 0; i < 8; i++) {
    const anchor = new Date(base);
    anchor.setDate(base.getDate() + i);
    const { start, end } = getPeriodRange("weekly", anchor);
    assert.equal(start.getDay(), 1, `start not Monday for anchor day ${anchor.toDateString()}`);
    assert.equal(end.getDay(), 0, `end not Sunday for anchor day ${anchor.toDateString()}`);
    assert.equal(end.getTime() - start.getTime(), 7 * 24 * 3600 * 1000 - 1);
    assert.ok(anchor.getTime() >= start.getTime() && anchor.getTime() <= end.getTime());
  }
});

test("monthly: leap-year February ends on the 29th", () => {
  const { end } = getPeriodRange("monthly", new Date(2028, 1, 15)); // 2028 is a leap year
  assert.equal(end.getMonth(), 1);
  assert.equal(end.getDate(), 29);
});

test("monthly: non-leap-year February ends on the 28th", () => {
  const { end } = getPeriodRange("monthly", new Date(2026, 1, 15)); // 2026 is not a leap year
  assert.equal(end.getMonth(), 1);
  assert.equal(end.getDate(), 28);
});

test("monthly: December anchor stays in December (no year rollover bug)", () => {
  const { start, end } = getPeriodRange("monthly", new Date(2026, 11, 10));
  assert.equal(start.getFullYear(), 2026);
  assert.deepEqual([start.getMonth(), start.getDate()], [11, 1]);
  assert.equal(end.getFullYear(), 2026);
  assert.deepEqual([end.getMonth(), end.getDate()], [11, 31]);
});

test("yearly: any anchor month/day resolves to Jan 1 – Dec 31 of that year", () => {
  for (const anchor of [new Date(2026, 0, 1), new Date(2026, 5, 30), new Date(2026, 11, 31)]) {
    const { start, end } = getPeriodRange("yearly", anchor);
    assert.deepEqual([start.getMonth(), start.getDate()], [0, 1]);
    assert.deepEqual([end.getMonth(), end.getDate()], [11, 31]);
    assert.equal(start.getFullYear(), 2026);
    assert.equal(end.getFullYear(), 2026);
  }
});

console.log("period label formatting");

test("formatPeriodLabel: daily/yearly/monthly/weekly shapes", () => {
  const anchor = new Date(2026, 1, 15); // 15 Feb 2026, a leap year
  assert.equal(formatPeriodLabel("daily", anchor, anchor), "15 Feb 2026");
  assert.equal(formatPeriodLabel("yearly", anchor, anchor), "2026");
  assert.equal(formatPeriodLabel("monthly", anchor, anchor), "February 2026");
  const { start, end } = getPeriodRange("weekly", anchor);
  const weekly = formatPeriodLabel("weekly", start, end);
  assert.ok(weekly.includes(" – "), `expected an en-dash range, got "${weekly}"`);
  assert.ok(weekly.includes("2026"));
});

console.log(`\nreports/period: ${passed} passed, ${failed} failed so far`);

console.log("\ninventory valuation");

function product(overrides: Partial<ValuationProductInput> = {}): ValuationProductInput {
  return {
    id: "p1",
    sku: "SKU-1",
    name: "Product 1",
    category: "Perfume",
    unit: "ml",
    costFifo: 10,
    stockSellable: 5,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    ...overrides,
  };
}

test("empty catalog produces a zeroed, empty report (no crash)", () => {
  const report = buildInventoryValuation([]);
  assert.equal(report.totalValue, 0);
  assert.equal(report.totalSkus, 0);
  assert.equal(report.categoryCount, 0);
  assert.equal(report.highest, null);
  assert.equal(report.lowest, null);
  assert.deepEqual(report.categories, []);
});

test("all-zero-value stock: highest/lowest are null, not a fake winner", () => {
  const report = buildInventoryValuation([
    product({ id: "a", costFifo: 0, stockSellable: 100 }),
    product({ id: "b", costFifo: 5, stockSellable: 0 }),
  ]);
  assert.equal(report.totalValue, 0);
  assert.equal(report.highest, null);
  assert.equal(report.lowest, null);
});

test("single category with value: highest is set, lowest is null (nothing to compare against)", () => {
  const report = buildInventoryValuation([product({ costFifo: 10, stockSellable: 5 })]);
  assert.equal(report.highest?.category, "Perfume");
  assert.equal(report.lowest, null);
});

test("two categories: highest/lowest are distinct and correctly ranked", () => {
  const report = buildInventoryValuation([
    product({ id: "a", category: "Perfume", costFifo: 100, stockSellable: 10 }), // value 1000
    product({ id: "b", category: "Oils", costFifo: 5, stockSellable: 4 }), // value 20
  ]);
  assert.equal(report.highest?.category, "Perfume");
  assert.equal(report.lowest?.category, "Oils");
  assert.notEqual(report.highest?.category, report.lowest?.category);
});

test("bucket=all sums every stock bucket; other buckets read only their own", () => {
  const p = product({
    stockSellable: 10,
    stockTester: 2,
    stockSample: 3,
    stockPersonal: 4,
    costFifo: 1,
  });
  assert.equal(buildInventoryValuation([p], { bucket: "all" }).totalQty, 19);
  assert.equal(buildInventoryValuation([p], { bucket: "tester" }).totalQty, 2);
  assert.equal(buildInventoryValuation([p], { bucket: "sample" }).totalQty, 3);
  assert.equal(buildInventoryValuation([p], { bucket: "personal" }).totalQty, 4);
  assert.equal(buildInventoryValuation([p]).totalQty, 10); // default = sellable
});

test("low-stock flag only applies to the sellable bucket, never tester/sample/personal", () => {
  const p = product({ stockSellable: 2, lowStockAt: 5 });
  const sellable = buildInventoryValuation([p], { bucket: "sellable" });
  assert.equal(sellable.categories[0].products[0].lowStock, true);
  const tester = buildInventoryValuation([p], { bucket: "tester" });
  assert.equal(tester.categories[0].products[0].lowStock, false);
});

test("category filter that matches nothing returns an empty (not crashed) report", () => {
  const report = buildInventoryValuation([product()], { category: "Nonexistent" });
  assert.equal(report.totalSkus, 0);
  assert.deepEqual(report.categories, []);
});

test("brand filter matches case-insensitively; products with no brand are excluded", () => {
  const withBrand = product({ id: "a", brand: "Chanel" });
  const noBrand = product({ id: "b", brand: undefined });
  const report = buildInventoryValuation([withBrand, noBrand], { brand: "chanel" });
  assert.equal(report.totalSkus, 1);
  assert.equal(report.categories[0].products[0].id, "a");
});

test('filter value "All" is a no-op, not a literal category/brand match', () => {
  const report = buildInventoryValuation([product({ category: "Perfume" })], {
    category: "All",
    brand: "All",
  });
  assert.equal(report.totalSkus, 1);
});

test("missing category on a product groups it under Uncategorized", () => {
  const report = buildInventoryValuation([product({ category: "" })]);
  assert.equal(report.categories[0].category, "Uncategorized");
});

test("shareOfCategory and shareOfTotal sum to ~100% and are 0 when the group has no value", () => {
  const zero = buildInventoryValuation([product({ costFifo: 0 })]);
  assert.equal(zero.categories[0].shareOfTotal, 0);
  assert.equal(zero.categories[0].products[0].shareOfCategory, 0);

  const report = buildInventoryValuation([
    product({ id: "a", category: "Perfume", costFifo: 10, stockSellable: 3 }), // 30
    product({ id: "b", category: "Perfume", costFifo: 10, stockSellable: 1 }), // 10
  ]);
  const shares = report.categories[0].products.map((p) => p.shareOfCategory);
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 100) < 1e-9);
});

test("parseValuationBucket: invalid value falls back to sellable", () => {
  assert.equal(parseValuationBucket("garbage"), "sellable");
  assert.equal(parseValuationBucket(null), "sellable");
  assert.equal(parseValuationBucket("tester"), "tester");
  assert.equal(parseValuationBucket("all"), "all");
});

test("CSV export escapes commas, quotes, and newlines in names", () => {
  const report = buildInventoryValuation([
    product({ category: 'Notes, "Rare"', name: "Line1\nLine2" }),
  ]);
  const csv = buildInventoryValuationCsv(report);
  assert.ok(csv.includes('"Notes, ""Rare"""'), "comma+quote category not escaped");
  assert.ok(csv.includes('"Line1\nLine2"'), "newline in product name not escaped");
});

test("CSV export handles an empty report without throwing", () => {
  const csv = buildInventoryValuationCsv(buildInventoryValuation([]));
  assert.ok(csv.startsWith("Section,Category,SKUs,Qty,Inventory Value,% of Total"));
});

// OMR has 3 decimals (baisa) — report / dashboard / quotation money must keep them.
test("roundMoney keeps baisa: 6.892 stays 6.892, float noise is removed", () => {
  assert.equal(roundMoney(6.892), 6.892);
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
  assert.equal(roundMoney(1.0005), 1.001);
  assert.equal(roundMoney(Number.NaN), 0);
  assert.equal(roundQty(12.3456), 12.346);
});

test("summing many 3-decimal sales does not drift (was 2-decimal rounding)", () => {
  const totals = Array.from({ length: 100 }, () => 6.892);
  assert.equal(roundMoney(totals.reduce((s, t) => s + t, 0)), 689.2);
});

test("moneyText prints 3 decimals for alerts and SMS", () => {
  assert.equal(moneyText(1234.5), "OMR 1234.500");
  assert.equal(moneyText(0.125, "OMR"), "OMR 0.125");
});

test("quotation totals keep baisa (VAT 5% on 10.125)", () => {
  const t = computeQuotationTotals([{ qty: 1, unitPrice: 10.125 }], 5);
  assert.deepEqual(t, { subtotal: 10.125, vatAmount: 0.506, total: 10.631 });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
