/**
 * Excel import unit tests (npm run test).
 * Covers sheet row numbers with blank rows, generated-SKU sequencing,
 * and case-insensitive Category / Concentration matching.
 */
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { EXCEL_HEADERS, type ExcelProductRow } from "./columns";
import { parseProductSheet } from "./parse";
import {
  generatedSku,
  nextSkuSeq,
  validateImportRows,
  type ExistingProductRef,
} from "./validate";

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

function row(overrides: Partial<ExcelProductRow> = {}): ExcelProductRow {
  return {
    rowNumber: 2,
    internalCode: "",
    name: "Oud Wood",
    category: "Brands",
    brand: "",
    concentration: "",
    unit: "pcs",
    costPrice: 10,
    retailPrice: 20,
    wholesalePrice: null,
    gender: "",
    size: "",
    collection: "",
    notes: "",
    itemType: "Finished Product",
    ...overrides,
  };
}

function existing(sku: string, name = `Existing ${sku}`): ExistingProductRef {
  return {
    id: sku,
    sku,
    name,
    category: "Brands",
    minMarginPct: 0,
    costFifo: 10,
    sellPrice: 20,
    unit: "pcs",
  };
}

function sheetBuffer(rows: (string | number)[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([[...EXCEL_HEADERS], ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Products");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function dataRow(name: string): (string | number)[] {
  return ["", name, "Brands", "", "", "pcs", 10, 20, "", "", "", "", "", "Finished Product"];
}

console.log("\nExcel import");

// --- parse.ts ---------------------------------------------------------------

test("row numbers match Excel rows", () => {
  const parsed = parseProductSheet(sheetBuffer([dataRow("A"), dataRow("B")]));
  assert.deepEqual(
    parsed.map((r) => r.rowNumber),
    [2, 3],
  );
});

test("row numbers stay correct after blank rows", () => {
  const empty: (string | number)[] = []; // truly empty row: no cells at all
  const parsed = parseProductSheet(
    sheetBuffer([dataRow("A"), empty, empty, dataRow("B")]),
  );
  assert.deepEqual(
    parsed.map((r) => [r.name, r.rowNumber]),
    [
      ["A", 2],
      ["B", 5],
    ],
  );
});

// --- SKU helpers ------------------------------------------------------------

test("nextSkuSeq starts at 1 for an empty catalogue", () => {
  assert.equal(nextSkuSeq([]), 1);
});

test("nextSkuSeq goes past the highest generated SKU, ignoring custom SKUs", () => {
  assert.equal(nextSkuSeq(["UN-BR-0003", "un-rm-0010", "CUSTOM-999", " UN-BK-0007 "]), 11);
});

test("generatedSku pads and uses the category code", () => {
  assert.equal(generatedSku("Brands", 7), "UN-BR-0007");
  assert.equal(generatedSku("", 12), "UN-XX-0012");
});

// --- validateImportRows -----------------------------------------------------

test("new SKUs continue after gaps (deleted products) instead of count+1", () => {
  // 2 products exist but the highest is 0005 — count+1 would give 0003.
  const res = validateImportRows(
    [row({ name: "New One" })],
    [existing("UN-BR-0001"), existing("UN-BR-0005")],
  );
  assert.equal(res[0].action, "create");
  assert.equal(res[0].sku, "UN-BR-0006");
});

test("several new rows get consecutive, unique SKUs", () => {
  const res = validateImportRows(
    [row({ name: "A", rowNumber: 2 }), row({ name: "B", rowNumber: 3 })],
    [],
  );
  assert.deepEqual(
    res.map((r) => r.sku),
    ["UN-BR-0001", "UN-BR-0002"],
  );
});

test("generated SKU skips codes used as Internal Code in the same file", () => {
  const res = validateImportRows(
    [
      row({ name: "Brand New", rowNumber: 2 }),
      row({ name: "Existing UN-BR-0002", internalCode: "UN-BR-0002", rowNumber: 3 }),
    ],
    [existing("UN-BR-0001"), existing("UN-BR-0002")],
  );
  assert.equal(res[0].sku, "UN-BR-0003");
  assert.equal(res[1].action, "update");
});

test("generated SKU never collides with another category's existing SKU number", () => {
  // UN-RM-0001 exists; next Brands product must not reuse sequence 1.
  const res = validateImportRows([row({ name: "X" })], [existing("UN-RM-0001")]);
  assert.equal(res[0].sku, "UN-BR-0002");
});

test("Category matching is case-insensitive and saved in canonical form", () => {
  const res = validateImportRows([row({ category: "body mist", unit: "ml" })], []);
  assert.equal(res[0].action, "create", res[0].errorReason);
  assert.equal(res[0].payload?.category, "Body Mist");
  assert.equal(res[0].sku, "UN-BM-0001");
});

test("Concentration matching is case-insensitive and saved in canonical form", () => {
  const res = validateImportRows([row({ concentration: "edp" })], []);
  assert.equal(res[0].action, "create", res[0].errorReason);
  assert.equal(res[0].payload?.concentration, "EDP");
});

test("unknown Category still errors", () => {
  const res = validateImportRows([row({ category: "Candles" })], []);
  assert.equal(res[0].action, "error");
  assert.match(res[0].errorReason || "", /Category "Candles" isn't on the list/);
});

test("unknown Concentration still errors", () => {
  const res = validateImportRows([row({ concentration: "Cologne" })], []);
  assert.equal(res[0].action, "error");
  assert.match(res[0].errorReason || "", /Concentration "Cologne" isn't on the list/);
});

test("update via Internal Code keeps the snapshot of the existing product", () => {
  const prev = existing("UN-BR-0004", "Oud Wood");
  const res = validateImportRows(
    [row({ internalCode: "un-br-0004", retailPrice: 25 })],
    [prev],
  );
  assert.equal(res[0].action, "update");
  assert.equal(res[0].previousProductSnapshot, prev);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
