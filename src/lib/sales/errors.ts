export type SaleErrorCode =
  | "FORMULA_MISSING"
  | "FORMULA_INCOMPLETE"
  | "OIL_NOT_SELECTED"
  | "INSUFFICIENT_STOCK"
  | "INVALID_LINE"
  | "PRODUCT_NOT_FOUND"
  | "DUPLICATE_CHECKOUT"
  | "INVALID_DISCOUNT"
  | "DISCOUNT_APPROVAL_REQUIRED"
  | "DISCOUNT_NOT_AUTHORIZED"
  | "PRICE_FLOOR_APPROVAL_REQUIRED"
  | "HELD_BILL_UNAVAILABLE"
  /** Same idempotency key, different bill — the earlier sale stands (409). */
  | "IDEMPOTENCY_CONFLICT"
  | "VALIDATION";

export class SaleError extends Error {
  readonly code: SaleErrorCode;
  /** Safe extra fields for the response body (only ever the caller's own data). */
  readonly details?: Record<string, string>;

  constructor(code: SaleErrorCode, message: string, details?: Record<string, string>) {
    super(message);
    this.name = "SaleError";
    this.code = code;
    this.details = details;
  }
}
