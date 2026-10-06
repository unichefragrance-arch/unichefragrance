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
import { matchRemixRole } from "../src/lib/sales/constants";
import { assertLocalOnlyTarget } from "./lib/dbSafety";

/** Additive packaging seed — does not wipe existing data. */
const extras = [
  {
    sku: "ETH-99",
    name: "Ethanol 99%",
    category: "Packaging",
    unit: "ml",
    sellPrice: 0,
    minMarginPct: 0,
    costFifo: 0.06,
    stockSellable: 8000,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 1500,
    itemType: "raw",
  },
  {
    sku: "BOT-30",
    name: "Glass Bottle 30ml",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 4,
    minMarginPct: 20,
    costFifo: 1.2,
    stockSellable: 280,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 40,
    itemType: "packaging",
  },
  {
    sku: "BOT-50",
    name: "Glass Bottle 50ml",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 6,
    minMarginPct: 20,
    costFifo: 1.8,
    stockSellable: 260,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 40,
    itemType: "packaging",
  },
  {
    sku: "BOT-100-FR",
    name: "Frosted Bottle 100ml",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 10,
    minMarginPct: 20,
    costFifo: 3.1,
    stockSellable: 180,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 30,
    itemType: "packaging",
  },
  {
    sku: "BOT-100-BK",
    name: "Black Bottle 100ml",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 11,
    minMarginPct: 20,
    costFifo: 3.4,
    stockSellable: 150,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 30,
    itemType: "packaging",
  },
  {
    sku: "CAP-SLV",
    name: "Cap — Silver",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 3,
    minMarginPct: 20,
    costFifo: 0.85,
    stockSellable: 360,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 50,
    itemType: "packaging",
  },
  {
    sku: "CAP-BLK",
    name: "Cap — Matte Black",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 3.5,
    minMarginPct: 20,
    costFifo: 0.95,
    stockSellable: 300,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 40,
    itemType: "packaging",
  },
  {
    sku: "CAP-WOOD",
    name: "Cap — Wood Finish",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 5,
    minMarginPct: 25,
    costFifo: 1.6,
    stockSellable: 140,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 25,
    itemType: "packaging",
  },
  {
    sku: "ATM-LUX",
    name: "Atomizer — Luxury",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 6,
    minMarginPct: 25,
    costFifo: 1.8,
    stockSellable: 200,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 30,
    itemType: "packaging",
  },
  {
    sku: "ATM-GLD",
    name: "Atomizer — Gold Spray",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 5.5,
    minMarginPct: 20,
    costFifo: 1.5,
    stockSellable: 220,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 30,
    itemType: "packaging",
  },
  {
    sku: "COL-GLD",
    name: "Collar — Gold",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 3,
    minMarginPct: 20,
    costFifo: 0.75,
    stockSellable: 240,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 40,
    itemType: "packaging",
  },
  {
    sku: "COL-SLV",
    name: "Collar — Silver",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 3,
    minMarginPct: 20,
    costFifo: 0.75,
    stockSellable: 230,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 40,
    itemType: "packaging",
  },
  {
    sku: "PCH-SAT",
    name: "Satin Pouch",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 4.5,
    minMarginPct: 25,
    costFifo: 1.3,
    stockSellable: 190,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 35,
    itemType: "packaging",
  },
  {
    sku: "LBL-STD",
    name: "Label — Standard",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 1.5,
    minMarginPct: 20,
    costFifo: 0.35,
    stockSellable: 800,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 100,
    itemType: "packaging",
  },
  {
    sku: "LBL-PRM",
    name: "Label — Premium Foil",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 2.5,
    minMarginPct: 25,
    costFifo: 0.7,
    stockSellable: 400,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 60,
    itemType: "packaging",
  },
  {
    sku: "BOX-STD",
    name: "Carton Box — Standard",
    category: "Packaging",
    unit: "pcs",
    sellPrice: 3,
    minMarginPct: 20,
    costFifo: 0.9,
    stockSellable: 320,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 50,
    itemType: "packaging",
  },
  {
    sku: "FIX-PRM",
    name: "Fixative — Premium",
    category: "Packaging",
    unit: "ml",
    sellPrice: 0,
    minMarginPct: 0,
    costFifo: 0.22,
    stockSellable: 2500,
    stockTester: 0,
    stockSample: 0,
    stockPersonal: 0,
    lowStockAt: 300,
    itemType: "raw",
  },
] as const;

const renames = [
  { sku: "ATM-STD", name: "Atomizer — Standard" },
  { sku: "COL-STD", name: "Collar — Standard" },
];

async function main() {
  // Destructive: local databases only — refuses Atlas/remote/unset targets, no override.
  assertLocalOnlyTarget("seed-packaging");
  await connectDB();
  let created = 0;
  let skipped = 0;

  for (const r of renames) {
    const res = await Product.updateOne({ sku: r.sku }, { $set: { name: r.name } });
    console.log(`rename ${r.sku}: matched=${res.matchedCount}`);
  }

  const supplier = await Supplier.findOne({ name: "Packaging Gulf" });

  for (const p of extras) {
    const existing = await Product.findOne({ sku: p.sku });
    if (existing) {
      skipped += 1;
      continue;
    }
    const doc = await Product.create(p);
    created += 1;
    if (supplier && p.stockSellable > 0) {
      await FifoLayer.create({
        productId: doc._id,
        supplierId: supplier._id,
        supplierName: supplier.name,
        purchaseDate: new Date("2026-06-01"),
        qtyRemaining: p.stockSellable,
        unitCost: p.costFifo,
        currency: "AED",
      });
    }
    console.log(`+ ${p.sku} ${p.name}`);
  }

  const packaging = await Product.find({
    category: { $in: ["Packaging", "Coffret"] },
  }).lean();
  const byRole: Record<string, string[]> = {};
  for (const p of packaging) {
    const role =
      matchRemixRole(p.name, p.sku) ||
      (/\bpouch\b/i.test(p.name) || /^PCH-/i.test(p.sku) ? "pouch" : "other");
    (byRole[role] ||= []).push(`${p.sku}:${p.name}`);
  }

  console.log(`\nCreated: ${created}  Skipped: ${skipped}`);
  console.log("Packaging by role:");
  for (const role of Object.keys(byRole).sort()) {
    console.log(`  ${role} (${byRole[role].length}): ${byRole[role].join(" | ")}`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Packaging seed failed:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
