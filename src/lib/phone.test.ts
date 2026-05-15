// Run: `npm test` (or `node --test src/lib/phone.test.ts`)
// Uses Node's built-in test runner + native TS type stripping (Node 22.6+).

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, toNationalDigits } from "./phone.ts";

test("normalizePhone: valid E.164 passthrough", () => {
  assert.equal(normalizePhone("+15125550123"), "+15125550123");
});

test("normalizePhone: 10-digit national converts to +1 E.164", () => {
  assert.equal(normalizePhone("5125550123"), "+15125550123");
});

test("normalizePhone: junk '5555555555' returns null", () => {
  // 5555555555 fails libphonenumber's isValidNumber() — area code 555
  // is reserved by NANP for fictional use.
  assert.equal(normalizePhone("5555555555"), null);
});

test("normalizePhone: empty string returns null", () => {
  assert.equal(normalizePhone(""), null);
});

test("normalizePhone: null / undefined return null", () => {
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);
});

test("normalizePhone: whitespace-only returns null", () => {
  assert.equal(normalizePhone("   "), null);
});

test("normalizePhone: strips formatting around valid number", () => {
  assert.equal(normalizePhone("(512) 555-0123"), "+15125550123");
  assert.equal(normalizePhone("512-555-0123"), "+15125550123");
});

test("toNationalDigits: E.164 US → 10 digits", () => {
  assert.equal(toNationalDigits("+15125550123"), "5125550123");
});

test("toNationalDigits: non-US returns null", () => {
  // UK number — valid E.164, but not +1, so the 10-digit fallback
  // is meaningless for mdapi_users matching.
  assert.equal(toNationalDigits("+442071838750"), null);
});
