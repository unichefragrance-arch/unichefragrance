import mongoose from "mongoose";
import { FifoLayer, Product } from "@/lib/models";
import { SaleError } from "@/lib/sales/errors";

export type FifoDeductionBatch = {
  layerId: string;
  qty: number;
  unitCost: number;
  purchaseDate: Date;
};

export type DeductFifoResult = {
  costTotal: number;
  batches: FifoDeductionBatch[];
};

type SessionOpt = {
  session?: mongoose.ClientSession | null;
  /** Skip weighted costFifo refresh (do it after the sale commits). */
  skipCostUpdate?: boolean;
};

/** POS writes: acknowledge primary only — cuts Atlas RTT vs w=majority. */
const FAST_WC = { w: 1 as const, j: false };

/**
 * FIFO consume oldest layers first.
 * Reserves sellable stock atomically, then consumes layers in one fetch + bulkWrite
 * (instead of findOne/update per layer round-trip — critical on remote Atlas).
 */
export async function deductFifo(
  productId: string | mongoose.Types.ObjectId,
  qty: number,
  opts: SessionOpt = {},
): Promise<DeductFifoResult> {
  const map = await deductFifoMany(
    [{ productId: String(productId), qty }],
    opts,
  );
  return map.get(String(productId)) ?? { costTotal: 0, batches: [] };
}

export type FifoDeductNeed = {
  productId: string;
  qty: number;
  /** Optional label for error messages */
  productName?: string;
};

/**
 * FIFO quantities are kept to 3 decimals (milli-units of ml / g / pcs).
 * Rounding every stored quantity keeps float dust (e.g. 0.3 − 0.1 − 0.2 =
 * 2.8e-17) out of layers and stock, so "empty" really is 0.
 */
const QTY_DECIMALS = 3;
export function roundQty(n: number): number {
  return Math.round(n * 1000) / 1000;
}
/** Update-pipeline expression: field + delta, rounded to QTY_DECIMALS. */
function addRounded(field: string, delta: number) {
  return { $round: [{ $add: [{ $ifNull: [field, 0] }, delta] }, QTY_DECIMALS] };
}
/** Tolerance for quantities written before rounding existed. */
const QTY_EPSILON = 0.0005;

/** Layers fetched up front per product; a sale needing more falls back to all. */
const LAYER_PREFIX = 25;

/**
 * Per-product in-process locks. Every write path that consumes FIFO stock
 * (POS checkout, quotation convert, adjustments, production) queues here, so
 * concurrent consumers of the same products take turns instead of racing into
 * Mongo write conflicts. Locks are taken in sorted order → no deadlock; work
 * on unrelated products still runs in parallel. Not re-entrant: never call
 * deductFifoMany (without a session) from inside withProductLocks.
 * Conflicts across server instances are still handled by transaction retry.
 */
const productLocks = new Map<string, Promise<void>>();

export async function withProductLocks<T>(
  productIds: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const releases: (() => void)[] = [];
  try {
    for (const key of [...new Set(productIds)].sort()) {
      const prev = productLocks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const tail = prev.then(() => held);
      productLocks.set(key, tail);
      releases.push(() => {
        release();
        if (productLocks.get(key) === tail) productLocks.delete(key);
      });
      await prev;
    }
    return await fn();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/**
 * Batch FIFO deduct (quotation convert, stock adjustments, production).
 * One Mongo transaction (planFifoDeductions → applyFifoPlan), queued per
 * product with POS checkouts — concurrent callers can never consume the same
 * layer twice or leave layers out of step with stock. With `session`, it
 * joins the caller's transaction instead (caller handles locking).
 * costFifo is updated inside the same writes, so skipCostUpdate is moot.
 */
export async function deductFifoMany(
  needs: FifoDeductNeed[],
  opts: SessionOpt = {},
): Promise<Map<string, DeductFifoResult>> {
  const filtered = needs.filter((n) => n.qty > 0);
  if (filtered.length === 0) return new Map();
  if (opts.session) {
    const plan = await planFifoDeductions(filtered, opts.session);
    await applyFifoPlan(plan, opts.session);
    return plan.results;
  }
  return withProductLocks(
    filtered.map((n) => String(n.productId)),
    async () => {
      const session = await mongoose.startSession();
      try {
        let results = new Map<string, DeductFifoResult>();
        await session.withTransaction(
          async () => {
            const plan = await planFifoDeductions(filtered, session);
            await applyFifoPlan(plan, session);
            results = plan.results;
          },
          { writeConcern: FAST_WC },
        );
        return results;
      } finally {
        await session.endSession();
      }
    },
  );
}

/** Read-only FIFO deduction plan, applied later in the same transaction by applyFifoPlan. */
export type FifoPlan = {
  results: Map<string, DeductFifoResult>;
  productOps: mongoose.mongo.AnyBulkWriteOperation[];
  layerOps: mongoose.mongo.AnyBulkWriteOperation[];
};

type LayerLean = {
  _id: mongoose.Types.ObjectId;
  qtyRemaining: number;
  unitCost: number;
  purchaseDate: Date;
};

/**
 * Transactional FIFO deduction, step 1 — reads only (2 queries, no writes).
 * Checks sellable stock + FIFO layers against the transaction snapshot and
 * plans which layers to consume: oldest purchaseDate first, ties broken by
 * insertion order (_id), quantities rounded to 3 decimals. Fetches each
 * product's remaining totals plus only its oldest LAYER_PREFIX layers (one
 * aggregation), so cost doesn't grow with layer count. Pair with
 * applyFifoPlan as the LAST writes of the transaction: the hot product /
 * layer documents every sale touches are then held for the shortest window.
 * The post-sale weighted FIFO cost (same formula as refreshCostFifo) is set
 * in that same product update, so no separate cost write runs after commit.
 */
export async function planFifoDeductions(
  needs: FifoDeductNeed[],
  session: mongoose.ClientSession,
): Promise<FifoPlan> {
  const coalesced = new Map<string, FifoDeductNeed>();
  for (const n of needs) {
    if (!(n.qty > 0)) continue;
    const id = String(n.productId);
    const cur = coalesced.get(id);
    if (cur) cur.qty = roundQty(cur.qty + n.qty);
    else coalesced.set(id, { productId: id, qty: roundQty(n.qty), productName: n.productName });
  }
  const list = [...coalesced.values()];
  const plan: FifoPlan = { results: new Map(), productOps: [], layerOps: [] };
  if (list.length === 0) return plan;

  const ids = list.map((n) => new mongoose.Types.ObjectId(n.productId));
  // Sequential on purpose: operations on one transaction session must not run
  // concurrently (the first one starts the transaction).
  const products = await Product.find({ _id: { $in: ids } }, "name stockSellable", {
    session,
  }).lean<{ _id: mongoose.Types.ObjectId; name: string; stockSellable: number }[]>();
  const layerRows = await FifoLayer.aggregate<{
    _id: mongoose.Types.ObjectId;
    qty: number;
    value: number;
    layers: LayerLean[];
  }>([
    { $match: { productId: { $in: ids }, qtyRemaining: { $gt: 0 } } },
    { $sort: { productId: 1, purchaseDate: 1, _id: 1 } },
    {
      $group: {
        _id: "$productId",
        qty: { $sum: "$qtyRemaining" },
        value: { $sum: { $multiply: ["$qtyRemaining", "$unitCost"] } },
        layers: {
          $firstN: {
            n: LAYER_PREFIX,
            input: {
              _id: "$_id",
              qtyRemaining: "$qtyRemaining",
              unitCost: "$unitCost",
              purchaseDate: "$purchaseDate",
            },
          },
        },
      },
    },
  ]).session(session);
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const layersById = new Map(layerRows.map((r) => [String(r._id), r]));
  const now = new Date();

  for (const need of list) {
    const product = productById.get(need.productId);
    if (!product) {
      throw new SaleError(
        "PRODUCT_NOT_FOUND",
        `Product not found: ${need.productName || need.productId}`,
      );
    }
    if (roundQty(product.stockSellable) < need.qty) {
      throw new SaleError("INSUFFICIENT_STOCK", `Insufficient stock for ${product.name}`);
    }

    const row = layersById.get(need.productId) ?? { qty: 0, value: 0, layers: [] as LayerLean[] };
    let layers = row.layers;
    const prefixQty = layers.reduce((s, l) => s + roundQty(l.qtyRemaining), 0);
    if (prefixQty < need.qty && layers.length === LAYER_PREFIX) {
      // Rare: one sale spans more than LAYER_PREFIX layers — read them all.
      layers = await FifoLayer.find(
        { productId: need.productId, qtyRemaining: { $gt: 0 } },
        "qtyRemaining unitCost purchaseDate",
        { sort: { purchaseDate: 1, _id: 1 }, session },
      ).lean<LayerLean[]>();
    }

    let remaining = need.qty;
    let costTotal = 0;
    const batches: FifoDeductionBatch[] = [];
    for (const layer of layers) {
      if (remaining <= 0) break;
      const available = roundQty(layer.qtyRemaining);
      if (available <= 0) continue;
      const take = roundQty(Math.min(available, remaining));
      plan.layerOps.push({
        updateOne: {
          filter: { _id: layer._id, qtyRemaining: { $gte: take - QTY_EPSILON } },
          update: [
            {
              $set: {
                qtyRemaining: {
                  $max: [0, { $round: [{ $subtract: ["$qtyRemaining", take] }, QTY_DECIMALS] }],
                },
              },
            },
          ],
        },
      });
      batches.push({
        layerId: String(layer._id),
        qty: take,
        unitCost: layer.unitCost,
        purchaseDate: layer.purchaseDate,
      });
      remaining = roundQty(remaining - take);
      costTotal += take * layer.unitCost;
    }
    if (remaining > 0) {
      throw new SaleError(
        "INSUFFICIENT_STOCK",
        `Insufficient stock for ${product.name} (FIFO need ${need.qty}, short ${remaining})`,
      );
    }

    const leftQty = roundQty(row.qty - need.qty);
    const leftValue = row.value - costTotal;
    plan.productOps.push({
      updateOne: {
        filter: { _id: product._id, stockSellable: { $gte: need.qty - QTY_EPSILON } },
        update: [
          {
            $set: {
              stockSellable: {
                $max: [0, { $round: [{ $subtract: ["$stockSellable", need.qty] }, QTY_DECIMALS] }],
              },
              lastSoldAt: now,
              costFifo: leftQty > 0 ? Number((leftValue / leftQty).toFixed(3)) : 0,
            },
          },
        ],
      },
    });
    plan.results.set(need.productId, { costTotal, batches });
  }
  return plan;
}

/**
 * Transactional FIFO deduction, step 2 — two bulk writes. Run last in the
 * transaction. A concurrent commit on the same documents surfaces as a
 * transient WriteConflict (deliberately NOT caught) so the caller's
 * withTransaction retries against a fresh snapshot.
 */
export async function applyFifoPlan(
  plan: FifoPlan,
  session: mongoose.ClientSession,
): Promise<void> {
  if (plan.productOps.length > 0) {
    const res = await Product.collection.bulkWrite(plan.productOps, { session, ordered: true });
    if (res.matchedCount !== plan.productOps.length) {
      throw new SaleError("INSUFFICIENT_STOCK", "Insufficient stock (retry checkout)");
    }
  }
  if (plan.layerOps.length > 0) {
    const res = await FifoLayer.collection.bulkWrite(plan.layerOps, { session, ordered: true });
    if (res.matchedCount !== plan.layerOps.length) {
      throw new SaleError("INSUFFICIENT_STOCK", "Insufficient stock (FIFO race — retry checkout)");
    }
  }
}

/** Recalculate weighted FIFO cost for one or more products (1 aggregation query). */
export async function refreshCostFifo(
  productIds:
    | string
    | mongoose.Types.ObjectId
    | Array<string | mongoose.Types.ObjectId>,
  opts: SessionOpt = {},
) {
  const ids = (Array.isArray(productIds) ? productIds : [productIds])
    .map((id) =>
      typeof id === "string" ? new mongoose.Types.ObjectId(id) : id,
    )
    .filter(Boolean);
  if (ids.length === 0) return;

  const session = opts.session ?? null;
  const agg = FifoLayer.aggregate([
    { $match: { productId: { $in: ids }, qtyRemaining: { $gt: 0 } } },
    {
      $group: {
        _id: "$productId",
        totalQty: { $sum: "$qtyRemaining" },
        totalCost: {
          $sum: { $multiply: ["$qtyRemaining", "$unitCost"] },
        },
      },
    },
  ]);
  if (session) agg.session(session);
  const rows = await agg;

  const byId = new Map(
    rows.map((r) => [
      String(r._id),
      r.totalQty > 0 ? Number((r.totalCost / r.totalQty).toFixed(3)) : 0,
    ]),
  );

  const updates = ids.map((id) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { costFifo: byId.get(String(id)) ?? 0 } },
    },
  }));

  await Product.bulkWrite(updates, {
    ...(session ? { session } : {}),
    writeConcern: FAST_WC,
  });
}

/** Reverse a prior deductFifo result (compensating rollback). */
export async function restoreFifo(
  productId: string | mongoose.Types.ObjectId,
  result: DeductFifoResult,
  opts: SessionOpt = {},
) {
  if (result.batches.length === 0) return;
  const session = opts.session ?? null;
  const findOpts = session
    ? { session, writeConcern: FAST_WC }
    : { writeConcern: FAST_WC };

  let totalQty = 0;
  const ops: mongoose.mongo.AnyBulkWriteOperation[] = result.batches.map((b) => {
    totalQty = roundQty(totalQty + b.qty);
    return {
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(b.layerId) },
        update: [{ $set: { qtyRemaining: addRounded("$qtyRemaining", b.qty) } }],
      },
    };
  });

  if (ops.length > 0) {
    await FifoLayer.collection.bulkWrite(ops, {
      ordered: false,
      writeConcern: FAST_WC,
      ...(session ? { session } : {}),
    });
  }

  await Product.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(productId)) },
    [{ $set: { stockSellable: addRounded("$stockSellable", totalQty) } }],
    findOpts,
  );

  if (!opts.skipCostUpdate) {
    await refreshCostFifo(productId, { session });
  }
}

export async function addFifoLayer(input: {
  productId: string;
  supplierId: string;
  supplierName: string;
  purchaseDate: Date;
  qty: number;
  unitCost: number;
  currency: string;
  /** Goods receipt this layer came from (audit trail). */
  purchaseOrderId?: string | null;
}) {
  const qty = roundQty(input.qty);
  const layer = await FifoLayer.create({
    productId: input.productId,
    supplierId: input.supplierId,
    supplierName: input.supplierName,
    purchaseDate: input.purchaseDate,
    qtyRemaining: qty,
    originalQty: qty,
    unitCost: input.unitCost,
    currency: input.currency,
    source: "purchase",
    purchaseOrderId: input.purchaseOrderId ?? null,
  });

  // Atomic + rounded (was read-modify-write, which could lose a concurrent update).
  const res = await Product.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(input.productId) },
    [{ $set: { stockSellable: addRounded("$stockSellable", qty) } }],
  );
  if (res.matchedCount > 0) {
    await refreshCostFifo(input.productId);
  }

  return layer;
}

/** Finished goods from a completed production order → new FIFO layer + sellable stock. */
export async function addProductionFifoLayer(input: {
  productId: string;
  supplierId: string;
  supplierName: string;
  productionOrderId: string;
  purchaseDate: Date;
  qty: number;
  unitCost: number;
  currency: string;
}) {
  if (!(input.qty > 0)) {
    throw new SaleError("VALIDATION", "Production output qty must be greater than 0");
  }

  const qty = roundQty(input.qty);
  const layer = await FifoLayer.create({
    productId: input.productId,
    supplierId: input.supplierId,
    supplierName: input.supplierName,
    purchaseDate: input.purchaseDate,
    qtyRemaining: qty,
    originalQty: qty,
    unitCost: input.unitCost,
    currency: input.currency,
    source: "production",
    productionOrderId: input.productionOrderId,
  });

  const res = await Product.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(input.productId) },
    [{ $set: { stockSellable: addRounded("$stockSellable", qty) } }],
    { writeConcern: FAST_WC },
  );
  if (res.matchedCount === 0) {
    await FifoLayer.findByIdAndDelete(layer._id);
    throw new SaleError("PRODUCT_NOT_FOUND", "Output product not found");
  }

  await refreshCostFifo(input.productId);
  return layer;
}
