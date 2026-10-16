/**
 * Owner (super admin) account for seed / bootstrap scripts — from the
 * environment only. There is deliberately NO built-in email or password:
 * a fallback committed to git is a credential anyone with the repo can read.
 * Scripts call this BEFORE writing anything, so a missing variable can never
 * leave a half-seeded database. Values are never printed.
 */
export type OwnerCredentials = { name: string; email: string; password: string };

type Env = Record<string, string | undefined>;

const pick = (env: Env, ...names: string[]) =>
  names.map((n) => env[n]?.trim()).find((v) => Boolean(v)) ?? "";

export function readOwnerCredentials(
  env: Env,
): { ok: true; owner: OwnerCredentials } | { ok: false; missing: string[] } {
  const email = pick(env, "SUPER_ADMIN_EMAIL", "ADMIN_EMAIL").toLowerCase();
  const password = pick(env, "SUPER_ADMIN_PASSWORD", "ADMIN_PASSWORD");
  const missing = [
    ...(email ? [] : ["SUPER_ADMIN_EMAIL or ADMIN_EMAIL"]),
    ...(password ? [] : ["SUPER_ADMIN_PASSWORD or ADMIN_PASSWORD"]),
  ];
  if (missing.length) return { ok: false, missing };
  return { ok: true, owner: { name: pick(env, "ADMIN_NAME") || "Owner", email, password } };
}

/** Exits (code 2) with the names — never the values — of what is missing. */
export function requireOwnerCredentials(script: string, env: Env = process.env): OwnerCredentials {
  const r = readOwnerCredentials(env);
  if (!r.ok) {
    console.error(
      `[${script}] REFUSING TO RUN: set ${r.missing.join(" and ")} for the owner account (no built-in default).`,
    );
    process.exit(2);
  }
  return r.owner;
}
