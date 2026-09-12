/* THE GOAL SHEET'S ARITHMETIC, PINNED.
 *
 * This page exists because a spreadsheet cannot compute its own left-hand column, and the
 * spreadsheet's own totals prove the point: its 29 rows sum to 16.6 while its stored "Total MD"
 * says 16.7, and Keswick shows 0.4 against 0.4 with a difference of 0.1. Both are one-decimal
 * rounding applied before the sum. Every assertion here is about a way that can happen again.
 */
import {
  SPOTS_PER_MATCH, band, countsTowardGoals, dailyAverage, daysElapsed, fmtUnit,
  matchMonthIndex, monthKey, ramp, rowKeyForField, sumTargets, weekly,
} from "@/lib/fieldGoals";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

console.log("\n— one match is eighteen spots, and a 36-spot match is two —");
is("18 spots over 1 day is one match a day", dailyAverage(18, 1), 1);
is("a 36-spot match counts twice", dailyAverage(36, 1), 2);
is("the constant is 18", SPOTS_PER_MATCH, 18);
/* THE TWO VENUES THE FORMULA WAS CHECKED AGAINST, kept as the record of why it is spots and not
 * matches: ATH Pearland runs 40-spot matches (40/18 = 2.2 a day) and the sheet says 2.4; Soccer
 * Central ran 36 and 32 on 2026-09-10 (68/18 = 3.8) and the sheet says 3.9. */
yes("ATH Pearland's 40-spot match is about 2.2, not 1", Math.abs(dailyAverage(40, 1) - 2.22) < 0.01);
yes("Soccer Central's 36+32 is about 3.8, not 2", Math.abs(dailyAverage(68, 1) - 3.78) < 0.01);
is("no elapsed days is no average, not a division by zero", dailyAverage(500, 0), 0);

console.log("\n— weekly is exactly daily times seven, everywhere —");
is("weekly of 2.4", weekly(2.4), 2.4 * 7);
yes("and the formatter agrees", fmtUnit(2.4, "week") === (2.4 * 7).toFixed(0) && fmtUnit(2.4, "day") === "2.4");
/* A ROUND TRIP THROUGH THE WEEKLY FIELD MUST COME BACK. The table stores a daily number whichever
 * unit was typed in, so typing 14 a week has to store exactly 2. */
is("typing 14 a week stores 2 a day", 14 / 7, 2);

console.log("\n— the sum is at full precision, and the sheet's own bug does not reproduce —");
/* THE SHEET'S 29 ROWS, one decimal each, as printed. Summed as printed they give 16.6; summed from
 * the values underneath they give the 16.7 the sheet claims. Rounding early is the whole fault. */
const PRINTED = [0.2, 0.0, 0.0, 0.2, 0.3, 2.4, 0.4, 0.3, 0.1, 0.0, 0.5, 0.0, 0.0, 0.0, 0.6, 0.1, 0.2, 0.2, 0.2, 0.7, 1.2, 0.1, 0.3, 0.0, 0.4, 2.4, 3.9, 1.2, 0.7];
const naive = +PRINTED.reduce((a, b) => a + b, 0).toFixed(1);
is("the naive one-decimal sum is the sheet's own 16.6", naive, 16.6);
/* The same rows at full precision — each one a spots/18/11 quotient rather than its printed face.
 * The sum lands above the naive one, which is the 0.1 the sheet loses. */
const FULL = [3.7, 0.1, 0.05, 4.3, 5.6, 43.6, 7.4, 5.4, 2.4, 0.6, 9.1, 0.2, 0.15, 0.1, 11.2, 2.2, 3.9, 4.1, 3.4, 13.3, 22.2, 2.1, 6.0, 0.3, 6.4, 44.0, 71.4, 22.0, 12.6]
  .map((spots) => dailyAverage(spots, 11));
const precise = FULL.reduce((a, b) => a + b, 0);
yes("summing at full precision does not lose the 0.1", +precise.toFixed(1) !== naive, `${precise.toFixed(1)} vs ${naive}`);
yes("…and rounding happens once, at the end", +precise.toFixed(1) === +(FULL.reduce((a, b) => a + b, 0)).toFixed(1));

console.log("\n— an absent target is not a zero —");
is("a row with no December goal adds nothing", sumTargets([1.5, null, 2.0, undefined]), 3.5);
is("…and the ramp has nothing to ramp to", ramp(0.5, null), [null, null, null]);
yes("a zero goal IS a goal and is summed", sumTargets([0, 1]) === 1 && ramp(0.7, 0)[2] === 0);

console.log("\n— the band is the sheet's legend, keyed on the DAILY gap —");
is("more than a match behind is red", band(1.2), "behind");
is("half to a whole is amber", band(0.6), "warn");
is("within 0.49 is green", band(0.3), "near");
is("past the goal is dark", band(-0.2), "over");
/* LEVEL IS NOT ABOVE. Two fields sit exactly on their goal and the legend puts them in "within
 * 0.49"; banding them as beating it was the first cut's error. */
is("LEVEL with the goal is within 0.49, not above", band(0), "near");
/* THE THRESHOLD MUST NOT MOVE WITH THE UNIT. Pressing Weekly multiplies the numbers by seven; a
 * band keyed on the displayed value would reclassify 0.3 (green) as 2.1 (red). */
const gaps = [-0.2, 0, 0.3, 0.6, 1.2];
is("CONTROL: the bands are identical in both units",
  gaps.map((g) => band(g)), gaps.map((g) => band(weekly(g) / 7)));
yes("…and a band keyed on the WEEKLY number would differ, which is why it is not",
  JSON.stringify(gaps.map((g) => band(g))) !== JSON.stringify(gaps.map((g) => band(weekly(g)))));

console.log("\n— the ramp is derived and follows the December it is pointed at —");
is("October and November ramp in thirds", ramp(0.2, 2.0).map((v) => +(v ?? 0).toFixed(2)), [0.8, 1.4, 2]);
const before = ramp(0.2, 2.0), after = ramp(0.2, 1.0);
yes("CONTROL: editing December moves the suggestions with it", before[0] !== after[0] && after[2] === 1);
is("a ramp from a level field is flat", ramp(0.4, 0.4).map((v) => +(v ?? 0).toFixed(2)), [0.4, 0.4, 0.4]);
is("a ramp can go DOWN when the goal is lower", ramp(0.7, 0.1).map((v) => +(v ?? 0).toFixed(2)), [0.5, 0.3, 0.1]);

console.log("\n— the days that divide —");
const now = new Date(2026, 8, 12, 10); // 12 Sep 2026
is("a finished month divides by its own length", daysElapsed(7, 2026, now), { days: 31, of: 31, partial: false });
is("the current month divides by days elapsed INCLUDING today", daysElapsed(8, 2026, now), { days: 12, of: 30, partial: true });
is("a future month has no elapsed days", daysElapsed(11, 2026, now), { days: 0, of: 31, partial: false });
yes("…so a future month has no average", dailyAverage(0, daysElapsed(11, 2026, now).days) === 0);

console.log("\n— the one match filter, which the chart and the table both read —");
const m = { field_id: 12, start_date: "2026-09-10T20:00:00+00:00", player_count: 18 };
yes("a played match counts", countsTowardGoals(m));
yes("a cancelled one does not", !countsTowardGoals({ ...m, is_cancelled: true }));
yes("one with no field cannot belong to a row", !countsTowardGoals({ ...m, field_id: null }));
/* WALL CLOCK, SLICED. start_date carries a Z it does not mean; parsing it would move a 7pm match
 * on the 30th into the next month in some zones. */
is("the month comes off the string", matchMonthIndex("2026-09-30T19:00:00+00:00"), 8);
is("…and another year is not this year's", matchMonthIndex("2025-09-30T19:00:00+00:00"), null);
is("a month key is the first of the month", monthKey(2026, 11), "2026-12-01");

console.log("\n— a row is keyed on its venue, and Warsaw is why it can be keyed on a field —");
const venueOf = new Map<number, number>([[22, 5], [1000, 5], [102, 9], [199, 9]]);
is("a venue's several fields collapse into one row", [22, 1000].map((f) => rowKeyForField(f, venueOf)), ["v5", "v5"]);
is("…and two venues stay two rows", [22, 102].map((f) => rowKeyForField(f, venueOf)), ["v5", "v9"]);
is("an unmapped field keys on itself", rowKeyForField(1684, venueOf), "f1684");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
