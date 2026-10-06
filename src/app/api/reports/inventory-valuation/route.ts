import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { loadInventoryValuation } from "@/lib/reports/inventoryValuation.server";
import { parseValuationBucket } from "@/lib/reports/inventoryValuation";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { searchParams } = new URL(req.url);
    const report = await loadInventoryValuation({
      bucket: parseValuationBucket(searchParams.get("bucket")),
      category: searchParams.get("category"),
      brand: searchParams.get("brand"),
      productId: searchParams.get("productId"),
    });
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to load inventory valuation"),
      },
      { status: 500 },
    );
  }
}
