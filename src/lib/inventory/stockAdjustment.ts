/**
 * INV-06/INV-07: every change to sellable stock goes through FIFO, so
 * Product.stockSellable always equals the sum of its FIFO layers.
 * A manual "set stock to N" (Inventory screen) becomes an audited adjustment:
 * up → a new layer at the product's current FIFO cost; down → FIFO out.
 */
import mongoose from "mongoose";
import { addFifoLayer, deductFifoMany, roundQty } from "@/lib/inventory";
import { warnIfNegativeStock } from "@/lib/inventory/stockCheck";
import { InventoryAdjustment, Supplier } from "@/lib/models";
import { SaleError } from "@/lib/sales/errors";

export const ADJUSTMENT_SUPPLIER = "Stock Adjustment";

export class StockAdjustmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockAdjustmentError";
  }
}

/** The internal supplier that adjustment layers are booked against. */
export async function adjustmentSupplierId(): Promise<string> {
  const existing = await Supplier.findOne({ name: ADJUSTMENT_SUPPLIER }).select("_id").lean<{ _id: unknown }>();
  if (existing) return String(existing._id);
  const created = await Supplier.create({
    name: ADJUSTMENT_SUPPLIER,
    phone: "internal",
    currency: "OMR",
    creditLimit: 0,
    outstanding: 0,
    avgLeadDays: 0,
  });
  return String(created._id);
}

/** Pieces are whole units; ml / g / kg may be fractional. */
export function assertQtyFitsUnit(qty: number, unit: string | undefined, label = "Quantity") {
  if ((unit ?? "pcs") === "pcs" && !Number.isInteger(qty)) {
    throw new StockAdjustmentError(`${label} must be a whole number of pieces`);
  }
}

type ProductForAdjust = {
  _id: unknown;
  name: string;
  unit?: string;
  stockSellable: number;
  costFifo?: number;
};

/**
 * Set sellable stock to `target` through FIFO. Refuses negative targets (the
 * negative-stock warning is returned as the error) and reductions the FIFO
 * layers can't cover. Returns the change and the adjustment it recorded.
 */
export async function setSellableStock(input: {
  product: ProductForAdjust;
  target: number;
  createdBy?: string;
  branchId?: string | null;
  branchName?: string | null;
  notes?: string;
}): Promise<{ delta: number; adjustmentId?: string; costTotal: number }> {
  const { product } = input;
  const target = Number(input.target);
  if (!Number.isFinite(target)) throw new StockAdjustmentError("Sellable stock must be a number");
  const negative = warnIfNegativeStock(product.name, target);
  if (negative) {
    throw new StockAdjustmentError(
      `${negative.replace("Negative stock is permitted with warning — ", "")} Stock can't be set below zero — record a wastage/adjustment or restock instead.`,
    );
  }
  assertQtyFitsUnit(target, product.unit, "Sellable stock");

  const delta = roundQty(target - (Number(product.stockSellable) || 0));
  if (delta === 0) return { delta: 0, costTotal: 0 };

  const productId = String(product._id);
  const branch = {
    ...(input.branchId && mongoose.isValidObjectId(input.branchId)
      ? { branchId: new mongoose.Types.ObjectId(input.branchId) }
      : {}),
    ...(input.branchName ? { branchName: input.branchName } : {}),
  };
  const notes = input.notes || "Stock count correction (Inventory screen)";

  if (delta > 0) {
    await addFifoLayer({
      productId,
      supplierId: await adjustmentSupplierId(),
      supplierName: ADJUSTMENT_SUPPLIER,
      purchaseDate: new Date(),
      qty: delta,
      unitCost: Number(product.costFifo) || 0,
      currency: "OMR",
    });
    const adj = await InventoryAdjustment.create({
      productId: product._id,
      productName: product.name,
      qty: delta,
      direction: "in",
      reason: "restock",
      costTotal: 0,
      notes,
      createdBy: input.createdBy,
      ...branch,
    });
    return { delta, adjustmentId: String(adj._id), costTotal: 0 };
  }

  const qty = -delta;
  let costTotal = 0;
  try {
    const map = await deductFifoMany([{ productId, qty, productName: product.name }]);
    costTotal = roundQty(map.get(productId)?.costTotal ?? 0);
  } catch (err) {
    if (err instanceof SaleError) {
      throw new StockAdjustmentError(
        `Cannot reduce ${product.name} by ${qty}: only ${product.stockSellable} on hand in FIFO. ${err.message}`,
      );
    }
    throw err;
  }
  const adj = await InventoryAdjustment.create({
    productId: product._id,
    productName: product.name,
    qty,
    direction: "out",
    reason: "adjustment",
    costTotal,
    notes,
    createdBy: input.createdBy,
    ...branch,
  });
  return { delta, adjustmentId: String(adj._id), costTotal };
}
