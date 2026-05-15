// Phone normalization for CRM thread keys + mdapi_users matching.
//
// mdapi_users.phone_number is a mix of formats:
//   ~63% 10-digit national ("5125550123") — no country prefix
//   ~37% E.164 ("+15125550123")
//   small amount of junk (e.g. "5555555555")
//
// We never rewrite mdapi_users (sync source of truth), so the strategy
// is: normalize-on-read. Inbound webhook + outbound send both pass
// through normalizePhone() before matching or upserting.
//
// Returns null when libphonenumber-js's isValidNumber() rejects the
// input. Caller must handle null (webhook logs + returns 200 without
// creating a thread; send route rejects with 400).

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

const DEFAULT_REGION: CountryCode = "US";

export function normalizePhone(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // parsePhoneNumberFromString accepts both E.164 ("+15125550123") and
  // national ("5125550123") forms. The second arg is the default
  // region for national-format inputs; E.164 inputs ignore it.
  const parsed = parsePhoneNumberFromString(trimmed, DEFAULT_REGION);
  if (!parsed) return null;
  if (!parsed.isValid()) return null;
  return parsed.number;
}

// 10-digit national fallback for mdapi_users lookup. Inbound phones
// arrive as E.164 (e.g. "+15125550123"); ~63% of mdapi_users.phone_number
// rows are stored as bare 10 digits ("5125550123"), so we need both
// shapes to widen the join.
//
// Returns null if the E.164 input is not a US/Canada (+1) number — for
// other country codes a 10-digit fallback is meaningless.
export function toNationalDigits(e164: string): string | null {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed || !parsed.isValid()) return null;
  if (parsed.countryCallingCode !== "1") return null;
  return parsed.nationalNumber;
}
