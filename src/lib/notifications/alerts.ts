import { moneyText } from "@/lib/money";
import { connectDB } from "@/lib/db";
import { Customer, Product, Sale, Supplier } from "@/lib/models";
import { hasPermission } from "@/lib/auth/roles";
import { ownBranchMatch } from "@/lib/auth/guards";
import type { AppSession } from "@/lib/auth/session";

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertType = "low_stock" | "dead_stock" | "report" | "receivables" | "payables";

export interface AlertItem {
  /** Stable per condition (e.g. `low-<productId>`) — doubles as the Notification's dedupeKey. */
  id: string;
  type: AlertType;
  title: string;
  detail: string;
  severity: AlertSeverity;
}

/**
 * Same alert conditions the dashboard's "Alerts" feed computes
 * (src/app/api/dashboard/route.ts) — kept as one definition so the header
 * notification bell surfaces the same real business signals rather than a
 * second, drifting definition of "what's worth notifying about."
 */
export async function buildAlerts(session: AppSession): Promise<AlertItem[]> {
  const canInventory = hasPermission(session.role, "inventory:read");
  const canReports = hasPermission(session.role, "reports:read");
  const canExpenses = hasPermission(session.role, "expenses:read");

  await connectDB();

  const branchFilter = ownBranchMatch(session);

  const alerts: AlertItem[] = [];

  if (canInventory) {
    // Lean + only the fields the alerts read: this runs on every bell poll
    // for every inventory user, over the whole catalogue.
    const products = await Product.find()
      .select("name unit stockSellable lowStockAt lastSoldAt")
      .lean<{ _id: unknown; name: string; unit: string; stockSellable: number; lowStockAt: number; lastSoldAt?: Date }[]>();
    const lowStock = products.filter(
      (p) => p.lowStockAt > 0 && p.stockSellable <= p.lowStockAt,
    );
    for (const p of lowStock) {
      alerts.push({
        id: `low-${p._id}`,
        type: "low_stock",
        title: `${p.name} below threshold`,
        detail: `${p.stockSellable} ${p.unit} remaining — threshold ${p.lowStockAt} ${p.unit}`,
        severity:
          p.stockSellable === 0 || p.stockSellable <= p.lowStockAt * 0.5
            ? "critical"
            : "warning",
      });
    }

    const deadStock = products
      .filter((p) => {
        if (!p.lastSoldAt) return false;
        const days =
          (Date.now() - new Date(p.lastSoldAt).getTime()) / (1000 * 60 * 60 * 24);
        return days > 30 && p.stockSellable > 0;
      })
      .slice(0, 3);
    for (const p of deadStock) {
      alerts.push({
        id: `dead-${p._id}`,
        type: "dead_stock",
        title: `${p.name} slow movement`,
        detail: "No sale in 30+ days — review pricing",
        severity: "info",
      });
    }
  }

  if (canReports) {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 6);
    weekAgo.setHours(0, 0, 0, 0);
    const weekSales = await Sale.find({
      status: "completed",
      createdAt: { $gte: weekAgo },
      ...branchFilter,
    }).select("total").lean<{ total: number }[]>();
    const weekTotal = weekSales.reduce((s, x) => s + x.total, 0);
    alerts.push({
      id: "weekly-report",
      type: "report",
      title: "Weekly sales report ready",
      detail: `Last 7 days · ${moneyText(weekTotal)} total`,
      severity: "info",
    });
  }

  if (canExpenses) {
    const receivableCustomers = await Customer.find({ creditBalance: { $gt: 0 } })
      .select("creditBalance")
      .lean<{ creditBalance?: number }[]>();
    const accountsReceivable =
      Math.round(
        receivableCustomers.reduce((s, c) => s + (c.creditBalance || 0), 0) * 100,
      ) / 100;
    if (accountsReceivable > 0) {
      alerts.push({
        id: "receivables-summary",
        type: "receivables",
        title: `${receivableCustomers.length} customer${receivableCustomers.length === 1 ? "" : "s"} with outstanding balance`,
        detail: `${moneyText(accountsReceivable)} total receivable`,
        severity: "warning",
      });
    }

    const payableSuppliers = await Supplier.find({ outstanding: { $gt: 0 } })
      .select("outstanding")
      .lean<{ outstanding?: number }[]>();
    const accountsPayable =
      Math.round(
        payableSuppliers.reduce((s, sup) => s + (sup.outstanding || 0), 0) * 100,
      ) / 100;
    if (accountsPayable > 0) {
      alerts.push({
        id: "payables-summary",
        type: "payables",
        title: `${payableSuppliers.length} supplier${payableSuppliers.length === 1 ? "" : "s"} with outstanding balance`,
        detail: `${moneyText(accountsPayable)} total payable`,
        severity: "warning",
      });
    }
  }

  return alerts;
}
