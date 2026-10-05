import * as XLSX from "xlsx";
import {
  EXCEL_HEADERS,
  type ExcelProductRow,
} from "@/lib/excel/columns";

function cellStr(value: unknown): string {
  if (value == null || value === "") return "";
  return String(value).trim();
}

function cellNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

const HEADER_ALIASES: Record<string, (typeof EXCEL_HEADERS)[number]> = {};
for (const h of EXCEL_HEADERS) {
  HEADER_ALIASES[normalizeHeader(h)] = h;
}

export function parseProductSheet(buffer: ArrayBuffer | Buffer): ExcelProductRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName =
    workbook.SheetNames.find((n) => n.toLowerCase() === "products") ||
    workbook.SheetNames[0];
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: true,
  });

  return raw
    .map((row, idx) => {
      const mapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        const canon = HEADER_ALIASES[normalizeHeader(key)];
        if (canon) mapped[canon] = value;
      }

      const isEmpty = EXCEL_HEADERS.every((h) => {
        const v = mapped[h];
        return v == null || String(v).trim() === "";
      });
      if (isEmpty) return null;

      return {
        // SheetJS skips blank rows, so use its 0-based sheet position, not the array index.
        rowNumber: ((row as { __rowNum__?: number }).__rowNum__ ?? idx + 1) + 1,
        internalCode: cellStr(mapped["Internal Code"]),
        name: cellStr(mapped["Product Name"]),
        category: cellStr(mapped["Category"]),
        brand: cellStr(mapped["Brand"]),
        concentration: cellStr(mapped["Concentration"]),
        unit: cellStr(mapped["Unit"]).toLowerCase(),
        costPrice: cellNum(mapped["Cost Price"]),
        retailPrice: cellNum(mapped["Retail Price"]),
        wholesalePrice: cellNum(mapped["Wholesale Price"]),
        gender: cellStr(mapped["Gender"]),
        size: cellStr(mapped["Size"]),
        collection: cellStr(mapped["Collection"]),
        notes: cellStr(mapped["Notes"]),
        itemType: cellStr(mapped["Item Type"]),
      } satisfies ExcelProductRow;
    })
    .filter((r): r is ExcelProductRow => r != null);
}
