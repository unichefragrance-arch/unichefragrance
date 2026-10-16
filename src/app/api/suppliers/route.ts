import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Supplier } from "@/lib/models";
import { toJSON, toJSONList } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

function mapSupplier(s: Record<string, unknown>) {
  return {
    ...s,
    lastPurchase: s.lastPurchase
      ? new Date(s.lastPurchase as string).toISOString().slice(0, 10)
      : null,
  };
}

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const suppliers = await Supplier.find().sort({ name: 1 });
    return NextResponse.json(toJSONList(suppliers).map(mapSupplier));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load suppliers") },
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
    // Ids and timestamps are set by the server, never by the request.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, id, __v, createdAt, updatedAt, ...fields } = body ?? {};
    const supplier = await Supplier.create({
      ...fields,
      lastPurchase: body.lastPurchase ? new Date(body.lastPurchase) : undefined,
    });
    return NextResponse.json(mapSupplier(toJSON(supplier)!), { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create supplier") },
      { status: 400 },
    );
  }
}
