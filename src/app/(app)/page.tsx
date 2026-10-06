"use client";

import Link from "next/link";
import { ArrowRight, AlertTriangle, Sparkles, TrendingUp, TrendingDown } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingState, useApiData } from "@/components/ui/DataState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { LowStockWatchlist } from "@/components/dashboard/LowStockWatchlist";
import { PaymentMixChart } from "@/components/dashboard/PaymentMixChart";
import { SalesMixChart } from "@/components/dashboard/SalesMixChart";
import { StockByCategoryChart } from "@/components/dashboard/StockByCategoryChart";
import { StockHealthChart } from "@/components/dashboard/StockHealthChart";
import { TopProductsChart } from "@/components/dashboard/TopProductsChart";
import { Stat } from "@/components/ui/Stat";
import { formatMoney } from "@/lib/format";
import type { DashboardData } from "@/lib/types";

export default function DashboardPage() {
  const { hasPermission } = useAuth();
  const { data, loading, error, reload } = useApiData<DashboardData>("/api/dashboard");
  if (loading) return <LoadingState label="Loading dashboard…" />;
  if (error || !data) return <ErrorState message={error || "Failed to load dashboard"} onRetry={reload} />;
  const {
    stats,
    salesTrend = [],
    alerts = [],
    recentSales = [],
    moduleRoadmap = [],
    expenseByCategory = [],
    topReceivables = [],
    topPayables = [],
    lowStock = [],
    stockByCategory = [],
    stockHealth = { healthy: 0, low: 0, out: 0 },
    paymentMix = [],
    topProductsToday = [],
  } = data;

  // Widgets are hidden per-role even though the API already omits data the
  // caller isn't permitted to see (src/app/api/dashboard/route.ts) — this is
  // belt-and-suspenders UI, not the enforcement point.
  const canPos = hasPermission("pos:read");
  const canInventory = hasPermission("inventory:read");
  const canReports = hasPermission("reports:read");
  const canExpenses = hasPermission("expenses:read");

  return (
    <div>
      <PageHeader
        eyebrow="U-niche Perfumes"
        title="Operations Dashboard"
        description="Live operating metrics for retail, remix, inventory health, and module readiness."
        actions={
          <>
            {canPos && (
              <Link href="/pos">
                <Button variant="gold">
                  Open POS
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            )}
            <Link href="/playground">
              <Button variant="secondary">Feature Map</Button>
            </Link>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {canPos && (
          <Stat
            label="Today's Sales"
            value={formatMoney(stats.todaySales ?? 0)}
            hint="completed today"
            delay="stagger-1"
          />
        )}
        {canReports && (
          <Stat
            label="Gross Margin"
            value={`${stats.grossMarginPct ?? 0}%`}
            hint="FIFO-based"
            delay="stagger-2"
          />
        )}
        {canPos && (
          <Stat
            label="Remix Sales"
            value={String(stats.remixSales ?? 0)}
            hint="auto BOM deducted"
            delay="stagger-3"
          />
        )}
        {canPos && (
          <Stat
            label="Transactions Today"
            value={String(stats.transactionsToday ?? 0)}
            hint="completed sales"
          />
        )}
        {canPos && (
          <Stat
            label="Avg. Sale Value"
            value={formatMoney(stats.avgSaleValue ?? 0)}
            hint="per transaction today"
          />
        )}
        {canInventory && (
          <Link
            href="/inventory"
            className="block rounded-[var(--radius)] transition hover:ring-2 hover:ring-gold/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            <Stat
              label="Inventory Value"
              value={formatMoney(stats.fifoValue ?? 0)}
              hint="FIFO sellable →"
              delay="stagger-4"
              className="h-full"
            />
          </Link>
        )}
        {canInventory && (
          <Link
            href="/inventory/low-stock"
            className="block rounded-[var(--radius)] transition hover:ring-2 hover:ring-gold/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            <Stat
              label="Low Stock SKUs"
              value={String(stats.lowStockCount ?? 0)}
              trend={(stats.lowStockCount ?? 0) > 0 ? "Action needed" : undefined}
              trendUp={false}
              hint="View all →"
              delay="stagger-5"
              className="h-full"
            />
          </Link>
        )}
        {canExpenses && (
          <Stat
            label="This Month's Expenses"
            value={formatMoney(stats.monthExpenseTotal ?? 0)}
            hint="approved & pending"
          />
        )}
        {canExpenses && (
          <Stat
            label="Net Profit"
            value={formatMoney(stats.netProfit ?? 0)}
            hint="this month, FIFO-based"
          />
        )}
        {canExpenses && (
          <Stat
            label="Accounts Receivable"
            value={formatMoney(stats.accountsReceivable ?? 0)}
            hint="owed by customers"
          />
        )}
        {canExpenses && (
          <Stat
            label="Accounts Payable"
            value={formatMoney(stats.accountsPayable ?? 0)}
            hint="owed to suppliers"
          />
        )}
        {canExpenses && (
          <Stat
            label="Net Cash"
            value={formatMoney(stats.netCash ?? 0)}
            hint="today · cash taken less expenses"
          />
        )}
      </div>

      {(canReports || canExpenses) && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {canReports && (
            <MarginCard
              label="Gross Margin"
              caption="revenue − FIFO cost, this month"
              value={stats.grossMarginPct ?? 0}
              trendPts={stats.grossMarginTrendPts ?? 0}
              tone="gold"
            />
          )}
          {canExpenses && (
            <MarginCard
              label="Net Profit Margin"
              caption="after all expenses, this month"
              value={stats.netProfitMarginPct ?? 0}
              trendPts={stats.netMarginTrendPts ?? 0}
              tone="sage"
            />
          )}
        </div>
      )}

      {canInventory && (
        <div className="mt-6 grid gap-6 xl:grid-cols-3">
          <Panel className="animate-fade-up xl:col-span-2">
            <PanelHeader
              title="Stock Value by Category"
              subtitle="FIFO cost × sellable quantity"
            />
            <StockByCategoryChart data={stockByCategory} />
          </Panel>
          <Panel className="animate-fade-up">
            <PanelHeader title="Stock Health" subtitle="Sellable stock vs. reorder threshold" />
            <StockHealthChart data={stockHealth} />
          </Panel>
        </div>
      )}

      <div className={`mt-6 grid gap-6 ${canPos || canInventory ? "xl:grid-cols-3" : ""}`}>
        {canPos && (
          <Panel className="animate-fade-up flex flex-col xl:col-span-2">
            <PanelHeader
              title="Weekly Sales Mix"
              subtitle="Retail · Wholesale · Remix"
              action={<Badge tone="info">Live</Badge>}
            />
            <div className="flex flex-1 flex-col justify-center">
              <SalesMixChart data={salesTrend} />
            </div>
          </Panel>
        )}

        {!canPos && canInventory && (
          <Panel className="animate-fade-up self-start xl:col-span-2">
            <PanelHeader
              title="Low Stock Watchlist"
              subtitle="Most urgent reorders first"
              action={
                <Link href="/inventory/low-stock" className="text-xs font-medium text-gold-deep hover:underline">
                  View all →
                </Link>
              }
            />
            <LowStockWatchlist items={lowStock} />
          </Panel>
        )}

        <Panel className="animate-fade-up">
          <PanelHeader
            title="Alerts"
            subtitle="Stock & reports"
            action={
              <div className="flex items-center gap-2">
                {canInventory && (
                  <Link
                    href="/inventory/low-stock"
                    className="text-xs font-medium text-gold-deep hover:underline"
                  >
                    Low stock →
                  </Link>
                )}
                <Badge tone="danger">
                  <AlertTriangle className="h-3 w-3" />
                  {alerts.length}
                </Badge>
              </div>
            }
          />
          <ul className="max-h-[280px] space-y-3 overflow-y-auto pr-1 scrollbar-thin">
            {alerts.length === 0 && (
              <li className="rounded-2xl border border-line/70 bg-mist/60 px-3 py-4 text-center text-sm text-ink-muted">
                No alerts right now — all clear.
              </li>
            )}
            {alerts.map((alert) => (
              <li
                key={alert.id}
                className="rounded-2xl border border-line/70 bg-mist/80 px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-ink">{alert.title}</p>
                  <Badge
                    tone={
                      alert.severity === "critical"
                        ? "danger"
                        : alert.severity === "warning"
                          ? "warning"
                          : "info"
                    }
                  >
                    {alert.severity}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-ink-muted">{alert.detail}</p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {canPos && (
        <div className="mt-6 grid gap-6 xl:grid-cols-3">
          <Panel className="animate-fade-up xl:col-span-2">
            <PanelHeader title="Top Sellers Today" subtitle="By revenue, this branch" />
            <TopProductsChart data={topProductsToday} />
          </Panel>
          <Panel className="animate-fade-up">
            <PanelHeader title="Payment Mix" subtitle="How today was paid" />
            <PaymentMixChart data={paymentMix} />
          </Panel>
        </div>
      )}

      {canExpenses && (
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <Panel className="animate-fade-up">
            <PanelHeader title="Expense Breakdown" subtitle="This month by category" />
            <ul className="space-y-2">
              {expenseByCategory.length === 0 && (
                <li className="text-sm text-ink-muted">No expenses recorded this month.</li>
              )}
              {expenseByCategory.map((row) => (
                <li
                  key={row.category}
                  className="flex items-center justify-between rounded-2xl border border-line/60 bg-mist/80 px-3 py-2"
                >
                  <span className="text-sm font-medium">{row.category}</span>
                  <span className="text-sm text-ink-muted">{formatMoney(row.amount)}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel className="animate-fade-up" padding={false}>
            <div className="border-b border-line/70 px-5 py-4">
              <PanelHeader title="Top Receivables" subtitle="Customers owing the most" />
            </div>
            <table className="w-full text-left text-sm">
              <thead className="bg-mist/60 text-[11px] uppercase tracking-wider text-ink-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Customer</th>
                  <th className="px-5 py-2.5 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {topReceivables.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-5 py-3 text-ink-muted">
                      No outstanding customer balances.
                    </td>
                  </tr>
                )}
                {topReceivables.map((row) => (
                  <tr key={row.id} className="border-t border-line/60">
                    <td className="px-5 py-3 font-medium">{row.name}</td>
                    <td className="px-5 py-3 text-right font-medium">{formatMoney(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel className="animate-fade-up" padding={false}>
            <div className="border-b border-line/70 px-5 py-4">
              <PanelHeader title="Top Payables" subtitle="Suppliers owed the most" />
            </div>
            <table className="w-full text-left text-sm">
              <thead className="bg-mist/60 text-[11px] uppercase tracking-wider text-ink-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Supplier</th>
                  <th className="px-5 py-2.5 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {topPayables.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-5 py-3 text-ink-muted">
                      No outstanding supplier balances.
                    </td>
                  </tr>
                )}
                {topPayables.map((row) => (
                  <tr key={row.id} className="border-t border-line/60">
                    <td className="px-5 py-3 font-medium">{row.name}</td>
                    <td className="px-5 py-3 text-right font-medium">{formatMoney(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      )}

      {canExpenses && (
        <Panel className="mt-6 animate-fade-up">
          <PanelHeader title="Quick Actions" subtitle="Common accounting tasks" />
          <div className="grid gap-3 sm:grid-cols-3">
            <Link href="/expenses">
              <Button variant="secondary" className="w-full">
                Log Expense
              </Button>
            </Link>
            <Link href="/purchases">
              <Button variant="secondary" className="w-full">
                View Bills
              </Button>
            </Link>
            <Link href="/reports">
              <Button variant="secondary" className="w-full">
                View Reports
              </Button>
            </Link>
          </div>
        </Panel>
      )}

      <div className={`mt-6 grid gap-6 ${canPos ? "lg:grid-cols-2" : ""}`}>
        {canPos && (
          <Panel className="animate-fade-up" padding={false}>
            <div className="border-b border-line/70 px-5 py-4">
              <PanelHeader
                title="Recent Sales"
                subtitle="Today at Main Store"
                action={
                  <Link href="/pos">
                    <Button size="sm" variant="ghost">
                      POS
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </Link>
                }
              />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-mist/60 text-[11px] uppercase tracking-wider text-ink-muted">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">Time</th>
                    <th className="px-3 py-2.5 font-medium">Customer</th>
                    <th className="px-3 py-2.5 font-medium">Type</th>
                    <th className="px-3 py-2.5 font-medium">Pay</th>
                    <th className="px-5 py-2.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
              {recentSales.map((sale) => (
                    <tr key={sale.id} className="border-t border-line/60">
                      <td className="px-5 py-3 text-ink-muted">{sale.time}</td>
                      <td className="px-3 py-3 font-medium">{sale.customer}</td>
                      <td className="px-3 py-3">
                        <Badge tone="neutral">{sale.type}</Badge>
                      </td>
                      <td className="px-3 py-3 text-ink-muted">{sale.payment}</td>
                      <td className="px-5 py-3 text-right font-medium">
                        {formatMoney(sale.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        <Panel className="animate-fade-up">
          <PanelHeader
            title="Phase 1 Roadmap"
            subtitle="Build order for the prototype"
            action={
              <Badge tone="gold">
                <Sparkles className="h-3 w-3" />
                Playground
              </Badge>
            }
          />
          <ul className="space-y-2">
            {moduleRoadmap.map((mod) => (
              <li
                key={mod.name}
                className="flex items-center justify-between rounded-2xl border border-line/60 bg-mist/80 px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-canvas">
                    {mod.priority}
                  </span>
                  <span className="text-sm font-medium">{mod.name}</span>
                </div>
                <Badge
                  tone={
                    mod.status === "prototype"
                      ? "success"
                      : mod.status === "shell"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {mod.status}
                </Badge>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

    </div>
  );
}

function MarginCard({
  label,
  caption,
  value,
  trendPts,
  tone,
}: {
  label: string;
  caption: string;
  value: number;
  trendPts: number;
  tone: "gold" | "sage";
}) {
  const trendTone = trendPts > 0 ? "success" : trendPts < 0 ? "danger" : "neutral";
  return (
    <Panel className="animate-fade-up bg-gradient-to-b from-paper to-mist/60">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-ink-muted">{label}</p>
        {trendPts !== 0 && (
          <Badge tone={trendTone}>
            {trendPts > 0 ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {trendPts > 0 ? "+" : ""}
            {trendPts.toFixed(1)} pts
          </Badge>
        )}
      </div>
      <div className="mt-4 flex justify-center">
        <ProgressRing value={value} tone={tone} />
      </div>
      <p className="mt-4 text-center text-xs text-ink-muted">{caption}</p>
    </Panel>
  );
}
