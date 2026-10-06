"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { roundMoney } from "@/lib/money";
import {
  Banknote,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  FileClock,
  FileText,
  FlaskConical,
  History,
  Landmark,
  Mail,
  Pause,
  Play,
  Printer,
  Search,
  Shuffle,
  Smartphone,
  Trash2,
  MessageCircle,
  Plus,
  Minus,
  Package,
  Tag,
  X,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { ErrorState, LoadingState, useApiData } from "@/components/ui/DataState";
import { api } from "@/lib/api";
import { formatMoney, tolaToMl } from "@/lib/format";
import { buildWhatsAppUrl } from "@/lib/notifications/whatsapp";
import { buildReceiptDoc, formatPaymentLabel } from "@/lib/receipt/document";
import {
  fetchReceiptHtml,
  printHtmlDocument,
  printSaleReceipt,
} from "@/lib/receipt/print";
import { receiptText } from "@/lib/receipt/text";
import { renderReceiptHtml } from "@/lib/receipt/template";
import type { ReceiptFormat, ReceiptLine } from "@/lib/receipt/types";
import { OIL_BASE_PRODUCT_ID, matchRemixRole } from "@/lib/sales/constants";
import {
  checkoutFailureMessage,
  classifyCheckoutError,
  keepCheckoutKey,
} from "@/lib/sales/checkoutRecovery";
import { resolveSearchPick } from "@/lib/sales/posSearch";
import {
  clampDiscount,
  computeDiscounts,
  discountAmount,
  discountLimitFor,
  exceedsDiscountLimit,
  parseDiscount,
  type DiscountInput,
  type DiscountType,
} from "@/lib/sales/discount";
import type {
  AppSettings,
  Customer,
  Formula,
  PaymentMethod,
  PaymentSplit,
  Product,
  Quotation,
} from "@/lib/types";

type CatalogFilter = "all" | "ready" | "oil" | "custom";

const CATALOG_FILTERS: { id: CatalogFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "oil", label: "Oils" },
  { id: "custom", label: "Remix" },
];

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

/** Money in the cart / mixed split — 3 decimals (OMR baisa), same as the server. */
function round2(n: number) {
  return roundMoney(n);
}

type CartLineType = "ready" | "remix" | "oil" | "refill" | "packaging";

type HeldSaleLine = {
  productId?: string;
  name: string;
  qty: number;
  unitLabel: string;
  unitPrice: number;
  lineType: CartLineType;
  bomNote?: string;
  deductMl?: number;
  oilProductId?: string;
  formulaId?: string;
  discountType?: DiscountType;
  discountValue?: number;
};

type HeldSale = {
  id: string;
  customerPhone: string;
  customerName?: string;
  salesperson: string;
  payment: string;
  paymentBreakdown?: PaymentSplit[];
  status: string;
  total: number;
  invoiceDiscountType?: DiscountType;
  invoiceDiscountValue?: number;
  saleType?: string;
  lines: HeldSaleLine[];
  time?: string;
  createdAt?: string;
};

type SendChannel = "email" | "whatsapp" | "sms";

type LastSale = {
  id: string;
  total: number;
  discountTotal: number;
  customerName: string;
  phone: string;
  email: string;
  payment: string;
  paymentBreakdown?: PaymentSplit[];
  salesperson: string;
  lines: ReceiptLine[];
};

type PackagingGroup =
  | "bottle"
  | "cap"
  | "atomizer"
  | "collar"
  | "label"
  | "box"
  | "pouch"
  | "other";

const PACKAGING_GROUPS: {
  id: PackagingGroup;
  label: string;
}[] = [
  { id: "bottle", label: "Bottles" },
  { id: "cap", label: "Caps" },
  { id: "atomizer", label: "Atomizers" },
  { id: "collar", label: "Collars" },
  { id: "label", label: "Labels" },
  { id: "box", label: "Boxes" },
  { id: "pouch", label: "Pouches" },
  { id: "other", label: "Other" },
];

/** Remix is made to order from its BOM (checkout checks the components) — its own count never blocks a sale. */
function isOutOfStock(p: Product): boolean {
  return p.category !== "Remix" && p.stockSellable <= 0;
}

function packagingGroupOf(product: Product): PackagingGroup {
  const role = matchRemixRole(product.name, product.sku);
  if (
    role === "bottle" ||
    role === "cap" ||
    role === "atomizer" ||
    role === "collar" ||
    role === "label" ||
    role === "box"
  ) {
    return role;
  }
  if (/\bpouch\b/i.test(product.name) || /^PCH-/i.test(product.sku)) {
    return "pouch";
  }
  return "other";
}

type CartLine = {
  key: string;
  product: Product;
  qty: number;
  unitLabel: string;
  unitPrice: number;
  lineType: CartLineType;
  deductMl?: number;
  bomNote?: string;
  oilProductId?: string;
  oilProductName?: string;
  formulaId?: string;
  formulaName?: string;
  /** POS-069: item-level discount (applied to qty × unitPrice). */
  discount?: DiscountInput;
};

function discountFromStored(
  type: DiscountType | undefined,
  value: number | undefined,
): DiscountInput | undefined {
  return (type === "percent" || type === "amount") && Number(value) > 0
    ? { type, value: Number(value) }
    : undefined;
}

function discountLabel(d: DiscountInput): string {
  return d.type === "percent" ? `${d.value}%` : formatMoney(d.value);
}

/** Inline editor for a line or bill discount — rejects bad input before it reaches the cart (POS-075). */
function DiscountEditor({
  initial,
  base,
  onApply,
  onCancel,
}: {
  initial?: DiscountInput | null;
  base: number;
  onApply: (d: DiscountInput | null) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<DiscountType>(initial?.type ?? "percent");
  const [value, setValue] = useState(initial ? String(initial.value) : "");
  const [error, setError] = useState<string | null>(null);

  function apply() {
    if (value.trim() === "") {
      setError("Enter a discount");
      return;
    }
    try {
      onApply(parseDiscount({ type, value }, base, "Discount"));
    } catch (err) {
      setError(
        err instanceof Error ? err.message.replace(/^Discount: /, "") : "Invalid discount",
      );
    }
  }

  return (
    <div className="mt-1.5 rounded-lg border border-line bg-canvas p-2">
      <div className="flex items-center gap-1.5">
        <div className="flex shrink-0 overflow-hidden rounded-md border border-line text-[11px] font-semibold">
          {(["percent", "amount"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setType(t);
                setError(null);
              }}
              className={`px-2 py-1 ${type === t ? "bg-ink text-canvas" : "bg-mist text-ink-muted"}`}
            >
              {t === "percent" ? "%" : "OMR"}
            </button>
          ))}
        </div>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={type === "percent" ? 100 : undefined}
          step="any"
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              onCancel();
            }
          }}
          aria-label="Discount value"
          aria-invalid={error ? true : undefined}
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-paper px-2 text-sm tabular-nums"
        />
        <Button size="sm" className="h-7 px-2.5" onClick={apply}>
          Apply
        </Button>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="shrink-0 text-ink-muted hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {error ? <p className="mt-1 text-[11px] text-coral">{error}</p> : null}
    </div>
  );
}

/** Sellable stock of a product the cart already claims (units, or ml for oil/refill) — mirrors applyLocalStockDeduction. */
function stockClaimed(cart: CartLine[], productId: string): number {
  let used = 0;
  for (const l of cart) {
    if (l.product.id !== productId) continue;
    if (l.lineType === "ready" || l.lineType === "packaging") used += l.qty;
    else if ((l.lineType === "oil" || l.lineType === "refill") && l.deductMl) {
      used += l.deductMl * l.qty;
    }
  }
  return used;
}

const emptyProducts: Product[] = [];
const emptyFormulas: Formula[] = [];

const payments: { id: PaymentMethod; label: string; icon: React.ReactNode }[] = [
  { id: "cash", label: "Cash", icon: <Banknote className="h-4 w-4" /> },
  { id: "card", label: "Card", icon: <CreditCard className="h-4 w-4" /> },
  { id: "bank", label: "Bank", icon: <Landmark className="h-4 w-4" /> },
  { id: "credit", label: "Credit", icon: <FileClock className="h-4 w-4" /> },
  { id: "mixed", label: "Mixed", icon: <Shuffle className="h-4 w-4" /> },
];

/** The methods a "Mixed" bill can be split across — every payment button except Mixed itself. */
const MIXED_METHODS: { id: PaymentSplit["method"]; label: string; icon: React.ReactNode }[] = [
  { id: "cash", label: "Cash", icon: <Banknote className="h-4 w-4" /> },
  { id: "card", label: "Card", icon: <CreditCard className="h-4 w-4" /> },
  { id: "bank", label: "Bank", icon: <Landmark className="h-4 w-4" /> },
  { id: "credit", label: "Credit", icon: <FileClock className="h-4 w-4" /> },
];

const emptyMixedAmounts: Record<PaymentSplit["method"], string> = {
  cash: "",
  card: "",
  bank: "",
  credit: "",
};

const emptyHeld: HeldSale[] = [];

function normalizePayment(value: string | undefined): PaymentMethod {
  const raw = (value || "cash").toLowerCase();
  if (
    raw === "cash" ||
    raw === "card" ||
    raw === "bank" ||
    raw === "credit" ||
    raw === "mixed"
  ) {
    return raw;
  }
  return "cash";
}

const TILL_SALESPERSON_KEY = "unich.pos.salesperson";
/** Held bills loaded for the menu; older ones are reached through search. */
const HELD_LIST_LIMIT = 200;

function readTillSalesperson(): string {
  try {
    return window.localStorage.getItem(TILL_SALESPERSON_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeTillSalesperson(name: string) {
  try {
    window.localStorage.setItem(TILL_SALESPERSON_KEY, name);
  } catch {
    // private mode / storage blocked — the choice still holds for this session
  }
}

function createIdempotencyKey() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `sale-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function PosPage() {
  return (
    <Suspense fallback={null}>
      <PosPageInner />
    </Suspense>
  );
}

function PosPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    data: products,
    loading,
    error,
    reload,
    setData: setProducts,
  } = useApiData<Product[]>("/api/products");
  const settings = useApiData<AppSettings>("/api/settings");
  const {
    data: heldBills,
    reload: reloadHeld,
    setData: setHeldBills,
  } = useApiData<HeldSale[]>(`/api/sales?status=held&limit=${HELD_LIST_LIMIT}`);
  /** POS-099: search all held bills (name / phone) — not only the loaded ones. */
  const [heldSearch, setHeldSearch] = useState("");
  const [heldQuery, setHeldQuery] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setHeldQuery(heldSearch.trim()), 300);
    return () => window.clearTimeout(t);
  }, [heldSearch]);
  const { data: heldMatches, loading: heldSearching } = useApiData<HeldSale[]>(
    heldQuery
      ? `/api/sales?status=held&limit=50&q=${encodeURIComponent(heldQuery)}`
      : null,
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const phoneLookupSeq = useRef(0);
  const [query, setQuery] = useState("");
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>("all");
  const [toolStrip, setToolStrip] = useState<"packaging" | "quick">("quick");
  const [cart, setCart] = useState<CartLine[]>([]);
  /** POS-070: bill-level discount, applied after line discounts. */
  const [invoiceDiscount, setInvoiceDiscount] = useState<DiscountInput | null>(null);
  /** Which discount editor is open: a cart line key, or "invoice". */
  const [discountEditor, setDiscountEditor] = useState<string | null>(null);
  /**
   * POS-071: manager approval prompt for an over-limit discount.
   * `floorMessage`: POS-062 — the server found a line below its minimum price,
   * which only the Admin can approve.
   */
  const [approval, setApproval] = useState<{
    email: string;
    password: string;
    error: string | null;
    floorMessage?: string;
  } | null>(null);
  const [approvingDiscount, setApprovingDiscount] = useState(false);
  const { user, hasPermission } = useAuth();
  const discountLimit = discountLimitFor(user?.role);
  const [payment, setPayment] = useState<PaymentMethod>("cash");
  const [mixedOpen, setMixedOpen] = useState(false);
  const [mixedAmounts, setMixedAmounts] = useState(emptyMixedAmounts);
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [customerMatch, setCustomerMatch] = useState<string | null>(null);
  const [matchedCustomerId, setMatchedCustomerId] = useState<string | null>(
    null,
  );
  // QTN-06: "Convert" on an approved quotation lands here with ?fromQuotation=<id> —
  // the bill pre-fills from the quotation instead of the cart, and Complete Sale
  // runs the real checkout (stock deduction included) via the quotation itself.
  const fromQuotationId = searchParams.get("fromQuotation");
  const [quotationMode, setQuotationMode] = useState<Quotation | null>(null);
  const [quotationLoadError, setQuotationLoadError] = useState<string | null>(null);
  const [completingQuotation, setCompletingQuotation] = useState(false);
  useEffect(() => {
    if (!fromQuotationId) return;
    let cancelled = false;
    api<Quotation>(`/api/quotations/${fromQuotationId}`)
      .then((q) => {
        if (cancelled) return;
        if (q.status !== "approved") {
          setQuotationLoadError(`Quotation ${q.number} is not approved (status: ${q.status}).`);
          return;
        }
        if (q.convertedToSaleId) {
          setQuotationLoadError(`Quotation ${q.number} was already converted.`);
          return;
        }
        setQuotationMode(q);
        setCustomerName(q.customerName);
        setPhone(q.customerPhone);
        setEmail(q.customerEmail || "");
        setPayment("credit");
      })
      .catch((err) => {
        if (!cancelled) {
          setQuotationLoadError(
            err instanceof Error ? err.message : "Could not load quotation",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fromQuotationId]);

  function exitQuotationMode() {
    setQuotationMode(null);
    setQuotationLoadError(null);
    setCustomerName("");
    setPhone("");
    setEmail("");
    router.replace("/pos");
  }

  /**
   * QTN-06: convert the approved quotation. A price below the minimum needs
   * the Admin (POS-062) — the server answers 403 and the Admin approval dialog
   * resubmits with their credentials (the quotation converts once, so they
   * can't be replayed against another sale).
   */
  async function completeQuotationSale(admin?: { email: string; password: string }) {
    if (!quotationMode) return;
    setCompletingQuotation(true);
    try {
      const res = await api<{
        quotation: Quotation;
        sale: { id: string; customerId?: string; total?: number };
      }>(`/api/quotations/${quotationMode.id}`, {
        method: "POST",
        body: JSON.stringify({
          action: "convert",
          payment,
          paymentBreakdown: payment === "mixed" ? mixedBreakdown : undefined,
          salesperson,
          ...(admin ? { approverEmail: admin.email, approverPassword: admin.password } : {}),
        }),
      });
      setApproval(null);
      flash(
        `Sale completed · ${formatMoney(res.sale.total ?? quotationMode.total)} · ${payment}`,
      );
      if (printAfterComplete) {
        void printSaleReceipt(res.sale.id, defaultFormat, { reprint: false }).catch(() => {});
      }
      const customerId = res.sale.customerId;
      setQuotationMode(null);
      setCustomerName("");
      setPhone("");
      setEmail("");
      router.push(customerId ? `/customers/${customerId}` : "/customers");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not complete sale";
      const code = (err as { data?: { code?: string } }).data?.code;
      if (code === "PRICE_FLOOR_APPROVAL_REQUIRED" || (admin && code === "DISCOUNT_NOT_AUTHORIZED")) {
        setApproval((prev) => ({
          email: admin?.email ?? prev?.email ?? "",
          password: "",
          error: admin ? message : null,
          floorMessage: prev?.floorMessage ?? message,
        }));
      } else {
        flash(message, 6000, "err");
      }
    } finally {
      setCompletingQuotation(false);
    }
  }

  const { data: customerFormulas, loading: formulasLoading } = useApiData<
    Formula[]
  >(
    matchedCustomerId
      ? `/api/formulas?customerId=${matchedCustomerId}&status=approved`
      : null,
  );
  const pastOrdersPhone =
    digitsOnly(phone).length >= 7 ? phone.trim() : "";
  const { data: pastOrders, loading: pastOrdersLoading } = useApiData<
    HeldSale[]
  >(
    pastOrdersPhone
      ? `/api/sales?status=completed&phone=${encodeURIComponent(pastOrdersPhone)}&limit=3`
      : null,
  );
  const [toast, setToast] = useState<string | null>(null);
  const [toastTone, setToastTone] = useState<"ok" | "err">("ok");
  const [checkingOut, setCheckingOut] = useState(false);
  const [holding, setHolding] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  /**
   * POS-093/094: this till's salesperson — sent with each bill, never written
   * to the store-wide settings, so one till's choice can't change another's.
   */
  const [selectedSalesperson, setSelectedSalesperson] = useState("");
  /**
   * POS-098: the held bill this cart was resumed from. It stays held on the
   * server until checkout closes it (atomically) or a re-hold updates it, so a
   * failed or abandoned checkout never loses the bill.
   */
  const [resumedFromId, setResumedFromId] = useState<string | null>(null);
  // Remembered per device (a till keeps its salesperson across reloads).
  useEffect(() => {
    const saved = readTillSalesperson();
    if (saved) setSelectedSalesperson(saved);
  }, []);
  const [remixOilId, setRemixOilId] = useState("");
  const [lastSale, setLastSale] = useState<LastSale | null>(null);
  const [saleDoneOpen, setSaleDoneOpen] = useState(false);
  /** Cashier opt-in only — never print unless this box is checked. */
  const [printAfterComplete, setPrintAfterComplete] = useState(false);
  const [receiptBusy, setReceiptBusy] = useState<string | null>(null);
  const [heldMenuOpen, setHeldMenuOpen] = useState(false);
  /** Keep collapsed so Previous Orders never push Complete off-screen. */
  const [customerExtrasOpen, setCustomerExtrasOpen] = useState(false);
  const sendInFlight = useRef(new Set<string>());
  /**
   * POS-154: one idempotency key per bill, kept until the bill's outcome is
   * known — even if the cart is edited after a lost response. The server then
   * returns the sale it already made (same bill) or refuses with 409 (changed
   * bill); it never makes a second sale. Cleared on success or that 409.
   */
  const checkoutKeyRef = useRef<string | null>(null);
  const [packagingPick, setPackagingPick] = useState<
    Partial<Record<PackagingGroup, string>>
  >({});
  const inventory = products ?? emptyProducts;
  const heldList = useMemo(
    () => (heldBills ?? emptyHeld).filter((s) => s.id !== resumedFromId),
    [heldBills, resumedFromId],
  );
  const heldMenuList = heldQuery
    ? (heldMatches ?? emptyHeld).filter((s) => s.id !== resumedFromId)
    : heldList;
  const salespeople = useMemo(() => {
    if (settings.data?.salespeople?.length) return settings.data.salespeople;
    return settings.data?.currentUserName ? [settings.data.currentUserName] : [];
  }, [settings.data]);
  const salesperson = useMemo(() => {
    if (selectedSalesperson && salespeople.includes(selectedSalesperson)) {
      return selectedSalesperson;
    }
    const active = (settings.data?.activeSalesperson || "").trim();
    if (active && salespeople.includes(active)) return active;
    return salespeople[0] || "";
  }, [selectedSalesperson, settings.data?.activeSalesperson, salespeople]);

  const defaultFormat: ReceiptFormat =
    settings.data?.receiptFormat === "a4" ? "a4" : "thermal";
  const smsAvailable = Boolean(settings.data?.smsConfigured);
  const vatPercent = Math.max(0, Number(settings.data?.vatPercent ?? 0));

  const oilProducts = useMemo(
    () => inventory.filter((p) => p.unit === "ml" && p.category !== "Packaging"),
    [inventory],
  );
  const savedFormulas = customerFormulas ?? emptyFormulas;
  const recentOrders = pastOrders ?? emptyHeld;

  useEffect(() => {
    if (!remixOilId && oilProducts.length > 0) {
      setRemixOilId(oilProducts[0].id);
    }
  }, [oilProducts, remixOilId]);

  // New / cleared phone → keep Repeat panel collapsed so Complete stays visible.
  useEffect(() => {
    setCustomerExtrasOpen(false);
  }, [pastOrdersPhone]);

  const packagingProducts = useMemo(
    () =>
      inventory.filter(
        (p) =>
          (p.category === "Packaging" || p.category === "Coffret") &&
          p.unit !== "ml" &&
          !/ethanol|fixative/i.test(p.name),
      ),
    [inventory],
  );

  const packagingByGroup = useMemo(() => {
    const map = Object.fromEntries(
      PACKAGING_GROUPS.map((g) => [g.id, [] as Product[]]),
    ) as Record<PackagingGroup, Product[]>;
    for (const p of packagingProducts) {
      map[packagingGroupOf(p)].push(p);
    }
    return map;
  }, [packagingProducts]);

  const hasRefillInCart = cart.some((l) => l.lineType === "refill");

  useEffect(() => {
    if (hasRefillInCart) setToolStrip("packaging");
  }, [hasRefillInCart]);

  function setPackagingForGroup(group: PackagingGroup, productId: string) {
    setPackagingPick((prev) => {
      const next = { ...prev };
      if (productId) next[group] = productId;
      else delete next[group];
      return next;
    });

    const items = packagingByGroup[group];
    const product = productId
      ? items.find((p) => p.id === productId)
      : undefined;

    setCart((prev) => {
      const withoutGroup = prev.filter(
        (l) =>
          !(
            l.lineType === "packaging" &&
            items.some((p) => p.id === l.product.id)
          ),
      );
      if (!product) return withoutGroup;
      return [
        ...withoutGroup,
        {
          key: `${product.id}-pkg-${Date.now()}`,
          product,
          qty: 1,
          unitLabel: product.unit,
          unitPrice: product.sellPrice,
          lineType: "packaging" as const,
          bomNote: "Refill packaging (BLD-09 charge: cap/atomizer/collar/pouch)",
        },
      ];
    });
  }

  const catalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inventory.filter((p) => {
      if (p.category === "Packaging") return false;
      if (catalogFilter === "oil" && p.unit !== "ml") return false;
      if (catalogFilter === "custom" && p.category !== "Remix") {
        return false;
      }
      if (
        catalogFilter === "ready" &&
        (p.unit === "ml" || p.category === "Remix")
      ) {
        return false;
      }
      if (q === "") return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      );
    });
  }, [inventory, query, catalogFilter]);

  const quick = inventory.filter((p) => p.isQuickButton);
  const quickDuplicateNames = new Set(
    quick
      .map((p) => p.name.trim().toLowerCase())
      .filter((n, i, all) => all.indexOf(n) !== i),
  );

  // Same math as createSale — clamped so a qty drop can't make a discount invalid.
  const pricing = useMemo(() => {
    const lines = cart.map((l) => {
      const gross = l.qty * l.unitPrice;
      return { gross, discount: clampDiscount(l.discount, gross) };
    });
    const afterLines = lines.reduce(
      (s, l) => s + l.gross - discountAmount(l.discount, l.gross),
      0,
    );
    const invoice = clampDiscount(invoiceDiscount, afterLines);
    return { invoice, ...computeDiscounts(lines, invoice) };
  }, [cart, invoiceDiscount]);
  const subtotal = pricing.subtotal;
  const cartTotal = pricing.total;
  const discountNeedsApproval =
    pricing.discountTotal > 0 && exceedsDiscountLimit(pricing, user?.role);
  const vatAmount =
    vatPercent > 0 ? round2(cartTotal - cartTotal / (1 + vatPercent / 100)) : 0;
  const netAmount = round2(cartTotal - vatAmount);
  const itemCount = cart.reduce((s, l) => s + l.qty, 0);
  // What the customer actually pays — after item + bill discounts.
  const billTotal = quotationMode ? quotationMode.total : cartTotal;
  const mixedBreakdown: PaymentSplit[] = MIXED_METHODS.map((m) => ({
    method: m.id,
    amount: round2(Number(mixedAmounts[m.id]) || 0),
  })).filter((e) => e.amount > 0);
  const mixedEntered = round2(mixedBreakdown.reduce((s, e) => s + e.amount, 0));
  const mixedRemaining = round2(billTotal - mixedEntered);
  const mixedBalanced = mixedBreakdown.length > 0 && Math.abs(mixedRemaining) < 0.005;

  useEffect(() => {
    const timer = window.setTimeout(() => searchRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const digits = digitsOnly(phone);
    if (digits.length < 7) {
      setCustomerMatch(null);
      setMatchedCustomerId(null);
      return;
    }
    const seq = ++phoneLookupSeq.current;
    const timer = window.setTimeout(async () => {
      try {
        const list = await api<Customer[]>(
          `/api/customers?q=${encodeURIComponent(phone.trim())}`,
        );
        if (seq !== phoneLookupSeq.current) return;
        const match =
          list.find((c) => digitsOnly(c.phone) === digits) ||
          list.find((c) => {
            const pd = digitsOnly(c.phone);
            return pd.endsWith(digits) || digits.endsWith(pd);
          });
        if (match) {
          setCustomerMatch(match.name);
          setMatchedCustomerId(match.id);
          setCustomerName(match.name);
          setEmail(match.email?.trim() || "");
        } else {
          setCustomerMatch(null);
          setMatchedCustomerId(null);
        }
      } catch {
        if (seq === phoneLookupSeq.current) {
          setCustomerMatch(null);
          setMatchedCustomerId(null);
        }
      }
    }, 320);
    return () => window.clearTimeout(timer);
  }, [phone]);

  function flash(msg: string, ms = 2200, tone: "ok" | "err" = "ok") {
    setToastTone(tone);
    setToast(msg);
    window.setTimeout(() => setToast(null), ms);
  }

  function switchSalesperson(name: string) {
    if (name === salesperson) return;
    setSelectedSalesperson(name);
    writeTillSalesperson(name);
    flash(`Salesperson · ${name}`);
  }

  /** Block cart growth past sellable stock (server re-checks at checkout). */
  function exceedsStock(product: Product, extra: number): boolean {
    if (stockClaimed(cart, product.id) + extra <= product.stockSellable) {
      return false;
    }
    flash(
      `Only ${product.stockSellable} ${product.unit} of ${product.name} in stock`,
      4000,
      "err",
    );
    return true;
  }

  function addReady(product: Product) {
    if (exceedsStock(product, 1)) return;
    setCart((prev) => {
      const existing = prev.find(
        (l) => l.product.id === product.id && l.lineType === "ready",
      );
      if (existing) {
        return prev.map((l) =>
          l.key === existing.key ? { ...l, qty: l.qty + 1 } : l,
        );
      }
      return [
        ...prev,
        {
          key: `${product.id}-ready-${Date.now()}`,
          product,
          qty: 1,
          unitLabel: product.unit,
          unitPrice: product.sellPrice,
          lineType: "ready",
        },
      ];
    });
  }

  function addRemix() {
    const remix = inventory.find((p) => p.category === "Remix");
    if (!remix) return flash("Create a customized perfume product first", 5000, "err");
    const oil = oilProducts.find((p) => p.id === remixOilId);
    if (!oil) {
      return flash("Oil not selected", 5000, "err");
    }
    setCart((prev) => [
      ...prev,
      {
        key: `remix-${Date.now()}`,
        product: remix,
        qty: 1,
        unitLabel: "pcs",
        unitPrice: remix.sellPrice,
        lineType: "remix",
        oilProductId: oil.id,
        oilProductName: oil.name,
        bomNote: `Selected oil: ${oil.name} (qty from formula)`,
      },
    ]);
    flash(`Remix added · oil ${oil.name}`);
  }

  /** BLD-08: reuse an approved customer formula on the current order.
   * BLD-04: POS only gets redacted formulas (reuseHints) — no full recipe. */
  function applyCustomerFormula(formula: Formula) {
    const remix = inventory.find((p) => p.category === "Remix");
    if (!remix) {
      return flash("Create a customized perfume product first", 5000, "err");
    }

    const hints = formula.reuseHints;
    let oilProductId: string | undefined;
    let oilProductName: string | undefined;

    if (hints) {
      if (hints.needsOilSelection || !hints.oilProductId) {
        const oil = oilProducts.find((p) => p.id === remixOilId);
        if (!oil) {
          return flash("Oil not selected for this formula", 5000, "err");
        }
        oilProductId = oil.id;
        oilProductName = oil.name;
      } else {
        oilProductId = hints.oilProductId;
        oilProductName = hints.oilProductName;
      }
    } else {
      // Admin-unlocked full formula (rare on POS) — same logic as before.
      const hasOilBase = formula.components.some(
        (c) => c.productId === OIL_BASE_PRODUCT_ID,
      );
      if (hasOilBase) {
        const oil = oilProducts.find((p) => p.id === remixOilId);
        if (!oil) {
          return flash("Oil not selected for this formula", 5000, "err");
        }
        oilProductId = oil.id;
        oilProductName = oil.name;
      } else {
        const oilComp = formula.components.find((c) => {
          if (c.productId === OIL_BASE_PRODUCT_ID) return false;
          const p = inventory.find((x) => x.id === c.productId);
          if (!p || p.unit !== "ml") return false;
          return !matchRemixRole(c.productName, p.sku);
        });
        if (oilComp) {
          oilProductId = oilComp.productId;
          oilProductName = oilComp.productName;
        }
      }
    }

    setCart((prev) => [
      ...prev,
      {
        key: `remix-${formula.id}-${Date.now()}`,
        product: remix,
        qty: 1,
        unitLabel: "pcs",
        unitPrice: remix.sellPrice,
        lineType: "remix",
        formulaId: formula.id,
        formulaName: formula.name,
        oilProductId,
        oilProductName,
        bomNote: `Reuse: ${formula.name} (v${formula.version || 1})`,
      },
    ]);
    flash(`Reused formula · ${formula.name}`);
  }

  /** Reuse a remix (or ready) line from a previous completed order. */
  function reusePastOrder(sale: HeldSale) {
    const remixLine = (sale.lines || []).find((l) => l.lineType === "remix");
    if (remixLine) {
      if (remixLine.formulaId) {
        const formula = savedFormulas.find((f) => f.id === remixLine.formulaId);
        if (formula) {
          applyCustomerFormula(formula);
          return;
        }
      }
      const remix = inventory.find((p) => p.category === "Remix");
      if (!remix) {
        return flash("Create a customized perfume product first", 5000, "err");
      }
      const oilId = remixLine.oilProductId
        ? String(remixLine.oilProductId)
        : remixOilId;
      const oil = oilProducts.find((p) => p.id === oilId);
      if (!remixLine.formulaId && !oil) {
        return flash("Oil not selected — pick remix oil first", 5000, "err");
      }
      setCart((prev) => [
        ...prev,
        {
          key: `remix-past-${sale.id}-${Date.now()}`,
          product: remix,
          qty: remixLine.qty || 1,
          unitLabel: "pcs",
          unitPrice: remix.sellPrice,
          lineType: "remix",
          formulaId: remixLine.formulaId
            ? String(remixLine.formulaId)
            : undefined,
          formulaName: remixLine.bomNote?.startsWith("Reuse:")
            ? remixLine.bomNote.replace(/^Reuse:\s*/, "").replace(/\s*\(v\d+\)$/, "")
            : undefined,
          oilProductId: oil?.id,
          oilProductName: oil?.name,
          bomNote:
            remixLine.bomNote ||
            `Repeat order · ${sale.time || "previous"}`,
        },
      ]);
      flash("Previous remix added to cart");
      return;
    }

    const ready = (sale.lines || []).find((l) => l.lineType === "ready");
    if (ready?.productId) {
      const product = inventory.find((p) => p.id === String(ready.productId));
      if (product) {
        addReady(product);
        flash("Previous item added to cart");
        return;
      }
    }
    flash("Nothing reusable on that order", 4000, "err");
  }

  function addOil(product: Product, unit: "tola" | "half_tola" | "quarter_tola") {
    const ml = tolaToMl(unit);
    if (exceedsStock(product, ml)) return;
    const label =
      unit === "tola" ? "1 Tola" : unit === "half_tola" ? "½ Tola" : "¼ Tola";
    setCart((prev) => [
      ...prev,
      {
        key: `${product.id}-${unit}-${Date.now()}`,
        product,
        qty: 1,
        unitLabel: label,
        unitPrice: Number((product.sellPrice * ml).toFixed(3)),
        lineType: "oil",
        deductMl: ml,
        bomNote: `Deduct ${ml} ml from ${product.name}`,
      },
    ]);
  }

  function addProductSmart(product: Product) {
    if (isOutOfStock(product)) {
      flash(`${product.name} is out of stock`, 4000, "err");
      return;
    }
    if (product.category === "Remix") {
      addRemix();
      return;
    }
    if (product.unit === "ml") {
      addOil(product, "tola");
      return;
    }
    addReady(product);
  }

  /** Instant catalog stock update after sale — avoids waiting on full reload. */
  function applyLocalStockDeduction(lines: CartLine[]) {
    const delta = new Map<string, number>();
    for (const line of lines) {
      if (line.lineType === "ready" || line.lineType === "packaging") {
        delta.set(
          line.product.id,
          (delta.get(line.product.id) || 0) + line.qty,
        );
      } else if (
        (line.lineType === "oil" || line.lineType === "refill") &&
        line.deductMl
      ) {
        delta.set(
          line.product.id,
          (delta.get(line.product.id) || 0) + line.deductMl * line.qty,
        );
      }
      // remix BOM components refresh via silent API reload
    }
    if (delta.size === 0) return;
    setProducts((prev) => {
      if (!prev) return prev;
      return prev.map((p) => {
        const cut = delta.get(p.id);
        if (!cut) return p;
        return {
          ...p,
          stockSellable: Math.max(0, p.stockSellable - cut),
        };
      });
    });
  }

  function addRefill() {
    const oil = oilProducts.find((p) => p.id === remixOilId);
    if (!oil) {
      return flash("Oil not selected — pick oil for refill", 5000, "err");
    }
    if (exceedsStock(oil, 100)) return;
    // BLD-09: customer bottle locked to 100ml only (backend also enforces)
    setCart((prev) => [
      ...prev,
      {
        key: `refill-${Date.now()}`,
        product: oil,
        qty: 1,
        unitLabel: "100ml refill",
        unitPrice: 120,
        lineType: "refill",
        deductMl: 100,
        bomNote:
          "Customer 100ml bottle only · charge Cap/Atomizer/Collar/Pouch as packaging",
      },
    ]);
    flash("Refill locked to 100ml customer bottle — add Cap/Atomizer/Collar/Pouch to charge");
  }

  function updateQty(key: string, delta: number) {
    const line = cart.find((l) => l.key === key);
    if (line && delta > 0) {
      const perUnit =
        line.lineType === "ready" || line.lineType === "packaging"
          ? 1
          : line.lineType === "oil" || line.lineType === "refill"
            ? line.deductMl ?? 0
            : 0;
      if (perUnit > 0 && exceedsStock(line.product, perUnit * delta)) return;
    }
    const nextQty = line ? Math.max(0, line.qty + delta) : 0;
    if (line?.lineType === "packaging" && nextQty === 0) {
      const group = packagingGroupOf(line.product);
      setPackagingPick((prev) => {
        if (prev[group] !== line.product.id) return prev;
        const next = { ...prev };
        delete next[group];
        return next;
      });
    }
    if (nextQty === 0 && cart.length === 1) resetDiscounts();
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, qty: Math.max(0, l.qty + delta) } : l))
        .filter((l) => l.qty > 0),
    );
  }

  function removeLine(key: string) {
    const line = cart.find((l) => l.key === key);
    if (line?.lineType === "packaging") {
      const group = packagingGroupOf(line.product);
      setPackagingPick((prev) => {
        if (prev[group] !== line.product.id) return prev;
        const next = { ...prev };
        delete next[group];
        return next;
      });
    }
    if (cart.length === 1) resetDiscounts();
    setCart((prev) => prev.filter((l) => l.key !== key));
  }

  /** Discount fields for the API — the clamped values the cart actually shows. */
  function linesForApi(lines: CartLine[]) {
    return lines.map((line) => {
      const gross = line.qty * line.unitPrice;
      return {
        productId: line.product.id,
        name: line.product.name,
        qty: line.qty,
        unitLabel: line.unitLabel,
        unitPrice: line.unitPrice,
        lineType: line.lineType,
        deductMl: line.deductMl,
        bomNote: line.bomNote,
        oilProductId: line.oilProductId,
        formulaId: line.formulaId,
        discount: clampDiscount(line.discount, gross) ?? undefined,
      };
    });
  }

  /** A bill discount never carries over to the next customer's cart. */
  function resetDiscounts() {
    setInvoiceDiscount(null);
    setDiscountEditor(null);
  }

  function setLineDiscount(key: string, discount: DiscountInput | null) {
    setCart((prev) =>
      prev.map((l) => (l.key === key ? { ...l, discount: discount ?? undefined } : l)),
    );
    setDiscountEditor(null);
  }

  /**
   * POS-071/072: exchange the manager's credentials for a single-use token
   * bound to this cart, then complete the sale with only the token.
   */
  async function approveAndCheckout(email: string, password: string) {
    if (quotationMode) {
      await completeQuotationSale({ email, password });
      return;
    }
    setApprovingDiscount(true);
    try {
      const res = await api<{ required: boolean; approvalToken?: string }>(
        "/api/sales/discount-approval",
        {
          method: "POST",
          body: JSON.stringify({
            lines: linesForApi(cart),
            invoiceDiscount: pricing.invoice ?? undefined,
            email,
            password,
          }),
        },
      );
      await checkout(res.approvalToken);
    } catch (err) {
      setApproval((prev) => ({
        email,
        password: "",
        error: err instanceof Error ? err.message : "Approval failed",
        floorMessage: prev?.floorMessage,
      }));
    } finally {
      setApprovingDiscount(false);
    }
  }

  async function checkout(approvalToken?: string) {
    if (cart.length === 0) return;
    if (!salesperson) {
      flash("Add a salesperson in Settings → Sales Team", 6000, "err");
      return;
    }
    if (!phone.trim()) {
      flash("Capture customer phone for marketing", 5000, "err");
      return;
    }
    const missingOil = cart.some(
      (l) => l.lineType === "remix" && !l.oilProductId && !l.formulaId,
    );
    if (missingOil) {
      flash("Oil not selected for remix line", 5000, "err");
      return;
    }
    const badRefill = cart.find(
      (l) =>
        l.lineType === "refill" &&
        (l.deductMl !== 100 || !/100\s*ml/i.test(l.unitLabel || "")),
    );
    if (badRefill) {
      flash("Refill accepts only 100ml customer bottles (BLD-09)", 6000, "err");
      return;
    }
    if (payment === "mixed" && !mixedBalanced) {
      flash("Split payment doesn't add up to the bill total yet", 6000, "err");
      setMixedOpen(true);
      return;
    }
    // POS-071: over the role limit → ask for a manager before hitting the server.
    if (discountNeedsApproval && !approvalToken) {
      setApproval((prev) => prev ?? { email: "", password: "", error: null });
      return;
    }
    setCheckingOut(true);
    if (!checkoutKeyRef.current) checkoutKeyRef.current = createIdempotencyKey();
    const idempotencyKey = checkoutKeyRef.current;
    const snapshot = {
      cart,
      packagingPick,
      customerName: customerName.trim(),
      phone: phone.trim(),
      email: email.trim(),
      payment,
      paymentBreakdown: payment === "mixed" ? mixedBreakdown : undefined,
      salesperson,
      total: cartTotal,
      discountTotal: pricing.discountTotal,
      invoiceDiscount: pricing.invoice,
      matchedCustomerId,
      customerMatch,
      resumedFromId,
    };
    // Clear cart immediately (same feel as Hold) — restore if save fails
    setCart([]);
    resetDiscounts();
    setPackagingPick({});
    setCustomerName("");
    setPhone("");
    setEmail("");
    setCustomerMatch(null);
    setMatchedCustomerId(null);
    try {
      // The response is the stored sale — the receipt is built from it, never
      // from the cart (the server re-prices, so cart prices can be stale).
      const sale = await api<{
        id: string;
        total?: number;
        discountTotal?: number;
        salesperson?: string;
        payment?: string;
        paymentBreakdown?: PaymentSplit[];
        lines?: Array<{ name: string; qty: number; unitLabel?: string; unitPrice: number }>;
      }>("/api/sales", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          customerPhone: snapshot.phone,
          customerName: snapshot.customerName || undefined,
          customerId: snapshot.matchedCustomerId || undefined,
          salesperson: snapshot.salesperson,
          payment: snapshot.payment,
          paymentBreakdown: snapshot.paymentBreakdown,
          idempotencyKey,
          lines: linesForApi(snapshot.cart),
          invoiceDiscount: snapshot.invoiceDiscount ?? undefined,
          discountApprovalToken: approvalToken,
          resumedFromId: snapshot.resumedFromId ?? undefined,
        }),
      });
      setApproval(null);
      setResumedFromId(null);
      checkoutKeyRef.current = null; // next bill gets a fresh key
      // POS-112/115: what the server recorded — print / WhatsApp must match the sale.
      const completed: LastSale = {
        id: sale.id,
        total: sale.total ?? snapshot.total,
        discountTotal: sale.discountTotal ?? snapshot.discountTotal,
        customerName: snapshot.customerName,
        phone: snapshot.phone,
        email: snapshot.email,
        payment: sale.payment ? sale.payment.toLowerCase() : snapshot.payment,
        paymentBreakdown: sale.paymentBreakdown ?? snapshot.paymentBreakdown,
        salesperson: sale.salesperson || snapshot.salesperson,
        lines: Array.isArray(sale.lines)
          ? sale.lines.map((line) => ({
              name: line.name,
              qty: line.qty,
              unitLabel: line.unitLabel ?? "",
              unitPrice: line.unitPrice,
            }))
          : snapshot.cart.map((line) => ({
              name: line.product.name,
              qty: line.qty,
              unitLabel: line.unitLabel,
              unitPrice: line.unitPrice,
            })),
      };
      setLastSale(completed);
      setSaleDoneOpen(true);
      flash(
        `Sale completed · ${formatMoney(completed.total)} · ${formatPaymentLabel(snapshot.payment, snapshot.paymentBreakdown)}`,
      );
      // Split amounts are specific to this bill — clear them for the next customer.
      if (snapshot.payment === "mixed") setMixedAmounts(emptyMixedAmounts);
      // Soft stock refresh — silent so POS does not flash "Loading…"
      applyLocalStockDeduction(snapshot.cart);
      void reloadHeld({ silent: true });
      // Print ONLY if cashier checked "Print after complete" (never automatic).
      if (printAfterComplete) {
        void printSale(completed, defaultFormat, false);
      }
      void reload({ silent: true });
      window.setTimeout(() => searchRef.current?.focus(), 100);
    } catch (err) {
      const failure = classifyCheckoutError(
        err,
        typeof navigator === "undefined" ? true : navigator.onLine,
      );
      if (!keepCheckoutKey(failure)) checkoutKeyRef.current = null;
      const message = checkoutFailureMessage(
        failure,
        err instanceof Error ? err.message : "Could not complete sale",
        (err as { data?: { saleId?: string } }).data?.saleId,
      );
      const code = (err as { data?: { code?: string } }).data?.code;
      if (failure === "conflict") void reload({ silent: true });
      if (code === "HELD_BILL_UNAVAILABLE") {
        // Completed or discarded on another till — completing this copy too
        // would duplicate the sale, so drop it.
        setResumedFromId(null);
        setApproval(null);
        void reloadHeld({ silent: true });
        flash(message, 7000, "err");
        return;
      }
      setCart(snapshot.cart);
      setPackagingPick(snapshot.packagingPick);
      setCustomerName(snapshot.customerName);
      setPhone(snapshot.phone);
      setEmail(snapshot.email);
      setPayment(snapshot.payment);
      setCustomerMatch(snapshot.customerMatch);
      setMatchedCustomerId(snapshot.matchedCustomerId);
      setInvoiceDiscount(snapshot.invoiceDiscount);
      if (code === "PRICE_FLOOR_APPROVAL_REQUIRED") {
        // Cost is server-only — the cashier learns about the floor from checkout.
        setApproval((prev) => ({
          email: prev?.email ?? "",
          password: "",
          error: approvalToken ? message : null,
          floorMessage: message,
        }));
      } else if (code === "DISCOUNT_APPROVAL_REQUIRED" || code === "DISCOUNT_NOT_AUTHORIZED") {
        // Server limit is the source of truth — prompt even if the client didn't.
        setApproval((prev) => ({
          email: prev?.email ?? "",
          password: "",
          error: approvalToken ? message : null,
          floorMessage: prev?.floorMessage,
        }));
      } else {
        flash(message, 6000, "err");
      }
    } finally {
      setCheckingOut(false);
    }
  }

  const checkoutRef = useRef(checkout);
  checkoutRef.current = checkout;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        void checkoutRef.current();
        return;
      }
      if (e.key === "Escape") {
        if (saleDoneOpen) {
          e.preventDefault();
          setSaleDoneOpen(false);
          return;
        }
        if (toast) {
          e.preventDefault();
          setToast(null);
        }
        return;
      }
      if (!typing && e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saleDoneOpen, toast]);

  function stubProductFromLine(line: HeldSaleLine): Product {
    const pid = line.productId ? String(line.productId) : `missing-${line.name}`;
    return {
      id: pid,
      sku: "—",
      name: line.name,
      category: "Brands",
      unit: line.lineType === "oil" || line.lineType === "refill" ? "ml" : "pcs",
      sellPrice: line.unitPrice,
      minMarginPct: 0,
      costFifo: 0,
      stockSellable: 0,
      stockTester: 0,
      stockSample: 0,
      stockPersonal: 0,
      lowStockAt: 0,
    };
  }

  /**
   * POS-102 pricing rule: a held bill completes at the CURRENT catalogue price
   * (the server always re-prices at checkout), so the resumed cart shows that
   * price too — what the cashier sees is what gets charged.
   */
  function currentUnitPrice(line: HeldSaleLine, product: Product | undefined): number {
    if (!product) return line.unitPrice;
    if (line.lineType === "oil") {
      return line.deductMl ? Number((product.sellPrice * line.deductMl).toFixed(3)) : line.unitPrice;
    }
    // Refill is a fixed service rate owned by the backend, not a catalogue price.
    if (line.lineType === "refill") return line.unitPrice;
    return product.sellPrice;
  }

  function cartFromHeld(sale: HeldSale): {
    lines: CartLine[];
    packaging: Partial<Record<PackagingGroup, string>>;
    repriced: number;
  } {
    const packaging: Partial<Record<PackagingGroup, string>> = {};
    let repriced = 0;
    const lines: CartLine[] = (sale.lines || []).map((line, index) => {
      const productId = line.productId ? String(line.productId) : "";
      const found = productId ? inventory.find((p) => p.id === productId) : undefined;
      const product = found || stubProductFromLine(line);
      const unitPrice = currentUnitPrice(line, found);
      if (Math.abs(unitPrice - line.unitPrice) > 0.0005) repriced += 1;
      const oilId = line.oilProductId ? String(line.oilProductId) : undefined;
      const oilProduct = oilId
        ? inventory.find((p) => p.id === oilId)
        : undefined;
      const formulaId = line.formulaId ? String(line.formulaId) : undefined;

      if (line.lineType === "packaging" && productId) {
        packaging[packagingGroupOf(product)] = productId;
      }

      return {
        key: `held-${sale.id}-${index}-${Date.now()}`,
        product,
        qty: line.qty,
        unitLabel: line.unitLabel,
        unitPrice,
        lineType: line.lineType,
        deductMl: line.deductMl,
        bomNote: line.bomNote,
        oilProductId: oilId,
        oilProductName: oilProduct?.name,
        formulaId,
        discount: discountFromStored(line.discountType, line.discountValue),
      };
    });
    return { lines, packaging, repriced };
  }

  async function holdBill() {
    if (cart.length === 0) {
      flash("Cart is empty — nothing to hold", 4000, "err");
      return;
    }
    if (!phone.trim()) {
      flash("Capture customer phone before holding the bill", 5000, "err");
      return;
    }
    if (!salesperson) {
      flash("Add a salesperson in Settings → Sales Team", 6000, "err");
      return;
    }
    setHolding(true);
    const snapshot = {
      customerName: customerName.trim(),
      phone: phone.trim(),
      payment,
      paymentBreakdown: payment === "mixed" ? mixedBreakdown : undefined,
      salesperson,
      email,
      cart,
      packagingPick,
      invoiceDiscount: pricing.invoice,
      matchedCustomerId,
      customerMatch,
      resumedFromId,
    };
    // Clear terminal immediately so the cashier feels instant feedback
    setCart([]);
    resetDiscounts();
    setPackagingPick({});
    setCustomerName("");
    setPhone("");
    setEmail("");
    setCustomerMatch(null);
    setMatchedCustomerId(null);
    try {
      const held = await api<HeldSale>("/api/sales", {
        method: "POST",
        body: JSON.stringify({
          customerPhone: snapshot.phone,
          customerName: snapshot.customerName || undefined,
          customerId: snapshot.matchedCustomerId || undefined,
          salesperson: snapshot.salesperson,
          payment: snapshot.payment,
          paymentBreakdown: snapshot.paymentBreakdown,
          status: "held",
          lines: linesForApi(snapshot.cart),
          invoiceDiscount: snapshot.invoiceDiscount ?? undefined,
          // Re-holding a resumed bill updates it instead of adding a copy.
          resumedFromId: snapshot.resumedFromId ?? undefined,
        }),
      });
      setResumedFromId(null);
      setHeldBills((prev) => [held, ...(prev ?? []).filter((s) => s.id !== held.id)]);
      flash("Bill held — resume anytime");
    } catch (err) {
      // Restore cart if save failed
      setCart(snapshot.cart);
      setPackagingPick(snapshot.packagingPick);
      setInvoiceDiscount(snapshot.invoiceDiscount);
      setCustomerName(snapshot.customerName);
      setPhone(snapshot.phone);
      setCustomerMatch(snapshot.customerMatch);
      setMatchedCustomerId(snapshot.matchedCustomerId);
      setEmail(snapshot.email);
      flash(err instanceof Error ? err.message : "Could not hold bill", 6000, "err");
    } finally {
      setHolding(false);
    }
  }

  async function resumeHeld(sale: HeldSale) {
    if (cart.length > 0) {
      flash("Hold or clear the current bill before resuming another", 5000, "err");
      return;
    }
    setResumingId(sale.id);
    const { lines, packaging, repriced } = cartFromHeld(sale);
    if (lines.length === 0) {
      setResumingId(null);
      flash("Held bill has no lines", 4000, "err");
      return;
    }
    // The bill stays held on the server until checkout closes it or a re-hold
    // updates it — nothing is voided here, so nothing can be lost.
    setResumedFromId(sale.id);
    setHeldMenuOpen(false);
    setHeldSearch("");
    setCart(lines);
    setPackagingPick(packaging);
    setInvoiceDiscount(
      discountFromStored(sale.invoiceDiscountType, sale.invoiceDiscountValue) ?? null,
    );
    setCustomerName(
      sale.customerName && sale.customerName !== "Walk-in Customer"
        ? sale.customerName
        : "",
    );
    setPhone(
      sale.customerPhone && sale.customerPhone !== "pending"
        ? sale.customerPhone
        : "",
    );
    setPayment(normalizePayment(sale.payment));
    // The held bill keeps its salesperson; the cashier can still change it.
    if (sale.salesperson && salespeople.includes(sale.salesperson)) {
      setSelectedSalesperson(sale.salesperson);
    }
    if (sale.payment === "mixed" && Array.isArray(sale.paymentBreakdown)) {
      const restored = { ...emptyMixedAmounts };
      for (const entry of sale.paymentBreakdown) {
        if (entry.method in restored) restored[entry.method] = String(entry.amount);
      }
      setMixedAmounts(restored);
    } else {
      setMixedAmounts(emptyMixedAmounts);
    }
    setResumingId(null);
    flash(
      repriced > 0
        ? `Resumed bill · ${repriced} line${repriced === 1 ? "" : "s"} repriced to today's price`
        : "Resumed bill",
      repriced > 0 ? 6000 : 3000,
      repriced > 0 ? "err" : "ok",
    );
  }

  // Resumed cart emptied by hand → the bill was never closed, so it simply
  // shows up in the held list again.
  useEffect(() => {
    if (cart.length === 0 && resumedFromId && !checkingOut && !holding) {
      setResumedFromId(null);
      void reloadHeld({ silent: true });
    }
  }, [cart.length, resumedFromId, checkingOut, holding, reloadHeld]);

  async function discardHeld(sale: HeldSale) {
    setDiscardingId(sale.id);
    setHeldBills((prev) => (prev ?? []).filter((s) => s.id !== sale.id));
    try {
      await api(`/api/sales/${sale.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "void" }),
      });
      flash("Held bill discarded");
    } catch (err) {
      // Server truth (it may have just been completed on another till).
      void reloadHeld({ silent: true });
      flash(
        err instanceof Error ? err.message : "Could not discard bill",
        6000,
        "err",
      );
    } finally {
      setDiscardingId(null);
    }
  }

  function receiptLines() {
    return cart.map((line) => ({
      name: line.product.name,
      qty: line.qty,
      unitLabel: line.unitLabel,
      unitPrice: line.unitPrice,
      note: line.oilProductName ? `Oil: ${line.oilProductName}` : undefined,
    }));
  }

  async function printSale(
    sale: LastSale,
    format: ReceiptFormat,
    reprint: boolean,
  ) {
    setReceiptBusy(`print-${format}`);
    try {
      // Everything the receipt needs is already in memory (this sale + the
      // settings the page loaded on mount) — render locally instead of an
      // API round-trip, so the print dialog opens immediately.
      const doc = buildReceiptDoc({
        saleId: sale.id,
        reprint,
        customer: { name: sale.customerName, phone: sale.phone, email: sale.email },
        salesperson: sale.salesperson,
        payment: formatPaymentLabel(sale.payment, sale.paymentBreakdown),
        lines: sale.lines,
        total: sale.total,
        discountTotal: sale.discountTotal,
        settings: settings.data ?? undefined,
      });
      await printHtmlDocument(renderReceiptHtml(doc, format));
      void api("/api/notifications/log", {
        method: "POST",
        body: JSON.stringify({
          channel: "print",
          kind: "receipt",
          status: "printed",
          saleId: sale.id,
          format,
        }),
      }).catch(() => undefined);
      flash(
        `Receipt sent to printer · ${format === "a4" ? "A4" : "80mm thermal"}`,
      );
    } catch (err) {
      flash(
        err instanceof Error ? err.message : "Could not print receipt",
        7000,
        "err",
      );
    } finally {
      setReceiptBusy(null);
    }
  }

  async function printDraftBill(format: ReceiptFormat) {
    if (cart.length === 0) {
      flash("Cart is empty — nothing to print", 4000, "err");
      return;
    }
    setReceiptBusy(`print-${format}`);
    try {
      const html = await fetchReceiptHtml("/api/receipts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          customerName: customerName.trim(),
          customerPhone: phone.trim(),
          salesperson,
          payment: formatPaymentLabel(payment, mixedBreakdown),
          total: cartTotal,
          discountTotal: pricing.discountTotal,
          lines: receiptLines(),
        }),
      });
      await printHtmlDocument(html);
      flash("Draft bill sent to printer");
    } catch (err) {
      flash(
        err instanceof Error ? err.message : "Could not print draft bill",
        7000,
        "err",
      );
    } finally {
      setReceiptBusy(null);
    }
  }

  function printCurrent(format: ReceiptFormat) {
    if (cart.length > 0) {
      void printDraftBill(format);
      return;
    }
    if (lastSale) {
      void printSale(lastSale, format, true);
      return;
    }
    flash("Add items or complete a sale first", 4000, "err");
  }

  function buildPosReceiptDoc(target: LastSale | null) {
    const lines = target?.lines?.length ? target.lines : receiptLines();
    return buildReceiptDoc({
      saleId: target?.id,
      draft: !target,
      customer: {
        name: target ? target.customerName : customerName.trim(),
        phone: target ? target.phone : phone.trim(),
        email: target ? target.email : email.trim(),
      },
      salesperson: target?.salesperson || salesperson,
      payment: target
        ? formatPaymentLabel(target.payment, target.paymentBreakdown)
        : formatPaymentLabel(payment, mixedBreakdown),
      lines,
      total: target ? target.total : cartTotal,
      discountTotal: target ? target.discountTotal : pricing.discountTotal,
      settings: settings.data ?? undefined,
    });
  }

  async function sendReceipt(channels: SendChannel[]) {
    const target = cart.length === 0 ? lastSale : null;
    const toPhone = target ? target.phone : phone.trim();
    const toEmail = target ? target.email : email.trim();
    const lines = target?.lines?.length ? target.lines : receiptLines();
    const flightKey = `${target?.id || "draft"}:${channels.join("+")}`;

    if (!target && cart.length === 0) {
      flash("Add items or complete a sale first", 4000, "err");
      return;
    }
    if (!toPhone) {
      flash("Customer phone is required", 5000, "err");
      return;
    }
    if (channels.includes("email") && !toEmail) {
      flash("Add a customer email to send the receipt by email", 6000, "err");
      return;
    }
    if (sendInFlight.current.has(flightKey)) return;
    sendInFlight.current.add(flightKey);

    const done: string[] = [];
    let receiptNo = "";
    let background = false;

    try {
      if (channels.includes("whatsapp")) {
        try {
          const doc = buildPosReceiptDoc(target);
          receiptNo = doc.receiptNo;
          window.open(
            buildWhatsAppUrl(toPhone, receiptText(doc)),
            "_blank",
            "noopener,noreferrer",
          );
          done.push("WhatsApp opened");
          void api("/api/notifications/log", {
            method: "POST",
            body: JSON.stringify({
              channel: "whatsapp",
              kind: "receipt",
              status: "handoff",
              saleId: target?.id,
              receiptNo: doc.receiptNo,
              to: toPhone,
            }),
          }).catch(() => {
            /* non-fatal */
          });
        } catch (err) {
          flash(
            err instanceof Error ? err.message : "Could not open WhatsApp",
            6000,
            "err",
          );
        }
      }

      const remoteChannels = channels.filter((c) => c !== "whatsapp");
      if (remoteChannels.length === 0) {
        if (done.length > 0) {
          flash(
            `${receiptNo ? `${receiptNo} · ` : ""}${done.join(" · ")}`,
            4000,
          );
        }
        return;
      }

      // Email / SMS save in background — no spinner, toast only when finished.
      background = true;
      void (async () => {
        try {
          const res = await api<{
            receiptNo?: string;
            email?: { ok: boolean; to?: string; error?: string };
            sms?: { ok: boolean; to?: string; error?: string };
          }>("/api/notifications/send", {
            method: "POST",
            body: JSON.stringify({
              channels: remoteChannels,
              kind: "receipt",
              saleId: target?.id,
              toPhone,
              toEmail: toEmail || undefined,
              customerName: target ? target.customerName : customerName.trim(),
              salesperson: target?.salesperson || salesperson,
              payment: target ? target.payment : payment,
              total: target ? target.total : cartTotal,
              discountTotal: target ? target.discountTotal : pricing.discountTotal,
              lines,
            }),
          });

          const parts = [
            ...done,
            res.email?.ok ? `Email → ${res.email.to}` : null,
            res.sms?.ok ? `SMS → ${res.sms.to}` : null,
          ].filter(Boolean);
          const no = res.receiptNo || receiptNo;
          flash(`${no ? `${no} · ` : ""}${parts.join(" · ")}`, 6000);
        } catch (err) {
          flash(
            err instanceof Error ? err.message : "Could not send receipt",
            8000,
            "err",
          );
        } finally {
          sendInFlight.current.delete(flightKey);
        }
      })();
    } catch (err) {
      flash(
        err instanceof Error ? err.message : "Could not send receipt",
        8000,
        "err",
      );
    } finally {
      if (!background) sendInFlight.current.delete(flightKey);
    }
  }

  if (loading || settings.loading) return <LoadingState label="Loading POS…" />;
  if (error || settings.error) {
    return (
      <ErrorState
        message={error || settings.error || "Failed to load POS"}
        onRetry={() => {
          void reload();
          void settings.reload();
        }}
      />
    );
  }

  return (
    <div className="xl:flex xl:h-[calc(100vh-3.5rem-2rem)] xl:flex-col xl:overflow-hidden">
      {toast ? (
        <div
          className={`animate-fade-up mb-3 shrink-0 rounded-lg border px-4 py-2.5 text-sm ${
            toastTone === "err"
              ? "border-rose-400/40 bg-rose-500/10 text-rose-200"
              : "border-gold/30 bg-gold/10 text-gold-deep"
          }`}
        >
          {toast}
        </div>
      ) : null}

      <div className="grid gap-5 xl:min-h-0 xl:flex-1 xl:grid-cols-[1.45fr_1fr] xl:items-stretch">
        {/* LEFT: search → big catalog grid → bottom tools */}
        <div className="flex min-h-0 flex-col gap-3">
          <Panel className="shrink-0 !p-4">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-muted" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  // POS-021: only add when identity is unambiguous (exact SKU,
                  // single result, or a unique exact name) — never by position.
                  const pick = resolveSearchPick(catalog, query);
                  if (pick.kind === "none") {
                    flash("No products match this search", 3000, "err");
                    return;
                  }
                  if (pick.kind === "ambiguous") {
                    flash(
                      `${pick.count} products match — click the one you want (check SKU / price) or type its SKU`,
                      4000,
                      "err",
                    );
                    return;
                  }
                  addProductSmart(pick.product);
                  setQuery("");
                }}
                placeholder="Search name, SKU, category… · F2 · Enter add · F9 complete"
                className="h-11 w-full rounded-full border border-line bg-mist pr-3 pl-10 text-sm outline-none focus:border-gold focus:ring-2 focus:ring-gold/20"
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {CATALOG_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setCatalogFilter(f.id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                    catalogFilter === f.id
                      ? "border-ink bg-ink text-canvas"
                      : "border-line bg-mist text-ink-muted hover:border-line-strong"
                  }`}
                >
                  {f.label}
                </button>
              ))}
              <span className="ml-auto self-center text-[11px] text-ink-muted">
                {catalog.length} products
              </span>
            </div>
          </Panel>

          <Panel
            padding={false}
            className="flex min-h-[280px] flex-1 flex-col overflow-hidden"
          >
            <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
              {catalog.length === 0 ? (
                <div className="flex h-full min-h-[200px] items-center justify-center text-sm text-ink-muted">
                  No products in this filter
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4">
                  {catalog.map((p) => {
                    const madeToOrder = p.category === "Remix";
                    const low =
                      !madeToOrder &&
                      p.lowStockAt > 0 &&
                      p.stockSellable <= p.lowStockAt;
                    const out = isOutOfStock(p);
                    return (
                      <div
                        key={p.id}
                        className={`flex flex-col rounded-xl border border-line/70 bg-mist/25 p-3 transition hover:border-gold/40 hover:bg-mist/40 ${
                          out ? "opacity-50" : ""
                        }`}
                      >
                        <div className="mb-2 flex items-start justify-between gap-2">
                          <Badge
                            tone={out ? "danger" : low ? "warning" : "success"}
                            className="h-5 max-w-full truncate px-2 text-[10px]"
                          >
                            {out
                              ? "Out"
                              : madeToOrder
                                ? "Made to order"
                                : `${p.stockSellable} ${p.unit}`}
                          </Badge>
                          <span className="shrink-0 text-sm font-bold tabular-nums text-ink">
                            {formatMoney(p.sellPrice)}
                            {p.unit === "ml" ? (
                              <span className="font-normal text-ink-muted">
                                /ml
                              </span>
                            ) : null}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-base font-semibold leading-snug text-ink">
                          {p.name}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-ink-muted">
                          {p.sku} · {p.category}
                          {p.size ? ` · ${p.size}` : ""}
                        </p>
                        <div className="mt-auto flex gap-1.5 pt-3">
                          {p.unit === "ml" ? (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-8 flex-1 px-0"
                                disabled={out}
                                title={out ? "Out of stock" : "¼ tola"}
                                onClick={() => addOil(p, "quarter_tola")}
                              >
                                ¼
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-8 flex-1 px-0"
                                disabled={out}
                                title={out ? "Out of stock" : "½ tola"}
                                onClick={() => addOil(p, "half_tola")}
                              >
                                ½
                              </Button>
                              <Button
                                size="sm"
                                variant="gold"
                                className="h-8 flex-1 px-0"
                                disabled={out}
                                title={out ? "Out of stock" : "1 tola"}
                                onClick={() => addOil(p, "tola")}
                              >
                                1T
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="gold"
                              className="h-8 w-full"
                              disabled={out}
                              title={out ? "Out of stock" : undefined}
                              onClick={() =>
                                p.category === "Remix"
                                  ? addRemix()
                                  : addReady(p)
                              }
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {out ? "Out" : "Add"}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Panel>

          {/* Bottom tool strip: Packaging | Quick Add */}
          <Panel className="shrink-0 !p-3">
            <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: "quick" as const, label: "Quick Add" },
                  { id: "packaging" as const, label: "Packaging" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setToolStrip(tab.id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                    toolStrip === tab.id
                      ? "border-ink bg-ink text-canvas"
                      : "border-line bg-mist text-ink-muted hover:border-line-strong"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
              {toolStrip === "packaging" && hasRefillInCart ? (
                <Badge tone="warning">Suggested for refill</Badge>
              ) : null}
            </div>

            {toolStrip === "quick" ? (
              <div className="flex flex-wrap gap-1.5">
                {quick.length === 0 ? (
                  <p className="text-xs text-ink-muted">
                    No quick-button products configured
                  </p>
                ) : (
                  quick.map((p) => {
                    const out = isOutOfStock(p);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={out}
                        title={out ? "Out of stock" : undefined}
                        onClick={() => {
                          if (p.category === "Remix") addRemix();
                          else if (p.unit === "ml") addOil(p, "tola");
                          else addReady(p);
                        }}
                        className="rounded-lg border border-line bg-mist/50 px-2.5 py-1.5 text-left text-xs transition hover:border-gold/50 hover:bg-mist disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <span className="block font-medium text-ink">
                          {p.name}
                        </span>
                        <span className="text-[10px] text-ink-muted">
                          {/* POS-021: same-name quick buttons must be told apart */}
                          {quickDuplicateNames.has(p.name.trim().toLowerCase())
                            ? `${p.sku} · `
                            : ""}
                          {out
                            ? "Out"
                            : `${formatMoney(p.sellPrice)}${p.unit === "ml" ? "/ml" : ""}`}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            ) : packagingProducts.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {PACKAGING_GROUPS.map((group) => {
                  const items = packagingByGroup[group.id];
                  if (items.length === 0) return null;
                  const selectedId = packagingPick[group.id] ?? "";
                  return (
                    <label key={group.id} className="block min-w-0">
                      <span className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                        <Package className="h-3 w-3" />
                        {group.label}
                      </span>
                      <select
                        value={selectedId}
                        onChange={(e) =>
                          setPackagingForGroup(group.id, e.target.value)
                        }
                        className="h-9 w-full rounded-lg border border-line bg-canvas px-2.5 text-xs text-ink outline-none focus:border-gold focus:ring-2 focus:ring-gold/20"
                      >
                        <option value="">
                          Select {group.label.toLowerCase()}…
                        </option>
                        {items.map((p) => {
                          const out = p.stockSellable <= 0;
                          return (
                            <option
                              key={p.id}
                              value={p.id}
                              disabled={out && p.id !== selectedId}
                            >
                              {p.name} · {formatMoney(p.sellPrice)}
                              {out ? " — out" : ""}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-ink-muted">No packaging products</p>
            )}
          </Panel>
        </div>

        <Panel className="flex min-h-0 flex-col overflow-hidden !p-4 xl:h-full">
          {/* Fixed header */}
          <div className="shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="font-bold text-xl text-ink">
                  {quotationMode ? `Converting ${quotationMode.number}` : "Current Bill"}
                </h2>
                <p className="text-[11px] text-ink-muted">
                  {quotationMode
                    ? `${quotationMode.lines.length} items from quotation`
                    : `${itemCount} items · ${heldList.length} held`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {quotationMode ? (
                  <button
                    type="button"
                    onClick={exitQuotationMode}
                    title="Exit quotation mode — back to a regular bill"
                    className="flex h-8 items-center gap-1 rounded-full border border-line bg-mist px-2.5 text-[11px] text-ink-muted hover:border-line-strong"
                  >
                    <X className="h-3 w-3" />
                    Exit
                  </button>
                ) : null}
                {/* Shown in quotation mode too: a converted quotation needs a salesperson. */}
                {salespeople.length > 0 ? (
                  <select
                    value={salesperson}
                    onChange={(e) => switchSalesperson(e.target.value)}
                    title="Salesperson for this bill"
                    className="h-8 max-w-[9rem] truncate rounded-full border border-line bg-mist px-2 text-[11px] outline-none focus:border-gold disabled:opacity-60"
                  >
                    {salespeople.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <Badge tone={quotationMode ? "gold" : cart.length > 0 ? "success" : "neutral"}>
                  {quotationMode ? "Quotation" : cart.length > 0 ? "Live" : "Idle"}
                </Badge>
              </div>
            </div>

            {quotationLoadError ? (
              <p className="mt-3 rounded-lg border border-coral/30 bg-coral-soft px-3 py-2 text-xs text-coral">
                {quotationLoadError}
              </p>
            ) : null}

            {/* Line 1: name */}
            <label className="mt-3 block">
              <span className="text-[11px] font-medium text-ink-muted">
                Name
              </span>
              <input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Customer name"
                readOnly={!!quotationMode}
                title={quotationMode ? "From the quotation — exit quotation mode to edit" : undefined}
                className="mt-1 h-9 w-full rounded-full border border-line bg-mist px-3 text-sm outline-none focus:border-gold focus:ring-2 focus:ring-gold/20 read-only:text-ink-muted"
              />
            </label>

            {/* Line 2: contact — equal label rows so inputs align */}
            <div className="mt-2 grid grid-cols-2 items-end gap-2">
              <label className="min-w-0 block">
                <span className="flex h-4 items-center gap-1 text-[11px] font-medium leading-none text-ink-muted">
                  Phone
                  {customerMatch ? (
                    <Badge tone="success" className="h-4 px-1.5 text-[9px]">
                      Known
                    </Badge>
                  ) : null}
                </span>
                <input
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    if (digitsOnly(e.target.value).length < 7) {
                      setCustomerMatch(null);
                      setMatchedCustomerId(null);
                    }
                  }}
                  placeholder="+971 …"
                  inputMode="tel"
                  readOnly={!!quotationMode}
                  title={quotationMode ? "From the quotation — exit quotation mode to edit" : undefined}
                  className="mt-1 box-border h-9 w-full rounded-full border border-line bg-mist px-3 text-sm leading-normal outline-none focus:border-gold focus:ring-2 focus:ring-gold/20 read-only:text-ink-muted"
                />
              </label>
              <label className="min-w-0 block">
                <span className="flex h-4 items-center text-[11px] font-medium leading-none text-ink-muted">
                  Email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="email@…"
                  readOnly={!!quotationMode}
                  title={quotationMode ? "From the quotation — exit quotation mode to edit" : undefined}
                  className="mt-1 box-border h-9 w-full rounded-full border border-line bg-mist px-3 text-sm leading-normal outline-none focus:border-gold focus:ring-2 focus:ring-gold/20 read-only:text-ink-muted"
                />
              </label>
            </div>

            {oilProducts.length > 0 ? (
              <label className="mt-2 block">
                <span className="text-[11px] font-medium text-ink-muted">
                  Remix oil
                </span>
                <select
                  value={remixOilId}
                  onChange={(e) => setRemixOilId(e.target.value)}
                  className="mt-1 h-9 w-full rounded-full border border-line bg-mist px-3 text-sm outline-none focus:border-gold focus:ring-2 focus:ring-gold/20"
                >
                  {oilProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {pastOrdersPhone ? (
              <div className="mt-2 rounded-lg border border-line/70 bg-mist/40">
                <button
                  type="button"
                  onClick={() => setCustomerExtrasOpen((o) => !o)}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
                >
                  <History className="h-3.5 w-3.5 shrink-0 text-gold-deep" />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                    Repeat
                    {!pastOrdersLoading && recentOrders.length > 0
                      ? ` · ${recentOrders.length} orders`
                      : ""}
                    {matchedCustomerId && savedFormulas.length > 0
                      ? ` · ${savedFormulas.length} formulas`
                      : ""}
                  </span>
                  {pastOrdersLoading || formulasLoading ? (
                    <span className="text-[10px] text-ink-muted">…</span>
                  ) : null}
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 text-ink-muted transition ${
                      customerExtrasOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {customerExtrasOpen ? (
                  <div className="max-h-36 space-y-2 overflow-y-auto border-t border-line/60 px-3 py-2">
                    <div>
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                        Previous orders
                      </p>
                      {!pastOrdersLoading && recentOrders.length === 0 ? (
                        <p className="text-[11px] text-ink-muted">
                          No completed orders yet.
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {recentOrders.map((sale) => {
                            const remix = (sale.lines || []).find(
                              (l) => l.lineType === "remix",
                            );
                            const summary =
                              remix?.bomNote ||
                              remix?.name ||
                              sale.lines?.[0]?.name ||
                              sale.saleType ||
                              "Sale";
                            return (
                              <li
                                key={sale.id}
                                className="flex items-center justify-between gap-2 rounded-md border border-line/60 bg-canvas/70 px-2 py-1"
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-medium">
                                    {summary}
                                  </p>
                                  <p className="text-[10px] text-ink-muted">
                                    {sale.time || "—"} ·{" "}
                                    {formatMoney(sale.total)}
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="h-7 shrink-0 px-2 text-[11px]"
                                  onClick={() => reusePastOrder(sale)}
                                >
                                  Reuse
                                </Button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                    {matchedCustomerId ? (
                      <div>
                        <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                          <FlaskConical className="h-3 w-3" />
                          Saved formulas
                        </p>
                        {!formulasLoading && savedFormulas.length === 0 ? (
                          <p className="text-[11px] text-ink-muted">
                            No approved formulas.
                          </p>
                        ) : (
                          <ul className="space-y-1">
                            {savedFormulas.map((f) => (
                              <li
                                key={f.id}
                                className="flex items-center justify-between gap-2 rounded-md border border-line/60 bg-canvas/70 px-2 py-1"
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-medium">
                                    {f.name}
                                  </p>
                                  <p className="text-[10px] text-ink-muted">
                                    v{f.version || 1} · {f.yieldMl} ml
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="h-7 shrink-0 px-2 text-[11px]"
                                  onClick={() => applyCustomerFormula(f)}
                                >
                                  Reuse
                                </Button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Only cart scrolls — Complete footer stays pinned */}
          <div className="scrollbar-hidden mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
            {quotationMode ? (
              quotationMode.lines.map((line, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-line/70 bg-mist/30 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold">{line.name}</p>
                    <p className="text-xs text-ink-muted">
                      {line.unitLabel} · {line.lineType}
                      {line.formulaName ? ` · ${line.formulaName}` : ""}
                    </p>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-sm font-semibold">{line.qty} ×</span>
                    <p className="text-base font-bold">
                      {formatMoney(line.qty * line.unitPrice)}
                    </p>
                  </div>
                </div>
              ))
            ) : cart.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line bg-mist/40 px-3 py-8 text-center text-sm text-ink-muted">
                Cart is empty — add products or remix
              </div>
            ) : (
              cart.map((line, index) => {
                const gross = line.qty * line.unitPrice;
                const lineDiscount = pricing.lines[index]?.discountAmount ?? 0;
                const shownDiscount = pricing.lines[index]?.discount ?? null;
                return (
                <div
                  key={line.key}
                  className="rounded-lg border border-line/70 bg-mist/30 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold">
                        {line.product.name}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {line.product.sku ? `${line.product.sku} · ` : ""}
                        {line.unitLabel} · {line.lineType}
                        {line.formulaName
                          ? ` · ${line.formulaName}`
                          : line.oilProductName
                            ? ` · oil: ${line.oilProductName}`
                            : ""}
                      </p>
                      {line.bomNote ? (
                        <p className="mt-0.5 text-[10px] text-sage">
                          {line.bomNote}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLine(line.key)}
                      className="shrink-0 text-ink-muted hover:text-coral"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-mist"
                        onClick={() => updateQty(line.key, -1)}
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                      <span className="w-8 text-center text-sm font-semibold">
                        {line.qty}
                      </span>
                      <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-mist"
                        onClick={() => updateQty(line.key, 1)}
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        title="Item discount"
                        aria-label={`Discount ${line.product.name}`}
                        aria-expanded={discountEditor === line.key}
                        className={`ml-1 flex h-7 w-7 items-center justify-center rounded-md border ${
                          line.discount
                            ? "border-gold/50 bg-gold/10 text-gold-deep"
                            : "border-line bg-mist text-ink-muted"
                        }`}
                        onClick={() =>
                          setDiscountEditor((cur) => (cur === line.key ? null : line.key))
                        }
                      >
                        <Tag className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="text-right">
                      {lineDiscount > 0 ? (
                        <p className="text-[11px] tabular-nums text-ink-muted line-through">
                          {formatMoney(gross)}
                        </p>
                      ) : null}
                      <p className="text-base font-bold tabular-nums">
                        {formatMoney(gross - lineDiscount)}
                      </p>
                    </div>
                  </div>
                  {shownDiscount ? (
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-gold-deep">
                      <span>
                        Item discount {discountLabel(shownDiscount)} · −
                        {formatMoney(lineDiscount)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setLineDiscount(line.key, null)}
                        aria-label={`Remove discount on ${line.product.name}`}
                        className="shrink-0 text-ink-muted hover:text-coral"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : null}
                  {discountEditor === line.key ? (
                    <DiscountEditor
                      initial={shownDiscount}
                      base={gross}
                      onApply={(d) => setLineDiscount(line.key, d)}
                      onCancel={() => setDiscountEditor(null)}
                    />
                  ) : null}
                </div>
                );
              })
            )}
          </div>

          {/* Fixed footer — always on screen */}
          <div className="shrink-0 border-t border-line/70 pt-3">
            {!quotationMode && cart.length > 0 ? (
              <div className="mb-2">
                {pricing.invoice ? (
                  <div className="flex items-center justify-between gap-2 text-xs text-gold-deep">
                    <button
                      type="button"
                      onClick={() => setDiscountEditor("invoice")}
                      className="flex min-w-0 items-center gap-1.5 truncate hover:underline"
                    >
                      <Tag className="h-3 w-3 shrink-0" />
                      Bill discount {discountLabel(pricing.invoice)} · −
                      {formatMoney(pricing.invoiceDiscountAmount)}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInvoiceDiscount(null);
                        setDiscountEditor(null);
                      }}
                      aria-label="Remove bill discount"
                      className="shrink-0 text-ink-muted hover:text-coral"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : discountEditor !== "invoice" ? (
                  <button
                    type="button"
                    onClick={() => setDiscountEditor("invoice")}
                    className="flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink"
                  >
                    <Tag className="h-3 w-3" />
                    Add bill discount
                  </button>
                ) : null}
                {discountEditor === "invoice" ? (
                  <DiscountEditor
                    initial={pricing.invoice}
                    base={subtotal - pricing.lineDiscountTotal}
                    onApply={(d) => {
                      setInvoiceDiscount(d);
                      setDiscountEditor(null);
                    }}
                    onCancel={() => setDiscountEditor(null)}
                  />
                ) : null}
              </div>
            ) : null}
            <div className="flex items-end justify-between gap-2">
              <div className="min-w-0 text-[11px] text-ink-muted">
                {quotationMode ? (
                  quotationMode.vatPercent > 0 ? (
                    <>
                      <p>
                        Net {formatMoney(quotationMode.subtotal)} · VAT{" "}
                        {quotationMode.vatPercent}% {formatMoney(quotationMode.vatAmount)}
                      </p>
                      <p className="text-[10px]">Locked to the quotation&apos;s price</p>
                    </>
                  ) : (
                    <p>Subtotal (locked to the quotation&apos;s price)</p>
                  )
                ) : (
                  <>
                    {pricing.discountTotal > 0 ? (
                      <p>
                        Subtotal {formatMoney(subtotal)} · Discount −
                        {formatMoney(pricing.discountTotal)}
                      </p>
                    ) : null}
                    {vatPercent > 0 ? (
                      <>
                        <p>
                          Net {formatMoney(netAmount)} · VAT {vatPercent}%{" "}
                          {formatMoney(vatAmount)}
                        </p>
                        <p className="text-[10px]">Prices include VAT</p>
                      </>
                    ) : pricing.discountTotal > 0 ? null : (
                      <p>Subtotal</p>
                    )}
                    {discountNeedsApproval ? (
                      <p className="font-medium text-coral">
                        {pricing.maxDiscountPct}% discount is over your {discountLimit}%
                        limit — needs manager approval
                      </p>
                    ) : null}
                  </>
                )}
              </div>
              <div className="text-right">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Total</p>
                <p className="font-bold text-3xl tabular-nums leading-none text-ink">
                  {formatMoney(quotationMode ? quotationMode.total : cartTotal)}
                </p>
              </div>
            </div>

            <div className="mt-2.5 grid grid-cols-5 gap-1">
              {payments.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    if (p.id === "mixed") {
                      setMixedOpen(true);
                    } else {
                      setPayment(p.id);
                    }
                  }}
                  className={`flex min-h-10 flex-col items-center justify-center gap-0.5 rounded-lg border px-0.5 py-1 text-[10px] font-semibold transition ${
                    payment === p.id
                      ? "border-ink bg-ink text-canvas"
                      : "border-line bg-mist text-ink-muted hover:border-line-strong"
                  }`}
                >
                  {p.icon}
                  {p.label}
                </button>
              ))}
            </div>

            {payment === "mixed" && mixedBreakdown.length > 0 ? (
              <button
                type="button"
                onClick={() => setMixedOpen(true)}
                className={`mt-1.5 flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[11px] ${
                  mixedBalanced
                    ? "border-line bg-mist/60 text-ink-muted"
                    : "border-red-300 bg-red-50 text-red-700"
                }`}
              >
                <span className="truncate">
                  {mixedBreakdown
                    .map(
                      (e) =>
                        `${e.method.charAt(0).toUpperCase()}${e.method.slice(1)} ${formatMoney(e.amount)}`,
                    )
                    .join(" + ")}
                </span>
                <span className="shrink-0 font-semibold underline">
                  {mixedBalanced ? "Edit" : `${formatMoney(mixedRemaining)} left`}
                </span>
              </button>
            ) : null}

            {!quotationMode ? (
              <Button
                className="mt-2 w-full"
                variant="secondary"
                size="sm"
                disabled={cart.length === 0 || holding || checkingOut}
                onClick={() => void holdBill()}
              >
                <Pause className="h-3.5 w-3.5" />
                Hold bill
              </Button>
            ) : null}

            {!quotationMode && cart.length > 0 ? (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={receiptBusy !== null}
                  onClick={() => printCurrent("thermal")}
                >
                  <Printer className="h-3.5 w-3.5" />
                  {receiptBusy === "print-thermal" ? "…" : "80mm"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={receiptBusy !== null}
                  onClick={() => printCurrent("a4")}
                >
                  <FileText className="h-3.5 w-3.5" />
                  {receiptBusy === "print-a4" ? "…" : "A4"}
                </Button>
              </div>
            ) : null}

            <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={printAfterComplete}
                onChange={(e) => {
                  const on = e.target.checked;
                  setPrintAfterComplete(on);
                  // Send only this field: a full (stale) settings copy would
                  // undo changes saved elsewhere. Cashiers can't save settings.
                  if (settings.data && hasPermission("settings:write")) {
                    void api<AppSettings>("/api/settings", {
                      method: "PUT",
                      body: JSON.stringify({ autoPrintReceipt: on }),
                    })
                      .then((updated) => settings.setData(updated))
                      .catch(() => undefined);
                  }
                }}
                className="h-3.5 w-3.5 accent-[var(--gold,#b8912f)]"
              />
              Print after complete
            </label>

            <Button
              className="cta-glow mt-2 w-full"
              variant="gold"
              disabled={
                quotationMode
                  ? completingQuotation
                  : cart.length === 0 ||
                    checkingOut ||
                    holding ||
                    (payment === "mixed" && !mixedBalanced)
              }
              onClick={() => void (quotationMode ? completeQuotationSale() : checkout())}
            >
              {completingQuotation
                ? "Completing…"
                : `Complete Sale · ${formatMoney(quotationMode ? quotationMode.total : cartTotal)}`}
            </Button>
            {!quotationMode ? (
              <p className="mt-1 text-center text-[10px] text-ink-muted">
                Shortcut · F9
              </p>
            ) : null}

            {/* Held bills dropdown — below Complete */}
            {!quotationMode && heldList.length > 0 ? (
              <div className="relative mt-2">
                <button
                  type="button"
                  onClick={() => setHeldMenuOpen((o) => !o)}
                  className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-mist/50 px-3 text-left text-xs font-medium text-ink transition hover:border-line-strong"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge tone="warning">{heldList.length}</Badge>
                    <span className="truncate">
                      Held ·{" "}
                      {heldList[0].customerName &&
                      heldList[0].customerName !== "Walk-in Customer"
                        ? heldList[0].customerName
                        : heldList[0].customerPhone || "Bill"}
                      {heldList[0].salesperson
                        ? ` · ${heldList[0].salesperson}`
                        : ""}
                      {heldList.length > 1 ? ` (+${heldList.length - 1})` : ""}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 text-ink-muted transition ${
                      heldMenuOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {heldMenuOpen ? (
                  <div className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-72 space-y-1.5 overflow-y-auto rounded-xl border border-line bg-canvas p-2 shadow-lg">
                    <input
                      type="search"
                      value={heldSearch}
                      onChange={(e) => setHeldSearch(e.target.value)}
                      placeholder="Search held bills · name or phone"
                      aria-label="Search held bills"
                      className="h-8 w-full rounded-lg border border-line bg-paper px-2.5 text-xs text-ink outline-none focus:border-gold"
                    />
                    {!heldQuery && (heldBills?.length ?? 0) >= HELD_LIST_LIMIT ? (
                      <p className="px-2 py-1 text-[11px] text-ink-muted">
                        Showing the latest {HELD_LIST_LIMIT} — search to find older bills.
                      </p>
                    ) : null}
                    {heldQuery && !heldSearching && heldMenuList.length === 0 ? (
                      <p className="px-2 py-1.5 text-[11px] text-ink-muted">
                        No held bill matches “{heldQuery}”.
                      </p>
                    ) : null}
                    {cart.length > 0 ? (
                      <p className="px-2 py-1.5 text-[11px] text-ink-muted">
                        Complete or clear the cart before resuming a held bill.
                      </p>
                    ) : null}
                    {heldMenuList.map((sale) => {
                      const lineCount = sale.lines?.length ?? 0;
                      const busy =
                        resumingId === sale.id || discardingId === sale.id;
                      const title =
                        sale.customerName &&
                        sale.customerName !== "Walk-in Customer"
                          ? sale.customerName
                          : sale.customerPhone || "No phone";
                      return (
                        <div
                          key={sale.id}
                          className="rounded-lg border border-line/70 bg-mist/30 px-2.5 py-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-ink">
                                {title}
                              </p>
                              <p className="truncate text-[11px] text-ink-muted">
                                Salesperson:{" "}
                                {sale.salesperson || "Not assigned"}
                              </p>
                              <p className="truncate text-[11px] text-ink-muted">
                                {sale.customerPhone || "—"} · {sale.time || "—"}{" "}
                                · {lineCount} line
                                {lineCount === 1 ? "" : "s"} ·{" "}
                                {formatMoney(sale.total)}
                              </p>
                            </div>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void discardHeld(sale)}
                              className="shrink-0 text-ink-muted hover:text-coral disabled:opacity-40"
                              title="Discard held bill"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <Button
                            className="mt-1.5 w-full"
                            size="sm"
                            variant="secondary"
                            disabled={cart.length > 0 || busy}
                            onClick={() => {
                              setHeldMenuOpen(false);
                              void resumeHeld(sale);
                            }}
                          >
                            <Play className="h-3.5 w-3.5" />
                            {resumingId === sale.id ? "Resuming…" : "Resume"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </Panel>
      </div>

      {approval ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 p-4 sm:items-center"
          onClick={() => !checkingOut && !approvingDiscount && !completingQuotation && setApproval(null)}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="discount-approval-title"
            className="animate-fade-up w-full max-w-sm rounded-2xl border border-line bg-canvas p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !checkingOut && !approvingDiscount && !completingQuotation) setApproval(null);
            }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!approval.email.trim() || !approval.password) {
                setApproval({ ...approval, error: "Enter the approver's email and password" });
                return;
              }
              void approveAndCheckout(approval.email.trim(), approval.password);
            }}
          >
            <h3 id="discount-approval-title" className="font-semibold text-lg text-ink">
              {approval.floorMessage ? "Admin approval" : "Manager approval"}
            </h3>
            <p className="mt-1 text-sm text-ink-muted">
              {approval.floorMessage ? (
                approval.floorMessage
              ) : (
                <>
                  {pricing.maxDiscountPct}% discount (−{formatMoney(pricing.discountTotal)}) is over
                  your {discountLimit}% limit. A manager or owner must approve it.
                </>
              )}
            </p>
            <label className="mt-3 block text-xs font-medium text-ink-muted">
              Approver email
              <input
                type="email"
                autoComplete="off"
                autoFocus
                value={approval.email}
                onChange={(e) => setApproval({ ...approval, email: e.target.value, error: null })}
                className="mt-1 h-9 w-full rounded-lg border border-line bg-paper px-3 text-sm text-ink"
              />
            </label>
            <label className="mt-2 block text-xs font-medium text-ink-muted">
              Password
              <input
                type="password"
                autoComplete="off"
                value={approval.password}
                onChange={(e) =>
                  setApproval({ ...approval, password: e.target.value, error: null })
                }
                className="mt-1 h-9 w-full rounded-lg border border-line bg-paper px-3 text-sm text-ink"
              />
            </label>
            {approval.error ? (
              <p role="alert" className="mt-2 text-xs text-coral">
                {approval.error}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={checkingOut || approvingDiscount || completingQuotation}
                onClick={() => setApproval(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="gold"
                size="sm"
                disabled={checkingOut || approvingDiscount || completingQuotation}
              >
                {checkingOut || approvingDiscount || completingQuotation ? "Approving…" : "Approve & complete"}
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {mixedOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 p-4 sm:items-center"
          onClick={() => setMixedOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMixedOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mixed-payment-title"
            className="animate-fade-up w-full max-w-sm rounded-2xl border border-line bg-canvas p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 id="mixed-payment-title" className="font-semibold text-lg text-ink">
                  Split payment
                </h3>
                <p className="mt-0.5 text-sm text-ink-muted">
                  Bill total {formatMoney(billTotal)} — cover it across a few methods, e.g. half
                  cash, half credit.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMixedOpen(false)}
                className="shrink-0 text-ink-muted hover:text-ink"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-2">
              {MIXED_METHODS.map((m) => (
                <div key={m.id} className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-mist text-ink-muted">
                    {m.icon}
                  </span>
                  <span className="w-12 shrink-0 text-sm font-medium text-ink">{m.label}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={mixedAmounts[m.id]}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/[^0-9.]/g, "");
                      setMixedAmounts((prev) => ({ ...prev, [m.id]: raw }));
                    }}
                    placeholder="0.000"
                    className="h-9 flex-1 rounded-lg border border-line bg-mist px-2.5 text-right text-sm tabular-nums text-ink outline-none focus:border-line-strong"
                  />
                </div>
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between rounded-lg bg-mist/70 px-3 py-2 text-sm">
              <span className="text-ink-muted">
                {mixedRemaining === 0 ? "Balanced" : mixedRemaining > 0 ? "Remaining" : "Over by"}
              </span>
              <span
                className={`font-semibold tabular-nums ${
                  Math.abs(mixedRemaining) < 0.005 ? "text-emerald-600" : "text-red-600"
                }`}
              >
                {formatMoney(Math.abs(mixedRemaining))}
              </span>
            </div>

            <Button
              className="mt-4 w-full"
              variant="gold"
              disabled={!mixedBalanced}
              onClick={() => {
                setPayment("mixed");
                setMixedOpen(false);
              }}
            >
              Use this split
            </Button>
          </div>
        </div>
      ) : null}

      {saleDoneOpen && lastSale ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 p-4 sm:items-center"
          onClick={() => setSaleDoneOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setSaleDoneOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="sale-done-title"
            className="animate-fade-up w-full max-w-md rounded-2xl border border-line bg-canvas p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold-deep">
                <CheckCircle2 className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h3
                  id="sale-done-title"
                  className="font-semibold text-lg text-ink"
                >
                  Sale complete
                </h3>
                <p className="mt-0.5 text-sm text-ink-muted">
                  {formatMoney(lastSale.total)} ·{" "}
                  {formatPaymentLabel(lastSale.payment, lastSale.paymentBreakdown)}
                  {lastSale.customerName
                    ? ` · ${lastSale.customerName}`
                    : lastSale.phone
                      ? ` · ${lastSale.phone}`
                      : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSaleDoneOpen(false)}
                className="text-ink-muted hover:text-ink"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <Button
              className="mt-4 w-full"
              variant="gold"
              onClick={() => {
                setSaleDoneOpen(false);
                searchRef.current?.focus();
              }}
            >
              Next customer
            </Button>

            <p className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
              Receipt options (optional)
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                disabled={receiptBusy !== null}
                onClick={() => void printSale(lastSale, "thermal", false)}
              >
                <Printer className="h-4 w-4" />
                {receiptBusy === "print-thermal" ? "Printing…" : "Print 80mm"}
              </Button>
              <Button
                variant="secondary"
                disabled={receiptBusy !== null}
                onClick={() => void printSale(lastSale, "a4", false)}
              >
                <FileText className="h-4 w-4" />
                {receiptBusy === "print-a4" ? "Printing…" : "A4 / PDF"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void sendReceipt(["whatsapp"])}
              >
                <MessageCircle className="h-4 w-4" />
                WhatsApp
              </Button>
              <Button
                variant="secondary"
                onClick={() => void sendReceipt(["email"])}
              >
                <Mail className="h-4 w-4" />
                Email
              </Button>
              <Button
                variant="secondary"
                disabled={!smsAvailable}
                title={
                  smsAvailable
                    ? undefined
                    : "Set SMS_PROVIDER and Twilio keys to enable SMS"
                }
                onClick={() => void sendReceipt(["sms"])}
              >
                <Smartphone className="h-4 w-4" />
                SMS
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  void sendReceipt(
                    smsAvailable
                      ? ["whatsapp", "email", "sms"]
                      : ["whatsapp", "email"],
                  )
                }
              >
                Send all
              </Button>
            </div>
            {!smsAvailable ? (
              <p className="mt-2 text-center text-[11px] text-ink-muted">
                SMS is off until Twilio keys are set.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
