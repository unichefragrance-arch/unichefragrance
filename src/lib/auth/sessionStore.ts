/**
 * Server-side session lifecycle. The signed cookie alone can't be taken back,
 * so every login gets an AuthSession record and requests are checked against
 * it plus the live user (active, role, branch) — see proxy.ts.
 */
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { AuthSession, User } from "@/lib/models";
import { COOKIE_MAX_AGE_SEC, createSessionToken, type AppSession } from "@/lib/auth/session";

/** How long a positive/negative check is reused — revocation applies within this window. */
const LIVE_CACHE_MS = 5_000;
const liveCache = new Map<string, { at: number; ok: boolean }>();
/**
 * A healthy session lookup takes milliseconds; past this the database is
 * treated as unavailable so requests fail fast (503) instead of waiting for
 * the driver's 15 s server-selection timeout.
 */
const SESSION_CHECK_TIMEOUT_MS = 2_500;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Session check timed out"), { name: "SessionCheckTimeout" })), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function issueSession(
  input: Omit<AppSession, "exp" | "sid">,
): Promise<{ token: string; sid: string; exp: number }> {
  await connectDB();
  const sid = randomBytes(18).toString("base64url");
  const exp = Date.now() + COOKIE_MAX_AGE_SEC * 1000;
  await AuthSession.create({ sid, userId: input.userId, expiresAt: new Date(exp) });
  return { token: createSessionToken({ ...input, sid, exp }), sid, exp };
}

export async function revokeSession(sid: string | undefined): Promise<void> {
  if (!sid) return;
  await connectDB();
  await AuthSession.updateOne({ sid, revokedAt: null }, { $set: { revokedAt: new Date() } });
  liveCache.delete(sid);
}

/**
 * Server-side session check:
 *  - "live": not revoked or expired, and its user still exists, is active and
 *    has the role/branch the cookie claims (a demotion or branch move forces a
 *    fresh login);
 *  - "dead": any of that is false — the cookie must be dropped;
 *  - "unavailable": the database could not be asked. That says nothing about
 *    the session, so callers must not log the user out, and it is not cached.
 */
export type SessionCheck = "live" | "dead" | "unavailable";

export async function checkSession(session: AppSession): Promise<SessionCheck> {
  if (!session.sid) return "dead"; // pre-revocation cookies: log in again
  const hit = liveCache.get(session.sid);
  if (hit && Date.now() - hit.at < LIVE_CACHE_MS) return hit.ok ? "live" : "dead";

  let ok = false;
  if (mongoose.isValidObjectId(session.userId)) {
    try {
      const lookup = (async () => {
        await connectDB();
        return Promise.all([
          AuthSession.findOne({ sid: session.sid })
            .select("userId revokedAt expiresAt")
            .lean<{ userId: string; revokedAt?: Date | null; expiresAt: Date }>(),
          User.findById(session.userId)
            .select("active role branchId")
            .lean<{ active?: boolean; role: string; branchId?: unknown }>(),
        ]);
      })();
      lookup.catch(() => undefined); // may settle after the timeout below
      const [rec, user] = await withTimeout(lookup, SESSION_CHECK_TIMEOUT_MS);
      ok =
        !!rec &&
        !rec.revokedAt &&
        rec.expiresAt.getTime() > Date.now() &&
        rec.userId === session.userId &&
        !!user &&
        user.active !== false &&
        user.role === session.role &&
        String(user.branchId ?? "") === String(session.branchId ?? "");
    } catch (err) {
      console.error(
        `[session] live-session check failed (database unavailable?): ${err instanceof Error ? err.name : "Error"}`,
      );
      return "unavailable";
    }
  }
  liveCache.set(session.sid, { at: Date.now(), ok });
  if (liveCache.size > 5_000) liveCache.clear();
  return ok ? "live" : "dead";
}

/** True only for a confirmed live session (unavailable counts as not live). */
export async function isSessionLive(session: AppSession): Promise<boolean> {
  return (await checkSession(session)) === "live";
}
