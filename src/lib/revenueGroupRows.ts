// THE REVENUE PAGE'S CITY AND FIELD ROWS — one builder, two grains, two bases.
//
// WHY IT IS A MODULE AND NOT A FUNCTION INSIDE RevenueSection.tsx. Two reasons, and the second is
// the load-bearing one. (1) Export has to describe the table it was clicked on, so the render and
// the CSV call the same thing. (2) The component imports a CSS module, so nothing can load it
// outside a bundler — the arithmetic here is the part worth asserting, and in the component it
// was unreachable from a node suite. See scripts/revenue-city-basis-test.ts.
//
// ── THE TWO BASES, AND WHY NEITHER IS "THE" ONE ───────────────────────────────────────────────
//
//   CITY GRAIN   fin_revenue, split by `type`. TAX-INCLUSIVE, dated by the Stripe charge. A city
//                IS a fin_revenue row, so both money columns come from the table the summary
//                cards read and the Total reconciles to the card by construction.
//   FIELD GRAIN  the roster walk (venuePartnerRevenueFor) plus the allocated member slice.
//                PRE-TAX, dated by kick-off. fin_revenue carries a venue NAME string, no field id
//                and no match id at all, so the ledger cannot reach this grain and never will.
//
// THEY DO NOT RECONCILE TO EACH OTHER AND MUST NOT BE MADE TO. Measured on Aug 2026, the same
// month end to end: $72,888.22 collected against $66,797.00 of roster DPP, and the $6,091.22
// between them is sales tax (+$5,104.10), credit spent at checkout (-$5,330.30), charges on
// matches that were later cancelled (+$5,368.36), absent and promo rows (+$569.32), and charge
// month against match month (+$18.94). Every one of those is a real difference between "money
// collected" and "play that happened". Forcing a tie would mean picking one and mislabelling it.
//
// ── WHAT WAS WRONG BEFORE ─────────────────────────────────────────────────────────────────────
//
// FieldMonth.revenue is `venuePartnerRevenueFor(...) + (memberSlice(...) ?? 0)` and this table put
// the whole figure in a cell headed DPP REVENUE, then added membership AGAIN beside it on a
// different basis. Aug 2026: $14,099.07 of pre-tax allocated membership inside the DPP column,
// plus $18,930.43 of tax-inclusive membership next to it, for a Total of $100,183.81 against
// $91,818.65 of money actually collected. Member mix divided by that total.

import { isCityHidden } from "./types";
import { CITY_DISPLAY_ORDER, type CityRevenueSplit, type Q2Month } from "./financeStats";
import type { FieldMonth, MatchRow } from "./fieldEconomics";

/* ── THE ROWS, BUILT ONCE, RENDERED AND EXPORTED FROM THE SAME CALL ─────────────────────────────
 * Extracted from GroupTable's body unchanged so that Export cannot describe a different table
 * than the one on screen. The CSV used to walk `shownFields` itself — the roster walk, at both
 * grains — so a city export carried roster figures while the city table carried ledger ones, and
 * nothing said which was which. That is the same failure this whole change is about, one file
 * further down. Match View already reports what it is showing (onPanelShown); this is that rule
 * applied to the other two grains.
 *
 * PURE, and returns null for "nothing here" rather than rendering it — the caller decides what
 * empty looks like. */
export type GroupRowsArgs = {
  rows: FieldMonth[]; matchRows: MatchRow[]; grain: "city" | "field"; month: Q2Month;
  membershipOf: (city: string) => number; membershipScoped: boolean;
  cityNonMembershipOf: ((city: string) => CityRevenueSplit) | null;
};
export type GroupRow = {
  label: string; city: string; venues: Set<string>; keys: Set<string>;
  matches: number; dpp: number; membership: number | null; total: number; venueCount: number;
};
export type GroupTotals = { venues: number; matches: number; total: number; dpp: number; membership: number | null };

export function buildGroupRows(
  { rows, matchRows, grain, month, membershipOf, membershipScoped, cityNonMembershipOf }: GroupRowsArgs,
): { list: GroupRow[]; T: GroupTotals; dppSplit: { type: string; gross: number }[] } | null {
  const scoped = rows.filter((r) => r.month === month);
  if (scoped.length === 0) return null;

  const keyed = new Map<string, { label: string; city: string; venues: Set<string>; keys: Set<string>; matches: number; dpp: number }>();
  for (const r of scoped) {
    const label = grain === "city" ? r.city : r.field;
    let e = keyed.get(label);
    if (!e) { e = { label, city: r.city, venues: new Set(), keys: new Set(), matches: 0, dpp: 0 }; keyed.set(label, e); }
    e.venues.add(r.field);
    e.keys.add(r.key);   // FieldMonth.key === MatchRow.fieldKey — the join, on an id
    e.matches += r.matches;
    /* ── MINUS THE MEMBER SLICE, AND THAT SUBTRACTION IS THE POINT ────────────────────────────
     * `FieldMonth.revenue` is `venuePartnerRevenueFor(...) + (memberSlice(...) ?? 0)`
     * (fieldEconomics.ts:431). That addition is CORRECT and stays: Finance › Cost divides a
     * venue's cost into ALL the revenue that venue carried, and dividing into DPP alone read
     * Dallas at 184.0%. What was wrong is that this table put the whole figure in a cell headed
     * DPP REVENUE, and then added membership again alongside it.
     *
     * MEASURED, Aug 2026: $14,099.07 of allocated membership inside a $81,296.07 "DPP" column,
     * and the Total carried it twice — once pre-tax here and once tax-inclusive beside it
     * ($18,930.43) — for a Total of $100,183.81 against $91,818.65 of money collected.
     *
     * THE SUBTRACTION IS HERE, NOT IN fieldEconomics. Cost reads that module and needs the sum;
     * this table is the consumer that needed the parts. Fixing it upstream would move the bug
     * onto the cost ratio. `?? 0` is right in THIS direction: a null slice means nothing was
     * added, so nothing is taken away.
     *
     * PRIVATE RENTAL STAYS IN. It is not membership, it is money the pitch took, and at city
     * grain the ledger figure includes it too — so both grains mean the same thing by this
     * column: everything that is not membership. The DPP popover names what is in there. */
    e.dpp += r.revenue - (r.membership ?? 0);
  }
  /* ── A CITY WITH LEDGER REVENUE AND NO VENUE-MONTH ROW STILL GETS A ROW ──────────────────────
   * `scoped` comes from the venue table, so a city whose money did not land at a mapped venue
   * this month would have no row at all and its revenue would disappear into the remainder with
   * nothing on screen saying so. At city grain the row set is the union, and the added rows
   * carry 0 venues and 0 matches because that is what is true of them. */
  if (grain === "city" && cityNonMembershipOf) {
    for (const c of CITY_DISPLAY_ORDER) {
      if (isCityHidden(c) || keyed.has(c)) continue;
      if (cityNonMembershipOf(c).gross <= 0 && membershipOf(c) <= 0) continue;
      keyed.set(c, { label: c, city: c, venues: new Set(), keys: new Set(), matches: 0, dpp: 0 });
    }
  }

  // The month's allocated member revenue and member spots, per field group.
  /* A NULL ALLOCATION IS NOT A ZERO, AND MUST NOT BE ADDED AS ONE. `?? 0` here printed $0 against
   * pitches with real member spots whenever the city had no prior-month rate — including for the
   * second or two before the member-spot data lands, where every pitch on the page read $0. A row
   * whose member revenue is unknown says so; `noRate` carries that up. */
  const memberByKey = new Map<string, { rev: number; spots: number; noRate: boolean }>();
  for (const m of matchRows) {
    if (m.month !== month) continue;
    const e = memberByKey.get(m.fieldKey) ?? { rev: 0, spots: 0, noRate: false };
    if (m.memberRevenue == null) e.noRate = true;
    else e.rev += m.memberRevenue;
    e.spots += m.memberSpots;
    memberByKey.set(m.fieldKey, e);
  }
  /* MEMBERSHIP IS number | null, AND THE DIFFERENCE IS THE POINT. null renders —, and means "no
   * basis to allocate on". 0 would mean "we allocated and it came to nothing", which is a claim
   * this table cannot make about a pitch no member played at. This mirrors cityPnl, where a pitch
   * with no spot data gets null and never 0.
   *
   * FIELD GRAIN: null when the pitch had NO MEMBER SPOTS this month — including when the whole
   * city has no member-spot data, in which case every allocation is 0 and printing $0 across a
   * column would read as a measurement. */
  const list = [...keyed.values()].map((e) => {
    let membership: number | null;
    if (grain === "city") {
      membership = membershipScoped ? membershipOf(e.city) : null;
      /* THE LEDGER REPLACES THE ROSTER WALK ENTIRELY AT THIS GRAIN — it does not adjust it. The
       * two figures now come from one table, one month key and one `type` split, which is what
       * makes `dpp + membership = this city's gross` true by construction rather than by
       * arithmetic that has to be kept in step. */
      if (cityNonMembershipOf) e.dpp = cityNonMembershipOf(e.city).gross;
    } else {
      let rev = 0, spots = 0, noRate = false;
      for (const k of e.keys) { const m = memberByKey.get(k); if (m) { rev += m.rev; spots += m.spots; if (m.noRate) noRate = true; } }
      membership = noRate || spots === 0 ? null : rev;
    }
    const total = e.dpp + (membership ?? 0);
    return { ...e, membership, total, venueCount: e.venues.size };
  }).sort((a, b) => b.total - a.total);

  const T = list.reduce((a, r) => ({
    venues: a.venues + r.venueCount, matches: a.matches + r.matches,
    total: a.total + r.total, dpp: a.dpp + r.dpp,
    // The total sums the rows that HAVE a figure. If none does, it stays null and prints — as they
    // all do; summing nulls to 0 would invent a total the rows above it never claimed.
    membership: r.membership == null ? a.membership : (a.membership ?? 0) + r.membership,
  }), { venues: 0, matches: 0, total: 0, dpp: 0, membership: null as number | null });

  /* WHAT IS ACTUALLY IN THE DPP COLUMN, this month, at this grain. Built from the same figures
   * the column is built from, so it cannot describe a different number than the one beside it.
   * Empty renders no ⓘ at all — there is nothing to disclose on a month with no revenue. */
  const dppSplit: { type: string; gross: number }[] = (() => {
    if (grain === "city" && cityNonMembershipOf) {
      const byType = new Map<string, number>();
      for (const e of list) {
        for (const t of cityNonMembershipOf(e.city).byType) {
          byType.set(t.type, (byType.get(t.type) ?? 0) + t.gross);
        }
      }
      return [...byType.entries()].map(([type, gross]) => ({ type, gross }))
        .filter((t) => Math.abs(t.gross) > 0.005).sort((a, b) => b.gross - a.gross);
    }
    /* FIELD GRAIN NAMES ITS OWN TWO PARTS. The roster walk and Private Rental are different
     * kinds of money — one has matches behind it and one has no match at all — and the column
     * adds them, so it says so here rather than leaving the reader to find the $400. */
    const rental = scoped.reduce((a, r) => a + r.privateRental, 0);
    const gate = scoped.reduce((a, r) => a + (r.revenue - (r.membership ?? 0) - r.privateRental), 0);
    return [{ type: "Daily paid, from the roster", gross: gate },
            { type: "Private Rental", gross: rental }]
      .filter((t) => Math.abs(t.gross) > 0.005).sort((a, b) => b.gross - a.gross);
  })();

  return { list, T, dppSplit };
}

