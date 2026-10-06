/**
 * POS-154/166: what a failed checkout means for the bill, and what to tell the
 * cashier. Pure + client-safe (no DB imports) so it is unit-tested directly.
 *
 * The bill keeps one idempotency key until its outcome is known. After a lost
 * response the key is kept even if the cart is edited: the server then either
 * returns the sale it already made (same bill) or answers 409 (different
 * bill) — it never silently creates a second sale.
 */
export type CheckoutFailureKind =
  /** Browser reports no network: the request was not answered. */
  | "offline"
  /** Network error, timeout or server error: the sale may or may not exist. */
  | "unknown"
  /** This bill's key already completed a sale with different contents. */
  | "conflict"
  /** A definite refusal (4xx): no sale was made with this key. */
  | "rejected";

type ApiErrorLike = {
  name?: string;
  status?: number;
  data?: { code?: string; saleId?: string };
};

export function classifyCheckoutError(err: unknown, online: boolean): CheckoutFailureKind {
  const e = (err ?? {}) as ApiErrorLike;
  if (typeof e.status !== "number") {
    // fetch threw (TypeError / AbortError): no HTTP answer at all.
    return online ? "unknown" : "offline";
  }
  if (e.status === 409 && e.data?.code === "IDEMPOTENCY_CONFLICT") return "conflict";
  if (e.status >= 500) return "unknown";
  return "rejected";
}

/** The key is only replaced once the earlier attempt is known to have made a different sale. */
export function keepCheckoutKey(kind: CheckoutFailureKind): boolean {
  return kind !== "conflict";
}

export function checkoutFailureMessage(
  kind: CheckoutFailureKind,
  serverMessage: string,
  saleId?: string,
): string {
  switch (kind) {
    case "offline":
      return "You're offline — this sale was NOT completed. Reconnect, then press Complete again.";
    case "unknown":
      return "Connection problem — we couldn't confirm this sale. Press Complete again: if it already went through, it will not be charged twice.";
    case "conflict":
      return `This bill was already completed earlier${saleId ? ` (sale ${saleId.slice(-6)})` : ""}. Your changes were NOT charged — check Recent sales, or press Complete again to charge this cart as a new sale.`;
    default:
      return serverMessage;
  }
}
