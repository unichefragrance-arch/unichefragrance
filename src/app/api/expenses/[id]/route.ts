import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Expense } from "@/lib/models";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { assertBranchAccess } from "@/lib/auth/guards";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid expense id" }, { status: 400 });
    }
    const existing = await Expense.findById(id).select("branchId").lean<{ branchId?: unknown }>();
    if (!existing) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }
    if (access) {
      const denied = assertBranchAccess(access, existing.branchId ? String(existing.branchId) : null);
      if (denied) return denied;
    }
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    }
    // A plain object of fields only: update operators ($set / $unset / …) would
    // reach Mongo as-is and get round the field rules below (e.g. move the
    // expense to another branch with {"$set":{"branchId":…}}).
    if (Object.keys(body).some((k) => k.startsWith("$") || k.includes("."))) {
      return NextResponse.json({ error: "Invalid expense update" }, { status: 400 });
    }
    // The branch is set from the creator's session, never moved by an edit.
    delete body.branchId;
    delete body.branchName;
    delete body._id;
    if (body.date) body.date = new Date(body.date);
    const expense = await Expense.findByIdAndUpdate(id, body, {
      new: true,
      runValidators: true,
    });
    if (!expense) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }
    return NextResponse.json(toJSON(expense));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update expense") },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid expense id" }, { status: 400 });
    }
    const existing = await Expense.findById(id).select("branchId").lean<{ branchId?: unknown }>();
    if (!existing) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }
    if (access) {
      const denied = assertBranchAccess(access, existing.branchId ? String(existing.branchId) : null);
      if (denied) return denied;
    }
    await Expense.deleteOne({ _id: id });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete expense") },
      { status: 500 },
    );
  }
}
