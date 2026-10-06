import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/auth/apiGuard";
import {
  isAuthResponse,
  requirePermission,
} from "@/lib/auth/guards";
import { mapUserPublic } from "@/lib/auth/mapUser";
import { hashPassword } from "@/lib/auth/password";
import {
  isUserRole,
  ROLE_LABELS,
} from "@/lib/auth/roles";
import { connectDB } from "@/lib/db";
import { AuthSession, Branch, User } from "@/lib/models";
import { recordAudit } from "@/lib/audit/log";
import type { UserRole } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/users/[id] */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = requirePermission(req, "users:read");
    if (isAuthResponse(auth)) return auth;

    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
    }
    await connectDB();
    const user = await User.findById(id);
    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    return NextResponse.json(mapUserPublic(user));
  } catch (error) {
    return NextResponse.json(
      {
        error: safeErrorMessage(error, "Failed to load user"),
      },
      { status: 500 },
    );
  }
}

/** PUT /api/users/[id] — update profile, role, branch, password. */
export async function PUT(req: Request, ctx: Ctx) {
  try {
    const auth = requirePermission(req, "users:write");
    if (isAuthResponse(auth)) return auth;

    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
    }
    await connectDB();
    const user = await User.findById(id);
    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    // Any change to an Owner (password, email, active…) — not just role —
    // would let a non-Owner take the account over.
    if (user.role === "owner" && auth.role !== "owner") {
      return NextResponse.json(
        { error: "Only Owner can modify Owner users." },
        { status: 403 },
      );
    }
    // Same scope as POST: non-Owner managers only manage their own branch.
    if (
      auth.role !== "owner" &&
      auth.branchId &&
      String(user.branchId ?? "") !== auth.branchId
    ) {
      return NextResponse.json(
        { error: "You can only manage users in your own branch." },
        { status: 403 },
      );
    }

    const body = (await req.json()) as {
      name?: string;
      email?: string;
      password?: string;
      role?: string;
      branchId?: string | null;
      active?: boolean;
    };

    if (typeof body.name === "string" && body.name.trim()) {
      user.name = body.name.trim();
    }

    if (typeof body.email === "string" && body.email.trim()) {
      const email = body.email.trim().toLowerCase();
      if (email !== user.email) {
        const clash = await User.findOne({ email, _id: { $ne: user._id } });
        if (clash) {
          return NextResponse.json(
            { error: "A user with this email already exists." },
            { status: 409 },
          );
        }
        user.email = email;
      }
    }

    let passwordChanged = false;
    if (typeof body.password === "string" && body.password.length > 0) {
      if (body.password.length < 6) {
        return NextResponse.json(
          { error: "Password must be at least 6 characters." },
          { status: 400 },
        );
      }
      user.passwordHash = hashPassword(body.password);
      passwordChanged = true;
    }

    if (body.role !== undefined) {
      if (!isUserRole(body.role)) {
        return NextResponse.json({ error: "Invalid role." }, { status: 400 });
      }
      if (body.role === "owner" && auth.role !== "owner") {
        return NextResponse.json(
          { error: "Only Owner can assign Owner." },
          { status: 403 },
        );
      }
      if (user.role === "owner" && auth.role !== "owner") {
        return NextResponse.json(
          { error: "Only Owner can modify Owner users." },
          { status: 403 },
        );
      }
      user.role = body.role as UserRole;
      user.roleLabel = ROLE_LABELS[body.role as UserRole];
    }

    if (body.branchId !== undefined) {
      if (body.branchId === null || body.branchId === "") {
        if (user.role !== "owner") {
          return NextResponse.json(
            { error: "branchId is required for this role." },
            { status: 400 },
          );
        }
        user.branchId = undefined;
        user.branchName = null;
      } else {
        const branch = await Branch.findById(body.branchId);
        if (!branch || !branch.active) {
          return NextResponse.json(
            { error: "Invalid or inactive branch." },
            { status: 400 },
          );
        }
        if (
          auth.role !== "owner" &&
          auth.branchId &&
          String(branch._id) !== auth.branchId
        ) {
          return NextResponse.json(
            { error: "You can only assign users to your own branch." },
            { status: 403 },
          );
        }
        user.branchId = branch._id;
        user.branchName = branch.name;
      }
    }

    if (typeof body.active === "boolean") {
      if (String(user._id) === auth.userId && body.active === false) {
        return NextResponse.json(
          { error: "You cannot deactivate your own account." },
          { status: 400 },
        );
      }
      user.active = body.active;
    }

    await user.save();
    // A reset password must also end logins made with the old one.
    if (passwordChanged) {
      await AuthSession.updateMany(
        { userId: String(user._id), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
    }
    recordAudit({
      session: auth,
      action: "user_updated",
      entityType: "User",
      entityId: String(user._id),
      detail: `role=${user.role} branch=${user.branchName || ""} active=${user.active}`,
      req,
    });
    return NextResponse.json(mapUserPublic(user));
  } catch (error) {
    return NextResponse.json(
      {
        error: safeErrorMessage(error, "Failed to update user"),
      },
      { status: 400 },
    );
  }
}

/** DELETE /api/users/[id] — soft-deactivate (preferred) or hard-delete. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = requirePermission(req, "users:write");
    if (isAuthResponse(auth)) return auth;

    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
    }
    if (id === auth.userId) {
      return NextResponse.json(
        { error: "You cannot delete your own account." },
        { status: 400 },
      );
    }

    await connectDB();
    const user = await User.findById(id);
    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    if (user.role === "owner" && auth.role !== "owner") {
      return NextResponse.json(
        { error: "Only Owner can remove Owner users." },
        { status: 403 },
      );
    }
    if (
      auth.role !== "owner" &&
      auth.branchId &&
      String(user.branchId ?? "") !== auth.branchId
    ) {
      return NextResponse.json(
        { error: "You can only manage users in your own branch." },
        { status: 403 },
      );
    }

    // Soft deactivate by default
    user.active = false;
    await user.save();
    recordAudit({
      session: auth,
      action: "user_deactivated",
      entityType: "User",
      entityId: String(user._id),
      detail: user.email,
      req,
    });
    return NextResponse.json({ ok: true, user: mapUserPublic(user) });
  } catch (error) {
    return NextResponse.json(
      {
        error: safeErrorMessage(error, "Failed to delete user"),
      },
      { status: 400 },
    );
  }
}
