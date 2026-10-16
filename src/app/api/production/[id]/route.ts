import mongoose from "mongoose";
import { NextResponse } from "next/server";
import {
  isFormulaAdminResponse,
  requireFormulaAdmin,
} from "@/lib/auth/formulaAdmin";
import { connectDB } from "@/lib/db";
import { CLAIM_STALE_MS } from "@/lib/production/completeProduction";
import { mapProductionOrder } from "@/lib/production/mapProduction";
import { SaleError } from "@/lib/sales/errors";
import { ProductionOrder } from "@/lib/models";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const admin = requireFormulaAdmin(req);
    if (isFormulaAdminResponse(admin)) return admin;

    await connectDB();
    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid production order id" }, { status: 400 });
    }
    const order = await ProductionOrder.findById(id).lean();
    if (!order) {
      return NextResponse.json(
        { error: "Production order not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      mapProductionOrder(toJSON(order)! as Record<string, unknown>),
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to load production order"),
      },
      { status: 500 },
    );
  }
}

/** Cancel a draft production order (completed orders cannot be deleted). */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const admin = requireFormulaAdmin(req);
    if (isFormulaAdminResponse(admin)) return admin;

    await connectDB();
    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid production order id" }, { status: 400 });
    }
    const order = await ProductionOrder.findById(id);
    if (!order) {
      return NextResponse.json(
        { error: "Production order not found" },
        { status: 404 },
      );
    }
    if (order.status === "completed") {
      throw new SaleError(
        "VALIDATION",
        "Completed production orders cannot be cancelled",
      );
    }
    if (order.status === "cancelled") {
      return NextResponse.json(
        mapProductionOrder(toJSON(order)! as Record<string, unknown>),
      );
    }

    // Atomic: only a draft that no request is completing right now can be
    // cancelled. A plain save() here used to overwrite a completion that
    // committed after the read above — a "cancelled" order whose materials
    // were consumed and whose output was added.
    const cancelled = await ProductionOrder.findOneAndUpdate(
      {
        _id: order._id,
        status: "draft",
        $or: [
          { completingAt: null },
          { completingAt: { $lt: new Date(Date.now() - CLAIM_STALE_MS) } },
        ],
      },
      { $set: { status: "cancelled", cancelledAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!cancelled) {
      return NextResponse.json(
        { error: "This production order is being completed or was just completed — it can't be cancelled" },
        { status: 409 },
      );
    }

    return NextResponse.json(
      mapProductionOrder(toJSON(cancelled)! as Record<string, unknown>),
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
          safeErrorMessage(error, "Failed to cancel production order"),
      },
      { status: 400 },
    );
  }
}
