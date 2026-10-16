import { NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/auth/apiGuard";
import { clearLoginAttempts, reserveLoginAttempt } from "@/lib/auth/rateLimit";
import {
  clearFormulaAdminCookieHeader,
  createFormulaAdminToken,
  formulaAdminCookieHeader,
  getConfiguredAdminEmail,
  getFormulaAdmin,
  verifyFormulaAdminCredentials,
} from "@/lib/auth/formulaAdmin";

/** GET — is formula-admin session active? */
export async function GET(req: Request) {
  const admin = getFormulaAdmin(req);
  if (!admin) {
    return NextResponse.json({
      unlocked: false,
      /** Hint only — never return the password. */
      emailHint: getConfiguredAdminEmail()
        ? getConfiguredAdminEmail().replace(/(.{2}).+(@.+)/, "$1***$2")
        : null,
    });
  }
  return NextResponse.json({
    unlocked: true,
    name: admin.name,
    email: admin.email,
    exp: admin.exp,
  });
}

/** POST — unlock with admin email + password; sets httpOnly cookie. */
export async function POST(req: Request) {
  try {
    const body = ((await req.json().catch(() => null)) ?? {}) as {
      email?: string;
      password?: string;
      name?: string;
    };

    if (
      (body.email !== undefined && typeof body.email !== "string") ||
      (body.password !== undefined && typeof body.password !== "string") ||
      (body.name !== undefined && typeof body.name !== "string")
    ) {
      return NextResponse.json({ error: "Email and password must be text." }, { status: 400 });
    }
    const email = (body.email || "").trim().toLowerCase();

    // This public endpoint checks ADMIN_PASSWORD — the owner's password too —
    // so it gets the same lockout as login (own bucket), or it would be an
    // unlimited guessing oracle that sidesteps the login lockout.
    const rl = await reserveLoginAttempt(`formula-admin:${email}`);
    if (rl.blocked) {
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }

    if (
      !verifyFormulaAdminCredentials({
        email: body.email,
        password: body.password,
      })
    ) {
      return NextResponse.json(
        { error: "Invalid admin email or password" },
        { status: 403 },
      );
    }
    void clearLoginAttempts(`formula-admin:${email}`);

    const name = (body.name || email || "Admin").trim() || "Admin";
    const token = createFormulaAdminToken(name, email);
    const res = NextResponse.json({ unlocked: true, name, email });
    res.headers.set("Set-Cookie", formulaAdminCookieHeader(token));
    return res;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to unlock formulas"),
      },
      { status: 400 },
    );
  }
}

/** DELETE — lock / clear session cookie. */
export async function DELETE() {
  const res = NextResponse.json({ unlocked: false });
  res.headers.set("Set-Cookie", clearFormulaAdminCookieHeader());
  return res;
}
