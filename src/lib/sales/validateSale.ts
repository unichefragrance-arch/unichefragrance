import mongoose from "mongoose";
import { resolveDeductMlFromUnitLabel, resolveOilTolaMl } from "@/lib/format";
import { Formula, Product } from "@/lib/models";
import {
  OIL_BASE_PRODUCT_ID,
  REFILL_OMR_PER_ML,
  REFILL_CUSTOMER_BOTTLE_ML,
  REMIX_OIL_ML,
  REMIX_COMPONENT_ROLES,
  REMIX_REQUIRED_ROLES,
  matchRemixRole,
  roleLabel,
  type RemixRole,
} from "@/lib/sales/constants";
import { SaleError } from "@/lib/sales/errors";

export type IncomingSaleLine = {
  productId?: string;
  name?: string;
  qty: number;
  unitLabel?: string;
  unitPrice?: number;
  lineType: string;
  bomNote?: string;
  deductMl?: number;
  oilProductId?: string;
  /** Ignored for remix — backend uses formula oil qty. */
  oilMl?: number;
  packagingProductIds?: string[];
  /** BLD-08: reuse a specific (customer) formula instead of the default remix BOM. */
  formulaId?: string;
  /** POS-069: `{ type: "percent" | "amount", value }` — validated in sales/discount. */
  discount?: unknown;
};

export type DeductionNeed = {
  productId: string;
  productName: string;
  qty: number;
  reason: string;
  lineIndex: number;
};

export type ValidatedSaleLine = {
  productId?: string;
  name: string;
  qty: number;
  unitLabel: string;
  unitPrice: number;
  lineType: "ready" | "remix" | "oil" | "refill" | "packaging" | "wholesale";
  bomNote?: string;
  deductMl?: number;
  oilProductId?: string;
  oilMl?: number;
  packagingProductIds?: string[];
  formulaId?: string;
};

export type SaleValidationResult = {
  lines: ValidatedSaleLine[];
  deductions: DeductionNeed[];
  subtotal: number;
};

type FormulaDoc = {
  _id?: mongoose.Types.ObjectId;
  components: Array<{
    productId: string;
    productName: string;
    qty: number;
    unit: string;
  }>;
  yieldMl: number;
  name: string;
  customerId?: mongoose.Types.ObjectId | null;
  status?: string;
  type?: string;
};

type ProductLean = {
  _id: mongoose.Types.ObjectId;
  name: string;
  sku?: string;
  unit: string;
  category?: string;
  sellPrice: number;
  wholesalePrice?: number;
  stockSellable?: number;
};

/**
 * A sellable oil: sold by ml, not packaging/raw stock, and not a remix BOM
 * role (ethanol / fixative are ml too). Mirrors the POS oil list so the API
 * can't be used to sell or blend non-oils as "oil".
 */
function assertIsOil(product: ProductLean, code: "OIL_NOT_SELECTED" | "INVALID_LINE", context: string) {
  if (product.unit !== "ml") {
    throw new SaleError(code, `${context}: selected product must be sold by ml`);
  }
  if (product.category === "Packaging" || matchRemixRole(product.name, product.sku)) {
    throw new SaleError(code, `${context}: ${product.name} is not an oil`);
  }
}

/** Sale quantities are whole units (pieces, or N × an approved oil size) — no fractions. */
function assertPositiveQty(qty: number, label: string) {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new SaleError(
      "INVALID_LINE",
      `Invalid quantity for ${label} — must be a whole number of at least 1`,
    );
  }
}

function resolvePriceFromProduct(
  product: ProductLean,
  lineType: string,
): { name: string; unitPrice: number; unit: string } {
  const unitPrice =
    lineType === "wholesale" && (product.wholesalePrice ?? 0) > 0
      ? product.wholesalePrice!
      : product.sellPrice;
  return { name: product.name, unitPrice, unit: product.unit };
}

async function resolveComponentProduct(
  productsById: Map<string, ProductLean>,
  productId: string,
  productName: string,
): Promise<ProductLean> {
  let product = productsById.get(productId);
  if (!product) {
    const loaded = await Product.findById(productId).lean<ProductLean>();
    if (!loaded) {
      throw new SaleError(
        "FORMULA_INCOMPLETE",
        `Formula incomplete: product not found for ${productName}`,
      );
    }
    product = loaded;
    productsById.set(productId, product);
  }
  return product;
}

/**
 * Customer blend (BLD-08 reuse): concrete oils in the formula, no oil-base.
 * Deducts every component; fills missing packaging/ethanol/fixative from fallback BOM.
 */
async function validateCustomerBlendSale(
  formula: FormulaDoc,
  options: {
    lineQty: number;
    lineIndex: number;
    productsById: Map<string, ProductLean>;
    packagingFallback?: FormulaDoc | null;
  },
): Promise<{
  oilMl: number;
  oilProductId?: string;
  oilProductName?: string;
  componentDeductions: DeductionNeed[];
}> {
  const { lineQty, lineIndex, productsById } = options;
  const foundRoles = new Map<RemixRole, FormulaDoc["components"][number]>();
  const componentDeductions: DeductionNeed[] = [];
  let oilMl = 0;
  let primaryOil:
    | { productId: string; productName: string; qty: number }
    | undefined;

  for (const comp of formula.components) {
    if (comp.productId === OIL_BASE_PRODUCT_ID) continue;
    if (!mongoose.isValidObjectId(comp.productId)) {
      throw new SaleError(
        "FORMULA_INCOMPLETE",
        `Formula incomplete: invalid product for ${comp.productName}`,
      );
    }
    if (!Number.isFinite(comp.qty) || comp.qty <= 0) {
      throw new SaleError(
        "FORMULA_INCOMPLETE",
        `Formula incomplete: invalid qty for ${comp.productName}`,
      );
    }

    const product = await resolveComponentProduct(
      productsById,
      comp.productId,
      comp.productName,
    );
    const role = matchRemixRole(comp.productName, product.sku);
    if (role && !foundRoles.has(role)) {
      foundRoles.set(role, comp);
    } else if (!role && product.unit === "ml") {
      oilMl += comp.qty;
      if (!primaryOil) {
        primaryOil = {
          productId: comp.productId,
          productName: comp.productName,
          qty: comp.qty,
        };
      }
    }

    componentDeductions.push({
      productId: comp.productId,
      productName: comp.productName,
      qty: comp.qty * lineQty,
      reason: role ? `remix:${role}` : `remix:blend:${comp.productName}`,
      lineIndex,
    });
  }

  if (oilMl <= 0) {
    throw new SaleError(
      "FORMULA_INCOMPLETE",
      "Formula incomplete: customer blend has no oil components",
    );
  }

  // Fill missing required roles from the default remix BOM when present.
  const fallback = options.packagingFallback;
  if (fallback) {
    for (const role of REMIX_COMPONENT_ROLES) {
      if (foundRoles.has(role)) continue;
      for (const comp of fallback.components) {
        if (comp.productId === OIL_BASE_PRODUCT_ID) continue;
        if (!mongoose.isValidObjectId(comp.productId)) continue;
        const product = await resolveComponentProduct(
          productsById,
          comp.productId,
          comp.productName,
        );
        if (matchRemixRole(comp.productName, product.sku) !== role) continue;
        foundRoles.set(role, comp);
        componentDeductions.push({
          productId: comp.productId,
          productName: comp.productName,
          qty: comp.qty * lineQty,
          reason: `remix:${role}`,
          lineIndex,
        });
        break;
      }
    }
  }

  const missing = REMIX_REQUIRED_ROLES.filter((role) => !foundRoles.has(role));
  if (missing.length > 0) {
    throw new SaleError(
      "FORMULA_INCOMPLETE",
      `Formula incomplete: ${missing.map(roleLabel).join(", ")} missing`,
    );
  }

  return {
    oilMl,
    oilProductId: primaryOil?.productId,
    oilProductName: primaryOil?.productName,
    componentDeductions,
  };
}

/**
 * Validates remix formula presence + required packaging/raw roles.
 * Oil is a separate mandatory selection when formula uses oil-base placeholder.
 * Customer blends (concrete oils, no oil-base) deduct recipe lines directly.
 */
export async function validateRemixSale(
  formula: FormulaDoc | null,
  options: {
    oilProductId?: string;
    lineQty: number;
    lineIndex: number;
    productsById?: Map<string, ProductLean>;
    packagingFallback?: FormulaDoc | null;
  },
): Promise<{
  oilMl: number;
  oilProductId?: string;
  oilProductName?: string;
  componentDeductions: DeductionNeed[];
}> {
  if (!formula) {
    throw new SaleError("FORMULA_MISSING", "Formula missing");
  }

  const productsById = options.productsById ?? new Map<string, ProductLean>();
  const foundRoles = new Map<RemixRole, FormulaDoc["components"][number]>();
  let oilComponent: FormulaDoc["components"][number] | undefined;

  for (const comp of formula.components) {
    if (comp.productId === OIL_BASE_PRODUCT_ID) {
      oilComponent = comp;
      continue;
    }

    if (!mongoose.isValidObjectId(comp.productId)) {
      throw new SaleError(
        "FORMULA_INCOMPLETE",
        `Formula incomplete: invalid product for ${comp.productName}`,
      );
    }

    if (!Number.isFinite(comp.qty) || comp.qty <= 0) {
      throw new SaleError(
        "FORMULA_INCOMPLETE",
        `Formula incomplete: invalid qty for ${comp.productName}`,
      );
    }

    const product = await resolveComponentProduct(
      productsById,
      comp.productId,
      comp.productName,
    );

    const role = matchRemixRole(comp.productName, product.sku);
    if (role && !foundRoles.has(role)) {
      foundRoles.set(role, comp);
    }
  }

  // BLD-08 customer formula reuse — concrete oils, no oil-base placeholder.
  if (!oilComponent) {
    return validateCustomerBlendSale(formula, {
      lineQty: options.lineQty,
      lineIndex: options.lineIndex,
      productsById,
      packagingFallback: options.packagingFallback,
    });
  }

  const missing = REMIX_REQUIRED_ROLES.filter((role) => !foundRoles.has(role));
  if (missing.length > 0) {
    throw new SaleError(
      "FORMULA_INCOMPLETE",
      `Formula incomplete: ${missing.map(roleLabel).join(", ")} missing`,
    );
  }

  if (oilComponent.qty <= 0) {
    throw new SaleError(
      "FORMULA_INCOMPLETE",
      "Formula incomplete: oil quantity (oil-base) missing",
    );
  }

  if (oilComponent.qty !== REMIX_OIL_ML) {
    throw new SaleError(
      "FORMULA_INCOMPLETE",
      `Formula incomplete: remix oil must be ${REMIX_OIL_ML} ml (BLD-02/03)`,
    );
  }

  if (!options.oilProductId || !mongoose.isValidObjectId(options.oilProductId)) {
    throw new SaleError("OIL_NOT_SELECTED", "Oil not selected");
  }

  let oilProduct = productsById.get(options.oilProductId);
  if (!oilProduct) {
    const loaded = await Product.findById(options.oilProductId).lean<ProductLean>();
    if (!loaded) {
      throw new SaleError("OIL_NOT_SELECTED", "Oil not selected");
    }
    oilProduct = loaded;
    productsById.set(options.oilProductId, oilProduct);
  }
  assertIsOil(oilProduct, "OIL_NOT_SELECTED", "Oil not selected");

  const lineQty = options.lineQty;
  const oilMl = oilComponent.qty; // backend-owned; never trust client oilMl
  const componentDeductions: DeductionNeed[] = [];

  for (const role of REMIX_COMPONENT_ROLES) {
    const comp = foundRoles.get(role);
    if (!comp) continue; // optional role (label/box/fixative) not in this formula
    componentDeductions.push({
      productId: comp.productId,
      productName: comp.productName,
      qty: comp.qty * lineQty,
      reason: `remix:${role}`,
      lineIndex: options.lineIndex,
    });
  }

  // Also deduct any other valid BOM components outside the recognised roles
  for (const comp of formula.components) {
    if (comp.productId === OIL_BASE_PRODUCT_ID) continue;
    if (!mongoose.isValidObjectId(comp.productId)) continue;
    const already = componentDeductions.some((d) => d.productId === comp.productId);
    if (already) continue;
    componentDeductions.push({
      productId: comp.productId,
      productName: comp.productName,
      qty: comp.qty * lineQty,
      reason: `remix:extra:${comp.productName}`,
      lineIndex: options.lineIndex,
    });
  }

  return {
    oilMl,
    oilProductId: String(oilProduct._id),
    oilProductName: oilProduct.name,
    componentDeductions: [
      ...componentDeductions,
      {
        productId: String(oilProduct._id),
        productName: oilProduct.name,
        qty: oilMl * lineQty,
        reason: "remix:oil",
        lineIndex: options.lineIndex,
      },
    ],
  };
}

function requireProduct(
  productsById: Map<string, ProductLean>,
  productId: string,
  label = productId,
): ProductLean {
  const product = productsById.get(productId);
  if (!product) {
    throw new SaleError("PRODUCT_NOT_FOUND", `Product not found: ${label}`);
  }
  return product;
}

/** In-memory default remix BOM — avoids an Atlas round-trip on every POS remix. */
let defaultRemixCache: { at: number; doc: FormulaDoc | null } | null = null;
const DEFAULT_REMIX_CACHE_MS = 60_000;

function peekDefaultRemixFormula(): FormulaDoc | null | undefined {
  if (
    defaultRemixCache &&
    Date.now() - defaultRemixCache.at < DEFAULT_REMIX_CACHE_MS
  ) {
    return defaultRemixCache.doc;
  }
  return undefined;
}

async function loadDefaultRemixFormula(): Promise<FormulaDoc | null> {
  const cached = peekDefaultRemixFormula();
  if (cached !== undefined) return cached;

  const docs = await Formula.find({ type: "remix", status: "approved" })
    .select("name type status customerId yieldMl components")
    .sort({ updatedAt: -1 })
    .limit(30)
    .lean<FormulaDoc[]>();
  const doc =
    docs.find((f) => f.customerId == null) || docs[0] || null;
  defaultRemixCache = { at: Date.now(), doc };
  return doc;
}

/** Call on POS boot so the first remix checkout skips a formula round-trip. */
export async function warmSaleCaches() {
  await loadDefaultRemixFormula();
}

/** Call when remix formulas are approved/edited so POS picks up the new BOM. */
export function invalidateDefaultRemixCache() {
  defaultRemixCache = null;
}

function collectFormulaProductIds(docs: FormulaDoc[], into: Set<string>) {
  for (const doc of docs) {
    for (const c of doc.components || []) {
      if (
        c.productId !== OIL_BASE_PRODUCT_ID &&
        mongoose.isValidObjectId(c.productId)
      ) {
        into.add(c.productId);
      }
    }
  }
}

/**
 * Full pre-sale validation: business rules + deduction plan (no writes).
 * Target: 1 Atlas round-trip when default remix formula is warm-cached.
 */
export async function validateSaleLines(
  rawLines: IncomingSaleLine[],
): Promise<SaleValidationResult> {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new SaleError("VALIDATION", "At least one line item is required");
  }

  const needsRemix = rawLines.some((l) => l.lineType === "remix");
  const productIds = new Set<string>();
  const formulaIds = new Set<string>();

  for (const raw of rawLines) {
    if (raw.productId && mongoose.isValidObjectId(raw.productId)) {
      productIds.add(raw.productId);
    }
    if (raw.oilProductId && mongoose.isValidObjectId(raw.oilProductId)) {
      productIds.add(raw.oilProductId);
    }
    if (raw.formulaId && mongoose.isValidObjectId(raw.formulaId)) {
      formulaIds.add(raw.formulaId);
    }
    if (Array.isArray(raw.packagingProductIds)) {
      for (const id of raw.packagingProductIds) {
        if (mongoose.isValidObjectId(id)) productIds.add(id);
      }
    }
  }

  const cachedDefault = needsRemix ? peekDefaultRemixFormula() : null;
  // When default BOM is cached, include its component ids in the first product read.
  if (cachedDefault) collectFormulaProductIds([cachedDefault], productIds);

  const lineProductIds = [...productIds];
  const [namedFormulas, remixFormula, firstProducts] = await Promise.all([
    formulaIds.size > 0
      ? Formula.find({
          _id: { $in: [...formulaIds] },
          status: "approved",
        })
          .select("name type status customerId yieldMl components")
          .lean<FormulaDoc[]>()
      : Promise.resolve([] as FormulaDoc[]),
    needsRemix
      ? cachedDefault !== undefined
        ? Promise.resolve(cachedDefault)
        : loadDefaultRemixFormula()
      : Promise.resolve(null),
    lineProductIds.length > 0
      ? Product.find({ _id: { $in: lineProductIds } })
          .select("name sku unit category sellPrice wholesalePrice stockSellable")
          .lean<ProductLean[]>()
      : Promise.resolve([] as ProductLean[]),
  ]);

  const formulasById = new Map<string, FormulaDoc>(
    namedFormulas.map((f) => [String(f._id), f]),
  );

  const productsById = new Map<string, ProductLean>(
    firstProducts.map((p) => [String(p._id), p]),
  );

  // Fetch any BOM component products not covered by the first read (cold cache / named formulas).
  const missingComponentIds = new Set<string>();
  collectFormulaProductIds(
    [...(remixFormula ? [remixFormula] : []), ...namedFormulas],
    missingComponentIds,
  );
  for (const id of [...missingComponentIds]) {
    if (productsById.has(id)) missingComponentIds.delete(id);
  }
  if (missingComponentIds.size > 0) {
    const extra = await Product.find({ _id: { $in: [...missingComponentIds] } })
      .select("name sku unit category sellPrice wholesalePrice stockSellable")
      .lean<ProductLean[]>();
    for (const p of extra) productsById.set(String(p._id), p);
  }

  const lines: ValidatedSaleLine[] = [];
  const deductions: DeductionNeed[] = [];
  let subtotal = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const qty = Number(raw.qty);
    assertPositiveQty(qty, `line ${i + 1}`);

    const lineType = raw.lineType as ValidatedSaleLine["lineType"];
    const allowed = [
      "ready",
      "remix",
      "oil",
      "refill",
      "packaging",
      "wholesale",
    ] as const;
    if (!allowed.includes(lineType as (typeof allowed)[number])) {
      throw new SaleError("INVALID_LINE", `Invalid line type: ${raw.lineType}`);
    }

    if (lineType === "ready" || lineType === "wholesale") {
      if (!raw.productId || !mongoose.isValidObjectId(raw.productId)) {
        throw new SaleError("INVALID_LINE", `Product required for ${lineType} line`);
      }
      const product = requireProduct(productsById, raw.productId);
      const resolved = resolvePriceFromProduct(product, lineType);
      lines.push({
        productId: raw.productId,
        name: resolved.name,
        qty,
        unitLabel: raw.unitLabel || resolved.unit,
        unitPrice: resolved.unitPrice,
        lineType,
        bomNote: raw.bomNote,
      });
      deductions.push({
        productId: raw.productId,
        productName: resolved.name,
        qty,
        reason: lineType,
        lineIndex: i,
      });
      subtotal += qty * resolved.unitPrice;
      continue;
    }

    if (lineType === "oil") {
      if (!raw.productId || !mongoose.isValidObjectId(raw.productId)) {
        throw new SaleError("INVALID_LINE", "Product required for oil line");
      }
      const product = requireProduct(productsById, raw.productId);
      assertIsOil(product, "INVALID_LINE", "Oil line");
      // Individual oil is sold only in approved tola sizes (¼ / ½ / 1 tola =
      // 3 / 6 / 12 ml); larger amounts are qty × size. Arbitrary "N ml" labels
      // are refused so the deduction can only ever be an approved size.
      const deductMl = resolveOilTolaMl(raw.unitLabel);
      if (deductMl == null) {
        throw new SaleError(
          "INVALID_LINE",
          "Oil is sold only as 1 Tola / ½ Tola / ¼ Tola (use quantity for more)",
        );
      }
      const unitPrice = Number((product.sellPrice * deductMl).toFixed(3));
      const unitLabel = raw.unitLabel!.trim();
      lines.push({
        productId: raw.productId,
        name: product.name,
        qty,
        unitLabel,
        unitPrice,
        lineType: "oil",
        deductMl,
        bomNote: raw.bomNote || `Deduct ${deductMl} ml from ${product.name}`,
      });
      deductions.push({
        productId: raw.productId,
        productName: product.name,
        qty: deductMl * qty,
        reason: "oil",
        lineIndex: i,
      });
      subtotal += qty * unitPrice;
      continue;
    }

    if (lineType === "refill") {
      if (!raw.productId || !mongoose.isValidObjectId(raw.productId)) {
        throw new SaleError("INVALID_LINE", "Oil product required for refill line");
      }
      const product = requireProduct(productsById, raw.productId);
      assertIsOil(product, "INVALID_LINE", "Refill");
      const deductMl = resolveDeductMlFromUnitLabel(raw.unitLabel);
      if (deductMl == null) {
        throw new SaleError(
          "INVALID_LINE",
          "Refill quantity (ml) is required — use a label like 100ml refill",
        );
      }
      // BLD-09: customer bottle accepted ONLY at 100ml (hard rule, not UI default)
      if (deductMl !== REFILL_CUSTOMER_BOTTLE_ML) {
        throw new SaleError(
          "INVALID_LINE",
          `Refill accepts only ${REFILL_CUSTOMER_BOTTLE_ML}ml customer bottles (got ${deductMl}ml)`,
        );
      }
      // Backend-owned refill service rate (OMR per ml) — do not trust client unitPrice
      const unitPrice = Number((REFILL_OMR_PER_ML * deductMl).toFixed(3));
      const unitLabel = `${REFILL_CUSTOMER_BOTTLE_ML}ml refill`;

      lines.push({
        productId: raw.productId,
        name: raw.name || `${product.name} refill`,
        qty,
        unitLabel,
        unitPrice,
        lineType: "refill",
        deductMl,
        bomNote: raw.bomNote,
        packagingProductIds: raw.packagingProductIds,
      });
      deductions.push({
        productId: raw.productId,
        productName: product.name,
        qty: deductMl * qty,
        reason: "refill:oil",
        lineIndex: i,
      });

      const packagingIds = Array.isArray(raw.packagingProductIds)
        ? raw.packagingProductIds
        : [];
      for (const pkgId of packagingIds) {
        if (!mongoose.isValidObjectId(pkgId)) {
          throw new SaleError("INVALID_LINE", "Invalid packaging product on refill");
        }
        const pkg = requireProduct(productsById, pkgId, "packaging");
        deductions.push({
          productId: String(pkg._id),
          productName: pkg.name,
          qty: qty,
          reason: "refill:packaging",
          lineIndex: i,
        });
        subtotal += qty * pkg.sellPrice;
      }

      subtotal += qty * unitPrice;
      continue;
    }

    if (lineType === "packaging") {
      if (!raw.productId || !mongoose.isValidObjectId(raw.productId)) {
        throw new SaleError("INVALID_LINE", "Product required for packaging line");
      }
      const product = requireProduct(productsById, raw.productId);
      const resolved = resolvePriceFromProduct(product, "packaging");
      lines.push({
        productId: raw.productId,
        name: resolved.name,
        qty,
        unitLabel: raw.unitLabel || resolved.unit,
        unitPrice: resolved.unitPrice,
        lineType: "packaging",
        bomNote: raw.bomNote,
      });
      deductions.push({
        productId: raw.productId,
        productName: resolved.name,
        qty,
        reason: "packaging",
        lineIndex: i,
      });
      subtotal += qty * resolved.unitPrice;
      continue;
    }

    if (lineType === "remix") {
      let formulaForLine: FormulaDoc | null = remixFormula;
      if (raw.formulaId) {
        if (!mongoose.isValidObjectId(raw.formulaId)) {
          throw new SaleError("FORMULA_MISSING", "Invalid formula id");
        }
        formulaForLine = formulasById.get(raw.formulaId) || null;
        if (!formulaForLine) {
          throw new SaleError(
            "FORMULA_MISSING",
            "Saved formula not found or not approved",
          );
        }
      }

      const remix = await validateRemixSale(formulaForLine, {
        oilProductId: raw.oilProductId,
        lineQty: qty,
        lineIndex: i,
        productsById,
        packagingFallback: remixFormula,
      });

      if (!raw.productId || !mongoose.isValidObjectId(raw.productId)) {
        throw new SaleError("INVALID_LINE", "Remix product required");
      }
      const product = requireProduct(productsById, raw.productId);
      // The remix price comes from this product, so it must be a Remix
      // product — otherwise any cheap item could be charged for a full remix BOM.
      if (product.category !== "Remix") {
        throw new SaleError(
          "INVALID_LINE",
          `${product.name} is not a remix product`,
        );
      }
      const resolved = resolvePriceFromProduct(product, "remix");
      const unitPrice = resolved.unitPrice;
      const name = resolved.name;
      const productId = raw.productId;

      lines.push({
        productId,
        name,
        qty,
        unitLabel: raw.unitLabel || "pcs",
        unitPrice,
        lineType: "remix",
        bomNote:
          raw.bomNote ||
          (remix.oilProductName
            ? `BOM: ${remix.oilMl}ml ${remix.oilProductName} + formula components`
            : `BOM: ${formulaForLine?.name || "formula"}`),
        oilProductId: remix.oilProductId,
        oilMl: remix.oilMl,
        formulaId: raw.formulaId,
      });
      deductions.push(...remix.componentDeductions);
      subtotal += qty * unitPrice;
      continue;
    }
  }

  return { lines, deductions, subtotal };
}

/**
 * Verify every planned deduction has enough sellable + FIFO stock (read-only).
 * Not used on the hot POS path — deductFifo enforces atomically (saves ~1 RTT).
 * Available for admin tools / preflight checks. Uses shared INV-06 stock check.
 */
export async function assertStockAvailable(deductions: DeductionNeed[]) {
  const { checkStockAvailability } = await import("@/lib/inventory/stockCheck");
  const result = await checkStockAvailability(
    deductions.map((d) => ({
      productId: d.productId,
      qty: d.qty,
      productName: d.productName,
    })),
  );

  for (const s of result.shortages) {
    if (s.missing) {
      throw new SaleError("PRODUCT_NOT_FOUND", `Product not found: ${s.productName}`);
    }
    if (!s.short) continue;
    if (s.fifoAvailable < s.need && s.available >= s.need) {
      throw new SaleError(
        "INSUFFICIENT_STOCK",
        `Insufficient stock for ${s.productName} (FIFO need ${s.need}, have ${s.fifoAvailable})`,
      );
    }
    throw new SaleError(
      "INSUFFICIENT_STOCK",
      `Insufficient stock for ${s.productName} (need ${s.need}, have ${s.available})`,
    );
  }
}

const FAST_LINE_TYPES = new Set(["ready", "packaging", "wholesale"]);

/**
 * @deprecated Always use validateSaleLines — client prices must not be trusted.
 * Kept only so existing imports compile; always returns null.
 */
export function tryFastValidateSaleLines(
  _rawLines: IncomingSaleLine[],
): SaleValidationResult | null {
  void FAST_LINE_TYPES;
  return null;
}

