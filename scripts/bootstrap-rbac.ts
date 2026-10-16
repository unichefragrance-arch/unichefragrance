import { ensureAuthBootstrap } from "../src/lib/auth/bootstrap";
import { connectDB } from "../src/lib/db";
import { Branch, User } from "../src/lib/models";
import { hashPassword } from "../src/lib/auth/password";
import { ROLE_LABELS } from "../src/lib/auth/roles";
import type { UserRole } from "../src/lib/types";
import mongoose from "mongoose";
import { assertLocalOnlyTarget } from "./lib/dbSafety";
import { requireOwnerCredentials, type OwnerCredentials } from "./lib/ownerCredentials";

function env(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v || fallback;
}

type DemoUser = {
  name: string;
  email: string;
  password: string;
  role: UserRole;
};

function demoUsersFromEnv(owner: OwnerCredentials): DemoUser[] {
  return [
    {
      // Owner: from the environment only — no committed default (see lib/ownerCredentials).
      ...owner,
      role: "owner",
    },
    {
      name: "Manager",
      email: env("ADMIN_USER_EMAIL", "admin@unich.local").toLowerCase(),
      password: env("ADMIN_USER_PASSWORD", "admin123"),
      role: "manager",
    },
    {
      name: "Cashier",
      email: env("SALES_EMAIL", "sales@unich.local").toLowerCase(),
      password: env("SALES_PASSWORD", "sales123"),
      role: "cashier",
    },
    {
      name: "Accountant",
      email: env("ACCOUNTANT_EMAIL", "accounts@unich.local").toLowerCase(),
      password: env("ACCOUNTANT_PASSWORD", "accounts123"),
      role: "accountant",
    },
    {
      name: "Inventory",
      email: env("INVENTORY_EMAIL", "inventory@unich.local").toLowerCase(),
      password: env("INVENTORY_PASSWORD", "inventory123"),
      role: "inventory",
    },
    {
      name: "Branch Manager",
      email: env("BRANCH_MANAGER_EMAIL", "branchmanager@unich.local").toLowerCase(),
      password: env("BRANCH_MANAGER_PASSWORD", "branch123"),
      role: "branch_manager",
    },
  ];
}

async function upsertUser(
  branchId: unknown,
  branchName: string,
  d: DemoUser,
) {
  const existing = await User.findOne({ email: d.email });
  if (existing) {
    existing.name = d.name;
    existing.passwordHash = hashPassword(d.password);
    existing.role = d.role;
    existing.roleLabel = ROLE_LABELS[d.role];
    existing.branchId = branchId as typeof existing.branchId;
    existing.branchName = branchName;
    existing.active = true;
    await existing.save();
    console.log("updated:", d.email, `(${d.role})`);
    return;
  }

  await User.create({
    name: d.name,
    email: d.email,
    passwordHash: hashPassword(d.password),
    role: d.role,
    roleLabel: ROLE_LABELS[d.role],
    branchId,
    branchName,
    active: true,
  });
  console.log("created:", d.email, `(${d.role})`);
}

async function main() {
  // Destructive: local databases only — refuses Atlas/remote/unset targets, no override.
  assertLocalOnlyTarget("bootstrap-rbac");
  // Before any write: refuse when the owner variables are missing.
  const demoUsers = demoUsersFromEnv(requireOwnerCredentials("bootstrap-rbac"));
  await ensureAuthBootstrap();
  await connectDB();

  let branch = await Branch.findOne({ code: "MAIN" });
  if (!branch) {
    branch = await Branch.create({
      name: "Main Store — Muscat",
      code: "MAIN",
      active: true,
    });
  }

  for (const d of demoUsers) {
    await upsertUser(branch._id, branch.name, d);
  }

  const users = await User.find()
    .select("name email role roleLabel branchName active")
    .lean();
  console.log("\nRBAC users (.env synced):");
  for (const u of users) {
    console.log(`  ${u.email}  →  ${u.roleLabel}  (${u.branchName || "—"})`);
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
