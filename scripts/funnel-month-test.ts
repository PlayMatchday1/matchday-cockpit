/* THE FUNNEL'S CURRENT MONTH, AND THE ONE WRONG DAY A MONTH IT USED TO HAVE.
 *
 * Two decisions carry this and neither is visible in the DOM: that the clamp is to the CALENDAR
 * rather than to the data (the booking horizon moves, so there is no offset to subtract), and that
 * it reads the BUSINESS timezone rather than UTC (on the 1st those disagree for a few hours).
 */
import { clampMonthsToNow, currentFunnelMonth, businessMonthKey } from "@/lib/funnelMonth";
import { BUSINESS_TZ } from "@/lib/businessHours";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

console.log("\n— the live axis shape, from prod 2026-09-27 —");
{
  /* THE REAL AXIS as measured: 2023-04 through 2026-10, with Chicago in 2026-09. The last three are
   * all that matter to the assertion; the floor is carried so the filter is not trivially short. */
  const axis = ["2023-04", "2026-07", "2026-08", "2026-09", "2026-10"];
  const sept = new Date("2026-09-27T12:00:00Z");
  is("the current month is September, not the booked October",
    currentFunnelMonth(axis, sept), "2026-09");
  /* CONTROL: THE PREVIOUS ROW MOVED WITH IT. A relabel would leave the second row on September,
   * which is the only thing separating this fix from a cosmetic patch. */
  const kept = clampMonthsToNow(axis, sept);
  is("  CONTROL: and the month before it is August, not September",
    kept[kept.length - 2], "2026-08");
  yes("  CONTROL: October appears nowhere in the kept months", !kept.includes("2026-10"), kept.join(","));
  is("  CONTROL: and nothing below the top was dropped", kept.length, axis.length - 1);
  is("  CONTROL: the floor survives, so the filter is not simply truncating",
    kept[0], "2023-04");
}

console.log("\n— the ceiling moves with the booking horizon, so the clamp is to the calendar —");
{
  const sept = new Date("2026-09-27T12:00:00Z");
  /* ONE MONTH OUT TODAY, TWO THE DAY A NOVEMBER MATCH IS BOOKED. A fix that subtracted one month
   * would be right today and wrong then, which is why there is no offset anywhere in this file. */
  is("one booked month ahead clamps to September",
    currentFunnelMonth(["2026-08", "2026-09", "2026-10"], sept), "2026-09");
  is("  and THREE booked months ahead still clamps to September",
    currentFunnelMonth(["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"], sept), "2026-09");
  is("  CONTROL: with no future months at all it is still September",
    currentFunnelMonth(["2026-08", "2026-09"], sept), "2026-09");
  /* AND IT DOES NOT INVENT A MONTH. An axis that stops short of now returns what it has. */
  is("an axis ending before now returns its own last month",
    currentFunnelMonth(["2026-06", "2026-07"], sept), "2026-07");
  is("  CONTROL: an all-future axis yields nothing rather than a phantom",
    currentFunnelMonth(["2026-11", "2026-12"], sept), null);
  is("  CONTROL: and an empty axis yields nothing", currentFunnelMonth([], sept), null);
}

console.log("\n— BUSINESS_TZ, and the one wrong day a month —");
{
  is("the business zone is Chicago", BUSINESS_TZ, "America/Chicago");
  /* THE ASSERTION THAT MATTERS. 2026-10-01T02:00Z is the 1st of OCTOBER in UTC and still
   * 2026-09-30 21:00 in Chicago. A UTC clamp would admit October; the business clamp must not.
   * This is the identical defect the Daily Matches divisor had. */
  const utcOctChiSept = new Date("2026-10-01T02:00:00Z");
  is("at 02:00Z on 1 October, Chicago is still in September",
    businessMonthKey(utcOctChiSept), "2026-09");
  is("  so the funnel's current month is September, not October",
    currentFunnelMonth(["2026-09", "2026-10"], utcOctChiSept), "2026-09");
  /* CONTROL: THE NAIVE UTC READING DISAGREES, which is what proves the zone is doing work. If both
   * agreed here the assertion above would pass with the timezone ripped out. */
  is("  CONTROL: the UTC month at that instant IS October, so the zone is load-bearing",
    utcOctChiSept.toISOString().slice(0, 7), "2026-10");
  /* AND ONCE CHICAGO CROSSES, OCTOBER IS ALLOWED. Without this the rule would be "never admit the
   * newest month", which is a different and wrong rule. */
  const chiOct = new Date("2026-10-01T12:00:00Z");
  is("at midday on 1 October Chicago has crossed, and October is current",
    currentFunnelMonth(["2026-09", "2026-10"], chiOct), "2026-10");
  /* DST, BOTH SIDES OF IT. Chicago is UTC-5 in July and UTC-6 in January, and a fixed offset would
   * be wrong for half the year. Retool hardcodes -06:00 and is an hour wrong from March to November. */
  is("July: 2026-08-01T04:30Z is still July in Chicago (UTC-5)",
    businessMonthKey(new Date("2026-08-01T04:30:00Z")), "2026-07");
  is("January: 2026-02-01T05:30Z is still January in Chicago (UTC-6)",
    businessMonthKey(new Date("2026-02-01T05:30:00Z")), "2026-01");
  is("  CONTROL: an hour later in January, Chicago has crossed",
    businessMonthKey(new Date("2026-02-01T06:30:00Z")), "2026-02");
  yes("  CONTROL: a fixed -06:00 would get the July case wrong",
    new Date("2026-08-01T04:30:00Z").getTime() - 6 * 3600_000 < new Date("2026-08-01T00:00:00Z").getTime());
}

console.log("\n— month keys compare as strings, which is why no Date is built from them —");
{
  yes("YYYY-MM is zero padded, so string order is calendar order", "2026-09" < "2026-10");
  yes("  and it holds across a year boundary", "2026-12" < "2027-01");
  /* THE TRAP AVOIDED: new Date("2026-09") is parsed as UTC midnight, so a Chicago reader is still in
   * August. Nothing in funnelMonth constructs a Date from a month key. */
  is("CONTROL: new Date on a month key lands in the PREVIOUS month in Chicago",
    businessMonthKey(new Date("2026-09")), "2026-08");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
