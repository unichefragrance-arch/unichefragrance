import { NextResponse } from "next/server";
import { parseFormat, receiptDocForSale } from "@/lib/receipt/server";
import { renderReceiptHtml } from "@/lib/receipt/template";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { Sale } from "@/lib/models";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { assertBranchAccess } from "@/lib/auth/guards";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: Request, context: RouteContext) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const { id } = await context.params;
    const { searchParams } = new URL(req.url);
    const format = parseFormat(searchParams.get("format"));
    const reprint = searchParams.get("reprint") === "1";

    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid sale id" }, { status: 400 });
    }
    // Branch isolation, same as GET /api/sales/:id.
    if (access) {
      await connectDB();
      const owner = await Sale.findById(id).select("branchId").lean<{ branchId?: unknown }>();
      if (!owner) return NextResponse.json({ error: "Sale not found" }, { status: 404 });
      const denied = assertBranchAccess(access, owner.branchId ? String(owner.branchId) : null);
      if (denied) return denied;
    }

    const doc = await receiptDocForSale(id, { reprint });
    if (!doc) {
      return NextResponse.json({ error: "Sale not found" }, { status: 404 });
    }

    if (searchParams.get("as") === "json") {
      return NextResponse.json(doc);
    }

    return new Response(renderReceiptHtml(doc, format), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to render receipt"),
      },
      { status: 500 },
    );
  }
}
