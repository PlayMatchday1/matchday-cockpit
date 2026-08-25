import "server-only"; // no-op under --conditions=react-server
// /admin/fields — the field-ID → venue mapping model, tested where it lives.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/field-id-admin-test.ts
//
// WHY THIS IS A UNIT SUITE AND NOT A SCREEN CHECK. The numbers here decide
// whether an operator commits a mapping that moves a venue's match count, its
// attributed revenue and its billed cost across every Finance surface. A wrong
// preview is a wrong decision taken deliberately, which is worse than an
// obviously broken page. So the arithmetic, the exclusions and every refusal in
// the write-request validator are asserted offline, and the guards are
// MUTATION-TESTED — each one is shown to reject as well as to accept.
//
// Money assertions use NON-ROUND values ($12.34, $19.99): a 100× error in
// either direction survives $0.00 and $100.00 and proves nothing.

import {
  addressPeers, buildFieldIdIndex, isRecent, previewAssignment, sortFieldRows,
  validateAssignment, visibleFieldRows, wallClockParts,
  type FieldIdRow, type MatchAggInput, type PlayerAggInput, type VenueOption,
} from "../src/lib/fieldIdAdmin";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

const NOW = Date.parse("2026-08-24T12:00:00Z");

// ── fixtures ────────────────────────────────────────────────────────────────
// Shapes copied from the live rows: `start_date` carries a Z it does not mean
// (wall clock), `amount` is CENTS in a numeric(10,2) column.
let nextId = 1;
function m(over: Partial<MatchAggInput> = {}): MatchAggInput & { api_id: number } {
  return {
    api_id: nextId++, field_id: 900, field_title: "Test Pitch",
    field_address: "1 Main St", field_zipcode: "78701",
    city_name: "Austin", city_identifier: "ATX",
    start_date: "2026-05-04T21:15:00.000Z", start_date_utc: "2026-05-05T02:15:00.000Z", is_cancelled: false, ...over,
  };
}
function p(matchId: number, amountCents: number, over: Partial<PlayerAggInput> = {}): PlayerAggInput & { api_id: number } {
  return {
    api_id: nextId++, match_api_id: matchId, amount: amountCents,
    user_email: "player@example.com", user_is_fake_player: false, is_absent: false, ...over,
  };
}

console.log("\nWALL CLOCK — the Z is a lie and the slot key must not re-shift it");
{
  const w = wallClockParts("2026-05-04T21:15:00.000Z");
  is("the date is read straight back at UTC", w?.date, "2026-05-04");
  is("...and so is the hour on the pitch (21:15, not a local re-shift)", w?.time, "21:15");
  is("2026-05-04 is a Monday, not a Sunday", w?.sunday, false);
  is("2026-05-03 IS a Sunday — the ATH Katy split leg", wallClockParts("2026-05-03T21:15:00.000Z")?.sunday, true);
  is("an unparseable date yields null rather than a wrong slot", wallClockParts("not-a-date"), null);
  is("a +00:00 offset (what PostgREST returns) is read the same way", wallClockParts("2026-05-04T21:15:00+00:00")?.time, "21:15");
  is("...and nothing is round-tripped through a Date: the hour survives verbatim", wallClockParts("2026-12-31T23:45:00+00:00")?.date, "2026-12-31");
}

console.log("\nTHE AGGREGATE — one row per field ID");
{
  const m1 = m({ start_date: "2025-11-10T19:00:00.000Z", start_date_utc: "2025-11-11T01:00:00.000Z" });
  const m2 = m({ start_date: "2026-05-04T21:15:00.000Z" });
  const m3 = m({ start_date: "2026-09-30T21:15:00.000Z", start_date_utc: "2026-10-01T02:15:00.000Z" }); // future
  const m4 = m({ start_date: "2026-06-01T21:15:00.000Z", is_cancelled: true });
  const other = m({ field_id: 901, field_title: "Other Pitch", start_date: "2026-05-05T19:00:00.000Z" });
  const idx = buildFieldIdIndex(
    [m1, m2, m3, m4, other],
    [
      p(m1.api_id, 1234),                                    // $12.34
      p(m2.api_id, 1999),                                    // $19.99
      p(m2.api_id, 500, { user_is_fake_player: true }),      // fake — dropped
      p(m2.api_id, 700, { user_email: "bot@matchday.com" }), // fake by email — dropped
      p(m2.api_id, 900, { is_absent: true }),                // absent — dropped
      p(m4.api_id, 5000),                                    // cancelled MATCH — dropped
      p(other.api_id, 100),
    ],
    NOW,
  );
  const f = idx.get(900)!;
  is("field 900 counts 3 live matches", f.liveMatches, 3);
  is("...and 1 cancelled, kept apart from live", f.cancelledMatches, 1);
  is("...and 1 of the live ones is in the future", f.upcomingMatches, 1);
  is("the range spans first to last LIVE match", `${f.firstMatch}→${f.lastMatch}`, "2025-11-10→2026-09-30");
  is("revenue is cents converted ONCE: 1234 + 1999 = $32.33", f.dppRevenue, 32.33);
  is("...over 2 spots, not 6", f.dppSpots, 2);
  // POSITIVE CONTROL for the three exclusions above: the same fixture rows DO
  // land when the disqualifying flag is removed, so the drops are the filters
  // working and not the fixture failing to reach the index at all.
  const loose = buildFieldIdIndex([m1, m2, m4], [p(m2.api_id, 500), p(m4.api_id, 5000, { match_api_id: m2.api_id })], NOW);
  is("CONTROL — the same amounts DO count once fake/absent/cancelled no longer apply", loose.get(900)!.dppRevenue, 55);
  is("a second field ID is its own row, never merged", idx.get(901)!.liveMatches, 1);
  is("...with its own money", idx.get(901)!.dppRevenue, 1);
  is("two field IDs in, two rows out", idx.size, 2);
}

console.log("\nTHE EVENT MARKER — cost is excluded because of the NAME (financeCosts.isEventSchedule)");
{
  const reg = m({ field_id: 10, field_title: "ATH Katy" });
  const ev1 = m({ field_id: 11, field_title: "Tourney ATH Katy" });
  const ev2 = m({ field_id: 11, field_title: "Tourney ATH Katy", start_date: "2026-05-06T21:15:00.000Z" });
  const idx = buildFieldIdIndex([reg, ev1, ev2], [], NOW);
  is("a plain title is billable", idx.get(10)!.billableLive, 1);
  is("a 'Tourney …' title is NOT billable, however many matches it carries", idx.get(11)!.billableLive, 0);
  is("...but it is still 2 LIVE matches — the exclusion is cost-only", idx.get(11)!.liveMatches, 2);
}

console.log("\nRESERVATION SLOTS — a venue books the pitch, not the fixture");
{
  const a = m({ field_id: 20, start_date: "2026-05-04T21:15:00.000Z" });
  const b = m({ field_id: 20, start_date: "2026-05-04T21:15:00.000Z" }); // same slot
  const c = m({ field_id: 20, start_date: "2026-05-04T22:15:00.000Z" }); // later hour
  const d = m({ field_id: 20, start_date: "2026-05-05T21:15:00.000Z", is_cancelled: true });
  const f = buildFieldIdIndex([a, b, c, d], [], NOW).get(20)!;
  is("4 rows, 3 of them live", f.liveMatches, 3);
  is("two matches at one (date, time) are ONE reservation", f.billableSlotsLive, 2);
  is("...and the cancelled pass adds to the SAME set, never a second counter", f.billableSlotsWithCancelled, 3);
}

console.log("\nORDER — unmapped first, then by live match count");
{
  const row = (fieldId: number, liveMatches: number, mapped: boolean): FieldIdRow =>
    ({ fieldId, liveMatches, mapping: mapped ? { venueId: 1, venueName: "V", venueCity: null, venueIsActive: true, countsAsRegularPlay: false, titleAtLink: null } : null } as FieldIdRow);
  eq(
    "big mapped venues never push an unmapped field down the page",
    sortFieldRows([row(1, 3000, true), row(2, 5, false), row(3, 9, false), row(4, 1, true)]).map((r) => r.fieldId),
    [3, 2, 1, 4],
  );
  eq("ties break on field id, so the order is stable", sortFieldRows([row(9, 5, false), row(2, 5, false)]).map((r) => r.fieldId), [2, 9]);
}

console.log(`\nTHE DEFAULT WINDOW — a live match inside the last 12 months`);
{
  is("a match last month is recent", isRecent({ lastMatch: "2026-07-01" }, NOW), true);
  is("a match 11 months back is recent", isRecent({ lastMatch: "2025-09-30" }, NOW), true);
  is("a match 13 months back is NOT", isRecent({ lastMatch: "2025-07-01" }, NOW), false);
  is("the boundary day itself is IN", isRecent({ lastMatch: "2025-08-24" }, NOW), true);
  is("the day before it is OUT", isRecent({ lastMatch: "2025-08-23" }, NOW), false);
  is("a booked FUTURE match is recent — field 1552's whole case", isRecent({ lastMatch: "2026-09-02" }, NOW), true);
  is("a field with only cancelled matches has no lastMatch and is not recent", isRecent({ lastMatch: null }, NOW), false);
  const rows = [
    { fieldId: 1, liveMatches: 2, lastMatch: "2026-08-01", mapping: null },
    { fieldId: 2, liveMatches: 9, lastMatch: "2024-03-01", mapping: null },
  ] as FieldIdRow[];
  eq("the default view hides the stale one", visibleFieldRows(rows, false, NOW).map((r) => r.fieldId), [1]);
  eq("...and Show all brings it back, still in rank order", visibleFieldRows(rows, true, NOW).map((r) => r.fieldId), [2, 1]);
}

console.log("\nADDRESS EVIDENCE — surfaced, never acted on");
{
  const mk = (fieldId: number, address: string | null, zip: string | null): FieldIdRow =>
    ({ fieldId, address, zip, mapping: null } as FieldIdRow);
  const katy = mk(1552, "Memorial Hermann Sports Park, 23910 Katy Fwy, Katy, TX", "77494");
  const all = [katy, mk(892, "Memorial Hermann Sports Park, 23910 Katy Fwy, Katy, TX", "77494"), mk(13, "Elsewhere", "78701")];
  eq("the field at the same address is surfaced", addressPeers(katy, all).map((r) => r.fieldId), [892]);
  is("...and it is not vacuous — the needle is proven present", addressPeers(katy, all).length > 0, true);
  eq("a field with no address and no zip has no peers", addressPeers(mk(7, null, null), all).map((r) => r.fieldId), []);
  eq("a lone address matches nobody", addressPeers(mk(8, "Nowhere Rd", "00000"), all).map((r) => r.fieldId), []);
}

// ── the preview ─────────────────────────────────────────────────────────────
const venue = (over: Partial<VenueOption> = {}): VenueOption => ({
  id: 7, venueName: "ATH Katy", city: "Houston", isActive: true, billingType: "per_match",
  perMatchRate: 140, costPerMatch: 140, chargeOnCancel: false, billsPerReservation: false,
  fieldCount: 1, liveMatches: 105, dppRevenue: 14145.5, split: null, ...over,
});
const field = (over: Partial<FieldIdRow> = {}): FieldIdRow => ({
  fieldId: 1552, title: "Tourney ATH Katy", titleVariants: 1, city: "Houston",
  address: "Memorial Hermann Sports Park, 23910 Katy Fwy, Katy, TX", zip: "77494",
  liveMatches: 9, cancelledMatches: 0, upcomingMatches: 2,
  firstMatch: "2026-07-20", lastMatch: "2026-09-02", dppRevenue: 1968.25, dppSpots: 170,
  billableLive: 0, billableCancelled: 0, billableSlotsLive: 0, billableSlotsWithCancelled: 0,
  sundayLive: 0, mapping: null, ...over,
});

console.log("\nTHE CONSEQUENCE — what the operator commits against");
{
  const pv = previewAssignment(field(), venue());
  is("matches gained is the field's LIVE count", pv.matchesGained, 9);
  is("...shown against the venue's current total", `${pv.venueMatchesBefore}→${pv.venueMatchesAfter}`, "105→114");
  is("revenue attributed is the field's whole history, to the cent", pv.revenueAttributed, 1968.25);
  is("...and the venue's total moves by exactly that", pv.venueRevenueAfter, 16113.75);
  is("cost added is ZERO — every match is an event by title", pv.cost.amount, 0);
  is("...and the exclusion is NAMED, not left as an unexplained zero", pv.eventExclusion?.excludedLive, 9);
  is("...with the cost that will not be counted: 9 × $140", pv.eventExclusion?.wouldHaveBeen, 1260);
}
{
  const pv = previewAssignment(field({ title: "ATH Katy Annex", billableLive: 9 }), venue());
  is("a plain-titled field DOES add cost: 9 × $140", pv.cost.amount, 1260);
  is("...and raises no event exclusion", pv.eventExclusion, null);
  is("the note names the basis so it is not mistaken for Field Costs", /As Billed \(per_match_rate\)/.test(pv.cost.note), true);
  is("CONTROL — the note is not empty", pv.cost.note.length > 40, true);
}
{
  const f = field({ title: "Plain", billableLive: 6, billableCancelled: 4, billableSlotsLive: 4, billableSlotsWithCancelled: 5, cancelledMatches: 4 });
  is("charge_on_cancel OFF bills live matches only: 6 × $140", previewAssignment(f, venue()).cost.amount, 840);
  is("charge_on_cancel ON adds the cancelled ones: 10 × $140", previewAssignment(f, venue({ chargeOnCancel: true })).cost.amount, 1400);
  is("bills_per_reservation collapses to slots: 4 × $140", previewAssignment(f, venue({ billsPerReservation: true })).cost.amount, 560);
  is("...and with charge_on_cancel, to the SAME set of 5 slots", previewAssignment(f, venue({ billsPerReservation: true, chargeOnCancel: true })).cost.amount, 700);
  is("the reservation wording says reservations, not matches", previewAssignment(f, venue({ billsPerReservation: true })).cost.unitNoun, "reservations");
}
{
  // A COST IS NULL, NEVER ZERO, WHEN THERE IS NO BASIS (migration 0142).
  const noRate = previewAssignment(field({ billableLive: 9 }), venue({ perMatchRate: null, costPerMatch: null }));
  is("no per_match_rate → the cost is UNKNOWN, not $0", noRate.cost.amount, null);
  is("...and it says untracked rather than free", /UNTRACKED, not as free/.test(noRate.cost.note), true);
  const stale = previewAssignment(field({ billableLive: 9 }), venue({ perMatchRate: null }));
  is("a venue with cost_per_match but no per_match_rate warns rather than quietly using the other column", stale.warnings.some((w) => /per_match_rate is NULL/.test(w)), true);
  const share = previewAssignment(field({ billableLive: 9 }), venue({ billingType: "profit_share", perMatchRate: null }));
  is("profit share has no per-match cost to add", share.cost.amount, null);
  is("...and says the payout base moves instead", /payout base/.test(share.cost.note), true);
  const flat = previewAssignment(field({ billableLive: 9 }), venue({ billingType: "monthly_flat" }));
  is("a monthly flat venue genuinely adds $0, and that IS a number", flat.cost.amount, 0);
}
{
  const sunday = venue({ split: { kind: "sunday", partnerName: "ATH Katy Sunday", partnerRate: 160 } });
  const withSun = previewAssignment(field({ billableLive: 9, sundayLive: 3 }), sunday);
  is("a split venue names the leg the Sunday matches will route to", /ATH Katy Sunday/.test(withSun.splitNote ?? ""), true);
  is("...and the count, and the other rate", /3 of these live matches/.test(withSun.splitNote ?? "") && /\$160/.test(withSun.splitNote ?? ""), true);
  is("with no Sunday matches it says so rather than staying silent", /None of this field/.test(previewAssignment(field({ sundayLive: 0 }), sunday).splitNote ?? ""), true);
  is("a venue with no split raises no split note at all", previewAssignment(field(), venue()).splitNote, null);
}
{
  is("a city mismatch is warned", previewAssignment(field({ city: "Warsaw" }), venue()).warnings.some((w) => /Warsaw/.test(w)), true);
  is("MatchDay's 'Dallas / Fort Worth' vs our 'Dallas' is NOT a mismatch", previewAssignment(field({ city: "Dallas / Fort Worth" }), venue({ city: "Dallas" })).warnings.length, 0);
  is("an inactive venue is called out", previewAssignment(field(), venue({ isActive: false })).warnings.some((w) => /INACTIVE/.test(w)), true);
  is("CONTROL — a matching, active venue raises no warnings at all", previewAssignment(field(), venue()).warnings.length, 0);
}

// ── the validator: every refusal shown to REFUSE ─────────────────────────────
console.log("\nTHE WRITE REQUEST — each guard mutation-tested");
{
  const venues = [venue(), venue({ id: 8, venueName: "ATH Pearland", city: "Houston" })];
  const unmapped = field();
  const mapped = field({ mapping: { venueId: 7, venueName: "ATH Katy", venueCity: "Houston", venueIsActive: true, countsAsRegularPlay: false, titleAtLink: "ATH Katy" } });
  const V = (input: Parameters<typeof validateAssignment>[0], row: FieldIdRow | null = unmapped) =>
    validateAssignment(input, { row, venues });

  const good = V({ fieldId: 1552, mode: "existing", venueId: 7 });
  is("ACCEPT — an unmapped field pointed at a real venue", good.ok, true);
  eq("...carrying the field's CURRENT title onto the link, for drift detection",
    good.ok ? good.request : null,
    { mode: "existing", fieldId: 1552, venueId: 7, titleAtLink: "Tourney ATH Katy" });

  is("REFUSE — a field with no matches at all", V({ fieldId: 99, mode: "existing", venueId: 7 }, null).ok, false);
  const already = V({ fieldId: 1552, mode: "existing", venueId: 8 }, mapped);
  is("REFUSE — a field that is already mapped", already.ok, false);
  is("...and it says re-pointing moves history, rather than a generic error", !already.ok && /moves history/.test(already.error), true);
  is("REFUSE — a venue id that does not exist", V({ fieldId: 1552, mode: "existing", venueId: 4242 }).ok, false);
  is("REFUSE — no venue picked at all", V({ fieldId: 1552, mode: "existing", venueId: null }).ok, false);
  is("REFUSE — an unknown mode", V({ fieldId: 1552, mode: "delete", venueId: 7 }).ok, false);

  const newOk = V({ fieldId: 1552, mode: "new", venueName: " Katy Annex ", city: "Houston", billingType: "per_match" });
  is("ACCEPT — a new venue with a name, a known city and a billing type", newOk.ok, true);
  is("...with the name trimmed", newOk.ok && newOk.request.mode === "new" ? newOk.request.venueName : null, "Katy Annex");
  is("REFUSE — a blank new-venue name", V({ fieldId: 1552, mode: "new", venueName: "   ", city: "Houston", billingType: "per_match" }).ok, false);
  is("REFUSE — no city", V({ fieldId: 1552, mode: "new", venueName: "X", city: "", billingType: "per_match" }).ok, false);
  const warsaw = V({ fieldId: 1552, mode: "new", venueName: "Bemowo", city: "Warsaw", billingType: "per_match" });
  is("REFUSE — a city outside the cockpit's list (Warsaw is a PARTNER market)", warsaw.ok, false);
  is("...and it says why an unknown city is worse than an error", !warsaw.ok && /drops out of every rollup/.test(warsaw.error), true);
  is("REFUSE — a billing type nobody offers", V({ fieldId: 1552, mode: "new", venueName: "X", city: "Houston", billingType: "hourly" }).ok, false);
  const dupe = V({ fieldId: 1552, mode: "new", venueName: "ath katy", city: "Houston", billingType: "per_match" });
  is("REFUSE — a new venue whose (name, city) already exists, case-insensitively", dupe.ok, false);
  is("...pointing at the existing row instead", !dupe.ok && /#7/.test(dupe.error), true);
  is("ACCEPT — the SAME name in a DIFFERENT city is a different pitch", V({ fieldId: 1552, mode: "new", venueName: "ATH Katy", city: "Austin", billingType: "per_match" }).ok, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
