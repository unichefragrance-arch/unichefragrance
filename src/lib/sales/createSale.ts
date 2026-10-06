import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import {
  applyFifoPlan,
  planFifoDeductions,
  withProductLocks,
  type FifoPlan,
} from "@/lib/inventory";
import { AppSettings, Customer, Sale } from "@/lib/models";
import { loosePhoneRegex, phoneDigits } from "@/lib/phone";
import { SaleError } from "@/lib/sales/errors";
import {
  computeDiscounts,
  exceedsDiscountLimit,
  type DiscountBreakdown,
} from "@/lib/sales/discount";
import {
  cartFingerprint,
  consumeDiscountApproval,
  verifyDiscountApproval,
  type DiscountActor,
  type DiscountApprover,
} from "@/lib/sales/discountApproval";
import {
  checkPriceFloor,
  needsAdminForFloor,
  priceFloorMessage,
} from "@/lib/sales/priceFloor";
import {
  validateSaleLines,
  type IncomingSaleLine,
  type ValidatedSaleLine,
} from "@/lib/sales/validateSale";

export type DeductionAuditEntry = {
  productId: string;
  productName: string;
  qty: number;
  reason: string;
  lineIndex: number;
  batches: Array<{
    layerId: string;
    qty: number;
    unitCost: number;
    purchaseDate: Date;
  }>;
  costTotal: number;
};

export type PaymentSplitInput = { method: string; amount: number };

export type CreateSaleInput = {
  customerPhone: string;
  customerName?: string;
  /** Known CRM id from POS phone match — skips customer upsert round-trip wait. */
  customerId?: string;
  salesperson?: string;
  /** Validated by normalizePayment — absent means cash. */
  payment: unknown;
  /** Required when payment === "mixed" — per-method amounts that must sum to the total. */
  paymentBreakdown?: unknown[];
  lines: IncomingSaleLine[];
  /** POS-070: `{ type: "percent" | "amount", value }` on the bill after line discounts. */
  invoiceDiscount?: unknown;
  /** Logged-in user — their role sets the discount limit (POS-071). */
  actor?: DiscountActor | null;
  /**
   * Single-use token from POST /api/sales/discount-approval when the discount
   * exceeds the actor's limit. Never the manager's password (POS-072 replay).
   */
  discountApprovalToken?: string | null;
  status?: "completed" | "held" | "void";
  /**
   * POS-098: the held bill this cart was resumed from. Completing closes that
   * bill in the same transaction (only if it is still held — so one held bill
   * can never become two sales); re-holding updates it in place.
   */
  resumedFromId?: string | null;
  idempotencyKey?: string;
  /**
   * Who owns the idempotency key when there is no `actor` (server-side callers
   * such as stock adjustments). Keys are scoped per user + branch.
   */
  idempotencyOwner?: string;
  /** BRN-08: stamp from session when present */
  branchId?: string | null;
  branchName?: string | null;
};

/** Primary-only ack — much faster than connection-string w=majority on Atlas. */
export const FAST_WC = { w: 1 as const, j: false };

function isDuplicateKey(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
}

/**
 * POS-093/094: the salesperson travels with each bill (one till's choice never
 * affects another). It must be on the Settings → Sales Team list — an unknown
 * name is rejected, not silently swapped. Only a bill with no salesperson
 * falls back to the store default (`activeSalesperson`).
 * Read fresh every time (not cached): a salesperson removed in Settings must
 * stop being accepted at once, on every server instance. Checkout runs this
 * alongside line validation, so it adds no latency.
 */
export async function resolveSalesperson(value?: unknown): Promise<string> {
  if (value != null && typeof value !== "string") {
    throw new SaleError("VALIDATION", "Salesperson must be a name");
  }
  const requested = typeof value === "string" ? value.trim() : "";
  await connectDB();
  const settings = await AppSettings.findOne({ key: "default" })
    .select("salespeople activeSalesperson")
    .lean<{ salespeople?: unknown[]; activeSalesperson?: string }>();
  const salespeople = Array.isArray(settings?.salespeople)
    ? settings.salespeople.map((name) => String(name).trim()).filter(Boolean)
    : [];
  if (salespeople.length === 0) {
    throw new SaleError("VALIDATION", "Add a salesperson in Settings → Sales Team");
  }
  const find = (name: string) =>
    salespeople.find((s) => s.toLowerCase() === name.toLowerCase());

  if (requested) {
    const matched = find(requested);
    if (matched) return matched;
    throw new SaleError("VALIDATION", `Unknown salesperson: ${requested}`);
  }
  const active = find(String(settings?.activeSalesperson ?? "").trim());
  if (active) return active;
  throw new SaleError("VALIDATION", "Select a salesperson (Settings → Sales Team)");
}

/** CRM-02/CRM-12: capture what a customer buys at order time — no manual re-entry in CRM. */
function productNamesFromLines(lines: ValidatedSaleLine[]): string[] {
  const names = new Set<string>();
  for (const l of lines) {
    const name = l.name?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

type CustomerTouchUpdate = {
  $set?: Record<string, unknown>;
  $inc?: Record<string, unknown>;
  $addToSet?: Record<string, unknown>;
};

/**
 * CRM-11: match the existing customer by phone (format-tolerant — "+971 50 123 4567"
 * and "971501234567" are the same person) before creating a new profile, so the same
 * person's orders on different dates (e.g. the 12th and the 19th) land in one history
 * instead of splitting across duplicate customers.
 */
export async function resolveCustomerByPhone(
  phone: string,
  givenName: string | undefined,
  update: CustomerTouchUpdate,
  session?: mongoose.ClientSession,
): Promise<mongoose.Types.ObjectId> {
  const digits = phoneDigits(phone);
  const filter =
    digits.length >= 7 ? { phone: { $regex: loosePhoneRegex(digits) } } : { phone };
  // Inside a transaction the commit carries the write concern, not each op.
  const writeOpts = session ? { session } : { writeConcern: FAST_WC };

  const existing = await Customer.findOne(filter, null, session ? { session } : {}).select("_id");
  if (existing) {
    await Customer.updateOne({ _id: existing._id }, update, writeOpts);
    return existing._id as mongoose.Types.ObjectId;
  }

  const created = await Customer.findOneAndUpdate(
    { phone },
    {
      $setOnInsert: {
        phone,
        preferences: [] as string[],
        ...(givenName ? {} : { name: "Walk-in Customer" }),
      },
      ...update,
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
      ...writeOpts,
    },
  );
  if (!created) {
    throw new SaleError("VALIDATION", "Could not resolve customer");
  }
  return created._id as mongoose.Types.ObjectId;
}

function coalesceDeductions(
  deductions: Awaited<ReturnType<typeof validateSaleLines>>["deductions"],
) {
  const map = new Map<
    string,
    {
      productId: string;
      productName: string;
      qty: number;
      reason: string;
      lineIndex: number;
    }
  >();
  for (const need of deductions) {
    const cur = map.get(need.productId);
    if (cur) {
      cur.qty += need.qty;
      cur.reason = `${cur.reason}+${need.reason}`;
    } else {
      map.set(need.productId, { ...need });
    }
  }
  return [...map.values()];
}

/** Read-only: stock check + FIFO plan + the audit entries the sale will store. */
async function planDeductions(
  deductions: Awaited<ReturnType<typeof validateSaleLines>>["deductions"],
  session: mongoose.ClientSession,
): Promise<{ plan: FifoPlan | null; audit: DeductionAuditEntry[] }> {
  const coalesced = coalesceDeductions(deductions);
  if (coalesced.length === 0) return { plan: null, audit: [] };

  const plan = await planFifoDeductions(
    coalesced.map((n) => ({
      productId: n.productId,
      qty: n.qty,
      productName: n.productName,
    })),
    session,
  );

  const audit = coalesced.map((need) => {
    const result = plan.results.get(need.productId) ?? { costTotal: 0, batches: [] };
    return {
      productId: need.productId,
      productName: need.productName,
      qty: need.qty,
      reason: need.reason,
      lineIndex: need.lineIndex,
      batches: result.batches,
      costTotal: result.costTotal,
    };
  });
  return { plan, audit };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


function resolveSaleType(lines: ValidatedSaleLine[]) {
  const types = new Set(lines.map((l) => l.lineType));
  if (types.has("remix")) return "Remix";
  if (types.has("oil")) return "Oil";
  if (types.has("refill")) return "Refill";
  if (types.has("wholesale")) return "Wholesale";
  if (types.size > 1) return "Mixed";
  return "Retail";
}

export const PAYMENT_METHODS = new Set(["cash", "card", "bank", "credit", "mixed"]);
const SPLIT_METHODS = new Set(["cash", "card", "bank", "credit"]);

/**
 * A bill with no payment field is cash (existing default). Anything sent must
 * be one of the known methods — an unknown value is rejected, never recorded
 * as cash. Case-insensitive; padding/whitespace variants are not accepted.
 */
export function normalizePayment(value: unknown): string {
  if (value === undefined) return "cash";
  if (typeof value !== "string" || !PAYMENT_METHODS.has(value.toLowerCase())) {
    throw new SaleError("VALIDATION", "Invalid payment method");
  }
  return value.toLowerCase();
}

/**
 * Validates and normalizes a mixed-payment breakdown against the sale total.
 * Held bills (whose total may still change) skip the sum check.
 */
export function normalizePaymentBreakdown(
  payment: string,
  breakdown: readonly unknown[] | undefined,
  total: number,
  requireBalanced: boolean,
): { method: string; amount: number }[] {
  if (payment !== "mixed") return [];
  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    throw new SaleError("VALIDATION", "Mixed payment needs a breakdown of amounts");
  }
  const byMethod = new Map<string, number>();
  for (const entry of breakdown) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SaleError("VALIDATION", "Invalid payment breakdown entry");
    }
    const raw = entry as { method?: unknown; amount?: unknown };
    const method = typeof raw.method === "string" ? raw.method.toLowerCase() : "";
    if (!SPLIT_METHODS.has(method)) {
      throw new SaleError("VALIDATION", "Invalid payment method in breakdown");
    }
    const amount = raw.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new SaleError("VALIDATION", `Invalid amount for ${method} in breakdown`);
    }
    if (amount === 0) continue;
    byMethod.set(method, (byMethod.get(method) || 0) + amount);
  }
  const normalized = [...byMethod.entries()].map(([method, amount]) => ({
    method,
    amount: Math.round(amount * 1000) / 1000,
  }));
  if (normalized.length === 0) {
    throw new SaleError("VALIDATION", "Mixed payment needs at least one method with an amount");
  }
  if (requireBalanced) {
    const sum = normalized.reduce((s, e) => s + e.amount, 0);
    if (Math.abs(sum - total) > 0.01) {
      throw new SaleError(
        "VALIDATION",
        `Mixed payment amounts (${sum.toFixed(3)}) don't match the total (${total.toFixed(3)})`,
      );
    }
  }
  return normalized;
}

export function creditPortion(payment: string, subtotal: number, breakdown: { method: string; amount: number }[]) {
  if (payment === "credit") return subtotal;
  if (payment === "mixed") {
    return breakdown.find((e) => e.method === "credit")?.amount || 0;
  }
  return 0;
}

function asObjectId(id?: string) {
  if (id && mongoose.isValidObjectId(id)) {
    return new mongoose.Types.ObjectId(id);
  }
  return undefined;
}

/**
 * Discounts are keyed by the incoming line index (validated lines keep the same
 * order). `subtotal` may exceed Σ qty × unitPrice (refill packaging is charged
 * on top) — that remainder is only reachable by the invoice discount.
 */
export function discountsFor(
  lines: ValidatedSaleLine[],
  rawLines: IncomingSaleLine[],
  invoiceDiscount: unknown,
  subtotal: number,
): DiscountBreakdown {
  const lineGross = lines.map((l) => l.qty * l.unitPrice);
  const extraGross = Math.max(0, subtotal - lineGross.reduce((s, g) => s + g, 0));
  return computeDiscounts(
    lines.map((_, i) => ({ gross: lineGross[i], discount: rawLines[i]?.discount })),
    invoiceDiscount,
    extraGross,
  );
}

function discountFields(breakdown: DiscountBreakdown) {
  return {
    subtotal: breakdown.subtotal,
    ...(breakdown.invoiceDiscount
      ? {
          invoiceDiscountType: breakdown.invoiceDiscount.type,
          invoiceDiscountValue: breakdown.invoiceDiscount.value,
        }
      : {}),
    invoiceDiscountAmount: breakdown.invoiceDiscountAmount,
    discountTotal: breakdown.discountTotal,
    total: breakdown.total,
  };
}

/** Native insert needs ObjectIds — mongoose casting is skipped. */
function linesForInsert(lines: ValidatedSaleLine[], breakdown: DiscountBreakdown) {
  return lines.map((l, i) => ({
    productId: asObjectId(l.productId),
    name: l.name,
    qty: l.qty,
    unitLabel: l.unitLabel,
    unitPrice: l.unitPrice,
    lineType: l.lineType,
    bomNote: l.bomNote,
    deductMl: l.deductMl,
    oilProductId: asObjectId(l.oilProductId),
    oilMl: l.oilMl,
    formulaId: asObjectId(l.formulaId),
    packagingProductIds: Array.isArray(l.packagingProductIds)
      ? l.packagingProductIds
          .filter((id) => mongoose.isValidObjectId(id))
          .map((id) => new mongoose.Types.ObjectId(id))
      : [],
    ...(breakdown.lines[i]?.discount
      ? {
          discountType: breakdown.lines[i].discount!.type,
          discountValue: breakdown.lines[i].discount!.value,
        }
      : {}),
    discountAmount: breakdown.lines[i]?.discountAmount ?? 0,
  }));
}

function auditForInsert(audit: DeductionAuditEntry[]) {
  return audit.map((a) => ({
    productId: new mongoose.Types.ObjectId(a.productId),
    productName: a.productName,
    qty: a.qty,
    reason: a.reason,
    lineIndex: a.lineIndex,
    costTotal: a.costTotal,
    batches: a.batches.map((b) => ({
      layerId: new mongoose.Types.ObjectId(b.layerId),
      qty: b.qty,
      unitCost: b.unitCost,
      purchaseDate: b.purchaseDate,
    })),
  }));
}

/**
 * A client-sent customerId is honoured only when that customer's phone is the
 * bill's phone — otherwise any cashier could charge a sale (or credit) to, and
 * rename, an arbitrary customer. A mismatch falls back to lookup by phone.
 */
export async function trustedCustomerId(
  id: string | undefined,
  phone: string,
): Promise<string | null> {
  if (!id || !mongoose.isValidObjectId(id)) return null;
  const customer = await Customer.findById(id)
    .select("phone")
    .lean<{ _id: unknown; phone?: string }>();
  if (!customer) return null;
  const want = phoneDigits(phone);
  return want.length > 0 && phoneDigits(customer.phone ?? "") === want
    ? String(customer._id)
    : null;
}

/** Held bills a session may reach: its own branch plus legacy unbranched ones. */
function heldBranchFilter(branchId?: string | null): Record<string, unknown> {
  const oid = asObjectId(branchId ?? undefined);
  return oid
    ? { $or: [{ branchId: oid }, { branchId: null }, { branchId: { $exists: false } }] }
    : {};
}

/**
 * POS-097: hold = the same server-side validation and pricing as checkout
 * (products must exist, prices come from the catalogue, never the client) but
 * no stock check or deduction and no approval — those happen on completion.
 * Re-holding a resumed bill updates that bill in place instead of leaving a
 * second copy behind.
 */
async function holdSale(input: CreateSaleInput) {
  await connectDB();
  if (!input.customerPhone?.trim()) {
    throw new SaleError("VALIDATION", "Customer phone is required");
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new SaleError("VALIDATION", "At least one line item is required");
  }
  const phone = input.customerPhone.trim();

  const [salesperson, validated, knownId] = await Promise.all([
    resolveSalesperson(input.salesperson),
    validateSaleLines(input.lines),
    trustedCustomerId(input.customerId, phone),
  ]);
  const { lines, subtotal } = validated;
  // Validated (bad input rejected) but not approved — approval happens at checkout.
  const breakdown = discountsFor(lines, input.lines, input.invoiceDiscount, subtotal);

  const givenName = input.customerName?.trim();
  const productNames = productNamesFromLines(lines);
  const touch = {
    ...(givenName ? { $set: { name: givenName } } : {}),
    ...(productNames.length > 0
      ? { $addToSet: { productsRequested: { $each: productNames } } }
      : {}),
  };

  let customerId: mongoose.Types.ObjectId;
  if (knownId) {
    customerId = new mongoose.Types.ObjectId(knownId);
    void Customer.updateOne({ _id: customerId }, touch, { writeConcern: FAST_WC }).catch(() => {
      /* non-blocking */
    });
  } else {
    customerId = await resolveCustomerByPhone(phone, givenName, touch);
  }

  const payment = normalizePayment(input.payment);
  // Held total may still change once resumed, so the split doesn't need to balance yet.
  const paymentBreakdown = normalizePaymentBreakdown(payment, input.paymentBreakdown, subtotal, false);
  const displayName = givenName || "Walk-in Customer";
  const now = new Date();
  const fields = {
    customerPhone: phone,
    customerName: displayName,
    customerId,
    salesperson,
    payment,
    paymentBreakdown,
    status: "held" as const,
    lines: linesForInsert(lines, breakdown),
    ...discountFields(breakdown),
    invoiceDiscountType: breakdown.invoiceDiscount?.type ?? null,
    invoiceDiscountValue: breakdown.invoiceDiscount?.value ?? null,
    saleType: resolveSaleType(lines),
    inventoryDeductions: [],
    ...(asObjectId(input.branchId ?? undefined)
      ? { branchId: asObjectId(input.branchId ?? undefined) }
      : {}),
    ...(input.branchName ? { branchName: input.branchName } : {}),
    updatedAt: now,
  };

  const resumedId = asObjectId(input.resumedFromId ?? undefined);
  if (resumedId) {
    const updated = await Sale.collection.findOneAndUpdate(
      { _id: resumedId, status: "held", ...heldBranchFilter(input.branchId) },
      { $set: fields },
      { returnDocument: "after", writeConcern: FAST_WC },
    );
    if (updated) {
      return {
        sale: { ...updated, id: String(resumedId) },
        deduplicated: false as const,
        timingMs: undefined,
      };
    }
    // Completed or discarded elsewhere meanwhile — keep this cart as a new bill.
  }

  const _id = new mongoose.Types.ObjectId();
  const doc = { _id, ...fields, createdAt: now };
  await Sale.collection.insertOne(doc, { writeConcern: FAST_WC });

  return {
    sale: { ...doc, id: String(_id) },
    deduplicated: false as const,
    timingMs: undefined as
      | {
          total: number;
          validate: number;
          stock: number;
          insert: number;
        }
      | undefined,
  };
}

/**
 * POS-146b: a client key is only meaningful for the user + branch that sent
 * it. Scoping the stored key means another till can never collide with (or
 * read back) this till's sale through a reused key.
 */
export function scopedIdempotencyKey(
  clientKey: string | undefined,
  userId: string | undefined,
  branchId: string | null | undefined,
): string | undefined {
  if (!clientKey) return undefined;
  return `u:${userId || "-"}|b:${branchId || "-"}|k:${clientKey}`;
}

type FingerprintSource = {
  customerPhone?: unknown;
  salesperson?: unknown;
  payment?: unknown;
  paymentBreakdown?: Array<{ method?: unknown; amount?: unknown }> | null;
  lines?: Array<Record<string, unknown>> | null;
  invoiceDiscountType?: unknown;
  invoiceDiscountValue?: unknown;
  resumedFromId?: unknown;
};

/**
 * What a checkout charged, from the stored-sale shape (linesForInsert output
 * or a sale document) — so a retry can be compared with the sale it made.
 */
export function checkoutFingerprint(d: FingerprintSource): string {
  const id = (v: unknown) => (v ? String(v) : "");
  const lines = (d.lines ?? []).map((l) => ({
    p: id(l.productId),
    q: Number(l.qty),
    t: String(l.lineType ?? ""),
    u: String(l.unitLabel ?? ""),
    o: id(l.oilProductId),
    f: id(l.formulaId),
    k: (Array.isArray(l.packagingProductIds) ? l.packagingProductIds : []).map(String).sort(),
    d: l.discountType ? [String(l.discountType), Number(l.discountValue)] : null,
  }));
  const split = (d.paymentBreakdown ?? [])
    .map((e) => `${String(e.method)}:${Number(e.amount)}`)
    .sort();
  return createHash("sha256")
    .update(
      JSON.stringify({
        ph: String(d.customerPhone ?? ""),
        sp: String(d.salesperson ?? ""),
        pay: String(d.payment ?? ""),
        split,
        lines,
        inv: d.invoiceDiscountType ? [String(d.invoiceDiscountType), Number(d.invoiceDiscountValue)] : null,
        r: id(d.resumedFromId),
      }),
    )
    .digest("hex");
}

/** Sales stored before keys were scoped carry the raw client key. */
const LEGACY_KEY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A retry that spans the deploy of scoped keys: the earlier attempt was
 * stored under the raw key, with no owner recorded. It is returned only when
 * it is recent, from the same branch and the identical bill — anything else is
 * ignored (never revealed), and this checkout proceeds as a new sale.
 */
async function findLegacyRetry(
  clientKey: string,
  branchId: string | null | undefined,
  fingerprint: string,
) {
  const legacy = await Sale.findOne({
    idempotencyKey: clientKey,
    createdAt: { $gte: new Date(Date.now() - LEGACY_KEY_WINDOW_MS) },
  }).lean<Record<string, unknown>>();
  if (!legacy) return null;
  if (String(legacy.branchId ?? "") !== String(branchId ?? "")) return null;
  if (checkoutFingerprint(legacy as FingerprintSource) !== fingerprint) return null;
  return {
    sale: { ...legacy, id: String(legacy._id) },
    deduplicated: true as const,
    timingMs: undefined,
  };
}

/**
 * The key was already used by this user + branch: the same bill gets the
 * original sale back; a different bill is refused (409) — never a second sale.
 */
function replayOrConflict(existing: Record<string, unknown>, fingerprint: string) {
  if (checkoutFingerprint(existing as FingerprintSource) !== fingerprint) {
    throw new SaleError(
      "IDEMPOTENCY_CONFLICT",
      "This checkout was already completed with different details. The earlier sale stands and this cart was not charged.",
      { saleId: String(existing._id) },
    );
  }
  return {
    sale: { ...existing, id: String(existing._id) },
    deduplicated: true as const,
    timingMs: undefined,
  };
}

/**
 * POS complete — validate, then ONE Mongo transaction for every write:
 * FIFO stock deduction + customer stats + sale insert commit together or not
 * at all. A crash or error mid-way can no longer leave stock deducted with no
 * sale recorded (the old best-effort compensating rollback could).
 * Inside it: reads + FIFO plan first, then customer + sale, then the hot
 * product/layer bulk writes last so concurrent sales conflict as little as
 * possible; conflicts retry with jittered backoff.
 */
export async function createSale(input: CreateSaleInput) {
  const status = input.status ?? "completed";
  if (status === "held") return holdSale(input);
  // POS-142b: the only stock-consuming outcome is a completed sale. The insert
  // below is a native driver call (no schema enum), so guard every caller here.
  if (status !== "completed") {
    throw new SaleError("VALIDATION", "Invalid sale status — checkout can only complete or hold a bill");
  }

  const t0 = Date.now();
  await connectDB();

  if (!input.customerPhone?.trim()) {
    throw new SaleError("VALIDATION", "Customer phone is required");
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new SaleError("VALIDATION", "At least one line item is required");
  }

  const phone = input.customerPhone.trim();
  const actor = input.actor ?? null;
  const clientKey = input.idempotencyKey?.trim() || undefined;
  const idempotencyKey = scopedIdempotencyKey(
    clientKey,
    actor?.userId ?? input.idempotencyOwner,
    input.branchId,
  );
  const givenName = input.customerName?.trim();
  const payment = normalizePayment(input.payment);
  const resumedFromId = input.resumedFromId ? asObjectId(input.resumedFromId) : undefined;
  if (input.resumedFromId && !resumedFromId) {
    throw new SaleError("VALIDATION", "Invalid held bill id");
  }

  const [salesperson, validated, knownCustomerId] = await Promise.all([
    resolveSalesperson(input.salesperson),
    validateSaleLines(input.lines),
    trustedCustomerId(input.customerId, phone),
  ]);
  const breakdown = discountsFor(
    validated.lines,
    input.lines,
    input.invoiceDiscount,
    validated.subtotal,
  );
  // Mixed payment must cover the amount actually charged — after discounts.
  const paymentBreakdown = normalizePaymentBreakdown(
    payment,
    input.paymentBreakdown,
    breakdown.total,
    true,
  );
  // POS-154: a retry of a key this user + branch already used is answered from
  // the stored sale before approvals are re-checked (a used approval token must
  // not turn a lost-response retry into an error).
  const fingerprint = checkoutFingerprint({
    customerPhone: phone,
    salesperson,
    payment,
    paymentBreakdown,
    lines: linesForInsert(validated.lines, breakdown),
    invoiceDiscountType: breakdown.invoiceDiscount?.type,
    invoiceDiscountValue: breakdown.invoiceDiscount?.value,
    resumedFromId,
  });
  if (idempotencyKey) {
    const existing = await Sale.findOne({ idempotencyKey }).lean<Record<string, unknown>>();
    if (existing) return replayOrConflict(existing, fingerprint);
    const legacy = await findLegacyRetry(clientKey!, input.branchId, fingerprint);
    if (legacy) return legacy;
  }
  // POS-060..067: the final price (server price − every discount) is checked
  // against cost + minimum margin here, never trusting a client flag.
  const floorViolations = await checkPriceFloor(validated, breakdown);
  const priceFloor = needsAdminForFloor(floorViolations, actor?.role)
    ? { message: priceFloorMessage(floorViolations) }
    : null;
  const needsApproval =
    (breakdown.discountTotal > 0 && exceedsDiscountLimit(breakdown, actor?.role)) ||
    priceFloor !== null;
  const approvalToken = needsApproval ? String(input.discountApprovalToken ?? "") : "";
  const approver: DiscountApprover | null = needsApproval
    ? await verifyDiscountApproval(
        approvalToken,
        breakdown,
        actor,
        cartFingerprint(input.lines, input.invoiceDiscount),
        priceFloor,
      )
    : null;
  const creditAmount = creditPortion(payment, breakdown.total, paymentBreakdown);
  const tValidate = Date.now();

  const productNames = productNamesFromLines(validated.lines);
  const customerUpdate: CustomerTouchUpdate = {
    $set: {
      lastVisit: new Date(),
      ...(givenName ? { name: givenName } : {}),
    },
    $inc: {
      totalPurchases: breakdown.total,
      ...(creditAmount > 0 ? { creditBalance: creditAmount } : {}),
    },
    // CRM-02/CRM-12: what they bought becomes "Products Requested" automatically.
    ...(productNames.length > 0
      ? { $addToSet: { productsRequested: { $each: productNames } } }
      : {}),
  };

  const _id = new mongoose.Types.ObjectId();
  let audit: DeductionAuditEntry[] = [];
  let saleDoc: Record<string, unknown> = {};
  let tStock = tValidate;

  const session = await mongoose.startSession();
  try {
    // withTransaction retries the callback on transient errors (e.g. write
    // conflicts), so everything it produces is (re)assigned inside it.
    let attempt = 0;
    await withProductLocks(
      validated.deductions.map((d) => d.productId),
      () => session.withTransaction(
      async () => {
        // Retry after a write conflict: random backoff so concurrent sales
        // touching the same components don't immediately collide again.
        if (attempt++ > 0) {
          await sleep(Math.random() * Math.min(250, 10 * 2 ** attempt));
        }
        // 1) Reads only — stock check + FIFO plan against this snapshot.
        const planned = await planDeductions(validated.deductions, session);
        audit = planned.audit;

        let customerObjectId: mongoose.Types.ObjectId;
        if (knownCustomerId) {
          customerObjectId = new mongoose.Types.ObjectId(knownCustomerId);
          await Customer.updateOne({ _id: customerObjectId }, customerUpdate, {
            session,
          });
        } else {
          customerObjectId = await resolveCustomerByPhone(
            phone,
            givenName,
            customerUpdate,
            session,
          );
        }
        tStock = Date.now();

        const now = new Date();
        saleDoc = {
          _id,
          customerPhone: phone,
          customerName: givenName || "Walk-in",
          customerId: customerObjectId,
          salesperson,
          payment,
          ...(paymentBreakdown.length > 0 ? { paymentBreakdown } : {}),
          status,
          lines: linesForInsert(validated.lines, breakdown),
          ...discountFields(breakdown),
          ...(breakdown.discountTotal > 0 && actor?.userId
            ? {
                discountAppliedBy: {
                  userId: asObjectId(actor.userId),
                  name: actor.name,
                  role: actor.role,
                },
              }
            : {}),
          ...(approver
            ? {
                discountApprovedBy: {
                  userId: new mongoose.Types.ObjectId(approver.userId),
                  name: approver.name,
                  role: approver.role,
                },
              }
            : {}),
          saleType: resolveSaleType(validated.lines),
          ...(resumedFromId ? { resumedFromId } : {}),
          // Omit when absent: the native driver would store null, and the
          // sparse unique index treats null as a value — so the 2nd keyless
          // sale would fail with E11000.
          ...(idempotencyKey ? { idempotencyKey } : {}),
          inventoryDeductions: auditForInsert(audit),
          // ObjectId, like every other branch-stamped document — the reports
          // and branch filters match on ObjectId (a string never matched).
          ...(asObjectId(input.branchId ?? undefined)
            ? { branchId: asObjectId(input.branchId ?? undefined) }
            : {}),
          ...(input.branchName ? { branchName: input.branchName } : {}),
          createdAt: now,
          updatedAt: now,
        };
        // Insert before consuming the approval: a duplicate checkout (same
        // idempotency key) fails here with E11000 and gets the original sale,
        // instead of failing on an approval its twin already used.
        await Sale.collection.insertOne(saleDoc, { session });
        if (resumedFromId) {
          // Atomic claim: if another till already completed or discarded this
          // bill, nothing matches and the whole sale rolls back.
          const closed = await Sale.collection.updateOne(
            { _id: resumedFromId, status: "held", ...heldBranchFilter(input.branchId) },
            { $set: { status: "void", completedSaleId: _id, updatedAt: new Date() } },
            { session },
          );
          if (closed.matchedCount === 0) {
            throw new SaleError(
              "HELD_BILL_UNAVAILABLE",
              "This held bill was already completed or discarded on another till",
            );
          }
        }
        if (approver) await consumeDiscountApproval(approvalToken, _id, session);
        // 2) Hot stock/layer writes last, just before commit (see planFifoDeductions).
        if (planned.plan) await applyFifoPlan(planned.plan, session);
      },
      // Primary-only commit ack — same latency trade-off as before (FAST_WC).
      { writeConcern: FAST_WC },
      ),
    );
  } catch (err) {
    // Same idempotency key already committed (double-click / retry): the
    // transaction aborted, so nothing was deducted twice — return the original.
    if (idempotencyKey && isDuplicateKey(err)) {
      const dup = await Sale.findOne({ idempotencyKey }).lean<Record<string, unknown>>();
      if (dup) return replayOrConflict(dup, fingerprint);
    }
    throw err;
  } finally {
    await session.endSession();
  }

  // costFifo was already updated inside the transaction (planFifoDeductions) —
  // no post-commit write to the same hot product documents.

  const timingMs = {
    total: Date.now() - t0,
    validate: tValidate - t0,
    stock: tStock - tValidate,
    insert: Date.now() - tStock,
  };
  if (timingMs.total > 2000) {
    console.warn("[createSale] slow POS complete", timingMs);
  }

  return {
    sale: { ...saleDoc, id: String(_id) },
    deduplicated: false as const,
    timingMs,
  };
}
