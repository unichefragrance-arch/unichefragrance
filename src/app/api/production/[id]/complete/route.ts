import { NextResponse } from "next/server";
import {
  isFormulaAdminResponse,
  requireFormulaAdmin,
} from "@/lib/auth/formulaAdmin";
import { connectDB } from "@/lib/db";
import { completeProductionOrder } from "@/lib/production/completeProduction";
import { mapProductionOrder } from "@/lib/production/mapProduction";
import { SaleError } from "@/lib/sales/errors";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const admin = requireFormulaAdmin(req);
    if (isFormulaAdminResponse(admin)) return admin;

    await connectDB();
    const { id } = await ctx.params;
    const body = ((await req.json().catch(() => null)) ?? {}) as {
      actualYieldMl?: number | string;
    };

    const actualYieldMl =
      body.actualYieldMl !== undefined && body.actualYieldMl !== ""
        ? Number(body.actualYieldMl)
        : undefined;

    const order = await completeProductionOrder(id, {
      completedBy: admin.name,
      actualYieldMl,
    });

    return NextResponse.json(
      mapProductionOrder(toJSON(order)! as Record<string, unknown>),
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
          safeErrorMessage(error, "Failed to complete production order"),
      },
      { status: 400 },
    );
  }
}
