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
  payment: string;
  /** Required when payment === "mixed" — per-method amounts that must sum to the total. */
  paymentBreakdown?: PaymentSplitInput[];
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
  idempotencyKey?: string;
  /** BRN-08: stamp from session when present */
  branchId?: string | null;
  branchName?: string | null;
};

/** Short TTL cache — AppSettings rarely changes during a POS shift. */
let salespersonCache:
  | { at: number; salespeople: string[]; active: string }
  | null = null;
const SALESPERSON_CACHE_MS = 120_000;

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

async function resolveSalesperson(value?: string) {
  const now = Date.now();
  if (!salespersonCache || now - salespersonCache.at > SALESPERSON_CACHE_MS) {
    const settings = await AppSettings.findOne({ key: "default" })
      .select("salespeople activeSalesperson")
      .lean();
    const configured = Array.isArray(settings?.salespeople)
      ? settings.salespeople
          .map((name: unknown) => String(name).trim())
          .filter(Boolean)
      : [];
    if (configured.length === 0) {
      throw new SaleError(
        "VALIDATION",
        "Set an active salesperson in Settings → Sales Team",
      );
    }
    const active = String(
      (settings as { activeSalesperson?: string } | null)?.activeSalesperson ||
        "",
    ).trim();
    salespersonCache = { at: now, salespeople: configured, active };
  }

  const { salespeople, active } = salespersonCache;
  const activeMatch = salespeople.find(
    (name: string) => name.toLowerCase() === active.toLowerCase(),
  );
  if (activeMatch) return activeMatch;

  const requested = value?.trim();
  if (requested) {
    const matched = salespeople.find(
      (name: string) => name.toLowerCase() === requested.toLowerCase(),
    );
    if (matched) return matched;
    throw new SaleError("VALIDATION", `Unknown salesperson: ${requested}`);
  }

  throw new SaleError(
    "VALIDATION",
    "Set an active salesperson in Settings → Sales Team",
  );
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

function normalizePayment(value: string): string {
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

const SPLIT_METHODS = new Set(["cash", "card", "bank", "credit"]);

/**
 * Validates and normalizes a mixed-payment breakdown against the sale total.
 * Held bills (whose total may still change) skip the sum check.
 */
function normalizePaymentBreakdown(
  payment: string,
  breakdown: PaymentSplitInput[] | undefined,
  total: number,
  requireBalanced: boolean,
): { method: string; amount: number }[] {
  if (payment !== "mixed") return [];
  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    throw new SaleError("VALIDATION", "Mixed payment needs a breakdown of amounts");
  }
  const byMethod = new Map<string, number>();
  for (const entry of breakdown) {
    const method = (entry.method || "").toLowerCase();
    if (!SPLIT_METHODS.has(method)) {
      throw new SaleError("VALIDATION", `Invalid payment method in breakdown: ${entry.method}`);
    }
    const amount = Number(entry.amount);
    if (!Number.isFinite(amount) || amount < 0) {
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

function creditPortion(payment: string, subtotal: number, breakdown: { method: string; amount: number }[]) {
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

const HELD_LINE_TYPES = new Set([
  "ready",
  "remix",
  "oil",
  "refill",
  "packaging",
  "wholesale",
]);

async function holdSale(input: CreateSaleInput) {
  await connectDB();
  const salesperson = await resolveSalesperson(input.salesperson);

  if (!input.customerPhone?.trim()) {
    throw new SaleError("VALIDATION", "Customer phone is required");
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new SaleError("VALIDATION", "At least one line item is required");
  }

  const phone = input.customerPhone.trim();
  const lines: ValidatedSaleLine[] = [];
  let subtotal = 0;

  for (let i = 0; i < input.lines.length; i++) {
    const raw = input.lines[i];
    const qty = Number(raw.qty);
    // Same whole-unit rule as checkout, so a held bill can always be completed.
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new SaleError("INVALID_LINE", `Invalid quantity for line ${i + 1}`);
    }
    if (!HELD_LINE_TYPES.has(raw.lineType)) {
      throw new SaleError("INVALID_LINE", `Invalid line type: ${raw.lineType}`);
    }
    const unitPrice = Number(raw.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new SaleError("INVALID_LINE", `Invalid price for line ${i + 1}`);
    }
    const name = (raw.name || "").trim() || "Item";
    lines.push({
      productId: raw.productId,
      name,
      qty,
      unitLabel: raw.unitLabel || "pcs",
      unitPrice,
      lineType: raw.lineType as ValidatedSaleLine["lineType"],
      bomNote: raw.bomNote,
      deductMl: raw.deductMl,
      oilProductId: raw.oilProductId,
      oilMl: raw.oilMl,
      packagingProductIds: raw.packagingProductIds,
      formulaId: raw.formulaId,
    });
    subtotal += qty * unitPrice;
  }
  // Validated (bad input rejected) but not approved — approval happens at checkout.
  const breakdown = discountsFor(lines, input.lines, input.invoiceDiscount, subtotal);

  const givenName = input.customerName?.trim();
  const knownId =
    input.customerId && mongoose.isValidObjectId(input.customerId)
      ? input.customerId
      : null;
  const productNames = productNamesFromLines(lines);

  let customerId: mongoose.Types.ObjectId;
  if (knownId) {
    customerId = new mongoose.Types.ObjectId(knownId);
    void Customer.updateOne(
      { _id: customerId },
      {
        ...(givenName ? { $set: { name: givenName } } : {}),
        ...(productNames.length > 0
          ? { $addToSet: { productsRequested: { $each: productNames } } }
          : {}),
      },
      { writeConcern: FAST_WC },
    ).catch(() => {
      /* non-blocking */
    });
  } else {
    customerId = await resolveCustomerByPhone(phone, givenName, {
      ...(givenName ? { $set: { name: givenName } } : {}),
      ...(productNames.length > 0
        ? { $addToSet: { productsRequested: { $each: productNames } } }
        : {}),
    });
  }

  const payment = normalizePayment(input.payment);
  // Held total may still change once resumed, so the split doesn't need to balance yet.
  const paymentBreakdown = normalizePaymentBreakdown(payment, input.paymentBreakdown, subtotal, false);
  const displayName = givenName || "Walk-in Customer";
  const now = new Date();
  const _id = new mongoose.Types.ObjectId();
  const doc = {
    _id,
    customerPhone: phone,
    customerName: displayName,
    customerId,
    salesperson,
    payment,
    ...(paymentBreakdown.length > 0 ? { paymentBreakdown } : {}),
    status: "held" as const,
    lines: linesForInsert(lines, breakdown),
    ...discountFields(breakdown),
    saleType: resolveSaleType(lines),
    inventoryDeductions: [],
    ...(asObjectId(input.branchId ?? undefined)
      ? { branchId: asObjectId(input.branchId ?? undefined) }
      : {}),
    ...(input.branchName ? { branchName: input.branchName } : {}),
    createdAt: now,
    updatedAt: now,
  };
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

  const t0 = Date.now();
  await connectDB();

  if (!input.customerPhone?.trim()) {
    throw new SaleError("VALIDATION", "Customer phone is required");
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new SaleError("VALIDATION", "At least one line item is required");
  }

  const phone = input.customerPhone.trim();
  const idempotencyKey = input.idempotencyKey?.trim() || undefined;
  const givenName = input.customerName?.trim();
  const knownCustomerId =
    input.customerId && mongoose.isValidObjectId(input.customerId)
      ? input.customerId
      : null;
  const payment = normalizePayment(input.payment);

  const [salesperson, validated] = await Promise.all([
    resolveSalesperson(input.salesperson),
    validateSaleLines(input.lines),
  ]);
  const breakdown = discountsFor(
    validated.lines,
    input.lines,
    input.invoiceDiscount,
    validated.subtotal,
  );
  const actor = input.actor ?? null;
  const needsApproval =
    breakdown.discountTotal > 0 && exceedsDiscountLimit(breakdown, actor?.role);
  const approvalToken = needsApproval ? String(input.discountApprovalToken ?? "") : "";
  const approver: DiscountApprover | null = needsApproval
    ? await verifyDiscountApproval(
        approvalToken,
        breakdown,
        actor,
        cartFingerprint(input.lines, input.invoiceDiscount),
      )
    : null;
  // Mixed payment must cover the amount actually charged — after discounts.
  const paymentBreakdown = normalizePaymentBreakdown(
    payment,
    input.paymentBreakdown,
    breakdown.total,
    true,
  );
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
      const dup = await Sale.findOne({ idempotencyKey }).lean();
      if (dup) {
        return {
          sale: { ...dup, id: String(dup._id) },
          deduplicated: true as const,
          timingMs: undefined,
        };
      }
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
