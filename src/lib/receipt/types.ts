export type ReceiptFormat = "thermal" | "a4";

export type ReceiptLine = {
  name: string;
  qty: number;
  unitLabel: string;
  unitPrice: number;
  note?: string;
};

export type ReceiptStore = {
  name: string;
  legalName: string;
  address: string;
  phone: string;
  taxNumber: string;
  logoUrl: string;
  footer: string;
  currency: string;
  bilingual: boolean;
};

export type ReceiptCustomer = {
  name: string;
  phone: string;
  email?: string;
};

export type ReceiptDoc = {
  receiptNo: string;
  issuedAt: string;
  /** Cart has not been checked out yet — printed copy is watermarked, not a tax invoice. */
  draft: boolean;
  reprint: boolean;
  store: ReceiptStore;
  customer: ReceiptCustomer;
  salesperson: string;
  payment: string;
  lines: ReceiptLine[];
  /** Net of VAT when VAT is configured, otherwise equal to total. */
  subtotal: number;
  vatPercent: number;
  vatAmount: number;
  /** POS discounts (line + invoice) already taken off `total`; 0 when none. */
  discountTotal: number;
  total: number;
};
