import dns from "node:dns";
import "dotenv/config";

dns.setDefaultResultOrder("ipv4first");
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {
  // ignore
}

import mongoose from "mongoose";
import { migrationMode } from "./lib/dbSafety";
import { connectDB } from "../src/lib/db";
import { Branch, User } from "../src/lib/models";
import { hashPassword } from "../src/lib/auth/password";
import { ROLE_LABELS } from "../src/lib/auth/roles";

/**
 * One-off: remaps existing `users.role` values from the old scheme
 * (super_admin/admin/sales) to the new one (owner/manager/cashier), and
 * seeds a Branch Manager account if none exists yet. Only touches the
 * `users` collection — unlike `db:seed`, nothing else is wiped.
 */
const ROLE_RENAMES: Record<string, "owner" | "manager" | "cashier"> = {
  super_admin: "owner",
  admin: "manager",
  sales: "cashier",
};

async function main() {
  // Dry run unless --apply --confirm-db=<name>.
  const { apply } = migrationMode("migrate-roles");
  await connectDB();

  console.log("Before:");
  for (const role of await User.distinct("role")) {
    console.log(`  ${role}: ${await User.countDocuments({ role })}`);
  }

  if (!apply) {
    for (const [oldRole, newRole] of Object.entries(ROLE_RENAMES)) {
      console.log(`[dry run] ${oldRole} -> ${newRole}: ${await User.countDocuments({ role: oldRole })} would be updated`);
    }
    const hasBm = await User.exists({ role: "branch_manager" });
    console.log(`[dry run] branch_manager account: ${hasBm ? "exists — nothing to create" : "would be created"}`);
    await mongoose.disconnect();
    return;
  }

  for (const [oldRole, newRole] of Object.entries(ROLE_RENAMES)) {
    const res = await User.updateMany(
      { role: oldRole },
      { $set: { role: newRole, roleLabel: ROLE_LABELS[newRole] } },
    );
    console.log(`${oldRole} -> ${newRole}: ${res.modifiedCount} updated`);
  }

  const hasBranchManager = await User.exists({ role: "branch_manager" });
  if (!hasBranchManager) {
    const branch =
      (await Branch.findOne({ code: "MAIN" })) || (await Branch.findOne());
    if (branch) {
      const email = (
        process.env.BRANCH_MANAGER_EMAIL || "branchmanager@unich.local"
      )
        .trim()
        .toLowerCase();
      const password =
        process.env.BRANCH_MANAGER_PASSWORD || "branch123";
      const existing = await User.findOne({ email });
      if (!existing) {
        await User.create({
          name: "Branch Manager",
          email,
          passwordHash: hashPassword(password),
          role: "branch_manager",
          roleLabel: ROLE_LABELS.branch_manager,
          branchId: branch._id,
          branchName: branch.name,
          active: true,
        });
        console.log(`Created branch_manager user: ${email}`);
      } else {
        console.log(
          `Skipped creating branch_manager: email ${email} already in use by another user.`,
        );
      }
    } else {
      console.log("Skipped creating branch_manager: no branch found.");
    }
  }

  console.log("After:");
  for (const role of await User.distinct("role")) {
    console.log(`  ${role}: ${await User.countDocuments({ role })}`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
