"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { roundMoney } from "@/lib/money";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingState, useApiData } from "@/components/ui/DataState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Stat } from "@/components/ui/Stat";
import { useAuth } from "@/components/auth/AuthProvider";
import { PurchaseSpendTrendChart } from "@/components/purchases/PurchaseSpendTrendChart";
import { SupplierSpendChart } from "@/components/purchases/SupplierSpendChart";
import { api } from "@/lib/api";
import { formatMoney, formatDate } from "@/lib/format";
import type { Product, PurchaseOrder, Supplier } from "@/lib/types";

const statusTone = {
  draft: "neutral",
  ordered: "info",
  received: "success",
  partial: "warning",
} as const;

type DraftLine = {
  productId: string;
  productName: string;
  sku: string;
  qtyOrdered: string;
  unitCost: string;
};

export default function PurchasesPage() {
  const { hasPermission } = useAuth();
  /** PUR-04: purchases/suppliers are owner/admin only — Inventory gets read-only view. */
  const canWrite = hasPermission("purchases:write");
  const { data: purchases, loading, error, reload } = useApiData<PurchaseOrder[]>("/api/purchases");
  const { data: suppliers, loading: suppliersLoading, error: suppliersError, reload: reloadSuppliers } =
    useApiData<Supplier[]>("/api/suppliers");
  const { data: products } = useApiData<Product[]>("/api/products");
  const [purchaseDraft, setPurchaseDraft] = useState<{
    supplierId: string;
    currency: string;
    status: string;
    vatPercent: string;
    lines: DraftLine[];
  } | null>(null);
  const [supplierDraft, setSupplierDraft] = useState<Record<string, string> | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const purchaseFormRef = useRef<HTMLDivElement>(null);
  const supplierFormRef = useRef<HTMLDivElement>(null);
  const purchaseOpen = purchaseDraft !== null;
  const supplierOpen = supplierDraft !== null;

  useEffect(() => {
    if (!purchaseOpen) return;
    const id = requestAnimationFrame(() => {
      purchaseFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(id);
  }, [purchaseOpen]);

  useEffect(() => {
    if (!supplierOpen) return;
    const id = requestAnimationFrame(() => {
      supplierFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(id);
  }, [supplierOpen]);

  const purchaseList = purchases ?? [];
  const supplierList = suppliers ?? [];
  const productList = products ?? [];
  const outstanding = supplierList.reduce((s, x) => s + x.outstanding, 0);

  const supplierSpend = useMemo(() => {
    const totals = new Map<string, { name: string; value: number }>();
    for (const po of purchaseList) {
      const bucket = totals.get(po.supplierId) || { name: po.supplierName, value: 0 };
      bucket.value += po.total;
      totals.set(po.supplierId, bucket);
    }
    return Array.from(totals.entries())
      .map(([id, b]) => ({ id, name: b.name, value: roundMoney(b.value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [purchaseList]);

  const draftSubtotal = useMemo(() => {
    if (!purchaseDraft) return 0;
    return purchaseDraft.lines.reduce(
      (s, l) => s + Number(l.qtyOrdered || 0) * Number(l.unitCost || 0),
      0,
    );
  }, [purchaseDraft]);
  const draftVatAmount = useMemo(() => {
    if (!purchaseDraft) return 0;
    return roundMoney(draftSubtotal * (Number(purchaseDraft.vatPercent || 0) / 100));
  }, [draftSubtotal, purchaseDraft]);
  const draftTotal = draftSubtotal + draftVatAmount;

  async function savePurchase() {
    if (!purchaseDraft?.supplierId) return;
    const supplier = supplierList.find((s) => s.id === purchaseDraft.supplierId);
    if (!supplier) return;
    const lines = purchaseDraft.lines
      .filter((l) => l.productId && Number(l.qtyOrdered) > 0)
      .map((l) => ({
        productId: l.productId,
        productName: l.productName,
        sku: l.sku,
        qtyOrdered: Number(l.qtyOrdered),
        unitCost: Number(l.unitCost || 0),
        qtyReceived:
          purchaseDraft.status === "received" ? Number(l.qtyOrdered) : 0,
      }));
    if (!lines.length) {
      setFormError("Add at least one product line");
      return;
    }
    setFormError(null);
    try {
      await api("/api/purchases", {
        method: "POST",
        body: JSON.stringify({
          supplierId: purchaseDraft.supplierId,
          supplierName: supplier.name,
          currency: purchaseDraft.currency || supplier.currency,
          status: purchaseDraft.status || "draft",
          vatPercent: Number(purchaseDraft.vatPercent || 0),
          lines,
        }),
      });
      setPurchaseDraft(null);
      await reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to save purchase");
    }
  }

  async function receiveAll(po: PurchaseOrder) {
    if (!po.lines?.length) return;
    setBusyId(po.id);
    try {
      await api(`/api/purchases/${po.id}`, {
        method: "PUT",
        body: JSON.stringify({ receiveAll: true }),
      });
      await reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to receive purchase");
    } finally {
      setBusyId(null);
    }
  }

  async function saveSupplier() {
    if (!supplierDraft?.name || !supplierDraft.phone) return;
    await api("/api/suppliers", {
      method: "POST",
      body: JSON.stringify({
        ...supplierDraft,
        creditLimit: Number(supplierDraft.creditLimit || 0),
        outstanding: 0,
        avgLeadDays: Number(supplierDraft.avgLeadDays || 0),
      }),
    });
    setSupplierDraft(null);
    await reloadSuppliers();
  }

  function addLine() {
    if (!purchaseDraft) return;
    setPurchaseDraft({
      ...purchaseDraft,
      lines: [
        ...purchaseDraft.lines,
        { productId: "", productName: "", sku: "", qtyOrdered: "1", unitCost: "" },
      ],
    });
  }

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    if (!purchaseDraft) return;
    const lines = purchaseDraft.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l));
    setPurchaseDraft({ ...purchaseDraft, lines });
  }

  function pickProduct(idx: number, productId: string) {
    const p = productList.find((x) => x.id === productId);
    updateLine(idx, {
      productId,
      productName: p?.name || "",
      sku: p?.sku || "",
      unitCost: p ? String(p.costFifo || 0) : "",
    });
  }

  function removeLine(idx: number) {
    if (!purchaseDraft) return;
    setPurchaseDraft({
      ...purchaseDraft,
      lines: purchaseDraft.lines.filter((_, i) => i !== idx),
    });
  }

  if (loading || suppliersLoading) return <LoadingState label="Loading purchasing data…" />;
  if (error || suppliersError) {
    return (
      <ErrorState
        message={error || suppliersError || "Failed to load purchasing data"}
        onRetry={() => {
          void reload();
          void reloadSuppliers();
        }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Purchasing & Suppliers"
        description="Supplier-based purchasing with multi-currency support, credit tracking, and FIFO layer creation on goods receipt. No auto PO — suppliers change often."
        actions={
          canWrite ? (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setSupplierDraft({ currency: "OMR" })}>
                Add Supplier
              </Button>
              <Button
                variant="gold"
                onClick={() =>
                  setPurchaseDraft({
                    supplierId: "",
                    currency: "OMR",
                    status: "ordered",
                    vatPercent: "5",
                    lines: [
                      { productId: "", productName: "", sku: "", qtyOrdered: "1", unitCost: "" },
                    ],
                  })
                }
              >
                New Purchase
              </Button>
            </div>
          ) : (
            <p className="text-xs text-ink-muted">
              Purchasing is owner/admin only (PUR-04) — view-only for your role.
            </p>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Active Suppliers" value={String(supplierList.length)} />
        <Stat label="Open Payables" value={formatMoney(outstanding)} />
        <Stat label="POs This Month" value={String(purchaseList.length)} />
        <Stat label="Currencies" value="OMR · AED" hint="Multi-currency ready" />
      </div>

      {formError ? (
        <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {formError}
        </p>
      ) : null}

      <div className="mt-6 grid gap-5 xl:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Purchase Spend Trend"
            subtitle="How much is received vs. still owed"
          />
          <PurchaseSpendTrendChart purchases={purchaseList} />
        </Panel>

        <Panel>
          <PanelHeader title="Top Suppliers by Spend" subtitle="All-time purchase value" />
          <SupplierSpendChart data={supplierSpend} />
        </Panel>
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-2">
        <Panel padding={false}>
          <div className="border-b border-line/70 px-5 py-4">
            <PanelHeader title="Recent Purchases" subtitle="Creates FIFO cost layers on receipt" />
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-mist/70 text-[11px] uppercase tracking-wider text-ink-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Date</th>
                <th className="px-3 py-2.5 font-medium">Supplier</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 text-right font-medium">Total</th>
                <th className="px-5 py-2.5 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {purchaseList.map((po) => {
                const canReceive =
                  (po.status === "ordered" || po.status === "partial" || po.status === "draft") &&
                  (po.lines?.length ?? 0) > 0 &&
                  po.lines.some((l) => l.qtyReceived < l.qtyOrdered);
                return (
                  <tr key={po.id} className="border-t border-line/60">
                    <td className="px-5 py-3 text-ink-muted">{formatDate(po.date)}</td>
                    <td className="px-3 py-3">
                      <p className="font-medium">{po.supplierName}</p>
                      <p className="text-[11px] text-ink-muted">
                        {po.itemCount} lines · {po.currency}
                        {po.lines?.length
                          ? ` · recv ${po.lines.reduce((s, l) => s + l.qtyReceived, 0)}/${po.lines.reduce((s, l) => s + l.qtyOrdered, 0)}`
                          : ""}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={statusTone[po.status]}>{po.status}</Badge>
                    </td>
                    <td className="px-3 py-3 text-right font-medium">
                      {formatMoney(po.total, po.currency)}
                      {po.vatPercent > 0 ? (
                        <p className="text-[11px] font-normal text-ink-muted">
                          incl. {po.vatPercent}% VAT
                        </p>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {canReceive && canWrite ? (
                        <Button
                          variant="secondary"
                          disabled={busyId === po.id}
                          onClick={() => void receiveAll(po)}
                        >
                          {busyId === po.id ? "Receiving…" : "Receive"}
                        </Button>
                      ) : po.status === "received" && (po.lines?.length ?? 0) > 0 ? (
                        <span className="text-[11px] text-ink-muted">FIFO applied</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        <Panel padding={false}>
          <div className="border-b border-line/70 px-5 py-4">
            <PanelHeader title="Supplier Directory" subtitle="Price history & credit" />
          </div>
          <ul className="divide-y divide-line/60">
            {supplierList.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                <div>
                  <p className="font-medium">{s.name}</p>
                  <p className="text-xs text-ink-muted">
                    {s.phone} · Lead {s.avgLeadDays}d · Last {formatDate(s.lastPurchase)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold">
                    {formatMoney(s.outstanding, s.currency)}
                  </p>
                  <p className="text-[11px] text-ink-muted">
                    of {formatMoney(s.creditLimit, s.currency)} limit
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {purchaseDraft ? (
        <div ref={purchaseFormRef}>
        <Panel className="mt-5">
          <PanelHeader
            title="New Purchase"
            subtitle="Add product lines — set status to Received to create FIFO layers immediately"
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <label className="text-xs text-ink-muted">
              Supplier
              <select
                value={purchaseDraft.supplierId}
                onChange={(e) => {
                  const s = supplierList.find((x) => x.id === e.target.value);
                  setPurchaseDraft({
                    ...purchaseDraft,
                    supplierId: e.target.value,
                    currency: s?.currency || purchaseDraft.currency,
                  });
                }}
                className="mt-1 h-9 w-full rounded border border-line bg-mist px-2"
              >
                <option value="">Select supplier</option>
                {supplierList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <CurrencySelect
              label="Currency"
              value={purchaseDraft.currency}
              onChange={(currency) => setPurchaseDraft({ ...purchaseDraft, currency })}
            />
            <label className="text-xs text-ink-muted">
              Status
              <select
                value={purchaseDraft.status}
                onChange={(e) => setPurchaseDraft({ ...purchaseDraft, status: e.target.value })}
                className="mt-1 h-9 w-full rounded border border-line bg-mist px-2"
              >
                <option value="draft">draft</option>
                <option value="ordered">ordered</option>
                <option value="received">received (apply FIFO now)</option>
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              VAT %
              <select
                value={purchaseDraft.vatPercent}
                onChange={(e) => setPurchaseDraft({ ...purchaseDraft, vatPercent: e.target.value })}
                className="mt-1 h-9 w-full rounded border border-line bg-mist px-2"
              >
                <option value="5">5% VAT</option>
                <option value="0">No VAT</option>
              </select>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 rounded border border-line/60 bg-mist/40 px-3 py-2 text-sm">
            <p className="text-ink-muted">
              Subtotal{" "}
              <span className="font-medium text-ink">
                {formatMoney(draftSubtotal, purchaseDraft.currency)}
              </span>
            </p>
            <p className="text-ink-muted">
              VAT ({purchaseDraft.vatPercent || 0}%){" "}
              <span className="font-medium text-ink">
                {formatMoney(draftVatAmount, purchaseDraft.currency)}
              </span>
            </p>
            <p className="text-ink-muted">
              Total{" "}
              <span className="font-semibold text-ink">
                {formatMoney(draftTotal, purchaseDraft.currency)}
              </span>
            </p>
          </div>

          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wider text-ink-muted">Lines</p>
              <Button variant="secondary" onClick={addLine}>
                Add line
              </Button>
            </div>
            {purchaseDraft.lines.map((line, idx) => (
              <div
                key={idx}
                className="grid gap-2 rounded border border-line/60 bg-mist/40 p-3 sm:grid-cols-[2fr_1fr_1fr_auto]"
              >
                <label className="text-xs text-ink-muted">
                  Product
                  <select
                    value={line.productId}
                    onChange={(e) => pickProduct(idx, e.target.value)}
                    className="mt-1 h-9 w-full rounded border border-line bg-white px-2"
                  >
                    <option value="">Select product</option>
                    {productList.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sku} — {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Field
                  label="Qty"
                  value={line.qtyOrdered}
                  onChange={(qtyOrdered) => updateLine(idx, { qtyOrdered })}
                />
                <Field
                  label="Unit cost"
                  value={line.unitCost}
                  onChange={(unitCost) => updateLine(idx, { unitCost })}
                />
                <div className="flex items-end">
                  <Button variant="secondary" onClick={() => removeLine(idx)}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex gap-2">
            <Button onClick={() => void savePurchase()}>Save Purchase</Button>
            <Button
              variant="secondary"
              onClick={() => {
                setPurchaseDraft(null);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </Panel>
        </div>
      ) : null}

      {supplierDraft ? (
        <div ref={supplierFormRef}>
        <Panel className="mt-5">
          <PanelHeader title="New Supplier" subtitle="Add a supplier directory entry" />
          <div className="grid gap-3 sm:grid-cols-4">
            <Field
              label="Name"
              value={supplierDraft.name || ""}
              onChange={(name) => setSupplierDraft({ ...supplierDraft, name })}
            />
            <Field
              label="Phone"
              value={supplierDraft.phone || ""}
              onChange={(phone) => setSupplierDraft({ ...supplierDraft, phone })}
            />
            <CurrencySelect
              label="Currency"
              value={supplierDraft.currency || "OMR"}
              onChange={(currency) => setSupplierDraft({ ...supplierDraft, currency })}
            />
            <Field
              label="Credit limit"
              value={supplierDraft.creditLimit || ""}
              onChange={(creditLimit) => setSupplierDraft({ ...supplierDraft, creditLimit })}
            />
          </div>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void saveSupplier()}>Save Supplier</Button>
            <Button variant="secondary" onClick={() => setSupplierDraft(null)}>
              Cancel
            </Button>
          </div>
        </Panel>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-9 w-full rounded border border-line bg-mist px-2 text-sm outline-none transition focus:border-gold focus:ring-2 focus:ring-gold/20"
      />
    </label>
  );
}

const CURRENCY_OPTIONS = ["OMR", "AED"];

function CurrencySelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-9 w-full rounded border border-line bg-mist px-2 text-sm outline-none transition focus:border-gold focus:ring-2 focus:ring-gold/20"
      >
        {CURRENCY_OPTIONS.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}
