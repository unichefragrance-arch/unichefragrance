/**
 * QA regression runner (npm run test:qa).
 *
 * Seeds a LOCAL throwaway database with scripts/seed.ts, then runs every
 * tests/qa suite against `next start` (run `npm run build` first). Each suite
 * boots its own server on its own port and drives the real API over HTTP.
 *
 * Safety: refuses unless DATABASE_URL points at localhost (seeding wipes the
 * database). Email/SMS providers are disabled for the run — nothing is sent.
 *
 *   mongod --replSet rs0 --port 27099 --dbpath /tmp/unich-qa --fork --logpath /tmp/unich-qa.log
 *   mongosh --port 27099 --eval 'rs.initiate()'
 *   DATABASE_URL="mongodb://127.0.0.1:27099/unich_qa?replicaSet=rs0&directConnection=true" npm run test:qa
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertLocalDb } from "../../src/lib/e2eGuard";

const SUITES = [
  "seed-data", // must run first: checks the freshly seeded data
  "salesperson",
  "branch-isolation",
  "hold-resume",
  "quotations",
  "receipts",
  "returns",
  "customer-edit",
  "report-rounding",
];

assertLocalDb();
if (!fs.existsSync(path.join(process.cwd(), ".next", "BUILD_ID"))) {
  console.error("No production build found — run `npm run build` first (suites use `next start`).");
  process.exit(2);
}

const env = {
  ...process.env,
  EMAIL_PROVIDER: "none",
  RESEND_API_KEY: "disabled-for-tests",
  SMS_PROVIDER: "",
  TWILIO_ACCOUNT_SID: "",
  TWILIO_AUTH_TOKEN: "",
};

function run(args: string[]) {
  return spawnSync("npx", args, { cwd: process.cwd(), env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

console.log("Seeding local database…");
const seed = run(["tsx", "scripts/seed.ts"]);
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  process.exit(1);
}

let totalPassed = 0;
let totalFailed = 0;
const broken: string[] = [];
for (const suite of SUITES) {
  const t = Date.now();
  const res = run(["tsx", path.join("tests", "qa", `${suite}.ts`)]);
  const out = `${res.stdout}\n${res.stderr}`;
  const summary = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  const secs = Math.round((Date.now() - t) / 1000);
  if (!summary) {
    broken.push(suite);
    console.log(`✗ ${suite}: crashed (exit ${res.status}, ${secs}s)`);
    console.log(out.split("\n").filter((l) => !/MONGOOSE|trace-warnings/.test(l)).slice(-8).join("\n"));
    continue;
  }
  const passed = Number(summary[1]);
  const failed = Number(summary[2]);
  totalPassed += passed;
  totalFailed += failed;
  console.log(`${failed ? "✗" : "✓"} ${suite}: ${passed} passed, ${failed} failed (${secs}s)`);
  for (const line of out.split("\n").filter((l) => l.includes("✗"))) console.log(`    ${line.trim()}`);
}

console.log(`\nQA total: ${totalPassed} passed, ${totalFailed} failed${broken.length ? `, crashed: ${broken.join(", ")}` : ""}`);
process.exit(totalFailed > 0 || broken.length > 0 ? 1 : 0);
