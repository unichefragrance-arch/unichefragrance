/**
 * Unit tests: src/lib/csvCell.ts (shared CSV cell escaping + formula-injection
 * guard) and the inventory valuation CSV export that uses it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { csvCell } from "@/lib/csvCell";
import {
  buildInventoryValuation,
  buildInventoryValuationCsv,
  type ValuationProductInput,
} from "@/lib/reports/inventoryValuation";

describe("csvCell — quoting", () => {
  it("null / undefined → empty; plain text unchanged", () => {
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
    assert.equal(csvCell("Oud"), "Oud");
  });
  it("quotes comma, quote, LF and CR; doubles inner quotes", () => {
    assert.equal(csvCell('Notes, "Rare"'), '"Notes, ""Rare"""');
    assert.equal(csvCell("a\nb"), '"a\nb"');
    assert.equal(csvCell("a\rb"), '"a\rb"');
  });
});

describe("csvCell — formula injection", () => {
  it("each trigger character gets an apostrophe", () => {
    for (const s of ["=1+1", "+cmd", "-2+3", "@SUM(A1)"]) assert.equal(csvCell(s), `'${s}`, s);
  });
  it("whitespace / control prefixes do not hide a formula", () => {
    assert.equal(csvCell(" =1"), "' =1");
    assert.equal(csvCell("\u0001=1"), "'\u0001=1");
    assert.equal(csvCell("\t=1"), "'\t=1");
    assert.equal(csvCell("\tplain"), "'\tplain");
    assert.equal(csvCell("\r=1"), "\"'\r=1\"");
  });
  it("neutralised cell is still quoted when it needs to be", () => {
    assert.equal(csvCell('=HYPERLINK("x","y")'), `"'=HYPERLINK(""x"",""y"")"`);
  });
  it("legitimate data unchanged", () => {
    for (const [v, out] of [[-5, "-5"], [0, "0"], [-0.125, "-0.125"], ["-12.500", "-12.500"], ["2026-10-16", "2026-10-16"], ["a@b.com", "a@b.com"], ["Oud = rose", "Oud = rose"], ["", ""]] as const) {
      assert.equal(csvCell(v), out, String(v));
    }
  });
});

describe("buildInventoryValuationCsv — regression: formula injection", () => {
  const product = (o: Partial<ValuationProductInput>): ValuationProductInput => ({
    id: "p1", sku: "SKU-1", name: "Oud", category: "Brands", brand: "", unit: "ml",
    costFifo: 2, stockSellable: 5, stockTester: 0, stockSample: 0, stockPersonal: 0, ...o,
  });
  const csvFor = (o: Partial<ValuationProductInput>) => buildInventoryValuationCsv(buildInventoryValuation([product(o)]));
  const detailRow = (csv: string) => csv.split("\n").find((l) => l.startsWith("Detail,"))!;

  it("neutralises formulas in category, SKU, name, brand and unit", () => {
    const csv = csvFor({ category: "=cat", sku: "+sku", name: "-1+1", brand: "@brand", unit: "=u" });
    assert.equal(detailRow(csv), "Detail,'=cat,'+sku,'-1+1,'@brand,'=u,5,2,10,100");
    assert.ok(csv.split("\n").some((l) => l.startsWith("Summary,'=cat,")), "summary category protected");
  });
  it("normal products export exactly as before", () => {
    assert.equal(detailRow(csvFor({})), "Detail,Brands,SKU-1,Oud,,ml,5,2,10,100");
  });
  it("existing quoting still works alongside the guard", () => {
    const row = detailRow(csvFor({ name: '=x, "y"' }));
    assert.ok(row.includes(`"'=x, ""y"""`), row);
  });
  it("numeric columns are never prefixed", () => {
    const row = detailRow(csvFor({ costFifo: 0.125, stockSellable: 3 }));
    assert.ok(row.endsWith(",3,0.125,0.375,100"), row);
  });
});
