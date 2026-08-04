import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVenue, canonicalVenueName, venueCategory } from "./venueResolver";

test("category comes from the string's own markers, not the pitch", () => {
  assert.equal(venueCategory("NEMP Tournaments"), "event");
  assert.equal(venueCategory("North East Metropolitan Park"), "regular");
  assert.equal(venueCategory("MatchDay Combine at Lou Fusz"), "event");
  assert.equal(venueCategory("Tourney at Soccer Central"), "event");
  assert.equal(venueCategory("Soccer Central World Cup Tournament"), "event");
  assert.equal(venueCategory("Onion Creek - St Patty's Showdown"), "event");
  assert.equal(venueCategory("Onion Creek"), "regular");
});

test("Hattrick Lakeline and Hattrick Tomball do NOT collapse", () => {
  assert.equal(canonicalVenueName("The Hattrick"), "Hattrick");
  assert.equal(canonicalVenueName("The Hattrick L."), "Hattrick");
  assert.equal(canonicalVenueName("The Hattrick T."), "Hattrick T.");
  assert.equal(canonicalVenueName("Hattrick Tomball"), "Hattrick T.");
  assert.notEqual(canonicalVenueName("The Hattrick"), canonicalVenueName("Hattrick Tomball"));
});

test("Soccer Central World Cup (event) gets a city", () => {
  const r = resolveVenue("Soccer Central World Cup Tournament");
  assert.equal(r.canonicalVenue, "Soccer Central");
  assert.equal(r.city, "San Antonio");
  assert.equal(r.category, "event");
});

test("event tournaments resolve to the base pitch's city, flagged event", () => {
  const nemp = resolveVenue("NEMP Tournaments");
  assert.equal(nemp.canonicalVenue, "NEMP");
  assert.equal(nemp.city, "Austin");
  assert.equal(nemp.category, "event");
  const pear = resolveVenue("Tourney ATH Pearland");
  assert.equal(pear.canonicalVenue, "ATH Pearland");
  assert.equal(pear.city, "Houston");
  assert.equal(pear.category, "event");
});

test("the four WestLake spellings unify to one Austin identity", () => {
  for (const s of ["WestLake", "WestLake - Field 3 - Match 1", "WestLake - Field 3 - Match 2", "Westlake HS Field 3"]) {
    const r = resolveVenue(s);
    assert.equal(r.canonicalVenue, "Westlake", `${s} → ${r.canonicalVenue}`);
    assert.equal(r.city, "Austin");
  }
});

test("VENUE fold is idempotent — canonicalVenueName(f(x)) === f(x), so a second sync run can't shift a venue", () => {
  // Representative inputs across all rule branches + the collapse cases.
  const inputs = [
    "WestLake - Field 3 - Match 1", "Westlake HS Field 3", "Westlake",
    "Tourney at Soccer Central", "Soccer Central Complex", "Soccer Central", "Soccer Central Tournament",
    "Tourney ATH Pearland", "ATH Pearland", "Tourney ATH Katy", "ATH Katy", "ATH Katy Sunday",
    "NEMP Tournaments", "North East Metropolitan Park", "NEMP",
    "The Hattrick", "The Hattrick L.", "The Hattrick T.", "Hattrick Tomball", "Hattrick", "Hattrick T.",
    "Lou Fusz - Indoor Field", "Lou Fusz TC Indoor Field", "MatchDay Combine at Lou Fusz",
    "Lou Fusz Indoor", "Lou Fusz Outdoor",
    "LBJ Early College High School - Match 2", "LBJ Early College High School",
    "Hill Country", "Hill Country Middle School", "Parmer Stadium - Premier", "Parmer",
    "Round Rock Tournaments", "Stadium Field at Round Rock M.C.", "Round Rock", "Special Events at RR", "RRMC F8", "RR F8",
    "KISC (Katy Intl)", "Katy International Sports Complex", "STAR", "N/A", "Some Brand New Venue",
    "Open Play at SJD", "San Juan Diego", "Mud Creek Soccer C.", "Mud Creek Soccer Complex",
    "NYCSC at East River Park Grand Street Field", "NYCSC East River", "NYCSC at Pier 40", "NYCSC Pier 40",
    "Tourney Houston Sports Park", "Houston Sports Park", "SEU Practice Field", "Sporti Soccer Complex",
  ];
  for (const x of inputs) {
    const c1 = canonicalVenueName(x);
    const c2 = canonicalVenueName(c1);
    assert.equal(c2, c1, `venue not idempotent: "${x}" -> "${c1}" -> "${c2}"`);
  }
});

test("the (venue, category) TUPLE is NOT idempotent — category is single-derivation, so it MUST be stored", () => {
  // Derived from the RAW string, once. Re-running resolveVenue on the folded
  // canonical (whose event marker has been stripped by design) flips the
  // category event→regular. That is exactly why fin_revenue must persist a
  // `category` column at write time and no read path may re-derive it from
  // fin_revenue.venue.
  const raw = resolveVenue("Soccer Central Tournament");
  assert.deepEqual([raw.canonicalVenue, raw.category], ["Soccer Central", "event"]);
  const refold = resolveVenue(raw.canonicalVenue);
  assert.deepEqual([refold.canonicalVenue, refold.category], ["Soccer Central", "regular"]);
  assert.notEqual(raw.category, refold.category); // f(f(x)) !== f(x) on the tuple — the finding
});

test("category is computed from the RAW input BEFORE the venue fold (order of operations)", () => {
  // Every raw event string → event. If the fold ran first and the marker rule
  // read the folded name, these would all silently become regular.
  const rawEvents = [
    "Tourney at Soccer Central", "Soccer Central World Cup Tournament", "Tourney ATH Pearland",
    "NEMP Tournaments", "Tourney ATH Katy", "Round Rock Tournaments",
    "MD Combine at Lou Fusz Athletic Complex", "Onion Creek - St Patty's Showdown",
  ];
  for (const e of rawEvents) assert.equal(resolveVenue(e).category, "event", `raw event must be event: ${e}`);
  // Their canonical venue names carry no marker → regular. Correct behaviour;
  // the pipeline only ever calls resolveVenue on the raw string, once.
  for (const c of ["Soccer Central", "ATH Pearland", "NEMP", "ATH Katy", "Round Rock", "Lou Fusz Outdoor", "Onion Creek"]) {
    assert.equal(resolveVenue(c).category, "regular", `canonical must be regular: ${c}`);
  }
});

test("Round Rock abbreviations (RR / RRMC) resolve to Round Rock; 'Special Events' is an event marker", () => {
  assert.equal(canonicalVenueName("Special Events at RR"), "Round Rock");
  assert.equal(canonicalVenueName("RRMC F8"), "Round Rock");
  assert.equal(canonicalVenueName("RR F8"), "Round Rock");
  // full spelling still resolves via the /round rock/ rule
  assert.equal(canonicalVenueName("Round Rock Multipurpose Complex"), "Round Rock");
  // 'Special Events' is now an event marker (was previously missed)
  assert.equal(venueCategory("Special Events at RR"), "event");
  const r = resolveVenue("Special Events at RR");
  assert.deepEqual([r.canonicalVenue, r.city, r.category], ["Round Rock", "Austin", "event"]);
  // a standalone "rr" inside a normal word must NOT trigger (word-boundaried)
  assert.equal(canonicalVenueName("Barrington Park"), "Barrington Park");
});

test("SJD abbreviation collapses to San Juan Diego (Austin); Mud Creek spellings unify (Atlanta)", () => {
  for (const s of ["Open Play at SJD", "Special Events at SJD", "EPL Kickoff Tournamanet at SJD - Bracket"]) {
    assert.equal(canonicalVenueName(s), "San Juan Diego", s);
    assert.equal(resolveVenue(s).city, "Austin");
  }
  assert.equal(canonicalVenueName("Mud Creek Soccer Complex"), "Mud Creek Soccer Complex");
  assert.equal(canonicalVenueName("Mud Creek Soccer C."), "Mud Creek Soccer Complex"); // 2nd spelling folds
  assert.equal(resolveVenue("Mud Creek Soccer C.").city, "Atlanta");
});

test("NYCSC is FOUR distinct pitches, not one — all in New York City", () => {
  const four = {
    "NYCSC at Pier 40": "NYCSC Pier 40",
    "NYCSC at Nike Field": "NYCSC Nike Field",
    "NYCSC at East River Park Grand Street Field": "NYCSC East River",
    "NYCSC at DeWitt Clinton Park": "NYCSC DeWitt Clinton",
  };
  const canons = new Set<string>();
  for (const [raw, canon] of Object.entries(four)) {
    const r = resolveVenue(raw);
    assert.equal(r.canonicalVenue, canon, raw);
    assert.equal(r.city, "New York City", raw);
    canons.add(r.canonicalVenue);
  }
  assert.equal(canons.size, 4, "the four NYCSC pitches must NOT collapse");
});

test("misfiled events reclassify via the vocabulary fix (cup / tournamanet)", () => {
  assert.equal(venueCategory("Brasileirão Cup"), "event");
  assert.equal(venueCategory("EPL Kickoff Tournamanet at SJD - Group Stage"), "event");
  // 'tournamanet' is tolerated as a specific typo, not general fuzziness:
  assert.equal(venueCategory("Tournamant"), "regular"); // a DIFFERENT typo does not match
});

test("new fallback-only venues resolve to their API city with no rule", () => {
  assert.equal(resolveVenue("SEU Practice Field").city, "Austin");
  assert.equal(resolveVenue("Community Fieldhouse").city, "Houston");
  assert.equal(resolveVenue("Mainland Sports Complex").city, "San Antonio");
  assert.equal(canonicalVenueName("SEU Practice Field"), "SEU Practice Field"); // passes through as itself
});

test("the four Lou Fusz spellings + combine resolve to St. Louis", () => {
  for (const s of ["Lou Fusz - Indoor Field", "Lou Fusz - Outdoor Field", "Lou Fusz TC Indoor Field", "MatchDay Combine at Lou Fusz"]) {
    assert.equal(resolveVenue(s).city, "St. Louis", `${s}`);
  }
  assert.equal(canonicalVenueName("Lou Fusz TC Indoor Field"), "Lou Fusz Indoor");
  assert.equal(canonicalVenueName("MatchDay Combine at Lou Fusz"), "Lou Fusz Outdoor");
});
