// Run via tsx (imports the opex module graph): `npm test` runs this
// through tsx. Standalone: `npx tsx --test src/lib/opex.finance-test.ts`.
//
// Guards the OpEx recurrence-expansion logic — the load-bearing bit that
// turns a stored entry + rule into per-day occurrences for a month view.

import { test } from "node:test";
import assert from "node:assert/strict";
import { occurrenceDaysInMonth, type Recurrence } from "./opex.ts";

const E = (
  scheduled_date: string,
  recurrence: Recurrence,
  recurrence_end: string | null = null,
) => ({ scheduled_date, recurrence, recurrence_end });

test("one_time: only on its own month", () => {
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "one_time"), 2026, 6), [15]);
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "one_time"), 2026, 7), []);
});

test("weekly: steps +7 through the month and into the next", () => {
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-03", "weekly"), 2026, 6), [3, 10, 17, 24, 31]);
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-03", "weekly"), 2026, 7), [7, 14, 21, 28]);
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-03", "weekly"), 2026, 5), []); // before anchor
});

test("weekly: honors recurrence_end", () => {
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-03", "weekly", "2026-07-17"), 2026, 6), [3, 10, 17]);
});

test("monthly: same day, clamped to last day when it doesn't exist", () => {
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "monthly"), 2026, 6), [15]); // anchor month
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "monthly"), 2026, 8), [15]); // Sep
  assert.deepEqual(occurrenceDaysInMonth(E("2026-01-31", "monthly"), 2026, 1), [28]); // Jan31 -> Feb28
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "monthly"), 2026, 5), []); // before anchor
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "monthly", "2026-08-01"), 2026, 8), []); // past end
});

test("quarterly: every 3 months from the anchor", () => {
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "quarterly"), 2026, 6), [15]); // Jul
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "quarterly"), 2026, 9), [15]); // Oct
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "quarterly"), 2026, 7), []); // Aug
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "quarterly"), 2027, 0), [15]); // Jan 2027
});

test("annually: same month/day each year, clamped for Feb 29", () => {
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "annually"), 2027, 6), [15]);
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "annually"), 2027, 7), []); // wrong month
  assert.deepEqual(occurrenceDaysInMonth(E("2026-07-15", "annually"), 2025, 6), []); // before anchor year
  assert.deepEqual(occurrenceDaysInMonth(E("2024-02-29", "annually"), 2027, 1), [28]); // Feb29 -> Feb28
});
