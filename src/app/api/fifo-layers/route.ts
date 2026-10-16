import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { FifoLayer, InventoryAdjustment, Product } from "@/lib/models";
import { addFifoLayer } from "@/lib/inventory";
import { assertQtyFitsUnit, StockAdjustmentError } from "@/lib/inventory/stockAdjustment";
import { toJSON, toJSONList } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { canViewCostPrices } from "@/lib/auth/roles";

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { searchParams } = new URL(req.url);
    const productId = searchParams.get("productId");
    const filter = productId ? { productId } : {};
    const layers = await FifoLayer.find(filter).sort({ purchaseDate: 1 });
    const showCost = !access || canViewCostPrices(access.role);
    return NextResponse.json(
      toJSONList(layers).map((l) => ({
        ...l,
        productId: String(l.productId),
        supplierId: String(l.supplierId),
        productionOrderId: l.productionOrderId
          ? String(l.productionOrderId)
          : undefined,
        source: (l.source as string) || "purchase",
        purchaseDate:
          l.purchaseDate instanceof Date
            ? l.purchaseDate.toISOString().slice(0, 10)
            : String(l.purchaseDate).slice(0, 10),
        ...(showCost ? {} : { unitCost: undefined }),
      })),
    );
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load FIFO layers") },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const body = await req.json();
    const productId = String(body?.productId ?? "");
    if (!mongoose.isValidObjectId(productId)) {
      return NextResponse.json({ error: "Valid productId required" }, { status: 400 });
    }
    const product = await Product.findById(productId)
      .select("name unit")
      .lean<{ _id: mongoose.Types.ObjectId; name: string; unit?: string }>();
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    // A manual layer adds real stock at a real cost: positive qty that fits the
    // unit, cost ≥ 0, a valid date. Before, -3 created a negative layer that
    // REDUCED stock, a negative cost was stored, and a missing product got an
    // orphan layer — all without any inventory record.
    const qty = Number(body.qtyRemaining ?? body.qty);
    const unitCost = Number(body.unitCost);
    const purchaseDate = new Date(body.purchaseDate);
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: "qty must be a number greater than 0" }, { status: 400 });
    }
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      return NextResponse.json({ error: "unitCost must be a number of 0 or more" }, { status: 400 });
    }
    if (Number.isNaN(purchaseDate.getTime())) {
      return NextResponse.json({ error: "purchaseDate must be a valid date" }, { status: 400 });
    }
    try {
      assertQtyFitsUnit(qty, product.unit, "qty");
    } catch (err) {
      if (err instanceof StockAdjustmentError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    // The layer (stock) and its inventory record commit together.
    let layer!: Awaited<ReturnType<typeof addFifoLayer>>;
    await mongoose.connection.transaction(async (session) => {
      layer = await addFifoLayer(
        {
          productId,
          supplierId: body.supplierId,
          supplierName: body.supplierName,
          purchaseDate,
          qty,
          unitCost,
          currency: body.currency || "OMR",
        },
        { session },
      );
      await InventoryAdjustment.create(
        [{
          productId: product._id,
          productName: product.name,
          qty,
          direction: "in",
          reason: "restock",
          costTotal: 0,
          notes: `Manual FIFO layer @ ${unitCost} (${body.supplierName || "no supplier"})`,
          createdBy: access?.name,
          ...(access?.branchId && mongoose.isValidObjectId(access.branchId)
            ? { branchId: new mongoose.Types.ObjectId(access.branchId), branchName: access.branchName ?? undefined }
            : {}),
        }],
        { session },
      );
    });
    return NextResponse.json(toJSON(layer), { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create FIFO layer") },
      { status: 400 },
    );
  }
}
