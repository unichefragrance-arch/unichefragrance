/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS script, run with node */
/**
 * Recovery option 4(a) "clean slate" for the accidental seed of 2026-10-05.
 * Approved by the owner on 2026-10-05.
 *
 *   node scripts/recover-2026-10-05-clean-slate.cjs                          # dry run (read only)
 *   node scripts/recover-2026-10-05-clean-slate.cjs --apply --confirm-db=unich
 *
 * --apply:
 *   1. Full logical backup of EVERY collection (EJSON) to backups/<stamp>-pre-recovery/,
 *      verified by re-counting — this is the rollback point.
 *   2. Re-verifies the investigation: in the 12 seeded collections every document
 *      must match seed.ts (natural key) AND have been inserted in the seed window.
 *      Anything else → abort, nothing deleted.
 *   3. Deletes exactly those _ids (never deleteMany({})), children first, plus any
 *      server-side sessions of the 6 demo users.
 *   4. Verifies: seeded documents gone, demo logins gone, every other collection's
 *      count unchanged.
 * Afterwards the first login re-creates the MAIN branch and the ADMIN_EMAIL owner
 * (src/lib/auth/bootstrap.ts) from the deployed app's environment.
 * Credentials are never printed.
 *
 * The recovery was carried out on 2026-10-05. Since then --apply is LOCAL-ONLY
 * (fails closed, no override): it refuses any target that is not an explicit
 * mongodb://localhost|127.0.0.1|[::1] URL — Atlas/SRV/remote/unset all exit 2
 * before connecting. A dry run stays read-only. To rehearse, pass a local URL
 * inline: DATABASE_URL='mongodb://127.0.0.1:27099/unich_rehearsal?...'.
 */
const fs = require("node:fs");
const path = require("node:path");
const { MongoClient, BSON } = require("mongodb");

const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true });
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const CONFIRM = (argv.find((a) => a.startsWith("--confirm-db=")) || "").slice("--confirm-db=".length);

const SIGNATURE = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-signature.json"), "utf8"));
// Seed insert window measured by the read-only investigation (UTC), ±2 min.
// `--window=<from>,<to>` exists only to rehearse on a freshly seeded local copy.
const WINDOW_ARG = (argv.find((a) => a.startsWith("--window=")) || "").slice("--window=".length);
const WINDOW_FROM = new Date(WINDOW_ARG ? WINDOW_ARG.split(",")[0] : "2026-10-05T21:31:05Z");
const WINDOW_TO = new Date(WINDOW_ARG ? WINDOW_ARG.split(",")[1] : "2026-10-05T21:35:13Z");
// Children before parents.
const DELETE_ORDER = ["sales", "quotations", "fifolayers", "purchaseorders", "formulas", "customers", "expenses", "products", "suppliers", "appsettings", "users", "branches"];
const DEMO_EMAILS = ["owner@unich.local", "admin@unich.local", "sales@unich.local", "accounts@unich.local", "inventory@unich.local", "branchmanager@unich.local"];
const NATURAL = ["sku", "email", "phone", "number", "code"];

/** Same rule as src/lib/e2eGuard.ts isLocalDbUrl: plain mongodb:// and every host is loopback. */
function isLocalDbUrl(url) {
  const raw = String(url || "").trim();
  if (!/^mongodb:\/\//.test(raw)) return false;
  const host = raw.replace(/^mongodb:\/\//, "").split(/[/?]/)[0].split("@").pop() || "";
  return host !== "" && host.split(",").every((h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h));
}

function target(url) {
  const after = String(url || "").replace(/^mongodb(\+srv)?:\/\//, "");
  const host = after.split(/[/?]/)[0].split("@").pop() || "";
  return { hostSuffix: host.replace(/^[^.]+\./, "*."), dbName: (after.split("/")[1] || "").split("?")[0] || "test" };
}
const sigKey = (o, keys) => JSON.stringify(keys.map((k) => (o[k] === undefined ? null : o[k])));
function isSeedDoc(name, d) {
  const { keys, signatures } = SIGNATURE[name];
  const full = new Set(signatures.map((s) => sigKey(s, keys)));
  const natural = keys.some((k) => NATURAL.includes(k) && d[k] !== undefined && signatures.some((s) => s[k] === d[k]));
  const t = d._id && typeof d._id.getTimestamp === "function" ? d._id.getTimestamp() : null;
  return (full.has(sigKey(d, keys)) || natural) && t && t >= WINDOW_FROM && t <= WINDOW_TO;
}

(async () => {
  const t = target(process.env.DATABASE_URL);
  console.log(`Target: ${t.hostSuffix}/${t.dbName} — ${APPLY ? "APPLY" : "DRY RUN (read only)"}`);
  if (APPLY && !isLocalDbUrl(process.env.DATABASE_URL)) {
    console.error("REFUSING TO RUN: --apply deletes documents and only runs against a local disposable database (mongodb://localhost|127.0.0.1|[::1]). No override exists.");
    process.exit(2);
  }
  if (APPLY && (!CONFIRM || CONFIRM !== t.dbName)) {
    console.error(`REFUSING TO RUN: --apply needs --confirm-db=<database name> matching the target ("${t.dbName}").`);
    process.exit(2);
  }

  const client = new MongoClient(process.env.DATABASE_URL, { appName: "recovery-2026-10-05" });
  await client.connect();
  const db = client.db();
  const all = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));
  const countsBefore = {};
  for (const n of all) countsBefore[n] = await db.collection(n).countDocuments();

  // 2) Classify — abort on anything that is not seed output.
  const plan = {};
  const problems = [];
  for (const name of DELETE_ORDER) {
    const docs = await db.collection(name).find({}).toArray();
    const seed = docs.filter((d) => isSeedDoc(name, d));
    const other = docs.length - seed.length;
    if (other > 0) problems.push(`${name}: ${other} document(s) are NOT seed output`);
    plan[name] = seed.map((d) => d._id);
  }
  const demoUsers = await db.collection("users").find({ email: { $in: DEMO_EMAILS } }).project({ _id: 1 }).toArray();
  const demoSessions = await db.collection("authsessions").countDocuments({ userId: { $in: demoUsers.map((u) => String(u._id)) } });
  console.log("\nPlanned deletions (children first):");
  for (const n of DELETE_ORDER) console.log(`  ${n.padEnd(15)} ${String(plan[n].length).padStart(3)} of ${countsBefore[n]}`);
  console.log(`  authsessions    ${String(demoSessions).padStart(3)} (demo users)`);
  const total = Object.values(plan).reduce((a, ids) => a + ids.length, 0);
  console.log(`  total           ${total}`);
  const untouched = all.filter((n) => !DELETE_ORDER.includes(n));
  console.log(`\nUnchanged collections: ${untouched.map((n) => `${n}(${countsBefore[n]})`).join(", ")}`);
  if (problems.length) {
    console.log(`\nABORT — state differs from the investigation:\n  ${problems.join("\n  ")}`);
    await client.close();
    process.exit(3);
  }
  if (!APPLY) {
    console.log(`\nDry run only. To apply: --apply --confirm-db=${t.dbName}`);
    return client.close();
  }

  // 1) Backup every collection, then verify it.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(ROOT, "backups", `${stamp}-pre-recovery`);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of all) {
    const docs = await db.collection(n).find({}).toArray();
    fs.writeFileSync(path.join(dir, `${n}.json`), BSON.EJSON.stringify(docs, undefined, 2, { relaxed: false }));
    const back = BSON.EJSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), "utf8"), { relaxed: false });
    if (back.length !== countsBefore[n]) throw new Error(`backup of ${n} has ${back.length}, expected ${countsBefore[n]} — aborting before any delete`);
  }
  console.log(`\nBackup written and verified: ${path.relative(ROOT, dir)} (${all.length} collections)`);

  // 3) Delete exactly the planned _ids.
  const sres = await db.collection("authsessions").deleteMany({ userId: { $in: demoUsers.map((u) => String(u._id)) } });
  console.log(`  authsessions: ${sres.deletedCount} deleted`);
  for (const n of DELETE_ORDER) {
    if (plan[n].length === 0) continue;
    const res = await db.collection(n).deleteMany({ _id: { $in: plan[n] } });
    console.log(`  ${n}: ${res.deletedCount} deleted`);
    if (res.deletedCount !== plan[n].length) throw new Error(`${n}: expected ${plan[n].length}, deleted ${res.deletedCount} — stop and review (backup: ${dir})`);
  }

  // 4) Verify.
  let ok = true;
  for (const n of DELETE_ORDER) {
    const left = await db.collection(n).countDocuments({ _id: { $in: plan[n] } });
    if (left !== 0) { ok = false; console.log(`  ✗ ${n}: ${left} planned docs remain`); }
  }
  const demoLeft = await db.collection("users").countDocuments({ email: { $in: DEMO_EMAILS } });
  if (demoLeft !== 0) { ok = false; console.log(`  ✗ ${demoLeft} demo logins remain`); }
  for (const n of untouched) {
    if (n === "authsessions") continue;
    const now = await db.collection(n).countDocuments();
    if (now !== countsBefore[n]) { ok = false; console.log(`  ✗ ${n} changed: ${countsBefore[n]} → ${now}`); }
  }
  console.log(ok ? "\nVERIFIED: seed output removed, demo logins gone, other collections unchanged." : "\nVERIFICATION FAILED — see above; rollback from the backup if needed.");
  await client.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("Recovery stopped:", e.message);
  process.exit(1);
});
