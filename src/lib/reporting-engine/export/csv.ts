import { csvCell } from "@/lib/csvCell";
import type { ReportResult } from "../types";

export function reportToCsv(result: ReportResult): string {
  const header = result.columns.map((c) => csvCell(c.label)).join(",");
  const lines = result.rows.map((row) =>
    result.columns.map((c) => csvCell(row[c.key] ?? "")).join(","),
  );
  return [header, ...lines].join("\r\n");
}
