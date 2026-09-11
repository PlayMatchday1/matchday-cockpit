// THE CRASH THIS GUARDS, AND THE REFUSAL IT MUST NOT SOFTEN.
//
// On 2026-09-11 /admin/finance/revenue rendered Next's error boundary for every operator:
// fin_venues 17 (Hammond Park, field 430) carried city "", memberSpotRateFor handed that to
// preTaxOf, and preTaxOf refuses a city it holds no rate for. One unattributable venue took down a
// page reporting money for eight cities.
//
// TWO THINGS ARE ASSERTED HERE AND THEY PULL IN OPPOSITE DIRECTIONS:
//   1. preTaxOf STILL THROWS for a real city with no rate. That refusal is the point of
//      salesTax.ts — defaulting to 0% would leave sales tax sitting inside a "pre-tax" figure —
//      and a fix that softened it would be worse than the crash. Asserted directly, so a future
//      "just return 0" cannot pass this file.
//   2. A city that is not a city — "" from a blank fin_venues.city, "—" from matchPnL's
//      no-venue sentinel — is EXCLUDED rather than valued. No rate could ever exist for either.
//
// A local fixture, deliberately: re-creating this against production data is what caused it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { preTaxOf, taxRateFor, hasTaxRate, isUnattributedCity, UnknownTaxCityError } from "./salesTax";

test("the refusal survives: a REAL city with no rate still throws", () => {
  // A market that exists in /cities but was never added to CITY_TAX_RATE. This is the case the
  // throw exists for and it must keep throwing.
  assert.throws(() => preTaxOf(100, "Lisbon"), UnknownTaxCityError);
  assert.throws(() => taxRateFor("Lisbon"), UnknownTaxCityError);
  assert.equal(isUnattributedCity("Lisbon"), false);
});

test("a real city with a rate is still divided, and Warsaw's real 0 is not a missing rate", () => {
  // Positive control: if these ever returned the gross unchanged, every assertion above could
  // pass on a helper that had quietly stopped working.
  assert.ok(preTaxOf(108.9, "Atlanta") < 108.9);
  assert.equal(Number(preTaxOf(108.9, "Atlanta").toFixed(2)), 100);
  assert.equal(preTaxOf(100, "Warsaw"), 100);
  assert.equal(hasTaxRate("Warsaw"), true);
});

test("no city at all is recognised, in both shapes that reach the tax helpers", () => {
  assert.equal(isUnattributedCity(""), true);       // blank fin_venues.city — the live cause
  assert.equal(isUnattributedCity("   "), true);
  assert.equal(isUnattributedCity("—"), true); // matchPnL's "no venue" sentinel
  assert.equal(isUnattributedCity(null), true);
  assert.equal(isUnattributedCity(undefined), true);
  // Negative control: the helper must not swallow real places.
  for (const c of ["Austin", "Atlanta", "Warsaw", "St. Louis", "New York City", "OKC"]) {
    assert.equal(isUnattributedCity(c), false, `${c} must not read as unattributed`);
  }
});

test("memberSpotRateFor returns null for an unattributed city instead of throwing", async () => {
  const { memberSpotRateFor } = await import("./financeStats");
  // A fixture shaped like the live failure: member spots recorded under an empty city, which is
  // what got past the existing `spots <= 0` guard and reached preTaxOf. venue 17 had 6 May spots.
  const data = {
    revenue: [],
    mdapiMemberSpots: {
      coveredMonths: new Set(["May 2026"]),
      byCityMonth: new Map([["|May 2026", { member: 6, dpp: 19, other: 0 }]]),
      byVenueMonth: new Map(),
    },
  } as unknown as Parameters<typeof memberSpotRateFor>[0];

  assert.doesNotThrow(() => memberSpotRateFor(data, "", "Jun 2026" as never));
  assert.equal(memberSpotRateFor(data, "", "Jun 2026" as never), null);
  assert.equal(memberSpotRateFor(data, "—", "Jun 2026" as never), null);

  // POSITIVE CONTROL. Without this, the two nulls above are indistinguishable from a function
  // that returns null for everything — which is exactly how an exclusion becomes a silent zero.
  const real = {
    revenue: [{ city: "Atlanta", month: "May 2026", type: "Membership", gross: 1089 }],
    mdapiMemberSpots: {
      coveredMonths: new Set(["May 2026"]),
      byCityMonth: new Map([["Atlanta|May 2026", { member: 10, dpp: 0, other: 0 }]]),
      byVenueMonth: new Map(),
    },
  } as unknown as Parameters<typeof memberSpotRateFor>[0];
  const rate = memberSpotRateFor(real, "Atlanta", "Jun 2026" as never);
  assert.ok(rate && rate.rate > 0, "a real city with spots and revenue must still produce a rate");
});

test("unattributedVenues names the venue and its fields, and is empty when nothing is broken", async () => {
  const { unattributedVenues } = await import("./financeStats");
  const broken = {
    venues: [{ id: 17, venue_name: "", city: "" }, { id: 16, venue_name: "PRUMC", city: "Atlanta" }],
    venueFieldLinks: [{ fin_venue_id: 17, mdapi_field_id: 430, field_title_at_link: "Hammond Park" }],
  } as unknown as Parameters<typeof unattributedVenues>[0];
  const got = unattributedVenues(broken);
  assert.equal(got.length, 1);
  assert.equal(got[0].venueId, 17);
  // The blanked venue_name falls back to the link snapshot, which is the name an operator can act on.
  assert.equal(got[0].venueName, "Hammond Park");
  assert.deepEqual(got[0].fieldIds, [430]);

  // The zero case needs its own control: this must be empty because nothing is broken, not
  // because the function matches nothing.
  const clean = {
    venues: [{ id: 16, venue_name: "PRUMC", city: "Atlanta" }],
    venueFieldLinks: [{ fin_venue_id: 16, mdapi_field_id: 1, field_title_at_link: "PRUMC" }],
  } as unknown as Parameters<typeof unattributedVenues>[0];
  assert.equal(unattributedVenues(clean).length, 0);
});

test("the write guard refuses to empty venue_name or city, and allows a partial patch", async () => {
  const { emptiedRequiredField, pickVenueFields } = await import("./venueWriteFields");
  // THE EXACT PAYLOAD THAT CAUSED THE OUTAGE: a drawer that seeded blank, saved as a PATCH.
  assert.equal(emptiedRequiredField({ venue_name: "", city: "", min_players: 9 }), "venue_name");
  assert.equal(emptiedRequiredField({ city: "" }), "city");
  assert.equal(emptiedRequiredField({ city: "   " }), "city");
  assert.equal(emptiedRequiredField({ city: null }), "city");

  // A PARTIAL UPDATE IS STILL PARTIAL. Not touching a column is not clearing it, so a patch that
  // omits these must pass — otherwise the guard would block every ordinary rate edit.
  assert.equal(emptiedRequiredField({ per_match_rate: 160 }), null);
  assert.equal(emptiedRequiredField({ venue_name: "Hammond Park", city: "Atlanta" }), null);
  // Clearing an OPTIONAL column is still allowed; only the two required ones are protected.
  assert.equal(emptiedRequiredField({ contact_name: "", schedule_url: "" }), null);

  // The allowlist still excludes the two columns that change how cost reconciliation aggregates.
  const picked = pickVenueFields({ city: "Austin", billing_cadence: "weekly", bills_per_reservation: true });
  assert.deepEqual(Object.keys(picked), ["city"]);
});
