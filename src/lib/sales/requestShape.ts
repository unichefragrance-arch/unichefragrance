/**
 * Shape checks for POST /api/sales — run before any business logic so a
 * malformed body is a controlled 400, never a TypeError deep in checkout.
 * Only types are checked here; business rules stay in createSale/validateSale.
 */
import mongoose from "mongoose";
import { SaleError } from "@/lib/sales/errors";

/** Statuses a checkout may create. Voiding a held bill is PATCH /api/sales/:id. */
export const CHECKOUT_STATUSES = ["completed", "held"] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new SaleError("VALIDATION", message);
}

/** Optional text: absent / null → undefined; anything but a string → 400. */
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") invalid(`${field} must be text`);
  return v;
}

/** Idempotency key from body or header: optional, but a string of bounded length. */
export function parseIdempotencyKey(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid(`${source} must be text`);
  const key = value.trim();
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) invalid(`${source} is too long`);
  return key || undefined;
}

export type CheckoutRequest = {
  customerPhone: string;
  customerName?: string;
  customerId?: string;
  salesperson?: string;
  payment: unknown;
  paymentBreakdown?: unknown[];
  lines: unknown[];
  invoiceDiscount?: unknown;
  discountApprovalToken?: string;
  status?: CheckoutStatus;
  resumedFromId?: string;
  idempotencyKey?: string;
};

export function parseCheckoutBody(body: unknown, headerKey: string | null): CheckoutRequest {
  if (!isPlainObject(body)) invalid("Request body must be a JSON object");

  // POS-142b: only these statuses — anything else (void, null, objects…) would
  // otherwise be stored as-is after stock was deducted.
  const status = body.status;
  if (status !== undefined && !(CHECKOUT_STATUSES as readonly unknown[]).includes(status)) {
    invalid("Invalid sale status — checkout can only complete or hold a bill");
  }

  const phone = body.customerPhone;
  if (typeof phone !== "string" || !phone.trim()) invalid("Customer phone is required");

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    invalid("At least one line item is required");
  }
  if (!body.lines.every(isPlainObject)) invalid("Each line item must be an object");

  const breakdown = body.paymentBreakdown;
  if (breakdown !== undefined && breakdown !== null && !Array.isArray(breakdown)) {
    invalid("paymentBreakdown must be a list");
  }

  const customerId = optionalString(body, "customerId");
  if (customerId && !mongoose.isValidObjectId(customerId)) invalid("Invalid customer id");
  const resumedFromId = optionalString(body, "resumedFromId");
  if (resumedFromId && !mongoose.isValidObjectId(resumedFromId)) invalid("Invalid held bill id");

  const bodyKey = parseIdempotencyKey(body.idempotencyKey, "idempotencyKey");
  const hdrKey = parseIdempotencyKey(headerKey ?? undefined, "Idempotency-Key header");

  return {
    customerPhone: phone,
    customerName: optionalString(body, "customerName"),
    customerId,
    salesperson: optionalString(body, "salesperson"),
    payment: body.payment,
    paymentBreakdown: (breakdown ?? undefined) as unknown[] | undefined,
    lines: body.lines,
    invoiceDiscount: body.invoiceDiscount,
    discountApprovalToken: optionalString(body, "discountApprovalToken"),
    status: status as CheckoutStatus | undefined,
    resumedFromId,
    idempotencyKey: bodyKey ?? hdrKey,
  };
}
