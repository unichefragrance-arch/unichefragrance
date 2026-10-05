import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Sale } from "@/lib/models";
import { createSale } from "@/lib/sales/createSale";
import { SaleError } from "@/lib/sales/errors";
import { warmSaleCaches } from "@/lib/sales/validateSale";
import { toJSON, toJSONList } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { canViewCostPrices } from "@/lib/auth/roles";
import { recordAudit } from "@/lib/audit/log";
import { escapeRegex, loosePhoneRegex, phoneDigits } from "@/lib/phone";

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

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    // Warm formula cache on POS boot (held-bills fetch) — first complete stays fast.
    void warmSaleCaches().catch(() => {
      /* non-fatal */
    });
    const { searchParams } = new URL(req.url);
    const limit = Number(searchParams.get("limit") || 20);
    const status = searchParams.get("status") || "completed";
    const phone = searchParams.get("phone")?.trim();
    const customerId = searchParams.get("customerId")?.trim();
    // Conditions are AND-ed via $and so the branch-isolation $or and the
    // customer-match $or (when both customerId and phone are given) can coexist.
    const conditions: Record<string, unknown>[] = [];
    if (status !== "all") {
      conditions.push({ status: status as "completed" | "held" | "void" });
    }
    if (
      access &&
      "role" in access &&
      access.role !== "owner" &&
      access.branchId
    ) {
      conditions.push({
        $or: [
          { branchId: access.branchId },
          { branchId: null },
          { branchId: { $exists: false } },
        ],
      });
    }
    if (customerId && phone) {
      // CRM-02: purchase history — match either the linked customerId or the
      // phone on record, since historical/seeded sales may only carry a phone.
      const digits = phoneDigits(phone);
      conditions.push({
        $or: [
          { customerId },
          {
            customerPhone:
              digits.length >= 7
                ? { $regex: loosePhoneRegex(digits) }
                : { $regex: escapeRegex(phone), $options: "i" },
          },
        ],
      });
    } else if (customerId) {
      conditions.push({ customerId });
    } else if (phone) {
      const digits = phoneDigits(phone);
      conditions.push({
        customerPhone:
          digits.length >= 7
            ? { $regex: loosePhoneRegex(digits) }
            : { $regex: escapeRegex(phone), $options: "i" },
      });
    }
    const filter = conditions.length > 0 ? { $and: conditions } : {};
    const sales = await Sale.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return NextResponse.json(toJSONList(sales).map(mapSale));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load sales") },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const body = await req.json();
    // Wholesale lines are charged at wholesalePrice — a cost-tier figure roles
    // like cashier may not even see — so they must not be able to apply it.
    const hasWholesaleLine =
      Array.isArray(body.lines) &&
      body.lines.some(
        (l: { lineType?: unknown }) => l?.lineType === "wholesale",
      );
    if (hasWholesaleLine && (!access || !canViewCostPrices(access.role))) {
      return NextResponse.json(
        {
          error: "Permission denied: wholesale pricing is not allowed for your role.",
          code: "VALIDATION",
        },
        { status: 403 },
      );
    }
    const headerKey = req.headers.get("idempotency-key") || undefined;
    const { sale, deduplicated, timingMs } = await createSale({
      customerPhone: body.customerPhone,
      customerName: body.customerName,
      customerId: body.customerId,
      salesperson: body.salesperson,
      payment: body.payment,
      lines: body.lines,
      invoiceDiscount: body.invoiceDiscount,
      actor: access
        ? { userId: access.userId, name: access.name, role: access.role }
        : null,
      discountApprovalToken: body.discountApprovalToken,
      status: body.status,
      idempotencyKey: body.idempotencyKey || headerKey,
      branchId: access?.branchId ?? undefined,
      branchName: access?.branchName ?? undefined,
    });

    if (!deduplicated) {
      const saleRec = sale as {
        discountTotal?: number;
        discountApprovedBy?: { name?: string };
      };
      const discountNote =
        (saleRec.discountTotal ?? 0) > 0
          ? ` · discount ${saleRec.discountTotal}${
              saleRec.discountApprovedBy?.name
                ? ` approved by ${saleRec.discountApprovedBy.name}`
                : ""
            }`
          : "";
      recordAudit({
        session: access,
        action: "sale_created",
        entityType: "Sale",
        entityId: String((sale as { id?: string; _id?: unknown }).id ?? (sale as { _id?: unknown })._id ?? ""),
        detail: `${body.customerName || body.customerPhone || "walk-in"} · ${body.payment || ""}${discountNote}`,
        req,
      });
    }

    const payload = { ...mapSale(toJSON(sale)!), deduplicated, timingMs };
    const res = NextResponse.json(payload, {
      status: deduplicated ? 200 : 201,
    });
    if (timingMs?.total != null) {
      res.headers.set("Server-Timing", `sale;dur=${timingMs.total}`);
    }
    return res;
  } catch (error) {
    const message =
      safeErrorMessage(error, "Failed to create sale");
    // Client mistakes (business rules, malformed JSON, bad ids) → 400;
    // anything else (DB outage, bug) is a server failure → 500.
    const isClientError =
      error instanceof SaleError ||
      error instanceof SyntaxError ||
      (error instanceof Error &&
        (error.name === "ValidationError" || error.name === "CastError"));
    // POS-071/072: over-limit discount needs approval / approval refused → 403.
    const isDiscountDenied =
      error instanceof SaleError &&
      (error.code === "DISCOUNT_APPROVAL_REQUIRED" ||
        error.code === "DISCOUNT_NOT_AUTHORIZED");
    const status = isDiscountDenied ? 403 : isClientError ? 400 : 500;
    return NextResponse.json(
      {
        error: message,
        code: error instanceof SaleError ? error.code : "UNKNOWN",
      },
      { status },
    );
  }
}
