/**
 * ITU-T E.164 country calling codes are prefix-free: 1 and 7 are 1 digit,
 * the codes below are 2 digits, and every other code is 3 digits
 * (e.g. Oman 968, UAE 971, Saudi 966).
 */
const TWO_DIGIT_CALLING_CODES = new Set([
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45",
  "46", "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58", "60", "61",
  "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94",
  "95", "98",
]);

/** Country calling code at the start of an international digits-only number ("" if none). */
export function countryCallingCode(internationalDigits: string): string {
  let digits = internationalDigits.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!digits || digits.startsWith("0")) return "";
  if (digits[0] === "1" || digits[0] === "7") return digits[0];
  if (digits.length < 2) return "";
  if (TWO_DIGIT_CALLING_CODES.has(digits.slice(0, 2))) return digits.slice(0, 2);
  return digits.length >= 3 ? digits.slice(0, 3) : "";
}

/** Digits-only phone; local leading 0 → default country from WHATSAPP_NUMBER. */
export function normalizePhone(phone: string, defaultCountry?: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);

  const country =
    defaultCountry ||
    countryCallingCode(process.env.WHATSAPP_NUMBER || "") ||
    "92";

  if (digits.startsWith("0")) {
    digits = country + digits.slice(1);
  }

  return digits;
}

export function phoneKey(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^0+/, "");
}

/** Match local / international variants (last 9 digits). */
export function phonesMatch(a: string, b: string): boolean {
  const da = phoneKey(a);
  const db = phoneKey(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const tail = 9;
  return da.length >= tail && db.length >= tail && da.slice(-tail) === db.slice(-tail);
}

export function storeWhatsAppNumber(): string {
  return normalizePhone(process.env.WHATSAPP_NUMBER || "");
}
