import mongoose from "mongoose";
import { FifoLayer, Formula, Product, ProductionOrder, PurchaseOrder, Sale } from "@/lib/models";

/**
 * Products that must not be hard-deleted: they hold stock or FIFO cost
 * history, or a sale, purchase, production order or formula points at them.
 * Deleting them would destroy received stock and leave those records
 * referencing a product that no longer exists.
 */
export async function productsInUse(ids: Array<string | mongoose.Types.ObjectId>): Promise<Set<string>> {
  const objectIds = ids
    .map(String)
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (objectIds.length === 0) return new Set();
  const strings = objectIds.map(String);

  const results = await Promise.all([
    FifoLayer.distinct("productId", { productId: { $in: objectIds } }),
    Product.find({
      _id: { $in: objectIds },
      $or: [
        { stockSellable: { $ne: 0 } },
        { stockTester: { $ne: 0 } },
        { stockSample: { $ne: 0 } },
        { stockPersonal: { $ne: 0 } },
      ],
    }).distinct("_id"),
    Sale.distinct("lines.productId", { "lines.productId": { $in: objectIds } }),
    PurchaseOrder.distinct("lines.productId", { "lines.productId": { $in: objectIds } }),
    ProductionOrder.distinct("plannedLines.productId", { "plannedLines.productId": { $in: objectIds } }),
    ProductionOrder.distinct("outputProductId", { outputProductId: { $in: objectIds } }),
    // Formula components store the product id as a string.
    Formula.distinct("components.productId", { "components.productId": { $in: strings } }),
  ]);
  const wanted = new Set(strings);
  return new Set(results.flat().map(String).filter((id) => wanted.has(id)));
}
