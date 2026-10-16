import { NextResponse } from "next/server";
import { clearSessionCookie, getSessionFromRequest } from "@/lib/auth/session";
import { FORMULA_ADMIN_COOKIE } from "@/lib/auth/formulaAdmin";
import { revokeSession } from "@/lib/auth/sessionStore";

/** POST /api/auth/logout — revoke this login server-side, then clear the cookie. */
export async function POST(req: Request) {
  const session = getSessionFromRequest(req);
  await revokeSession(session?.sid).catch(() => undefined);
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  // The formula-recipe unlock is a separate cookie: on a shared till it
  // would otherwise outlive the logout and carry over to the next user.
  res.cookies.set(FORMULA_ADMIN_COOKIE, "", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  });
  return res;
}

export async function DELETE(req: Request) {
  return POST(req);
}
