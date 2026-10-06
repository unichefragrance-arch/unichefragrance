import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Expense } from "@/lib/models";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

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
    const body = await req.json();
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
    const expense = await Expense.findByIdAndDelete(id);
    if (!expense) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete expense") },
      { status: 500 },
    );
  }
}
