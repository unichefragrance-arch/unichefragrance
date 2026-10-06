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
import { Sale } from "../src/lib/models";

/**
 * One-off: POS checkouts used to store `sales.branchId` as a string, while
 * every report and branch filter matches on ObjectId — so branch-scoped
 * reports showed 0 for POS sales. Converts string ids to ObjectId in place.
 * Idempotent; dry run by default — pass --apply --confirm-db=<name> to write.
 */
async function main() {
  // Dry run unless --apply --confirm-db=<name>.
  const { apply } = migrationMode("migrate-sale-branch-ids");
  await connectDB();

  const filter = { branchId: { $type: "string" } };
  const total = await Sale.collection.countDocuments(filter);
  const invalid = await Sale.collection.countDocuments({
    branchId: { $type: "string", $not: /^[0-9a-fA-F]{24}$/ },
  });
  console.log(`Sales with a string branchId: ${total} (${invalid} not a valid id — left untouched)`);

  if (!apply) {
    console.log("Dry run — re-run with --apply to convert.");
    await mongoose.disconnect();
    return;
  }

  const res = await Sale.collection.updateMany(
    { branchId: { $type: "string", $regex: /^[0-9a-fA-F]{24}$/ } },
    [{ $set: { branchId: { $toObjectId: "$branchId" } } }],
  );
  console.log(`Converted: ${res.modifiedCount}`);
  console.log(
    `Remaining string branchIds: ${await Sale.collection.countDocuments(filter)}`,
  );
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
