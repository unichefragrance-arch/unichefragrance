/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS script, run with node */
/**
 * READ-ONLY investigation + recovery DRY RUN for the accidental `scripts/seed.ts`
 * run on 2026-10-05 (~21:32 UTC) that may have targeted the .env database.
 *
 *   node scripts/investigate-2026-10-05-seed.cjs [--env path/to/.env] [--out report.json]
 *
 * Guarantees:
 *  - Every collection handle is wrapped: any write/DDL method throws before it
 *    reaches the driver, and aggregation pipelines with $out / $merge are refused.
 *  - There is NO apply mode. The recovery plan is printed as text for review;
 *    each step is marked REQUIRES EXPLICIT APPROVAL and nothing here runs it.
 *  - Credentials are never printed — only scheme, host category and db name.
 */
const fs = require("node:fs");
const path = require("node:path");
const { MongoClient } = require("mongodb");

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: arg("--env", path.join(ROOT, ".env")), quiet: true });
const OUT = arg("--out", path.join(ROOT, "seed-investigation-report.json"));

const WIPE_AT = new Date("2026-10-05T17:27:24.541Z"); // db:wipe backup stamp
const BACKUP_WIPE = path.join(ROOT, "backups", "2026-10-05T17-27-24-541Z");
const SIGNATURE = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-signature.json"), "utf8"));
const SEEDED = Object.keys(SIGNATURE); // the 12 collections seed.ts clears + refills
const UNTOUCHED_WITH_REFS = {
  auditlogs: ["entityId", "userId", "actorId"],
  authsessions: ["userId"],
  deliverylogs: ["saleId", "quotationId"],
  discountapprovals: ["saleId", "actorUserId", "approverUserId"],
  notifications: ["entityId", "saleId", "productId"],
  inventoryadjustments: ["productId"],
  productionorders: ["outputProductId", "formulaId"],
  importbatches: [],
  ratelimits: [],
};
// Parents first: what each seeded collection points at.
const DEPENDENCIES = {
  users: ["branches"], products: [], suppliers: [], branches: [], appsettings: [],
  fifolayers: ["products", "suppliers", "purchaseorders"], formulas: ["products", "customers"],
  customers: [], purchaseorders: ["suppliers", "products"], quotations: ["customers", "products", "formulas", "branches"],
  sales: ["customers", "products", "fifolayers", "branches", "users"], expenses: [],
};

// ---------- read-only enforcement ------------------------------------------
const READ_METHODS = new Set(["find", "findOne", "countDocuments", "estimatedDocumentCount", "distinct", "aggregate", "listIndexes", "indexes", "collectionName", "dbName", "namespace"]);
function readOnlyCollection(col) {
  return new Proxy(col, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      if (!READ_METHODS.has(prop)) return () => { throw new Error(`READ-ONLY GUARD: ${String(prop)}() refused`); };
      if (prop === "aggregate") return (pipeline = [], opts) => {
        if (pipeline.some((st) => "$out" in st || "$merge" in st)) throw new Error("READ-ONLY GUARD: $out/$merge refused");
        return v.call(target, pipeline, opts);
      };
      return v.bind(target);
    },
  });
}
function readOnlyDb(db) {
  return {
    databaseName: db.databaseName,
    collection: (n) => readOnlyCollection(db.collection(n)),
    listCollections: (f, o) => db.listCollections(f, o),
  };
}

// ---------- helpers ----------------------------------------------------------
function describeTarget(url) {
  const after = String(url || "").replace(/^mongodb(\+srv)?:\/\//, "");
  const host = after.split(/[/?]/)[0].split("@").pop() || "";
  const local = host.split(",").every((h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h));
  return {
    scheme: (String(url).match(/^(mongodb(\+srv)?):/) || [])[1] || "?",
    hostCategory: host ? (local ? "LOCAL" : "REMOTE") : "UNSET",
    hostSuffix: local ? host : host.replace(/^[^.]+\./, "*."),
    dbName: (after.split("/")[1] || "").split("?")[0] || "(driver default)",
  };
}
const idTime = (id) => (id && typeof id.getTimestamp === "function" ? id.getTimestamp() : null);
const iso = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString() : null);
const sigKey = (o, keys) => JSON.stringify(keys.map((k) => (o[k] === undefined ? null : o[k])));
const loadBackup = (dir, name) => {
  const f = path.join(dir, `${name}.json`);
  if (!fs.existsSync(f)) return [];
  const { EJSON } = require("bson");
  return EJSON.parse(fs.readFileSync(f, "utf8"), { relaxed: false });
};

(async () => {
  const target = describeTarget(process.env.DATABASE_URL);
  console.log("TARGET:", target, "\nMODE: read-only (writes blocked in code; no apply mode exists)\n");
  if (target.hostCategory === "UNSET") throw new Error("DATABASE_URL not set — stopping.");

  const client = new MongoClient(process.env.DATABASE_URL, { readPreference: "primaryPreferred", appName: "seed-investigation-readonly" });
  await client.connect();
  const db = readOnlyDb(client.db());
  const report = { generatedAt: new Date().toISOString(), target, collections: {}, candidates: [], untouched: {}, evidence: [], plan: [] };

  // 1) Locate the seed window: the seed inserts every collection within ~1 s.
  const branchIds = await db.collection("branches").find({}).project({ _id: 1, code: 1, name: 1 }).toArray();
  const userRows = await db.collection("users").find({}).project({ _id: 1, email: 1, role: 1, createdAt: 1 }).toArray();
  const times = [...branchIds, ...userRows].map((d) => idTime(d._id)).filter(Boolean).sort((a, b) => a - b);
  const seedStart = times.length ? times[0] : null;
  const seedEnd = times.length ? times[times.length - 1] : null;
  report.seedWindow = { firstInsert: iso(seedStart), lastInsert: iso(seedEnd) };
  const inWindow = (t) => t && seedStart && t >= new Date(seedStart.getTime() - 120000) && t <= new Date(seedEnd.getTime() + 120000);
  console.log(`Seed-window estimate (branches+users _id time): ${iso(seedStart)} → ${iso(seedEnd)}`);

  // 2) Every document in the 12 seeded collections, classified.
  for (const name of SEEDED) {
    const { keys, signatures } = SIGNATURE[name];
    const sigSet = new Set(signatures.map((s) => sigKey(s, keys)));
    const docs = await db.collection(name).find({}).toArray();
    const stats = { total: docs.length, seedSignatureMatch: 0, insertedInSeedWindow: 0, high: 0, medium: 0, low: 0, insertedAfterSeed: 0 };
    for (const d of docs) {
      const t = idTime(d._id);
      const sigHit = sigSet.has(sigKey(d, keys)) || keys.some((k) => d[k] !== undefined && signatures.some((s) => s[k] !== undefined && s[k] === d[k] && ["sku", "email", "phone", "number", "code"].includes(k)));
      const win = inWindow(t);
      const after = seedEnd && t && t > new Date(seedEnd.getTime() + 120000);
      const confidence = sigHit && win ? "HIGH" : sigHit || win ? "MEDIUM" : "LOW";
      stats.seedSignatureMatch += sigHit ? 1 : 0;
      stats.insertedInSeedWindow += win ? 1 : 0;
      stats.insertedAfterSeed += after ? 1 : 0;
      stats[confidence.toLowerCase()]++;
      report.candidates.push({
        collection: name, _id: String(d._id), insertedAt: iso(t), createdAt: iso(d.createdAt), updatedAt: iso(d.updatedAt),
        naturalKey: Object.fromEntries(keys.filter((k) => d[k] !== undefined && k !== "email").map((k) => [k, d[k]])),
        evidence: [sigHit && "matches seed.ts natural key", win && "inserted in seed window", after && "inserted AFTER seed (possible real activity)"].filter(Boolean),
        confidence,
        productionCritical: confidence === "LOW" || after ? "POSSIBLY — do not touch without review" : "No (seed demo data)",
        action: confidence === "HIGH" && !after ? "Candidate for quarantine/removal — REQUIRES EXPLICIT APPROVAL" : "KEEP — manual review",
      });
    }
    // Updated after insert (someone used the seeded data, e.g. sold a seeded product)?
    stats.modifiedAfterSeed = seedEnd ? docs.filter((d) => d.updatedAt instanceof Date && d.updatedAt > new Date(seedEnd.getTime() + 120000)).length : 0;
    report.collections[name] = stats;
  }
  console.log("\nSEEDED COLLECTIONS (current state):");
  console.table(report.collections);

  // 3) Untouched collections — references to ids that no longer exist = deleted real data.
  const existing = {};
  for (const name of SEEDED) existing[name] = new Set((await db.collection(name).find({}).project({ _id: 1 }).toArray()).map((d) => String(d._id)));
  const allSeededIds = new Set(Object.values(existing).flatMap((s) => [...s]));
  for (const [name, refFields] of Object.entries(UNTOUCHED_WITH_REFS)) {
    const col = db.collection(name);
    const total = await col.countDocuments();
    const sinceWipe = await col.countDocuments({ createdAt: { $gte: WIPE_AT } });
    const beforeSeed = seedStart ? await col.countDocuments({ createdAt: { $gte: WIPE_AT, $lt: seedStart } }) : null;
    const afterSeed = seedEnd ? await col.countDocuments({ createdAt: { $gt: seedEnd } }) : null;
    let dangling = 0, toSeeded = 0;
    if (refFields.length) {
      const rows = await col.find({ createdAt: { $gte: WIPE_AT } }).project(Object.fromEntries(refFields.map((f) => [f, 1]))).toArray();
      for (const r of rows) for (const f of refFields) {
        if (!r[f]) continue;
        const v = String(r[f]);
        if (!/^[a-f0-9]{24}$/.test(v)) continue;
        if (allSeededIds.has(v)) toSeeded++; else dangling++;
      }
    }
    report.untouched[name] = { total, sinceWipe, betweenWipeAndSeed: beforeSeed, afterSeed, refsToSeededDocs: toSeeded, danglingRefsSinceWipe: dangling };
  }
  console.log("\nCOLLECTIONS THE SEED DID NOT CLEAR (preserve — audit trail):");
  console.table(report.untouched);

  // 4) Activity between the wipe and the seed (what the seed may have destroyed).
  const window = seedStart ? await db.collection("auditlogs").find({ createdAt: { $gte: WIPE_AT, $lt: seedStart } }).sort({ createdAt: 1 }).toArray() : [];
  const byAction = {};
  for (const a of window) byAction[a.action] = (byAction[a.action] || 0) + 1;
  report.activityBetweenWipeAndSeed = { entries: window.length, byAction, first: iso(window[0]?.createdAt), last: iso(window.at(-1)?.createdAt) };
  console.log("\nAUDIT ACTIVITY between 17:27 wipe and seed:", report.activityBetweenWipeAndSeed);
  const sessionsBefore = seedStart ? await db.collection("authsessions").find({ createdAt: { $gte: WIPE_AT, $lt: seedStart } }).project({ userId: 1, createdAt: 1 }).toArray() : [];
  const lostUsers = [...new Set(sessionsBefore.map((s) => String(s.userId)))].filter((id) => !existing.users.has(id));
  report.usersWithSessionsButNoLongerPresent = lostUsers.length;
  console.log(`Users who logged in after the wipe but no longer exist: ${lostUsers.length}`);

  // 5) Backup comparison.
  const wipeBackup = Object.fromEntries(["users", "branches", "appsettings"].map((n) => [n, loadBackup(BACKUP_WIPE, n)]));
  report.backup = {
    path: path.relative(ROOT, BACKUP_WIPE),
    note: "Taken BEFORE the 17:27 db:wipe — the state the wipe started from, not the state just before the seed.",
    counts: Object.fromEntries(Object.entries(wipeBackup).map(([k, v]) => [k, v.length])),
    presentNow: Object.fromEntries(Object.entries(wipeBackup).map(([k, v]) => [k, v.filter((d) => existing[k]?.has(String(d._id))).length])),
  };
  console.log("\nBACKUP:", report.backup);

  // 6) Verdict + plan (text only).
  const high = report.candidates.filter((c) => c.confidence === "HIGH").length;
  const verdict = high >= 50 && report.collections.users?.seedSignatureMatch >= 6
    ? "CONFIRMED: seed.ts output is present on this database."
    : high > 0 ? "PARTIAL: some seed-signature documents present — manual review." : "NOT CONFIRMED: no seed signature found on this database.";
  report.verdict = verdict;
  const step = (n, text, count) => report.plan.push({ step: n, action: text, affected: count, status: "NOT EXECUTED — REQUIRES EXPLICIT APPROVAL" });
  const highBy = (c) => report.candidates.filter((x) => x.collection === c && x.confidence === "HIGH").length;
  step(0, "Take a full backup / Atlas snapshot of the CURRENT state first (evidence + rollback point)", "all");
  step(1, "Check Atlas Backup for a snapshot/PITR between the 17:27 wipe and the seed; if one exists, prefer restoring from it to the seeded collections only", "12 collections");
  step(2, "Revoke sessions of the 6 seeded demo accounts (authsessions by userId)", report.untouched.authsessions?.refsToSeededDocs ?? "?");
  step(3, "Remove HIGH-confidence seed docs, children first: sales → quotations → fifolayers → purchaseorders → formulas → customers → expenses → products → suppliers → appsettings → users → branches",
    Object.fromEntries(["sales", "quotations", "fifolayers", "purchaseorders", "formulas", "customers", "expenses", "products", "suppliers", "appsettings", "users", "branches"].map((c) => [c, highBy(c)])));
  step(4, `Restore parents first from ${report.backup.path}: branches → users → appsettings (or from the Atlas snapshot)`, report.backup.counts);
  step(5, "Do NOT touch auditlogs / importbatches / notifications / deliverylogs / discountapprovals (audit trail of the incident)", "-");
  step(6, "Verify: counts per collection; no seed SKUs/emails remain; original owner can log in; demo logins fail; no dangling refs; stock = Σ FIFO layers per product", "-");
  console.log(`\nVERDICT: ${verdict}`);
  console.log("\nRECOVERY DRY RUN (nothing executed):");
  for (const p of report.plan) console.log(`  [${p.step}] ${p.action}\n      affected: ${JSON.stringify(p.affected)}  — ${p.status}`);

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nFull candidate list (${report.candidates.length} records) written locally to ${path.relative(process.cwd(), OUT)}`);
  await client.close();
})().catch((e) => { console.error("Investigation stopped:", e.message); process.exit(1); });
