/**
 * Safety guard for E2E scripts that write and delete real documents.
 * Exits (code 2) before any DB connection unless DATABASE_URL points at
 * localhost — e.g. a throwaway `mongod --replSet` / mongodb-memory-server.
 * Override only for a dedicated dev/staging DB: E2E_ALLOW_REMOTE_DB=1.
 */
export function isLocalDbUrl(url: string): boolean {
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
  if (!isLocalDbUrl(url) && process.env.E2E_ALLOW_REMOTE_DB !== "1") {
    console.error(
      "Refusing to run: DATABASE_URL is not a local DB. Point it at a throwaway local replica set, or set E2E_ALLOW_REMOTE_DB=1 for a dedicated dev/staging DB.",
    );
    process.exit(2);
  }
}
