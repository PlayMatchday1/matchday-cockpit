// Pay-date dating for Match Manager Pay. Pay moved from Thursday (Sunday+4)
// to Tuesday (Sunday+2) — when payroll actually leaves the account. These
// lock the derivation, its inverse, and the cutover anchor so the recompute
// window and the frozen-history floor can't silently drift.
//
// Run: npx tsx --test src/lib/managerPayCompute.finance-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  payDateForWeek,
  workWeekStartForPayDate,
  weekdayUtc,
  MANAGER_PAY_CUTOVER_PAY_DATE,
} from "./managerPayCompute";

// weekdayUtc: 0=Sun .. 6=Sat. Monday=1, Tuesday=2.

test("pay date is the Tuesday after the work week (Monday + 8)", () => {
  // Work week Mon 2026-06-22 .. Sun 06-28 → pay Tue 2026-06-30. This is the
  // approved boundary shift: was Thu 2026-07-02, now dated into June.
  assert.equal(payDateForWeek("2026-06-22"), "2026-06-30");
  assert.equal(weekdayUtc("2026-06-30"), 2, "pay date is a Tuesday");
  // A mid-month week stays on its Tuesday.
  assert.equal(payDateForWeek("2026-07-06"), "2026-07-14");
  assert.equal(weekdayUtc("2026-07-14"), 2);
});

test("workWeekStartForPayDate is the exact inverse and lands on Monday", () => {
  for (const monday of ["2026-05-11", "2026-06-22", "2026-07-13"]) {
    assert.equal(workWeekStartForPayDate(payDateForWeek(monday)), monday);
  }
  assert.equal(weekdayUtc(workWeekStartForPayDate("2026-06-30")), 1);
});

test("cutover is the Tuesday of the first recomputed week (Mon 2026-05-11)", () => {
  // Moving to Tuesdays keeps the SAME first work week, so the recompute
  // window is unchanged — only the constant's weekday moved (Thu 05-21 → Tue
  // 05-19).
  assert.equal(MANAGER_PAY_CUTOVER_PAY_DATE, "2026-05-19");
  assert.equal(weekdayUtc(MANAGER_PAY_CUTOVER_PAY_DATE), 2);
  assert.equal(workWeekStartForPayDate(MANAGER_PAY_CUTOVER_PAY_DATE), "2026-05-11");
  assert.equal(weekdayUtc("2026-05-11"), 1);
});

test("frozen history stays below the delete floor", () => {
  // The recompute deletes fin_expenses rows with date >= cutover. The last
  // frozen manual Thursday (2026-05-14) is strictly below it, so lowering the
  // floor from Thu 05-21 to Tue 05-19 still never touches frozen rows.
  assert.ok("2026-05-14" < MANAGER_PAY_CUTOVER_PAY_DATE);
});
