/**
 * Safety guard for E2E scripts that write and delete real documents.
 * Exits (code 2) before any DB connection unless DATABASE_URL points at
 * localhost — e.g. a throwaway `mongod --replSet` / mongodb-memory-server.
 * There is no override: these scripts create and delete documents, and an
 * environment-variable escape hatch is exactly how a remote DB gets hit.
 */
export function isLocalDbUrl(url: string): boolean {
  // SRV records are resolved via DNS — never treat them as local.
  if (!/^mongodb:\/\//.test(url.trim())) return false;
  const host =
    url.replace(/^mongodb(\+srv)?:\/\//, "").split(/[/?]/)[0].split("@").pop() || "";
  return (
    host !== "" &&
    host
      .split(",")
      .every((h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h))
  );
}

export function assertLocalDb() {
  const url = process.env.DATABASE_URL || "";
  if (!isLocalDbUrl(url)) {
    console.error(
      "Refusing to run: DATABASE_URL is not a local DB. Point it at a throwaway local replica set (no override exists).",
    );
    process.exit(2);
  }
}
