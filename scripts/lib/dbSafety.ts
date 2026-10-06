/**
 * Target guards for scripts that write to MongoDB. Call before connecting.
 *
 * - assertLocalOnlyTarget: seed / wipe / reset / demo-account scripts. Refuses
 *   anything but an explicit localhost / 127.0.0.1 / ::1 target — Atlas, SRV,
 *   remote, mixed host lists, unset or unparseable URLs. There is deliberately
 *   NO environment-variable override (cf. the 2026-10-05 incident, where an
 *   unset DATABASE_URL was silently filled from .env with the Atlas URL).
 * - migrationMode: one-off migrations that may legitimately target production.
 *   Dry run by default; writing needs `--apply` AND `--confirm-db=<db name>`
 *   matching the target. Prints only redacted target metadata.
 */
import { isLocalDbUrl } from "../../src/lib/e2eGuard";

export type DbTarget = {
  hostCategory: "LOCAL" | "REMOTE" | "UNSET";
  hosts: string;
  dbName: string;
};

/** Credentials are never part of the result. */
export function describeDbTarget(url: string | undefined): DbTarget {
  const raw = String(url ?? "").trim();
  if (!raw) return { hostCategory: "UNSET", hosts: "", dbName: "" };
  const afterScheme = raw.replace(/^mongodb(\+srv)?:\/\//, "");
  const authority = afterScheme.split(/[/?]/)[0] ?? "";
  const hosts = authority.split("@").pop() ?? "";
  const dbName = (afterScheme.split("/")[1] ?? "").split("?")[0] || "test";
  const local = /^mongodb:\/\//.test(raw) && isLocalDbUrl(raw);
  return {
    hostCategory: local ? "LOCAL" : "REMOTE",
    // Show remote hosts only by suffix (cluster names can be sensitive).
    hosts: local ? hosts : hosts.split(",").map((h) => h.replace(/^[^.]+\./, "*.")).join(","),
    dbName,
  };
}

function refuse(script: string, reason: string): never {
  console.error(`[${script}] REFUSING TO RUN: ${reason}`);
  process.exit(2);
}

export function assertLocalOnlyTarget(script: string): DbTarget {
  const target = describeDbTarget(process.env.DATABASE_URL);
  if (target.hostCategory === "UNSET") {
    refuse(script, "DATABASE_URL is not set. Pass a local URL explicitly, e.g. DATABASE_URL='mongodb://127.0.0.1:27017/unich_dev'.");
  }
  if (target.hostCategory !== "LOCAL") {
    refuse(
      script,
      `this script deletes/overwrites data and only runs against a local database; target is ${target.hostCategory} (${target.hosts}/${target.dbName}). No override exists.`,
    );
  }
  console.log(`[${script}] target: LOCAL ${target.hosts}/${target.dbName}`);
  return target;
}

export function migrationMode(script: string, argv = process.argv): { apply: boolean; target: DbTarget } {
  const target = describeDbTarget(process.env.DATABASE_URL);
  if (target.hostCategory === "UNSET") refuse(script, "DATABASE_URL is not set.");
  console.log(`[${script}] target: ${target.hostCategory} ${target.hosts}/${target.dbName}`);
  const wantsApply = argv.includes("--apply");
  const confirm = argv.find((a) => a.startsWith("--confirm-db="))?.slice("--confirm-db=".length);
  if (!wantsApply) {
    console.log(`[${script}] DRY RUN — nothing will be written. To write: --apply --confirm-db=${target.dbName}`);
    return { apply: false, target };
  }
  if (confirm !== target.dbName) {
    refuse(script, `--apply needs --confirm-db=<database name> matching the target ("${target.dbName}").`);
  }
  console.log(`[${script}] APPLY confirmed for database "${target.dbName}".`);
  return { apply: true, target };
}
