import { NextResponse } from "next/server";
import {
  isFormulaAdminResponse,
  requireFormulaAdmin,
} from "@/lib/auth/formulaAdmin";
import { connectDB } from "@/lib/db";
import { createProductionOrder } from "@/lib/production/completeProduction";
import { mapProductionOrder } from "@/lib/production/mapProduction";
import { SaleError } from "@/lib/sales/errors";
import { ProductionOrder } from "@/lib/models";
import { toJSON, toJSONList } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const admin = requireFormulaAdmin(req);
    if (isFormulaAdminResponse(admin)) return admin;

    await connectDB();
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;

    const orders = await ProductionOrder.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return NextResponse.json(
      toJSONList(orders).map((o) =>
        mapProductionOrder(o as Record<string, unknown>),
      ),
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to load production orders"),
      },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const admin = requireFormulaAdmin(req);
    if (isFormulaAdminResponse(admin)) return admin;

    await connectDB();
    const body = await req.json();

    const order = await createProductionOrder({
      formulaId: String(body.formulaId || ""),
      qty: Number(body.qty),
      oilProductId: body.oilProductId ? String(body.oilProductId) : undefined,
      outputProductId: String(body.outputProductId || ""),
      outputQty:
        body.outputQty !== undefined && body.outputQty !== ""
          ? Number(body.outputQty)
          : undefined,
      actualYieldMl:
        body.actualYieldMl !== undefined && body.actualYieldMl !== ""
          ? Number(body.actualYieldMl)
          : undefined,
      notes: body.notes ? String(body.notes) : undefined,
      createdBy: admin.name,
      complete: body.complete === true,
    });

    return NextResponse.json(
      mapProductionOrder(toJSON(order)! as Record<string, unknown>),
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
          safeErrorMessage(error, "Failed to create production order"),
      },
      { status: 400 },
    );
  }
}
