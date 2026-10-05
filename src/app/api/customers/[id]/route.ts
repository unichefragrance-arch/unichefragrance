import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import mongoose from "mongoose";
import { customerProfileFields } from "@/lib/customers/profileFields";
import { Customer } from "@/lib/models";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { requireRole } from "@/lib/auth/guards";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    const customer = await Customer.findById(id);
    if (!customer) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
    const json = toJSON(customer)!;
    return NextResponse.json({
      ...json,
      lastVisit: json.lastVisit
        ? new Date(json.lastVisit as string).toISOString().slice(0, 10)
        : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load customer") },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid customer id" }, { status: 400 });
    }
    const body = await req.json();
    // Profile fields only — balances and purchase totals are never edited here.
    const customer = await Customer.findByIdAndUpdate(
      id,
      { $set: customerProfileFields(body) },
      { new: true, runValidators: true },
    );
    if (!customer) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
    return NextResponse.json(toJSON(customer));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update customer") },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    // CRM-12: Cashier may view/create/edit customers but not delete — Manager+ only.
    const access = requireRole(req, ["owner", "manager"]);
    if (isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    const customer = await Customer.findByIdAndDelete(id);
    if (!customer) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete customer") },
      { status: 500 },
    );
  }
}
