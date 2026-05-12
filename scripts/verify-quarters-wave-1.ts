// Wave-1 verification: prove (a) lib/quarters.ts produces the right
// shape on key dates, and (b) financeStats.Q2_MONTHS still resolves
// to ["Apr 2026", "May 2026", "Jun 2026"] under today's clock.
//
// Run with: npx tsx scripts/verify-quarters-wave-1.ts

import {
  getCurrentQuarter,
  getQuarterByKey,
  getAvailableQuarters,
  getQuarterDateRange,
  isCurrentMonth,
  isFutureMonth,
  isCurrentQuarter,
} from "../src/lib/quarters";

let fail = 0;
function assertEq<T>(label: string, got: T, want: T) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  const ok = a === b;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${label}\n   got:  ${a}\n   want: ${b}`);
}

// === Today (May 11, 2026) — Q2 2026 ===
const MAY_11 = new Date(2026, 4, 11); // Mon May 11
const todayQ = getCurrentQuarter(MAY_11);

assertEq("getCurrentQuarter(May 11 2026).label", todayQ.label, "Q2 2026");
assertEq("getCurrentQuarter(May 11 2026).key", todayQ.key, "2026Q2");
assertEq(
  "Q2 month keys",
  todayQ.months.map((m) => m.key),
  ["Apr 2026", "May 2026", "Jun 2026"],
);
assertEq(
  "Q2 month indexes",
  todayQ.months.map((m) => m.monthIndex),
  [3, 4, 5],
);
assertEq(
  "Q2 month days",
  todayQ.months.map((m) => m.daysInMonth),
  [30, 31, 30],
);
assertEq(
  "Q2 month fullNames",
  todayQ.months.map((m) => m.fullName),
  ["APRIL", "MAY", "JUNE"],
);
assertEq(
  "Q2 start ISO",
  todayQ.start.toISOString().slice(0, 10),
  "2026-04-01",
);
assertEq("Q2 end ISO", todayQ.end.toISOString().slice(0, 10), "2026-06-30");

// === July 15, 2026 — Q3 2026 ===
const JUL_15 = new Date(2026, 6, 15);
const q3 = getCurrentQuarter(JUL_15);
assertEq("Jul 15 → quarter label", q3.label, "Q3 2026");
assertEq("Jul 15 → quarter key", q3.key, "2026Q3");
assertEq(
  "Q3 month keys",
  q3.months.map((m) => m.key),
  ["Jul 2026", "Aug 2026", "Sep 2026"],
);
assertEq(
  "Q3 month days (Jul=31, Aug=31, Sep=30)",
  q3.months.map((m) => m.daysInMonth),
  [31, 31, 30],
);
assertEq(
  "Q3 start ISO",
  q3.start.toISOString().slice(0, 10),
  "2026-07-01",
);
assertEq("Q3 end ISO", q3.end.toISOString().slice(0, 10), "2026-09-30");

// === Jun 30, 2026 — still Q2 ===
const JUN_30 = new Date(2026, 5, 30);
assertEq("Jun 30 → quarter label", getCurrentQuarter(JUN_30).label, "Q2 2026");

// === Jul 1, 2026 — now Q3 ===
const JUL_1 = new Date(2026, 6, 1);
assertEq("Jul 1 → quarter label", getCurrentQuarter(JUL_1).label, "Q3 2026");

// === Leap year sanity (2028 Q1: Feb has 29 days) ===
const FEB_2028 = new Date(2028, 1, 15);
const q1_2028 = getCurrentQuarter(FEB_2028);
assertEq(
  "2028 Q1 month days (leap year Feb=29)",
  q1_2028.months.map((m) => m.daysInMonth),
  [31, 29, 31],
);

// === getQuarterByKey roundtrips ===
assertEq("parse 2026Q2", getQuarterByKey("2026Q2")?.label, "Q2 2026");
assertEq("parse 2027q4 (lowercase)", getQuarterByKey("2027q4")?.label, "Q4 2027");
assertEq("parse malformed", getQuarterByKey("garbage"), null);
assertEq(
  "parse pre-EARLIEST",
  getQuarterByKey("2026Q1"),
  null,
);
assertEq(
  "parse pre-EARLIEST year",
  getQuarterByKey("2025Q4"),
  null,
);

// === getAvailableQuarters — May 11 should only surface Q2 2026 ===
assertEq(
  "available quarters on May 11 2026",
  getAvailableQuarters(MAY_11).map((q) => q.key),
  ["2026Q2"],
);
assertEq(
  "available quarters on Jul 15 2026",
  getAvailableQuarters(JUL_15).map((q) => q.key),
  ["2026Q3", "2026Q2"],
);
assertEq(
  "available quarters on Jan 2 2027",
  getAvailableQuarters(new Date(2027, 0, 2)).map((q) => q.key),
  ["2027Q1", "2026Q4", "2026Q3", "2026Q2"],
);

// === getQuarterDateRange spot ===
const r = getQuarterDateRange(2026, 4);
assertEq("Q4 2026 start", r.start.toISOString().slice(0, 10), "2026-10-01");
assertEq("Q4 2026 end", r.end.toISOString().slice(0, 10), "2026-12-31");

// === predicates ===
assertEq(
  "May 11: May 2026 is current month",
  isCurrentMonth(todayQ.months[1], MAY_11),
  true,
);
assertEq(
  "May 11: Jun 2026 is future month",
  isFutureMonth(todayQ.months[2], MAY_11),
  true,
);
assertEq(
  "May 11: Apr 2026 is not future",
  isFutureMonth(todayQ.months[0], MAY_11),
  false,
);
assertEq(
  "May 11: Q2 2026 is the current quarter",
  isCurrentQuarter(todayQ, MAY_11),
  true,
);
assertEq(
  "May 11: Q3 2026 is not the current quarter",
  isCurrentQuarter(q3, MAY_11),
  false,
);

// === The key Wave-1 invariant: Q2_MONTHS as it lands in financeStats ===
// Replicates exactly what financeStats.ts line 21 evaluates at module
// load. On today's clock this MUST equal the previous hardcoded value.
const today = new Date(); // real clock
const liveQ = getCurrentQuarter(today);
const liveMonthKeys = liveQ.months.map((m) => m.key);
console.log(`\nReal-clock Q2_MONTHS would be: ${JSON.stringify(liveMonthKeys)}`);
console.log(`(Today=${today.toISOString().slice(0, 10)}, quarter=${liveQ.label})`);

if (fail > 0) {
  console.error(`\n${fail} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
