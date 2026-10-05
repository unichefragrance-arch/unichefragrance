import { lineTotal, money } from "./document";
import type { ReceiptDoc, ReceiptFormat } from "./types";

const AR = {
  invoice: "فاتورة ضريبية",
  receipt: "إيصال",
  date: "التاريخ",
  customer: "العميل",
  salesperson: "البائع",
  payment: "الدفع",
  item: "الصنف",
  qty: "الكمية",
  price: "السعر",
  amount: "المبلغ",
  subtotal: "المجموع الفرعي",
  discount: "الخصم",
  vat: "ضريبة القيمة المضافة",
  total: "الإجمالي",
  trn: "الرقم الضريبي",
};

export function renderReceiptHtml(
  doc: ReceiptDoc,
  format: ReceiptFormat = "thermal",
): string {
  const title = doc.vatPercent > 0 ? "TAX INVOICE" : "RECEIPT";
  const heading = doc.store.bilingual
    ? `${title} · ${doc.vatPercent > 0 ? AR.invoice : AR.receipt}`
    : title;

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<title>${esc(doc.receiptNo)}</title>
<style>${format === "thermal" ? thermalCss() : a4Css()}</style>
</head>
<body class="${format}${doc.draft ? " is-draft" : ""}">
<main class="sheet">
  ${storeHeader(doc)}
  <div class="doc-title">${esc(heading)}</div>
  ${doc.draft ? `<div class="stamp">DRAFT — NOT A TAX INVOICE</div>` : ""}
  ${doc.reprint && !doc.draft ? `<div class="stamp">REPRINT</div>` : ""}
  ${metaBlock(doc)}
  ${linesTable(doc, format)}
  ${totalsBlock(doc)}
  ${footerBlock(doc)}
</main>
<script>window.__receiptReady = true;</script>
</body>
</html>`;
}

function storeHeader(doc: ReceiptDoc): string {
  const { store } = doc;
  return `<header class="store">
    ${store.logoUrl ? `<img class="logo" src="${esc(store.logoUrl)}" alt="" />` : ""}
    <h1>${esc(store.name)}</h1>
    ${store.legalName ? `<p>${esc(store.legalName)}</p>` : ""}
    ${store.address ? `<p>${esc(store.address)}</p>` : ""}
    ${store.phone ? `<p>Tel: ${esc(store.phone)}</p>` : ""}
    ${
      store.taxNumber
        ? `<p>${store.bilingual ? `${AR.trn} / ` : ""}TRN: ${esc(store.taxNumber)}</p>`
        : ""
    }
  </header>`;
}

function metaBlock(doc: ReceiptDoc): string {
  const issued = new Date(doc.issuedAt);
  const rows: [string, string][] = [
    ["No.", doc.receiptNo],
    [label("Date", AR.date, doc), formatStamp(issued)],
    [label("Customer", AR.customer, doc), doc.customer.name],
  ];
  if (doc.customer.phone) rows.push(["Phone", doc.customer.phone]);
  if (doc.salesperson) {
    rows.push([label("Salesperson", AR.salesperson, doc), doc.salesperson]);
  }
  rows.push([label("Payment", AR.payment, doc), titleCase(doc.payment)]);

  return `<section class="meta">${rows
    .map(
      ([key, value]) =>
        `<div class="meta-row"><span>${esc(key)}</span><span>${esc(value)}</span></div>`,
    )
    .join("")}</section>`;
}

function linesTable(doc: ReceiptDoc, format: ReceiptFormat): string {
  const currency = doc.store.currency;
  const head =
    format === "a4"
      ? `<thead><tr>
          <th class="idx">#</th>
          <th>${esc(label("Item", AR.item, doc))}</th>
          <th class="num">${esc(label("Qty", AR.qty, doc))}</th>
          <th class="num">${esc(label("Price", AR.price, doc))}</th>
          <th class="num">${esc(label("Amount", AR.amount, doc))}</th>
        </tr></thead>`
      : `<thead><tr>
          <th>${esc(label("Item", AR.item, doc))}</th>
          <th class="num">${esc(label("Amount", AR.amount, doc))}</th>
        </tr></thead>`;

  const body = doc.lines
    .map((line, index) => {
      const qty = `${trimNum(line.qty)} × ${line.unitLabel}`;
      if (format === "a4") {
        return `<tr>
          <td class="idx">${index + 1}</td>
          <td>${esc(line.name)}${line.note ? `<span class="note">${esc(line.note)}</span>` : ""}</td>
          <td class="num">${esc(qty)}</td>
          <td class="num">${esc(money(line.unitPrice, currency))}</td>
          <td class="num">${esc(money(lineTotal(line), currency))}</td>
        </tr>`;
      }
      return `<tr>
        <td>${esc(line.name)}<span class="note">${esc(qty)} @ ${esc(money(line.unitPrice, currency))}</span></td>
        <td class="num">${esc(money(lineTotal(line), currency))}</td>
      </tr>`;
    })
    .join("");

  const empty = `<tr><td colspan="${format === "a4" ? 5 : 2}" class="empty">No items</td></tr>`;

  return `<table class="lines">${head}<tbody>${body || empty}</tbody></table>`;
}

function totalsBlock(doc: ReceiptDoc): string {
  const currency = doc.store.currency;
  const rows: [string, string, boolean][] = [];
  if (doc.discountTotal > 0) {
    rows.push([
      label("Discount", AR.discount, doc),
      `-${money(doc.discountTotal, currency)}`,
      false,
    ]);
  }
  if (doc.vatPercent > 0) {
    rows.push([label("Subtotal", AR.subtotal, doc), money(doc.subtotal, currency), false]);
    // Percentage stays inside the English half so bidi does not reorder it.
    rows.push([
      label(`VAT ${trimNum(doc.vatPercent)}%`, AR.vat, doc),
      money(doc.vatAmount, currency),
      false,
    ]);
  }
  rows.push([label("Total", AR.total, doc), money(doc.total, currency), true]);

  return `<section class="totals">${rows
    .map(
      ([key, value, strong]) =>
        `<div class="total-row${strong ? " grand" : ""}"><span>${esc(key)}</span><span>${esc(value)}</span></div>`,
    )
    .join("")}${
    doc.vatPercent > 0
      ? `<p class="vat-note">Prices are inclusive of ${trimNum(doc.vatPercent)}% VAT.</p>`
      : ""
  }</section>`;
}

function footerBlock(doc: ReceiptDoc): string {
  return `<footer class="foot">
    <p>${esc(doc.store.footer)}</p>
    <p class="ref">${esc(doc.receiptNo)}</p>
  </footer>`;
}

function label(en: string, ar: string, doc: ReceiptDoc): string {
  return doc.store.bilingual ? `${en} / ${ar}` : en;
}

function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function trimNum(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function esc(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const sharedCss = `
* { box-sizing: border-box; }
body { margin: 0; color: #000; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.store { text-align: center; }
.store .logo { max-height: 56px; max-width: 60%; object-fit: contain; margin-bottom: 6px; }
.store h1 { margin: 0 0 2px; letter-spacing: 0.06em; text-transform: uppercase; }
.store p { margin: 1px 0; }
.doc-title { text-align: center; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
.stamp { margin: 6px 0; text-align: center; font-weight: 700; letter-spacing: 0.12em; border: 1px dashed #000; padding: 3px; }
.meta-row, .total-row { display: flex; justify-content: space-between; gap: 10px; }
.meta-row span:first-child, .total-row span:first-child { color: #333; }
table.lines { width: 100%; border-collapse: collapse; }
table.lines th { text-align: left; font-weight: 700; }
table.lines .num { text-align: right; white-space: nowrap; }
table.lines .note { display: block; color: #444; }
table.lines .empty { text-align: center; color: #555; padding: 10px 0; }
.total-row.grand { font-weight: 700; }
.vat-note { margin: 4px 0 0; color: #333; }
.foot { text-align: center; }
.foot .ref { letter-spacing: 0.1em; }
@media print { .sheet { page-break-inside: avoid; } }
`;

function thermalCss(): string {
  return `${sharedCss}
@page { size: 80mm auto; margin: 3mm; }
body { width: 74mm; font-family: "Courier New", ui-monospace, monospace; font-size: 11px; line-height: 1.35; }
.store h1 { font-size: 15px; }
.store p { font-size: 10px; }
.doc-title { font-size: 12px; margin: 6px 0; padding: 3px 0; border-top: 1px dashed #000; border-bottom: 1px dashed #000; }
.meta { margin-bottom: 6px; font-size: 10px; }
table.lines { font-size: 10px; margin-bottom: 6px; }
table.lines thead th { border-bottom: 1px dashed #000; padding-bottom: 2px; }
table.lines td { vertical-align: top; padding: 3px 0; border-bottom: 1px dotted #bbb; }
table.lines .note { font-size: 9px; }
.totals { border-top: 1px dashed #000; padding-top: 4px; font-size: 11px; }
.total-row.grand { font-size: 13px; margin-top: 2px; }
.vat-note { font-size: 9px; }
.foot { margin-top: 8px; padding-top: 6px; border-top: 1px dashed #000; font-size: 10px; }
`;
}

function a4Css(): string {
  return `${sharedCss}
@page { size: A4; margin: 16mm; }
body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.5; }
.sheet { max-width: 178mm; margin: 0 auto; }
.store { text-align: left; border-bottom: 2px solid #000; padding-bottom: 10px; }
.store h1 { font-size: 22px; }
.store p { font-size: 11px; color: #333; }
.doc-title { font-size: 14px; margin: 14px 0; }
.meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 24px; margin-bottom: 14px; }
.meta-row { border-bottom: 1px solid #e5e5e5; padding: 4px 0; }
table.lines { margin-bottom: 14px; }
table.lines th { border-bottom: 1px solid #000; padding: 6px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
table.lines td { padding: 7px 4px; border-bottom: 1px solid #eee; vertical-align: top; }
table.lines .idx { width: 28px; color: #666; }
table.lines .note { font-size: 10px; }
.totals { margin-left: auto; width: 62mm; }
.total-row { padding: 4px 0; border-bottom: 1px solid #eee; }
.total-row.grand { font-size: 15px; border-bottom: none; border-top: 2px solid #000; padding-top: 6px; }
.vat-note { font-size: 10px; text-align: right; }
.foot { margin-top: 24px; padding-top: 10px; border-top: 1px solid #ddd; color: #333; font-size: 11px; }
`;
}
