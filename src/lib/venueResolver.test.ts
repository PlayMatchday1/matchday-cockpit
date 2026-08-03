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

test("the four Lou Fusz spellings + combine resolve to St. Louis", () => {
  for (const s of ["Lou Fusz - Indoor Field", "Lou Fusz - Outdoor Field", "Lou Fusz TC Indoor Field", "MatchDay Combine at Lou Fusz"]) {
    assert.equal(resolveVenue(s).city, "St. Louis", `${s}`);
  }
  assert.equal(canonicalVenueName("Lou Fusz TC Indoor Field"), "Lou Fusz Indoor");
  assert.equal(canonicalVenueName("MatchDay Combine at Lou Fusz"), "Lou Fusz Outdoor");
});
