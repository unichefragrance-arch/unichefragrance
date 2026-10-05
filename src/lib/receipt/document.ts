import type {
  ReceiptCustomer,
  ReceiptDoc,
  ReceiptLine,
  ReceiptStore,
} from "./types";

export type ReceiptSettingsInput = {
  branchName?: string;
  currency?: string;
  invoiceLanguages?: string;
  storeLegalName?: string;
  storeAddress?: string;
  storePhone?: string;
  storeTaxNumber?: string;
  receiptLogoUrl?: string;
  receiptFooter?: string;
  vatPercent?: number;
};

export function receiptStoreFromSettings(
  settings: ReceiptSettingsInput | null | undefined,
): ReceiptStore {
  const s = settings ?? {};
  return {
    name: s.branchName?.trim() || "UNICH",
    legalName: s.storeLegalName?.trim() || "",
    address: s.storeAddress?.trim() || "",
    phone: s.storePhone?.trim() || process.env.WHATSAPP_NUMBER || "",
    taxNumber: s.storeTaxNumber?.trim() || "",
    logoUrl: s.receiptLogoUrl?.trim() || "",
    footer: s.receiptFooter?.trim() || "Thank you for shopping with UNICH.",
    currency: s.currency?.trim() || "OMR",
    bilingual: /arab/i.test(s.invoiceLanguages || ""),
  };
}

/** Stable, human-readable number derived from the sale id — a reprint keeps the same number. */
export function receiptNumberFor(saleId: string, issuedAt: Date): string {
  const day = [
    issuedAt.getFullYear(),
    String(issuedAt.getMonth() + 1).padStart(2, "0"),
    String(issuedAt.getDate()).padStart(2, "0"),
  ].join("");
  const suffix = saleId.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase();
  return `INV-${day}-${suffix || "DRAFT"}`;
}

export function money(amount: number, currency: string): string {
  const value = Number.isFinite(amount) ? amount : 0;
  return `${currency} ${value.toFixed(2)}`;
}

export function lineTotal(line: ReceiptLine): number {
  return line.qty * line.unitPrice;
}

export function buildReceiptDoc(input: {
  saleId?: string;
  issuedAt?: Date | string;
  draft?: boolean;
  reprint?: boolean;
  customer: ReceiptCustomer;
  salesperson?: string;
  payment?: string;
  lines: ReceiptLine[];
  /** Gross amount actually charged. Falls back to the sum of the lines. */
  total?: number;
  /** Line + invoice discounts already deducted from `total`. */
  discountTotal?: number;
  settings?: ReceiptSettingsInput | null;
}): ReceiptDoc {
  const store = receiptStoreFromSettings(input.settings);
  const issuedAt = input.issuedAt ? new Date(input.issuedAt) : new Date();
  const lines = input.lines ?? [];
  const gross =
    typeof input.total === "number" && Number.isFinite(input.total)
      ? input.total
      : lines.reduce((sum, line) => sum + lineTotal(line), 0);

  // Shelf prices already include VAT, so the tax is split out of the amount charged
  // rather than added on top — the printed total always equals the recorded sale total.
  const vatPercent = Math.max(0, Number(input.settings?.vatPercent ?? 0));
  const net = vatPercent > 0 ? gross / (1 + vatPercent / 100) : gross;
  const vatAmount = round2(gross - net);

  return {
    receiptNo: receiptNumberFor(input.saleId || "", issuedAt),
    issuedAt: issuedAt.toISOString(),
    draft: Boolean(input.draft),
    reprint: Boolean(input.reprint),
    store,
    customer: {
      name: input.customer.name?.trim() || "Walk-in Customer",
      phone: input.customer.phone?.trim() || "",
      email: input.customer.email?.trim() || "",
    },
    salesperson: input.salesperson?.trim() || "",
    payment: input.payment?.trim() || "cash",
    lines,
    subtotal: round2(gross - vatAmount),
    vatPercent,
    vatAmount,
    discountTotal: round2(Math.max(0, Number(input.discountTotal ?? 0) || 0)),
    total: round2(gross),
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
