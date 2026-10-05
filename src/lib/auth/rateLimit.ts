import { connectDB } from "@/lib/db";
import { RateLimit } from "@/lib/models";
import { RATE_LIMIT } from "@/lib/auth/rateLimitConfig";

export type LoginRateLimitCheck = {
  blocked: boolean;
  retryAfterSec: number;
  /** Attempts left after this one. */
  remaining: number;
  resetAt: Date;
};

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

function recentAttempts(attempts: Date[] | undefined, windowStart: number): Date[] {
  return (attempts ?? [])
    .map((t) => new Date(t))
    .filter((t) => t.getTime() > windowStart)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Reserve one password attempt for `email` BEFORE the password is checked.
 * The slot is taken in a single conditional write (only while fewer than
 * maxAttempts fall inside the window), so parallel requests can't all pass a
 * read-then-record check, and a locked-out caller adds nothing — the lockout
 * isn't extended and the array stays bounded. Call `clearLoginAttempts` after
 * a successful check.
 */
export async function reserveLoginAttempt(email: string): Promise<LoginRateLimitCheck> {
  await connectDB();
  const key = `email:${email}`;
  const { maxAttempts, windowMs } = RATE_LIMIT.account;
  const now = new Date();
  const windowStart = now.getTime() - windowMs;

  const reserve = () =>
    RateLimit.findOneAndUpdate(
      {
        key,
        $expr: {
          $lt: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ["$attempts", []] },
                  cond: { $gt: ["$$this", new Date(windowStart)] },
                },
              },
            },
            maxAttempts,
          ],
        },
      },
      {
        // Keep only the newest maxAttempts — older ones can't matter.
        $push: { attempts: { $each: [now], $slice: -maxAttempts } },
        $set: { expiresAt: new Date(now.getTime() + windowMs) },
      },
      { returnDocument: "after" },
    ).lean<{ attempts: Date[] }>();

  let doc = await reserve();
  if (!doc) {
    // No document yet, or the account is locked. Creating it is atomic too:
    // a duplicate key means another request created it first — try once more.
    try {
      await RateLimit.create({
        key,
        attempts: [now],
        expiresAt: new Date(now.getTime() + windowMs),
      });
      doc = { attempts: [now] };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      doc = await reserve();
    }
  }

  if (doc) {
    const recent = recentAttempts(doc.attempts, windowStart);
    return {
      blocked: false,
      retryAfterSec: 0,
      remaining: Math.max(0, maxAttempts - recent.length),
      resetAt: new Date((recent[0] ?? now).getTime() + windowMs),
    };
  }

  const locked = await RateLimit.findOne({ key }).lean<{ attempts: Date[] }>();
  const recent = recentAttempts(locked?.attempts, windowStart);
  const resetAt = new Date((recent[0] ?? now).getTime() + windowMs);
  return {
    blocked: true,
    retryAfterSec: Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)),
    remaining: 0,
    resetAt,
  };
}

export async function clearLoginAttempts(email: string): Promise<void> {
  await connectDB();
  await RateLimit.deleteOne({ key: `email:${email}` });
}
