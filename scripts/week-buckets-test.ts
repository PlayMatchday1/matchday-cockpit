/* WEEKLY BUCKETS FOR PLAYER BEHAVIOR.
 *
 * WHAT THIS GUARDS. Two clocks that look identical and are not. A signup is a TRUE UTC INSTANT and
 * must be converted to its Chicago day; a match's start_date is LOCAL WALL CLOCK carrying a Z it
 * does not mean and must be sliced. Swapping them produces plausible numbers and wrong ones — and
 * on a WEEKLY bucket the error is ~4x what it is monthly, because a shifted day crosses a boundary
 * one time in seven rather than one in thirty.
 *
 * Measured on production, 27,029 completed users: 218 (0.81%) fall in a different MONTH under the
 * two zones; 933 (3.45%) fall in a different WEEK.
 */

import { readFileSync } from "node:fs";
import {
  weekKey, addWeeks, lastWeeks, weekEnd, weekRangeLabel, weekTick, isoDow,
  chicagoYmd, wallClockYmd, changeColumnLabel, changeColumnTitle,
} from "../src/lib/weekBuckets";
import { mondayOf } from "../src/lib/managerPayCompute";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("\nWEEKS ARE MONDAY TO SUNDAY — the definition this estate already has");
{
  is("a Tuesday resolves to its Monday", weekKey("2026-09-01"), "2026-08-31");
  is("a Monday is its own key", weekKey("2026-08-31"), "2026-08-31");
  is("the Sunday six days later is the SAME week", weekKey("2026-09-06"), "2026-08-31");
  is("…and the next Monday is a new one", weekKey("2026-09-07"), "2026-09-07");
  is("every key is a Monday", isoDow(weekKey("2026-09-04")), 1);
  is("the week closes on a Sunday", isoDow(weekEnd("2026-08-31")), 7);
  is("…which is Monday + 6", weekEnd("2026-08-31"), "2026-09-06");
  /* NOT A THIRD DEFINITION. Master Schedule and Manager Pay both snap to Monday; this must agree
   * with them on the same date or the estate has three week definitions and no way to reconcile. */
  for (const d of ["2026-09-01", "2026-09-06", "2026-09-07", "2026-01-01", "2026-12-31"]) {
    if (weekKey(d) === mondayOf(d)) ok(`  agrees with Manager Pay's mondayOf on ${d}`);
    else bad(`weekKey agrees with mondayOf on ${d}`, `${weekKey(d)} vs ${mondayOf(d)} — A THIRD WEEK DEFINITION`);
  }
  // CONTROL: mondayOf is real and returns something, so the agreement is not two nulls.
  is("  control: mondayOf actually resolves", mondayOf("2026-09-01"), "2026-08-31");
}

console.log("\n13 BUCKETS, OLDEST FIRST, ENDING WITH THE CURRENT (PARTIAL) WEEK");
{
  const ws = lastWeeks("2026-09-01", 13);
  is("  thirteen of them", ws.length, 13);
  is("  all Mondays", ws.every((w) => isoDow(w) === 1), true);
  is("  oldest first", [...ws].sort().join() === ws.join(), true);
  is("  the last is the week containing today", ws[12], weekKey("2026-09-01"));
  is("  the first is twelve weeks earlier", ws[0], addWeeks(ws[12], -12));
  is("  consecutive, no gaps", ws.every((w, i) => i === 0 || w === addWeeks(ws[i - 1], 1)), true);
  // CONTROL: a different count really changes the axis.
  is("  control: asking for 4 gives 4", lastWeeks("2026-09-01", 4).length, 4);
}

console.log("\nLABELS NAME BOTH ENDS — never a week number");
{
  is("  the range label", weekRangeLabel("2026-08-24"), "Aug 24 – Aug 30");
  is("  …across a month boundary", weekRangeLabel("2026-08-31"), "Aug 31 – Sep 6");
  is("  …across a year boundary", weekRangeLabel("2026-12-28"), "Dec 28 – Jan 3");
  is("  the short axis tick is the Monday", weekTick("2026-08-24"), "Aug 24");
  /* NO "W35" ANYWHERE. ISO week numbering disagrees with every other week numbering a reader has
   * met, and a number is a lookup they have to do in their head. */
  const LIB = readFileSync("src/lib/weekBuckets.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  is("  no week NUMBER is produced anywhere", /\bW\$\{|`W\$|"W"\s*\+/.test(LIB), false);
  is("  control: the scan fires on a template that builds one", /`W\$/.test("`W${n}`"), true);
}

console.log("\nTHE TWO CLOCKS, AND THEY ARE NOT INTERCHANGEABLE");
{
  /* THE CASE THAT PROVES IT. 03:36Z on 1 September is 22:36 on 31 August in Chicago — the exact
   * shape of the 135-vs-134 discrepancy already recorded on the membership count. */
  is("  a 03:36Z signup falls on the PREVIOUS Chicago day", chicagoYmd("2026-09-01T03:36:00Z"), "2026-08-31");
  is("  …and 14:00Z stays on its own day", chicagoYmd("2026-09-01T14:00:00Z"), "2026-09-01");
  /* A MATCH IS THE OPPOSITE. start_date is already the time at the pitch, so it is sliced. */
  is("  a match's start_date is SLICED, not converted", wallClockYmd("2026-09-01T03:36:00Z"), "2026-09-01");
  /* AND THAT DIFFERENCE IS THE WHOLE POINT: the same string gives two different days. */
  if (chicagoYmd("2026-09-01T03:36:00Z") !== wallClockYmd("2026-09-01T03:36:00Z"))
    ok("  control: the two helpers genuinely disagree on the same input — using the wrong one is silent");
  else bad("control: the two clocks differ", "IF THEY AGREED THIS WHOLE DISTINCTION WOULD BE UNTESTED");
  // A near-midnight signup crosses a WEEK boundary, not just a day.
  is("  a Monday 04:00Z signup lands in the PREVIOUS week in Chicago",
    weekKey(chicagoYmd("2026-08-31T04:00:00Z")), "2026-08-24");
  is("  …where UTC would have put it in the new one", weekKey("2026-08-31"), "2026-08-31");
  /* wallClockYmd MUST NOT CONSTRUCT A DATE — that is what re-shifts a 7pm match. */
  const LIB = readFileSync("src/lib/weekBuckets.ts", "utf8");
  const wc = LIB.slice(LIB.indexOf("export const wallClockYmd"), LIB.indexOf("export const wallClockYmd") + 160);
  is("  wallClockYmd constructs no Date", /new Date\(/.test(wc), false);
}

console.log("\nTHE CHANGE COLUMN IS RELABELLED — a WoW delta must not be headed MoM");
{
  is("  weekly reads WoW", changeColumnLabel("weekly"), "WoW");
  is("  monthly still reads MoM", changeColumnLabel("monthly"), "MoM");
  is("  …and the tooltip says which", changeColumnTitle("weekly").startsWith("Week over week"), true);
  is("  control: the monthly tooltip is different", changeColumnTitle("monthly").startsWith("Month over month"), true);
}

console.log("\nTHE ROUTE READS THE RIGHT CLOCK FOR EACH SOURCE, AND PAGES PAST THE CAP");
{
  const R = readFileSync("src/app/api/lifecycle/behavior-weekly/route.ts", "utf8");
  const code = R.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  is("  signups go through chicagoYmd", /weekKey\(chicagoYmd\(String\(u\.completed_sign_up_at\)\)\)/.test(code), true);
  is("  matches go through wallClockYmd", /weekKey\(wallClockYmd\(String\(m\.start_date\)\)\)/.test(code), true);
  is("  control: the two are NOT swapped", /chicagoYmd\(String\(m\.start_date\)\)|wallClockYmd\(String\(u\.completed_sign_up_at\)\)/.test(code), false);
  /* THE 1,000-ROW CAP. The first version chunked match ids and trusted the result — every week
   * came back with exactly 1,000 roster rows and metrics of 554, 15, 535, 45, which read as
   * seasonality and were truncation. */
  is("  the roster read pages inside each chunk", /for \(let off = 0; ; off \+= 1000\)/.test(code), true);
  is("  …with a stable order, or offset paging skips rows", /\.order\("api_id"\)\.range\(off, off \+ 999\)/.test(code), true);
  is("  …and stops on a short page", /if \(\(data \?\? \[\]\)\.length < 1000\) break;/.test(code), true);
  is("  fake players and cancelled rows are excluded", /p\.is_cancelled === true \|\| p\.user_is_fake_player === true/.test(code), true);
  is("  totalPlayers is DISTINCT people, not spots", /activeByWeek\.get\(w\).*\.add\(uid\)/.test(code) || /\.add\(uid\)/.test(code), true);
  is("  the reconciliation gap is returned, not hidden", /reconcile:/.test(code) && /monthlyTimezone: "UTC"/.test(code), true);
  is("  a failed read is an ERROR, never an empty chart", /status: 502/.test(code), true);
}

console.log("\nAND THE MONTHLY BUCKETS ARE UTC — stated where it can be checked");
{
  /* THE FACT THE WEEKLY VIEW CANNOT RECONCILE WITH. growth_registration buckets signups with
   * AT TIME ZONE 'UTC'; weekly is Chicago. This asserts the monthly definition has not silently
   * changed underneath the note that explains the gap. */
  const MIG = readFileSync("supabase/migrations/0096_growth_materialized_views.sql", "utf8");
  is("  growth_registration buckets in UTC", /AT TIME ZONE 'UTC', 'YYYY-MM'\) END AS signup_month/.test(MIG), true);
  is("  control: the scan would notice a Chicago rewrite", /America\/Chicago.*signup_month/.test(MIG), false);
  const R = readFileSync("src/app/api/lifecycle/behavior-weekly/route.ts", "utf8");
  is("  and the route says the two will not sum", /will not sum to each other/.test(R), true);
  is("  …naming BOTH reasons, not just the timezone", /weeks do not align to month boundaries/.test(R), true);
}

console.log(`\nweek-buckets: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
