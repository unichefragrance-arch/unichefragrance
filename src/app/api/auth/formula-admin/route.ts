import { NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/auth/apiGuard";
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

    const email = (body.email || "").trim().toLowerCase();
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
