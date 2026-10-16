import mongoose from "mongoose";
import { FifoLayer, Formula, Product, ProductionOrder, PurchaseOrder, Sale } from "@/lib/models";

/**
 * Products that must not be hard-deleted: they hold stock or FIFO cost
 * history, or a sale, purchase, production order or formula points at them.
 * Deleting them would destroy received stock and leave those records
 * referencing a product that no longer exists.
 *
 * With `session`, the check reads the transaction's snapshot: a caller that
 * then deletes the products in that same transaction conflicts with (and
 * retries after) any stock change that commits in between.
 */
export async function productsInUse(
  ids: Array<string | mongoose.Types.ObjectId>,
  session?: mongoose.ClientSession,
): Promise<Set<string>> {
  const objectIds = ids
    .map(String)
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (objectIds.length === 0) return new Set();
  const strings = objectIds.map(String);
  const s = session ?? null;

  const queries = [
    () => FifoLayer.distinct("productId", { productId: { $in: objectIds } }).session(s),
    () => Product.find({
      _id: { $in: objectIds },
      $or: [
        { stockSellable: { $ne: 0 } },
        { stockTester: { $ne: 0 } },
        { stockSample: { $ne: 0 } },
        { stockPersonal: { $ne: 0 } },
      ],
    }).distinct("_id").session(s),
    () => Sale.distinct("lines.productId", { "lines.productId": { $in: objectIds } }).session(s),
    () => PurchaseOrder.distinct("lines.productId", { "lines.productId": { $in: objectIds } }).session(s),
    () => ProductionOrder.distinct("plannedLines.productId", { "plannedLines.productId": { $in: objectIds } }).session(s),
    () => ProductionOrder.distinct("outputProductId", { outputProductId: { $in: objectIds } }).session(s),
    // Formula components store the product id as a string.
    () => Formula.distinct("components.productId", { "components.productId": { $in: strings } }).session(s),
  ];
  // Operations on one transaction session must not run concurrently.
  const results: unknown[][] = [];
  if (session) for (const q of queries) results.push(await q());
  else results.push(...(await Promise.all(queries.map((q) => q()))));
  const wanted = new Set(strings);
  return new Set(results.flat().map(String).filter((id) => wanted.has(id)));
}
