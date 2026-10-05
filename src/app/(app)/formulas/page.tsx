"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  Eye,
  FileDown,
  History,
  Lock,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingState, useApiData } from "@/components/ui/DataState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { api } from "@/lib/api";
import { formatQty } from "@/lib/format";
import { printHtmlDocument } from "@/lib/receipt/print";
import { buildRecipeHtml } from "@/lib/formulas/recipeDocument";
import {
  sumLiquidMl,
  validateFormulaInput,
} from "@/lib/formulas/validateFormula";
import {
  matchRemixRole,
  OIL_BASE_PRODUCT_ID,
  REMIX_OIL_ML,
  type RemixRole,
} from "@/lib/sales/constants";
import type {
  Formula,
  FormulaComponent,
  FormulaStatus,
  Product,
  StockUnit,
} from "@/lib/types";

const UNITS: StockUnit[] = ["ml", "g", "kg", "pcs"];

function statusTone(status: FormulaStatus) {
  if (status === "approved") return "success" as const;
  if (status === "rejected") return "danger" as const;
  if (status === "archived") return "neutral" as const;
  return "warning" as const;
}

const emptyComponent = (): FormulaComponent => ({
  productId: "",
  productName: "",
  qty: 0,
  unit: "ml",
});

const oilBaseComponent = (qty = REMIX_OIL_ML): FormulaComponent => ({
  productId: OIL_BASE_PRODUCT_ID,
  productName: "Selected Oil Blend",
  qty,
  unit: "ml",
});

export default function FormulasPage() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [adminName, setAdminName] = useState("Admin");
  const [adminEmail, setAdminEmail] = useState("");
  const [authChecking, setAuthChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  // BLD-04: only fetch full recipes after admin session is active.
  const formulasUrl = unlocked
    ? query
      ? `/api/formulas?q=${encodeURIComponent(query)}`
      : "/api/formulas"
    : null;
  const {
    data: formulas,
    loading,
    error,
    reload,
    setData: setFormulas,
  } = useApiData<Formula[]>(formulasUrl);
  const { data: products } = useApiData<Product[]>(
    unlocked ? "/api/products" : null,
  );
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Partial<Formula> | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const draftPanelRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/formula-admin", {
          cache: "no-store",
          credentials: "include",
        });
        const json = (await res.json()) as {
          unlocked?: boolean;
          name?: string;
          email?: string;
        };
        if (cancelled) return;
        if (json.unlocked) {
          setUnlocked(true);
          if (json.name) setAdminName(json.name);
          if (json.email) setAdminEmail(json.email);
        }
      } catch {
        /* stay locked */
      } finally {
        if (!cancelled) setAuthChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  async function unlockAdmin() {
    if (unlocking) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const res = await fetch("/api/auth/formula-admin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: adminEmail.trim(),
          password,
          name: adminName.trim() || adminEmail.trim() || "Admin",
        }),
      });
      const json = (await res.json()) as {
        error?: string;
        name?: string;
        email?: string;
      };
      if (!res.ok) {
        throw new Error(json.error || "Invalid admin email or password");
      }
      setPassword("");
      setUnlocked(true);
      if (json.name) setAdminName(json.name);
      if (json.email) setAdminEmail(json.email);
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : "Unlock failed");
    } finally {
      setUnlocking(false);
    }
  }

  async function lockAdmin() {
    setUnlocked(false);
    setFormulas(null);
    setSelectedId("");
    setDraft(null);
    try {
      await fetch("/api/auth/formula-admin", {
        method: "DELETE",
        credentials: "include",
      });
    } catch {
      /* cookie clear best-effort */
    }
  }

  const productList = products ?? [];
  const ethanolProduct = useMemo(
    () => productList.find((p) => matchRemixRole(p.name, p.sku) === "ethanol"),
    [productList],
  );
  const fixativeProduct = useMemo(
    () => productList.find((p) => matchRemixRole(p.name, p.sku) === "fixative"),
    [productList],
  );
  const labelProduct = useMemo(
    () => productList.find((p) => matchRemixRole(p.name, p.sku) === "label"),
    [productList],
  );
  const boxProduct = useMemo(
    () => productList.find((p) => matchRemixRole(p.name, p.sku) === "box"),
    [productList],
  );
  const bottleProduct = useMemo(
    () => productList.find((p) => matchRemixRole(p.name, p.sku) === "bottle"),
    [productList],
  );
  const capProduct = useMemo(
    () => productList.find((p) => matchRemixRole(p.name, p.sku) === "cap"),
    [productList],
  );
  const atomizerProduct = useMemo(
    () => productList.find((p) => matchRemixRole(p.name, p.sku) === "atomizer"),
    [productList],
  );
  const collarProduct = useMemo(
    () => productList.find((p) => matchRemixRole(p.name, p.sku) === "collar"),
    [productList],
  );
  const pouchProduct = useMemo(
    () => productList.find((p) => matchRemixRole(p.name, p.sku) === "pouch"),
    [productList],
  );

  const activeId = selectedId || formulas?.[0]?.id || "";
  const selected = formulas?.find((f) => f.id === activeId);
  const pendingCount =
    formulas?.filter((f) => f.status === "draft" || f.status === "rejected")
      .length ?? 0;
  const versionHistory = [...(selected?.versions || [])].reverse();
  const auditLog = [...(selected?.history || [])].reverse();

  const draftLiquid = sumLiquidMl(draft?.components || []);
  const draftYield = Number(draft?.yieldMl) || 0;

  function openDraft(next: Partial<Formula>) {
    setSaveError(null);
    setDraft(next);
    // Defer scroll/focus so the draft panel paints first (feels instant).
    requestAnimationFrame(() => {
      draftPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      nameInputRef.current?.focus();
    });
  }

  function duplicateFormula() {
    if (!selected) return;
    openDraft({
      name: `${selected.name} (Copy)`,
      type: selected.type,
      yieldMl: selected.yieldMl,
      notes: selected.notes,
      customerId: selected.customerId,
      customerName: selected.customerName,
      components: selected.components.map((c) => ({ ...c })),
      status: "draft",
    });
  }

  function pickProduct(index: number, productId: string) {
    if (!draft) return;
    if (productId === OIL_BASE_PRODUCT_ID) {
      updateComponent(index, {
        productId: OIL_BASE_PRODUCT_ID,
        productName: "Selected Oil Blend",
        qty: REMIX_OIL_ML,
        unit: "ml",
      });
      return;
    }
    const p = productList.find((x) => x.id === productId);
    updateComponent(index, {
      productId,
      productName: p?.name || "",
      unit: (p?.unit as StockUnit) || "ml",
    });
  }

  type QuickRole =
    | "oil"
    | Extract<
        RemixRole,
        "ethanol" | "fixative" | "label" | "box" | "bottle" | "cap" | "atomizer" | "collar" | "pouch"
      >;

  function hasRole(role: QuickRole) {
    const comps = draft?.components || [];
    if (role === "oil") {
      return comps.some((c) => c.productId === OIL_BASE_PRODUCT_ID);
    }
    return comps.some((c) => {
      const p = productList.find((x) => x.id === c.productId);
      return matchRemixRole(c.productName, p?.sku) === role;
    });
  }

  const packagingProductByRole = {
    ethanol: ethanolProduct,
    fixative: fixativeProduct,
    label: labelProduct,
    box: boxProduct,
    bottle: bottleProduct,
    cap: capProduct,
    atomizer: atomizerProduct,
    collar: collarProduct,
    pouch: pouchProduct,
  } as const;
  const packagingDefaultQty: Record<Exclude<QuickRole, "oil">, number> = {
    ethanol: 80,
    fixative: 2,
    label: 1,
    box: 1,
    bottle: 1,
    cap: 1,
    atomizer: 1,
    collar: 1,
    pouch: 1,
  };
  const packagingHints: Record<Exclude<QuickRole, "oil">, string> = {
    ethanol: "No ethanol product in inventory (name/SKU must match ETH- / Ethanol).",
    fixative: "No fixative product in inventory (name/SKU must match FIX- / Fixative).",
    label: "No label product in inventory (name/SKU must match LBL- / Label).",
    box: "No box product in inventory (name/SKU must match BOX- / GB- / Box).",
    bottle: "No bottle product in inventory (name/SKU must match BOT- / Bottle).",
    cap: "No cap product in inventory (name/SKU must match CAP- / Cap).",
    atomizer: "No atomizer product in inventory (name/SKU must match ATM- / Atomizer).",
    collar: "No collar product in inventory (name/SKU must match COL- / Collar).",
    pouch: "No pouch product in inventory (name/SKU must match PCH- / Pouch).",
  };

  function addQuick(role: QuickRole) {
    if (!draft) return;
    if (hasRole(role)) return;
    if (role === "oil") {
      setDraft({
        ...draft,
        components: [...(draft.components || []), oilBaseComponent()],
      });
      return;
    }
    const product = packagingProductByRole[role];
    if (!product) {
      setSaveError(packagingHints[role]);
      return;
    }
    setSaveError(null);
    setDraft({
      ...draft,
      components: [
        ...(draft.components || []),
        {
          productId: product.id,
          productName: product.name,
          qty: packagingDefaultQty[role],
          unit: (product.unit as StockUnit) || "ml",
        },
      ],
    });
  }

  /** BLD-02: fill every packaging role this draft is still missing, in one shot. */
  function addAllMissingPackaging() {
    if (!draft) return;
    const packagingRoles: Exclude<QuickRole, "oil">[] = [
      "bottle",
      "cap",
      "atomizer",
      "collar",
      "pouch",
      "label",
      "box",
      "ethanol",
      "fixative",
    ];
    const missing = packagingRoles.filter((role) => !hasRole(role));
    if (!missing.length) return;

    const added: FormulaComponent[] = [];
    const hints: string[] = [];
    for (const role of missing) {
      const product = packagingProductByRole[role];
      if (!product) {
        hints.push(packagingHints[role]);
        continue;
      }
      added.push({
        productId: product.id,
        productName: product.name,
        qty: packagingDefaultQty[role],
        unit: (product.unit as StockUnit) || "ml",
      });
    }
    setSaveError(hints[0] || null);
    if (added.length) {
      setDraft({ ...draft, components: [...(draft.components || []), ...added] });
    }
  }

  async function saveFormula() {
    if (!draft || busy) return;
    const components = (draft.components || []).filter(
      (c) => c.productId.trim() || c.productName.trim() || c.qty,
    );
    const errors = validateFormulaInput({
      name: draft.name,
      type: draft.type,
      yieldMl: draft.yieldMl,
      components,
    });
    if (errors.length) {
      setSaveError(errors[0]);
      return;
    }

    const payload = {
      name: draft.name,
      type: draft.type,
      yieldMl: draft.yieldMl,
      components,
      notes: draft.notes,
      customerId: draft.customerId,
      customerName: draft.customerName,
      status: "draft" as const,
    };

    // Optimistic close — editor dismisses immediately; server sync in background.
    const previous = draft.id
      ? (formulas ?? []).find((f) => f.id === draft.id)
      : undefined;
    const optimistic: Formula = {
      id: draft.id || `tmp-${Date.now()}`,
      name: payload.name || "Untitled",
      type: (payload.type as Formula["type"]) || "remix",
      status: "draft",
      version: previous ? (previous.version || 1) + 1 : 1,
      versions: previous?.versions || [],
      history: previous?.history || [],
      customerId: payload.customerId,
      customerName: payload.customerName,
      yieldMl: payload.yieldMl || 0,
      components,
      notes: payload.notes,
      updatedAt: new Date().toISOString().slice(0, 10),
    };

    setSaveError(null);
    setBusy(true);
    setFormulas((prev) => {
      const list = prev ?? [];
      if (draft.id) return list.map((f) => (f.id === draft.id ? optimistic : f));
      return [optimistic, ...list];
    });
    setSelectedId(optimistic.id);
    setDraft(null);

    try {
      const saved = await api<Formula>(
        draft.id ? `/api/formulas/${draft.id}` : "/api/formulas",
        {
          method: draft.id ? "PUT" : "POST",
          body: JSON.stringify(payload),
        },
      );
      setFormulas((prev) => {
        const list = prev ?? [];
        if (draft.id) return list.map((f) => (f.id === saved.id ? saved : f));
        return list.map((f) => (f.id === optimistic.id ? saved : f));
      });
      setSelectedId(saved.id);
    } catch (err) {
      if (previous) {
        setFormulas((prev) =>
          (prev ?? []).map((f) => (f.id === previous.id ? previous : f)),
        );
        setSelectedId(previous.id);
      } else {
        setFormulas((prev) =>
          (prev ?? []).filter((f) => f.id !== optimistic.id),
        );
      }
      setDraft({ ...draft, components });
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function removeFormula() {
    if (!selected) return;
    const previous = selected;
    const id = selected.id;
    const snapshot = formulas ?? [];
    // Optimistic — UI updates instantly; Atlas sync in background.
    setSaveError(null);
    setFormulas((prev) => (prev ?? []).filter((f) => f.id !== id));
    setSelectedId("");
    try {
      await api(`/api/formulas/${id}`, { method: "DELETE" });
    } catch (err) {
      setFormulas(snapshot);
      setSelectedId(previous.id);
      setSaveError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function setStatus(status: FormulaStatus) {
    if (!selected) return;
    const previous = selected;
    const now = new Date().toISOString().replace("T", " ").slice(0, 16);
    const optimistic: Formula = {
      ...selected,
      status,
      approvedAt:
        status === "approved"
          ? new Date().toISOString().slice(0, 10)
          : undefined,
      approvedBy: status === "approved" ? adminName : undefined,
      history: [
        ...(selected.history || []),
        {
          at: now,
          by: adminName,
          action: "status_changed",
          detail: `Status → ${status}`,
          fromStatus: selected.status,
          toStatus: status,
          fromVersion: selected.version || 1,
          toVersion: selected.version || 1,
        },
      ],
    };
    setSaveError(null);
    setFormulas((prev) =>
      (prev ?? []).map((f) => (f.id === optimistic.id ? optimistic : f)),
    );
    try {
      const updated = await api<Formula>(`/api/formulas/${selected.id}`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      setFormulas((prev) =>
        (prev ?? []).map((f) => (f.id === updated.id ? updated : f)),
      );
    } catch (err) {
      setFormulas((prev) =>
        (prev ?? []).map((f) => (f.id === previous.id ? previous : f)),
      );
      setSaveError(
        err instanceof Error ? err.message : "Failed to update status",
      );
    }
  }

  async function restoreVersion(version: number) {
    if (!selected || busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      const updated = await api<Formula>(`/api/formulas/${selected.id}`, {
        method: "PUT",
        body: JSON.stringify({ restoreVersion: version }),
      });
      setFormulas((prev) =>
        (prev ?? []).map((f) => (f.id === updated.id ? updated : f)),
      );
      setShowHistory(true);
      setShowAudit(true);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to restore version",
      );
    } finally {
      setBusy(false);
    }
  }

  /** BLD-04 print — build from in-memory recipe (no Atlas round-trip). */
  function printRecipe() {
    if (!selected) return;
    setSaveError(null);
    void printHtmlDocument(buildRecipeHtml(selected)).catch((err) => {
      setSaveError(err instanceof Error ? err.message : "Print failed");
    });
  }

  /** BLD-04 export — download HTML + print dialog (Save as PDF). */
  function exportRecipe() {
    if (!selected) return;
    setSaveError(null);
    try {
      const html = buildRecipeHtml(selected);
      const safeName = (selected.name || "formula")
        .replace(/[^\w\-]+/g, "_")
        .slice(0, 60);
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}.html`;
      a.click();
      URL.revokeObjectURL(url);
      void printHtmlDocument(html).catch((err) => {
        setSaveError(err instanceof Error ? err.message : "Export failed");
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Export failed");
    }
  }

  function updateComponent(index: number, patch: Partial<FormulaComponent>) {
    if (!draft) return;
    const components = [...(draft.components || [])];
    components[index] = { ...components[index], ...patch };
    setDraft({ ...draft, components });
  }

  if (authChecking) return <LoadingState label="Checking admin access…" />;

  if (unlocked && loading && !formulas) {
    return <LoadingState label="Loading formulas…" />;
  }
  if (unlocked && (error || !formulas)) {
    return (
      <ErrorState
        message={error || "Failed to load formulas"}
        onRetry={() => void reload({ silent: true })}
      />
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Manufacturing"
        title="Formulas & BOM Engine"
        description="Dynamic bill of materials for remix, pure oil, and bakhoor (BLD-02), plus saved customer formulas. Only Admin may view, create, edit, approve, print, or export recipes."
        actions={
          unlocked ? (
            <div className="flex flex-wrap items-center gap-2">
              {pendingCount > 0 ? (
                <Badge tone="warning">{pendingCount} awaiting approval</Badge>
              ) : null}
              <Badge tone="success">
                <Eye className="h-3 w-3" />
                {adminName} · access granted
              </Badge>
            </div>
          ) : null
        }
      />

      {!unlocked ? (
        <Panel className="mx-auto max-w-lg text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-mist">
            <Lock className="h-6 w-6 text-ink-muted" />
          </div>
          <h2 className="mt-4 font-semibold text-2xl text-ink">Restricted Module</h2>
          <p className="mt-2 text-sm text-ink-muted">
            Only Admin can view, create, edit, approve, print, or export perfume
            formulas. Sales staff can sell remix without seeing component ratios.
            Server enforces this — UI unlock alone is not enough.
          </p>
          <div className="mx-auto mt-6 max-w-xs space-y-3 text-left">
            <label className="block text-xs font-medium text-ink-muted">
              Admin email
              <input
                type="email"
                className="mt-1 w-full rounded-[var(--radius)] border border-line bg-white px-3 py-2 text-sm"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="admin@example.com"
                autoComplete="username"
              />
            </label>
            <label className="block text-xs font-medium text-ink-muted">
              Admin password
              <input
                type="password"
                className="mt-1 w-full rounded-[var(--radius)] border border-line bg-white px-3 py-2 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void unlockAdmin();
                }}
                autoComplete="current-password"
              />
            </label>
            {unlockError ? (
              <p className="text-xs text-coral">{unlockError}</p>
            ) : (
              <p className="text-[11px] text-ink-muted">
                Credentials from .env — ADMIN_EMAIL + ADMIN_PASSWORD
              </p>
            )}
            <Button
              className="w-full"
              variant="gold"
              disabled={unlocking || !password || !adminEmail.trim()}
              onClick={() => void unlockAdmin()}
            >
              <Shield className="h-4 w-4" />
              {unlocking ? "Unlocking…" : "Admin Unlock"}
            </Button>
          </div>
        </Panel>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <Panel padding={false}>
            <div className="border-b border-line/70 px-4 py-3">
              <p className="text-sm font-medium">Formula Library</p>
              <label className="relative mt-2 block">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, customer, type…"
                  className="h-9 w-full rounded-lg border border-line bg-mist pl-8 pr-3 text-sm outline-none focus:border-gold/50"
                />
              </label>
            </div>
            <ul className="p-2">
              {(formulas ?? []).length === 0 ? (
                <li className="px-3 py-6 text-center text-xs text-ink-muted">
                  {query ? `No formulas match “${query}”.` : "No formulas yet."}
                </li>
              ) : (
                (formulas ?? []).map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(f.id);
                        setShowHistory(false);
                        setShowAudit(false);
                      }}
                      className={`w-full rounded-lg px-3 py-2.5 text-left transition ${
                        activeId === f.id ? "bg-ink text-canvas" : "hover:bg-mist"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium">{f.name}</p>
                        <Badge
                          tone={activeId === f.id ? "gold" : statusTone(f.status)}
                          className="shrink-0"
                        >
                          {f.status}
                        </Badge>
                      </div>
                      <p
                        className={`mt-0.5 text-[11px] ${
                          activeId === f.id ? "text-gold-soft" : "text-ink-muted"
                        }`}
                      >
                        {f.type} · {f.yieldMl} ml · v{f.version || 1}
                      </p>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </Panel>

          {selected ? (
            <Panel>
              <PanelHeader
                title={selected.name}
                subtitle={
                  selected.customerName
                    ? `Customer formula · ${selected.customerName}`
                    : selected.notes || "Internal formula"
                }
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={statusTone(selected.status)}>{selected.status}</Badge>
                    <Badge tone="info">v{selected.version || 1}</Badge>
                    <Badge
                      tone={
                        selected.type === "remix"
                          ? "gold"
                          : selected.type === "oil"
                            ? "info"
                            : "success"
                      }
                    >
                      {selected.type}
                    </Badge>
                  </div>
                }
              />

              {selected.status === "archived" ? (
                <div className="mb-4 rounded-lg border border-line bg-mist/50 px-4 py-3 text-sm text-ink-muted">
                  This recipe is <strong>archived</strong>. Unarchive to draft before
                  approving for production.
                </div>
              ) : null}

              {selected.status !== "approved" && selected.status !== "archived" ? (
                <div className="mb-4 rounded-lg border border-amber/30 bg-amber/10 px-4 py-3 text-sm text-amber">
                  This recipe is <strong>{selected.status}</strong>. Admin must approve
                  before it is used for production or remix sales. Materials reservation
                  stays off until approved (BLD-12).
                </div>
              ) : null}

              {selected.status === "approved" &&
              selected.materialsReservation?.active ? (
                <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-ink">
                  Materials reservation <strong>active</strong> (BLD-12) ·{" "}
                  {selected.materialsReservation.lines.length} component line
                  {selected.materialsReservation.lines.length === 1 ? "" : "s"}
                  {selected.materialsReservation.reservedAt
                    ? ` · since ${selected.materialsReservation.reservedAt}`
                    : ""}
                  . Reject/archive clears reservation.
                </div>
              ) : null}

              {selected.type === "remix" ? (
                <div className="mb-4 rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-gold-deep">
                  Every Remix sale deducts a fixed {REMIX_OIL_ML} ml of selected oil
                  (BLD-02/03 — not tola) plus ethanol and packaging from the approved BOM.
                </div>
              ) : null}

              {selected.type === "oil" ? (
                <div className="mb-4 rounded-lg border border-line bg-mist/50 px-4 py-3 text-sm text-ink-muted">
                  Pure Oil BOM (BLD-02): oil by tola/ml plus bottle and cap packaging.
                </div>
              ) : null}

              {selected.type === "bakhoor" ? (
                <div className="mb-4 rounded-lg border border-line bg-mist/50 px-4 py-3 text-sm text-ink-muted">
                  Bakhoor BOM (BLD-02): bakhoor weight plus packaging bottle and pouch.
                </div>
              ) : null}

              <div className="overflow-hidden rounded-[var(--radius-sm)] border border-line">
                <table className="w-full text-left text-sm">
                  <thead className="bg-mist/70 text-[11px] uppercase tracking-wider text-ink-muted">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">#</th>
                      <th className="px-4 py-2.5 font-medium">Component</th>
                      <th className="px-4 py-2.5 font-medium">Qty</th>
                      <th className="px-4 py-2.5 font-medium">Unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.components.map((c, i) => (
                      <tr key={`${c.productId}-${i}`} className="border-t border-line/60">
                        <td className="px-4 py-3 text-ink-muted">{i + 1}</td>
                        <td className="px-4 py-3 font-medium">{c.productName}</td>
                        <td className="px-4 py-3">{c.qty}</td>
                        <td className="px-4 py-3">{c.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-5">
                <Meta label="Yield" value={formatQty(selected.yieldMl, "ml")} />
                <Meta
                  label="Liquid total"
                  value={formatQty(sumLiquidMl(selected.components), "ml")}
                />
                <Meta label="Version" value={`v${selected.version || 1}`} />
                <Meta label="Updated" value={selected.updatedAt} />
                <Meta
                  label="Approved"
                  value={
                    selected.status === "approved"
                      ? `${selected.approvedBy || "Admin"}${selected.approvedAt ? ` · ${selected.approvedAt}` : ""}`
                      : "—"
                  }
                />
              </div>

              {versionHistory.length > 0 ? (
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => setShowHistory((v) => !v)}
                    className="flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink"
                  >
                    <History className="h-3.5 w-3.5" />
                    Version history ({versionHistory.length})
                    <span>{showHistory ? "· hide" : "· show"}</span>
                  </button>
                  {showHistory ? (
                    <ul className="mt-2 space-y-2">
                      {versionHistory.map((v) => (
                        <li
                          key={v.version}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 bg-mist/30 px-3 py-2 text-sm"
                        >
                          <div>
                            <p className="font-medium">
                              v{v.version}{" "}
                              <span className="font-normal text-ink-muted">
                                · {v.status} · {v.components.length} components ·{" "}
                                {v.yieldMl} ml
                              </span>
                            </p>
                            <p className="text-[11px] text-ink-muted">
                              Saved {v.savedAt}
                              {v.savedBy ? ` · ${v.savedBy}` : ""}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void restoreVersion(v.version)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Restore
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {auditLog.length > 0 ? (
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => setShowAudit((v) => !v)}
                    className="flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink"
                  >
                    <History className="h-3.5 w-3.5" />
                    Audit log ({auditLog.length})
                    <span>{showAudit ? "· hide" : "· show"}</span>
                  </button>
                  {showAudit ? (
                    <ul className="mt-2 max-h-48 space-y-1.5 overflow-y-auto">
                      {auditLog.map((h, i) => (
                        <li
                          key={`${h.at}-${i}`}
                          className="rounded-lg border border-line/60 bg-mist/20 px-3 py-2 text-xs"
                        >
                          <p className="font-medium text-ink">
                            {h.action.replace("_", " ")}
                            {h.detail ? (
                              <span className="font-normal text-ink-muted">
                                {" "}
                                — {h.detail}
                              </span>
                            ) : null}
                          </p>
                          <p className="mt-0.5 text-ink-muted">
                            {h.at}
                            {h.by ? ` · ${h.by}` : ""}
                            {h.fromStatus && h.toStatus
                              ? ` · ${h.fromStatus} → ${h.toStatus}`
                              : ""}
                            {h.fromVersion != null &&
                            h.toVersion != null &&
                            h.fromVersion !== h.toVersion
                              ? ` · v${h.fromVersion} → v${h.toVersion}`
                              : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {saveError && !draft ? (
                <div className="mt-4 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                  {saveError}
                </div>
              ) : null}

              <div className="mt-5 flex flex-wrap gap-2">
                {selected.status !== "approved" && selected.status !== "archived" ? (
                  <Button
                    size="sm"
                    variant="gold"
                    onClick={() => void setStatus("approved")}
                  >
                    <Check className="h-3.5 w-3.5" />
                    Approve Formula
                  </Button>
                ) : null}
                {selected.status === "draft" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void setStatus("rejected")}
                  >
                    <X className="h-3.5 w-3.5" />
                    Reject
                  </Button>
                ) : null}
                {selected.status === "approved" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void setStatus("draft")}
                  >
                    Revoke Approval
                  </Button>
                ) : null}
                {selected.status === "rejected" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void setStatus("draft")}
                  >
                    Back to Draft
                  </Button>
                ) : null}
                {selected.status !== "archived" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void setStatus("archived")}
                  >
                    <Archive className="h-3.5 w-3.5" />
                    Archive
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void setStatus("draft")}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Unarchive
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={selected.status === "archived"}
                  onClick={() =>
                    openDraft({
                      ...selected,
                      components: selected.components.map((c) => ({ ...c })),
                    })
                  }
                >
                  Edit Formula
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    openDraft({
                      type: "remix",
                      yieldMl: 100,
                      components: [emptyComponent()],
                      status: "draft",
                    })
                  }
                >
                  New Formula
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void removeFormula()}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => printRecipe()}
                >
                  <Printer className="h-3.5 w-3.5" /> Print
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => exportRecipe()}
                >
                  <FileDown className="h-3.5 w-3.5" /> Export PDF
                </Button>
                <Button size="sm" variant="secondary" onClick={duplicateFormula}>
                  Duplicate
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void lockAdmin()}>
                  Lock Again
                </Button>
              </div>
            </Panel>
          ) : (
            <Panel>
              <p className="text-sm text-ink-muted">No formulas yet. Create one to begin.</p>
              <Button
                className="mt-3"
                onClick={() =>
                  openDraft({
                    type: "remix",
                    yieldMl: 100,
                    components: [emptyComponent()],
                    status: "draft",
                  })
                }
              >
                New Formula
              </Button>
            </Panel>
          )}
        </div>
      )}

      {draft ? (
        <div ref={draftPanelRef} className="mt-5 scroll-mt-6">
          <Panel>
            <PanelHeader
              title={draft.id ? "Edit Formula" : "New Formula"}
              subtitle={
                draft.id
                  ? `Editing v${draft.version || 1} — save creates v${(draft.version || 1) + 1} as draft.`
                  : "Saved as draft — Admin must approve before production use."
              }
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                label="Name"
                value={draft.name || ""}
                inputRef={nameInputRef}
                onChange={(name) => setDraft({ ...draft, name })}
              />
              <label className="text-xs text-ink-muted">
                Type
                <select
                  value={draft.type || "remix"}
                  onChange={(e) =>
                    setDraft({ ...draft, type: e.target.value as Formula["type"] })
                  }
                  className="mt-1 h-9 w-full rounded border border-line bg-mist px-2"
                >
                  <option value="remix">remix</option>
                  <option value="oil">oil</option>
                  <option value="bakhoor">bakhoor</option>
                </select>
              </label>
              <Input
                label="Yield ml"
                type="number"
                value={String(draft.yieldMl || "")}
                onChange={(value) =>
                  setDraft({ ...draft, yieldMl: Number(value) || 0 })
                }
              />
            </div>

            <div className="mt-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-muted">BOM ingredients</p>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={hasRole("oil")}
                    onClick={() => addQuick("oil")}
                  >
                    + Oil
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={hasRole("ethanol") || !ethanolProduct}
                    onClick={() => addQuick("ethanol")}
                  >
                    + Ethanol
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={hasRole("fixative") || !fixativeProduct}
                    onClick={() => addQuick("fixative")}
                  >
                    + Fixative
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={hasRole("label") || !labelProduct}
                    onClick={() => addQuick("label")}
                  >
                    + Label
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={hasRole("box") || !boxProduct}
                    onClick={() => addQuick("box")}
                  >
                    + Box
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={hasRole("bottle") || !bottleProduct}
                    onClick={() => addQuick("bottle")}
                  >
                    + Bottle
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={hasRole("cap") || !capProduct}
                    onClick={() => addQuick("cap")}
                  >
                    + Cap
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={hasRole("atomizer") || !atomizerProduct}
                    onClick={() => addQuick("atomizer")}
                  >
                    + Atomizer
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={hasRole("collar") || !collarProduct}
                    onClick={() => addQuick("collar")}
                  >
                    + Collar
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={hasRole("pouch") || !pouchProduct}
                    onClick={() => addQuick("pouch")}
                  >
                    + Pouch
                  </Button>
                  <Button
                    size="sm"
                    variant="gold"
                    onClick={addAllMissingPackaging}
                    title="BLD-02: fill every missing packaging role (bottle/cap/atomizer/collar/label/box/ethanol/fixative) at once"
                  >
                    + Fill missing packaging
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        components: [...(draft.components || []), emptyComponent()],
                      })
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add row
                  </Button>
                </div>
              </div>

              <p
                className={`mb-2 text-xs ${
                  draftYield > 0 && Math.abs(draftLiquid - draftYield) > 0.001
                    ? "text-coral"
                    : "text-ink-muted"
                }`}
              >
                Liquid total {draftLiquid} ml / yield {draftYield || "—"} ml
                {draftYield > 0 && Math.abs(draftLiquid - draftYield) <= 0.001
                  ? " · matched"
                  : " · must match to save (pcs ignored)"}
              </p>

              <div className="space-y-2">
                {(draft.components || []).map((c, index) => (
                  <div
                    key={index}
                    className="grid gap-2 rounded-lg border border-line/70 bg-mist/30 p-2 sm:grid-cols-[1.6fr_0.7fr_0.7fr_auto]"
                  >
                    <select
                      value={c.productId}
                      onChange={(e) => pickProduct(index, e.target.value)}
                      className="h-9 rounded border border-line bg-paper px-2 text-sm"
                    >
                      <option value="">Select product…</option>
                      <option value={OIL_BASE_PRODUCT_ID}>
                        oil-base — Selected Oil Blend (POS picks oil)
                      </option>
                      {c.productId &&
                      c.productId !== OIL_BASE_PRODUCT_ID &&
                      !productList.some((p) => p.id === c.productId) ? (
                        <option value={c.productId}>
                          {c.productName || c.productId}
                        </option>
                      ) : null}
                      {productList.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} — {p.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      placeholder="Qty"
                      value={Number.isFinite(c.qty) && c.qty !== 0 ? String(c.qty) : c.qty === 0 ? "0" : ""}
                      onChange={(e) =>
                        updateComponent(index, {
                          qty: e.target.value === "" ? 0 : Number(e.target.value),
                        })
                      }
                      className="h-9 rounded border border-line bg-paper px-2 text-sm"
                    />
                    <select
                      value={c.unit}
                      onChange={(e) =>
                        updateComponent(index, {
                          unit: e.target.value as StockUnit,
                        })
                      }
                      className="h-9 rounded border border-line bg-paper px-2 text-sm"
                    >
                      {UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          components: (draft.components || []).filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                {(draft.components || []).length === 0 ? (
                  <p className="text-xs text-ink-muted">
                    No ingredients yet. Use + Oil / Ethanol / Fixative or Add row.
                  </p>
                ) : null}
              </div>
            </div>

            {saveError ? (
              <p className="mt-3 rounded-lg border border-coral/30 bg-coral-soft px-3 py-2 text-sm text-coral">
                {saveError}
              </p>
            ) : null}

            <div className="mt-3 flex gap-2">
              <Button disabled={busy} onClick={() => void saveFormula()}>
                Save as Draft
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setDraft(null);
                  setSaveError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <input
        ref={inputRef}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-9 w-full rounded border border-line bg-mist px-2 text-sm"
      />
    </label>
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
