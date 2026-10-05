import { NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/auth/apiGuard";
import {
  ensureAuthBootstrap,
  isAuthBootstrapped,
} from "@/lib/auth/bootstrap";
import { mapUserPublic } from "@/lib/auth/mapUser";
import { verifyPasswordAsync } from "@/lib/auth/password";
import { clearLoginAttempts, reserveLoginAttempt } from "@/lib/auth/rateLimit";
import { RATE_LIMIT, WARN_REMAINING } from "@/lib/auth/rateLimitConfig";
import { permissionsForRole, ROLE_LABELS } from "@/lib/auth/roles";
import { recordAudit } from "@/lib/audit/log";
import {
  applySessionCookie,
  createSessionToken,
} from "@/lib/auth/session";
import { AUTH_TIMEOUT_MS, withAuthTimeout } from "@/lib/auth/timeout";
import { connectDB } from "@/lib/db";
import { User } from "@/lib/models";

function rateLimitHeaders(remaining: number, resetAt: Date, retryAfterSec?: number) {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(RATE_LIMIT.account.maxAttempts),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(Math.ceil(resetAt.getTime() / 1000)),
  };
  if (retryAfterSec !== undefined) {
    headers["Retry-After"] = String(retryAfterSec);
  }
  return headers;
}

async function loginHandler(req: Request) {
  // Parse body first — no DB needed.
  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 },
    );
  }

  // Open DB connection once (shared by rate limit + user lookup below).
  if (isAuthBootstrapped()) {
    await connectDB();
  } else {
    await ensureAuthBootstrap();
  }

  // Reserve an attempt atomically BEFORE checking the password, so parallel
  // guesses can't outrun the lockout. Runs alongside the user lookup.
  const [rl, user] = await Promise.all([
    reserveLoginAttempt(email),
    User.findOne({ email })
      .select("name email passwordHash role roleLabel branchId branchName active")
      .lean(),
  ]);

  if (rl.blocked) {
    return NextResponse.json(
      { error: "Too many failed login attempts. Please try again later." },
      {
        status: 429,
        headers: rateLimitHeaders(0, rl.resetAt, rl.retryAfterSec),
      },
    );
  }

  // Async scrypt keeps the event loop free for other requests.
  const credentialsOk =
    user &&
    user.active !== false &&
    (await verifyPasswordAsync(password, user.passwordHash as string));

  if (!credentialsOk) {
    recordAudit({ action: "login_failed", entityType: "User", email, req });

    const remaining = rl.remaining;
    return NextResponse.json(
      {
        error: "Invalid email or password.",
        ...(remaining <= WARN_REMAINING && { attemptsRemaining: remaining }),
      },
      {
        status: 401,
        headers: rateLimitHeaders(remaining, rl.resetAt),
      },
    );
  }

  // Successful login — clear account counter and issue session cookie.
  void clearLoginAttempts(email);

  const role = user.role as keyof typeof ROLE_LABELS;
  const roleLabel =
    (user.roleLabel as string) || ROLE_LABELS[role] || String(user.role);

  void User.updateOne(
    { _id: user._id },
    {
      $set: {
        lastLoginAt: new Date(),
        ...(user.roleLabel ? {} : { roleLabel }),
      },
    },
  ).exec();

  const mapped = mapUserPublic({
    ...user,
    roleLabel,
    id: String(user._id),
  })!;

  const token = createSessionToken({
    userId: mapped.id,
    name: mapped.name,
    email: mapped.email,
    role: mapped.role,
    roleLabel: mapped.roleLabel,
    branchId: mapped.branchId,
    branchName: mapped.branchName,
  });

  recordAudit({
    session: {
      userId: mapped.id,
      name: mapped.name,
      email: mapped.email,
      role: mapped.role,
      roleLabel: mapped.roleLabel,
      branchId: mapped.branchId,
      branchName: mapped.branchName,
      exp: 0,
    },
    action: "login_success",
    entityType: "User",
    entityId: mapped.id,
    req,
  });

  const res = NextResponse.json({
    ok: true,
    user: mapped,
    permissions: permissionsForRole(mapped.role),
  });
  applySessionCookie(res, token);
  return res;
}

/** POST /api/auth/login — email + password → session cookie (≤3s budget). */
export async function POST(req: Request) {
  try {
    return await withAuthTimeout(loginHandler(req), "Login", AUTH_TIMEOUT_MS);
  } catch (error) {
    const message =
      safeErrorMessage(error, "Login failed");
    const timedOut = /too long/i.test(message);
    return NextResponse.json(
      { error: message },
      { status: timedOut ? 504 : 500 },
    );
  }
}
