"use client";

import { Suspense, useMemo, useState } from "react";
import { Download, FileText, PauseCircle, Printer } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingState, useApiData } from "@/components/ui/DataState";
import { EmptyState, PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Stat } from "@/components/ui/Stat";
import { hasPermission } from "@/lib/auth/roles";
import { formatDate, formatMoney } from "@/lib/format";
import { printSaleReceipt } from "@/lib/receipt/print";
import type { AppSettings } from "@/lib/types";
import {
  REPORT_PERIODS,
  toDateInputValue,
  type ReportPeriod,
} from "@/lib/reports/period";
import type { SaleReportResult, SaleReportStatus } from "@/lib/reports/salesReport";
import { ReportCenter } from "./ReportCenter";

const selectClass =
  "h-10 rounded-full border border-line bg-mist px-3 text-sm outline-none focus:border-gold focus:ring-2 focus:ring-gold/20";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const [completedPeriod, setCompletedPeriod] = useState<ReportPeriod>("daily");
  const [heldPeriod, setHeldPeriod] = useState<ReportPeriod>("daily");
  const [completedDate, setCompletedDate] = useState(() => toDateInputValue(new Date()));
  const [heldDate, setHeldDate] = useState(() => toDateInputValue(new Date()));
  const [exporting, setExporting] = useState<SaleReportStatus | null>(null);

  const completedUrl = useMemo(
    () =>
      `/api/reports/sales?status=completed&period=${completedPeriod}&date=${completedDate}`,
    [completedPeriod, completedDate],
  );
  const heldUrl = useMemo(
    () => `/api/reports/sales?status=held&period=${heldPeriod}&date=${heldDate}`,
    [heldPeriod, heldDate],
  );

  const completed = useApiData<SaleReportResult>(completedUrl);
  // POS-119: reprint any completed sale from history — rendered by the server
  // from the stored sale (receipt route needs POS access).
  const { user } = useAuth();
  const canReprint = Boolean(user && hasPermission(user.role, "pos:read"));
  const receiptSettings = useApiData<AppSettings>(canReprint ? "/api/settings" : null);
  const [reprintingId, setReprintingId] = useState<string | null>(null);
  const [reprintError, setReprintError] = useState<string | null>(null);
  async function reprint(saleId: string) {
    setReprintingId(saleId);
    setReprintError(null);
    try {
      const format = receiptSettings.data?.receiptFormat === "a4" ? "a4" : "thermal";
      await printSaleReceipt(saleId, format, { reprint: true });
      void fetch("/api/notifications/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ channel: "print", kind: "receipt", status: "printed", saleId, format }),
      }).catch(() => undefined);
    } catch (err) {
      setReprintError(err instanceof Error ? err.message : "Could not reprint receipt");
    } finally {
      setReprintingId(null);
    }
  }
  const held = useApiData<SaleReportResult>(heldUrl);

  async function exportReport(
    status: SaleReportStatus,
    period: ReportPeriod,
    date: string,
  ) {
    setExporting(status);
    try {
      const res = await fetch(
        `/api/reports/sales/export?status=${status}&period=${period}&date=${date}`,
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error || "Export failed");
      }
      const blob = await res.blob();
      downloadBlob(blob, `${status}-${period}-${date}.xlsx`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(null);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Insights"
        title="Reports & Dashboards"
        description="Completed sales and held bills in separate sections — pick Daily, Weekly, Monthly, or Yearly and download Excel."
      />

      <div className="space-y-6">
        <SaleReportSection
          title="Completed Sales"
          subtitle="Checked-out bills only"
          tone="success"
          icon={<FileText className="h-4 w-4" />}
          period={completedPeriod}
          date={completedDate}
          onPeriodChange={setCompletedPeriod}
          onDateChange={setCompletedDate}
          report={completed.data}
          loading={completed.loading}
          error={completed.error ?? reprintError}
          onRetry={() => void completed.reload()}
          onReprint={canReprint ? (id) => void reprint(id) : undefined}
          reprintingId={reprintingId}
          exporting={exporting === "completed"}
          onExport={() =>
            void exportReport("completed", completedPeriod, completedDate)
          }
        />

        <SaleReportSection
          title="Held Bills"
          subtitle="Parked carts waiting to complete"
          tone="warning"
          icon={<PauseCircle className="h-4 w-4" />}
          period={heldPeriod}
          date={heldDate}
          onPeriodChange={setHeldPeriod}
          onDateChange={setHeldDate}
          report={held.data}
          loading={held.loading}
          error={held.error}
          onRetry={() => void held.reload()}
          exporting={exporting === "held"}
          onExport={() => void exportReport("held", heldPeriod, heldDate)}
        />

        <Suspense fallback={null}>
          <ReportCenter />
        </Suspense>
      </div>
    </div>
  );
}

function SaleReportSection({
  title,
  subtitle,
  tone,
  icon,
  period,
  date,
  onPeriodChange,
  onDateChange,
  report,
  loading,
  error,
  onRetry,
  exporting,
  onExport,
  onReprint,
  reprintingId,
}: {
  title: string;
  subtitle: string;
  tone: "success" | "warning";
  icon: React.ReactNode;
  period: ReportPeriod;
  date: string;
  onPeriodChange: (p: ReportPeriod) => void;
  onDateChange: (d: string) => void;
  report: SaleReportResult | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  exporting: boolean;
  onExport: () => void;
  onReprint?: (saleId: string) => void;
  reprintingId?: string | null;
}) {
  const summary = report?.summary;
  const paymentMix = summary
    ? Object.entries(summary.byPayment)
        .map(([k, v]) => `${k} ${v.count}`)
        .join(" · ")
    : "";

  return (
    <Panel padding={false} className="overflow-hidden">
      <div className="border-b border-line/70 bg-gradient-to-r from-mist/80 to-transparent px-5 py-4">
        <PanelHeader
          title={
            <span className="inline-flex items-center gap-2">
              <span
                className={
                  tone === "success"
                    ? "text-sage"
                    : "text-amber"
                }
              >
                {icon}
              </span>
              {title}
            </span>
          }
          subtitle={
            report
              ? `${subtitle} · ${report.label}`
              : subtitle
          }
          action={
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={`${title}-period`}>
                Period
              </label>
              <select
                id={`${title}-period`}
                value={period}
                onChange={(e) => onPeriodChange(e.target.value as ReportPeriod)}
                className={selectClass}
              >
                {REPORT_PERIODS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={date}
                onChange={(e) => onDateChange(e.target.value)}
                className={selectClass}
                aria-label={`${title} date`}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={exporting || loading || !report?.sales.length}
                onClick={onExport}
              >
                <Download className="h-3.5 w-3.5" />
                {exporting ? "Exporting…" : "Excel"}
              </Button>
            </div>
          }
        />
      </div>

      <div className="px-5 py-4">
        {loading && !report ? (
          <LoadingState label={`Loading ${title.toLowerCase()}…`} />
        ) : error && !report ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat
                label="Bills"
                value={String(summary?.count ?? 0)}
                hint={report?.label}
                className="!shadow-none"
              />
              <Stat
                label="Total"
                value={formatMoney(summary?.total ?? 0)}
                className="!shadow-none"
              />
              <Stat
                label="Avg ticket"
                value={formatMoney(summary?.avgTicket ?? 0)}
                className="!shadow-none"
              />
              <Stat
                label="Payment mix"
                value={
                  paymentMix
                    ? Object.keys(summary?.byPayment ?? {}).length > 1
                      ? `${Object.keys(summary!.byPayment).length} methods`
                      : Object.keys(summary?.byPayment ?? {})[0] || "—"
                    : "—"
                }
                hint={paymentMix || undefined}
                className="!shadow-none"
              />
            </div>

            {report && report.sales.length === 0 ? (
              <EmptyState
                className="mt-4"
                title={`No ${title.toLowerCase()}`}
                detail={`Nothing found for ${report.label}. Try another period or date.`}
              />
            ) : (
              <div className="mt-4 overflow-x-auto rounded-[var(--radius)] border border-line/60">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-mist/70 text-[11px] uppercase tracking-wider text-ink-muted">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Date</th>
                      <th className="px-3 py-2.5 font-medium">Customer</th>
                      <th className="px-3 py-2.5 font-medium">Salesperson</th>
                      <th className="px-3 py-2.5 font-medium">Type</th>
                      <th className="px-3 py-2.5 font-medium">Payment</th>
                      <th className="px-4 py-2.5 text-right font-medium">Total</th>
                      {onReprint ? <th className="px-3 py-2.5" aria-label="Receipt" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {(report?.sales ?? []).map((sale) => (
                      <tr key={sale.id} className="border-t border-line/60">
                        <td className="px-4 py-3 text-ink-muted">
                          <p>{formatDate(sale.createdAt)}</p>
                          <p className="text-[11px]">{sale.time}</p>
                        </td>
                        <td className="px-3 py-3">
                          <p className="font-medium text-ink">{sale.customer}</p>
                          <p className="text-[11px] text-ink-muted">
                            {sale.customerPhone}
                          </p>
                        </td>
                        <td className="px-3 py-3 text-ink-muted">
                          {sale.salesperson || "—"}
                        </td>
                        <td className="px-3 py-3">
                          <Badge tone="info">{sale.type}</Badge>
                        </td>
                        <td className="px-3 py-3">
                          <Badge tone={tone === "success" ? "success" : "warning"}>
                            {sale.payment}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          {formatMoney(sale.total)}
                        </td>
                        {onReprint ? (
                          <td className="px-3 py-3 text-right">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={reprintingId === sale.id}
                              onClick={() => onReprint(sale.id)}
                              title="Reprint receipt"
                            >
                              <Printer className="h-3.5 w-3.5" />
                              {reprintingId === sale.id ? "Printing…" : "Reprint"}
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {loading ? (
              <p className="mt-3 text-xs text-ink-muted">Refreshing…</p>
            ) : null}
            {error ? (
              <p className="mt-3 text-xs text-coral">
                {error}{" "}
                <button type="button" className="underline" onClick={onRetry}>
                  Retry
                </button>
              </p>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}
