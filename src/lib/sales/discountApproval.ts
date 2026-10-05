import { createHash, randomBytes } from "node:crypto";
import type mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { DiscountApproval, User } from "@/lib/models";
import { verifyPasswordAsync } from "@/lib/auth/password";
import { clearLoginAttempts, reserveLoginAttempt } from "@/lib/auth/rateLimit";
import { SaleError } from "@/lib/sales/errors";
import {
  discountLimitFor,
  exceedsDiscountLimit,
  roundMoney,
  type DiscountBreakdown,
} from "@/lib/sales/discount";
import type { IncomingSaleLine } from "@/lib/sales/validateSale";
import type { UserRole } from "@/lib/types";

export type DiscountActor = {
  userId?: string;
  name?: string;
  role?: UserRole | null;
};

export type DiscountApprovalInput = {
  email?: string;
  password?: string;
};

export type DiscountApprover = {
  userId: string;
  name: string;
  role: UserRole;
};

/**
 * POS-071/072: a discount within the actor's role limit passes as-is (null).
 * Above it, a manager/owner must approve with their own credentials, and
 * their role limit must cover the discount — otherwise the sale is blocked.
 * Approver passwords share the login rate limit, so this can't be used to
 * brute-force an account — the attempt is reserved atomically before the
 * password is checked, so parallel guesses can't outrun the lockout.
 */
export async function resolveDiscountApproval(
  breakdown: DiscountBreakdown,
  actor: DiscountActor | null,
  approval: DiscountApprovalInput | null | undefined,
): Promise<DiscountApprover | null> {
  if (breakdown.discountTotal <= 0) return null;
  if (!exceedsDiscountLimit(breakdown, actor?.role)) return null;

  const pct = breakdown.maxDiscountPct;
  const ownLimit = discountLimitFor(actor?.role);
  const email = approval?.email?.trim().toLowerCase();
  const password = approval?.password ?? "";
  if (!email || !password) {
    throw new SaleError(
      "DISCOUNT_APPROVAL_REQUIRED",
      `Discount of ${pct}% exceeds your ${ownLimit}% limit — manager approval required`,
    );
  }

  await connectDB();
  const [rl, user] = await Promise.all([
    reserveLoginAttempt(email),
    User.findOne({ email }).select("name role passwordHash active").lean<{
      _id: unknown;
      name: string;
      role: UserRole;
      passwordHash: string;
      active?: boolean;
    }>(),
  ]);
  if (rl.blocked) {
    throw new SaleError(
      "DISCOUNT_NOT_AUTHORIZED",
      "Too many approval attempts for this account. Try again later.",
    );
  }
  // Async scrypt: a sync hash would stall every other checkout on this server.
  if (
    !user ||
    user.active === false ||
    !(await verifyPasswordAsync(password, user.passwordHash))
  ) {
    throw new SaleError("DISCOUNT_NOT_AUTHORIZED", "Approval failed: invalid approver email or password");
  }
  void clearLoginAttempts(email);

  const approverLimit = discountLimitFor(user.role);
  if (breakdown.rawMaxDiscountPct > approverLimit + 1e-9) {
    throw new SaleError(
      "DISCOUNT_NOT_AUTHORIZED",
      `${user.name} can approve up to ${approverLimit}% — this discount is ${pct}%`,
    );
  }
  return { userId: String(user._id), name: user.name, role: user.role };
}

/** How long a manager's approval stays usable at the till. */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

function normDiscount(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const { type, value } = raw as { type?: unknown; value?: unknown };
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? { type: String(type), value: roundMoney(num) } : null;
}

/**
 * What the manager approved: every input that affects price or discount.
 * Changing any line, qty or discount after approval needs a new approval.
 */
export function cartFingerprint(lines: IncomingSaleLine[], invoiceDiscount: unknown): string {
  const norm = (Array.isArray(lines) ? lines : []).map((l) => ({
    p: String(l.productId ?? ""),
    q: Number(l.qty),
    t: String(l.lineType ?? ""),
    u: String(l.unitLabel ?? ""),
    o: String(l.oilProductId ?? ""),
    f: String(l.formulaId ?? ""),
    k: (Array.isArray(l.packagingProductIds) ? l.packagingProductIds.map(String) : []).sort(),
    d: normDiscount(l.discount),
  }));
  return createHash("sha256")
    .update(JSON.stringify({ lines: norm, invoice: normDiscount(invoiceDiscount) }))
    .digest("hex");
}

/**
 * POS-072: a single-use, short-lived approval bound to the requesting user and
 * this exact cart. The checkout request carries only this token — never the
 * manager's password — so a captured checkout can't approve another sale.
 */
export async function issueDiscountApproval(input: {
  breakdown: DiscountBreakdown;
  actor: DiscountActor;
  approver: DiscountApprover;
  fingerprint: string;
}): Promise<{ token: string; expiresAt: Date }> {
  await connectDB();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  await DiscountApproval.create({
    token,
    actorUserId: input.actor.userId,
    approverUserId: input.approver.userId,
    approverName: input.approver.name,
    approverRole: input.approver.role,
    fingerprint: input.fingerprint,
    maxDiscountPct: input.breakdown.maxDiscountPct,
    discountTotal: input.breakdown.discountTotal,
    expiresAt,
  });
  return { token, expiresAt };
}

type ApprovalDoc = {
  token: string;
  actorUserId: string;
  approverUserId: string;
  approverName: string;
  approverRole: UserRole;
  fingerprint: string;
  expiresAt: Date;
  usedAt?: Date | null;
};

/**
 * Pre-checks an approval token for this checkout (read-only). Use is NOT
 * checked here — `consumeDiscountApproval` does that inside the sale
 * transaction, after the sale insert, so a retried checkout with the same
 * idempotency key gets the original sale back instead of "already used".
 */
export async function verifyDiscountApproval(
  token: string | undefined,
  breakdown: DiscountBreakdown,
  actor: DiscountActor | null,
  fingerprint: string,
): Promise<DiscountApprover> {
  const pct = breakdown.maxDiscountPct;
  const ownLimit = discountLimitFor(actor?.role);
  if (!token || typeof token !== "string") {
    throw new SaleError(
      "DISCOUNT_APPROVAL_REQUIRED",
      `Discount of ${pct}% exceeds your ${ownLimit}% limit — manager approval required`,
    );
  }
  await connectDB();
  const doc = await DiscountApproval.findOne({ token }).lean<ApprovalDoc>();
  if (
    !doc ||
    !actor?.userId ||
    doc.actorUserId !== actor.userId ||
    doc.fingerprint !== fingerprint ||
    doc.expiresAt.getTime() <= Date.now()
  ) {
    throw new SaleError(
      "DISCOUNT_APPROVAL_REQUIRED",
      "Approval is missing, expired, or for a different bill — ask the manager to approve again",
    );
  }
  // Prices are re-read at checkout: the approver's limit must still cover it.
  if (breakdown.rawMaxDiscountPct > discountLimitFor(doc.approverRole) + 1e-9) {
    throw new SaleError(
      "DISCOUNT_NOT_AUTHORIZED",
      `${doc.approverName} can approve up to ${discountLimitFor(doc.approverRole)}% — this discount is ${pct}%`,
    );
  }
  return { userId: doc.approverUserId, name: doc.approverName, role: doc.approverRole };
}

/** Marks the token used by `saleId` — atomically, inside the sale transaction. */
export async function consumeDiscountApproval(
  token: string,
  saleId: mongoose.Types.ObjectId,
  session: mongoose.ClientSession,
): Promise<void> {
  const now = new Date();
  const used = await DiscountApproval.findOneAndUpdate(
    { token, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now, saleId } },
    { session },
  );
  if (!used) {
    throw new SaleError(
      "DISCOUNT_NOT_AUTHORIZED",
      "This approval was already used or has expired — ask the manager to approve again",
    );
  }
}
