import { lineTotal, money } from "./document";
import type { ReceiptDoc } from "./types";

/** Long form used for WhatsApp and email bodies. */
export function receiptText(doc: ReceiptDoc): string {
  const currency = doc.store.currency;
  const items = doc.lines.map(
    (line) =>
      `• ${line.name} × ${line.qty}${line.unitLabel ? ` (${line.unitLabel})` : ""} — ${money(lineTotal(line), currency)}`,
  );

  return [
    `${doc.store.name} — ${doc.draft ? "Draft bill" : "Receipt"} ${doc.receiptNo}`,
    `Hi ${doc.customer.name},`,
    "",
    ...(items.length > 0 ? items : ["• (no line items)"]),
    "",
    doc.discountTotal > 0
      ? `Discount: -${money(doc.discountTotal, currency)}`
      : null,
    doc.vatPercent > 0 ? `Subtotal: ${money(doc.subtotal, currency)}` : null,
    doc.vatPercent > 0
      ? `VAT ${doc.vatPercent}%: ${money(doc.vatAmount, currency)}`
      : null,
    `Total: ${money(doc.total, currency)}`,
    `Payment: ${doc.payment}`,
    doc.salesperson ? `Served by: ${doc.salesperson}` : null,
    doc.store.phone ? `Shop: ${doc.store.phone}` : null,
    "",
    doc.store.footer,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** Single-segment friendly summary for SMS. */
export function receiptSmsText(doc: ReceiptDoc): string {
  const currency = doc.store.currency;
  const itemCount = doc.lines.reduce((sum, line) => sum + line.qty, 0);
  return [
    `${doc.store.name}: ${doc.receiptNo}`,
    `${trimCount(itemCount)} item(s) · ${money(doc.total, currency)} · ${doc.payment}`,
    doc.store.phone ? `Queries: ${doc.store.phone}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);
}

function trimCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
