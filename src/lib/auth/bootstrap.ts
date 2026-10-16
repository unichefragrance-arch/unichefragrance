import { connectDB } from "@/lib/db";
import { Branch, User } from "@/lib/models";
import { hashPassword } from "@/lib/auth/password";
import { ROLE_LABELS } from "@/lib/auth/roles";

/** Process-local lock so cold starts don't re-run bootstrap on every request. */
let bootstrapPromise: Promise<void> | null = null;
let bootstrapped = false;

export function isAuthBootstrapped(): boolean {
  return bootstrapped;
}

/**
 * Ensure at least one branch + admin user exist (BRN-08 bootstrap).
 * Uses ADMIN_EMAIL / ADMIN_PASSWORD from env when seeding the first admin.
 * Safe to call often — runs at most once per process (retries on failure).
 */
export async function ensureAuthBootstrap(): Promise<void> {
  if (bootstrapped) return;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    await connectDB();

    let branch = await Branch.findOne({ code: "MAIN" }).lean();
    if (!branch) {
      branch = (
        await Branch.create({
          name: "Main Store — Muscat",
          code: "MAIN",
          active: true,
        })
      ).toObject();
    }

    const existing = await User.exists({});
    if (existing) {
      bootstrapped = true;
      return;
    }

    const email = (
      process.env.ADMIN_EMAIL ||
      process.env.admin_email ||
      "admin@unich.local"
    )
      .trim()
      .toLowerCase();
    const password =
      process.env.ADMIN_PASSWORD ||
      process.env.FORMULA_ADMIN_PASSWORD ||
      process.env.IMPORT_ADMIN_PASSWORD;
    // No built-in default in any environment: `next dev` may point at a shared
    // database, and a known password there is as bad as in production.
    if (!password) {
      throw new Error(
        "ADMIN_PASSWORD is not set. Refusing to bootstrap the first admin user with a built-in default password.",
      );
    }

    const name =
      process.env.ADMIN_NAME?.trim() ||
      email.split("@")[0] ||
      "Admin";

    try {
      await User.create({
        name,
        email,
        passwordHash: hashPassword(password),
        role: "owner",
        roleLabel: ROLE_LABELS.owner,
        branchId: branch._id,
        branchName: branch.name,
        active: true,
      });
    } catch (err) {
      // Parallel first-login race: another request already created the admin.
      const code = (err as { code?: number })?.code;
      if (code !== 11000) throw err;
    }
    bootstrapped = true;
  })().catch((err) => {
    bootstrapPromise = null;
    bootstrapped = false;
    throw err;
  });

  return bootstrapPromise;
}
