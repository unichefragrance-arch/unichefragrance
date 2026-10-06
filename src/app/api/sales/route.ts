import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Sale } from "@/lib/models";
import { createSale } from "@/lib/sales/createSale";
import { SaleError } from "@/lib/sales/errors";
import { parseCheckoutBody } from "@/lib/sales/requestShape";
import { warmSaleCaches, type IncomingSaleLine } from "@/lib/sales/validateSale";
import { toJSON, toJSONList } from "@/lib/serialize";
import { isAuthResponse, isDbUnavailable, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { branchScopeFilter } from "@/lib/auth/guards";
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
    const requestedLimit = Number(searchParams.get("limit") || 20);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500)
      : 20;
    // POS-099: held-bill search (customer name or phone) so bills beyond the
    // list cap stay reachable.
    const q = searchParams.get("q")?.trim().slice(0, 64);
    const status = searchParams.get("status") || "completed";
    const phone = searchParams.get("phone")?.trim();
    const customerId = searchParams.get("customerId")?.trim();
    // Conditions are AND-ed via $and so the branch-isolation $or and the
    // customer-match $or (when both customerId and phone are given) can coexist.
    const conditions: Record<string, unknown>[] = [];
    if (status !== "all") {
      conditions.push({ status: status as "completed" | "held" | "void" });
    }
    // Branch isolation — a non-owner with no branch sees only unbranched
    // (legacy) sales, never every branch.
    const branchFilter = access && "role" in access ? branchScopeFilter(access) : null;
    if (branchFilter) conditions.push(branchFilter);
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
    if (q) {
      const digits = phoneDigits(q);
      conditions.push({
        $or: [
          { customerName: { $regex: escapeRegex(q), $options: "i" } },
          ...(digits.length >= 3 ? [{ customerPhone: { $regex: loosePhoneRegex(digits) } }] : []),
        ],
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

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: "Request body must be valid JSON", code: "VALIDATION" }, { status: 400 });
    }
    // Types are checked before any business logic: a malformed body is a 400,
    // and only "completed" / "held" (or no status) may reach createSale.
    const body = parseCheckoutBody(raw, req.headers.get("idempotency-key"));
    // Wholesale lines are charged at wholesalePrice — a cost-tier figure roles
    // like cashier may not even see — so they must not be able to apply it.
    const hasWholesaleLine = body.lines.some(
      (l) => (l as { lineType?: unknown }).lineType === "wholesale",
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
    const { sale, deduplicated, timingMs } = await createSale({
      customerPhone: body.customerPhone,
      customerName: body.customerName,
      customerId: body.customerId,
      salesperson: body.salesperson,
      payment: body.payment,
      paymentBreakdown: body.paymentBreakdown,
      lines: body.lines as IncomingSaleLine[],
      invoiceDiscount: body.invoiceDiscount,
      actor: access
        ? { userId: access.userId, name: access.name, role: access.role }
        : null,
      discountApprovalToken: body.discountApprovalToken,
      status: body.status,
      resumedFromId: body.resumedFromId,
      idempotencyKey: body.idempotencyKey,
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
    // POS-062: below the minimum price without Admin approval → 403.
    const isDiscountDenied =
      error instanceof SaleError &&
      (error.code === "DISCOUNT_APPROVAL_REQUIRED" ||
        error.code === "DISCOUNT_NOT_AUTHORIZED" ||
        error.code === "PRICE_FLOOR_APPROVAL_REQUIRED");
    // POS-098: the resumed held bill was completed/discarded elsewhere → 409.
    // POS-154: this user's key already made a sale with a different bill → 409.
    const isConflict =
      error instanceof SaleError &&
      (error.code === "HELD_BILL_UNAVAILABLE" || error.code === "IDEMPOTENCY_CONFLICT");
    const status = isConflict
      ? 409
      : isDiscountDenied
        ? 403
        : isClientError
          ? 400
          : isDbUnavailable(error)
            ? 503
            : 500;
    return NextResponse.json(
      {
        error: message,
        code: error instanceof SaleError ? error.code : "UNKNOWN",
        ...(error instanceof SaleError ? error.details : {}),
      },
      { status },
    );
  }
}
