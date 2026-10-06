import dns from "node:dns";
import "dotenv/config";

dns.setDefaultResultOrder("ipv4first");
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {
  // ignore
}

import mongoose from "mongoose";
import { migrationMode } from "./lib/dbSafety";
import { connectDB } from "../src/lib/db";
import { AppSettings, FifoLayer, PurchaseOrder, Supplier } from "../src/lib/models";

/**
 * One-off: the shop switched from AED to OMR. The ORM schema defaults were
 * already updated (src/lib/models.ts), but existing seeded/live documents
 * still carry the old "AED" value in their `currency` field — this flips
 * every one of them to "OMR" so old + new data agree.
 */
const MODELS = [
  { name: "FifoLayer", model: FifoLayer },
  { name: "Supplier", model: Supplier },
  { name: "PurchaseOrder", model: PurchaseOrder },
  { name: "AppSettings", model: AppSettings },
] as const;

async function main() {
  // Dry run unless --apply --confirm-db=<name>.
  const { apply } = migrationMode("migrate-currency-omr");
  await connectDB();

  console.log("Before:");
  for (const { name, model } of MODELS) {
    const counts = await model.aggregate([
      { $group: { _id: "$currency", count: { $sum: 1 } } },
    ]);
    console.log(`  ${name}:`, counts);
  }

  if (!apply) {
    for (const { name, model } of MODELS) {
      console.log(`[dry run] ${name}: ${await model.countDocuments({ currency: "AED" })} would be updated AED -> OMR`);
    }
    await mongoose.disconnect();
    return;
  }

  console.log("\nUpdating AED -> OMR:");
  for (const { name, model } of MODELS) {
    const res = await model.updateMany(
      { currency: "AED" },
      { $set: { currency: "OMR" } },
    );
    console.log(`  ${name}: ${res.modifiedCount} updated`);
  }

  console.log("\nAfter:");
  for (const { name, model } of MODELS) {
    const counts = await model.aggregate([
      { $group: { _id: "$currency", count: { $sum: 1 } } },
    ]);
    console.log(`  ${name}:`, counts);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
