import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { deductFifoMany, addFifoLayer } from "@/lib/inventory";
import {
  checkStockAvailability,
  warnIfNegativeStock,
} from "@/lib/inventory/stockCheck";
import {
  Customer,
  Expense,
  InventoryAdjustment,
  Product,
} from "@/lib/models";
import { createSale } from "@/lib/sales/createSale";
import { SaleError } from "@/lib/sales/errors";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { recordAudit } from "@/lib/audit/log";
import {
  ADJUSTMENT_SUPPLIER,
  adjustmentSupplierId,
  assertQtyFitsUnit,
  StockAdjustmentError,
} from "@/lib/inventory/stockAdjustment";



type AdjustmentReason =
  | "wastage_cost"
  | "wastage_customer"
  | "restock"
  | "adjustment";

function normalizeReason(
  raw: string,
  direction: "in" | "out",
): AdjustmentReason {
  const r = raw.trim().toLowerCase();
  if (r === "wastage_cost" || r === "wastage" || r === "cost") {
    return "wastage_cost";
  }
  if (
    r === "wastage_customer" ||
    r === "customer" ||
    r === "customer_paid" ||
    r === "customer_damage"
  ) {
    return "wastage_customer";
  }
  if (r === "restock" || direction === "in") return "restock";
  return "adjustment";
}

/**
 * INV-06 / INV-07: inventory adjustment.
 * - wastage_cost: FIFO out + expense (other wasted products = cost)
 * - wastage_customer: replacement sale (customer leaked/damaged → replace + pay)
 * - restock / adjustment: FIFO in or generic out
 */
export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;
    const branchStamp = {
      branchId: access?.branchId ?? undefined,
      branchName: access?.branchName ?? undefined,
    };

    await connectDB();
    const body = await req.json();
    const productId = String(body.productId || "");
    const qty = Number(body.qty);
    const direction = String(body.direction || "").toLowerCase() as
      | "in"
      | "out";
    const reason = normalizeReason(
      String(body.reason || (direction === "out" ? "wastage_cost" : "restock")),
      direction === "in" ? "in" : "out",
    );
    const notes = body.notes ? String(body.notes).trim() : "";
    // Who did it comes from the session — never from the request body.
    const createdBy = access?.name || undefined;

    if (!mongoose.isValidObjectId(productId)) {
      return NextResponse.json({ error: "Valid productId required" }, { status: 400 });
    }
    if (!(qty > 0) || !Number.isFinite(qty)) {
      return NextResponse.json({ error: "qty must be > 0" }, { status: 400 });
    }
    if (direction !== "in" && direction !== "out") {
      return NextResponse.json(
        { error: 'direction must be "in" or "out"' },
        { status: 400 },
      );
    }

    if (reason === "wastage_customer" && direction !== "out") {
      return NextResponse.json(
        { error: "Customer wastage must be direction=out" },
        { status: 400 },
      );
    }
    if (reason === "wastage_cost" && direction !== "out") {
      return NextResponse.json(
        { error: "Cost wastage must be direction=out" },
        { status: 400 },
      );
    }

    const product = await Product.findById(productId).lean<{
      _id: mongoose.Types.ObjectId;
      name: string;
      sku?: string;
      unit?: string;
      stockSellable: number;
      costFifo?: number;
      sellPrice?: number;
    }>();
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    // Pieces are whole units (a sale can't sell half a bottle either).
    try {
      assertQtyFitsUnit(qty, product.unit, "qty");
    } catch (err) {
      if (err instanceof StockAdjustmentError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    // ——— INV-07: customer leaked/damaged → replace + customer pays (sale) ———
    if (reason === "wastage_customer") {
      const customerId = String(body.customerId || "");
      if (!mongoose.isValidObjectId(customerId)) {
        return NextResponse.json(
          {
            error:
              "customerId required for customer wastage (INV-07: replaced and paid by customer)",
          },
          { status: 400 },
        );
      }

      const customer = await Customer.findById(customerId).lean<{
        _id: mongoose.Types.ObjectId;
        name: string;
        phone: string;
      }>();
      if (!customer) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }

      const unitPrice =
        body.unitPrice !== undefined && Number(body.unitPrice) >= 0
          ? Number(body.unitPrice)
          : Number(product.sellPrice) || 0;

      if (!(unitPrice > 0)) {
        return NextResponse.json(
          {
            error:
              "Product sell price required so customer can pay for replacement (INV-07)",
          },
          { status: 400 },
        );
      }

      const payment = String(body.payment || "cash").toLowerCase();
      const { sale } = await createSale({
        customerId: String(customer._id),
        customerPhone: customer.phone,
        customerName: customer.name,
        payment,
        lines: [
          {
            productId,
            name: product.name,
            qty,
            unitPrice,
            lineType: "ready",
            unitLabel: product.unit || "pcs",
            bomNote: notes || "INV-07 customer leaked/damaged replacement",
          },
        ],
        status: "completed",
        idempotencyKey: body.idempotencyKey
          ? String(body.idempotencyKey)
          : undefined,
        // Keys are scoped per user + branch (no cross-user replay).
        idempotencyOwner: access?.userId,
        branchId: access?.branchId ?? undefined,
        branchName: access?.branchName ?? undefined,
      });

      const saleId = String(
        (sale as { id?: string; _id?: unknown }).id ||
          (sale as { _id?: unknown })._id,
      );
      const adjustment = await InventoryAdjustment.create({
        productId: product._id,
        productName: product.name,
        qty,
        direction: "out",
        reason: "wastage_customer",
        liability: "customer_paid",
        costTotal: 0,
        customerId: customer._id,
        customerName: customer.name,
        customerPhone: customer.phone,
        saleId: new mongoose.Types.ObjectId(saleId),
        notes: notes || "Customer leaked/damaged — replaced and paid by customer",
        createdBy,
        ...branchStamp,
      });

      const updated = await Product.findById(productId);
      recordAudit({
        session: access,
        action: "stock_adjusted",
        entityType: "InventoryAdjustment",
        entityId: String(adjustment._id),
        detail: `${product.name} × ${qty} · out · wastage_customer`,
        req,
      });
      return NextResponse.json(
        {
          ok: true,
          direction: "out",
          reason: "wastage_customer",
          liability: "customer_paid",
          qty,
          saleId,
          adjustmentId: String(adjustment._id),
          stockSellable: updated
            ? Number(
                (updated as { stockSellable?: number }).stockSellable ?? 0,
              )
            : undefined,
          warnings: [] as string[],
          product: updated ? toJSON(updated) : null,
        },
        { status: 201 },
      );
    }

    // ——— INV-07: other wastage = cost (FIFO out + expense) ———
    if (direction === "out") {
      const stockBefore = Number(product.stockSellable) || 0;

      // Fast path: deductFifoMany already enforces sellable + FIFO (no pre-check RTT).
      let costTotal = 0;
      try {
        const map = await deductFifoMany([
          { productId, qty, productName: product.name },
        ]);
        costTotal = Number(
          (map.get(productId)?.costTotal ?? 0).toFixed(3),
        );
      } catch (err) {
        if (err instanceof SaleError) {
          return NextResponse.json(
            {
              error: `Cannot record damage/wastage: need ${qty}, sellable ${stockBefore}. ${err.message}. Restock FIFO first.`,
              code: err.code,
              stockSellable: stockBefore,
            },
            { status: 400 },
          );
        }
        throw err;
      }

      const stockAfter = stockBefore - qty;
      let expenseId: string | undefined;
      let adjustmentId: string | undefined;

      if (reason === "wastage_cost") {
        const [expense, adjustment] = await Promise.all([
          Expense.create({
            date: new Date(),
            category: "Wastage",
            detail:
              notes ||
              `INV-07 wastage (cost): ${product.name} × ${qty}${
                product.unit ? ` ${product.unit}` : ""
              }`,
            amount: costTotal,
            status: "approved",
            ...branchStamp,
          }),
          InventoryAdjustment.create({
            productId: product._id,
            productName: product.name,
            qty,
            direction: "out",
            reason: "wastage_cost",
            liability: "cost",
            costTotal,
            notes:
              notes || "Other wasted product recorded as cost",
            createdBy,
            ...branchStamp,
          }),
        ]);
        expenseId = String(expense._id);
        adjustmentId = String(adjustment._id);
        // Link expense on adjustment (non-blocking best-effort)
        void InventoryAdjustment.updateOne(
          { _id: adjustment._id },
          { $set: { expenseId: expense._id } },
        ).exec();
      } else {
        const adjustment = await InventoryAdjustment.create({
          productId: product._id,
          productName: product.name,
          qty,
          direction: "out",
          reason: "adjustment",
          costTotal,
          notes: notes || "Stock adjustment out",
          createdBy,
          ...branchStamp,
        });
        adjustmentId = String(adjustment._id);
      }

      recordAudit({
        session: access,
        action: "stock_adjusted",
        entityType: "InventoryAdjustment",
        entityId: adjustmentId,
        detail: `${product.name} × ${qty} · out · ${reason}`,
        req,
      });

      return NextResponse.json({
        ok: true,
        direction: "out",
        reason: reason === "wastage_cost" ? "wastage_cost" : "adjustment",
        liability: reason === "wastage_cost" ? "cost" : undefined,
        qty,
        costTotal,
        expenseId,
        adjustmentId,
        stockSellableBefore: stockBefore,
        stockSellable: stockAfter,
        warnings: [] as string[],
        product: {
          id: productId,
          stockSellable: stockAfter,
          costFifo: Number(product.costFifo) || 0,
        },
      });
    }

    // direction === "in" — admin restock via adjustment layer
    const supplierId = await adjustmentSupplierId();

    const stockBefore = Number(product.stockSellable) || 0;
    const stockAfter = stockBefore + qty;

    const unitCost = Number(body.unitCost);
    const layer = await addFifoLayer({
      productId,
      supplierId,
      supplierName: ADJUSTMENT_SUPPLIER,
      purchaseDate: new Date(),
      qty,
      unitCost: Number.isFinite(unitCost) && unitCost >= 0
        ? unitCost
        : Number(product.costFifo) || 0,
      currency: "OMR",
    });

    const adjustment = await InventoryAdjustment.create({
      productId: product._id,
      productName: product.name,
      qty,
      direction: "in",
      reason: "restock",
      costTotal: 0,
      notes: notes || "Restock adjustment",
      createdBy,
      ...branchStamp,
    });

    recordAudit({
      session: access,
      action: "stock_adjusted",
      entityType: "InventoryAdjustment",
      entityId: String(adjustment._id),
      detail: `${product.name} × ${qty} · in · restock`,
      req,
    });

    return NextResponse.json(
      {
        ok: true,
        direction: "in",
        reason: "restock",
        qty,
        warnings: [] as string[],
        layerId: String(layer._id),
        adjustmentId: String(adjustment._id),
        stockSellableBefore: stockBefore,
        stockSellable: stockAfter,
        product: {
          id: productId,
          stockSellable: stockAfter,
          costFifo: Number(product.costFifo) || 0,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof SaleError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to adjust inventory"),
      },
      { status: 400 },
    );
  }
}

/** Preview stock impact without mutating (INV-06 warning surface). */
export async function PUT(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const body = await req.json();
    const productId = String(body.productId || "");
    const qty = Number(body.qty);
    const direction = String(body.direction || "out").toLowerCase();

    if (!mongoose.isValidObjectId(productId) || !(qty > 0)) {
      return NextResponse.json({ error: "productId and qty > 0 required" }, { status: 400 });
    }

    const product = await Product.findById(productId)
      .select("name stockSellable")
      .lean<{ name: string; stockSellable: number }>();
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    if (direction === "in") {
      return NextResponse.json({
        ok: true,
        warnings: [] as string[],
        projectedSellable: product.stockSellable + qty,
      });
    }

    const stock = await checkStockAvailability([
      { productId, qty, productName: product.name },
    ]);
    const projected = product.stockSellable - qty;
    const negWarn = warnIfNegativeStock(product.name, projected);

    return NextResponse.json({
      ok: stock.ok && !negWarn,
      warnings: [...stock.warnings, ...(negWarn ? [negWarn] : [])],
      shortages: stock.shortages,
      projectedSellable: projected,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to preview adjustment"),
      },
      { status: 400 },
    );
  }
}
