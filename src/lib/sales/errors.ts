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
  | "VALIDATION";

export class SaleError extends Error {
  readonly code: SaleErrorCode;

  constructor(code: SaleErrorCode, message: string) {
    super(message);
    this.name = "SaleError";
    this.code = code;
  }
}
