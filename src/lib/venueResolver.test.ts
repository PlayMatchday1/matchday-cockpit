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

test("resolver is idempotent — f(f(x)) === f(x), so a second sync run can't shift a venue", () => {
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
    "Round Rock Tournaments", "Stadium Field at Round Rock M.C.", "Round Rock",
    "KISC (Katy Intl)", "Katy International Sports Complex", "STAR", "N/A", "Some Brand New Venue",
  ];
  for (const x of inputs) {
    const c1 = canonicalVenueName(x);
    const c2 = canonicalVenueName(c1);
    assert.equal(c2, c1, `not idempotent: "${x}" -> "${c1}" -> "${c2}"`);
  }
});

test("the four Lou Fusz spellings + combine resolve to St. Louis", () => {
  for (const s of ["Lou Fusz - Indoor Field", "Lou Fusz - Outdoor Field", "Lou Fusz TC Indoor Field", "MatchDay Combine at Lou Fusz"]) {
    assert.equal(resolveVenue(s).city, "St. Louis", `${s}`);
  }
  assert.equal(canonicalVenueName("Lou Fusz TC Indoor Field"), "Lou Fusz Indoor");
  assert.equal(canonicalVenueName("MatchDay Combine at Lou Fusz"), "Lou Fusz Outdoor");
});
