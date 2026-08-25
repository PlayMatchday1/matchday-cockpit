import "server-only"; // no-op under --conditions=react-server
// FINANCE › COST — realized on both sides, and nothing reads an override.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/cost-realized-test.ts
//
// WHY A SUITE FOR THIS. The Cost page's whole argument is that its ratio compares the SAME
// matches on both sides. Two things can silently break that and neither is visible on screen:
//
//   1. READING THE WALL CLOCK AS AN INSTANT. mdapi start_date carries a Z it does not mean. A
//      match at 7pm Austin time is stamped 19:00Z and is "past" five hours before it kicks off,
//      so tonight's fixtures bill all afternoon. That exact bug has shipped three times. The
//      fixtures below make the wall clock and the true instant DISAGREE on purpose, so a reader
//      of the wrong field fails here rather than in production.
//
//   2. AN OVERRIDE CREEPING BACK IN. An override is a billing-timing lump — Soccer Central's
//      $5,600 covering three months — and this page derives from a rate instead. A helper that
//      quietly checked overrides again would make a month's ratio a fact about when an invoice
//      arrived. The fixtures key an override that is 100× the derived figure, so any path that
//      reads one is unmissable.

import { buildFieldMonths, hasKickedOff, realizedRegistrations } from "../src/lib/fieldEconomics";
import type { FinanceData } from "../src/lib/useFinanceData";
import type { JoinedMatchPlayerRow } from "../src/lib/mdapiMatchesRead";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// THE TRAP, BUILT ON PURPOSE. The pitch is US Central (UTC-5) and it is 20:00 UTC — 3pm on the
// pitch. Tonight's 7pm fixture is SIX HOURS OUT, but mdapi stamps its wall clock "19:00Z", which
// read as an instant is an hour AGO. So the two readings disagree, and disagree in the direction
// that bills a match nobody has played.
const NOW = Date.parse("2026-08-25T20:00:00Z");
const PAST_UTC = "2026-08-25T15:00:00.000Z";   // 10am Central — genuinely played
const FUTURE_UTC = "2026-08-26T00:00:00.000Z"; // 7pm Central  — genuinely not yet
const WALL_LOOKS_PAST = "2026-08-25T19:00:00.000Z"; // the SAME 7pm match's wall clock, wearing a fake Z

console.log("\nTHE PREDICATE — the true instant, never the wall clock");
{
  is("a match six hours out has NOT kicked off", hasKickedOff({ startUtcMs: Date.parse(FUTURE_UTC) }, NOW), false);
  is("...and the fixture is a real trap: that match's WALL CLOCK reads an hour ago",
     Date.parse(WALL_LOOKS_PAST) < NOW, true);
  is("...so a reader of the wall clock would have called it played", hasKickedOff({ startUtcMs: Date.parse(WALL_LOOKS_PAST) }, NOW), true);
  is("CONTROL — the same shape with a real past instant HAS kicked off", hasKickedOff({ startUtcMs: Date.parse(PAST_UTC) }, NOW), true);
  is("an unknown instant is NOT past — absence is not evidence of play", hasKickedOff({ startUtcMs: null }, NOW), false);
  is("the boundary instant itself counts as kicked off", hasKickedOff({ startUtcMs: NOW }, NOW), true);
}

console.log("\nTHE REGISTRATION CUT — same predicate, applied before the revenue helper sees it");
{
  // Each row carries BOTH readings, disagreeing. `matchStart` is the wall-clock Date a careless
  // implementation would reach for; `matchStartUtcIso` is the true instant this one must use.
  const reg = (utcIso: string, wallIso: string, amount: number): JoinedMatchPlayerRow =>
    ({ matchStartUtcIso: utcIso, matchStart: new Date(wallIso), matchPricePaid: amount } as unknown as JoinedMatchPlayerRow);
  const played = reg(PAST_UTC, PAST_UTC, 12.34);
  const trap = reg(FUTURE_UTC, WALL_LOOKS_PAST, 19.99);   // wall clock past, true instant six hours out
  const cut = realizedRegistrations([played, trap], NOW);
  is("the trap row is dropped — its true instant has not arrived", cut.length, 1);
  is("...specifically the trap, not the played one", cut[0]?.matchStartUtcIso, PAST_UTC);
  is("...and a wall-clock reader would have kept it, which is the bug", trap.matchStart.getTime() < NOW, true);
  is("null means NO CUT — both rows back", realizedRegistrations([played, trap], null).length, 2);
  is("...so the cut above is doing work, not receiving a one-row input", cut.length < 2, true);
}

// ── a minimal FinanceData, hand-built so every figure below is arithmetic a reader can check ──
type Sched = { id: string; venue_id: number | null; month: string; category: string; start_utc_ms: number | null; mdapi_field_id: number | null; match_date: string; match_time: string };
const sched = (id: string, venueId: number, utc: string | null, cat = "regular"): Sched => ({
  id, venue_id: venueId, month: "Aug 2026", category: cat,
  start_utc_ms: utc == null ? null : Date.parse(utc),
  mdapi_field_id: 1, match_date: "2026-08-25", match_time: `7:00 PM - 8:00 PM ${id}`,
});

function financeData(over: Partial<Record<string, unknown>> = {}): FinanceData {
  const venue = (id: number, name: string, billing: string, extra: Record<string, unknown> = {}) => ({
    id, venue_name: name, raw_venue_name: name, city: "Austin", billing_type: billing,
    per_match_rate: 100, cost_per_match: 40, charge_on_cancel: false, bills_per_reservation: false,
    is_active: true, hourly_rate: null, monthly_flat: null, max_spots: 20, dpp_price: 12,
    member_price: null, notes: null, launch_date: null, ...extra,
  });
  return {
    venues: [
      venue(1, "Rate Pitch", "per_match"),
      venue(2, "Share Pitch", "profit_share", { per_match_rate: null, cost_per_match: null }),
      venue(3, "Flat Pitch", "monthly_flat"),
      venue(4, "No Basis Pitch", "per_match", { per_match_rate: null, cost_per_match: null }),
    ],
    masterSchedule: [
      sched("m1", 1, PAST_UTC), sched("m2", 1, PAST_UTC), sched("m3", 1, FUTURE_UTC),
      sched("s1", 2, PAST_UTC), sched("f1", 3, PAST_UTC), sched("n1", 4, PAST_UTC),
    ],
    cancelledSchedule: [],
    // AN OVERRIDE 100× THE DERIVED FIGURE. Any path that reads one is unmissable.
    overrides: [
      { id: 1, venue_id: 1, month: "Aug 2026", override_amount: 8000, reason: "lump", created_at: "", created_by: "" },
      { id: 2, venue_id: 2, month: "Aug 2026", override_amount: 9000, reason: "lump", created_at: "", created_by: "" },
      { id: 3, venue_id: 3, month: "Aug 2026", override_amount: 7000, reason: "flat", created_at: "", created_by: "" },
    ],
    partnerDashboards: [{ venueId: 2, revenueSharePct: 50, revenueModel: "flat_percentage", enabled: true }],
    partnerPayoutsByVenueMonth: new Map([["2|Aug 2026", 250]]),
    revenue: [], expenses: [], managerPay: [], pricing: [], memberSpots: [], members: [],
    venueAliases: new Map(), venueFields: new Map(), venueFieldLinks: [], config: {},
    mdapiMemberSpots: { byCityMonth: new Map(), byMatch: new Map() },
    ...over,
  } as unknown as FinanceData;
}

const MONTH = "Aug 2026" as never;
const rowFor = (name: string, d = financeData(), reg: JoinedMatchPlayerRow[] = [], cut: number | null = NOW) =>
  buildFieldMonths(d, reg, [MONTH], cut).find((r) => r.field === name)!;

console.log("\nEVERY ROW DERIVES FROM A RATE, AND NEVER FROM AN OVERRIDE");
{
  const r = rowFor("Rate Pitch");
  is("2 of the 3 scheduled matches have kicked off", r.matches, 2);
  is("cost is cost_per_match × REALIZED matches = 40 × 2", r.cost, 80);
  is("...NOT the $8,000 override keyed for the month", r.cost !== 8000, true);
  is("...and NOT 40 × 3, which would bill a match still to be played", r.cost !== 120, true);
  const uncut = rowFor("Rate Pitch", financeData(), [], null);
  is("CONTROL — with no cut the third match IS billed: 40 × 3", uncut.cost, 120);
  is("...so the fixture really does contain a future match", uncut.matches, 3);
}
console.log("\nA SHARE VENUE USES ITS MODEL, AND THE OVERRIDE IS NOT IT");
{
  const r = rowFor("Share Pitch");
  is("cost is the partner dashboard's own owed", r.cost, 250);
  is("...not the $9,000 override", r.cost !== 9000, true);
  is("...and not cost_per_match × n, which is null for this venue anyway", r.basis, "profit_share");
}
console.log("\nA FLAT VENUE HAS NO RATE TO MULTIPLY, SO IT IS A DASH");
{
  const r = rowFor("Flat Pitch");
  is("cost is NULL — unknown, never 0", r.cost, null);
  is("...and specifically not the $7,000 override", r.cost !== 7000, true);
}
console.log("\nNO BASIS ON FILE IS STILL A DASH, NOT A FREE PITCH");
{
  is("a per_match venue with neither rate column reads NULL", rowFor("No Basis Pitch").cost, null);
}

console.log("\nBOTH SIDES OF THE RATIO COUNT THE SAME MATCHES");
{
  const reg = (utc: string, amount: number, fieldId = 1): JoinedMatchPlayerRow =>
    ({ matchStartUtcIso: utc, matchStart: new Date(utc), matchPricePaid: amount, paymentType: "DAILY PAID",
       matchCanceled: false, email: "p@example.com", fieldId, matchApiId: 1 } as unknown as JoinedMatchPlayerRow);
  const d = financeData({ venueFields: new Map([[1, 1]]) });
  const regs = [reg(PAST_UTC, 60), reg(FUTURE_UTC, 500)];
  const r = rowFor("Rate Pitch", d, regs, NOW);
  is("only the played match's money is in revenue", r.revenue, 60);
  is("...so the ratio is 80/60, not 80/560", Math.round((r.cost! / r.revenue) * 1000) / 1000, 1.333);
  const uncut = rowFor("Rate Pitch", d, regs, null);
  is("CONTROL — uncut, the future match's $500 IS counted", uncut.revenue, 560);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
