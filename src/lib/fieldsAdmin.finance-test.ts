// Tests for the Fields management page's pure logic. These guard writes
// to the canonical fin_venues record, so the rules are covered directly:
// CM is derived (never stored), the save payload excludes CM, the Drive
// URL is validated, min/max are ints, and delete is always a soft
// deactivation that can't orphan history.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cityManagerFor,
  buildFieldPayload,
  isValidHttpUrl,
  parseIntStrict,
  resolveDeleteAction,
  cityOptions,
  contactLink,
  formatPhoneDisplay,
  UNASSIGNED_CITY_MANAGER,
  type CityManagerRoster,
  type FieldFormInput,
} from "./fieldsAdmin";

const roster: CityManagerRoster = new Map([
  ["Houston", "Yarra"],
  ["Austin", "Garrett"],
  ["OKC", "Rodrigo"],
  ["St. Louis", "Willfried"],
  ["Dallas", "Chris"],
  ["San Antonio", "Abraham"],
]);

const form = (over: Partial<FieldFormInput> = {}): FieldFormInput => ({
  venue_name: "ATH Pearland",
  city: "Houston",
  contact_name: "Sam",
  contact_number: "281-555-0100",
  min_players: "10",
  max_players: "18",
  schedule_url: "https://drive.google.com/file/d/abc/view",
  ...over,
});

// ---------------------------------------------------------------
// City Manager is DERIVED from city, and updates when city changes
// ---------------------------------------------------------------
test("City Manager derives from the venue's city", () => {
  assert.equal(cityManagerFor("Houston", roster), "Yarra");
  assert.equal(cityManagerFor("Dallas", roster), "Chris");
});

test("CM updates when the city changes (same derivation, new input)", () => {
  let city = "Houston";
  assert.equal(cityManagerFor(city, roster), "Yarra");
  city = "San Antonio"; // user picks a different city in the modal
  assert.equal(cityManagerFor(city, roster), "Abraham");
});

test("Atlanta and El Paso show 'Unassigned' (no roster entry)", () => {
  assert.equal(cityManagerFor("Atlanta", roster), UNASSIGNED_CITY_MANAGER);
  assert.equal(cityManagerFor("El Paso", roster), UNASSIGNED_CITY_MANAGER);
  assert.equal(cityManagerFor(null, roster), UNASSIGNED_CITY_MANAGER);
  assert.equal(cityManagerFor(undefined, roster), UNASSIGNED_CITY_MANAGER);
});

// ---------------------------------------------------------------
// CM is NEVER persisted on the venue
// ---------------------------------------------------------------
test("the save payload has no City Manager field", () => {
  const res = buildFieldPayload(form());
  assert.ok(res.ok);
  if (!res.ok) return;
  const keys = Object.keys(res.payload);
  for (const forbidden of [
    "city_manager",
    "cityManager",
    "manager_name",
    "manager",
    "cm",
  ]) {
    assert.ok(
      !keys.includes(forbidden),
      `payload must not contain "${forbidden}"`,
    );
  }
  // Exactly the venue columns, nothing manager-shaped, and no retired
  // field_name.
  assert.deepEqual(keys.sort(), [
    "city",
    "contact_name",
    "contact_number",
    "max_players",
    "min_players",
    "schedule_url",
    "venue_name",
  ]);
  assert.ok(!keys.includes("field_name"), "field_name is retired");
});

// ---------------------------------------------------------------
// add-field lands in the right city
// ---------------------------------------------------------------
test("a new field carries the chosen city into the payload", () => {
  const res = buildFieldPayload(form({ city: "San Antonio", venue_name: "STAR" }));
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.payload.city, "San Antonio");
  assert.equal(res.payload.venue_name, "STAR");
  // and it derives the right CM for that city, without storing it
  assert.equal(cityManagerFor(res.payload.city, roster), "Abraham");
});

test("field (short name) and city are required", () => {
  assert.equal(buildFieldPayload(form({ venue_name: "  " })).ok, false);
  assert.equal(buildFieldPayload(form({ city: "" })).ok, false);
  assert.equal(buildFieldPayload(form({ city: "Gotham" })).ok, false); // unknown city
});

// ---------------------------------------------------------------
// Drive URL validation
// ---------------------------------------------------------------
test("schedule URL validation accepts http(s), rejects everything else", () => {
  assert.equal(isValidHttpUrl("https://drive.google.com/x"), true);
  assert.equal(isValidHttpUrl("http://example.com"), true);
  assert.equal(isValidHttpUrl("drive.google.com/x"), false); // no scheme
  assert.equal(isValidHttpUrl("not a url"), false);
  assert.equal(isValidHttpUrl("mailto:a@b.com"), false);
  assert.equal(isValidHttpUrl("javascript:alert(1)"), false);
  assert.equal(isValidHttpUrl(""), false);
});

test("a non-URL schedule link fails the save", () => {
  const res = buildFieldPayload(form({ schedule_url: "just some text" }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /valid http/i);
});

test("an empty schedule link is allowed (optional) → null", () => {
  const res = buildFieldPayload(form({ schedule_url: "" }));
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.payload.schedule_url, null);
});

// ---------------------------------------------------------------
// min/max accept ints only
// ---------------------------------------------------------------
test("parseIntStrict: whole numbers only; blank → null; junk → not ok", () => {
  assert.deepEqual(parseIntStrict("12"), { ok: true, value: 12 });
  assert.deepEqual(parseIntStrict(""), { ok: true, value: null });
  assert.deepEqual(parseIntStrict(null), { ok: true, value: null });
  assert.equal(parseIntStrict("12.5").ok, false); // float
  assert.equal(parseIntStrict("-3").ok, false); // negative
  assert.equal(parseIntStrict("ten").ok, false); // text
  assert.equal(parseIntStrict("1e3").ok, false); // exponent
});

test("min/max players reject non-integers on save; min can't exceed max", () => {
  assert.equal(buildFieldPayload(form({ min_players: "12.5" })).ok, false);
  assert.equal(buildFieldPayload(form({ max_players: "abc" })).ok, false);
  assert.equal(
    buildFieldPayload(form({ min_players: "20", max_players: "10" })).ok,
    false,
  );
  // valid ints pass through
  const res = buildFieldPayload(form({ min_players: "8", max_players: "16" }));
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.payload.min_players, 8);
  assert.equal(res.payload.max_players, 16);
});

// ---------------------------------------------------------------
// delete = soft-deactivate, never orphans references
// ---------------------------------------------------------------
test("delete resolves to a soft-deactivate (is_active=false), never a hard delete", () => {
  const action = resolveDeleteAction();
  assert.equal(action.mode, "soft-deactivate");
  assert.deepEqual(action.patch, { is_active: false });
  // There is no hard-delete branch — a referenced venue is preserved, its
  // match/cost/schedule history intact, just dropped from active lists.
});

// ---------------------------------------------------------------
// Field Contact → clickable tel: / mailto:
// ---------------------------------------------------------------
test("contactLink: a phone number → tel: with dialable digits", () => {
  assert.deepEqual(contactLink("(713) 555-0110"), {
    href: "tel:7135550110",
    kind: "phone",
  });
  assert.deepEqual(contactLink("210-555-0142"), {
    href: "tel:2105550142",
    kind: "phone",
  });
});

test("contactLink: an international number keeps its leading +", () => {
  assert.deepEqual(contactLink("+1 (713) 555-0110"), {
    href: "tel:+17135550110",
    kind: "phone",
  });
});

test("contactLink: an email → mailto:", () => {
  assert.deepEqual(contactLink("marco@soccercentral.com"), {
    href: "mailto:marco@soccercentral.com",
    kind: "email",
  });
});

test("formatPhoneDisplay: any 10-digit US number → XXX-XXX-XXXX", () => {
  assert.equal(formatPhoneDisplay("7135550110"), "713-555-0110");
  assert.equal(formatPhoneDisplay("(713) 555-0110"), "713-555-0110");
  assert.equal(formatPhoneDisplay("713.555.0110"), "713-555-0110");
  assert.equal(formatPhoneDisplay("713 555 0110"), "713-555-0110");
});

test("formatPhoneDisplay: 11-digit with country code 1 (and +1) → 1-XXX-XXX-XXXX", () => {
  assert.equal(formatPhoneDisplay("17135550110"), "1-713-555-0110");
  assert.equal(formatPhoneDisplay("+1 (713) 555-0110"), "+1-713-555-0110");
});

test("formatPhoneDisplay: international / partial / odd length is left untouched", () => {
  assert.equal(formatPhoneDisplay("+44 20 7946 0958"), "+44 20 7946 0958");
  assert.equal(formatPhoneDisplay("555-0110"), "555-0110"); // 7 digits
  assert.equal(formatPhoneDisplay("ext 42"), "ext 42");
});

test("contactLink: empty / non-dialable / malformed email → null (plain text)", () => {
  assert.equal(contactLink(null), null);
  assert.equal(contactLink(""), null);
  assert.equal(contactLink("   "), null);
  assert.equal(contactLink("ask at front desk"), null); // no digits
  assert.equal(contactLink("not-an-email@"), null); // no domain
  assert.equal(contactLink("@nodomain"), null); // no local part
});

// ---------------------------------------------------------------
// city select uses the canonical list
// ---------------------------------------------------------------
test("city options are the canonical 8-city list, matching fin_venues.city", () => {
  const opts = cityOptions();
  assert.equal(opts.length, 8);
  for (const c of ["Austin", "Dallas", "Houston", "San Antonio", "Atlanta", "St. Louis", "OKC", "El Paso"]) {
    assert.ok(opts.includes(c as (typeof opts)[number]), `${c} in options`);
  }
});
