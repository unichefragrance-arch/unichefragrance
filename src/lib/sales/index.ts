export {
  createSale,
  resolveCustomerByPhone,
  resolveSalesperson,
  trustedCustomerId,
  normalizePaymentBreakdown,
  creditPortion,
  FAST_WC,
} from "@/lib/sales/createSale";
export { SaleError } from "@/lib/sales/errors";
export {
  validateRemixSale,
  validateSaleLines,
  tryFastValidateSaleLines,
  assertStockAvailable,
} from "@/lib/sales/validateSale";
export {
  REMIX_COMPONENT_ROLES,
  REMIX_REQUIRED_ROLES,
  OIL_BASE_PRODUCT_ID,
  REMIX_OIL_ML,
  REFILL_CUSTOMER_BOTTLE_ML,
  REFILL_OMR_PER_ML,
  matchRemixRole,
} from "@/lib/sales/constants";
