import "server-only"; // no-op under --conditions=react-server
// FINANCE › CITIES — the table adds up (Ryan, 2026-10-10; replaces scripts/e2e/verify-citypnl-redesign.mjs).
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/cities-sums-test.ts
//
// TWO SUMS THE PAGE PRINTS AND A READER CHECKS BY EYE, asserted on a fixed fixture through the code
// the page runs (computeCityPnl and citiesTotal), under every Basis option:
//   1. Each city's field rows plus its "No field" row equal the city's revenue and field cost.
//   2. The city rows plus Unassigned equal the All cities total.
// Revenue arrives the way the page hands it in (CityRevenue: the Revenue page's net, in dollars), so
// the fixture states it directly; cost comes from a hand-built FinanceData whose figures are
// arithmetic a reader can check (a $40 rate × 2 played matches; a $250 partner payout).
import { citiesTotal, computeCityPnl, type CityCostMode, type CityCostScope, type CityRevenue } from "../src/lib/cityPnl";
import { emptyMdapiMemberSpotIndex } from "../src/lib/financeStats";
import type { FinanceData } from "../src/lib/useFinanceData";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const cents = (v: number) => Math.round(v * 100);

const NOW = new Date("2026-08-25T20:00:00Z");
const PLAYED = Date.parse("2026-08-25T15:00:00Z");
const MONTH = "Aug 2026";

// ── THE FIXTURE ──────────────────────────────────────────────────────────────────────────────
// Austin: "Rate Pitch" ($40 a match, two played) and "No Basis Pitch" (no rate on file), plus
// $250.10 of revenue at no pitch. Houston: "Share Pitch" (partner payout $250), plus $20 at no pitch.
const venue = (id: number, name: string, city: string, billing: string, extra: Record<string, unknown> = {}) => ({
  id, venue_name: name, raw_venue_name: name, city, billing_type: billing,
  per_match_rate: 40, cost_per_match: 40, charge_on_cancel: false, bills_per_reservation: false,
  is_active: true, hourly_rate: null, monthly_flat: null, max_spots: 20, dpp_price: 12,
  member_price: null, notes: null, launch_date: null, ...extra,
});
const sched = (id: string, venueId: number) => ({
  id, venue_id: venueId, month: MONTH, category: "regular", start_utc_ms: PLAYED,
  mdapi_field_id: 1, match_date: "2026-08-25", match_time: `10:00 AM - 11:00 AM ${id}`,
});
const data = {
  venues: [
    venue(1, "Rate Pitch", "Austin", "per_match"),
    venue(4, "No Basis Pitch", "Austin", "per_match", { per_match_rate: null, cost_per_match: null }),
    venue(2, "Share Pitch", "Houston", "profit_share", { per_match_rate: null, cost_per_match: null }),
  ],
  masterSchedule: [sched("m1", 1), sched("m2", 1), sched("n1", 4), sched("s1", 2)],
  cancelledSchedule: [], overrides: [],
  partnerDashboards: [{ venueId: 2, revenueSharePct: 50, revenueModel: "flat_percentage", enabled: true }],
  partnerPayoutsByVenueMonth: new Map([["2|Aug 2026", 250]]),
  revenue: [], expenses: [], managerPay: [], pricing: [], memberSpots: [], members: [],
  venueAliases: new Map(), venueFields: new Map(), venueFieldLinks: [], config: {},
  mdapiMemberSpots: emptyMdapiMemberSpotIndex(),
} as unknown as FinanceData;

const REV: Record<string, { net: number; membership: number; venues: Record<number, { net: number; membership: number }> }> = {
  Austin: { net: 1000.25, membership: 300, venues: { 1: { net: 600.10, membership: 200 }, 4: { net: 150.05, membership: 50 } } },
  Houston: { net: 500, membership: 0, venues: { 2: { net: 480, membership: 0 } } },
};
const UNASSIGNED = 33.33;
const revenueOf = (city: string): CityRevenue => ({
  cityNet: REV[city].net, cityMembership: REV[city].membership,
  venueNet: (ids) => ids.reduce((a, id) => {
    const v = REV[city].venues[id];
    return v ? { net: a.net + v.net, membership: a.membership + v.membership } : a;
  }, { net: 0, membership: 0 }),
});

const BASES: [CityCostMode, CityCostScope][] = [["per_match", "realized"], ["per_match", "fullMonth"], ["as_billed", "realized"], ["as_billed", "fullMonth"]];
for (const [mode, scope] of BASES) {
  console.log(`\nBASIS ${mode} · ${scope}`);
  const rows = ["Austin", "Houston"].map((c) => computeCityPnl(data, revenueOf(c), c, [MONTH as never], mode, scope, NOW));
  for (const k of rows) {
    const fieldRev = k.fields.reduce((a, f) => a + cents(f.totalRev), 0);
    const fieldCost = k.fields.reduce((a, f) => a + (f.cost == null ? 0 : cents(f.cost)), 0);
    is(`${k.city}: field rows + No field = city revenue`, fieldRev + cents(k.noFieldRev), cents(k.gross));
    is(`${k.city}: field rows' cost = city field cost`, fieldCost, cents(k.fieldCost));
  }
  const austin = rows[0], houston = rows[1];
  // POSITIVE CONTROLS: the sums above are over real, non-trivial rows — not two empty sets agreeing.
  is("  control: Austin carries both pitches", austin.fields.length, 2);
  is("  control: Austin's revenue is the fixture's", cents(austin.gross), cents(1000.25));
  is("  control: Austin's No field is non-zero ($250.10)", cents(austin.noFieldRev), 25010);
  is("  control: the unmapped pitch has no cost, not $0", austin.fields.find((f) => f.venue === "No Basis Pitch")?.cost ?? "null", "null");
  is("  control: the share pitch costs its payout", houston.fields[0]?.cost, 250);
  is("  control: WITHOUT the No field row, Austin's fields do NOT reach its revenue",
    austin.fields.reduce((a, f) => a + cents(f.totalRev), 0) === cents(austin.gross), false);
  if (mode === "per_match" && scope === "realized") is("  control: Austin's field cost is $40 × 2 played", austin.fieldCost, 80);

  const T = citiesTotal(rows, UNASSIGNED);
  is("All cities revenue = city rows + Unassigned", cents(T.total), cents(1000.25) + cents(500) + cents(UNASSIGNED));
  is("All cities field cost = the city rows'", cents(T.cost), cents(austin.fieldCost) + cents(houston.fieldCost));
  is("All cities expenses = the city rows'", cents(T.over), cents(austin.overheadTotal) + cents(houston.overheadTotal));
  is("All cities profit = city rows + Unassigned", cents(T.net), cents(austin.net) + cents(houston.net) + cents(UNASSIGNED));
  is("  control: without Unassigned the total is short by exactly it", cents(citiesTotal(rows, 0).total), cents(T.total) - cents(UNASSIGNED));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
