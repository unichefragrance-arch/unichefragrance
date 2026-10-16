/**
 * Unit tests: formulas (liquid ml, materials reservation, mapFormula/public, audit),
 * mappers (serialize, mapUserPublic, mapProductionOrder, customerProfileFields),
 * Excel column helpers + error report, report CSV, discount limits, report registry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { liquidMlOf, sumLiquidMl } from "@/lib/formulas/validateFormula";
import { buildMaterialsReservation, clearMaterialsReservation } from "@/lib/formulas/materialsReservation";
import { makeAuditEntry, mapFormula, mapFormulaPublic } from "@/lib/formulas/mapFormula";
import { OIL_BASE_PRODUCT_ID } from "@/lib/sales/constants";
import { toJSON, toJSONList } from "@/lib/serialize";
import { mapUserPublic } from "@/lib/auth/mapUser";
import { mapProductionOrder } from "@/lib/production/mapProduction";
import { customerProfileFields } from "@/lib/customers/profileFields";
import { categoryCode, EXCEL_HEADERS, itemTypeFromLabel, itemTypeToLabel, PRODUCT_CATEGORIES } from "@/lib/excel/columns";
import { buildErrorReport } from "@/lib/excel/errorReport";
import { reportToCsv } from "@/lib/reporting-engine/export/csv";
import { discountLimitFor, exceedsDiscountLimit } from "@/lib/sales/discount";
import { getReport, listReportsForRole, registerReport } from "@/lib/reporting-engine/registry";
import type { FormulaComponent } from "@/lib/types";
import type { ReportDefinition, ReportResult } from "@/lib/reporting-engine/types";

process.env.TZ = "UTC";

describe("liquidMlOf — one branch per unit", () => {
  it("ml and g count 1:1, kg ×1000, pcs and unknown → 0", () => {
    assert.equal(liquidMlOf({ qty: 5, unit: "ml" }), 5);
    assert.equal(liquidMlOf({ qty: 5, unit: "g" }), 5);
    assert.equal(liquidMlOf({ qty: 0.02, unit: "kg" }), 20);
    assert.equal(liquidMlOf({ qty: 5, unit: "pcs" }), 0);
    assert.equal(liquidMlOf({ qty: 5, unit: "L" as never }), 0);
  });
  it("non-finite qty → 0 (guard branch)", () => {
    for (const q of [NaN, Infinity, "abc" as never, undefined as never]) assert.equal(liquidMlOf({ qty: q, unit: "ml" }), 0);
  });
  it("numeric strings are coerced; negatives pass through", () => {
    assert.equal(liquidMlOf({ qty: "7.5" as never, unit: "ml" }), 7.5);
    assert.equal(liquidMlOf({ qty: -2, unit: "ml" }), -2);
  });
  it("sumLiquidMl: empty → 0; mixed units summed", () => {
    assert.equal(sumLiquidMl([]), 0);
    assert.equal(sumLiquidMl([{ qty: 20, unit: "ml" }, { qty: 1, unit: "pcs" }, { qty: 0.03, unit: "kg" }]), 50);
  });
});

describe("materials reservation — state", () => {
  const comp = (o: Partial<FormulaComponent>) => ({ productId: "p1", productName: "Ethanol", qty: 10, unit: "ml", ...o }) as FormulaComponent;

  it("not approved → inactive, no lines (even with components)", () => {
    assert.deepEqual(buildMaterialsReservation([comp({})], false), { active: false, lines: [] });
  });
  it("approved → active with reservedAt and filtered lines", () => {
    const r = buildMaterialsReservation([
      comp({}),
      comp({ productId: OIL_BASE_PRODUCT_ID }),
      comp({ productId: "" }),
      comp({ qty: 0 }),
      comp({ qty: -1 }),
      comp({ productId: "p2", productName: "", unit: "" as never, qty: "3" as never }),
    ], true);
    assert.equal(r.active, true);
    assert.ok(r.reservedAt instanceof Date);
    assert.deepEqual(r.lines, [
      { productId: "p1", productName: "Ethanol", qty: 10, unit: "ml" },
      { productId: "p2", productName: "Component", qty: 3, unit: "ml" },
    ]);
  });
  it("approved with undefined / null entries is safe", () => {
    assert.deepEqual(buildMaterialsReservation(undefined, true).lines, []);
    assert.deepEqual(buildMaterialsReservation([null as never], true).lines, []);
  });
  it("transition approved → cleared returns a fresh inactive state", () => {
    const active = buildMaterialsReservation([comp({})], true);
    const cleared = clearMaterialsReservation();
    assert.deepEqual(cleared, { active: false, lines: [] });
    assert.equal(active.lines.length, 1, "clearing does not mutate the old reservation");
    assert.notEqual(clearMaterialsReservation(), clearMaterialsReservation(), "new object each time");
  });
});

describe("mapFormula", () => {
  it("defaults for a bare record", () => {
    const f = mapFormula({ id: "f1" });
    assert.deepEqual(
      [f.status, f.version, f.versions, f.history, f.materialsReservation, f.customerId, f.approvedAt, f.updatedAt],
      ["draft", 1, [], [], { active: false, lines: [] }, undefined, undefined, undefined],
    );
  });
  it("version must be a number to be kept", () => {
    assert.equal(mapFormula({ version: 3 }).version, 3);
    assert.equal(mapFormula({ version: "3" }).version, 1);
    assert.equal(mapFormula({ version: 0 }).version, 0);
  });
  it("formats dates and stringifies ids", () => {
    const f = mapFormula({
      customerId: { toString: () => "c9" },
      approvedAt: "2026-10-16T22:15:00Z",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      versions: [{ customerId: 5, savedAt: "2026-02-03T04:05:06Z" }, {}],
      history: [{ at: "2026-02-03T04:05:06Z", action: "approved" }, { action: "x" }],
      materialsReservation: { active: 1, reservedAt: "2026-03-01", lines: "nope" },
    });
    assert.equal(f.customerId, "c9");
    assert.equal(f.approvedAt, "2026-10-16");
    assert.equal(f.updatedAt, "2026-01-01");
    assert.deepEqual(f.versions[0], { customerId: "5", savedAt: "2026-02-03" });
    assert.deepEqual(f.versions[1], { customerId: undefined, savedAt: undefined });
    assert.equal(f.history[0].at, "2026-02-03 04:05");
    assert.equal(f.history[1].at, undefined);
    assert.deepEqual(f.materialsReservation, { active: true, reservedAt: "2026-03-01", lines: [] });
  });
  it("invalid date string throws RangeError", () => {
    assert.throws(() => mapFormula({ approvedAt: "not a date" }), RangeError);
  });
});

describe("mapFormulaPublic — recipe is hidden; oil hint branches", () => {
  const base = { id: "f1", name: "Blend", type: "remix", yieldMl: 50, history: [{ at: "2026-01-01" }], materialsReservation: { active: true, lines: [{ qty: 5 }] } };

  it("never exposes components, versions, history or reservation lines", () => {
    const p = mapFormulaPublic({ ...base, components: [{ productId: "p1", unit: "ml" }] });
    assert.deepEqual([p.components, p.versions, p.history, p.materialsReservation], [[], [], [], { active: true, lines: [] }]);
    assert.equal(p.recipeHidden, true);
    assert.equal("notes" in p, false);
  });
  it("oil-base placeholder → needs oil selection, no oil id", () => {
    const p = mapFormulaPublic({ ...base, components: [{ productId: OIL_BASE_PRODUCT_ID, unit: "ml" }, { productId: "p1", unit: "ml" }] });
    assert.deepEqual(p.reuseHints, { needsOilSelection: true, oilProductId: undefined, oilProductName: undefined });
  });
  it("concrete ml oil → hint carries that oil", () => {
    const p = mapFormulaPublic({ ...base, components: [{ productId: "bottle", unit: "pcs" }, { productId: "oud", productName: "Oud", unit: "ml" }] });
    assert.deepEqual(p.reuseHints, { needsOilSelection: false, oilProductId: "oud", oilProductName: "Oud" });
  });
  it("no ml component / no components → needs oil selection", () => {
    assert.equal(mapFormulaPublic({ ...base, components: [{ productId: "b", unit: "pcs" }] }).reuseHints.needsOilSelection, true);
    assert.equal(mapFormulaPublic({ ...base }).reuseHints.needsOilSelection, true);
    assert.equal(mapFormulaPublic({ ...base, components: [{ unit: "ml" }] }).reuseHints.needsOilSelection, true, "ml without productId");
  });
});

describe("makeAuditEntry", () => {
  it("by defaults to Admin; empty string too", () => {
    assert.equal(makeAuditEntry({ action: "approved" as never }).by, "Admin");
    assert.equal(makeAuditEntry({ action: "approved" as never, by: "" }).by, "Admin");
    assert.equal(makeAuditEntry({ action: "approved" as never, by: "Sara" }).by, "Sara");
  });
  it("stamps the current time and copies status/version fields", () => {
    const before = Date.now();
    const e = makeAuditEntry({ action: "edited" as never, fromStatus: "draft", toStatus: "approved", fromVersion: 1, toVersion: 2, detail: "d" });
    assert.ok(e.at.getTime() >= before && e.at.getTime() <= Date.now());
    assert.deepEqual([e.fromStatus, e.toStatus, e.fromVersion, e.toVersion, e.detail], ["draft", "approved", 1, 2, "d"]);
  });
});

describe("toJSON / toJSONList", () => {
  it("null/undefined → null", () => {
    assert.equal(toJSON(null), null);
    assert.equal(toJSON(undefined), null);
  });
  it("plain object: _id → id, __v dropped, input not mutated", () => {
    const src = { _id: { toString: () => "abc" }, __v: 3, name: "x" };
    assert.deepEqual(toJSON(src), { name: "x", id: "abc" });
    assert.ok("_id" in src && "__v" in src);
  });
  it("uses toObject() when present (mongoose doc branch)", () => {
    const doc = { toObject: () => ({ _id: 7, a: 1 }) };
    assert.deepEqual(toJSON(doc), { a: 1, id: "7" });
  });
  it("falls back to existing id; no id at all → 'undefined'", () => {
    assert.equal(toJSON({ id: "keep" })!.id, "keep");
    assert.equal(toJSON({ a: 1 })!.id, "undefined");
  });
  it("toJSONList maps each and handles empty", () => {
    assert.deepEqual(toJSONList([]), []);
    assert.deepEqual(toJSONList([{ _id: 1 }, { _id: 2 }]).map((d) => d.id), ["1", "2"]);
  });
});

describe("mapUserPublic", () => {
  it("null → null", () => assert.equal(mapUserPublic(null), null));
  it("never returns passwordHash; normalises fields", () => {
    const u = mapUserPublic({
      _id: "u1", name: "Sara", email: "SARA@X.COM", role: "cashier", roleLabel: "",
      branchId: { toString: () => "b1" }, branchName: "Muscat", active: true,
      lastLoginAt: "2026-10-16T10:00:00Z", createdAt: new Date("2026-01-01T00:00:00Z"), passwordHash: "scrypt$x$y",
    });
    assert.ok(u);
    assert.equal("passwordHash" in u, false);
    assert.equal(u.email, "sara@x.com");
    assert.equal(u.roleLabel, "cashier", "empty label falls back to role");
    assert.equal(u.branchId, "b1");
    assert.equal(u.lastLoginAt, "2026-10-16T10:00:00.000Z");
    assert.equal(u.updatedAt, undefined);
  });
  it("active is true unless explicitly false", () => {
    const mk = (active: unknown) => mapUserPublic({ _id: "u", name: "", email: "", role: "owner", roleLabel: "Owner", active } as never)!.active;
    assert.equal(mk(true), true);
    assert.equal(mk(undefined), true);
    assert.equal(mk(false), false);
  });
  it("missing branch → nulls", () => {
    const u = mapUserPublic({ _id: "u", name: "A", email: "a", role: "owner", roleLabel: "Owner", active: true, branchId: null, branchName: "" })!;
    assert.deepEqual([u.branchId, u.branchName, u.lastLoginAt], [null, null, null]);
  });
});

describe("mapProductionOrder", () => {
  it("bare order: ids stringified, arrays default, batch null", () => {
    const o = mapProductionOrder({ formulaId: 1, outputProductId: 2 });
    assert.deepEqual(
      [o.formulaId, o.outputProductId, o.oilProductId, o.plannedLines, o.consumption, o.batch, o.completedAt],
      ["1", "2", undefined, [], [], null, undefined],
    );
  });
  it("date formats: minutes for timestamps, day for updatedAt and purchaseDate", () => {
    const o = mapProductionOrder({
      formulaId: "f", outputProductId: "o", oilProductId: "oil",
      completedAt: "2026-10-16T08:09:10Z", updatedAt: "2026-10-16T08:09:10Z",
      plannedLines: [{ productId: 9, qty: 1 }],
      consumption: [{ productId: 3, batches: [{ layerId: 4, purchaseDate: "2026-05-06T00:00:00Z" }, { layerId: 5 }] }, { productId: 6 }],
      batch: { outputProductId: 7, producedAt: "2026-10-16T08:09:10Z" },
    });
    assert.equal(o.completedAt, "2026-10-16 08:09");
    assert.equal(o.updatedAt, "2026-10-16");
    assert.equal(o.oilProductId, "oil");
    assert.deepEqual(o.plannedLines, [{ productId: "9", qty: 1 }]);
    assert.deepEqual(o.consumption[0].batches, [
      { layerId: "4", purchaseDate: "2026-05-06" },
      { layerId: "5", purchaseDate: undefined },
    ]);
    assert.deepEqual(o.consumption[1].batches, []);
    assert.deepEqual(o.batch, { outputProductId: "7", fifoLayerId: undefined, producedAt: "2026-10-16 08:09" });
  });
  it("regression: missing ids become '' — never the text 'undefined' or 'null'", () => {
    const o = mapProductionOrder({
      formulaId: null,
      plannedLines: [{ qty: 1 }],
      consumption: [{ batches: [{ purchaseDate: null }] }],
      batch: { producedAt: null },
    });
    assert.equal(o.formulaId, "");
    assert.equal(o.outputProductId, "");
    assert.equal(o.plannedLines[0].productId, "");
    assert.equal(o.consumption[0].productId, "");
    assert.equal(o.consumption[0].batches[0].layerId, "");
    assert.equal(o.batch?.outputProductId, "");
    assert.ok(!/undefined|null/.test(JSON.stringify(o)), JSON.stringify(o));
  });
  it("falsy-but-real ids (0) are kept", () => {
    assert.equal(mapProductionOrder({ formulaId: 0, outputProductId: 0 }).formulaId, "0");
  });
});

describe("customerProfileFields — allow-list", () => {
  it("non-object bodies → {}", () => {
    for (const b of [null, undefined, "x", 5, true]) assert.deepEqual(customerProfileFields(b), {});
  });
  it("trims strings, null → '', omits undefined keys", () => {
    assert.deepEqual(customerProfileFields({ name: "  Ali ", phone: null, email: 5 }), { name: "Ali", phone: "", email: "5" });
  });
  it("never passes money/history fields through", () => {
    const out = customerProfileFields({ name: "A", creditBalance: 999, totalPurchases: 1, lastVisit: "x", _id: "y", branchId: "z" });
    assert.deepEqual(out, { name: "A" });
  });
  it("lists: trimmed, empties removed, non-array → []", () => {
    assert.deepEqual(customerProfileFields({ preferences: [" oud ", "", null, "  ", 3] }), { preferences: ["oud", "3"] });
    assert.deepEqual(customerProfileFields({ productsRequested: "oud" }), { productsRequested: [] });
  });
  it("hasCustomFormula only when a real boolean", () => {
    assert.deepEqual(customerProfileFields({ hasCustomFormula: false }), { hasCustomFormula: false });
    assert.deepEqual(customerProfileFields({ hasCustomFormula: "true" }), {});
  });
});

describe("Excel column helpers", () => {
  it("itemTypeFromLabel accepts short and long labels, any case/padding", () => {
    const rows: [string, string | null][] = [
      ["finished", "finished"], [" Finished Product ", "finished"],
      ["PACKAGING", "packaging"], ["packaging component", "packaging"],
      ["raw", "raw"], ["Raw Material", "raw"],
      ["", null], ["   ", null], ["rawmaterial", null], ["finish", null],
    ];
    for (const [input, expected] of rows) assert.equal(itemTypeFromLabel(input), expected, JSON.stringify(input));
  });
  it("itemTypeToLabel ↔ itemTypeFromLabel round-trip", () => {
    for (const t of ["finished", "packaging", "raw"] as const) assert.equal(itemTypeFromLabel(itemTypeToLabel(t)), t);
  });
  it("categoryCode: every category has a unique 2-letter code; unknown → XX", () => {
    const codes = PRODUCT_CATEGORIES.map(categoryCode);
    assert.ok(codes.every((c) => /^[A-Z]{2}$/.test(c) && c !== "XX"));
    assert.equal(new Set(codes).size, codes.length);
    for (const c of ["", "brands", " Brands", "Other"]) assert.equal(categoryCode(c), "XX", c);
  });
});

describe("buildErrorReport — round-trips through xlsx", () => {
  const read = (buf: Buffer) => {
    const wb = XLSX.read(buf, { type: "buffer" });
    assert.deepEqual(wb.SheetNames, ["Failed Rows"]);
    return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Failed Rows"], { header: 1, defval: "" });
  };
  it("empty list → header row only", () => {
    const rows = read(buildErrorReport([]));
    assert.deepEqual(rows, [[...EXCEL_HEADERS, "Error Reason", "Source Row"]]);
  });
  it("payload values map to their columns; sku falls back to f.sku", () => {
    const rows = read(buildErrorReport([
      { rowNumber: 3, sku: "S-1", errorReason: "Missing price", payload: { name: "Oud, \"royal\"", category: "Brands", sellPrice: 12.5 } },
      { rowNumber: 4, errorReason: "Bad", payload: null },
    ]));
    assert.equal(rows.length, 3);
    const [r1, r2] = [rows[1], rows[2]];
    assert.deepEqual([r1[0], r1[1], r1[2], r1[7], r1[14], r1[15]], ["S-1", "Oud, \"royal\"", "Brands", 12.5, "Missing price", 3]);
    assert.deepEqual([r2[0], r2[14], r2[15]], ["", "Bad", 4]);
  });
});

describe("reportToCsv — CSV escaping", () => {
  const result = (rows: ReportResult["rows"]): ReportResult => ({
    id: "r", label: "R", category: "sales" as never, generatedAt: "", range: { from: "", to: "" }, branchId: null,
    columns: [{ key: "a", label: "Name, full" }, { key: "b", label: "Total" }] as never,
    rows, totals: {}, compareTotals: null,
  });
  it("header only for no rows; CRLF line endings", () => {
    assert.equal(reportToCsv(result([])), '"Name, full",Total');
    assert.equal(reportToCsv(result([{ a: "x", b: 1 }, { a: "y", b: 2 }])), '"Name, full",Total\r\nx,1\r\ny,2');
  });
  it("quotes commas, quotes and newlines; doubles inner quotes", () => {
    assert.equal(reportToCsv(result([{ a: 'He said "hi"', b: "1,000" }])).split("\r\n")[1], '"He said ""hi""","1,000"');
    assert.equal(reportToCsv(result([{ a: "line1\nline2", b: 0 }])).split("\r\n")[1], '"line1\nline2",0');
  });
  it("null and missing cells are empty", () => {
    assert.equal(reportToCsv(result([{ a: null, b: undefined as never }])).split("\r\n")[1], ",");
  });
  const cell = (a: string | number) => reportToCsv(result([{ a, b: "" }])).split("\r\n").slice(1).join("\r\n").replace(/,$/, "");
  it("regression: text starting with = + - @ gets a leading apostrophe", () => {
    assert.equal(cell("=1+1"), "'=1+1");
    assert.equal(cell("+cmd"), "'+cmd");
    assert.equal(cell("-2+3"), "'-2+3");
    assert.equal(cell("@SUM(A1)"), "'@SUM(A1)");
    assert.equal(cell('=HYPERLINK("http://x","y")'), '"\'=HYPERLINK(""http://x"",""y"")"');
  });
  it("regression: leading whitespace / control characters do not hide a formula", () => {
    assert.equal(cell(" =1+1"), "' =1+1");
    assert.equal(cell("\u0001=1"), "'\u0001=1");
    assert.equal(cell("\t=1"), "'\t=1");
    assert.equal(cell("\r=1"), `"'\r=1"`);
    assert.equal(cell("\tplain"), "'\tplain", "leading tab is neutralised too");
  });
  it("legitimate data is unchanged: numbers, plain negative strings, inner symbols", () => {
    assert.equal(cell(-5), "-5");
    assert.equal(cell(-0.125), "-0.125");
    assert.equal(cell("-12.500"), "-12.500");
    assert.equal(cell("Oud = rose"), "Oud = rose");
    assert.equal(cell("a@b.com"), "a@b.com");
    assert.equal(cell("2026-10-16"), "2026-10-16");
    assert.equal(cell(""), "");
  });
  it("header labels are protected the same way", () => {
    const r = { ...result([]), columns: [{ key: "a", label: "=evil" }] as never };
    assert.equal(reportToCsv(r), "'=evil");
  });
});

describe("discountLimitFor", () => {
  it("per-role limits", () => {
    assert.deepEqual(
      (["owner", "manager", "branch_manager", "cashier", "accountant", "inventory"] as const).map(discountLimitFor),
      [100, 50, 20, 10, 0, 0],
    );
  });
  it("unknown / null / undefined / wrong case → 0", () => {
    for (const r of ["ghost", "", null, undefined, "Owner"]) {
      assert.equal(discountLimitFor(r), 0, String(r));
    }
  });
  it("regression: Object.prototype names resolve to 0, not inherited members", () => {
    for (const r of ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"]) {
      assert.equal(discountLimitFor(r), 0, r);
    }
  });
  it("regression: inherited names can no longer bypass exceedsDiscountLimit", () => {
    for (const r of ["toString", "__proto__", "constructor"]) {
      assert.equal(exceedsDiscountLimit({ rawMaxDiscountPct: 99 }, r), true, r);
      assert.equal(exceedsDiscountLimit({ rawMaxDiscountPct: 0.01 }, r), true, r);
    }
  });
  it("non-string roles → 0", () => {
    for (const r of [1, {}, ["owner"], true]) assert.equal(discountLimitFor(r as never), 0);
  });
  it("limits still apply at the exact boundary", () => {
    assert.equal(exceedsDiscountLimit({ rawMaxDiscountPct: 10 }, "cashier"), false);
    assert.equal(exceedsDiscountLimit({ rawMaxDiscountPct: 10.001 }, "cashier"), true);
    assert.equal(exceedsDiscountLimit({ rawMaxDiscountPct: 100 }, "owner"), false);
  });
});

describe("report registry — state", () => {
  const def = (id: string, category: string): ReportDefinition => ({
    id, label: id, description: "", category: category as never, branchScoped: false, columns: [],
    run: async () => ({ rows: [], totals: {} }),
  });
  it("unknown id → null", () => assert.equal(getReport("unit-test-missing"), null));
  it("register → get returns the same definition; duplicate id throws", () => {
    const d = def("unit-test-hr", "hr");
    registerReport(d);
    assert.equal(getReport("unit-test-hr"), d);
    assert.throws(() => registerReport(def("unit-test-hr", "sales")), /already registered/);
    assert.equal(getReport("unit-test-hr")?.category, "hr", "failed duplicate did not overwrite");
  });
  it("listReportsForRole filters by category access", () => {
    registerReport(def("unit-test-sales", "sales"));
    const ids = (role: string) => listReportsForRole(role as never).map((r) => r.id);
    assert.ok(ids("owner").includes("unit-test-hr"));
    assert.ok(!ids("cashier").includes("unit-test-hr"));
    assert.ok(ids("cashier").includes("unit-test-sales"));
    assert.deepEqual(ids("ghost"), []);
  });
});
