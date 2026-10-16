import { randomUUID } from "crypto";
import mongoose from "mongoose";
import {
  addProductionFifoLayer,
  deductFifoMany,
  type DeductFifoResult,
} from "@/lib/inventory";
import { Product, ProductionOrder, Supplier } from "@/lib/models";
import { planProduction } from "@/lib/production/planProduction";
import {
  assertYieldWithinTolerance,
  type YieldVarianceResult,
} from "@/lib/production/yieldVariance";
import { SaleError } from "@/lib/sales/errors";

const PRODUCTION_SUPPLIER_NAME = "In-house Production";

export async function ensureProductionSupplier() {
  let supplier = await Supplier.findOne({ name: PRODUCTION_SUPPLIER_NAME });
  if (!supplier) {
    supplier = await Supplier.create({
      name: PRODUCTION_SUPPLIER_NAME,
      phone: "internal",
      currency: "OMR",
      creditLimit: 0,
      outstanding: 0,
      avgLeadDays: 0,
    });
  }
  return supplier;
}

function newOrderNumber() {
  return `PO-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function newBatchNumber() {
  return `PB-${randomUUID().slice(0, 8).toUpperCase()}`;
}

type PlannedLine = {
  productId: string;
  productName: string;
  qty: number;
  unit?: string;
  reason?: string;
};

function applyYieldFields(
  order: {
    actualYieldMl?: number;
    varianceMl?: number;
    wastageMl?: number;
    withinTolerance?: boolean;
  },
  yieldInfo: YieldVarianceResult,
) {
  order.actualYieldMl = yieldInfo.actualYieldMl;
  order.varianceMl = yieldInfo.varianceMl;
  order.wastageMl = yieldInfo.wastageMl;
  order.withinTolerance = yieldInfo.withinTolerance;
}

export type CreateProductionInput = {
  formulaId: string;
  qty: number;
  oilProductId?: string;
  outputProductId: string;
  outputQty?: number;
  /** BLD-06: required when complete=true. */
  actualYieldMl?: number;
  notes?: string;
  createdBy?: string;
  /** If true, consume materials + create finished batch immediately. */
  complete?: boolean;
};

/**
 * Create a production order (draft) and optionally complete it.
 * Complete path: BLD-06 yield check → FIFO-consume planned materials → finished batch.
 */
export async function createProductionOrder(input: CreateProductionInput) {
  const plan = await planProduction({
    formulaId: input.formulaId,
    qty: input.qty,
    oilProductId: input.oilProductId,
  });

  if (!mongoose.isValidObjectId(input.outputProductId)) {
    throw new SaleError("PRODUCT_NOT_FOUND", "Output product is required");
  }

  const output = await Product.findById(input.outputProductId).lean<{
    _id: mongoose.Types.ObjectId;
    name: string;
    sku?: string;
    unit: string;
    itemType?: string;
  }>();
  if (!output) {
    throw new SaleError("PRODUCT_NOT_FOUND", "Output product not found");
  }

  const expectedYieldMl = plan.yieldMl * plan.qty;

  let outputQty =
    input.outputQty !== undefined && Number(input.outputQty) > 0
      ? Number(input.outputQty)
      : plan.defaultOutputQty(output.unit);

  // When completing with ml/g output, stock qty follows actual yield (BLD-06).
  if (
    input.complete &&
    input.actualYieldMl !== undefined &&
    (output.unit === "ml" || output.unit === "g")
  ) {
    outputQty = Number(input.actualYieldMl);
  }

  if (!(outputQty > 0)) {
    throw new SaleError("VALIDATION", "Output qty must be greater than 0");
  }

  const order = await ProductionOrder.create({
    orderNumber: newOrderNumber(),
    formulaId: plan.formulaId,
    formulaName: plan.formulaName,
    formulaType: plan.formulaType,
    formulaVersion: plan.formulaVersion,
    qty: plan.qty,
    yieldMl: expectedYieldMl,
    status: "draft",
    oilProductId: plan.oilProductId,
    oilProductName: plan.oilProductName,
    outputProductId: output._id,
    outputProductName: output.name,
    outputSku: output.sku || "",
    outputUnit: output.unit,
    outputQty,
    plannedLines: plan.plannedLines.map((l) => ({
      productId: l.productId,
      productName: l.productName,
      qty: l.qty,
      unit: l.unit,
      reason: l.reason,
    })),
    consumption: [],
    batch: null,
    notes: input.notes?.trim() || undefined,
    createdBy: input.createdBy,
  });

  if (input.complete) {
    return completeProductionOrder(String(order._id), {
      completedBy: input.createdBy,
      actualYieldMl: input.actualYieldMl,
    });
  }

  return order;
}

export async function completeProductionOrder(
  orderId: string,
  opts: { completedBy?: string; actualYieldMl?: number } = {},
) {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new SaleError("VALIDATION", "Invalid production order id");
  }

  const current = await ProductionOrder.findById(orderId);
  if (!current) {
    throw new SaleError("VALIDATION", "Production order not found");
  }
  if (current.status === "completed") {
    throw new SaleError("VALIDATION", "Production order already completed");
  }
  if (current.status === "cancelled") {
    throw new SaleError("VALIDATION", "Cancelled production orders cannot be completed");
  }

  // BLD-06: require actual yield and enforce ±5 ml tolerance
  if (opts.actualYieldMl === undefined || opts.actualYieldMl === null) {
    throw new SaleError(
      "VALIDATION",
      "Actual yield (ml) is required to complete production (BLD-06 ±5 ml)",
    );
  }

  let yieldInfo: YieldVarianceResult;
  try {
    yieldInfo = assertYieldWithinTolerance(
      Number(current.yieldMl),
      Number(opts.actualYieldMl),
    );
  } catch (err) {
    throw new SaleError(
      "VALIDATION",
      err instanceof Error ? err.message : "Yield variance out of tolerance",
    );
  }

  // Claim the order atomically BEFORE moving stock: concurrent completions
  // (double click, two tabs) would otherwise each consume materials and add
  // output, with only the final save colliding. A claim older than
  // CLAIM_STALE_MS (crashed request) may be taken over.
  const order = await ProductionOrder.findOneAndUpdate(
    {
      _id: current._id,
      status: "draft",
      $or: [
        { completingAt: null },
        { completingAt: { $lt: new Date(Date.now() - CLAIM_STALE_MS) } },
      ],
    },
    { $set: { completingAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!order) {
    throw new SaleError(
      "VALIDATION",
      "Production order is already being completed or was completed",
    );
  }
  try {
    applyYieldFields(order, yieldInfo);

    // ml/g finished goods: stock added equals actual yield
    const unit = String(order.outputUnit || "");
    if (unit === "ml" || unit === "g") {
      order.outputQty = yieldInfo.actualYieldMl;
    }

    const needs = (order.plannedLines as PlannedLine[]).map((l) => ({
      productId: String(l.productId),
      productName: l.productName,
      qty: Number(l.qty),
    }));

    // Materials out, finished goods in and the order's "completed" state commit
    // together or not at all. Before, each step committed on its own: a failure
    // saving the order left materials consumed and output added under a draft
    // order, and the next attempt consumed them again.
    const supplier = await ensureProductionSupplier();
    await mongoose.connection.transaction(async (session) => {
      const deductMap: Map<string, DeductFifoResult> = await deductFifoMany(needs, { session });

      const consumption = (order.plannedLines as PlannedLine[]).map((l) => {
        const result = deductMap.get(String(l.productId)) ?? {
          costTotal: 0,
          batches: [],
        };
        return {
          productId: l.productId,
          productName: l.productName,
          qty: Number(l.qty),
          reason: l.reason,
          costTotal: Number(result.costTotal.toFixed(3)),
          batches: result.batches.map((b) => ({
            layerId: b.layerId,
            qty: b.qty,
            unitCost: b.unitCost,
            purchaseDate: b.purchaseDate,
          })),
        };
      });

      const totalMaterialCost = Number(
        consumption.reduce((s, c) => s + c.costTotal, 0).toFixed(3),
      );
      const unitCost = Number(
        (totalMaterialCost / Math.max(order.outputQty, 1e-9)).toFixed(3),
      );

      const batchNumber = newBatchNumber();
      const producedAt = new Date();

      const layer = await addProductionFifoLayer(
        {
          productId: String(order.outputProductId),
          supplierId: String(supplier._id),
          supplierName: `${PRODUCTION_SUPPLIER_NAME} · ${batchNumber}`,
          productionOrderId: String(order._id),
          purchaseDate: producedAt,
          qty: order.outputQty,
          unitCost,
          currency: "OMR",
        },
        { session },
      );

      order.status = "completed";
      order.consumption = consumption;
      order.batch = {
        batchNumber,
        producedAt,
        outputProductId: order.outputProductId,
        outputProductName: order.outputProductName,
        outputSku: order.outputSku,
        outputQty: order.outputQty,
        outputUnit: order.outputUnit,
        unitCost,
        totalMaterialCost,
        fifoLayerId: new mongoose.Types.ObjectId(String(layer._id)),
      };
      order.completedAt = producedAt;
      order.completedBy = opts.completedBy;
      order.completingAt = null;
      // Only a still-draft order completes: if a cancel (of a stale claim)
      // committed meanwhile, the save matches nothing and the whole
      // transaction — materials and output included — rolls back.
      order.$where = { status: "draft" };
      await order.save({ session });
    });

    return order;
  } catch (err) {
    if ((err as Error)?.name === "DocumentNotFoundError") {
      err = new SaleError("VALIDATION", "Production order was cancelled or completed by another request");
    }
    await ProductionOrder.updateOne(
      { _id: order._id, status: "draft" },
      { $set: { completingAt: null } },
    ).catch(() => undefined);
    throw err;
  }
}

/** A completion claim older than this belongs to a crashed request. */
export const CLAIM_STALE_MS = 2 * 60 * 1000;
