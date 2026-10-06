import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import {
  buildInventoryValuationExcel,
  loadInventoryValuation,
} from "@/lib/reports/inventoryValuation.server";
import {
  buildInventoryValuationCsv,
  parseValuationBucket,
} from "@/lib/reports/inventoryValuation";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { searchParams } = new URL(req.url);
    const bucket = parseValuationBucket(searchParams.get("bucket"));
    const category = searchParams.get("category");
    const brand = searchParams.get("brand");
    const productId = searchParams.get("productId");
    const format = searchParams.get("format") === "csv" ? "csv" : "xlsx";
    const report = await loadInventoryValuation({
      bucket,
      category,
      brand,
      productId,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `inventory-valuation-${stamp}.${format}`;

    if (format === "csv") {
      const csv = buildInventoryValuationCsv(report);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    const buffer = buildInventoryValuationExcel(report);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to export inventory valuation"),
      },
      { status: 500 },
    );
  }
}
