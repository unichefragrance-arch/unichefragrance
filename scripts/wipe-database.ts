/**
 * Wipe EVERY collection in the database (documents only — indexes are kept).
 * A full JSON backup is written to backups/<timestamp>/ before anything is deleted.
 *
 * After the wipe, the first login re-creates the MAIN branch + admin user from
 * ADMIN_EMAIL / ADMIN_PASSWORD (see src/lib/auth/bootstrap.ts).
 *
 * Usage: npm run db:wipe -- --yes
 */
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { connectDB } from "../src/lib/db";
import { assertLocalOnlyTarget } from "./lib/dbSafety";

async function main() {
  // Destructive: local databases only — refuses Atlas/remote/unset targets, no override.
  assertLocalOnlyTarget("wipe-database");
  if (!process.argv.includes("--yes")) {
    console.error("Refusing to wipe without --yes. Usage: npm run db:wipe -- --yes");
    process.exit(1);
  }

  console.log("Connecting…");
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");

  const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((name) => !name.startsWith("system."));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(process.cwd(), "backups", stamp);
  fs.mkdirSync(backupDir, { recursive: true });

  console.log(`Backing up ${collections.length} collections to ${backupDir}`);
  for (const name of collections) {
    const docs = await db.collection(name).find({}).toArray();
    fs.writeFileSync(
      path.join(backupDir, `${name}.json`),
      mongoose.mongo.BSON.EJSON.stringify(docs, undefined, 2, { relaxed: false }),
    );
    console.log(`  ${name}: ${docs.length} docs backed up`);
  }

  console.log("Deleting…");
  for (const name of collections) {
    const res = await db.collection(name).deleteMany({});
    console.log(`  ${name}: ${res.deletedCount} deleted`);
  }

  console.log("Done. Database is empty.");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Wipe failed:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
