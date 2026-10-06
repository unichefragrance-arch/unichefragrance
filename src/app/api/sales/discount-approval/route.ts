import { NextResponse } from "next/server";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { recordAudit } from "@/lib/audit/log";
import { discountsFor } from "@/lib/sales/createSale";
import { exceedsDiscountLimit } from "@/lib/sales/discount";
import {
  cartFingerprint,
  issueDiscountApproval,
  resolveDiscountApproval,
} from "@/lib/sales/discountApproval";
import { SaleError } from "@/lib/sales/errors";
import { checkPriceFloor, needsAdminForFloor, priceFloorMessage } from "@/lib/sales/priceFloor";
import { isPlainObject } from "@/lib/sales/requestShape";
import { validateSaleLines, type IncomingSaleLine } from "@/lib/sales/validateSale";

/**
 * POS-071/072: a manager approves an over-limit discount for THIS cart.
 * Credentials are checked here (rate-limited like login) and exchanged for a
 * single-use, short-lived token bound to the cashier + cart fingerprint.
 * POST /api/sales then carries only `discountApprovalToken`.
 */
export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;
    if (access === null) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const body = await req.json();
    if (!isPlainObject(body) || !Array.isArray(body.lines) || !body.lines.every(isPlainObject)) {
      return NextResponse.json(
        { error: "Request body must be an object with a list of line items", code: "VALIDATION" },
        { status: 400 },
      );
    }
    // Server prices, same as checkout — the % approved is the % that will be charged.
    const validated = await validateSaleLines(body.lines as IncomingSaleLine[]);
    const breakdown = discountsFor(
      validated.lines,
      body.lines as IncomingSaleLine[],
      body.invoiceDiscount,
      validated.subtotal,
    );
    const actor = { userId: access.userId, name: access.name, role: access.role };
    // POS-062/063: below the minimum price → only the Admin can approve.
    const floorViolations = await checkPriceFloor(validated, breakdown);
    const priceFloor = needsAdminForFloor(floorViolations, actor.role)
      ? { message: priceFloorMessage(floorViolations) }
      : null;
    const discountNeedsApproval =
      breakdown.discountTotal > 0 && exceedsDiscountLimit(breakdown, actor.role);
    if (!discountNeedsApproval && !priceFloor) {
      return NextResponse.json({ required: false });
    }

    const approver = await resolveDiscountApproval(
      breakdown,
      actor,
      {
        email: typeof body.email === "string" ? body.email : undefined,
        password: typeof body.password === "string" ? body.password : undefined,
      },
      priceFloor,
    );
    // resolveDiscountApproval returns null only when no approval is needed.
    if (!approver) return NextResponse.json({ required: false });

    const { token, expiresAt } = await issueDiscountApproval({
      breakdown,
      actor,
      approver,
      fingerprint: cartFingerprint(body.lines as IncomingSaleLine[], body.invoiceDiscount),
    });

    recordAudit({
      session: access,
      action: "discount_approved",
      entityType: "Sale",
      detail: `${breakdown.maxDiscountPct}% (−${breakdown.discountTotal})${
        priceFloor ? ` below minimum price (${priceFloor.message})` : ""
      } approved by ${approver.name} (${approver.role})`,
      req,
    });

    return NextResponse.json({
      required: true,
      approvalToken: token,
      expiresAt,
      approver: { name: approver.name, role: approver.role },
      maxDiscountPct: breakdown.maxDiscountPct,
      discountTotal: breakdown.discountTotal,
      belowMinimumPrice: priceFloor !== null,
    });
  } catch (error) {
    const denied =
      error instanceof SaleError &&
      (error.code === "DISCOUNT_APPROVAL_REQUIRED" ||
        error.code === "DISCOUNT_NOT_AUTHORIZED" ||
        error.code === "PRICE_FLOOR_APPROVAL_REQUIRED");
    const clientError = error instanceof SaleError || error instanceof SyntaxError;
    return NextResponse.json(
      {
        error: safeErrorMessage(error, "Could not approve discount"),
        code: error instanceof SaleError ? error.code : "UNKNOWN",
      },
      { status: denied ? 403 : clientError ? 400 : 500 },
    );
  }
}
