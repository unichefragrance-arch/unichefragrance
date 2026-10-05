import type { ItemType, ProductCategory, StockUnit } from "@/lib/types";
import {
  CONCENTRATIONS,
  OIL_CATEGORIES,
  PCS_PREFERRED_CATEGORIES,
  PRODUCT_CATEGORIES,
  STOCK_UNITS,
  categoryCode,
  itemTypeFromLabel,
  type ExcelProductRow,
} from "@/lib/excel/columns";

export interface ExistingProductRef {
  id: string;
  sku: string;
  name: string;
  category: string;
  minMarginPct: number;
  costFifo: number;
  sellPrice: number;
  wholesalePrice?: number;
  brand?: string;
  concentration?: string;
  gender?: string;
  size?: string;
  collection?: string;
  notes?: string;
  itemType?: string;
  unit: string;
}

export interface ValidatedImportRow {
  rowNumber: number;
  action: "create" | "update" | "error";
  sku: string;
  errorReason?: string;
  priceFloorViolation?: boolean;
  payload?: {
    sku: string;
    name: string;
    category: ProductCategory;
    unit: StockUnit;
    brand: string;
    concentration: string;
    costFifo: number;
    sellPrice: number;
    wholesalePrice: number;
    gender: string;
    size: string;
    collection: string;
    notes: string;
    itemType: ItemType;
    minMarginPct: number;
  };
  previousProductSnapshot?: ExistingProductRef;
}

function parseSizeNumber(size: string): number | null {
  if (!size.trim()) return null;
  const m = size.trim().match(/^(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]);
}

const GENERATED_SKU_RE = /^UN-[A-Z]{2}-(\d+)$/i;

/** Next free generated-SKU sequence number, past every existing UN-XX-NNNN SKU. */
export function nextSkuSeq(existingSkus: Iterable<string>): number {
  let max = 0;
  for (const sku of existingSkus) {
    const m = sku.trim().match(GENERATED_SKU_RE);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function generatedSku(category: string, seq: number): string {
  return `UN-${categoryCode(category || "XX")}-${String(seq).padStart(4, "0")}`;
}

function priceFloorOk(retail: number, cost: number, minMarginPct: number): boolean {
  const floor = cost * (1 + minMarginPct / 100);
  return retail + 1e-9 >= floor;
}

export function validateImportRows(
  rows: ExcelProductRow[],
  existing: ExistingProductRef[],
  opts?: { defaultMinMarginPct?: number; allowPriceFloorOverride?: boolean },
): ValidatedImportRow[] {
  const defaultMargin = opts?.defaultMinMarginPct ?? 0;
  const allowFloor = opts?.allowPriceFloorOverride ?? false;
  const bySku = new Map(existing.map((p) => [p.sku.toLowerCase(), p]));
  const nameCatKeys = new Map<string, string>(); // key -> sku
  for (const p of existing) {
    nameCatKeys.set(`${p.name.toLowerCase()}||${p.category.toLowerCase()}`, p.sku);
  }

  const fileNameCat = new Map<string, number>();
  const fileSkus = new Map<string, number>();
  const results: ValidatedImportRow[] = [];
  const takenSkus = new Set(existing.map((p) => p.sku.toLowerCase()));
  for (const row of rows) {
    const code = row.internalCode.trim().toLowerCase();
    if (code) takenSkus.add(code);
  }
  let createSeq = nextSkuSeq(existing.map((p) => p.sku));

  for (const row of rows) {
    const errors: string[] = [];

    if (!row.name) errors.push("Missing Product Name");
    if (!row.category) errors.push("Missing Category — pick one from the Lists sheet");
    if (!row.unit) errors.push("Missing Unit — use ml, pcs, g, or kg");
    if (row.costPrice == null) errors.push("Missing Cost Price");
    if (row.retailPrice == null) errors.push("Missing Retail Price");
    if (!row.itemType) errors.push("Missing Item Type — pick one from the Lists sheet");

    const category = (PRODUCT_CATEGORIES.find(
      (c) => c.toLowerCase() === row.category.toLowerCase(),
    ) ?? row.category) as ProductCategory;
    if (row.category && !PRODUCT_CATEGORIES.includes(category)) {
      errors.push(`Category "${row.category}" isn't on the list — pick one from the Lists sheet`);
    }

    const unit = row.unit as StockUnit;
    if (row.unit && !STOCK_UNITS.includes(unit)) {
      errors.push(`Unit "${row.unit}" isn't valid — use ml, pcs, g, or kg`);
    }

    const concentration =
      CONCENTRATIONS.find((c) => c.toLowerCase() === row.concentration.toLowerCase()) ??
      row.concentration;
    if (
      concentration &&
      !CONCENTRATIONS.includes(concentration as (typeof CONCENTRATIONS)[number])
    ) {
      errors.push(`Concentration "${row.concentration}" isn't on the list — pick one from the Lists sheet`);
    }

    const itemType = itemTypeFromLabel(row.itemType);
    if (row.itemType && !itemType) {
      errors.push(
        `Item Type "${row.itemType}" isn't valid — use Finished Product, Packaging Component, or Raw Material`,
      );
    }

    if (row.costPrice != null && row.costPrice < 0) errors.push("Cost Price can't be negative");
    if (row.retailPrice != null && row.retailPrice < 0) errors.push("Retail Price can't be negative");
    if (row.wholesalePrice != null && row.wholesalePrice < 0) {
      errors.push("Wholesale Price can't be negative");
    }
    if (row.costPrice === 0 && row.retailPrice === 0) {
      errors.push("Cost Price and Retail Price can't both be 0");
    }

    if (PRODUCT_CATEGORIES.includes(category) && STOCK_UNITS.includes(unit)) {
      if (OIL_CATEGORIES.has(category) && unit !== "ml") {
        errors.push(`"${category}" products must use Unit = ml`);
      }
      if (PCS_PREFERRED_CATEGORIES.has(category) && unit !== "pcs") {
        errors.push(`"${category}" products must use Unit = pcs`);
      }
      if (OIL_CATEGORIES.has(category) && row.size) {
        const sizeNum = parseSizeNumber(row.size);
        if (sizeNum != null && sizeNum % 5 !== 0) {
          errors.push("Size must be a multiple of 5 ml (e.g. 5, 10, 15...)");
        }
      }
    }

    const nameCatKey = `${row.name.toLowerCase()}||${row.category.toLowerCase()}`;
    if (row.name && row.category) {
      if (fileNameCat.has(nameCatKey)) {
        errors.push(
          `Same Product Name + Category used twice in this file (also row ${fileNameCat.get(nameCatKey)}) — each product needs to be unique`,
        );
      } else {
        fileNameCat.set(nameCatKey, row.rowNumber);
      }
    }

    let existingProduct: ExistingProductRef | undefined;
    let sku = row.internalCode.trim();
    let action: "create" | "update" = "create";

    if (sku) {
      if (fileSkus.has(sku.toLowerCase())) {
        errors.push(
          `Internal Code "${sku}" used twice in this file (also row ${fileSkus.get(sku.toLowerCase())})`,
        );
      } else {
        fileSkus.set(sku.toLowerCase(), row.rowNumber);
      }
      existingProduct = bySku.get(sku.toLowerCase());
      if (!existingProduct) {
        errors.push(`No existing product has Internal Code "${sku}" — leave it blank to add this as a new product`);
      } else {
        action = "update";
        const otherSku = nameCatKeys.get(nameCatKey);
        if (otherSku && otherSku.toLowerCase() !== sku.toLowerCase()) {
          errors.push(`This Product Name + Category is already used by Internal Code "${otherSku}" — check for a typo`);
        }
      }
    } else {
      const clash = nameCatKeys.get(nameCatKey);
      if (clash) {
        errors.push(
          `A product with this Name + Category already exists (Internal Code "${clash}") — fill in Internal Code to update it instead`,
        );
      }
      do {
        sku = generatedSku(category, createSeq);
        createSeq += 1;
      } while (takenSkus.has(sku.toLowerCase()));
      takenSkus.add(sku.toLowerCase());
      action = "create";
    }

    const minMarginPct = existingProduct?.minMarginPct ?? defaultMargin;
    let priceFloorViolation = false;
    if (
      row.costPrice != null &&
      row.retailPrice != null &&
      row.costPrice >= 0 &&
      row.retailPrice >= 0 &&
      !priceFloorOk(row.retailPrice, row.costPrice, minMarginPct)
    ) {
      priceFloorViolation = true;
      if (!allowFloor) {
        const floor = row.costPrice * (1 + minMarginPct / 100);
        errors.push(
          `Retail Price is too low — needs to be at least ${floor.toFixed(2)} for this product's ${minMarginPct}% minimum margin`,
        );
      }
    }

    if (errors.length > 0) {
      results.push({
        rowNumber: row.rowNumber,
        action: "error",
        sku: row.internalCode || sku,
        errorReason: errors.join("; "),
        priceFloorViolation,
      });
      continue;
    }

    results.push({
      rowNumber: row.rowNumber,
      action,
      sku,
      priceFloorViolation,
      previousProductSnapshot: existingProduct,
      payload: {
        sku,
        name: row.name,
        category,
        unit,
        brand: row.brand,
        concentration,
        costFifo: row.costPrice!,
        sellPrice: row.retailPrice!,
        wholesalePrice: row.wholesalePrice ?? 0,
        gender: row.gender,
        size: row.size,
        collection: row.collection,
        notes: row.notes,
        itemType: itemType!,
        minMarginPct,
      },
    });
  }

  return results;
}
