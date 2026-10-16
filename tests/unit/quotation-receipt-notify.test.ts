/**
 * Unit tests: quotation calc/lines/document, receipt document/text,
 * notifications (WhatsApp, SMS, email config branches).
 * fetch is mocked — no network calls.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { lineAmount, round2 } from "@/lib/quotation/calc";
import { normalizeQuotationLines } from "@/lib/quotation/lines";
import { buildQuotationDoc } from "@/lib/quotation/document";
import {
  currencyDecimals,
  formatPaymentLabel,
  lineTotal,
  receiptNumberFor,
  receiptStoreFromSettings,
  buildReceiptDoc,
} from "@/lib/receipt/document";
import { receiptSmsText } from "@/lib/receipt/text";
import {
  buildStoreWhatsAppUrl,
  buildWhatsAppUrl,
  formatQuotationMessage,
  formatQuotationSms,
} from "@/lib/notifications/whatsapp";
import { sendSms, smsConfigured } from "@/lib/notifications/sms";
import { sendEmail } from "@/lib/notifications/email";
import { withEnv } from "./_env";

process.env.TZ = "UTC";

const env = process.env as Record<string, string | undefined>;
const NOTIFY_KEYS = [
  "WHATSAPP_NUMBER", "SMS_PROVIDER", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM", "TWILIO_MESSAGING_SERVICE_SID", "RESEND_API_KEY", "EMAIL_PROVIDER", "EMAIL_FROM",
];
const SAVED = Object.fromEntries(NOTIFY_KEYS.map((k) => [k, env[k]]));
beforeEach(() => { for (const k of NOTIFY_KEYS) delete env[k]; });
afterEach(() => {
  for (const k of NOTIFY_KEYS) {
    if (SAVED[k] === undefined) delete env[k];
    else env[k] = SAVED[k];
  }
});

describe("lineAmount / round2", () => {
  it("qty × price + charges; missing charges counts as 0", () => {
    assert.equal(lineAmount({ qty: 3, unitPrice: 2.5 }), 7.5);
    assert.equal(lineAmount({ qty: 3, unitPrice: 2.5, charges: 1 }), 8.5);
    assert.equal(lineAmount({ qty: 0, unitPrice: 99, charges: 0 }), 0);
  });
  it("NaN charges are treated as 0 (|| branch)", () => {
    assert.equal(lineAmount({ qty: 1, unitPrice: 1, charges: NaN }), 1);
  });
  it("round2 rounds to 3 dp (baisa), half-up at the boundary", () => {
    assert.equal(round2(1.0005), 1.001);
    assert.equal(round2(1.0004), 1);
    assert.equal(round2(0.1 + 0.2), 0.3);
    assert.equal(round2(-1.2345), -1.234);
  });
  it("round2 maps non-finite to 0", () => {
    for (const v of [NaN, Infinity, -Infinity]) assert.equal(round2(v), 0);
  });
});

describe("normalizeQuotationLines — never trust client shapes", () => {
  it("non-array input → []", () => {
    for (const v of [undefined, null, "x", 5, { qty: 1 }]) {
      assert.deepEqual(normalizeQuotationLines(v as never), []);
    }
  });
  it("fills defaults for an almost-empty line", () => {
    assert.deepEqual(normalizeQuotationLines([{ qty: 2 }]), [{
      productId: undefined, name: "Item", qty: 2, unitLabel: "pcs", unitPrice: 0, lineType: "ready",
      formulaId: undefined, formulaName: "", packagingProductIds: [], bottleNote: "", designNote: "",
      charges: 0, notes: "",
    }]);
  });
  it("drops lines with qty 0, negative, NaN or missing (boundary at 0)", () => {
    const out = normalizeQuotationLines([{ qty: 0 }, { qty: -1 }, { qty: "abc" as never }, {}, { qty: 0.001 }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].qty, 0.001);
  });
  it("coerces numeric strings and trims names/units", () => {
    const [l] = normalizeQuotationLines([{ qty: "3" as never, unitPrice: "1.5" as never, name: "  Oud  ", unitLabel: " ml " }]);
    assert.deepEqual([l.qty, l.unitPrice, l.name, l.unitLabel], [3, 1.5, "Oud", "ml"]);
  });
  it("whitespace-only name falls back to 'Item'", () => {
    assert.equal(normalizeQuotationLines([{ qty: 1, name: "   " }])[0].name, "Item");
  });
  it("unknown lineType → ready; every allowed type kept", () => {
    for (const t of ["ready", "remix", "oil", "refill", "packaging", "wholesale", "custom_blend"]) {
      assert.equal(normalizeQuotationLines([{ qty: 1, lineType: t }])[0].lineType, t);
    }
    for (const t of ["READY", "hack", "", undefined]) {
      assert.equal(normalizeQuotationLines([{ qty: 1, lineType: t }])[0].lineType, "ready");
    }
  });
  it("negative charges are clamped to 0; packaging ids must be an array", () => {
    const [l] = normalizeQuotationLines([{ qty: 1, charges: -5, packagingProductIds: "p1" as never }]);
    assert.equal(l.charges, 0);
    assert.deepEqual(l.packagingProductIds, []);
  });
  it("regression: a negative unit price is rejected with the line number", () => {
    assert.throws(() => normalizeQuotationLines([{ qty: 1, unitPrice: 5 }, { qty: 1, unitPrice: -10 }]), /^Error: Line 2: unit price cannot be negative$/);
    assert.throws(() => normalizeQuotationLines([{ qty: 1, unitPrice: -0.001 }]), /cannot be negative/);
    assert.throws(() => normalizeQuotationLines([{ qty: 1, unitPrice: "-1" as never }]), /cannot be negative/);
  });
  it("regression: a non-numeric unit price is rejected, not stored as NaN", () => {
    for (const v of ["abc", NaN, Infinity, "1,5", {}]) {
      assert.throws(() => normalizeQuotationLines([{ qty: 1, unitPrice: v as never }]), /Line 1: unit price must be a number/, String(v));
    }
  });
  it("boundary: unit price 0 and missing price are allowed (free / to-be-priced line)", () => {
    assert.equal(normalizeQuotationLines([{ qty: 1, unitPrice: 0 }])[0].unitPrice, 0);
    assert.equal(normalizeQuotationLines([{ qty: 1, unitPrice: -0 }])[0].unitPrice, -0);
    assert.equal(normalizeQuotationLines([{ qty: 1 }])[0].unitPrice, 0);
    assert.equal(normalizeQuotationLines([{ qty: 1, unitPrice: null as never }])[0].unitPrice, 0);
  });
  it("the rejection is a plain Error, so the API answers 400 with this message", () => {
    try {
      normalizeQuotationLines([{ qty: 1, unitPrice: -1 }]);
      assert.fail("should throw");
    } catch (e) {
      assert.equal((e as Error).name, "Error");
    }
  });
});

describe("buildQuotationDoc", () => {
  const customer = { name: "  ", phone: " 123 " };
  it("defaults: version 1, draft, 14-day validity, 'Customer' name", () => {
    const d = buildQuotationDoc({ number: "Q-1", customer, lines: [] });
    assert.deepEqual(
      [d.version, d.status, d.validityDays, d.customer.name, d.customer.phone, d.signedAt, d.total],
      [1, "draft", 14, "Customer", "123", "", 0],
    );
  });
  it("totals add VAT on top; negative VAT is clamped to 0", () => {
    const lines = [{ name: "A", qty: 2, unitLabel: "pcs", unitPrice: 5, charges: 1 }];
    const d = buildQuotationDoc({ number: "Q", customer, lines, vatPercent: 5 });
    assert.deepEqual([d.subtotal, d.vatAmount, d.total], [11, 0.55, 11.55]);
    const neg = buildQuotationDoc({ number: "Q", customer, lines, vatPercent: -5 });
    assert.deepEqual([neg.vatPercent, neg.vatAmount, neg.total], [0, 0, 11]);
  });
  it("dates become ISO strings; invalid date throws", () => {
    const d = buildQuotationDoc({ number: "Q", customer, lines: [], date: "2026-10-16", expiry: new Date("2026-10-30"), signedAt: "2026-10-17" });
    assert.equal(d.date, "2026-10-16T00:00:00.000Z");
    assert.equal(d.expiry, "2026-10-30T00:00:00.000Z");
    assert.equal(d.signedAt, "2026-10-17T00:00:00.000Z");
    assert.throws(() => buildQuotationDoc({ number: "Q", customer, lines: [], date: "nope" }), RangeError);
  });
  it("validityDays 0 is kept (?? not ||)", () => {
    assert.equal(buildQuotationDoc({ number: "Q", customer, lines: [], validityDays: 0 }).validityDays, 0);
  });
});

describe("receiptStoreFromSettings", () => {
  it("null/undefined settings → all defaults", () => {
    for (const s of [null, undefined, {}]) {
      const st = receiptStoreFromSettings(s);
      assert.deepEqual([st.name, st.footer, st.currency, st.bilingual, st.phone], ["UNICH", "Thank you for shopping with UNICH.", "OMR", false, ""]);
    }
  });
  it("whitespace-only values fall back to defaults", () => {
    const st = receiptStoreFromSettings({ branchName: "  ", currency: " ", receiptFooter: "\t" });
    assert.deepEqual([st.name, st.currency, st.footer], ["UNICH", "OMR", "Thank you for shopping with UNICH."]);
  });
  it("phone falls back to WHATSAPP_NUMBER", () => {
    withEnv({ WHATSAPP_NUMBER: "92300" }, () => assert.equal(receiptStoreFromSettings({}).phone, "92300"));
    assert.equal(receiptStoreFromSettings({ storePhone: " 968 " }).phone, "968");
  });
  it("bilingual when invoiceLanguages mentions Arabic (any case)", () => {
    for (const l of ["English + Arabic", "ARABIC", "arab"]) assert.equal(receiptStoreFromSettings({ invoiceLanguages: l }).bilingual, true, l);
    assert.equal(receiptStoreFromSettings({ invoiceLanguages: "English" }).bilingual, false);
  });
});

describe("receiptNumberFor", () => {
  const day = new Date(2026, 0, 5);
  it("INV-YYYYMMDD-last6 uppercase alnum", () => {
    assert.equal(receiptNumberFor("665f1a2b3c4d5e6f7a8b9c0d", day), "INV-20260105-8B9C0D");
  });
  it("strips punctuation before taking the suffix", () => {
    assert.equal(receiptNumberFor("ab-cd_ef!gh", day), "INV-20260105-CDEFGH");
  });
  it("short and empty ids (boundary < 6, = 0)", () => {
    assert.equal(receiptNumberFor("a1", day), "INV-20260105-A1");
    assert.equal(receiptNumberFor("", day), "INV-20260105-DRAFT");
    assert.equal(receiptNumberFor("---", day), "INV-20260105-DRAFT");
  });
  it("non-ASCII letters are removed", () => {
    assert.equal(receiptNumberFor("فاتورة", day), "INV-20260105-DRAFT");
  });
  it("same input → same number (reprint is stable)", () => {
    assert.equal(receiptNumberFor("abc123", day), receiptNumberFor("abc123", new Date(day)));
  });
  it("zero-pads month/day at year boundaries", () => {
    assert.equal(receiptNumberFor("x", new Date(2025, 11, 31)), "INV-20251231-X");
  });
});

describe("currencyDecimals", () => {
  it("3 for Gulf dinars/rials (case-insensitive)", () => {
    for (const c of ["OMR", "omr", "BHD", "KWD", "JOD", "TND", "LYD", "IQD"]) assert.equal(currencyDecimals(c), 3, c);
  });
  it("2 for others, empty and garbage", () => {
    for (const c of ["USD", "AED", "PKR", "", " OMR", null as never, undefined as never]) assert.equal(currencyDecimals(c), 2, String(c));
  });
});

describe("lineTotal", () => {
  it("qty × unitPrice, ignoring everything else", () => {
    assert.equal(lineTotal({ name: "x", qty: 2, unitLabel: "", unitPrice: 3.25 }), 6.5);
    assert.equal(lineTotal({ name: "x", qty: 0, unitLabel: "", unitPrice: 9 }), 0);
  });
});

describe("formatPaymentLabel — condition coverage", () => {
  it("not mixed / no breakdown / empty breakdown → unchanged", () => {
    assert.equal(formatPaymentLabel("cash", [{ method: "cash", amount: 1 }]), "cash");
    assert.equal(formatPaymentLabel("mixed"), "mixed");
    assert.equal(formatPaymentLabel("mixed", []), "mixed");
  });
  it("mixed: zero parts dropped, method capitalised", () => {
    assert.equal(
      formatPaymentLabel("mixed", [{ method: "cash", amount: 5 }, { method: "card", amount: 0 }, { method: "credit", amount: 2.5 }]),
      "Mixed (Cash OMR 5.00 + Credit OMR 2.50)",
    );
  });
  it("mixed with only zero amounts → plain 'mixed'", () => {
    assert.equal(formatPaymentLabel("mixed", [{ method: "cash", amount: 0 }]), "mixed");
  });
});

describe("receiptSmsText (via buildReceiptDoc)", () => {
  const doc = (o: Partial<Parameters<typeof buildReceiptDoc>[0]> = {}) =>
    buildReceiptDoc({ saleId: "abc123", issuedAt: "2026-10-16T10:00:00Z", customer: { name: "" }, lines: [{ name: "Oud", qty: 2, unitLabel: "ml", unitPrice: 3 }], ...o } as never);

  it("integer item count and OMR 3 dp", () => {
    assert.equal(receiptSmsText(doc()), "UNICH: INV-20261016-ABC123 2 item(s) · OMR 6.000 · cash");
  });
  it("fractional item count prints 2 dp", () => {
    assert.equal(receiptSmsText(doc({ lines: [{ name: "Oil", qty: 1.5, unitLabel: "ml", unitPrice: 2 }] })), "UNICH: INV-20261016-ABC123 1.50 item(s) · OMR 3.000 · cash");
  });
  it("adds shop phone when set; never exceeds 300 chars", () => {
    const t = receiptSmsText(doc({ settings: { storePhone: "968", branchName: "X".repeat(400) } }));
    assert.equal(t.length, 300);
    assert.ok(receiptSmsText(doc({ settings: { storePhone: "968" } })).endsWith("Queries: 968"));
  });
});

describe("WhatsApp links and messages", () => {
  it("buildWhatsAppUrl encodes the text and normalises the phone", () => {
    assert.equal(buildWhatsAppUrl("+92 300-1234567", "Hi & bye?\nنعم"), `https://wa.me/923001234567?text=${encodeURIComponent("Hi & bye?\nنعم")}`);
  });
  it("buildWhatsAppUrl throws for an empty/punctuation-only phone", () => {
    assert.throws(() => buildWhatsAppUrl("", "x"), /recipient phone is required/);
    assert.throws(() => buildWhatsAppUrl(" - ", "x"), /recipient phone is required/);
  });
  it("buildStoreWhatsAppUrl: unset → throws, set → url", () => {
    assert.throws(() => buildStoreWhatsAppUrl("x"), /WHATSAPP_NUMBER is not configured/);
    withEnv({ WHATSAPP_NUMBER: "923000000001" }, () => {
      assert.equal(buildStoreWhatsAppUrl("x"), "https://wa.me/923000000001?text=x");
    });
  });
  it("formatQuotationMessage: every optional line appears when set", () => {
    const m = withEnv({ WHATSAPP_NUMBER: "92300" }, () =>
      formatQuotationMessage({ number: "Q", customerName: "A", total: 1, items: 1, date: "d", expiry: "e", approvalUrl: "u", currency: "USD" }));
    for (const part of ["Date: d", "Valid until: e", "View & approve: u", "Reply on WhatsApp: +92300", "Total: $1.00"]) {
      assert.ok(m.includes(part), part);
    }
  });
  it("regression: keeps its blank spacer lines; absent optional fields leave no gap", () => {
    assert.equal(
      formatQuotationMessage({ number: "Q-1", customerName: "Ali", total: 12.5, items: 2 }),
      "UNICH Quotation Q-1\nHi Ali,\n\nItems: 2\nTotal: OMR\u00A012.50\n\nPlease reply to confirm or request changes.",
    );
    assert.ok(!formatQuotationMessage({ number: "Q", customerName: "A", total: 1, items: 1 }).includes("\n\n\n"));
  });
  it("regression: with every optional field the spacers stay in place", () => {
    const m = withEnv({ WHATSAPP_NUMBER: "92300" }, () =>
      formatQuotationMessage({ number: "Q", customerName: "A", total: 1, items: 1, date: "d", expiry: "e", approvalUrl: "u" }));
    assert.deepEqual(m.split("\n"), [
      "UNICH Quotation Q", "Hi A,", "", "Items: 1", `Total: OMR\u00A01.00`, "Date: d", "Valid until: e",
      "View & approve: u", "Reply on WhatsApp: +92300", "", "Please reply to confirm or request changes.",
    ]);
  });
  it("empty-string optional fields are treated as absent", () => {
    const m = formatQuotationMessage({ number: "Q", customerName: "A", total: 1, items: 1, date: "", expiry: "", approvalUrl: "" });
    assert.ok(!m.includes("Date:") && !m.includes("Valid until:") && !m.includes("View & approve:"));
  });
  it("formatQuotationSms: minimal, full, and 300-char cap", () => {
    assert.equal(formatQuotationSms({ number: "Q-1", total: 12.5, items: 2 }), "UNICH Quotation Q-1: 2 item(s) · OMR 12.500");
    const full = withEnv({ WHATSAPP_NUMBER: "92300" }, () => formatQuotationSms({ number: "Q", total: 1, items: 1, expiry: "e", approvalUrl: "u" }));
    assert.equal(full, "UNICH Quotation Q: 1 item(s) · OMR 1.000 valid until e View: u Reply: +92300");
    assert.equal(formatQuotationSms({ number: "Q", total: 1, items: 1, approvalUrl: "x".repeat(500) }).length, 300);
  });
});

describe("smsConfigured — MC/DC over provider && sid && token && (from || msid)", () => {
  const full = { SMS_PROVIDER: "Twilio", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "+1" };
  const rows: [string, Record<string, string | undefined>, boolean][] = [
    ["all set (provider case-insensitive)", full, true],
    ["messaging service instead of from", { ...full, TWILIO_FROM: undefined, TWILIO_MESSAGING_SERVICE_SID: "MG" }, true],
    ["no provider", { ...full, SMS_PROVIDER: undefined }, false],
    ["other provider", { ...full, SMS_PROVIDER: "nexmo" }, false],
    ["no sid", { ...full, TWILIO_ACCOUNT_SID: undefined }, false],
    ["no token", { ...full, TWILIO_AUTH_TOKEN: undefined }, false],
    ["neither from nor msid", { ...full, TWILIO_FROM: undefined }, false],
  ];
  for (const [label, patch, expected] of rows) {
    it(`${label} → ${expected}`, () => withEnv(patch, () => assert.equal(smsConfigured(), expected)));
  }
});

describe("sendSms — each early return, then the network outcomes", () => {
  const twilio = { SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+100" };
  const err = async (patch: Record<string, string | undefined>, input = { to: "92300", text: "hi" }) =>
    withEnv(patch, () => sendSms(input));

  it("config errors", async () => {
    assert.match(((await err({})) as { error: string }).error, /SMS is not configured/);
    assert.deepEqual(await err({ SMS_PROVIDER: "nexmo" }), { ok: false, error: "Unsupported SMS_PROVIDER: nexmo" });
    assert.match(((await err({ ...twilio, TWILIO_AUTH_TOKEN: undefined })) as { error: string }).error, /AUTH_TOKEN/);
    assert.match(((await err({ ...twilio, TWILIO_FROM: undefined })) as { error: string }).error, /TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID/);
  });
  it("input errors: empty phone, whitespace body", async () => {
    assert.deepEqual(await err(twilio, { to: "", text: "hi" }), { ok: false, error: "SMS recipient phone is required" });
    assert.deepEqual(await err(twilio, { to: "92300", text: "   " }), { ok: false, error: "SMS body is required" });
  });
  it("success: posts form data with From and Basic auth", async (t) => {
    const calls: [string, RequestInit][] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 });
    });
    assert.deepEqual(await err(twilio, { to: "0300 1234567", text: "hi" }), { ok: true, id: "SM1" });
    const [url, init] = calls[0];
    assert.equal(url, "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    const body = new URLSearchParams(String(init.body));
    assert.deepEqual([body.get("To"), body.get("Body"), body.get("From")], ["+923001234567", "hi", "+100"]);
    assert.equal((init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("AC1:tok").toString("base64")}`);
  });
  it("messaging service SID wins over From", async (t) => {
    let body = "";
    t.mock.method(globalThis, "fetch", async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response("{}", { status: 201 });
    });
    const r = await err({ ...twilio, TWILIO_MESSAGING_SERVICE_SID: "MG9" });
    assert.deepEqual(r, { ok: true, id: "sent" }, "missing sid → 'sent'");
    const p = new URLSearchParams(body);
    assert.equal(p.get("MessagingServiceSid"), "MG9");
    assert.equal(p.get("From"), null);
  });
  it("HTTP error uses Twilio's message, or a status fallback for non-JSON", async (t) => {
    const replies = [
      new Response(JSON.stringify({ message: "Invalid 'To'" }), { status: 400 }),
      new Response("<html>", { status: 502 }),
    ];
    t.mock.method(globalThis, "fetch", async () => replies.shift()!);
    assert.deepEqual(await err(twilio), { ok: false, error: "Invalid 'To'" });
    assert.deepEqual(await err(twilio), { ok: false, error: "Twilio rejected the message (502)" });
  });
  it("network failure is caught", async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("ECONNRESET"); });
    assert.deepEqual(await err(twilio), { ok: false, error: "ECONNRESET" });
  });
});

describe("sendEmail — branches before the network", () => {
  it("unsupported provider", async () => {
    assert.deepEqual(await withEnv({ EMAIL_PROVIDER: "SMTP" }, () => sendEmail({ to: "a@b.c", subject: "s", text: "t" })), { ok: false, error: "Unsupported EMAIL_PROVIDER: smtp" });
  });
  it("missing API key", async () => {
    assert.deepEqual(await sendEmail({ to: "a@b.c", subject: "s", text: "t" }), { ok: false, error: "RESEND_API_KEY is not configured" });
  });
  it("blank recipient", async () => {
    assert.deepEqual(await withEnv({ RESEND_API_KEY: "re_x" }, () => sendEmail({ to: "   ", subject: "s", text: "t" })), { ok: false, error: "Recipient email is required" });
  });
});
