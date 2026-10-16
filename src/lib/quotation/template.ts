import { money } from "@/lib/receipt/document";
import type { QuotationDoc, QuotationDocLine } from "./document";

export function renderQuotationHtml(doc: QuotationDoc): string {
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<title>${esc(doc.number)}</title>
<style>${css()}</style>
</head>
<body>
<main class="sheet">
  ${storeHeader(doc)}
  <div class="doc-title">QUOTATION${doc.version > 1 ? ` · REV ${doc.version}` : ""}</div>
  ${metaBlock(doc)}
  ${linesTable(doc)}
  ${totalsBlock(doc)}
  ${termsBlock(doc)}
  ${signatureBlock(doc)}
  ${footerBlock(doc)}
</main>
<script>window.__quotationReady = true;</script>
</body>
</html>`;
}

function storeHeader(doc: QuotationDoc): string {
  const { store } = doc;
  return `<header class="store">
    ${store.logoUrl ? `<img class="logo" src="${esc(store.logoUrl)}" alt="" />` : ""}
    <h1>${esc(store.name)}</h1>
    ${store.legalName ? `<p>${esc(store.legalName)}</p>` : ""}
    ${store.address ? `<p>${esc(store.address)}</p>` : ""}
    ${store.phone ? `<p>Tel: ${esc(store.phone)}</p>` : ""}
    ${store.taxNumber ? `<p>TRN: ${esc(store.taxNumber)}</p>` : ""}
  </header>`;
}

function metaBlock(doc: QuotationDoc): string {
  const rows: [string, string][] = [
    ["Quotation No.", doc.number],
    ["Status", titleCase(doc.status)],
    ["Date", formatStamp(new Date(doc.date))],
    ["Valid Until", formatStamp(new Date(doc.expiry))],
    ["Customer", doc.customer.name],
  ];
  if (doc.customer.phone) rows.push(["Phone", doc.customer.phone]);
  if (doc.customer.email) rows.push(["Email", doc.customer.email]);
  if (doc.customer.trn) rows.push(["Customer TRN", doc.customer.trn]);
  if (doc.customer.address) rows.push(["Address", doc.customer.address]);
  if (doc.customerPoNumber) rows.push(["Customer PO/LPO No.", doc.customerPoNumber]);

  return `<section class="meta">${rows
    .map(
      ([key, value]) =>
        `<div class="meta-row"><span>${esc(key)}</span><span>${esc(value)}</span></div>`,
    )
    .join("")}</section>`;
}

function lineDesc(line: QuotationDocLine): string {
  // Line names are user input (quotation editor, public customer link) — escape like everything else.
  return line.note ? `${esc(line.name)}<span class="note">${esc(line.note)}</span>` : esc(line.name);
}

function linesTable(doc: QuotationDoc): string {
  const currency = doc.store.currency;
  const head = `<thead><tr>
    <th class="idx">#</th>
    <th>Item</th>
    <th class="num">Qty</th>
    <th class="num">Unit Price</th>
    <th class="num">Charges</th>
    <th class="num">Amount</th>
  </tr></thead>`;

  const body = doc.lines
    .map((line, index) => {
      const amount = line.qty * line.unitPrice + (line.charges || 0);
      return `<tr>
        <td class="idx">${index + 1}</td>
        <td>${lineDesc(line)}</td>
        <td class="num">${esc(trimNum(line.qty))} ${esc(line.unitLabel)}</td>
        <td class="num">${esc(money(line.unitPrice, currency))}</td>
        <td class="num">${line.charges ? esc(money(line.charges, currency)) : "—"}</td>
        <td class="num">${esc(money(amount, currency))}</td>
      </tr>`;
    })
    .join("");

  const empty = `<tr><td colspan="6" class="empty">No items</td></tr>`;

  return `<table class="lines">${head}<tbody>${body || empty}</tbody></table>`;
}

function totalsBlock(doc: QuotationDoc): string {
  const currency = doc.store.currency;
  const rows: [string, string, boolean][] = [
    ["Subtotal", money(doc.subtotal, currency), false],
  ];
  if (doc.vatPercent > 0) {
    rows.push([`VAT (${trimNum(doc.vatPercent)}%)`, money(doc.vatAmount, currency), false]);
  }
  rows.push(["Total", money(doc.total, currency), true]);

  return `<section class="totals">${rows
    .map(
      ([key, value, strong]) =>
        `<div class="total-row${strong ? " grand" : ""}"><span>${esc(key)}</span><span>${esc(value)}</span></div>`,
    )
    .join("")}</section>`;
}

function termsBlock(doc: QuotationDoc): string {
  const rows: [string, string][] = [];
  if (doc.paymentTerms) rows.push(["Payment Terms", doc.paymentTerms]);
  if (doc.deliveryTerms) rows.push(["Delivery Terms", doc.deliveryTerms]);
  rows.push(["Validity", `${doc.validityDays} day(s) from quotation date`]);

  const meta = rows
    .map(([key, value]) => `<p><strong>${esc(key)}:</strong> ${esc(value)}</p>`)
    .join("");
  const terms = doc.termsText
    ? `<div class="terms-text"><strong>Terms &amp; Conditions</strong><p>${esc(doc.termsText)}</p></div>`
    : "";
  const notes = doc.notes ? `<div class="terms-text"><strong>Notes</strong><p>${esc(doc.notes)}</p></div>` : "";

  return `<section class="terms">${meta}${terms}${notes}</section>`;
}

function signatureBlock(doc: QuotationDoc): string {
  if (!doc.signatureDataUrl) return "";
  return `<section class="signature">
    <img src="${esc(doc.signatureDataUrl)}" alt="Customer signature" />
    <p>${esc(doc.signedByName || "Customer")}${doc.signedAt ? ` · ${formatStamp(new Date(doc.signedAt))}` : ""}</p>
  </section>`;
}

function footerBlock(doc: QuotationDoc): string {
  return `<footer class="foot">
    <p>${esc(doc.store.footer)}</p>
    <p class="ref">${esc(doc.number)}</p>
  </footer>`;
}

function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
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

function css(): string {
  return `
* { box-sizing: border-box; }
body { margin: 0; color: #000; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.5; }
@page { size: A4; margin: 16mm; }
.sheet { max-width: 178mm; margin: 0 auto; }
.store { text-align: left; border-bottom: 2px solid #000; padding-bottom: 10px; }
.store .logo { max-height: 56px; max-width: 60%; object-fit: contain; margin-bottom: 6px; }
.store h1 { margin: 0 0 2px; font-size: 22px; letter-spacing: 0.06em; text-transform: uppercase; }
.store p { margin: 1px 0; font-size: 11px; color: #333; }
.doc-title { text-align: center; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; font-size: 14px; margin: 14px 0; }
.meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 24px; margin-bottom: 14px; }
.meta-row { display: flex; justify-content: space-between; gap: 10px; border-bottom: 1px solid #e5e5e5; padding: 4px 0; }
.meta-row span:first-child { color: #333; }
table.lines { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
table.lines th { text-align: left; font-weight: 700; border-bottom: 1px solid #000; padding: 6px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
table.lines td { padding: 7px 4px; border-bottom: 1px solid #eee; vertical-align: top; }
table.lines .idx { width: 28px; color: #666; }
table.lines .num { text-align: right; white-space: nowrap; }
table.lines .note { display: block; color: #444; font-size: 10px; }
table.lines .empty { text-align: center; color: #555; padding: 10px 0; }
.totals { margin-left: auto; width: 72mm; }
.total-row { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; border-bottom: 1px solid #eee; }
.total-row.grand { font-size: 15px; font-weight: 700; border-bottom: none; border-top: 2px solid #000; padding-top: 6px; }
.terms { margin-top: 18px; font-size: 11px; color: #222; }
.terms p { margin: 2px 0 8px; }
.terms-text { margin-top: 6px; }
.terms-text p { white-space: pre-wrap; color: #333; }
.signature { margin-top: 20px; }
.signature img { max-height: 70px; border-bottom: 1px solid #000; }
.signature p { margin: 2px 0 0; font-size: 10px; color: #333; }
.foot { margin-top: 24px; padding-top: 10px; border-top: 1px solid #ddd; color: #333; font-size: 11px; text-align: center; }
.foot .ref { letter-spacing: 0.1em; }
@media print { .sheet { page-break-inside: avoid; } }
`;
}
