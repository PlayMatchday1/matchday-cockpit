/* DAILY GRAIN AND THE MATCHED WINDOW — the two decisions on Player Activity that are invisible in
 * the DOM.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/behavior-daily-test.ts
 */
import {
  chicagoYmd, wallClockYmd, weekKey, dayKey, daysInMonthRange, MAX_DAYS, isDayComplete,
  weekendDays, matchedMonthWindow,
} from "@/lib/weekBuckets";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

console.log("\n— the two date rules survive into daily, and a swap moves rows both ways —");
{
  /* THE NEAR-MIDNIGHT PAIR. Same calendar day in the raw strings; different days after the rules.
   * A registration is a TRUE UTC INSTANT and is converted. A match's start_date carries a Z it does
   * not mean and is SLICED. */
  const reg = "2026-09-15T02:30:00Z";
  const match = "2026-09-15T02:30:00+00:00";
  is("a registration at 02:30Z lands on the 14th in Chicago", chicagoYmd(reg), "2026-09-14");
  is("  and a match at the same wall clock lands on the 15th", wallClockYmd(match), "2026-09-15");
  yes("  so the rules put them on DIFFERENT days", chicagoYmd(reg) !== wallClockYmd(match));
  /* CONTROL: THE STRINGS ARE THE SAME DAY. Without this the assertion above passes on two inputs
   * that were never the same day to begin with, which proves nothing about the rules. */
  is("  CONTROL: while the raw strings are the same calendar day",
    reg.slice(0, 10), match.slice(0, 10));
  /* THE SWAP, WHICH IS THE BUG THIS GUARDS. It moves both rows in OPPOSITE directions, so the error
   * doubles rather than partly cancelling. */
  is("swapped, the registration wrongly claims the 15th", wallClockYmd(reg), "2026-09-15");
  is("  and the match wrongly claims the 14th", chicagoYmd(match), "2026-09-14");
  /* AND DAY GRAIN IS weekKey's OWN INPUT. This is the whole reason daily is cheap: the day key is
   * what the helpers already return, and weekKey is the bucketing wrapped around them. */
  is("the day key IS what chicagoYmd returns", dayKey(chicagoYmd(reg)), "2026-09-14");
  is("  and weekKey is a wrapper over it, not a different derivation",
    weekKey(chicagoYmd(reg)), weekKey("2026-09-14"));
  /* A NON-MONDAY, because on a Monday the week key and the day key are legitimately identical and
   * the control proves nothing. 2026-09-14 is a Monday; 2026-09-16 is a Wednesday. */
  yes("  CONTROL: and on a Wednesday the week key differs from the day key",
    weekKey("2026-09-16") !== "2026-09-16", `${weekKey("2026-09-16")} vs 2026-09-16`);
  is("  CONTROL: while on a Monday they are the same, which is why the line above picks a Wednesday",
    weekKey("2026-09-14"), "2026-09-14");
}

console.log("\n— daily narrows the axis, and days align to months —");
{
  const sep = daysInMonthRange("2026-09", "2026-09");
  is("one month of days is that month's length", sep.axis.length, 30);
  is("  starting on the 1st", sep.axis[0], "2026-09-01");
  is("  and ending on the 30th", sep.axis[29], "2026-09-30");
  is("  with nothing dropped", sep.dropped, 0);
  /* DAYS ALIGN TO MONTHS, which weekly can never promise. A month's days sum to that month exactly,
   * so daily does NOT inherit weekly's "weeks do not align to months" caveat. */
  yes("every day of September belongs to September",
    sep.axis.every((d) => d.startsWith("2026-09")));
  /* SIX MONTHS OF DAYS IS 180 COLUMNS. The cap front-drops rather than erroring. */
  const six = daysInMonthRange("2026-04", "2026-09");
  is("six months of days is capped at MAX_DAYS", six.axis.length, MAX_DAYS);
  yes("  CONTROL: and it dropped from the FRONT, keeping the newest days",
    six.axis[six.axis.length - 1] === "2026-09-30", six.axis[six.axis.length - 1]);
  yes("  CONTROL: with the drop count reported rather than silent", six.dropped > 100, String(six.dropped));
  is("a February is 28 days in 2026", daysInMonthRange("2026-02", "2026-02").axis.length, 28);
  is("today is not complete", isDayComplete("2026-09-27", "2026-09-27"), false);
  is("  yesterday is", isDayComplete("2026-09-26", "2026-09-27"), true);
  is("  CONTROL: and tomorrow is not", isDayComplete("2026-09-28", "2026-09-27"), false);
}

console.log("\n— the weekend count, which is why day-matching is honest rather than sufficient —");
{
  /* ── THE BRIEF SAID FIVE AGAINST FOUR AND THE CALENDAR SAYS FOUR AGAINST FOUR ──────────────
   * Computed rather than accepted: 2026-08-01 is a SATURDAY and 2026-09-01 is a TUESDAY, and a
   * 27-day window from each holds EIGHT weekend days - four Saturdays and four Sundays - in both.
   * August has five Saturdays in the month (1, 8, 15, 22, 29) but the 29th falls OUTSIDE 27 days,
   * which is where the five came from and is exactly why the window matters.
   *
   * THE DESIGN IS UNAFFECTED. The counts CAN differ, and when they do they move spots more than
   * anything else on this page, so both are printed. They are DERIVED from the window rather than
   * typed, which is what makes the header right on a window where they do diverge. */
  is("August 1-27 holds eight weekend days", weekendDays("2026-08-01", "2026-08-27"), 8);
  is("  and September 1-27 holds eight as well", weekendDays("2026-09-01", "2026-09-27"), 8);
  yes("  so on THIS pair day-matching happens to be weekend-matched too",
    weekendDays("2026-08-01", "2026-08-27") === weekendDays("2026-09-01", "2026-09-27"));
  /* ── A CONSTRUCTED PAIR THAT GENUINELY DIFFERS, SO THE HELPER IS PROVEN ABLE TO SAY SO ──────
   * Not engineered from today's data: two real months picked for their opening weekday.
   *
   * ── THE RULE, SO A PAIR IS DERIVED RATHER THAN GUESSED ────────────────────────────────────
   * A 27-day window is three weeks plus six days. The six extras carry the weekdays of days 1 to 6,
   * which cover every weekday but ONE. So the tail adds two weekend days unless the omitted weekday
   * is Saturday or Sunday - that is, unless the month opens on Sunday or Monday. SEVEN weekend days
   * then, EIGHT otherwise.
   *
   * WHICH IS WHY THE OBVIOUS PAIR FAILS. Friday-against-Tuesday feels like a contrast and is not:
   * May 2026 opens Friday, September opens Tuesday, and neither omits a weekend day, so both give 8.
   * Two weekdays that feel different are not two derived from the arithmetic. The pair has to include
   * a Sunday or Monday opening. June 2026 opens MONDAY (7) against September's TUESDAY (8). */
  is("a Monday-opening month gives 7 weekend days in 27", weekendDays("2026-06-01", "2026-06-27"), 7);
  is("  a Tuesday-opening month gives 8", weekendDays("2026-09-01", "2026-09-27"), 8);
  yes("  so on a constructed pair the helper reports a DIFFERENCE, which is the property under test",
    weekendDays("2026-06-01", "2026-06-27") !== weekendDays("2026-09-01", "2026-09-27"));
  /* CONTROL: and a Friday-against-Tuesday pair does NOT differ, which is why the pair above was
   * chosen by opening weekday rather than by looking plausible. */
  is("  CONTROL: Friday-opening May also gives 8, so Fri-vs-Tue would have proven nothing",
    weekendDays("2026-05-01", "2026-05-27"), 8);
  is("  CONTROL: a full week is always two weekend days", weekendDays("2026-09-07", "2026-09-13"), 2);
  is("  CONTROL: a single Wednesday is none", weekendDays("2026-09-09", "2026-09-09"), 0);
}

console.log("\n— the matched window —");
{
  /* PART-ELAPSED: both windows cut to the same day count, today INCLUDED. Excluding today would
   * compare 26 finished days against 26 while the column above showed 27 days of data, and the pill
   * would disagree with its own cell for a reason nobody could see. */
  const w = matchedMonthWindow("2026-09", "2026-08", "2026-09-27");
  is("a part-elapsed September cuts both windows to 27 days", w.days, 27);
  is("  September 1 to 27", [w.last.from, w.last.to], ["2026-09-01", "2026-09-27"]);
  is("  against August 1 to 27", [w.prev.from, w.prev.to], ["2026-08-01", "2026-08-27"]);
  is("  and reports both weekend counts", [w.prevWeekends, w.lastWeekends], [8, 8]);
  /* CLOSED: the windows are the whole months, and `days` is null so the header can say so. */
  const c = matchedMonthWindow("2026-08", "2026-07", "2026-09-27");
  is("a closed August compares whole months", c.days, null);
  is("  August in full", [c.last.from, c.last.to], ["2026-08-01", "2026-08-31"]);
  is("  against July in full", [c.prev.from, c.prev.to], ["2026-07-01", "2026-07-31"]);
  /* CONTROL: THE TWO BRANCHES DIFFER. Without this, a matchedMonthWindow that always returned whole
   * months would satisfy the closed case and quietly break the live one. */
  yes("  CONTROL: the two branches return different shapes",
    w.days !== null && c.days === null);
  /* THE SHORT-MONTH CLAMP. The first 31 days of a 31-day month is not a window February has. */
  const f = matchedMonthWindow("2026-03", "2026-02", "2026-03-31");
  is("31 days of March clamps to February's 28", f.prev.to, "2026-02-28");
  is("  while March keeps its own 31", f.last.to, "2026-03-31");
  yes("  CONTROL: so the windows are deliberately unequal there, and the day count says 31",
    f.days === 31);
  /* AND THE FIRST DAY OF A MONTH IS A ONE-DAY WINDOW, not a zero-day one. */
  const d1 = matchedMonthWindow("2026-09", "2026-08", "2026-09-01");
  is("the 1st is a one-day window", d1.days, 1);
  is("  comparing Sep 1 with Aug 1", [d1.last.to, d1.prev.to], ["2026-09-01", "2026-08-01"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
