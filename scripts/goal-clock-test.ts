/* THE CURRENT MONTH'S AVERAGE: WHOSE CALENDAR, AND WHICH DAYS.
 *
 * Two defects, one commit, and this suite is the record of both.
 *
 * ONE — THE CLOCK WAS THE RUNTIME'S. daysElapsed read now.getFullYear/getMonth/getDate. Those are
 * LOCAL getters and the fix was not to swap them for UTC ones: a Vercel function's local zone IS
 * UTC, so they already returned UTC calendar parts. The divisor stepped at UTC midnight, which is
 * 7pm in Chicago, and the average fell for five hours every evening. Worse, currentMonth read the
 * same clock, so between 7pm and midnight on the 30th the page relabelled to the next month,
 * closed the current one as finished and opened the new one with a single elapsed day.
 *
 * TWO — THE AVERAGE DRIFTED ALL AFTERNOON. The divisor counted today, a day still in progress,
 * while the numerator counted every match in the month INCLUDING ones not yet played, with their
 * bookings so far. Now both halves stop at the end of yesterday, so the figure moves once a day.
 *
 * EVERY INSTANT BELOW IS WRITTEN AS AN EXPLICIT UTC Z. new Date(y, m, d) builds from the RUNNER's
 * local parts, so a suite written that way asserts something different on a laptop than it does on
 * CI; that is the exact class of bug being fixed and it must not be reintroduced by the test.
 */
import {
  businessMonthIndex, businessYesterday, countsTowardGoals, dailyAverage, daysElapsed,
  hasNoCompletedDay, playedByYesterday, MONTH_LABELS,
} from "@/lib/fieldGoals";
import { todayBusinessDate } from "@/lib/goalPace";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

const at = (iso: string) => new Date(iso);
const SEP = 8, OCT = 9, NOV = 10;

console.log("\n— 1. the figure does not move through the day —");
{
  /* THE WHOLE POINT, AND THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL COMPLAINT. 09:00 and
   * 23:00 Chicago on the same date are 14:00Z and 04:00Z-the-next-day; the second one is past UTC
   * midnight, which is precisely where the old code stepped. */
  const morning = at("2026-10-15T14:00:00Z");   // 09:00 Chicago, 15 Oct
  const night = at("2026-10-16T04:00:00Z");     // 23:00 Chicago, 15 Oct
  is("09:00 and 23:00 Chicago are the same Chicago date",
    [todayBusinessDate(morning), todayBusinessDate(night)], ["2026-10-15", "2026-10-15"]);
  is("…so the divisor is identical at both",
    [daysElapsed(OCT, 2026, morning), daysElapsed(OCT, 2026, night)],
    [{ days: 14, of: 31, partial: true }, { days: 14, of: 31, partial: true }]);
  is("…and so is the numerator's cutoff",
    [businessYesterday(morning), businessYesterday(night)], ["2026-10-14", "2026-10-14"]);
  /* CONTROL: 23:00 Chicago really is on the far side of UTC midnight, so the assertion above is
   * testing the boundary rather than two instants that never crossed it. */
  yes("CONTROL: 23:00 Chicago is already the next UTC day, so the boundary was actually crossed",
    night.toISOString().slice(0, 10) !== morning.toISOString().slice(0, 10));
  /* CONTROL: the same pair read off the RUNTIME's calendar would have disagreed — the defect. */
  yes("CONTROL: reading the runtime's date instead would have given two different days",
    night.getUTCDate() !== morning.getUTCDate());
}

console.log("\n— 2. it changes exactly once, across midnight Chicago —");
{
  const before = at("2026-10-16T04:59:00Z");   // 23:59 Chicago, 15 Oct
  const after = at("2026-10-16T05:01:00Z");    // 00:01 Chicago, 16 Oct
  is("23:59 Chicago still divides by 14", daysElapsed(OCT, 2026, before).days, 14);
  is("00:01 Chicago divides by 15", daysElapsed(OCT, 2026, after).days, 15);
  is("…and the cutoff moves with it", [businessYesterday(before), businessYesterday(after)], ["2026-10-14", "2026-10-15"]);
  /* CONTROL: ONCE, not twice. Sampled hourly across the whole Chicago day, the divisor takes
   * exactly two distinct values — one step, at midnight, and none at 7pm. */
  const seen = new Set<number>();
  for (let h = 0; h < 24; h++) seen.add(daysElapsed(OCT, 2026, at(`2026-10-15T${String(h).padStart(2, "0")}:30:00Z`)).days);
  is("CONTROL: across 24 hourly samples the divisor takes exactly 2 values, not 3", seen.size, 2);
  /* CONTROL: and the step is at midnight Chicago, not at 7pm. 2026-10-16T00:30Z is 19:30 Chicago
   * on the 15th — the instant the old code stepped on. */
  is("CONTROL: 19:30 Chicago has NOT stepped", daysElapsed(OCT, 2026, at("2026-10-16T00:30:00Z")).days, 14);
}

console.log("\n— 3. a match later today contributes nothing, and tomorrow it does —");
{
  const now = at("2026-10-15T14:00:00Z");       // 09:00 Chicago, 15 Oct
  const cutoff = businessYesterday(now);        // 2026-10-14
  const laterToday = { field_id: 7, start_date: "2026-10-15T20:00:00+00:00", player_count: 18 };
  const yesterdayMatch = { field_id: 7, start_date: "2026-10-14T20:00:00+00:00", player_count: 18 };
  const laterThisMonth = { field_id: 7, start_date: "2026-10-28T20:00:00+00:00", player_count: 18 };
  yes("a match later today is excluded", !playedByYesterday(laterToday.start_date, cutoff));
  yes("…and so is one later this month", !playedByYesterday(laterThisMonth.start_date, cutoff));
  yes("CONTROL: yesterday's match IS counted, so the filter is not rejecting everything",
    playedByYesterday(yesterdayMatch.start_date, cutoff));
  /* THE CONTROL THE BRIEF ASKS FOR: the SAME match, one day later. */
  const tomorrow = at("2026-10-16T14:00:00Z");  // 09:00 Chicago, 16 Oct
  yes("CONTROL: the very same match counts tomorrow", playedByYesterday(laterToday.start_date, businessYesterday(tomorrow)));
  /* A MATCH EARLIER TODAY IS ALSO OUT. "Through the end of yesterday" is the rule, not "before
   * this moment" — otherwise the figure would still drift, just in steps. */
  yes("a match EARLIER today is out too, because the rule is completed days",
    !playedByYesterday("2026-10-15T06:00:00+00:00", cutoff));
  /* THE FILTER IS ADDITIONAL TO countsTowardGoals, NOT A REPLACEMENT. A cancelled match from
   * yesterday must still be excluded. */
  yes("CONTROL: the played filter does not rescue a cancelled match",
    playedByYesterday(yesterdayMatch.start_date, cutoff) && !countsTowardGoals({ ...yesterdayMatch, is_cancelled: true }));
}

console.log("\n— 3b. filtering the SPOTS must not delete the ROW —");
{
  /* CAUGHT ON THE DEPLOYED DATA, NOT REASONED ABOUT. The first cut applied playedByYesterday to
   * the match set itself, which is the natural way to write it and is wrong: a field whose every
   * 2026 match is still ahead then has no matches at all and vanishes from the page. Two real
   * ones did — Turf On (Houston, 14 matches) and One Touch (Atlanta, 13), both starting 1 October.
   * "Every venue with a 2026 match is a row, whether or not anybody has given it a goal" is the
   * whole reason this page beats the spreadsheet, so the row set is built from every counted match
   * and only the SPOTS are filtered. This asserts the shape of that loop. */
  const cutoff = "2026-09-25";
  const futureOnly = [
    { field_id: 1882, start_date: "2026-10-01T20:00:00+00:00", player_count: 18 },
    { field_id: 1882, start_date: "2026-10-08T20:00:00+00:00", player_count: 18 },
  ];
  const rowsFrom = (ms: { field_id: number; start_date: string }[]) => new Set(ms.map((m) => m.field_id));
  const spotsFrom = (ms: { field_id: number; start_date: string; player_count: number }[]) =>
    ms.filter((m) => playedByYesterday(m.start_date, cutoff)).reduce((s, m) => s + m.player_count, 0);
  is("a field whose matches are all ahead still produces a row", rowsFrom(futureOnly).size, 1);
  is("…and contributes no spots", spotsFrom(futureOnly), 0);
  /* CONTROL: the same field, once its matches are behind it, contributes both. */
  const played = futureOnly.map((m) => ({ ...m, start_date: m.start_date.replace("2026-10", "2026-09") }));
  is("CONTROL: once played, the same field contributes its spots", spotsFrom(played), 36);
  is("CONTROL: and it was one row all along", rowsFrom(played).size, 1);
}

console.log("\n— 4. day one has no value, not a zero —");
{
  const dayOne = at("2026-10-01T14:00:00Z");    // 09:00 Chicago, 1 Oct
  const cell = daysElapsed(OCT, 2026, dayOne);
  is("the 1st has zero completed days", cell, { days: 0, of: 31, partial: true });
  yes("…and says so as a state rather than as a number", hasNoCompletedDay(cell));
  is("CONTROL: dividing by it is still not a crash", dailyAverage(500, cell.days), 0);
  /* THE DISTINCTION THAT MATTERS. A FUTURE month also has zero days, and it is NOT the same
   * state: nothing is pending there. If these ever collapse into one, the 1st renders as a future
   * month and the page stops showing the current month at all. */
  const future = daysElapsed(NOV, 2026, dayOne);
  is("a future month also has zero days", future, { days: 0, of: 30, partial: false });
  yes("CONTROL: but it is NOT the day-one state", !hasNoCompletedDay(future));
  yes("CONTROL: and the 2nd IS a number again", !hasNoCompletedDay(daysElapsed(OCT, 2026, at("2026-10-02T14:00:00Z"))));
  is("…dividing by one completed day on the 2nd", daysElapsed(OCT, 2026, at("2026-10-02T14:00:00Z")).days, 1);
}

console.log("\n— 5. the month boundary, from both sides —");
{
  /* 2026-10-01T00:05Z is 19:05 Chicago on 30 SEPTEMBER. The old code called that October. */
  const beforeUtcMidnight = at("2026-09-30T23:55:00Z");   // 18:55 Chicago, 30 Sep
  const afterUtcMidnight = at("2026-10-01T00:05:00Z");    // 19:05 Chicago, 30 Sep
  for (const [name, t] of [["23:55Z", beforeUtcMidnight], ["00:05Z", afterUtcMidnight]] as const) {
    is(`${name}: the page is on September`, MONTH_LABELS[businessMonthIndex(t).monthIndex0], "Sep");
    is(`${name}: September is still partial`, daysElapsed(SEP, 2026, t), { days: 29, of: 30, partial: true });
    is(`${name}: October has nothing`, daysElapsed(OCT, 2026, t), { days: 0, of: 31, partial: false });
  }
  /* CONTROL: the two instants really do straddle UTC midnight, or this proves nothing. */
  yes("CONTROL: the pair does straddle UTC midnight",
    beforeUtcMidnight.toISOString().slice(0, 10) === "2026-09-30" && afterUtcMidnight.toISOString().slice(0, 10) === "2026-10-01");
  /* AND IT DOES ROLL OVER, at the right moment: 05:01Z on 1 Oct is 00:01 Chicago on 1 Oct. */
  const trulyOctober = at("2026-10-01T05:01:00Z");
  is("00:01 Chicago on 1 Oct: the page is on October", MONTH_LABELS[businessMonthIndex(trulyOctober).monthIndex0], "Oct");
  is("…September is now a finished month", daysElapsed(SEP, 2026, trulyOctober), { days: 30, of: 30, partial: false });
  is("…and October has no completed day yet", daysElapsed(OCT, 2026, trulyOctober), { days: 0, of: 31, partial: true });
}

console.log("\n— 6. the boundary moves with DST, which is why the zone is named —");
{
  /* UTC midnight is 7pm Chicago in CDT and 6pm in CST. Offset arithmetic would be wrong from
   * 1 November; Intl in a named zone is right on both sides. */
  is("2026-11-02T00:30Z is 1 Nov in Chicago", todayBusinessDate(at("2026-11-02T00:30:00Z")), "2026-11-01");
  is("2026-10-31T00:30Z is 30 Oct in Chicago", todayBusinessDate(at("2026-10-31T00:30:00Z")), "2026-10-30");
  /* CONTROL: the two are on opposite sides of the fall-back, and the Chicago wall clock proves it
   * — 6pm on one, 7pm on the other, from the same 00:30Z offset into the UTC day. */
  const hourIn = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: true }).format(at(iso));
  is("CONTROL: the same UTC instant-of-day is 6 PM after the change and 7 PM before",
    [hourIn("2026-11-02T00:30:00Z"), hourIn("2026-10-31T00:30:00Z")], ["6 PM", "7 PM"]);
  /* AND THE DIVISOR FOLLOWS. 00:30Z on 2 Nov is still 1 November in Chicago, so November has no
   * completed day; a UTC reading would have called it the 2nd and divided by one. */
  is("November has no completed day at 2026-11-02T00:30Z", daysElapsed(NOV, 2026, at("2026-11-02T00:30:00Z")), { days: 0, of: 30, partial: true });
  yes("CONTROL: the runtime's own date would have said the 2nd", at("2026-11-02T00:30:00Z").getUTCDate() === 2);
  /* SPRING FORWARD TOO, so the helper is not merely tuned to one direction. 8 March 2026. */
  is("2026-03-08T06:30Z is 8 Mar in Chicago (spring forward)", todayBusinessDate(at("2026-03-08T06:30:00Z")), "2026-03-08");
  is("…and businessYesterday across it is the 7th", businessYesterday(at("2026-03-08T06:30:00Z")), "2026-03-07");
}

console.log("\n— 7. every call site agrees, because they share one clock —");
{
  /* The route calls daysElapsed three times (lines 135, 155, 177) off a single `now` read once at
   * the top. Same function, same argument, same answer — asserted so a future refactor cannot give
   * one of them its own clock and leave the chart disagreeing with the table by a day. */
  const now = at("2026-10-16T04:30:00Z");   // 23:30 Chicago, 15 Oct
  const three = [daysElapsed(OCT, 2026, now), daysElapsed(OCT, 2026, now), daysElapsed(OCT, 2026, now)];
  is("the three reads are identical", new Set(three.map((x) => JSON.stringify(x))).size, 1);
  is("…and they are the Chicago answer, not the runtime's", three[0].days, 14);
  /* CONTROL: the numerator's cutoff comes off the SAME instant and lands one day behind the
   * divisor. Divisor 14 completed days means the 14 days through the 14th, so the cutoff is the
   * 14th. If these ever drift apart the average is over the wrong window. */
  is("CONTROL: the cutoff is the last of those completed days", businessYesterday(now), "2026-10-14");
  const [, , d] = businessYesterday(now).split("-").map(Number);
  is("CONTROL: cutoff day-of-month equals the divisor", d, three[0].days);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
