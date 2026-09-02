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
  weeksInMonthRange, monthStart, monthEnd, addDays, MAX_WEEKS,
  isWeekComplete, isMonthComplete, isBucketComplete, lastTwoComplete,
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
  /* COMMENTS BLANKED FIRST — for the FIFTH time in this codebase's history, an absence scan
   * matched a comment ABOUT the thing rather than the thing. The route's `reconcile` note carries a
   * paragraph explaining that it used to say "the monthly view is UTC", and the control below,
   * reading the raw file, found that sentence and reported the stale claim was still live. A guard
   * that cannot tell code from prose about code is not a guard. */
  const R = readFileSync("src/app/api/lifecycle/behavior-weekly/route.ts", "utf8");
  /* TWO VIEWS OF THE SAME FILE, ON PURPOSE, AND THEY ARE NOT INTERCHANGEABLE. `R` is raw, for the
   * assertions that ask "is this DOCUMENTED" — those want the comments. `Rcode` is comment-blanked,
   * for the assertions that ask "is this IN THE CODE". Scanning the wrong one is how this file
   * briefly reported that a claim removed from the route was still live: the removal note quoted
   * the old sentence, and the raw scan found the quotation. */
  const Rcode = R.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
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
  /* CHANGED BY THIS TASK, DELIBERATELY. Migration 0157 moved growth_registration to Chicago, so
   * the route's note now says BOTH sides are Chicago. It used to say monthly was UTC, and leaving
   * that assertion green would have pinned a sentence the page no longer has any business saying. */
  /* A MALFORMED RANGE IS A 400, NOT A SHRUG. If the route ignored an unparseable start/end and
   * fell back to its default window, the picker would be inert again for exactly the inputs most
   * likely to be wrong, and the chart would look fine. */
  is("  a malformed month pair is rejected", /must both be YYYY-MM/.test(code), true);
  is("  …and a backwards one too", /start must not be after end/.test(code), true);
  is("  the read is bounded at BOTH ends once the window can end in the past",
    /\.lt\("completed_sign_up_at", upper\)/.test(code) && /\.lt\("start_date", upper\)/.test(code), true);
  is("  the reconciliation gap is returned, not hidden", /reconcile:/.test(code) && /monthlyTimezone: "America\/Chicago"/.test(code), true);
  is("  control: the route no longer claims monthly is UTC", /monthlyTimezone: "UTC"/.test(code), false);
  is("  a failed read is an ERROR, never an empty chart", /status: 502/.test(code), true);
}

console.log("\nAND THE MONTHLY BUCKETS ARE UTC — stated where it can be checked");
{
  /* THE FACT THE WEEKLY VIEW CANNOT RECONCILE WITH. growth_registration buckets signups with
   * AT TIME ZONE 'UTC'; weekly is Chicago. This asserts the monthly definition has not silently
   * changed underneath the note that explains the gap. */
  /* THE LIVE DEFINITION IS 0157, NOT 0096. This guard used to read 0096 and assert UTC. 0096 is
   * still on disk and still says UTC — it is history and correctly so — which is exactly why
   * pointing at it was no longer a guard: it would have gone on passing forever while describing a
   * view that had been replaced. It reads the migration that is actually in effect. */
  const MIG = readFileSync("supabase/migrations/0157_growth_registration_chicago.sql", "utf8");
  is("  growth_registration buckets in America/Chicago", /AT TIME ZONE 'America\/Chicago', 'YYYY-MM'\) END AS signup_month/.test(MIG), true);
  // CONTROL: the same scan run against the SUPERSEDED migration finds UTC — so the pattern above
  // is discriminating between the two files and not just matching any signup_month line.
  const MIG96 = readFileSync("supabase/migrations/0096_growth_materialized_views.sql", "utf8");
  is("  control: the superseded 0096 still reads UTC", /AT TIME ZONE 'UTC', 'YYYY-MM'\) END AS signup_month/.test(MIG96), true);
  is("  control: …and 0157 is not a copy of it", /AT TIME ZONE 'UTC', 'YYYY-MM'\) END AS signup_month/.test(MIG), false);
  /* COMMENTS BLANKED FIRST — for the FIFTH time in this codebase's history, an absence scan
   * matched a comment ABOUT the thing rather than the thing. The route's `reconcile` note carries a
   * paragraph explaining that it used to say "the monthly view is UTC", and the control below,
   * reading the raw file, found that sentence and reported the stale claim was still live. A guard
   * that cannot tell code from prose about code is not a guard. */
  const R = readFileSync("src/app/api/lifecycle/behavior-weekly/route.ts", "utf8");
  /* TWO VIEWS OF THE SAME FILE, ON PURPOSE, AND THEY ARE NOT INTERCHANGEABLE. `R` is raw, for the
   * assertions that ask "is this DOCUMENTED" — those want the comments. `Rcode` is comment-blanked,
   * for the assertions that ask "is this IN THE CODE". Scanning the wrong one is how this file
   * briefly reported that a claim removed from the route was still live: the removal note quoted
   * the old sentence, and the raw scan found the quotation. */
  const Rcode = R.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  is("  and the route says the two will not sum", /will not sum to /.test(Rcode) && /each other/.test(Rcode), true);
  /* THE SURVIVING REASON, AND ONLY IT. Timezone was reason 1 and is now resolved; weeks not
   * aligning to months is calendar arithmetic and is permanent. The note must still carry it. */
  is("  …naming the reason that survives 0157", /belongs wholly to neither month/.test(Rcode), true);
  is("  control: the note no longer blames the timezone", /monthly view is UTC/.test(Rcode), false);
  // CONTROL FOR THE BLANKING ITSELF: an absence that only holds because the scan is empty is not
  // an absence. The stripped source must still contain the note it is being scanned for.
  is("  control: the stripped source still has the reconcile note", /monthlyTimezone/.test(Rcode), true);
  is("  control: …and the comment really was removed", /UPDATED FOR MIGRATION 0157/.test(Rcode), false);
}

console.log("\nTHE PANEL TOGGLE — monthly untouched, weekly normalised into the same shape");
{
  const P = readFileSync("src/components/growth/BehaviorPanel.tsx", "utf8");
  const code = P.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  is("  monthly is the default", /useState<Granularity>\("monthly"\)/.test(code), true);
  is("  the toggle renders both options", /data-testid="behavior-gran-monthly"/.test(code) && /data-testid="behavior-gran-weekly"/.test(code), true);
  is("  the selection is persisted", /localStorage\.setItem\(BEHAVIOR_GRAN_KEY/.test(code), true);
  is("  …and read back on mount", /localStorage\.getItem\(BEHAVIOR_GRAN_KEY\)/.test(code), true);
  /* THE PICKER IS WIRED. This used to assert `const WEEKS = 13` — the constant that MADE the
   * period picker inert. The constant is gone and the request now carries the picker's range. */
  is("  weekly asks for the SELECTED PERIOD, not a fixed window",
    /behavior-weekly\?start=\$\{encodeURIComponent\(period\.start\)\}&end=\$\{encodeURIComponent\(period\.end\)\}/.test(code), true);
  is("  control: the fixed 13-week constant is gone", /const WEEKS = 13/.test(code), false);
  is("  …and the fetch re-runs when the window changes", /\[gran, winKey, period\.start, period\.end\]/.test(code), true);
  /* THE STALE-CHART GUARD. Without the clear, the previous window's bars stay on screen under the
   * new window's caption while the new read is in flight, and nothing on the page says so. */
  is("  …clearing the old window's data first", /setWeekly\(null\); setWeeklyErr\(null\);/.test(code), true);
  is("  the window is cached so a pill round-trip does not refetch", /weeklyCache\.current\.get\(winKey\)/.test(code), true);
  is("  the count's UNIT follows the granularity", /gran === "weekly" \? "week" : "month"/.test(code), true);
  is("  a capped window says how many weeks it dropped", /not shown \(53-week maximum\)/.test(code), true);

  /* THE WHOLE DESIGN IN ONE ASSERTION. Weekly is normalised to the monthly point shape — `w`
   * becomes `m` — so every downstream consumer is untouched. If this stops being true the panel
   * has grown a second code path and monthly is no longer guaranteed unchanged. */
  is("  weekly wears the monthly shape (w -> m)", /m: p\.w, registrations: p\.registrations/.test(code), true);
  is("  …and monthly resolves to exactly the old expression",
    /data\.behaviorOverall\.map\(\(p\) => p\.m\)\.filter\(\(m\) => m >= period\.start && m <= period\.end\)/.test(code), true);
  is("  the source switches, the consumers do not",
    /const src = gran === "weekly" && weeklyData \? weeklyData : data;/.test(code), true);
  // CONTROL: no consumer still reads the raw monthly maps directly, which would ignore the toggle.
  is("  control: nothing reads data.behaviorByCity/ByField any more", /data\.behaviorBy(City|Field)\[/.test(code), false);
  is("  control: …and networkSeries is fed src", /networkSeries\(src,/.test(code), true);

  console.log("  -- labels and the change column --");
  is("  the change column relabels", /Latest \{changeColumnLabel\(gran\)\}/.test(code), true);
  is("  …in the CSV header too", /`Latest \$\{changeColumnLabel\(gran\)\}`/.test(code), true);
  /* CHANGED DELIBERATELY. The tooltip used to be the generic changeColumnTitle; it now NAMES the
   * two buckets compared, which is what stops a partial week hiding inside the badge again.
   * changeColumnTitle is still the monthly branch of cmpTitle. */
  is("  …with a tooltip saying which", /title=\{cmpTitle\}/.test(code), true);
  /* CHANGED DELIBERATELY. The tooltip used to name its pair only in weekly and fall back to the
   * generic changeColumnTitle for monthly — which was consistent with monthly having no partial
   * buckets to exclude. Monthly now has both, so it names its pair too. */
  is("  …and the tooltip names the actual pair", /against \$\{bucketLabel\(months\[cmp\.prev\], gran\)\}/.test(code), true);
  is("  control: the generic monthly fallback is gone", /: changeColumnTitle\(gran\)\)/.test(code), false);
  is("  …and BOTH granularities get a named pair", /\$\{gran === "weekly" \? "Week over week" : "Month over month"\}/.test(code), true);
  is("  bucket labels follow the granularity", /const bucketLabel = \(k: string, g: Granularity\)/.test(code), true);
  is("  …and the chart axis uses the short form", /bucketTick\(m, gran\)/.test(code), true);
  is("  the range caption follows too", /gran === "weekly"\s*\?\s*`\$\{weekTick\(months\[0\]\)\}/.test(code), true);

  console.log("  -- city and field detail follow the granularity --");
  is("  the city list reads src", /Object\.keys\(src\.behaviorByCity\)/.test(code), true);
  is("  the field list reads src", /Object\.keys\(src\.behaviorByField\)/.test(code), true);
  is("  the model recomputes on a granularity change", /\[cityMode, fieldMode, detailMode, src, months, cities, fields, selectedFields, usingDefault, metric, gran, weekly, complete, cmp\]/.test(code), true);
  // A failed weekly fetch must be an error, not an empty chart.
  is("  a failed weekly fetch is an ERROR", /this is not an empty chart/.test(P), true);
  is("  …and loading says so", /data-testid="behavior-weekly-loading"/.test(code), true);
}

console.log("\nTHE FIELD BREAKDOWN IS IN THE ROUTE, AND REGISTRATIONS ARE NOT FAKED PER FIELD");
{
  /* COMMENTS BLANKED FIRST — for the FIFTH time in this codebase's history, an absence scan
   * matched a comment ABOUT the thing rather than the thing. The route's `reconcile` note carries a
   * paragraph explaining that it used to say "the monthly view is UTC", and the control below,
   * reading the raw file, found that sentence and reported the stale claim was still live. A guard
   * that cannot tell code from prose about code is not a guard. */
  const R = readFileSync("src/app/api/lifecycle/behavior-weekly/route.ts", "utf8");
  /* TWO VIEWS OF THE SAME FILE, ON PURPOSE, AND THEY ARE NOT INTERCHANGEABLE. `R` is raw, for the
   * assertions that ask "is this DOCUMENTED" — those want the comments. `Rcode` is comment-blanked,
   * for the assertions that ask "is this IN THE CODE". Scanning the wrong one is how this file
   * briefly reported that a claim removed from the route was still live: the removal note quoted
   * the old sentence, and the raw scan found the quotation. */
  const Rcode = R.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const code = R.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  is("  byField is returned", /byField,/.test(code), true);
  is("  …keyed on field_title", /matchField\.set\(Number\(m\.api_id\), String\(m\.field_title/.test(code), true);
  is("  …with the same three play metrics", /newPlayers: newByWeekField/.test(code) && /totalPlayers: activeByWeekField/.test(code) && /spots: spotsByWeekField/.test(code), true);
  /* A REGISTRATION HAS NO FIELD. It carries the city declared at signup and nobody registers at a
   * pitch, so a per-field registration figure would be invented. The monthly path says the same. */
  is("  registrations are NOT broken out per field", /registrations: 0,/.test(code), true);
  is("  …and the reason is written down", /never a pitch/.test(R), true);
}

console.log("\nTHE MONTHLY BUCKETS ARE CHICAGO NOW — one clock across the page");
{
  const MIG = readFileSync("supabase/migrations/0157_growth_registration_chicago.sql", "utf8");
  is("  0157 moves signup_month to America/Chicago", /AT TIME ZONE 'America\/Chicago', 'YYYY-MM'\) END AS signup_month/.test(MIG), true);
  is("  …and recreates the UNIQUE index REFRESH CONCURRENTLY needs",
    /CREATE UNIQUE INDEX growth_registration_pk/.test(MIG), true);
  is("  …and the second index too", /CREATE INDEX growth_registration_signup/.test(MIG), true);
  // CONTROL: it is a DROP + CREATE, because a materialized view cannot be replaced in place.
  is("  control: it drops first, as a materialized view requires", /DROP MATERIALIZED VIEW IF EXISTS/.test(MIG), true);
  const FACTS = readFileSync("docs/matchday-api-facts.md", "utf8");
  is("  the snapshots divergence is on the record", /TWO CLOCKS IN THE ESTATE, ON PURPOSE/.test(FACTS), true);
  is("  …naming members_monthly_snapshots as the UTC side", /members_monthly_snapshots.*stays UTC|stays \*\*UTC\*\*/.test(FACTS), true);
}

console.log("\nTHE PERIOD PICKER DRIVES THE WEEKLY WINDOW — the picker used to be inert here");
{
  is("monthStart is the first of the month", monthStart("2026-03"), "2026-03-01");
  is("monthEnd finds 31 where there are 31", monthEnd("2026-03"), "2026-03-31");
  is("monthEnd finds 30 where there are 30", monthEnd("2026-04"), "2026-04-30");
  is("monthEnd handles February", monthEnd("2026-02"), "2026-02-28");
  // THE LEAP YEAR. 2028 is one; getting this wrong drops a day off the axis once every four years.
  is("monthEnd handles a leap February", monthEnd("2028-02"), "2028-02-29");
  is("monthEnd handles December, where the year rolls", monthEnd("2026-12"), "2026-12-31");
  is("addDays crosses a month boundary", addDays("2026-08-31", 2), "2026-09-02");

  /* THE HEADLINE CLAIM: a 3-month period is about 13 weeks and a 6-month period about 26. "About"
   * is the point — these are DERIVED from the calendar, not assumed, because months are not four
   * weeks long and pinning the number is the mistake verify-pace-readout made. */
  const q3 = weeksInMonthRange("2026-06", "2026-08");
  const q6 = weeksInMonthRange("2026-03", "2026-08");
  const q12 = weeksInMonthRange("2025-09", "2026-08");
  is("a 3-month period yields 13 or 14 weeks", q3.axis.length >= 13 && q3.axis.length <= 14, true);
  is("a 6-month period yields 26 or 27 weeks", q6.axis.length >= 26 && q6.axis.length <= 27, true);
  is("a 12-month period yields 52 or 53 weeks", q12.axis.length >= 52 && q12.axis.length <= 53, true);
  /* CONTROL FOR ALL THREE: the counts must DIFFER. If weeksInMonthRange ignored its arguments and
   * returned a constant, every range above would still be "a number of weeks" and every assertion
   * that only checked a range could pass. This is the assertion that the window actually moves. */
  is("  control: the three windows are different lengths", new Set([q3.axis.length, q6.axis.length, q12.axis.length]).size, 3);
  is("  control: and different starts", new Set([q3.axis[0], q6.axis[0], q12.axis[0]]).size, 3);

  // EVERY KEY IS A MONDAY, and every one is inside the range. The rule the caption states.
  is("every key is a Monday", q6.axis.every((w) => isoDow(w) === 1), true);
  is("every Monday is inside the month range", q6.axis.every((w) => w >= "2026-03-01" && w <= "2026-08-31"), true);
  is("  …the first is the first Monday on or after the 1st", q6.axis[0], "2026-03-02");
  is("  …the last is the last Monday on or before the 31st", q6.axis[q6.axis.length - 1], "2026-08-31");
  /* CONTROL: 2026-03-01 is a SUNDAY, so the first Monday is the 2nd and NOT the 1st. If the code
   * had used weekKey(lo) without stepping forward it would have returned 2026-02-23 — a Monday in
   * FEBRUARY, outside the period the picker selected. That is the specific bug this pins. */
  is("  control: March 1 2026 is indeed a Sunday", isoDow("2026-03-01"), 7);
  is("  control: the axis does NOT reach back into February", q6.axis.includes("2026-02-23"), false);
  // …and the opposite case: a period starting ON a Monday keeps that Monday.
  const onMon = weeksInMonthRange("2026-06", "2026-06");
  is("  control: June 1 2026 is a Monday", isoDow("2026-06-01"), 1);
  is("  …and a period starting on a Monday keeps it", onMon.axis[0], "2026-06-01");

  is("the axis is sorted oldest first", q6.axis.slice().sort().join() === q6.axis.join(), true);
  is("the axis has no duplicates", new Set(q6.axis).size, q6.axis.length);
  is("consecutive keys are exactly 7 days apart",
    q6.axis.every((w, i) => i === 0 || addWeeks(q6.axis[i - 1], 1) === w), true);

  /* THE CEILING IS ANNOUNCED, NOT APPLIED SILENTLY. A silent truncation reads as "this is the
   * whole period"; the caller renders `dropped`. */
  const long = weeksInMonthRange("2023-01", "2026-08");
  is("a very long period is capped at MAX_WEEKS", long.axis.length, MAX_WEEKS);
  is("  …and says how many it dropped", long.dropped > 0, true);
  is("  …keeping the MOST RECENT weeks, not the oldest", long.axis[long.axis.length - 1], q12.axis[q12.axis.length - 1]);
  // CONTROL: a period that fits reports dropped 0, so `dropped > 0` above is not vacuously true.
  is("  control: a period that fits drops nothing", q6.dropped, 0);
  is("  control: …and q3 too", q3.dropped, 0);

  // A ONE-MONTH PERIOD IS THE FLOOR THE PICKER ALLOWS, and it must never come back empty.
  for (const ym of ["2026-01", "2026-02", "2026-09", "2028-02"]) {
    const r = weeksInMonthRange(ym, ym);
    is(`a single month (${ym}) yields 4 or 5 weeks`, r.axis.length >= 4 && r.axis.length <= 5, true);
  }
}

console.log("\nA PARTIAL WEEK IS NOT A COLLAPSE — the change compares COMPLETE buckets only");
{
  /* THE DEFECT, IN ONE LINE. On 2026-09-01 the last bucket was Aug 31 – Sep 6 with ONE day in it,
   * and "Latest WoW" compared it against a whole week: -68.4%, -58.6%, -46.6%, -56.0%, -44.4%. */
  is("the week containing today is NOT complete", isWeekComplete("2026-08-31", "2026-09-01"), false);
  is("  …nor on its final day", isWeekComplete("2026-08-31", "2026-09-06"), false);
  is("  …and becomes complete the day after its Sunday", isWeekComplete("2026-08-31", "2026-09-07"), true);
  is("a week wholly in the past is complete", isWeekComplete("2026-08-24", "2026-09-01"), true);
  // CONTROL: the test is the CALENDAR, not the data. A quiet week is still a complete week, and a
  // rule that skipped low weeks would hide the real collapses this column exists to show.
  is("  control: completeness does not depend on any value", isWeekComplete("2026-08-24", "2026-09-01"), isWeekComplete("2026-08-24", "2099-01-01"));
  is("  control: a FUTURE week is not complete either", isWeekComplete("2026-09-14", "2026-09-01"), false);

  /* THE PAIR THE CHANGE COLUMN USES. Indices into the axis, newest first. */
  is("the last two complete buckets are picked", lastTwoComplete([true, true, true, false]), { last: 2, prev: 1 });
  is("  …skipping a partial in the middle too", lastTwoComplete([true, true, false, true]), { last: 3, prev: 1 });
  is("  …and using the last two when nothing is partial", lastTwoComplete([true, true, true]), { last: 2, prev: 1 });
  /* NOT ENOUGH IS null, NOT ZERO. A change reported as 0% reads as "nothing moved"; the honest
   * answer when there is nothing to compare is that there is no answer. */
  is("one complete bucket yields NO pair", lastTwoComplete([false, true]), null);
  is("  …and none at all yields no pair", lastTwoComplete([false, false]), null);
  is("  …and an empty axis yields no pair", lastTwoComplete([]), null);
  // CONTROL: the two indices are always distinct and ordered, or the change compares a bucket
  // with itself and reports 0% forever.
  const pr = lastTwoComplete([true, false, true, true, false]);
  is("  control: prev is strictly older than last", pr !== null && pr.prev < pr.last, true);
  is("  control: …and it skipped the partials", pr, { last: 3, prev: 2 });

  /* THE REAL SHAPE, END TO END. 27 weeks Mar 2 – Aug 31 with today = 2026-09-01: the axis ends on
   * the partial Aug 31, so the comparison must be Aug 24 against Aug 17. Measured in the browser
   * as exactly that pair. */
  const axis = weeksInMonthRange("2026-03", "2026-08").axis;
  const comp = axis.map((w) => isWeekComplete(w, "2026-09-01"));
  is("  the real axis is 27 weeks", axis.length, 27);
  is("  …of which exactly one is incomplete", comp.filter((c) => !c).length, 1);
  is("  …and it is the last", comp[comp.length - 1], false);
  const pair = lastTwoComplete(comp);
  is("  the change compares Aug 24 against Aug 17",
    [axis[pair.prev], axis[pair.last]], ["2026-08-17", "2026-08-24"]);
  // CONTROL: it is NOT comparing the partial week, which is what produced -68.4%.
  is("  control: the partial week is not either end of the pair",
    [pair.last, pair.prev].includes(axis.length - 1), false);
}

console.log("\nTHE WEEKLY PANEL AND ROUTE — the wiring behind the browser suite");
{
  const raw = readFileSync("src/components/growth/BehaviorPanel.tsx", "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const rt = readFileSync("src/app/api/lifecycle/behavior-weekly/route.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  is("  the change reads the complete pair, not the last two cells", /const li = cmp \? cmp\.last : cells\.length - 1;/.test(code), true);
  /* BOTH CHANGE SITES, NOT ONE. The CSV export computes its own change for the detail rows and
   * had the identical defect — it is only visible in a downloaded file, which is exactly the kind
   * of place a wrong number survives. This absence scan is what found it. */
  is("  control: NO unconditional last-two survives anywhere in the file",
    /const last = cells\[cells\.length - 1\] \?\? 0;\s*const prev = cells\[cells\.length - 2\]/.test(code), false);
  is("  the CSV's detail rows use the same complete pair", (code.match(/const li = cmp \? cmp\.last/g) ?? []).length, 2);
  is("  …and the CSV header names the pair", /Latest \$\{changeColumnLabel\(gran\)\} \(\$\{cmpSub\}\)/.test(code), true);
  is("  the table header is the BUCKET, not its month", /<th key=\{m\} data-testid="behavior-col-head"/.test(code) && /\{bucketLabel\(m, gran\)\}/.test(code), true);
  is("  control: the header no longer calls monthLabel unconditionally", /<th key=\{m\}>\{monthLabel\(m\)\}<\/th>/.test(code), false);
  is("  completeness is judged in the payload's clock, not the browser's",
    /weekly\?\.window\?\.today \?\? chicagoToday\(\)/.test(code), true);
  /* THE OPPOSITE OF WHAT THIS ONCE PINNED. It asserted that monthly treated every bucket as
   * complete — correct at the time, and flagged in that same commit as a known gap. The gap is
   * closed; the assertion is inverted rather than deleted so the old behaviour cannot return. */
  is("  MONTHLY NOW OBEYS THE SAME RULE", /months\.map\(\(m\) => isBucketComplete\(m, todayYmd, gran\)\)/.test(code), true);
  is("  control: the hardcoded all-complete monthly branch is gone",
    /months\.map\(\(\) => true\)/.test(code), false);
  is("  the end-of-line series labels are gone", /serieslab/.test(raw), false);
  is("  …replaced by a legend", /data-testid="behavior-legend"/.test(code), true);
  is("  the axis is thinned from the NEWEST bucket backwards", /\(months\.length - 1 - i\) % every === 0/.test(code), true);
  is("  …by a step derived from label width, not pinned", /Math\.ceil\(\(months\.length \* LABEL_W\) \/ Math\.max\(1, IW\)\)/.test(code), true);
  is("  the partial tail is dashed", /strokeDasharray="5 4"/.test(code), true);
  is("  hover is wired", /onMouseMove=\{onMove\}/.test(code) && /data-testid="behavior-tooltip"/.test(code), true);

  is("  the route drops weeks that have not started", /full\.filter\(\(w\) => w <= today\)/.test(rt), true);
  is("  …and reports how many", /futureDropped/.test(rt), true);
  is("  …and refuses an entirely future period rather than drawing nothing",
    /entirely in the future/.test(rt), true);
  is("  today travels with the payload", /dropped: ranged\?\.dropped \?\? 0, futureDropped, today,/.test(rt), true);

  const CSS = readFileSync("src/components/growth/playerBehavior.module.css", "utf8");
  is("  the name column is sticky, which is the 'missing labels' fix", /position: sticky; left: 0;/.test(CSS), true);
  is("  …with a solid background, or the columns slide under it", /position: sticky; left: 0; z-index: 2; background: var\(--surface\);/.test(CSS), true);
  is("  gridlines match MembershipActiveChart", /\.gl \{ stroke: #003326; stroke-opacity: 0\.08; stroke-width: 1; \}/.test(CSS), true);
  const REF = readFileSync("src/components/MembershipActiveChart.tsx", "utf8");
  is("  control: …which is genuinely what that chart uses",
    /stroke="#003326"/.test(REF) && /strokeOpacity=\{0\.08\}/.test(REF), true);
  is("  the plot has a baseline", /\.baseline \{ stroke: #003326;/.test(CSS), true);
}

console.log("\nONE CITY VOCABULARY — the weekly path used to group on two");
{
  const rt = readFileSync("src/app/api/lifecycle/behavior-weekly/route.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const gv = readFileSync("src/lib/growthFromViews.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const panel = readFileSync("src/components/growth/BehaviorPanel.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /* THE CAUSE. Registrations were keyed on the RAW preferable_city_name and play on
   * cityFromAbbr(city_identifier) — "Dallas / Fort Worth" against "Dallas", "Oklahoma City"
   * against "OKC" — so 1,802 of 9,482 registrations belonged to no listed row. */
  is("  weekly registrations are NORMALISED, not raw", /normalizeDeclared\(u\.preferable_city_name/.test(rt), true);
  is("  control: the raw grouping is gone", /String\(u\.preferable_city_name \?\? ""\)\.trim\(\)/.test(rt), false);
  is("  weekly play uses normalizeMatchCity", /normalizeMatchCity\(String\(m\.city_identifier/.test(rt), true);
  /* cityFromAbbr IS NOT INTERCHANGEABLE with normalizeMatchCity. It is a second, older map that
   * never received Warsaw and returns null for an unknown code where normalizeMatchCity falls back
   * to the code. That difference alone dropped 85 Warsaw spots and hid the city entirely. */
  is("  control: cityFromAbbr is no longer called in this route", /cityFromAbbr\(/.test(rt), false);
  const cityMap = readFileSync("src/lib/cityMap.ts", "utf8");
  const sched = readFileSync("src/lib/scheduleReconcile.ts", "utf8");
  is("  control: cityFromAbbr's map genuinely still lacks Warsaw", /WAW/.test(cityMap), false);
  is("  control: …while normalizeMatchCity's map has it", /WAW: "Warsaw"/.test(sched), true);
  is("  control: …which is why the two are not interchangeable",
    /return CITY_ABBR_TO_COCKPIT\[trimmed\] \?\? null;/.test(cityMap), true);

  // BOTH PATHS USE THE SAME TWO NORMALISERS, or the vocabularies drift apart again.
  is("  monthly uses the same declared normaliser", /normalizeDeclared\(u\.declared_city_raw\)/.test(gv), true);

  /* A REGISTRATION WITH NO CITY IS A ROW, NOT A DROP. Both paths had `if (city)` and both were
   * therefore short by construction. 0 rows land here today, which is the only reason nobody had
   * seen it — the branch exists so the sum is a guarantee rather than a coincidence. */
  is("  weekly buckets the city-less into Unassigned", /\?\? UNASSIGNED_CITY;/.test(rt), true);
  is("  monthly does too", /normalizeDeclared\(u\.declared_city_raw\) \?\? UNASSIGNED_CITY/.test(gv), true);
  is("  control: monthly no longer drops them", /const city = normalizeDeclared\(u\.declared_city_raw\); if \(city\) inc2/.test(gv), false);
  is("  …and the monthly city INDEX knows about the bucket, or the row is computed and never shown",
    /declaredCitySet\.add\(normalizeDeclared\(u\.declared_city_raw\) \?\? UNASSIGNED_CITY\)/.test(gv), true);

  /* THE DISPLAY HALF. The panel listed only cities with spots > 0, so New York City (102) and
   * El Paso (90) — registrations, no pitch — were computed, returned, and dropped on the way to
   * the screen. That is what made MONTHLY short too: 9,269 against 9,460. */
  is("  the city list qualifies on ANY metric, not spots alone",
    /\(p\.spots \?\? 0\) > 0 \|\| \(p\.registrations \?\? 0\) > 0/.test(panel), true);
  /* SCOPED TO THE CITY LIST, not to "any spots-only filter anywhere". The first version of this
   * control matched the FIELD list, which filters on spots legitimately — a pitch with no spots is
   * not a pitch anyone played at, and Field Detail carries no registrations to lose. A control
   * that fires on the wrong subject is not a control. */
  is("  control: the spots-only CITY filter is gone",
    /behaviorByCity\[c\]\.some\(\(p\) => inPeriod\.has\(p\.m\) && \(p\.spots \?\? 0\) > 0\)/.test(panel), false);
  is("  control: …while the FIELD list still filters on spots, deliberately",
    /behaviorByField\[f\]\.points\.some\(\(p\) => inPeriod\.has\(p\.m\) && \(p\.spots \?\? 0\) > 0\)/.test(panel), true);
  is("  Unassigned sorts last, being a residual and not a market", /a === UNASSIGNED_CITY \? 1 :/.test(panel), true);

  const ga = readFileSync("src/lib/growthAnalytics.ts", "utf8");
  is("  UNASSIGNED_CITY is defined once", (ga.match(/export const UNASSIGNED_CITY/g) ?? []).length, 1);
  /* IT IS NOT UNKNOWN_CITY. That bucket means "carried a city we could not map" on the revenue and
   * play axes; this one means "the player never told us". Folding them makes a row nobody can act
   * on — you would not know whether to fix a mapping or chase a signup form. */
  is("  control: …and is distinct from UNKNOWN_CITY", /export const UNKNOWN_CITY = "Unknown city";/.test(ga), true);
  is("  control: …with different values", /UNASSIGNED_CITY = "Unassigned"/.test(ga), true);
}

console.log("\nFIELD DETAIL'S PICKER — nothing selected must not mean draw everything");
{
  const panel = readFileSync("src/components/growth/BehaviorPanel.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /* THE STATE MACHINE. `null` means "I have not chosen" and re-derives the default; a Set is the
   * operator's own choice. Collapsing the two — an empty Set for "no choice" — is what makes Clear
   * produce an empty chart, and an empty chart is indistinguishable from a broken one. */
  is("  the selection is Set | null, not just a Set", /useState<Set<string> \| null>\(null\)/.test(panel), true);
  is("  null draws the DEFAULT, never every field", /if \(fieldSel === null\) return defaultFields;/.test(panel), true);
  is("  control: the series map is over the SELECTION, not over `fields`",
    /series = selectedFields\.map\(\(f, k\) =>/.test(panel), true);
  is("  control: …the old all-fields map is gone", /series = fields\.map\(\(f, k\) =>/.test(panel), false);
  is("  an empty stored selection falls back to the default rather than an empty chart",
    /return live\.length \? live\.slice\(0, FIELD_MAX\) : defaultFields;/.test(panel), true);
  is("  …and taking the last chip off returns to the default too",
    /return base\.size === 0 \? null : base;/.test(panel), true);
  is("  Clear goes back to null, i.e. to the default five", /setFieldQuery\(""\); setFieldSel\(null\);/.test(panel), true);

  /* THE DEFAULT IS RANKED BY THE FIGURE THE TABLE ALREADY SHOWS — a sum for a count, the latest
   * value for a rate. A second definition of "biggest" would put five fields on the chart that are
   * not the five largest rows beneath it, and nobody could check it by looking. */
  is("  the ranking matches the table's period figure", /rate \? \(cells\[cells\.length - 1\] \?\? 0\) : cells\.reduce\(\(a, b\) => a \+ b, 0\)/.test(panel), true);
  is("  …tie-broken by name, so the default is stable across reloads", /b\.score - a\.score \|\| a\.f\.localeCompare\(b\.f\)/.test(panel), true);

  is("  the cap is 8 and is a named constant", /const FIELD_MAX = 8;/.test(panel), true);
  is("  …enforced on add", /if \(base\.size >= FIELD_MAX\) \{ setCapHit\(true\); return prev; \}/.test(panel), true);
  is("  …and explained on the control rather than swallowed", /data-testid="behavior-field-cap"/.test(panel), true);
  /* THE PALETTE IS NOT THE CONSTRAINT — the eye is. 8 < 12 means no two selected fields can share
   * a colour, which is the property the cap has to preserve. */
  const colors = (panel.match(/const FIELD_COLORS = \[[^\]]*\]/s) ?? [""])[0];
  is("  control: the palette has more entries than the cap", (colors.match(/#/g) ?? []).length >= 8, true);

  is("  search filters the CHIPS", /visibleGroups/.test(panel) && /fieldQuery/.test(panel), true);
  is("  control: …and never the selection", /const visibleGroups[\s\S]{0,400}?setFieldSel/.test(panel), false);
  is("  the chips are grouped by city", /data-testid="behavior-field-group"/.test(panel), true);
  is("  …in the City Detail order", /const order = \[\.\.\.cities,/.test(panel), true);
  is("  …with an Unassigned group rather than a drop", /src\.behaviorByField\[f\]\?\.city\?\.trim\(\) \|\| UNASSIGNED_CITY/.test(panel), true);
  is("  the selection is persisted", /localStorage\.setItem\(BEHAVIOR_FIELDS_KEY/.test(panel), true);
  is("  …and read back on mount", /localStorage\.getItem\(BEHAVIOR_FIELDS_KEY\)/.test(panel), true);
  is("  control: an empty persisted array is NOT restored as an empty selection",
    /Array\.isArray\(arr\) && arr\.length > 0/.test(panel), true);
  is("  the CSV follows the selection too", /const scopes = fieldMode \? selectedFields : cities;/.test(panel), true);

  /* CITY DETAIL IS UNTOUCHED — 8 series there is fine and was explicitly out of scope. */
  is("  control: City Detail still maps over every city", /series = cities\.map\(\(c\) =>/.test(panel), true);
  is("  control: …and has no picker of its own", /fieldMode \? \(\s*<div className=\{styles\.fieldPicker\}/.test(panel), true);
}

console.log("\nA PARTIAL MONTH IS NOT A COLLAPSE EITHER — the same rule, on the other bucket");
{
  is("the current month is NOT complete", isMonthComplete("2026-09", "2026-09-02"), false);
  is("  …nor on its last day", isMonthComplete("2026-09", "2026-09-30"), false);
  is("  …and becomes complete the day after", isMonthComplete("2026-09", "2026-10-01"), true);
  is("a past month is complete", isMonthComplete("2026-08", "2026-09-02"), true);
  is("  …a future month is not", isMonthComplete("2026-12", "2026-09-02"), false);
  // MONTH LENGTHS ARE NOT ASSUMED — monthEnd does the calendar, including February and leap years.
  is("February is complete on March 1", isMonthComplete("2026-02", "2026-03-01"), true);
  is("  …and not on Feb 28", isMonthComplete("2026-02", "2026-02-28"), false);
  is("a leap February is not complete on the 29th", isMonthComplete("2028-02", "2028-02-29"), false);
  is("  …and is on March 1", isMonthComplete("2028-02", "2028-03-01"), true);
  is("December rolls the year", isMonthComplete("2026-12", "2027-01-01"), true);
  /* CONTROL: it is not returning a constant. The old code was literally `() => true` for every
   * month, which satisfies every "a past month is complete" assertion above on its own. */
  is("  control: it returns both answers", new Set([
    isMonthComplete("2026-08", "2026-09-02"), isMonthComplete("2026-09", "2026-09-02")]).size, 2);

  /* ONE PREDICATE FOR BOTH BUCKETS, so the two granularities cannot drift apart again. */
  is("isBucketComplete routes weekly", isBucketComplete("2026-08-31", "2026-09-02", "weekly"), isWeekComplete("2026-08-31", "2026-09-02"));
  is("  …and monthly", isBucketComplete("2026-09", "2026-09-02", "monthly"), isMonthComplete("2026-09", "2026-09-02"));
  // CONTROL: the two branches genuinely differ, or the routing is untested.
  is("  control: the same date answers differently per granularity",
    isBucketComplete("2026-08", "2026-09-02", "monthly"), true);
  is("  control: …while the week containing it does not", isBucketComplete("2026-08-31", "2026-09-02", "weekly"), false);

  /* END TO END on the shape that exposed it: a hand-picked range ending in the current month. */
  const axis = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
  const comp = axis.map((m) => isMonthComplete(m, "2026-09-02"));
  is("  five of six months are complete", comp.filter(Boolean).length, 5);
  const pair = lastTwoComplete(comp);
  is("  the change compares Aug against Jul", [axis[pair.prev], axis[pair.last]], ["2026-07", "2026-08"]);
  is("  control: the partial month is neither end", [pair.last, pair.prev].includes(5), false);
}

console.log("\nEVERY MONTHLY-BUCKET CALL SITE — changed, or already handled");
{
  const panel = readFileSync("src/components/growth/BehaviorPanel.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // ── CHANGED 1: Player Behavior.
  is("  Behavior applies completeness to BOTH granularities",
    /months\.map\(\(m\) => isBucketComplete\(m, todayYmd, gran\)\)/.test(panel), true);
  is("  control: monthly is no longer hardcoded complete", /months\.map\(\(\) => true\)/.test(panel), false);
  is("  the partial column tag is not weekly-only", /data-partial=\{!complete\[i\] \? "1" : "0"\}/.test(panel), true);
  is("  control: …the weekly gate on it is gone", /gran === "weekly" && !complete\[i\]/.test(panel), false);
  is("  the legend note is not weekly-only", /\{partialIdx >= 0 && \(/.test(panel), true);
  is("  the axis note names the right unit", /gran === "weekly" \? "partial week" : "partial month"/.test(panel), true);
  is("  the tooltip badge is not weekly-only", /\{!complete\[hoverIdx\] && <span/.test(panel), true);
  is("  the change tooltip names both buckets in either granularity", /Both are COMPLETE \$\{bucketUnit\}s/.test(panel), true);

  /* ── THE EXPORT, WHICH IS THE ONE THAT WAS MISSED LAST TIME ───────────────────────────────────
   * Three separate things have to be true of the file, and the third is the one nobody checks. */
  is("  the CSV labels the partial column", /complete\[i\] \? bucketLabel\(k, gran\) : `\$\{bucketLabel\(k, gran\)\} \(partial\)`/.test(panel), true);
  is("  the CSV header names the compared pair", /Latest \$\{changeColumnLabel\(gran\)\} \(\$\{cmpSub\}\)/.test(panel), true);
  is("  BOTH change sites read the same complete pair", (panel.match(/const li = cmp \? cmp\.last/g) ?? []).length, 2);
  is("  control: no unconditional last-two survives",
    /const li = cells\.length - 1;\s*const pi = cells\.length - 2;/.test(panel), false);

  // ── CHANGED 2: the membership churn tile, a STOCK asked about a future date.
  const memb = readFileSync("src/app/api/membership/route.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  is("  the churn 'as of' instant is clamped to now", /const endOfNewest = projected > nowIso \? nowIso : projected;/.test(memb), true);
  is("  control: it no longer projects to a future month end", /const endOfNewest = monthEndIso\(newest\);/.test(memb), false);
  is("  …and the PRIOR month end is left alone, being a real one", /const endOfPrior = monthEndIso\(months\[months\.length - 2\] \?\? newest\);/.test(memb), true);

  /* ── ALREADY HANDLED, asserted so they stay that way ──────────────────────────────────────────
   * These are not changes. Each already avoids the partial-bucket trap by its own means, and each
   * assertion here pins the mechanism that does it. */
  const pc = readFileSync("src/lib/periodCompare.ts", "utf8");
  is("  periodCompare uses SAME-DAY-OF-MONTH windows, so every period is like-for-like",
    /const endDay = Math\.min\(todayDay, lastDayOfMonth\);/.test(pc), true);
  is("  …and flags the in-progress one", /inProgress: offset === 0,/.test(pc), true);
  const heat = readFileSync("src/components/CancelHeatmap.tsx", "utf8");
  is("  CancelHeatmap deliberately reads the cell BEFORE the current one",
    /weeks\.length >= 2 \? weeks\[weeks\.length - 2\]/.test(heat), true);
  const fin = readFileSync("src/lib/financeStats.ts", "utf8");
  is("  financeStats compares prior month SAME-DAY MTD", /export function priorMonthSameDayMtdGross/.test(fin), true);
  const act = readFileSync("src/components/MembershipActiveChart.tsx", "utf8");
  is("  MembershipActiveChart marks its in-progress point", /isCurrent \? "url\(#active-current-stripes\)"/.test(act), true);
}

console.log(`\nweek-buckets: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
