import { connectDB } from "@/lib/db";
import { AppSettings, Sale } from "@/lib/models";
import { buildReceiptDoc, type ReceiptSettingsInput } from "./document";
import type { ReceiptDoc, ReceiptFormat, ReceiptLine } from "./types";

export type ReceiptSettings = ReceiptSettingsInput & {
  receiptFormat: ReceiptFormat;
  autoPrintReceipt: boolean;
};

/** Short TTL — settings rarely change mid-shift; avoids an extra Atlas round-trip per send. */
let settingsCache: { at: number; value: ReceiptSettings } | null = null;
const SETTINGS_CACHE_MS = 60_000;

export function invalidateReceiptSettingsCache() {
  settingsCache = null;
}

export async function loadReceiptSettings(): Promise<ReceiptSettings> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < SETTINGS_CACHE_MS) {
    return settingsCache.value;
  }

  await connectDB();
  const settings = await AppSettings.findOne({ key: "default" })
    .select(
      "branchName currency invoiceLanguages storeLegalName storeAddress storePhone storeTaxNumber receiptLogoUrl receiptFooter vatPercent receiptFormat autoPrintReceipt",
    )
    .lean<Record<string, unknown>>();
  const raw = settings ?? {};
  const format = raw.receiptFormat === "a4" ? "a4" : "thermal";
  const value: ReceiptSettings = {
    branchName: str(raw.branchName),
    currency: str(raw.currency) || "OMR",
    invoiceLanguages: str(raw.invoiceLanguages),
    storeLegalName: str(raw.storeLegalName),
    storeAddress: str(raw.storeAddress),
    storePhone: str(raw.storePhone),
    storeTaxNumber: str(raw.storeTaxNumber),
    receiptLogoUrl: str(raw.receiptLogoUrl),
    receiptFooter: str(raw.receiptFooter),
    vatPercent: Number(raw.vatPercent ?? 0),
    receiptFormat: format,
    autoPrintReceipt: raw.autoPrintReceipt === true,
  };
  settingsCache = { at: now, value };
  return value;
}

export function parseFormat(value: string | null | undefined): ReceiptFormat {
  return value === "a4" ? "a4" : "thermal";
}

export async function receiptDocForSale(
  saleId: string,
  options?: { reprint?: boolean; settings?: ReceiptSettings },
): Promise<ReceiptDoc | null> {
  await connectDB();
  const sale = await Sale.findById(saleId)
    .select(
      "createdAt status customerName customerPhone salesperson payment lines total discountTotal",
    )
    .lean<Record<string, unknown>>();
  if (!sale) return null;

  const settings = options?.settings ?? (await loadReceiptSettings());
  const lines = Array.isArray(sale.lines)
    ? (sale.lines as Record<string, unknown>[]).map(
        (line): ReceiptLine => ({
          name: str(line.name),
          qty: Number(line.qty ?? 0),
          unitLabel: str(line.unitLabel),
          unitPrice: Number(line.unitPrice ?? 0),
        }),
      )
    : [];

  return buildReceiptDoc({
    saleId,
    issuedAt: (sale.createdAt as Date) ?? new Date(),
    draft: sale.status === "held",
    reprint: Boolean(options?.reprint),
    customer: {
      name: str(sale.customerName),
      phone: str(sale.customerPhone),
    },
    salesperson: str(sale.salesperson),
    payment: str(sale.payment) || "cash",
    lines,
    total: Number(sale.total ?? 0),
    discountTotal: Number(sale.discountTotal ?? 0),
    settings,
  });
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
