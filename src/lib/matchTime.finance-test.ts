// Guards for mdapi match time handling (originally Match Reviews only —
// the module is now the general home, see lib/matchTime.ts). mdapi_matches.start_date is a
// venue-LOCAL wall-clock stamped with a fake +00:00 offset; start_date_utc is
// the true instant. Mixing them shifts matches a day forward and lets tonight's
// not-yet-played matches show with phantom (recurring-series) ratings. These
// lock the invariant so a date regression fails here, not on the dashboard.
//
// Run: npx tsx --test src/lib/matchTime.finance-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchStartMs,
  isPastMatch,
  matchLocalDate,
  matchLocalMonth,
  fmtMatchDateTime,
  windowCutoffIso,
  msFromInstantToMatch,
} from "./matchTime";

// Lowell H. Strike, tonight — a Central 9:00 PM match. Real instant is Jul 21
// 02:00 UTC; start_date's fake +00:00 makes "21:00" look like 21:00 UTC.
const LOWELL_LOCAL = "2026-07-20T21:00:00+00:00";
const LOWELL_UTC = "2026-07-21T02:00:00+00:00";
// ATH Pearland — a real, already-played Jul 19 9:15 PM Central match.
const PEARLAND_LOCAL = "2026-07-19T21:15:00+00:00";
const PEARLAND_UTC = "2026-07-20T02:15:00+00:00";

test("display renders date AND time from the local wall-clock (no tz split)", () => {
  assert.equal(fmtMatchDateTime(LOWELL_LOCAL), "Jul 20 · 9:00 PM");
  assert.equal(fmtMatchDateTime(PEARLAND_LOCAL), "Jul 19 · 9:15 PM");
  assert.equal(matchLocalDate(LOWELL_LOCAL), "2026-07-20");
  assert.equal(matchLocalMonth(LOWELL_LOCAL), "2026-07");
});

test("matchStartMs uses the TRUE utc instant, not start_date's fake offset", () => {
  // 5 hours apart: the fake +00:00 vs the real Central offset.
  assert.equal(matchStartMs(LOWELL_UTC, LOWELL_LOCAL), Date.parse(LOWELL_UTC));
  assert.notEqual(matchStartMs(LOWELL_UTC, LOWELL_LOCAL), Date.parse(LOWELL_LOCAL));
});

test("INVARIANT: a match whose true start is in the future is excluded", () => {
  // "Now" = Jul 20 5:00 PM Central (22:00 UTC). Lowell's true start is 9:00 PM
  // Central (Jul 21 02:00 UTC) — still 4h away, so it must NOT be reviewable.
  const now = Date.parse("2026-07-20T22:00:00+00:00");
  assert.equal(isPastMatch(LOWELL_UTC, LOWELL_LOCAL, now), false);
  // The bug this replaces: comparing start_date's wall-clock (21:00 "UTC")
  // would wrongly treat it as past by 5:00 PM. Prove the fix diverges from it.
  assert.equal(Date.parse(LOWELL_LOCAL) <= now, true); // the OLD (buggy) verdict
});

test("a genuinely-played past match is included", () => {
  const now = Date.parse("2026-07-20T22:00:00+00:00");
  assert.equal(isPastMatch(PEARLAND_UTC, PEARLAND_LOCAL, now), true);
});

test("last-3-days cutoff is today minus 2 local days, inclusive", () => {
  // A local Date at noon on Jul 20.
  const now = new Date(2026, 6, 20, 12, 0, 0);
  assert.equal(windowCutoffIso(now, 3), "2026-07-18");
  assert.equal(windowCutoffIso(now, 1), "2026-07-20");
});

test("null/garbage timestamps degrade safely", () => {
  assert.equal(matchStartMs(null, null), null);
  assert.equal(isPastMatch(null, null, Date.now()), false);
  assert.equal(fmtMatchDateTime(null), "");
  assert.equal(matchLocalDate(undefined), "");
});

// ---------------------------------------------------------------
// Durations spanning a match and a non-match timestamp.
//
// The signup → first-match funnel metric subtracted a genuine-UTC
// created_at from a wall-clock-derived match Date, biasing every
// measurement by the venue's offset. These pin the corrected form.
// ---------------------------------------------------------------

test("msFromInstantToMatch measures from a real instant to the real kickoff", () => {
  // Player completed signup 2026-07-20 18:00 UTC (1:00 PM Central); the
  // match kicks off 2026-07-21 02:00 UTC (9:00 PM Central same evening).
  const signupUtcMs = Date.parse("2026-07-20T18:00:00Z");
  const delta = msFromInstantToMatch(LOWELL_UTC, LOWELL_LOCAL, signupUtcMs);
  assert.equal(delta, 8 * 3600_000, "8 hours from signup to kickoff");

  // The buggy inline form reads the fake +00:00 as real and lands 5h early,
  // understating the gap. Pinned so the difference stays visible.
  const buggy = Date.parse(LOWELL_LOCAL) - signupUtcMs;
  assert.equal(buggy, 3 * 3600_000);
  assert.notEqual(buggy, delta);
});

test("msFromInstantToMatch is negative for a match already played", () => {
  const nowMs = Date.parse("2026-07-20T12:00:00Z");
  const delta = msFromInstantToMatch(PEARLAND_UTC, PEARLAND_LOCAL, nowMs);
  assert.ok(delta !== null && delta < 0, "Jul 19 match precedes Jul 20 noon");
});

test("msFromInstantToMatch returns null when the instant is unknown", () => {
  assert.equal(msFromInstantToMatch(null, null, Date.now()), null);
});

test("a match kicking off later tonight is NOT past, at any afternoon hour", () => {
  // The exact window the CRM route mislabelled: between the fake stamp
  // (21:00 "UTC" = 16:00 real) and true kickoff (02:00 next day UTC), the
  // match must still read as upcoming.
  for (const hour of ["16:30", "18:00", "20:00", "23:00"]) {
    const nowMs = Date.parse(`2026-07-20T${hour}:00Z`);
    assert.equal(
      isPastMatch(LOWELL_UTC, LOWELL_LOCAL, nowMs),
      false,
      `at ${hour} UTC the 02:00-UTC match has not kicked off`,
    );
  }
  // Just after the true instant it flips.
  assert.equal(
    isPastMatch(LOWELL_UTC, LOWELL_LOCAL, Date.parse("2026-07-21T02:00:01Z")),
    true,
  );
});
