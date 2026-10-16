/**
 * Unit tests: src/lib/format.ts, src/lib/phone.ts, src/lib/notifications/phone.ts
 * Edge cases, boundary values, string robustness, branch + condition coverage.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clsx,
  formatDate,
  formatMoney,
  formatMoneyCompact,
  formatPhone,
  formatQty,
  marginPct,
  tolaToMl,
} from "@/lib/format";
import { escapeRegex, loosePhoneRegex, phoneDigits } from "@/lib/phone";
import {
  countryCallingCode,
  normalizePhone,
  phoneKey,
  phonesMatch,
  storeWhatsAppNumber,
} from "@/lib/notifications/phone";
import { withEnv } from "./_env";

process.env.TZ = "UTC";

describe("formatMoney", () => {
  it("formats zero with 2 decimals (lower bound of minimumFractionDigits)", () => {
    assert.equal(formatMoney(0), "OMR 0.00");
  });
  it("keeps 3 decimals for baisa and rounds the 4th", () => {
    assert.equal(formatMoney(1.2345), "OMR 1.235");
    assert.equal(formatMoney(0.0005), "OMR 0.001");
  });
  it("groups thousands and pads to 2 decimals", () => {
    assert.equal(formatMoney(1234.5), "OMR 1,234.50");
    assert.equal(formatMoney(1e9), "OMR 1,000,000,000.00");
  });
  it("puts the sign before the currency for negatives", () => {
    assert.equal(formatMoney(-5), "-OMR 5.00");
  });
  it("never contains a no-break space (so long amounts can wrap)", () => {
    for (const v of [0, 1, 1234.567, -99999.999]) {
      assert.ok(!formatMoney(v).includes(" "), `NBSP in ${formatMoney(v)}`);
    }
  });
  it("honours a non-default currency", () => {
    assert.equal(formatMoney(5, "USD"), "$5.00");
  });
  it("throws RangeError for an invalid currency code", () => {
    assert.throws(() => formatMoney(1, "XYZ1"), RangeError);
  });
  it("regression: non-finite amounts display as zero, never OMRNaN / ∞", () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      assert.equal(formatMoney(v), "OMR 0.00", String(v));
      assert.equal(formatMoneyCompact(v), "OMR 0.0", String(v));
    }
  });
  it("regression: loose runtime input — null/undefined/garbage → 0, numeric string formats", () => {
    for (const v of [null, undefined, "abc", {}, ""]) {
      assert.ok(!/NaN|∞/.test(formatMoney(v as never)), JSON.stringify(v));
    }
    assert.equal(formatMoney(undefined as never), "OMR 0.00");
    assert.equal(formatMoney("abc" as never), "OMR 0.00");
    assert.equal(formatMoney("12.5" as never), "OMR 12.50");
  });
  it("largest finite value still formats (boundary)", () => {
    assert.ok(formatMoney(Number.MAX_VALUE).startsWith("OMR 179,769,313"));
  });
});

describe("formatMoneyCompact", () => {
  it("compacts thousands and billions", () => {
    assert.equal(formatMoneyCompact(1234.5), "OMR 1.2K");
    assert.equal(formatMoneyCompact(1e9), "OMR 1.0B");
  });
  it("small values stay un-suffixed, 1 decimal max", () => {
    assert.equal(formatMoneyCompact(1.2345), "OMR 1.2");
    assert.equal(formatMoneyCompact(0), "OMR 0.0");
  });
  it("has no no-break space", () => {
    assert.ok(!formatMoneyCompact(6200).includes(" "));
  });
});

describe("formatQty — integer vs fractional branch", () => {
  it("integer branch: no decimals", () => {
    assert.equal(formatQty(12, "ml"), "12 ml");
    assert.equal(formatQty(0, "pcs"), "0 pcs");
    assert.equal(formatQty(-3, "g"), "-3 g");
  });
  it("fractional branch: always 3 decimals", () => {
    assert.equal(formatQty(1.5, "ml"), "1.500 ml");
    assert.equal(formatQty(0.0004, "kg"), "0.000 kg");
    assert.equal(formatQty(2.0005, "ml"), "2.001 ml");
  });
  it("empty unit leaves a trailing space (string robustness)", () => {
    assert.equal(formatQty(1, ""), "1 ");
  });
});

describe("formatDate", () => {
  it("formats ISO dates as DD Mon YYYY", () => {
    assert.equal(formatDate("2026-10-16"), "16 Oct 2026");
  });
  it("handles leap day and year boundaries", () => {
    assert.equal(formatDate("2024-02-29"), "29 Feb 2024");
    assert.equal(formatDate("2025-12-31T23:59:59Z"), "31 Dec 2025");
    assert.equal(formatDate("2026-01-01T00:00:00Z"), "01 Jan 2026");
  });
  it("throws RangeError for an unparseable string", () => {
    assert.throws(() => formatDate("garbage"), RangeError);
    assert.throws(() => formatDate(""), RangeError);
  });
});

describe("formatPhone", () => {
  it("is identity for any string, including empty and unicode", () => {
    for (const s of ["", "+968 9123 4567", "٠٥٠١٢٣", "  x  "]) assert.equal(formatPhone(s), s);
  });
});

describe("tolaToMl — every branch", () => {
  it("tola → 12, half → 6, quarter (fallthrough) → 3", () => {
    assert.equal(tolaToMl("tola"), 12);
    assert.equal(tolaToMl("half_tola"), 6);
    assert.equal(tolaToMl("quarter_tola"), 3);
  });
  it("unknown values fall through to the quarter branch", () => {
    assert.equal(tolaToMl("bogus" as never), 3);
  });
});

describe("marginPct — boundary on sell <= 0", () => {
  it("sell = 0 and negative sell return 0 (guard branch)", () => {
    assert.equal(marginPct(0, 5), 0);
    assert.equal(marginPct(-1, 5), 0);
  });
  it("smallest positive sell takes the formula branch", () => {
    assert.equal(marginPct(Number.MIN_VALUE, 0), 100);
  });
  it("normal, zero-margin and loss cases", () => {
    assert.equal(marginPct(10, 6), 40);
    assert.equal(marginPct(10, 10), 0);
    assert.equal(marginPct(10, 15), -50);
    assert.equal(marginPct(10, 0), 100);
  });
});

describe("clsx", () => {
  it("drops every falsy kind and joins with one space", () => {
    assert.equal(clsx("a", false, null, undefined, "", "b"), "a b");
  });
  it("no args / all falsy → empty string", () => {
    assert.equal(clsx(), "");
    assert.equal(clsx(false, null, undefined), "");
  });
  it("does not trim or dedupe (string robustness)", () => {
    assert.equal(clsx(" a ", "a"), " a  a");
  });
});

describe("phoneDigits", () => {
  it("strips everything except ASCII digits", () => {
    assert.equal(phoneDigits("+968 (91) 23-45.67"), "96891234567");
    assert.equal(phoneDigits(""), "");
    assert.equal(phoneDigits("abc"), "");
  });
  it("Arabic-Indic digits are not \\d and are removed", () => {
    assert.equal(phoneDigits("٠٥٠١"), "");
  });
});

describe("escapeRegex", () => {
  it("escapes every regex metacharacter", () => {
    const meta = ".*+?^${}()|[]\\";
    const re = new RegExp(`^${escapeRegex(meta)}$`);
    assert.ok(re.test(meta));
    assert.ok(!re.test("x"));
  });
  it("leaves plain text alone", () => {
    assert.equal(escapeRegex("abc 123"), "abc 123");
    assert.equal(escapeRegex(""), "");
  });
  it("neutralises catastrophic patterns", () => {
    assert.ok(!new RegExp(escapeRegex(".*")).test("anything"));
  });
});

describe("loosePhoneRegex", () => {
  const match = (digits: string, stored: string) => new RegExp(loosePhoneRegex(digits)).test(stored);
  it("matches digits separated by spaces, dashes, plus", () => {
    assert.ok(match("971501234567", "+971 50 123 4567"));
    assert.ok(match("501234", "50-12-34"));
  });
  it("does not match a different number", () => {
    assert.ok(!match("501235", "50-12-34"));
  });
  it("single digit and empty input boundaries", () => {
    assert.equal(loosePhoneRegex("5"), "5");
    assert.equal(loosePhoneRegex(""), "");
  });
});

describe("normalizePhone — branches: 00 prefix, leading 0, country source", () => {
  it("strips a 00 international prefix", () => {
    assert.equal(normalizePhone("00968 9123 4567", "92"), "96891234567");
  });
  it("replaces a single leading 0 with the given country", () => {
    assert.equal(normalizePhone("0300-1234567", "92"), "923001234567");
  });
  it("already international stays as is", () => {
    assert.equal(normalizePhone("+968 9123 4567", "92"), "96891234567");
  });
  it("country falls back to first 2 digits of WHATSAPP_NUMBER (2-digit code)", () => {
    withEnv({ WHATSAPP_NUMBER: "+92 300 0000001" }, () => {
      assert.equal(normalizePhone("03001234567"), "923001234567");
    });
  });
  it("regression: 3-digit country code (Oman +968) from WHATSAPP_NUMBER", () => {
    withEnv({ WHATSAPP_NUMBER: "+968 9999 0000" }, () => {
      assert.equal(normalizePhone("091234567"), "96891234567");
    });
    withEnv({ WHATSAPP_NUMBER: "00968 9999 0000" }, () => {
      assert.equal(normalizePhone("091234567"), "96891234567");
    });
  });
  it("regression: 1-digit country code (+1) from WHATSAPP_NUMBER", () => {
    withEnv({ WHATSAPP_NUMBER: "+1 415 555 0100" }, () => {
      assert.equal(normalizePhone("04155550111"), "14155550111");
    });
  });
  it("WHATSAPP_NUMBER in local format (leading 0) has no country → 92 fallback", () => {
    withEnv({ WHATSAPP_NUMBER: "03289193373" }, () => {
      assert.equal(normalizePhone("0300"), "92300");
    });
  });
  it("country falls back to 92 when WHATSAPP_NUMBER is unset", () => {
    withEnv({ WHATSAPP_NUMBER: undefined }, () => {
      assert.equal(normalizePhone("0300"), "92300");
    });
  });
  it("country falls back to 92 when WHATSAPP_NUMBER has no digits", () => {
    withEnv({ WHATSAPP_NUMBER: "n/a" }, () => {
      assert.equal(normalizePhone("0300"), "92300");
    });
  });
  it("empty and punctuation-only input → empty string", () => {
    assert.equal(normalizePhone("", "92"), "");
    assert.equal(normalizePhone("+-() ", "92"), "");
  });
  it("boundary: exactly '0' and exactly '00'", () => {
    assert.equal(normalizePhone("0", "92"), "92");
    assert.equal(normalizePhone("00", "92"), "");
  });
  it("'000x' strips 00 then treats the next 0 as local", () => {
    assert.equal(normalizePhone("0003", "92"), "923");
  });
});

describe("countryCallingCode — E.164 prefix lengths", () => {
  const rows: [string, string][] = [
    ["+968 9123 4567", "968"], ["971501234567", "971"], ["966501234567", "966"],
    ["923000000001", "92"], ["+44 20 7946 0000", "44"], ["+91 98765 43210", "91"],
    ["+1 415 555 0100", "1"], ["+7 495 123 4567", "7"], ["0096891234567", "968"],
    ["+20 2 1234 5678", "20"], ["+212 6 1234 5678", "212"], ["+880 1712 345678", "880"],
  ];
  for (const [input, code] of rows) {
    it(`${input} → ${code}`, () => assert.equal(countryCallingCode(input), code));
  }
  it("no country: empty, local 0-prefixed, too short", () => {
    for (const v of ["", "+", "0300 1234567", "9", "96"]) assert.equal(countryCallingCode(v), "", v);
  });
  it("boundary: exactly 2 digits that form a 2-digit code; exactly 3 digits", () => {
    assert.equal(countryCallingCode("92"), "92");
    assert.equal(countryCallingCode("968"), "968");
  });
});

describe("phoneKey", () => {
  it("removes non-digits and all leading zeros", () => {
    assert.equal(phoneKey("+00 0300-123"), "300123");
    assert.equal(phoneKey("0000"), "");
    assert.equal(phoneKey(""), "");
  });
});

describe("phonesMatch — condition coverage", () => {
  it("false when either side is empty (each operand of !da || !db)", () => {
    assert.equal(phonesMatch("", "123456789"), false);
    assert.equal(phonesMatch("123456789", ""), false);
    assert.equal(phonesMatch("000", "000"), false);
  });
  it("true on exact key match, even if shorter than 9 digits", () => {
    assert.equal(phonesMatch("0123", "123"), true);
  });
  it("true when last 9 digits match (local vs international)", () => {
    assert.equal(phonesMatch("03001234567", "+92 300 1234567"), true);
  });
  it("boundary: 8-digit keys that differ never tail-match", () => {
    assert.equal(phonesMatch("12345678", "912345678"), false);
  });
  it("boundary: exactly 9 digits each side", () => {
    assert.equal(phonesMatch("123456789", "9123456789"), true);
  });
  it("false when tails differ", () => {
    assert.equal(phonesMatch("923001234567", "923001234568"), false);
  });
});

describe("storeWhatsAppNumber", () => {
  it("normalises the env number", () => {
    withEnv({ WHATSAPP_NUMBER: "+92 300 0000001" }, () => {
      assert.equal(storeWhatsAppNumber(), "923000000001");
    });
  });
  it("unset → empty string", () => {
    withEnv({ WHATSAPP_NUMBER: undefined }, () => {
      assert.equal(storeWhatsAppNumber(), "");
    });
  });
});
