import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Sale } from "@/lib/models";
import { toJSON } from "@/lib/serialize";
import mongoose from "mongoose";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { assertBranchAccess } from "@/lib/auth/guards";
import { redactSaleCost } from "@/lib/auth/roles";

type RouteContext = { params: Promise<{ id: string }> };

function mapSale(s: Record<string, unknown>) {
  const createdAt = s.createdAt ? new Date(s.createdAt as string) : new Date();
  return {
    ...s,
    time: createdAt.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
    customer: s.customerName,
    type: s.saleType,
    payment:
      typeof s.payment === "string"
        ? s.payment.charAt(0).toUpperCase() + s.payment.slice(1)
        : s.payment,
  };
}

export async function GET(req: Request, context: RouteContext) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await context.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid sale id" }, { status: 400 });
    }
    const sale = await Sale.findById(id);
    if (!sale) {
      return NextResponse.json({ error: "Sale not found" }, { status: 404 });
    }
    // Branch isolation: another branch's sale (and its customer) stays hidden.
    if (access) {
      const denied = assertBranchAccess(access, sale.branchId ? String(sale.branchId) : null);
      if (denied) return denied;
    }
    const json = toJSON(sale)!;
    return NextResponse.json(mapSale(access ? redactSaleCost(json, access.role) : json));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load sale") },
      { status: 500 },
    );
  }
}

/**
 * Void a held bill (discard) or update status.
 * Completing a held bill is done by resuming into the cart then POST /api/sales.
 */
export async function PATCH(req: Request, context: RouteContext) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await context.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid sale id" }, { status: 400 });
    }
    const body = await req.json();
    const sale = await Sale.findById(id).select("status branchId").lean<{
      status: string;
      branchId?: unknown;
    }>();
    if (!sale) {
      return NextResponse.json({ error: "Sale not found" }, { status: 404 });
    }
    if (access) {
      const denied = assertBranchAccess(access, sale.branchId ? String(sale.branchId) : null);
      if (denied) return denied;
    }

    if (body.status === "void") {
      // POS-101: atomic — of two tills discarding/completing the same held bill
      // at once, exactly one wins; the other gets 409.
      const voided = await Sale.findOneAndUpdate(
        { _id: id, status: "held" },
        { $set: { status: "void" } },
        { returnDocument: "after" },
      );
      if (!voided) {
        return NextResponse.json(
          {
            error:
              sale.status === "held"
                ? "This held bill was just completed or discarded on another till"
                : "Only held bills can be discarded",
          },
          { status: sale.status === "held" ? 409 : 400 },
        );
      }
      const json = toJSON(voided)!;
      return NextResponse.json(mapSale(access ? redactSaleCost(json, access.role) : json));
    }

    return NextResponse.json(
      { error: "Unsupported status update" },
      { status: 400 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: safeErrorMessage(error, "Failed to update sale"),
      },
      { status: 400 },
    );
  }
}
