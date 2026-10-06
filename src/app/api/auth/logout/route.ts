import { NextResponse } from "next/server";
import { clearSessionCookie, getSessionFromRequest } from "@/lib/auth/session";
import { revokeSession } from "@/lib/auth/sessionStore";

/** POST /api/auth/logout — revoke this login server-side, then clear the cookie. */
export async function POST(req: Request) {
  const session = getSessionFromRequest(req);
  await revokeSession(session?.sid).catch(() => undefined);
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}

export async function DELETE(req: Request) {
  return POST(req);
}
