/**
 * One CSV cell, shared by every CSV export. Client-safe (no imports).
 *
 * CSV/formula injection (OWASP): Excel/Sheets run a cell whose first
 * meaningful character is = + - @, and leading whitespace or control
 * characters (tab, CR, LF…) do not stop that. Such text cells get a leading
 * apostrophe so they display as text. Numbers and plain signed decimals
 * ("-12.500") are data, not formulas, and are never touched.
 */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@]/;
const CONTROL_START = /^[\t\r]/;

function neutraliseFormula(s: string): string {
  if (PLAIN_NUMBER.test(s)) return s;
  return FORMULA_START.test(s) || CONTROL_START.test(s) ? `'${s}` : s;
}

export function csvCell(value: string | number | null | undefined): string {
  const s =
    value == null ? "" : typeof value === "number" ? String(value) : neutraliseFormula(String(value));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
