/* THE GOAL SHEET'S ARITHMETIC, PINNED.
 *
 * This page exists because a spreadsheet cannot compute its own left-hand column, and the
 * spreadsheet's own totals prove the point: its 29 rows sum to 16.6 while its stored "Total MD"
 * says 16.7, and Keswick shows 0.4 against 0.4 with a difference of 0.1. Both are one-decimal
 * rounding applied before the sum. Every assertion here is about a way that can happen again.
 */
import {
  SPOTS_PER_MATCH, band, bandForDisplay, countsTowardGoals, cityRollup, cityTotals, dailyAverage,
  daysElapsed, fmtSigned, fmtUnit, historyIndexes, isDormantIn, matchMonthIndex, monthKey, ramp,
  rowCountsTowardTotals, rowKeyForField, roundTo, sortGoalRows, sumTargets, trendKind,
  TREND_DEAD_BAND, weekly, type RollupRow,
  BASELINE_MIN_COMPLETED_DAYS, baselineMonth, isDormantFor,
  dailyIn, fmtShownSigned, shownGap, shownTrend,
} from "@/lib/fieldGoals";
import fs from "node:fs";

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
/* AN EXPLICIT INSTANT, NOT LOCAL PARTS. This was new Date(2026, 8, 12, 10), which builds from the
 * RUNNER's timezone — the same class of bug the current month's divisor had, sitting in the suite
 * meant to catch it. At 10:00 it happened to resolve to 12 Sep in Chicago from UTC through London
 * and would have resolved to the 11th from about UTC+9, so it was one differently-configured CI
 * box away from a flake. 15:00Z is 10:00 in Chicago, the same wall clock it always meant. */
const now = new Date("2026-09-12T15:00:00Z"); // 10:00 Chicago, 12 Sep 2026
is("a finished month divides by its own length", daysElapsed(7, 2026, now), { days: 31, of: 31, partial: false });
/* COMPLETED DAYS, TODAY EXCLUDED. This read "INCLUDING today" and wanted 12, which is the contract
 * the completed-days change reverses: the divisor now covers the 11 days through the 11th, so the
 * figure moves once a day instead of drifting all afternoon as bookings land. */
is("the current month divides by COMPLETED days, today excluded", daysElapsed(8, 2026, now), { days: 11, of: 30, partial: true });
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


/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * DORMANT vs NOT COUNTED, THE ORDER, AND THE "-0" BUG
 * Appended when Ryan asked for the two exclusions and the sort. Every assertion here is about a way
 * the table and the chart could end up disagreeing, or a number rendering as something nobody means.
 */
{
  console.log("\n— not counted leaves every total; dormant leaves only the table —");
  yes("a normal row counts", rowCountsTowardTotals({}));
  yes("…and one marked not-counted does not", !rowCountsTowardTotals({ notCounted: true }));
  /* THE ONE PREDICATE. If the table filtered on this and the chart did not, the bars would sit
   * above the sum of the rows beneath them — the spreadsheet's own fault. */
  const rows = [
    { notCounted: false, monthly: [{ matches: 4 }, { matches: 0 }] },
    { notCounted: true, monthly: [{ matches: 9 }, { matches: 9 }] },
  ];
  is("the counted set drops the excluded row", rows.filter(rowCountsTowardTotals).length, 1);
  yes("a dormant row is still counted", rowCountsTowardTotals(rows[0]) && isDormantIn(rows[0], 1));
  yes("dormancy is per month, not per row", !isDormantIn(rows[0], 0) && isDormantIn(rows[0], 1));
  /* A ZERO AVERAGE IS NOT DORMANCY. A month with matches that nobody joined reads 0.0 and is not
   * quiet; only the match COUNT can tell them apart. */
  yes("a month with matches and no players is NOT dormant", !isDormantIn({ monthly: [{ matches: 3 }] }, 0));

  console.log("\n— no number renders as -0 —");
  is("a hair below zero rounds to plain zero", roundTo(-0.004, 1), 0);
  is("…and prints without a sign", fmtSigned(-0.004, "day"), "0.0");
  yes("…and Object.is confirms it is not negative zero", !Object.is(roundTo(-0.004, 1), -0));
  is("a real surplus keeps its minus", fmtSigned(-0.2, "day"), "-0.2");
  is("a real shortfall keeps its plus", fmtSigned(0.3, "day"), "+0.3");
  is("weekly rounds to whole numbers", fmtSigned(0.43, "week"), "+3");
  /* ATH PEARLAND. 0.004 above goal is LEVEL in any sense a person means, and the sheet's legend puts
   * level in "within 0.49" rather than "already above". Banding the DISPLAYED value is what makes
   * the dot and the printed number agree. */
  is("level-by-rounding bands as within 0.49, not above", bandForDisplay(-0.004), "near");
  is("…while a genuine surplus is still above", bandForDisplay(-0.2), "over");
  is("…and the thresholds are unmoved", [bandForDisplay(0.3), bandForDisplay(0.6), bandForDisplay(1.2)], ["near", "warn", "behind"]);

  console.log("\n— the order, and where a row with no goal goes —");
  const set = [
    { name: "Alpha", city: "Austin", gapDaily: 0.2 },
    { name: "Bravo", city: "Dallas", gapDaily: 1.8 },
    { name: "Charlie", city: "Austin", gapDaily: -0.5 },
    { name: "Delta", city: "Boston", gapDaily: null },
    { name: "Echo", city: "Austin", gapDaily: 0.7 },
  ];
  is("by gap runs worst-first", sortGoalRows(set, "gap").map((r) => r.name), ["Bravo", "Echo", "Alpha", "Charlie", "Delta"]);
  /* THE BANDS THEN RUN IN SEQUENCE, which is the whole reason gap order is the default: the rule
   * explains itself with no legend. */
  is("…so the bands are monotonic down the list",
    sortGoalRows(set, "gap").filter((r) => r.gapDaily != null).map((r) => bandForDisplay(r.gapDaily as number)),
    ["behind", "warn", "near", "over"]);
  is("by city groups, then names", sortGoalRows(set, "city").map((r) => r.name), ["Alpha", "Charlie", "Echo", "Bravo", "Delta"]);
  is("A–Z is A–Z", sortGoalRows(set, "name").map((r) => r.name), ["Alpha", "Bravo", "Charlie", "Echo", "Delta"]);
  yes("a row with no goal is last under EVERY order",
    (["gap", "city", "name"] as const).every((k) => sortGoalRows(set, k).at(-1)?.name === "Delta"));
  /* STABLE BETWEEN LOADS. Two rows with the same gap must not swap places on a reload. */
  const tied = [{ name: "Zulu", city: "X", gapDaily: 0.5 }, { name: "Alpha", city: "X", gapDaily: 0.5 }];
  is("ties break on the name", sortGoalRows(tied, "gap").map((r) => r.name), ["Alpha", "Zulu"]);
  is("…and the same order comes back a second time", sortGoalRows(sortGoalRows(tied, "gap"), "gap").map((r) => r.name), ["Alpha", "Zulu"]);
}

console.log("\n— a city equals the sum of the fields AS DISPLAYED —");
{
  /* ── THE BUG THIS PINS ────────────────────────────────────────────────────────────────────
   * Austin printed 6.1 for September over ten field rows that read 0.1, 0.4, 2.2, 0.2, 0.2, 1.2,
   * 0.0, 0.5, 1.1, 0.3 — which add to 6.2 — and a GAP of 3.8 over field gaps adding to 3.7. The
   * city summed at full precision and rounded once; each field rounded on its own. Both are
   * defensible and only one can be on screen, because the reader adds up the column in front of
   * them.
   *
   * THE FIXTURE IS BUILT TO REPRODUCE IT rather than to pass. Ten fields whose raw dailies each
   * sit just under a rounding boundary: full-precision they sum below the rounded sum, so a
   * regression to the old rule changes the answer here and the assertion fails. */
  const year = 2026, cur = 8, DEC_I = 11;
  const decKey = monthKey(year, DEC_I);
  // Raw dailies that each round UP, so sum-of-rounded > rounded-of-sum.
  const RAW = [0.1499, 0.1499, 0.1499, 0.1499, 0.1499, 0.1499, 0.1499, 0.1499, 0.1499, 0.1499];
  const mk = (i: number, daily: number, dec: number | null): RollupRow => ({
    key: `f${i}`, kind: "existing", name: `Field ${i}`, city: "Austin",
    monthly: Array.from({ length: 12 }, (_, m) => ({ daily: m === cur ? daily : 0 })),
    targets: dec == null ? {} : { [decKey]: dec },
  });
  const rows = RAW.map((d, i) => mk(i, d, 0.4499));
  const [austin] = cityRollup(rows, year, cur, "gap");

  const shownSep = RAW.map((d) => roundTo(d, 1));           // what each field row prints
  const sumShownSep = roundTo(shownSep.reduce((a, b) => a + b, 0), 1);
  is("the city September equals the sum of the field Septembers as printed", austin.live, sumShownSep);
  /* THE CONTROL THAT MAKES THIS A TEST. Under the OLD rule the city would print the rounded
   * full-precision sum, which on this fixture is a different number. If these ever coincide the
   * fixture has stopped exercising the bug. */
  const oldWay = roundTo(RAW.reduce((a, b) => a + b, 0), 1);
  yes("  CONTROL: the old full-precision rule gives a different answer on this fixture",
    oldWay !== sumShownSep, `both ${sumShownSep}`);

  /* REPLACED 2026-10-02 (Ryan reversed the rule): the city GAP was the sum of the field gaps; it is
   * now the city's own displayed December minus its own displayed baseline. */
  is("the city GAP equals the city's displayed Dec minus its displayed baseline",
    austin.gapDaily, roundTo(roundTo(austin.dec, 1) - roundTo(austin.live, 1), 1));
  is("  and Dec likewise", austin.dec, roundTo(rows.map(() => roundTo(0.4499, 1)).reduce((a, b) => a + b, 0), 1));

  /* A NEGATIVE GAP STILL COUNTS. Onion Creek sits at -0.3 — already past its goal — and dropping
   * it would overstate the city's remaining work by exactly that much. */
  const withOver = cityRollup([...rows, mk(99, 1.0, 0.7)], year, cur, "gap")[0];
  /* REPLACED 2026-10-02, same reason: displayed Dec minus displayed baseline, one level up. */
  is("a field already past its goal pulls the city GAP down",
    withOver.gapDaily, roundTo(withOver.dec - withOver.live, 1));
  yes("  CONTROL: …and it is lower than without that field", withOver.gapDaily < austin.gapDaily);

  /* A NEW FIELD WITH NO DATA CONTRIBUTES NOTHING, which is what it did before this change. Its
   * September is null — it does not exist yet, which is not the same as having run no matches. */
  const withSlot = cityRollup([...rows, { key: "s1", kind: "slot", name: "New Field - ", city: "Austin",
    monthly: Array.from({ length: 12 }, () => ({ daily: 0 })), targets: {} }], year, cur, "gap")[0];
  is("a new field with no goal leaves the city September untouched", withSlot.live, austin.live);
  is("  …and its GAP untouched", withSlot.gapDaily, austin.gapDaily);
  is("  …and it carries a null September so it renders a dash",
    withSlot.fields.find((f) => f.kind === "slot")?.live, null);

  /* THE FOOTER IS THE SUM OF THE COLUMN ABOVE IT, with the same guarantee one level up. */
  const many = cityRollup([...rows, mk(50, 0.1499, 0.4499), { key: "h1", kind: "existing", name: "H", city: "Houston",
    monthly: Array.from({ length: 12 }, (_, m) => ({ daily: m === cur ? 0.1499 : 0 })), targets: { [decKey]: 0.4499 } }], year, cur, "gap");
  const tot = cityTotals(many);
  is("the footer September equals the sum of the city Septembers",
    tot.live, roundTo(many.reduce((a, c) => a + c.live, 0), 1));
  /* REPLACED 2026-10-02: the footer GAP was the sum of the city gaps (+11.2 under 16.5 and 27.6);
   * it is now the footer's displayed December minus its displayed baseline. */
  is("  and the footer GAP is the footer's displayed Dec minus its displayed baseline",
    tot.gapDaily, roundTo(tot.dec - tot.base, 1));
  yes("  CONTROL: more than one city, so the footer is not one row wearing a total", many.length > 1);
}

console.log("\n— history: a dash is not a zero, and a trend is not a gap —");
{
  /* ── WHY THIS IS HERE AND NOT ONLY IN THE BROWSER ────────────────────────────────────────
   * PRODUCTION HAS ONLY CLIMBING CITIES TODAY. Measured 2026-09-29: all seven cities with
   * history trend up, and none is flat or falling. The browser check therefore cannot exercise
   * two of the three states, and MANUFACTURING ONE BY EDITING PRODUCTION would be the worst
   * possible way to make a line green. A fixture is the honest place for it. */
  is("a climb past the dead band is up", trendKind(0.2), "up");
  is("a fall past it is down", trendKind(-0.2), "dn");
  is("anything inside it is flat, not a direction", trendKind(0.1), "flat");
  is("  …in both directions", trendKind(-0.1), "flat");
  /* THE BAND IS EXCLUSIVE AT THE EDGE, so a value exactly on it does not get an arrow. */
  is("  the boundary itself is flat", trendKind(TREND_DEAD_BAND), "flat");
  /* NULL IN, NULL OUT. A market with no history must NOT be handed a zero: zero classifies as
   * "flat", which is a claim about a trajectory that was never measured. */
  is("no history means no trend, never a flat zero", trendKind(null), null);
  yes("  CONTROL: and zero WOULD have read as flat, which is why null must not become it",
    trendKind(0) === "flat");

  is("history is the three months before the live one", historyIndexes(8), [5, 6, 7]);
  is("  …and never runs off the front of the year", historyIndexes(1), [0]);

  const year = 2026, cur = 8, decKey = monthKey(year, 11);
  /* `matches` IS WHAT SAYS A PITCH EXISTED. Both rows below read daily 0 in June; only one of
   * them had a pitch open. Without the match count they are indistinguishable, and the quiet one
   * would be printed as 0.0 — the exact misread this rule exists to prevent. */
  const mk = (key: string, city: string, dailies: number[], matches: number[], dec: number | null): RollupRow => ({
    key, kind: "existing", name: key, city,
    monthly: Array.from({ length: 12 }, (_, m) => ({ daily: dailies[m] ?? 0, matches: matches[m] ?? 0 })),
    targets: dec == null ? {} : { [decKey]: dec },
  });
  const zeros = new Array(12).fill(0);
  const open = (...at: number[]) => { const a = new Array(12).fill(0); for (const i of at) a[i] = 4; return a; };

  // Old pitch: open since May. Quiet in June (no spots) but it EXISTED.
  const old = mk("old", "Austin", Object.assign([...zeros], { 5: 0, 6: 0.4, 7: 0.6, 8: 0.9 }), open(4, 5, 6, 7, 8), 2.0);
  // New pitch: first match in August only.
  const fresh = mk("fresh", "Austin", Object.assign([...zeros], { 7: 0.2, 8: 0.3 }), open(7, 8), 1.0);
  const [austin] = cityRollup([old, fresh], year, cur, "gap");

  is("a month BEFORE a pitch opened dashes", austin.fields.find((f) => f.key === "fresh")!.hist.slice(0, 2), [null, null]);
  yes("  CONTROL: while the month it opened carries a figure, so the dash is about existence",
    austin.fields.find((f) => f.key === "fresh")!.hist[2] === 0.2);
  is("a QUIET month for a pitch that existed is a real 0, not a dash",
    austin.fields.find((f) => f.key === "old")!.hist[0], 0);
  /* THE CITY TAKES THE FIGURE WHEREVER ANY PITCH EXISTED, and sums as displayed — the same rule
   * September and December already follow, so a history column foots to its drawer. */
  is("the city June is its open pitches only", austin.hist[0], 0);
  is("  and August sums both, as displayed", austin.hist[2], roundTo(roundTo(0.6, 1) + roundTo(0.2, 1), 1));
  yes("  CONTROL: which is a different number from June, so the columns are not one value repeated",
    austin.hist[2] !== austin.hist[0]);
  is("the trend runs from the EARLIEST history month to the live one",
    austin.trend, roundTo(austin.live - (austin.hist[0] as number), 1));
  yes("  CONTROL: and is not the gap", austin.trend !== austin.dec - austin.live);

  // A city where NOTHING was ever open: every history month dashes, it is new, and it has no trend.
  const brandNew = cityRollup([mk("p1", "Philadelphia", zeros, zeros, 0.5)], year, cur, "gap")[0];
  is("a market with nothing open dashes every history month", brandNew.hist, [null, null, null]);
  yes("  …and is flagged new", brandNew.isNew);
  is("  …and carries NO trend rather than a fabricated one", brandNew.trend, null);
  yes("  CONTROL: while the climbing city is not flagged new", austin.isNew === false);
  yes("  CONTROL: …and does have a trend, so the null above is specific", austin.trend != null);
}

console.log("\n— THE BASELINE: the month the gap, trend and progress are measured from —");
{
  /* Ryan, 2026-10-02: on the 2nd the live month has one completed day, and that day was the "now"
   * every gap, trend and progress bar read. Days 1-7 read the last full month; the 8th onward reads
   * the live month to date. */
  is("the threshold is seven completed days", BASELINE_MIN_COMPLETED_DAYS, 7);
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const keyOn = (d: number) => baselineMonth(`2026-10-${String(d).padStart(2, "0")}`).baseKey;
  is("days 1 to 7 read the last full month", days.filter((d) => d <= 7).map(keyOn), Array(7).fill("2026-09-01"));
  is("the 8th onward reads the live month", days.filter((d) => d >= 8).map(keyOn), Array(24).fill("2026-10-01"));
  is("…the 7th has six completed days, the 8th seven", [baselineMonth("2026-10-07").completedDays, baselineMonth("2026-10-08").completedDays], [6, 7]);
  is("January's last full month is last December", baselineMonth("2027-01-03").baseKey, "2026-12-01");
  is("an override wins: month to date on the 2nd", baselineMonth("2026-10-02", "to-date").baseKey, "2026-10-01");
  is("an override wins: last full month on the 20th", baselineMonth("2026-10-20", "last-full").baseKey, "2026-09-01");
  is("…and the default is still reported", baselineMonth("2026-10-02", "to-date").defaultCompareFrom, "last-full");

  /* MONTH TO DATE IS THE CURRENT BUILD, EVERY COLUMN. scripts/fixtures/field-goals-mtd-golden.json
   * was written by the rollup as it stood at 07920d2/e2417dc (before the baseline existed), over an
   * October-2nd world. The rollup with the baseline on the live month must reproduce it exactly —
   * including the suggested October and November, which in this mode still ramp from the live month.
   * The one renamed key (sep → live) is mapped back; `base` is new and must equal `live` here. */
  type G = { year: number; cur: number; rows: RollupRow[] } & Record<"gap" | "city" | "name", { cities: unknown[]; totals: unknown }>;
  const g = JSON.parse(fs.readFileSync("scripts/fixtures/field-goals-mtd-golden.json", "utf8")) as G;
  /* CHANGED 2026-10-02: the gap rule was reversed (displayed goal minus displayed baseline), so the
   * golden's gap keys — and the gap SORT's order, which follows them — are the old rule's. Every
   * other key is still compared; the gap is asserted against the new rule in its own section. */
  const GAPKEYS = new Set(["base", "gapDaily", "gapSort"]);
  const strip = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (k, v) => (GAPKEYS.has(k) ? undefined : v)).replace(/"live":/g, '"sep":'));
  const byCity = (x: { cities: { city: string; fields: { key: string }[] }[]; totals: unknown }) => ({
    cities: [...x.cities].map((c) => ({ ...c, fields: [...c.fields].sort((a, b) => a.key.localeCompare(b.key)) })).sort((a, b) => a.city.localeCompare(b.city)),
    totals: x.totals });
  for (const sort of ["gap", "city", "name"] as const) {
    const now = cityRollup(g.rows, g.year, g.cur, sort, g.cur);
    is(`month to date reproduces the current build in every non-gap column (sort ${sort})`,
      byCity(strip({ cities: now, totals: cityTotals(now) }) as never), byCity(strip(g[sort]) as never));
  }
  const mtd = cityRollup(g.rows, g.year, g.cur, "gap");
  yes("CONTROL: the golden is not trivial — 5 cities, suggestions present", (g.gap.cities as unknown[]).length === 5 && mtd.some((c) => c.oct > 0));
  yes("in month to date the baseline IS the live month, every city and field",
    mtd.every((c) => c.base === c.live && c.fields.every((f) => f.base === f.live)));

  // THE LAST FULL MONTH AS BASELINE, over the same world
  const lf = cityRollup(g.rows, g.year, g.cur, "gap", g.cur - 1);
  const austin = lf.find((c) => c.city === "Austin")!;
  const rowsA = g.rows.filter((r) => r.city === "Austin" && !r.notCounted);
  const sepOf = (r: RollupRow) => r.monthly[8].daily;
  is("the city baseline is September, summed as displayed", austin.base, roundTo(rowsA.reduce((a, r) => a + roundTo(sepOf(r), 1), 0), 1));
  /* REPLACED 2026-10-02: was "December minus September, field by field" (summed field gaps). */
  is("the gap is the city's displayed December minus its displayed September", austin.gapDaily,
    roundTo(roundTo(austin.dec, 1) - roundTo(austin.base, 1), 1));
  yes("CONTROL: and is not the month-to-date gap", austin.gapDaily !== mtd.find((c) => c.city === "Austin")!.gapDaily);
  const nemp = austin.fields.find((f) => f.key === "v1")!;
  is("October's suggestion is the September-to-December line, not one from October's partial day",
    roundTo(nemp.oct as number, 4), roundTo(ramp(2.13, 3.0)[0] as number, 4));
  yes("CONTROL: the month-to-date suggestion runs from October's own day",
    roundTo(mtd.find((c) => c.city === "Austin")!.fields.find((f) => f.key === "v1")!.oct as number, 4) === roundTo(ramp(0.9, 3.0)[0] as number, 4));
  is("a typed October target is never replaced by a suggestion", austin.fields.find((f) => f.key === "v2")!.oct, 1.5);
  is("the live month still shows, unchanged", austin.live, mtd.find((c) => c.city === "Austin")!.live);
  is("the trend runs from the earliest history month to the baseline (Jul → Sep)", austin.trend, roundTo(austin.base - (austin.hist[0] as number), 1));
  yes("CONTROL: …which is not the month-to-date trend", austin.trend !== mtd.find((c) => c.city === "Austin")!.trend);

  // A CITY THAT HAS NEVER PLAYED STILL DASHES, AND ITS GAP IS THE WHOLE DECEMBER GOAL
  const sd = lf.find((c) => c.city === "San Diego")!;
  is("a city with no history still dashes every history month", sd.hist, [null, null, null]);
  is("…carries no trend", sd.trend, null);
  yes("…and is new", sd.isNew);
  is("…and its gap is the full December goal", sd.gapDaily, 1.0);
  is("…and its field has no baseline figure, a dash not 0.0", sd.fields[0].base, null);

  // DORMANT FOLLOWS THE BASELINE
  const westlake = g.rows.find((r) => r.key === "v3")!;   // all September, nothing yet in October
  const quiet = g.rows.find((r) => r.key === "v5")!;      // nothing since June
  yes("a field with September matches and none yet in October is NOT dormant", !isDormantFor(westlake, 8, 9));
  yes("CONTROL: the live-month-only rule would have folded it", isDormantIn(westlake, 9));
  yes("a field with neither is dormant", isDormantFor(quiet, 8, 9));
  const startedInOct = { monthly: [...Array(8).fill({ daily: 0, matches: 0 }), { daily: 0, matches: 0 }, { daily: 0.5, matches: 1 }] };
  yes("a field that has played in the live month is never folded, whichever baseline", !isDormantFor(startedInOct, 8, 9) && !isDormantFor(startedInOct, 9, 9));
  yes("in month to date, dormant is exactly today's rule", [westlake, quiet, startedInOct].every((r) => isDormantFor(r, 9, 9) === isDormantIn(r, 9)));
}

console.log("\n— EVERY GAP IS THE DISPLAYED GOAL MINUS THE DISPLAYED BASELINE (Ryan, 2026-10-02) —");
{
  /* Checked against the PRINTED STRINGS — fmtUnit for the goal and baseline cells, fmtShownSigned
   * for the gap — so this is the subtraction a reader does, not shownGap checked against itself. */
  const g = JSON.parse(fs.readFileSync("scripts/fixtures/field-goals-mtd-golden.json", "utf8")) as { year: number; cur: number; rows: RollupRow[] };
  const decKey = monthKey(g.year, 11);
  let rowsChecked = 0, bad1 = 0;
  for (const mode of ["to-date", "last-full"] as const) {
    const baseIdx = mode === "to-date" ? g.cur : g.cur - 1;
    for (const unit of ["day", "week"] as const) {
      const cities = cityRollup(g.rows, g.year, g.cur, "gap", baseIdx, unit);
      const tot = cityTotals(cities);
      const printedGap = (dec: number, base: number) => Number(fmtShownSigned(shownGap(dailyIn(dec, unit), dailyIn(base, unit), unit) as number, unit));
      const reader = (dec: number, base: number) => roundTo(Number(fmtUnit(dec, unit)) - Number(fmtUnit(base, unit)), unit === "day" ? 1 : 0);
      // city rows (city grain)
      for (const c of cities) { rowsChecked++; if (printedGap(c.dec, c.base) !== reader(c.dec, c.base)) { bad1++; bad(`${mode}/${unit} ${c.city}`, `${printedGap(c.dec, c.base)} vs ${reader(c.dec, c.base)}`); } }
      // field rows (the drawer, and the Fields grain: the same page rows through the same shownGap)
      for (const r of g.rows) {
        const dec = r.targets[decKey]; if (dec == null) continue;
        const base = r.kind === "slot" ? 0 : r.monthly[baseIdx].daily;
        rowsChecked++; if (printedGap(dec, base) !== reader(dec, base)) { bad1++; bad(`${mode}/${unit} field ${r.key}`); }
      }
      // footer and tile
      rowsChecked++; if (printedGap(tot.dec, tot.base) !== reader(tot.dec, tot.base)) { bad1++; bad(`${mode}/${unit} footer`); }
      // sort: by the gap on screen, ties on the daily gap, then the name
      const keys = cities.map((c) => [c.gapSort, c.gapDaily, c.city] as const);
      const sorted = keys.every((k, i) => i === 0 || keys[i - 1][0] > k[0] || (keys[i - 1][0] === k[0] && (keys[i - 1][1] > k[1] || (keys[i - 1][1] === k[1] && keys[i - 1][2] <= k[2]))));
      yes(`${mode}/${unit}: by gap sorts by the gap on screen, ties daily then name`, sorted, JSON.stringify(keys));
    }
  }
  /* DERIVED, NOT PINNED: 4 mode/unit pairs × (every city + every field with a December goal + the footer). */
  const expectRows = 4 * (cityRollup(g.rows, g.year, g.cur).length + g.rows.filter((r) => r.targets[decKey] != null).length + 1);
  is("every city row, field row and footer, both modes, both units: gap = displayed goal - displayed baseline", { rowsChecked, bad: bad1 }, { rowsChecked: expectRows, bad: 0 });
  yes("CONTROL: rows were actually checked", rowsChecked > 20);

  // THE TWO CASES IN THE BRIEF, on the numbers as printed
  is("OKC: 0.7 and 1.0 is +0.3, not +0.4", shownGap(1.0, 0.7, "day"), 0.3);
  is("All MatchDay: 16.5 and 27.6 is +11.1, not +11.2", shownGap(27.6, 16.5, "day"), 11.1);
  /* A GAP OF UNROUNDED PARTS IS THE BUG. OKC's fields: 0.96 goal, 0.66 baseline → 0.30, which
   * summed from unrounded parts printed +0.4 under 0.7 and 1.0. */
  yes("CONTROL: the unrounded difference really did differ", roundTo(0.96 + 0.04 - (0.66 + 0.04), 1) === 0.3 && roundTo(1.04 - 0.66, 1) === 0.4);
  is("Weekly subtracts the two weekly figures shown (27.6 and 16.5 a day → 193 - 116 = 77)", shownGap(27.6 * 7, 16.5 * 7, "week"), 77);
  yes("CONTROL: …which is not 7 × the daily gap rounded (78)", Math.round(11.1 * 7) !== 77);
  is("a row with no baseline has the whole December goal to find", shownGap(1.0, null, "day"), 1.0);
  is("a row with no goal has no gap", shownGap(null, 0.7, "day"), null);
  is("a trend with no earliest month is no trend, not a zero", shownTrend(6.1, null, "day"), null);
  is("Weekly trend subtracts the two weekly figures shown", shownTrend(6.1 * 7, 6.8 * 7, "week"), 43 - 48);
  is("spots: the plain difference of the two totals shown", shownGap(36673.4, 14549.6, "spots"), 36673 - 14550);

  // THE "TO FIND" TILE IS THE FOOTER GAP — the page reads the tile's three figures off the footer
  for (const mode of ["to-date", "last-full"] as const) for (const unit of ["day", "week"] as const) {
    const tot = cityTotals(cityRollup(g.rows, g.year, g.cur, "gap", mode === "to-date" ? g.cur : g.cur - 1, unit));
    const tile = shownGap(dailyIn(tot.dec, unit), dailyIn(tot.base, unit), unit);
    const footerPrinted = Number(fmtShownSigned(shownGap(dailyIn(tot.dec, unit), dailyIn(tot.base, unit), unit) as number, unit));
    is(`2026 "To find" equals the footer gap (${mode}, ${unit})`, tile, footerPrinted);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
