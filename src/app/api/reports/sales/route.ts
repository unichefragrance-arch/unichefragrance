import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import {
  parseAnchorDate,
  parseReportPeriod,
} from "@/lib/reports/period";
import { buildSaleReport, type SaleReportStatus } from "@/lib/reports/salesReport";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { branchScopeFilter } from "@/lib/auth/guards";

export const runtime = "nodejs";

function parseStatus(value: string | null): SaleReportStatus {
  return value === "held" ? "held" : "completed";
}

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { searchParams } = new URL(req.url);
    const report = await buildSaleReport({
      status: parseStatus(searchParams.get("status")),
      period: parseReportPeriod(searchParams.get("period")),
      anchor: parseAnchorDate(searchParams.get("date")),
      limit: Number(searchParams.get("limit") || 500),
      // Non-owners see only their own branch (plus legacy unbranched sales).
      branchFilter: access ? branchScopeFilter(access) : null,
    });
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to load sales report"),
      },
      { status: 500 },
    );
  }
}
