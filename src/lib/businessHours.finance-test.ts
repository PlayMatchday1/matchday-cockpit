// Business-hours math — the numbers here are shown to people, so the
// window logic gets exhaustive coverage. All timestamps are written as
// explicit UTC ISO strings with the Central wall-clock they denote in a
// comment, since the whole point is the UTC↔Central mapping.
//
// July 2026 is CDT (UTC−5): 9:00am CDT = 14:00 UTC, 9:00pm CDT = 02:00
// UTC the next day. A few cases deliberately straddle the Mar 8 2026
// spring-forward to prove DST correctness.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  businessMinutesBetween,
  median,
  zonedWallClockToUtcMs,
  wallClockPartsInZone,
  BUSINESS_TZ,
  BUSINESS_HOURS_START,
  BUSINESS_HOURS_END,
} from "./businessHours";

const iso = (s: string) => Date.parse(s);
// Small tolerance for anything that could carry sub-minute rounding.
const approx = (a: number, b: number, epsilon = 0.001) =>
  Math.abs(a - b) <= epsilon;

test("constants match the spec (9am–9pm Central)", () => {
  assert.equal(BUSINESS_HOURS_START, 9);
  assert.equal(BUSINESS_HOURS_END, 21);
  assert.equal(BUSINESS_TZ, "America/Chicago");
});

// ---------------------------------------------------------------
// zoned wall-clock ↔ UTC
// ---------------------------------------------------------------
test("9am CDT resolves to 14:00 UTC (summer offset)", () => {
  // 2026-07-22 09:00 Central → 14:00Z
  assert.equal(
    zonedWallClockToUtcMs(2026, 7, 22, 9, 0, BUSINESS_TZ),
    iso("2026-07-22T14:00:00Z"),
  );
});

test("9am CST resolves to 15:00 UTC (winter offset)", () => {
  // 2026-01-15 09:00 Central (CST, UTC−6) → 15:00Z
  assert.equal(
    zonedWallClockToUtcMs(2026, 1, 15, 9, 0, BUSINESS_TZ),
    iso("2026-01-15T15:00:00Z"),
  );
});

test("wallClockPartsInZone reads Central components back", () => {
  const p = wallClockPartsInZone(iso("2026-07-22T02:30:00Z"), BUSINESS_TZ);
  // 02:30 UTC = 9:30pm CDT the previous day.
  assert.equal(p.year, 2026);
  assert.equal(p.month, 7);
  assert.equal(p.day, 21);
  assert.equal(p.hour, 21);
  assert.equal(p.minute, 30);
});

// ---------------------------------------------------------------
// 1. instant reply ≈ 0
// ---------------------------------------------------------------
test("instant reply during business hours ≈ 0 minutes", () => {
  // 10:00:00am → 10:00:30am CDT, mid-window.
  const start = iso("2026-07-22T15:00:00Z");
  const end = iso("2026-07-22T15:00:30Z");
  assert.ok(businessMinutesBetween(start, end) < 1);
});

test("a one-minute in-window reply is exactly 1 business minute", () => {
  const start = iso("2026-07-22T15:00:00Z"); // 10:00am CDT
  const end = iso("2026-07-22T15:01:00Z"); // 10:01am CDT
  assert.ok(approx(businessMinutesBetween(start, end), 1));
});

// ---------------------------------------------------------------
// 2. overnight — counts only post-9am business minutes
// ---------------------------------------------------------------
test("the spec example: 8:50pm → 9:10am next day = 20 business minutes", () => {
  // 8:50pm CDT 7/21 = 01:50Z 7/22; 9:10am CDT 7/22 = 14:10Z 7/22.
  const inbound = iso("2026-07-22T01:50:00Z");
  const reply = iso("2026-07-22T14:10:00Z");
  // 8:50pm→9:00pm = 10 min, overnight closed, 9:00am→9:10am = 10 min.
  assert.ok(approx(businessMinutesBetween(inbound, reply), 20));
});

test("inbound before open starts its clock at 9am, not on arrival", () => {
  // 7:00am CDT (12:00Z) inbound, answered 10:00am CDT (15:00Z).
  const inbound = iso("2026-07-22T12:00:00Z");
  const reply = iso("2026-07-22T15:00:00Z");
  // Only 9:00–10:00am counts = 60 minutes, not 180.
  assert.ok(approx(businessMinutesBetween(inbound, reply), 60));
});

test("a full business day is 12 hours = 720 minutes", () => {
  // 9:00am → 9:00pm CDT on 7/22.
  const open = iso("2026-07-22T14:00:00Z");
  const close = iso("2026-07-23T02:00:00Z");
  assert.ok(approx(businessMinutesBetween(open, close), 720));
});

test("multi-day gap sums each day's window", () => {
  // 8:00pm CDT Wed 7/22 → 10:00am CDT Fri 7/24.
  // Wed 8–9pm = 60, Thu full = 720, Fri 9–10am = 60 → 840.
  const inbound = iso("2026-07-23T01:00:00Z"); // 8pm CDT 7/22
  const reply = iso("2026-07-24T15:00:00Z"); // 10am CDT 7/24
  assert.ok(approx(businessMinutesBetween(inbound, reply), 840));
});

// ---------------------------------------------------------------
// 3. after-hours / weekend-only gap doesn't inflate
// ---------------------------------------------------------------
test("a gap entirely after close contributes 0 business minutes", () => {
  // 9:30pm → 10:30pm CDT, both past the 9pm close.
  const start = iso("2026-07-22T02:30:00Z"); // 9:30pm CDT 7/21
  const end = iso("2026-07-22T03:30:00Z"); // 10:30pm CDT 7/21
  assert.equal(businessMinutesBetween(start, end), 0);
});

test("a weekend overnight gap (Sat 10pm → Sun 8am) does not inflate", () => {
  // Sat 7/25 10:00pm CDT = 03:00Z Sun; Sun 7/26 8:00am CDT = 13:00Z.
  // Sat 10pm–midnight and Sun midnight–8am are all closed; the reply
  // lands before Sunday's 9am open → 0 business minutes.
  const inbound = iso("2026-07-26T03:00:00Z");
  const reply = iso("2026-07-26T13:00:00Z");
  assert.equal(businessMinutesBetween(inbound, reply), 0);
});

test("weekends ARE working days: Sat 10am → Sat 11am = 60 minutes", () => {
  // The flip side of the rule — weekend in-window time counts, so a
  // Saturday inbound answered an hour later reads as 60 min, not a
  // two-day wait until Monday.
  const inbound = iso("2026-07-25T15:00:00Z"); // Sat 10am CDT
  const reply = iso("2026-07-25T16:00:00Z"); // Sat 11am CDT
  assert.ok(approx(businessMinutesBetween(inbound, reply), 60));
});

test("Friday-night inbound answered Monday morning counts only weekend+Mon windows, not the closed nights", () => {
  // Fri 7/24 10:00pm CDT (03:00Z Sat) → Mon 7/27 9:30am CDT (14:30Z).
  // Fri after close = 0, Sat full 720, Sun full 720, Mon 9–9:30 = 30
  // → 1470. Proves the three closed overnight bands add nothing.
  const inbound = iso("2026-07-25T03:00:00Z");
  const reply = iso("2026-07-27T14:30:00Z");
  assert.ok(approx(businessMinutesBetween(inbound, reply), 1470));
});

// ---------------------------------------------------------------
// DST correctness
// ---------------------------------------------------------------
test("spans spring-forward without gaining or losing an hour", () => {
  // Sat 3/7/2026 8:00pm CST → Sun 3/8 10:00am CDT. The 2am→3am jump is
  // inside the closed overnight band, so it must not affect the count:
  // Sat 8–9pm = 60, Sun 9–10am = 60 → 120, exactly like any other night.
  const inbound = iso("2026-03-08T02:00:00Z"); // 8pm CST 3/7
  const reply = iso("2026-03-08T15:00:00Z"); // 10am CDT 3/8
  assert.ok(approx(businessMinutesBetween(inbound, reply), 120));
});

// ---------------------------------------------------------------
// guards
// ---------------------------------------------------------------
test("reversed or zero-length interval is 0", () => {
  const a = iso("2026-07-22T15:00:00Z");
  const b = iso("2026-07-22T16:00:00Z");
  assert.equal(businessMinutesBetween(b, a), 0);
  assert.equal(businessMinutesBetween(a, a), 0);
});

test("non-finite timestamps yield 0, never NaN", () => {
  const a = iso("2026-07-22T15:00:00Z");
  assert.equal(businessMinutesBetween(NaN, a), 0);
  assert.equal(businessMinutesBetween(a, NaN), 0);
});

// ---------------------------------------------------------------
// 4. median robust to a single huge outlier
// ---------------------------------------------------------------
test("median ignores a single huge outlier the mean would chase", () => {
  const values = [5, 6, 7, 8, 9999];
  assert.equal(median(values), 7);
  // Sanity: the mean would be dragged past 2000.
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(mean > 2000);
});

test("median of an even-length list averages the two middle values", () => {
  assert.equal(median([10, 20, 30, 40]), 25);
});

test("median of a single value is that value; empty is null", () => {
  assert.equal(median([42]), 42);
  assert.equal(median([]), null);
});

test("median does not mutate its input", () => {
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2]);
});
