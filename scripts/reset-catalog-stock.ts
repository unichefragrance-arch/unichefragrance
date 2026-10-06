/**
 * Reset catalog stock to seed defaults — does NOT wipe sales/customers/settings.
 * Usage: npx tsx --env-file=.env scripts/reset-catalog-stock.ts
 */
import dns from "node:dns";
import "dotenv/config";

dns.setDefaultResultOrder("ipv4first");
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {
  // ignore
}

import mongoose from "mongoose";
import { connectDB } from "../src/lib/db";
import { FifoLayer, Product, Supplier } from "../src/lib/models";
import { assertLocalOnlyTarget } from "./lib/dbSafety";

/** Seed stock + cost defaults keyed by SKU. */
const STOCK_RESET: Record<
  string,
  {
    stockSellable: number;
    stockTester?: number;
    stockSample?: number;
    stockPersonal?: number;
    costFifo: number;
  }
> = {
  "BP-001": { stockSellable: 18, stockTester: 2, stockSample: 6, stockPersonal: 0, costFifo: 145.5 },
  "SG-001": { stockSellable: 42, stockTester: 3, stockSample: 12, stockPersonal: 1, costFifo: 98.2 },
  "PO-012": { stockSellable: 860, stockTester: 40, stockSample: 25, stockPersonal: 10, costFifo: 7.25 },
  "SN-004": { stockSellable: 48, stockTester: 5, stockSample: 8, stockPersonal: 0, costFifo: 5.1 },
  "RM-STD": { stockSellable: 0, stockTester: 0, stockSample: 0, stockPersonal: 0, costFifo: 42.8 },
  "ETH-96": { stockSellable: 12400, costFifo: 0.045 },
  "ETH-99": { stockSellable: 8000, costFifo: 0.06 },
  "BOT-30": { stockSellable: 280, costFifo: 1.2 },
  "BOT-50": { stockSellable: 260, costFifo: 1.8 },
  "BOT-100": { stockSellable: 320, costFifo: 2.4 },
  "BOT-100-FR": { stockSellable: 180, costFifo: 3.1 },
  "BOT-100-BK": { stockSellable: 150, costFifo: 3.4 },
  "CAP-STD": { stockSellable: 410, costFifo: 0.85 },
  "CAP-SLV": { stockSellable: 360, costFifo: 0.85 },
  "CAP-BLK": { stockSellable: 300, costFifo: 0.95 },
  "CAP-WOOD": { stockSellable: 140, costFifo: 1.6 },
  "ATM-STD": { stockSellable: 380, costFifo: 1.1 },
  "ATM-LUX": { stockSellable: 200, costFifo: 1.8 },
  "ATM-GLD": { stockSellable: 220, costFifo: 1.5 },
  "COL-STD": { stockSellable: 355, costFifo: 0.6 },
  "COL-GLD": { stockSellable: 240, costFifo: 0.75 },
  "COL-SLV": { stockSellable: 230, costFifo: 0.75 },
  "PCH-STD": { stockSellable: 210, costFifo: 1.5 },
  "PCH-SAT": { stockSellable: 190, costFifo: 1.3 },
  "LBL-STD": { stockSellable: 800, costFifo: 0.35 },
  "LBL-PRM": { stockSellable: 400, costFifo: 0.7 },
  "BOX-STD": { stockSellable: 320, costFifo: 0.9 },
  "FIX-STD": { stockSellable: 5000, costFifo: 0.12 },
  "FIX-PRM": { stockSellable: 2500, costFifo: 0.22 },
  "BM-003": { stockSellable: 4, stockTester: 1, stockSample: 3, stockPersonal: 0, costFifo: 22 },
  "BK-002": { stockSellable: 27, stockTester: 0, stockSample: 2, stockPersonal: 0, costFifo: 38 },
  "PO-001": { stockSellable: 92, stockTester: 10, stockSample: 15, stockPersonal: 5, costFifo: 2.1 },
  "GB-001": { stockSellable: 56, stockTester: 0, stockSample: 0, stockPersonal: 0, costFifo: 12 },
};

async function main() {
  // Destructive: local databases only — refuses Atlas/remote/unset targets, no override.
  assertLocalOnlyTarget("reset-catalog-stock");
  console.log("Connecting…");
  await connectDB();

  const products = await Product.find({}).select("_id sku name");
  console.log(`Found ${products.length} products`);

  let updated = 0;
  const productIds: mongoose.Types.ObjectId[] = [];

  for (const p of products) {
    const reset = STOCK_RESET[p.sku];
    productIds.push(p._id as mongoose.Types.ObjectId);

    if (!reset) {
      // Unknown SKU — give a healthy default so catalog is usable
      await Product.updateOne(
        { _id: p._id },
        {
          $set: {
            stockSellable: 50,
            stockTester: 0,
            stockSample: 0,
            stockPersonal: 0,
          },
        },
      );
      updated++;
      continue;
    }

    await Product.updateOne(
      { _id: p._id },
      {
        $set: {
          stockSellable: reset.stockSellable,
          stockTester: reset.stockTester ?? 0,
          stockSample: reset.stockSample ?? 0,
          stockPersonal: reset.stockPersonal ?? 0,
          costFifo: reset.costFifo,
        },
      },
    );
    updated++;
  }

  // Rebuild FIFO layers for reset products
  await FifoLayer.deleteMany({ productId: { $in: productIds } });

  let supplier = await Supplier.findOne().lean();
  if (!supplier) {
    supplier = (
      await Supplier.create({
        name: "Stock Reset",
        phone: "+971 0 000 0000",
        currency: "AED",
      })
    ).toObject();
  }

  const refreshed = await Product.find({
    _id: { $in: productIds },
    stockSellable: { $gt: 0 },
  }).select("_id sku stockSellable costFifo");

  for (const p of refreshed) {
    await FifoLayer.create({
      productId: p._id,
      supplierId: supplier._id,
      supplierName: supplier.name,
      purchaseDate: new Date(),
      qtyRemaining: p.stockSellable,
      unitCost: p.costFifo,
      currency: "AED",
    });
  }

  console.log(`Reset stock on ${updated} products`);
  console.log(`Rebuilt ${refreshed.length} FIFO layers`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Catalog stock reset failed:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
