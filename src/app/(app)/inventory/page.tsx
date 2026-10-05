"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Filter,
  TrendingDown,
  TrendingUp,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Stat } from "@/components/ui/Stat";
import { ErrorState, LoadingState, useApiData } from "@/components/ui/DataState";
import { api } from "@/lib/api";
import { clsx, formatMoney, formatQty } from "@/lib/format";
import {
  buildInventoryValuation,
  type CategoryValuation,
  type ValuationBucket,
} from "@/lib/reports/inventoryValuation";
import type { FifoLayer, ImportBatchSummary, Product } from "@/lib/types";

const buckets: { id: ValuationBucket; label: string }[] = [
  { id: "sellable", label: "Sellable" },
  { id: "tester", label: "Testers" },
  { id: "sample", label: "Samples" },
  { id: "personal", label: "Personal" },
  { id: "all", label: "All buckets" },
];
const emptyProducts: Product[] = [];

export default function InventoryPage() {
  const { data: products, loading, error, reload, setData: setProducts } =
    useApiData<Product[]>("/api/products");
  const [bucket, setBucket] = useState<ValuationBucket>("sellable");
  const [selected, setSelected] = useState("");
  const [category, setCategory] = useState("All");
  const [brand, setBrand] = useState("All");
  const [productId, setProductId] = useState("All");
  const [saving, setSaving] = useState(false);
  const [exportingValuation, setExportingValuation] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [staging, setStaging] = useState<ImportBatchSummary | null>(null);
  const [stageBusy, setStageBusy] = useState(false);
  const [commitBusy, setCommitBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [adminOverride, setAdminOverride] = useState(false);
  const [safeMode, setSafeMode] = useState(true);
  const [adminPassword, setAdminPassword] = useState("");
  const [lastCommittedBatchId, setLastCommittedBatchId] = useState<string | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [adjustQty, setAdjustQty] = useState("1");
  const [wastageKind, setWastageKind] = useState<"cost" | "customer">("cost");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [customerHits, setCustomerHits] = useState<
    Array<{ id: string; name: string; phone: string }>
  >([]);
  const [customerSearching, setCustomerSearching] = useState(false);

  const inventory = products ?? emptyProducts;

  const valuation = useMemo(
    () =>
      buildInventoryValuation(inventory, {
        bucket,
        category: "All",
        brand,
        productId,
      }),
    [brand, bucket, inventory, productId],
  );

  const activeCategory =
    category === "All"
      ? null
      : valuation.categories.find((c) => c.category === category) ?? null;

  const categoryOptions = useMemo(
    () => ["All", ...valuation.categories.map((c) => c.category)],
    [valuation.categories],
  );

  const brandOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of inventory) {
      const b = (p.brand || "").trim();
      if (b) set.add(b);
    }
    return ["All", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [inventory]);

  const productOptions = useMemo(() => {
    return inventory
      .filter((p) => {
        if (brand !== "All") {
          const pb = (p.brand || "").trim();
          if (!pb || pb.toLowerCase() !== brand.toLowerCase()) return false;
        }
        if (category !== "All" && p.category !== category) return false;
        return true;
      })
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [brand, category, inventory]);

  const productRows = activeCategory?.products ?? [];
  const tableProducts =
    category === "All"
      ? []
      : productRows.length
        ? productRows
        : inventory
            .filter((p) => p.category === category)
            .map((p) => {
              const qty =
                bucket === "tester"
                  ? p.stockTester
                  : bucket === "sample"
                    ? p.stockSample
                    : bucket === "personal"
                      ? p.stockPersonal
                      : bucket === "all"
                        ? p.stockSellable +
                          p.stockTester +
                          p.stockSample +
                          p.stockPersonal
                        : p.stockSellable;
              return {
                id: p.id,
                sku: p.sku,
                name: p.name,
                category: p.category,
                brand: p.brand || "",
                unit: p.unit,
                qty,
                costFifo: p.costFifo,
                value: qty * p.costFifo,
                shareOfCategory: 0,
                lowStock:
                  bucket === "sellable" &&
                  p.lowStockAt > 0 &&
                  p.stockSellable <= p.lowStockAt,
              };
            });

  const activeId =
    selected ||
    tableProducts[0]?.id ||
    (category === "All" ? "" : inventory.find((p) => p.category === category)?.id) ||
    inventory[0]?.id ||
    "";

  const {
    data: layers,
    loading: layersLoading,
    reload: reloadLayers,
  } = useApiData<FifoLayer[]>(
    activeId ? `/api/fifo-layers?productId=${activeId}` : null,
  );

  const selectedProduct = inventory.find((p) => p.id === activeId);
  const lowCount = inventory.filter(
    (p) => p.lowStockAt > 0 && p.stockSellable <= p.lowStockAt,
  ).length;

  function flash(msg: string, ms = 4000) {
    setToast(msg);
    window.setTimeout(() => setToast(null), ms);
  }

  /** Patch sellable on the spot (optimistic / confirmed). */
  function patchSellable(productId: string, stockSellable: number, extra?: Partial<Product>) {
    setProducts((prev) => {
      const list = prev ?? [];
      return list.map((p) =>
        p.id === productId
          ? { ...p, stockSellable, ...extra }
          : p,
      );
    });
  }

  /** Confirm patch + refresh FIFO layers in background (do not block UI). */
  function applyAdjustResult(updated: {
    id: string;
    stockSellable: number;
    costFifo?: number;
  }) {
    patchSellable(updated.id, updated.stockSellable, {
      costFifo: updated.costFifo,
    });
    void reloadLayers({ silent: true });
  }

  function selectCategory(next: string) {
    setCategory(next);
    setSelected("");
    if (next === "All") {
      setProductId("All");
      return;
    }
    if (productId !== "All") {
      const p = inventory.find((x) => x.id === productId);
      if (!p || p.category !== next) {
        setProductId("All");
      }
    }
  }

  function selectProductFilter(next: string) {
    setProductId(next);
    if (next === "All") {
      setSelected("");
      return;
    }
    const p = inventory.find((x) => x.id === next);
    if (!p) return;
    setCategory(p.category);
    setSelected(p.id);
  }

  async function saveStock() {
    if (!selectedProduct) return;
    // INV-06: stock can't be set below zero — warn and stop (a FIFO layer
    // can't hold negative stock; record wastage/adjustment or restock instead).
    if (selectedProduct.stockSellable < 0) {
      flash(
        `Stock warning: ${selectedProduct.name} sellable would be ${selectedProduct.stockSellable}. Stock can't go below zero — admin should restock or reorder.`,
        7000,
      );
      return;
    }
    setSaving(true);
    try {
      // A changed sellable figure is booked server-side as a FIFO adjustment.
      const res = await api<{
        warnings?: string[];
        stockAdjustment?: { delta: number };
      }>(`/api/products/${selectedProduct.id}`, {
        method: "PUT",
        body: JSON.stringify({
          stockSellable: selectedProduct.stockSellable,
          stockTester: selectedProduct.stockTester,
          stockSample: selectedProduct.stockSample,
          stockPersonal: selectedProduct.stockPersonal,
          lowStockAt: selectedProduct.lowStockAt,
        }),
      });
      await reload();
      if (res.warnings && res.warnings.length > 0) {
        flash(res.warnings[0]);
      } else if (res.stockAdjustment) {
        const d = res.stockAdjustment.delta;
        flash(`Stock saved · adjustment ${d > 0 ? "+" : ""}${d} recorded`);
      } else {
        flash("Stock saved");
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not save stock", 7000);
    } finally {
      setSaving(false);
    }
  }

  async function searchCustomers(q: string) {
    setCustomerQuery(q);
    setCustomerId("");
    if (q.trim().length < 2) {
      setCustomerHits([]);
      return;
    }
    setCustomerSearching(true);
    try {
      const rows = await api<Array<{ id: string; name: string; phone: string }>>(
        `/api/customers?q=${encodeURIComponent(q.trim())}`,
      );
      setCustomerHits(rows.slice(0, 8));
    } catch {
      setCustomerHits([]);
    } finally {
      setCustomerSearching(false);
    }
  }

  async function adjustStock(direction: "in" | "out") {
    if (!selectedProduct) return;
    const qty = Number(adjustQty);
    if (!Number.isFinite(qty) || !(qty > 0)) {
      flash("Qty must be greater than 0");
      return;
    }

    const reason =
      direction === "in"
        ? "restock"
        : wastageKind === "customer"
          ? "wastage_customer"
          : "wastage_cost";

    if (reason === "wastage_customer" && !customerId) {
      flash("Select a customer for leaked/damaged replacement (INV-07)");
      return;
    }

    const productId = selectedProduct.id;
    const before = selectedProduct.stockSellable;
    const unit = selectedProduct.unit;
    const optimisticAfter =
      direction === "out" ? before - qty : before + qty;

    // Instant Sellable update on the panel (revert if API fails)
    patchSellable(productId, optimisticAfter);
    setSaving(true);

    try {
      const payload: Record<string, unknown> = {
        productId,
        qty,
        direction,
        reason,
      };
      if (reason === "wastage_customer") {
        payload.customerId = customerId;
      }

      const res = await fetch("/api/inventory/adjustments", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        error?: string;
        expenseId?: string;
        saleId?: string;
        costTotal?: number;
        stockSellable?: number;
        product?: {
          id?: string;
          stockSellable?: number;
          costFifo?: number;
        } | null;
      };

      if (!res.ok) {
        patchSellable(productId, before);
        throw new Error(
          data.error ||
            "Stock not updated — check FIFO layers / sellable qty",
        );
      }

      const after =
        data.stockSellable !== undefined
          ? Number(data.stockSellable)
          : data.product?.stockSellable !== undefined
            ? Number(data.product.stockSellable)
            : optimisticAfter;

      applyAdjustResult({
        id: productId,
        stockSellable: after,
        costFifo:
          data.product?.costFifo !== undefined
            ? Number(data.product.costFifo)
            : undefined,
      });

      if (data.saleId) {
        flash(
          `Saved · −${formatQty(qty, unit)} (${formatQty(before, unit)} → ${formatQty(after, unit)}) · customer paid`,
        );
      } else if (data.expenseId) {
        flash(
          `Saved · damage −${formatQty(qty, unit)} (${formatQty(before, unit)} → ${formatQty(after, unit)})${
            data.costTotal != null ? ` · ${formatMoney(data.costTotal)}` : ""
          } · Expenses`,
        );
      } else if (direction === "in") {
        flash(
          `Saved · restock +${formatQty(qty, unit)} (${formatQty(before, unit)} → ${formatQty(after, unit)})`,
        );
      } else {
        flash(
          `Saved · −${formatQty(qty, unit)} (${formatQty(before, unit)} → ${formatQty(after, unit)})`,
        );
      }
      setAdjustQty("1");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Adjustment failed");
    } finally {
      setSaving(false);
    }
  }

  async function transferBucket(
    from: "stockSellable" | "stockTester" | "stockSample" | "stockPersonal",
    to: "stockSellable" | "stockTester" | "stockSample" | "stockPersonal",
  ) {
    if (!selectedProduct) return;
    setSaving(true);
    try {
      const res = await fetch("/api/inventory/transfers", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: selectedProduct.id,
          qty: 1,
          from,
          to,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        warnings?: string[];
        requiresAck?: boolean;
      };
      if (!res.ok) throw new Error(data.error || "Transfer failed");
      await reload();
      flash(data.warnings?.[0] || "Bucket transfer saved");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setSaving(false);
    }
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadTemplate() {
    const res = await fetch("/api/products/import/template");
    if (!res.ok) throw new Error("Could not download template");
    downloadBlob(await res.blob(), "unich-product-import-template.xlsx");
  }

  async function exportCatalogue() {
    try {
      const res = await fetch("/api/products/export");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Export failed");
      }
      downloadBlob(await res.blob(), "unich-product-catalogue.xlsx");
      flash("Catalogue exported");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Export failed");
    }
  }

  async function exportValuation() {
    setExportingValuation(true);
    try {
      const params = new URLSearchParams({ bucket });
      if (category !== "All") params.set("category", category);
      if (brand !== "All") params.set("brand", brand);
      if (productId !== "All") params.set("productId", productId);
      const res = await fetch(
        `/api/reports/inventory-valuation/export?${params.toString()}`,
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Valuation export failed");
      }
      downloadBlob(
        await res.blob(),
        `inventory-valuation-${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
      flash("Category valuation exported");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Valuation export failed");
    } finally {
      setExportingValuation(false);
    }
  }

  async function onFileSelected(file: File | null) {
    if (!file) return;
    setStageBusy(true);
    setStaging(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/products/import/stage", {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Staging failed");
      setStaging(data as ImportBatchSummary);
      setAdminOverride(false);
      setAdminPassword("");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Staging failed");
    } finally {
      setStageBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function commitImport() {
    if (!staging) return;
    setCommitBusy(true);
    try {
      const result = await api<{
        batchId: string;
        created: number;
        updated: number;
        failed: number;
      }>("/api/products/import/commit", {
        method: "POST",
        body: JSON.stringify({
          batchId: staging.batchId,
          adminOverride,
          strictMode: safeMode,
          adminPassword: adminOverride ? adminPassword : undefined,
        }),
      });
      setLastCommittedBatchId(result.batchId);
      flash(
        `Import committed · ${result.created} created · ${result.updated} updated · ${result.failed} skipped`,
      );
      setImportOpen(false);
      setStaging(null);
      await reload();
    } catch (err) {
      flash(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setCommitBusy(false);
    }
  }

  async function downloadErrors() {
    if (!staging) return;
    const res = await fetch(`/api/products/import/${staging.batchId}/errors`);
    if (!res.ok) {
      flash("Could not download error report");
      return;
    }
    downloadBlob(await res.blob(), `import-errors-${staging.batchId}.xlsx`);
  }

  async function undoLastImport() {
    if (!lastCommittedBatchId) return;
    setUndoBusy(true);
    try {
      await api(`/api/products/import/${lastCommittedBatchId}/undo`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      flash(`Undid import ${lastCommittedBatchId}`);
      setLastCommittedBatchId(null);
      await reload();
    } catch (err) {
      flash(err instanceof Error ? err.message : "Undo failed");
    } finally {
      setUndoBusy(false);
    }
  }

  const errorRows = staging?.rows.filter((r) => r.action === "error") ?? [];
  const hasWritable =
    Boolean(staging && (staging.created > 0 || staging.updated > 0)) ||
    Boolean(staging && adminOverride && staging.priceFloorCount > 0 && adminPassword);
  const strictBlocked = Boolean(safeMode && staging && staging.failed > 0);

  const importModal = importOpen ? (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
        <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-paper shadow-xl">
          <div className="flex items-center justify-between border-b border-line/70 px-5 py-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gold">
                Catalogue import
              </p>
              <h2 className="mt-1 font-semibold text-xl text-ink">Excel Import</h2>
            </div>
            <button
              type="button"
              className="rounded-lg p-2 text-ink-muted hover:bg-mist hover:text-ink"
              onClick={() => {
                setImportOpen(false);
                setStaging(null);
              }}
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="space-y-4 px-5 py-4">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void downloadTemplate().catch((e) => flash(e.message))}
              >
                <FileSpreadsheet className="h-4 w-4" />
                1) Download Template
              </Button>
              <Button
                variant="gold"
                size="sm"
                disabled={stageBusy}
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="h-4 w-4" />
                {stageBusy ? "Checking File…" : "2) Upload File"}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => void onFileSelected(e.target.files?.[0] || null)}
              />
            </div>

            {staging ? (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <MiniStat label="Rows in file" value={String(staging.total)} />
                  <MiniStat label="New products" value={String(staging.created)} />
                  <MiniStat label="Products to update" value={String(staging.updated)} />
                  <MiniStat label="Rows to fix" value={String(staging.failed)} />
                </div>

                {staging.priceFloorCount > 0 ? (
                  <div className="rounded-lg border border-line bg-mist/50 px-3 py-3 text-sm">
                    <p className="font-medium text-ink">
                      {staging.priceFloorCount} row needs admin price approval
                    </p>
                    <label className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
                      <input
                        type="checkbox"
                        checked={adminOverride}
                        onChange={(e) => setAdminOverride(e.target.checked)}
                      />
                      Allow admin price exception (password)
                    </label>
                    {adminOverride ? (
                      <input
                        type="password"
                        placeholder="Admin password"
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        className="mt-2 h-9 w-full rounded border border-line bg-paper px-2 text-sm"
                      />
                    ) : null}
                  </div>
                ) : null}

                {errorRows.length > 0 ? (
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-sm font-medium">Rows needing fix</p>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void downloadErrors()}
                      >
                        Download Fix File
                      </Button>
                    </div>
                    <p className="mb-2 text-xs text-ink-muted">
                      Fix these rows and upload the file again.
                    </p>
                    <div className="max-h-48 overflow-auto rounded-lg border border-line">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-mist/70 text-ink-muted">
                          <tr>
                            <th className="px-3 py-2">Row</th>
                            <th className="px-3 py-2">Product Code</th>
                            <th className="px-3 py-2">What to fix</th>
                          </tr>
                        </thead>
                        <tbody>
                          {errorRows.map((r) => (
                            <tr key={r.rowNumber} className="border-t border-line/60">
                              <td className="px-3 py-2 align-top">{r.rowNumber}</td>
                              <td className="px-3 py-2 align-top">{r.sku || "—"}</td>
                              <td className="px-3 py-2 align-top text-ink-muted">
                                <ul className="list-disc space-y-0.5 pl-4">
                                  {(r.errorReason || "")
                                    .split(";")
                                    .map((issue) => issue.trim())
                                    .filter(Boolean)
                                    .map((issue, i) => (
                                      <li key={i}>{issue}</li>
                                    ))}
                                </ul>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-sage">All rows passed validation.</p>
                )}

                <div className="rounded-lg border border-line bg-mist/50 px-3 py-3 text-sm">
                  <label className="flex items-center gap-2 text-ink">
                    <input
                      type="checkbox"
                      checked={safeMode}
                      onChange={(e) => setSafeMode(e.target.checked)}
                    />
                    Safe Mode (Stop if any error)
                  </label>
                  <p className="mt-1 text-xs text-ink-muted">
                    On: import stops if any row has an issue. Off: good rows import, bad
                    rows skip.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2 border-t border-line/70 pt-4">
                  <Button
                    variant="gold"
                    disabled={commitBusy || !hasWritable || strictBlocked}
                    onClick={() => void commitImport()}
                  >
                    {commitBusy ? "Importing…" : "Import Now"}
                  </Button>
                  {strictBlocked ? (
                    <Button variant="secondary" onClick={() => void downloadErrors()}>
                      Fix File & Re-upload
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setStaging(null);
                      setAdminOverride(false);
                      setAdminPassword("");
                    }}
                  >
                    Reset
                  </Button>
                </div>
                <p className="text-[11px] text-ink-muted">
                  Batch {staging.batchId} ·{" "}
                  {safeMode
                    ? "Safe Mode is ON: fix all rows first."
                    : "Safe Mode is OFF: valid rows will import."}
                </p>
              </>
            ) : (
              <p className="text-sm text-ink-muted">
                Download the flat template, fill one product per row, then upload for a
                dry-run preview before anything hits the database.
              </p>
            )}
          </div>
        </div>
      </div>
  ) : null;

  if (loading) return <LoadingState label="Loading inventory…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!inventory.length) {
    return (
      <div>
        <PageHeader
          eyebrow="Inventory"
          title="Stock & Category Valuation"
          description="No products yet. Import a catalogue to start tracking FIFO stock value by category."
          actions={
            <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" />
              Import Excel
            </Button>
          }
        />
        {importModal}
      </div>
    );
  }

  const topCards = valuation.categories.slice(0, 4);

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock & Category Valuation"
        description="FIFO inventory value by category — click a category to drill into products and cost layers."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" />
              Import Excel
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void exportCatalogue()}>
              <Download className="h-4 w-4" />
              Catalogue
            </Button>
            <Button
              variant="gold"
              size="sm"
              disabled={exportingValuation}
              onClick={() => void exportValuation()}
            >
              <FileSpreadsheet className="h-4 w-4" />
              {exportingValuation ? "Exporting…" : "Export valuation"}
            </Button>
            {lastCommittedBatchId ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={undoBusy}
                onClick={() => void undoLastImport()}
              >
                <Undo2 className="h-4 w-4" />
                {undoBusy ? "Undoing…" : "Undo last import"}
              </Button>
            ) : null}
          </>
        }
      />

      {toast ? (
        <div className="mb-4 rounded-lg border border-sage/30 bg-sage-soft px-4 py-2 text-sm text-sage">
          {toast}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Total Inventory"
          value={formatMoney(valuation.totalValue)}
          hint={`${valuation.totalSkus} SKUs · FIFO sellable basis`}
        />
        <Stat
          label="Categories"
          value={String(valuation.categoryCount)}
          hint="With stock value tracked"
        />
        <Stat
          label="Highest Value"
          value={valuation.highest ? formatMoney(valuation.highest.value) : "—"}
          hint={valuation.highest?.category}
          trend={
            valuation.highest
              ? `${valuation.highest.shareOfTotal.toFixed(0)}% of total`
              : undefined
          }
          trendUp
        />
        <Link
          href="/inventory/low-stock"
          className="block rounded-[var(--radius)] transition hover:ring-2 hover:ring-gold/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
        >
          <Stat
            label="Low Stock Alerts"
            value={String(lowCount)}
            trend={lowCount > 0 ? "Review" : "Healthy"}
            trendUp={lowCount === 0}
            hint={lowCount > 0 ? "View all low products →" : "All healthy →"}
            className="h-full"
          />
        </Link>
      </div>

      {topCards.length > 0 ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {topCards.map((c, idx) => (
            <button
              key={c.category}
              type="button"
              onClick={() => selectCategory(c.category)}
              className={clsx(
                "group rounded-[var(--radius)] border p-4 text-left transition",
                "hover:border-gold/50 hover:bg-gold/5",
                category === c.category
                  ? "border-gold bg-gold/10 shadow-[var(--shadow-soft)]"
                  : "border-line/80 bg-paper",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-gold-deep">
                  {idx === 0 ? "Top category" : `Category ${idx + 1}`}
                </p>
                <ChevronRight className="h-4 w-4 text-ink-muted opacity-0 transition group-hover:opacity-100" />
              </div>
              <p className="mt-1.5 truncate text-base font-semibold text-ink">
                {c.category}
              </p>
              <p className="mt-1 text-xl font-semibold tracking-tight text-ink">
                {formatMoney(c.value)}
              </p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-mist">
                <div
                  className="h-full rounded-full bg-gold transition-all"
                  style={{ width: `${Math.min(100, Math.max(4, c.shareOfTotal))}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-ink-muted">
                {c.skuCount} SKUs · {c.shareOfTotal.toFixed(1)}% of inventory
              </p>
            </button>
          ))}
        </div>
      ) : null}

      {(valuation.highest || valuation.lowest) && category === "All" ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {valuation.highest ? (
            <InsightChip
              icon={<TrendingUp className="h-4 w-4" />}
              tone="high"
              title="Highest inventory value"
              body={`${valuation.highest.category} holds ${formatMoney(valuation.highest.value)} (${valuation.highest.shareOfTotal.toFixed(1)}%)`}
              onClick={() => selectCategory(valuation.highest!.category)}
            />
          ) : null}
          {valuation.lowest ? (
            <InsightChip
              icon={<TrendingDown className="h-4 w-4" />}
              tone="low"
              title="Lowest inventory value"
              body={`${valuation.lowest.category} holds ${formatMoney(valuation.lowest.value)} (${valuation.lowest.shareOfTotal.toFixed(1)}%)`}
              onClick={() => selectCategory(valuation.lowest!.category)}
            />
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {buckets.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setBucket(b.id)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
              bucket === b.id
                ? "bg-ink text-canvas"
                : "border border-line bg-mist text-ink-muted hover:text-ink"
            }`}
          >
            {b.label}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Filter className="h-4 w-4 text-ink-muted" />
          <select
            value={category}
            onChange={(e) => selectCategory(e.target.value)}
            className="h-9 rounded-lg border border-line bg-mist px-2 text-sm outline-none focus:border-gold"
            aria-label="Filter by category"
          >
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {c === "All" ? "All categories" : c}
              </option>
            ))}
          </select>
          <select
            value={brand}
            onChange={(e) => {
              setBrand(e.target.value);
              setSelected("");
              setProductId("All");
            }}
            className="h-9 rounded-lg border border-line bg-mist px-2 text-sm outline-none focus:border-gold"
            aria-label="Filter by brand"
          >
            {brandOptions.map((b) => (
              <option key={b} value={b}>
                {b === "All" ? "All brands" : b}
              </option>
            ))}
          </select>
          <select
            value={productId}
            onChange={(e) => selectProductFilter(e.target.value)}
            className="h-9 max-w-[220px] rounded-lg border border-line bg-mist px-2 text-sm outline-none focus:border-gold"
            aria-label="Filter by product"
          >
            <option value="All">All products</option>
            {productOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {category !== "All" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => selectCategory("All")}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted transition hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
            All categories
          </button>
          <span className="text-ink-muted">/</span>
          <Badge tone="gold">{category}</Badge>
          {activeCategory ? (
            <span className="text-sm text-ink-muted">
              {activeCategory.skuCount} SKUs · {formatMoney(activeCategory.value)} ·{" "}
              {activeCategory.shareOfTotal.toFixed(1)}% of total
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 grid gap-5 xl:grid-cols-[1.35fr_1fr]">
        <Panel padding={false}>
          {category === "All" ? (
            <CategorySummaryTable
              categories={valuation.categories}
              totalValue={valuation.totalValue}
              onSelect={selectCategory}
            />
          ) : (
            <ProductValuationTable
              products={tableProducts}
              activeId={activeId}
              onSelect={(id) => setSelected(id)}
              categoryValue={activeCategory?.value ?? 0}
            />
          )}
        </Panel>

        <div className="space-y-5">
          {category === "All" ? (
            <Panel>
              <PanelHeader
                title="How to read this"
                subtitle="Category-wise FIFO valuation"
              />
              <ul className="space-y-3 text-sm text-ink-muted">
                <li>
                  <span className="font-medium text-ink">Category value</span> = sum of
                  product FIFO values ({bucket === "all" ? "all buckets" : bucket}).
                </li>
                <li>
                  Click a category row or card to see each SKU&apos;s qty, cost, and value.
                </li>
                <li>
                  Values update live after purchases, sales, adjustments, and imports.
                </li>
                <li>
                  Export valuation for Excel with both category summary and product detail.
                </li>
              </ul>
            </Panel>
          ) : selectedProduct ? (
            <>
              <Panel>
                <PanelHeader
                  title={selectedProduct.name}
                  subtitle={`${selectedProduct.sku} · ${selectedProduct.category}`}
                  action={<Badge tone="gold">Admin</Badge>}
                />
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Meta
                    label="Sellable"
                    value={formatQty(
                      selectedProduct.stockSellable,
                      selectedProduct.unit,
                    )}
                  />
                  <Meta
                    label="Testers"
                    value={formatQty(selectedProduct.stockTester, selectedProduct.unit)}
                  />
                  <Meta
                    label="Samples"
                    value={formatQty(selectedProduct.stockSample, selectedProduct.unit)}
                  />
                  <Meta
                    label="Personal"
                    value={formatQty(
                      selectedProduct.stockPersonal,
                      selectedProduct.unit,
                    )}
                  />
                  <Meta
                    label="Low at"
                    value={formatQty(selectedProduct.lowStockAt, selectedProduct.unit)}
                  />
                  <Meta label="Avg FIFO" value={formatMoney(selectedProduct.costFifo)} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  {(
                    [
                      "stockSellable",
                      "stockTester",
                      "stockSample",
                      "stockPersonal",
                      "lowStockAt",
                    ] as const
                  ).map((field) => (
                    <label key={field} className="text-xs text-ink-muted">
                      {field.replace("stock", "").replace(/([A-Z])/g, " $1")}
                      <input
                        type="number"
                        value={selectedProduct[field]}
                        onChange={(e) => {
                          setProducts(
                            inventory.map((p) =>
                              p.id === selectedProduct.id
                                ? { ...p, [field]: Number(e.target.value) }
                                : p,
                            ),
                          );
                        }}
                        className="mt-1 h-8 w-full rounded border border-line bg-mist px-2 text-sm"
                      />
                    </label>
                  ))}
                </div>
                <Button className="mt-3" size="sm" onClick={saveStock} disabled={saving}>
                  {saving ? "Saving…" : "Save stock fields"}
                </Button>
                <div className="mt-4 border-t border-line pt-3">
                  <p className="text-xs font-medium text-ink-muted">
                    Damage / wastage / restock (INV-07)
                  </p>
                  <p className="mt-1 text-[11px] text-ink-muted">
                    Qty = damage pieces. Record wastage out → Sellable updates
                    instantly + saves (FIFO + Expenses). Short FIFO = error, stock
                    reverts.
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label className="text-xs text-ink-muted">
                      Qty
                      <input
                        type="number"
                        min={0.001}
                        step="any"
                        value={adjustQty}
                        onChange={(e) => setAdjustQty(e.target.value)}
                        className="mt-1 h-8 w-full rounded border border-line bg-mist px-2 text-sm text-ink"
                      />
                    </label>
                    <label className="text-xs text-ink-muted">
                      Out reason
                      <select
                        value={wastageKind}
                        onChange={(e) =>
                          setWastageKind(e.target.value as "cost" | "customer")
                        }
                        className="mt-1 h-8 w-full rounded border border-line bg-mist px-2 text-sm text-ink"
                      >
                        <option value="cost">Wastage as cost</option>
                        <option value="customer">
                          Customer damage (paid)
                        </option>
                      </select>
                    </label>
                  </div>
                  {wastageKind === "customer" ? (
                    <div className="mt-2 space-y-1">
                      <label className="text-xs text-ink-muted">
                        Customer (name or phone)
                        <input
                          type="search"
                          value={customerQuery}
                          onChange={(e) => void searchCustomers(e.target.value)}
                          placeholder="Search customer…"
                          className="mt-1 h-8 w-full rounded border border-line bg-mist px-2 text-sm text-ink"
                        />
                      </label>
                      {customerSearching ? (
                        <p className="text-[11px] text-ink-muted">Searching…</p>
                      ) : null}
                      {customerHits.length > 0 ? (
                        <ul className="max-h-28 overflow-y-auto rounded border border-line bg-canvas text-sm">
                          {customerHits.map((c) => (
                            <li key={c.id}>
                              <button
                                type="button"
                                className={`block w-full px-2 py-1.5 text-left hover:bg-mist ${
                                  customerId === c.id ? "bg-gold/10" : ""
                                }`}
                                onClick={() => {
                                  setCustomerId(c.id);
                                  setCustomerQuery(`${c.name} · ${c.phone}`);
                                  setCustomerHits([]);
                                }}
                              >
                                {c.name} · {c.phone}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {customerId ? (
                        <p className="text-[11px] text-sage">
                          Customer selected for paid replacement.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={saving}
                      onClick={() => void adjustStock("out")}
                    >
                      Record wastage out
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={saving}
                      onClick={() => void adjustStock("in")}
                    >
                      Restock in
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={saving}
                      onClick={() => void transferBucket("stockSellable", "stockTester")}
                    >
                      Sellable → Tester
                    </Button>
                  </div>
                </div>
              </Panel>

              <Panel>
                <PanelHeader
                  title="FIFO Cost Layers"
                  subtitle="Oldest layer consumed first on sale"
                />
                {layersLoading ? (
                  <LoadingState label="Loading layers…" />
                ) : !layers?.length ? (
                  <p className="text-sm text-ink-muted">
                    No FIFO layers recorded for this SKU.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {layers.map((layer, idx) => (
                      <li
                        key={layer.id}
                        className="rounded-lg border border-line/70 bg-mist/30 px-3 py-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[10px] font-semibold text-canvas">
                              {idx + 1}
                            </span>
                            <div>
                              <p className="text-sm font-medium">{layer.supplierName}</p>
                              <p className="text-[11px] text-ink-muted">
                                {layer.purchaseDate} · {layer.currency}
                                {layer.source === "production"
                                  ? " · production batch"
                                  : ""}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-semibold">
                              {formatMoney(layer.unitCost)}
                            </p>
                            <p className="text-[11px] text-ink-muted">
                              {formatQty(layer.qtyRemaining, selectedProduct.unit)} left
                            </p>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-4 rounded-lg border border-dashed border-gold/40 bg-gold/10 px-3 py-2 text-xs text-gold-deep">
                  Conversion: 1 Tola = 12 ml · ½ = 6 ml · ¼ = 3 ml
                </div>
              </Panel>
            </>
          ) : (
            <Panel>
              <PanelHeader title="Select a product" subtitle="Drill into FIFO layers" />
              <p className="text-sm text-ink-muted">
                Choose a SKU from the list to edit stock buckets and review purchase layers.
              </p>
            </Panel>
          )}
        </div>
      </div>

      {importModal}
    </div>
  );
}

function CategorySummaryTable({
  categories,
  totalValue,
  onSelect,
}: {
  categories: CategoryValuation[];
  totalValue: number;
  onSelect: (category: string) => void;
}) {
  if (!categories.length) {
    return (
      <div className="px-5 py-10 text-center text-sm text-ink-muted">
        No category value for the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex items-center justify-between border-b border-line/70 px-5 py-3">
        <div>
          <p className="text-sm font-semibold text-ink">Category summary</p>
          <p className="text-xs text-ink-muted">
            Click a row to drill into products · Total {formatMoney(totalValue)}
          </p>
        </div>
      </div>
      <table className="w-full text-left text-sm">
        <thead className="bg-mist/70 text-[11px] uppercase tracking-wider text-ink-muted">
          <tr>
            <th className="px-5 py-3 font-medium">Category</th>
            <th className="px-3 py-3 font-medium">SKUs</th>
            <th className="px-3 py-3 font-medium">Qty</th>
            <th className="px-3 py-3 font-medium">Share</th>
            <th className="px-5 py-3 text-right font-medium">Inventory Value</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <tr
              key={c.category}
              onClick={() => onSelect(c.category)}
              className="cursor-pointer border-t border-line/60 transition hover:bg-gold/5"
            >
              <td className="px-5 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{c.category}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-ink-muted" />
                </div>
              </td>
              <td className="px-3 py-3 text-ink-muted">{c.skuCount}</td>
              <td className="px-3 py-3 text-ink-muted">
                {Number.isInteger(c.qty) ? c.qty : c.qty.toFixed(3)}
              </td>
              <td className="px-3 py-3">
                <div className="flex min-w-[7rem] items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-mist">
                    <div
                      className="h-full rounded-full bg-ink/70"
                      style={{
                        width: `${Math.min(100, Math.max(3, c.shareOfTotal))}%`,
                      }}
                    />
                  </div>
                  <span className="w-10 text-right text-xs text-ink-muted">
                    {c.shareOfTotal.toFixed(0)}%
                  </span>
                </div>
              </td>
              <td className="px-5 py-3 text-right font-semibold">
                {formatMoney(c.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductValuationTable({
  products,
  activeId,
  onSelect,
  categoryValue,
}: {
  products: {
    id: string;
    sku: string;
    name: string;
    brand: string;
    unit: string;
    qty: number;
    costFifo: number;
    value: number;
    shareOfCategory: number;
    lowStock: boolean;
  }[];
  activeId: string;
  onSelect: (id: string) => void;
  categoryValue: number;
}) {
  if (!products.length) {
    return (
      <div className="px-5 py-10 text-center text-sm text-ink-muted">
        No products in this category for the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex items-center justify-between border-b border-line/70 px-5 py-3">
        <div>
          <p className="text-sm font-semibold text-ink">Products in category</p>
          <p className="text-xs text-ink-muted">
            FIFO value per SKU · Category total {formatMoney(categoryValue)}
          </p>
        </div>
      </div>
      <table className="w-full text-left text-sm">
        <thead className="bg-mist/70 text-[11px] uppercase tracking-wider text-ink-muted">
          <tr>
            <th className="px-5 py-3 font-medium">SKU / Product</th>
            <th className="px-3 py-3 font-medium">Qty</th>
            <th className="px-3 py-3 font-medium">FIFO Cost</th>
            <th className="px-3 py-3 font-medium">Share</th>
            <th className="px-5 py-3 text-right font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr
              key={p.id}
              onClick={() => onSelect(p.id)}
              className={clsx(
                "cursor-pointer border-t border-line/60 transition hover:bg-mist/50",
                activeId === p.id ? "bg-gold/10" : "",
              )}
            >
              <td className="px-5 py-3">
                <p className="font-medium">{p.name}</p>
                <p className="text-[11px] text-ink-muted">
                  {p.sku}
                  {p.brand ? ` · ${p.brand}` : ""}
                </p>
              </td>
              <td className="px-3 py-3">
                <Badge tone={p.lowStock ? "danger" : "neutral"}>
                  {formatQty(p.qty, p.unit)}
                </Badge>
              </td>
              <td className="px-3 py-3">{formatMoney(p.costFifo)}</td>
              <td className="px-3 py-3 text-xs text-ink-muted">
                {p.shareOfCategory.toFixed(1)}%
              </td>
              <td className="px-5 py-3 text-right font-medium">
                {formatMoney(p.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InsightChip({
  icon,
  tone,
  title,
  body,
  onClick,
}: {
  icon: React.ReactNode;
  tone: "high" | "low";
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex items-start gap-3 rounded-[var(--radius)] border px-4 py-3 text-left transition hover:border-gold/40",
        tone === "high"
          ? "border-sage/30 bg-sage-soft/40"
          : "border-line bg-mist/50",
      )}
    >
      <span
        className={clsx(
          "mt-0.5 rounded-full p-1.5",
          tone === "high" ? "bg-sage/15 text-sage" : "bg-ink/5 text-ink-muted",
        )}
      >
        {icon}
      </span>
      <span>
        <p className="text-xs font-medium uppercase tracking-wider text-ink-muted">
          {title}
        </p>
        <p className="mt-0.5 text-sm text-ink">{body}</p>
      </span>
    </button>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line/60 bg-mist/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-ink-muted">{label}</p>
      <p className="mt-0.5 font-medium">{value}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line/60 bg-mist/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-ink-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}
