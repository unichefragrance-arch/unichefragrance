/**
 * TESTS ONLY — a real user + live server-side session for a test identity.
 * Since sessions are checked against AuthSession and the user record (see
 * sessionStore.ts), a bare signed cookie is no longer enough. Refuses to run
 * against anything but a local database.
 */
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { hashPassword } from "@/lib/auth/password";
import type { AppSession } from "@/lib/auth/session";
import { issueSession } from "@/lib/auth/sessionStore";
import { isLocalDbUrl } from "@/lib/e2eGuard";
import { User } from "@/lib/models";

type UserLean = { _id: unknown; name: string; email: string; role: string; branchId?: unknown };

export async function testSessionCookie(input: Omit<AppSession, "exp" | "sid">): Promise<string> {
  if (!isLocalDbUrl(process.env.DATABASE_URL || "")) {
    throw new Error("testSessionCookie is for local test databases only");
  }
  const sameBranch = (u: UserLean) => String(u.branchId ?? "") === String(input.branchId ?? "");
  let user = mongoose.isValidObjectId(input.userId)
    ? await User.findById(input.userId).lean<UserLean>()
    : null;
  if (!user || user.role !== input.role || !sameBranch(user)) {
    // Keep the requested id when it is free, so tests can rely on it.
    const id = !user && mongoose.isValidObjectId(input.userId)
      ? new mongoose.Types.ObjectId(input.userId)
      : new mongoose.Types.ObjectId();
    const created = await User.create({
      _id: id,
      name: input.name || `QA ${input.role}`,
      email: `qa-${String(id)}@test.local`,
      passwordHash: hashPassword(randomUUID()),
      role: input.role,
      roleLabel: input.roleLabel || input.role,
      branchId: input.branchId && mongoose.isValidObjectId(input.branchId)
        ? new mongoose.Types.ObjectId(input.branchId)
        : null,
      branchName: input.branchName,
      active: true,
    });
    user = created.toObject() as UserLean;
  }
  const { token } = await issueSession({
    userId: String(user._id),
    name: user.name,
    email: user.email,
    role: input.role,
    roleLabel: input.roleLabel,
    branchId: user.branchId ? String(user.branchId) : null,
    branchName: input.branchName,
  });
  return `unich_session=${token}`;
}
