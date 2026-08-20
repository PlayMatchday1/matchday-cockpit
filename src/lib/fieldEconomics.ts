// FIELD ECONOMICS — the ONE derivation behind both /admin/finance/revenue and
// /admin/finance/cost.
//
// WHY THIS FILE EXISTS. Two derivations of "what a field cost" were already in the tree and they
// do not agree:
//
//   canonicalVenueCost (financeCosts.ts) — override, then per_match_rate × matches, then the
//     partner dashboard's own owed for a share venue, then "needs override".
//   groupPerMatchCostFor (financeStats.ts) — cost_per_match × charged matches, share venues still
//     routed to the partner dashboard.
//   matchPnL.ts — venue.cost_per_match, unconditionally, FOR EVERY BILLING TYPE.
//
// The first two are the estate's two deliberate bases (see CostMode below) and both are correct
// in their own mode. THE THIRD IS NOT A BASIS, IT IS A BUG: it reads cost_per_match for a
// profit_share venue, and Crossbar Rowlett carries a PLACEHOLDER ZERO there. A Field Cost column
// fed from matchPnL renders $0 for a venue whose real cost is the partner payout. A zero is a
// claim. So the money pages route through this file and never through matchPnL's cost.
//
// A COST IS NULL, NEVER ZERO, WHEN IT IS NOT RECORDED. `cost: null` means "no basis on file" and
// renders as a dash, is held out of every ratio, and shows up in the cost-not-recorded list. A
// genuine $0 — Carroll Senior HS is billed per_match at a real rate of $0 — is a number and
// renders as one. The two are different facts and the type keeps them apart.
//
// UNITS ARE DOLLARS. mdapiMatchesRead converts player.amount (cents) to dollars at the read
// boundary and fin_revenue.gross is already dollars, so everything downstream of FinanceData is
// dollars. Nothing here divides by 100 and nothing here should.
//
// MONTH KEYS are Q2Month — "Aug 2026" — the same string financeStats uses.

import { canonicalVenueCost, isEventSchedule, type VenueCostKind } from "./financeCosts";
import {
  cityMembershipRevenueFor,
  groupPerMatchCostFor,
  venuePartnerRevenueFor,
  type Q2Month,
} from "./financeStats";
import { normalizeCity } from "./cityMap";
import { groupVenues, type VenueGroup } from "./venueGroups";
import { isCityHidden } from "./types";
import { getQuarterByKey, type QuarterInfo } from "./quarters";
import type { FinanceData, FinVenue } from "./useFinanceData";
import {
  hasMembershipAtMatchTime,
  type JoinedMatchPlayerRow,
  type MembershipWindowsByUserId,
} from "./mdapiMatchesRead";
import { isFakePlayerEmail } from "./mdapiFakePlayer";

// City comparison is canonical on BOTH sides. normalizeCity returns null for a name that is
// already cockpit-canonical ("Dallas" is a value, not a key), so the `?? c` fallback is
// load-bearing — dropping it collapses every city to null and the filter matches nothing.
export const canonCity = (c: string | null | undefined): string =>
  normalizeCity(c) ?? (c ?? "");

// THE THREE REAL STRUCTURES. hourly_rate is null on every row in fin_venues and no venue is
// recorded as an installation or a free-use arrangement, so those are not options here — a filter
// offering them would be offering empty sets.
export type CostBasis = "per_match" | "profit_share" | "monthly_flat";

export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  per_match: "Per match",
  profit_share: "Profit share",
  monthly_flat: "Monthly flat",
};

// Which canonical kinds mean "we do not know what this cost". Everything else is a real figure.
const UNKNOWN_KINDS: ReadonlySet<VenueCostKind> = new Set(["unknown", "needs_override"]);

// The structure a venue is billed under, independent of whether this particular month has a
// figure. per_match_minus_manager (Crossbar Rowlett) is stored as per_match but paid as a share
// of match revenue, so it reads as profit_share here — the label has to describe how the money
// actually moves, or a >100% ratio month looks like an error instead of a share month.
export function basisOf(venue: FinVenue, data: FinanceData): CostBasis {
  if (venue.billing_type === "monthly_flat") return "monthly_flat";
  if (venue.billing_type === "profit_share") return "profit_share";
  const dash = data.partnerDashboards.find((d) => d.venueId === venue.id);
  if (dash?.revenueModel === "per_match_minus_manager") return "profit_share";
  return "per_match";
}

// ===== THE TWO COST BASES =====
//
// The estate already models cost two ways, and they are different facts rather than one fact
// entered twice. Cities exposes the same pair behind its gear popover; this page uses the same
// helpers so the two cannot disagree.
//
//   AS BILLED   — what the venue INVOICED. canonicalVenueCost: an override if one exists, else
//                 per_match_rate × matches. A venue with per_match_rate = null does not invoice
//                 per match — it lump-sums, and the lumps arrive as overrides. So $0 in a month
//                 with no override is the truth: no invoice landed that month.
//   PER MATCH   — the operator's NORMALIZED unit cost. groupPerMatchCostFor: cost_per_match ×
//                 charged matches, deliberately bypassing billing-timing lumps so a venue's cost
//                 stays steady month to month. This is the basis the brief specified, and the
//                 default, matching Cities.
//
// Reading cost_per_match in as-billed mode would manufacture an invoice nobody sent; reading
// per_match_rate in per-match mode would reintroduce the lumps the mode exists to remove. Neither
// column is a fallback for the other.
export type CostMode = "per_match" | "as_billed";

// A venue group, one month, one basis. null amount ⟺ NO COST BASIS ON FILE — never 0-for-unknown.
function groupCost(
  data: FinanceData,
  group: VenueGroup,
  month: Q2Month,
  mode: CostMode,
): { amount: number | null; kind: VenueCostKind } {
  const primary = group.legs[0];
  const basis = basisOf(primary, data);

  // SHARE-LIKE IS ALWAYS THE DASHBOARD'S OWED, in either mode. Never rate × n, and never
  // cost_per_match — which is precisely what keeps Crossbar Rowlett's placeholder zero
  // unreachable instead of special-cased.
  if (basis === "profit_share" || basis === "monthly_flat" || mode === "as_billed") {
    let sum = 0;
    let known = false;
    for (const leg of group.legs) {
      const info = canonicalVenueCost(data, leg.id, month);
      if (UNKNOWN_KINDS.has(info.kind)) continue;
      // THE $0-WEARING-A-MAPPED-KIND TRAP, as-billed only: autoCost computes
      // `rate = per_match_rate ?? 0`, so a venue with no per_match_rate returns kind "per_match"
      // with amount 0 — a mapped-looking unknown. cityPnl.ts names this same trap.
      //
      // cost_per_match IS NOT PART OF THIS TEST. It was, and that was the bug: NEMP carries
      // cost_per_match $77 and no per_match_rate, so the old condition judged it "known" and
      // rendered $0 — a venue that bills monthly, reading as free. On the as-billed basis
      // cost_per_match drives nothing, so it cannot be evidence that an invoice exists.
      //
      // A MONTH VALUE STILL WINS, including one keyed at exactly $0: canonicalVenueCost returns
      // kind "override" for those, so they never reach this line. That is what keeps "keyed zero"
      // (Centennial Commons, Scissortail June — a real, deliberate $0) distinct from
      // "nothing keyed" (NEMP August — unknown, and rendered as a dash).
      if (info.kind === "per_match" && leg.per_match_rate == null) continue;
      known = true;
      sum += info.amount;
    }
    return known ? { amount: sum, kind: "override" } : { amount: null, kind: "needs_override" };
  }

  // PER-MATCH basis on a per_match venue. Unknown only when NO leg carries a unit cost in either
  // column — Carroll Senior HS stores an explicit 0 and is therefore known, and free.
  const hasUnit = group.legs.some((l) => l.cost_per_match != null || l.per_match_rate != null);
  if (!hasUnit) return { amount: null, kind: "needs_override" };
  return { amount: groupPerMatchCostFor(data, group, month), kind: "per_match" };
}

// EVENTS CARRY REVENUE BUT NO COST — and that asymmetry has to be handled, not inherited.
//
// isEventSchedule excludes tournament/combine rows from venue cost by explicit policy: an event
// is not billed as a match. But those events sell spots, and venuePartnerRevenueFor counts every
// DAILY PAID spot at the venue, event or not. Left alone, a cost ratio therefore divides
// non-event cost by ALL revenue. ATH Pearland is the case that exposes it: 2 billable matches in
// July against $16,368 of revenue, most of it from event play, giving a 2.0% ratio that says the
// pitch is nearly free when it says nothing of the kind.
//
// So event revenue is measured separately and held OUT of the ratio's denominator, leaving the
// ratio comparing the same matches on both sides. It is still reported — it is real money — just
// not used to divide a cost that was never charged against it.
//
// The join key is the mdapi api_id: FinMasterSchedule.id is String(api_id) and
// JoinedMatchPlayerRow.matchApiId is the same number.
function eventMatchIds(data: FinanceData): Set<string> {
  const s = new Set<string>();
  for (const r of data.masterSchedule) if (isEventSchedule(r)) s.add(r.id);
  for (const r of data.cancelledSchedule) if (isEventSchedule(r)) s.add(r.id);
  return s;
}

// Cost-driving match count, mirroring financeCosts.venueMatchCount: alive matches plus the
// cancelled ones the venue charges for, events excluded (an event carries no venue cost).
function groupMatchCount(data: FinanceData, group: VenueGroup, month: Q2Month): number {
  const ids = new Set(group.legs.map((l) => l.id));
  let n = 0;
  for (const s of data.masterSchedule) {
    if (isEventSchedule(s)) continue;
    if (s.venue_id != null && ids.has(s.venue_id) && s.month === month) n += 1;
  }
  for (const leg of group.legs) {
    if (!leg.charge_on_cancel) continue;
    for (const s of data.cancelledSchedule) {
      if (isEventSchedule(s)) continue;
      if (s.venue_id === leg.id && s.month === month) n += 1;
    }
  }
  return n;
}

// The Private Rental half of venuePartnerRevenueFor, isolated. Mirrors that helper's own lookup
// exactly (fin_revenue.venue is already canonical, mapped to an id) so the two cannot diverge.
function privateRentalFor(data: FinanceData, legVenueIds: Set<number>, month: Q2Month): number {
  if (data.revenue.length === 0) return 0;
  const nameToVenueId = new Map<string, number>();
  for (const v of data.venues) nameToVenueId.set(v.venue_name, v.id);
  let total = 0;
  for (const e of data.revenue) {
    if (e.month !== month) continue;
    if (e.type !== "Private Rental") continue;
    const id = nameToVenueId.get(e.venue ?? "");
    if (id == null || !legVenueIds.has(id)) continue;
    total += Number(e.gross ?? 0) || 0;
  }
  return total;
}

export type FieldMonth = {
  key: string;              // stable row key: group primary venue id
  field: string;            // group display name (ATH Katy + its Sunday leg are one field)
  city: string;             // canonical
  month: Q2Month;
  basis: CostBasis;
  venueIds: number[];
  // null ⟺ no cost basis on file for this venue-month. NEVER 0-for-unknown.
  cost: number | null;
  // DPP gate revenue plus Private Rental at this field. The same helper the partner dashboards
  // and Field Ranking read, so the two cannot drift.
  revenue: number;
  // The Private Rental slice of `revenue`. Split out because it has NO match behind it — it is a
  // fin_revenue line, not a gate. Without this, the match-grain table could never reconcile to
  // the field totals and the difference would look like a bug instead of a rental.
  privateRental: number;
  // The EVENT slice of `revenue` — tournament and combine play, which carries no venue cost by
  // policy. Held out of the ratio denominator so cost and revenue count the same matches.
  eventRevenue: number;
  matches: number;
  // Per-match allocation of the month's cost. For a per_match venue this returns the rate back
  // exactly; for flat and share venues it spreads the month's real figure across the matches it
  // covered, which is the only honest per-match number those structures have.
  costPerMatch: number | null;
};

export function buildFieldMonths(
  data: FinanceData,
  matchRegistrations: JoinedMatchPlayerRow[],
  months: Q2Month[],
  mode: CostMode = "per_match",
): FieldMonth[] {
  const groups = groupVenues(data.venues);
  const events = eventMatchIds(data);
  // DAILY PAID revenue at an EVENT match, keyed by venue and month, built in one pass.
  const eventRev = new Map<string, number>();
  for (const r of matchRegistrations) {
    if (r.matchCanceled || r.paymentType !== "DAILY PAID") continue;
    if (isFakePlayerEmail(r.email) || r.fieldId == null) continue;
    if (!events.has(String(r.matchApiId))) continue;
    const venueId = data.venueFields.get(r.fieldId);
    if (venueId == null) continue;
    const d = r.matchStart;
    const k = `${venueId}|${monthKeyOf(d.getFullYear(), d.getMonth())}`;
    eventRev.set(k, (eventRev.get(k) ?? 0) + (Number(r.matchPricePaid ?? 0) || 0));
  }
  const out: FieldMonth[] = [];
  for (const g of groups) {
    if (isCityHidden(g.city)) continue;
    const ids = g.legs.map((l) => l.id);
    const idSet = new Set(ids);
    const basis = basisOf(g.legs[0], data);
    for (const month of months) {
      const cost = groupCost(data, g, month, mode).amount;
      const matches = groupMatchCount(data, g, month);
      out.push({
        key: `g-${g.legs[0].id}`,
        field: g.displayName,
        city: canonCity(g.city),
        month,
        basis,
        venueIds: ids,
        cost,
        revenue: venuePartnerRevenueFor(data, matchRegistrations, idSet, month),
        privateRental: privateRentalFor(data, idSet, month),
        eventRevenue: ids.reduce((a, id) => a + (eventRev.get(`${id}|${month}`) ?? 0), 0),
        matches,
        costPerMatch: cost == null ? null : matches > 0 ? cost / matches : null,
      });
    }
  }
  return out;
}

// ===== Match grain =====
//
// One row per match. The money column is built with the SAME predicate venuePartnerRevenueFor
// uses — DAILY PAID, not cancelled, no fake players — so summing this table's DPP Revenue by
// field and month returns the field totals exactly, less Private Rental (which has no match
// behind it and is carried separately on FieldMonth).
//
// THE SPOT SPLIT NEEDS SUBSCRIPTION WINDOWS. useMatchData fetches without them, and without them
// EVERY paid_status='FREE' row is classified MEMBER — first-match-free signups, guest passes and
// manager fills all counted as members. Passing the windows in restores the real split, so
// "Members Code" means a member and "Free Code" means a comp. Called with an empty map the split
// degrades to the legacy behaviour rather than throwing; the caller loads the real one.
//
// FIELD COST IS THE ALLOCATION, NEVER cost_per_match. See the header of this file.

export type MatchRow = {
  matchApiId: number;
  start: Date;            // WALL CLOCK — parseLocal built it component-wise, so .getHours() is
                          // the hour on the pitch. Never re-parse a string here.
  month: Q2Month;
  week: number;           // ISO-8601 week number
  city: string;
  location: string;
  fieldKey: string;
  memberSpots: number;
  freeSpots: number;
  dppSpots: number;
  totalSpots: number;
  dppRevenue: number;
  fieldCost: number | null;
};

// ISO-8601 week: weeks start Monday and week 1 is the one containing the first Thursday.
export function isoWeek(d: Date): number {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const firstThursday = new Date(t.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7));
  return 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86400_000));
}

export function buildMatchRows(
  data: FinanceData,
  matchRegistrations: JoinedMatchPlayerRow[],
  fieldRows: FieldMonth[],
  windows: MembershipWindowsByUserId,
): MatchRow[] {
  // venue id → the field row it belongs to, per month, so each match picks up its own field's
  // allocated cost rather than a venue-level constant.
  const groupOfVenue = new Map<number, FieldMonth[]>();
  for (const r of fieldRows) {
    for (const id of r.venueIds) {
      const a = groupOfVenue.get(id);
      if (a) a.push(r); else groupOfVenue.set(id, [r]);
    }
  }
  const wanted = new Set(fieldRows.map((r) => r.month));

  const acc = new Map<number, MatchRow>();
  for (const r of matchRegistrations) {
    if (r.matchCanceled) continue;
    if (r.playerCanceledAt) continue;
    if (isFakePlayerEmail(r.email)) continue;
    if (r.fieldId == null) continue;
    const venueId = data.venueFields.get(r.fieldId);
    if (venueId == null) continue;
    const d = r.matchStart;
    const month = monthKeyOf(d.getFullYear(), d.getMonth());
    if (!wanted.has(month)) continue;
    const fm = groupOfVenue.get(venueId)?.find((x) => x.month === month);
    if (!fm) continue;

    let row = acc.get(r.matchApiId);
    if (!row) {
      row = {
        matchApiId: r.matchApiId,
        start: d,
        month,
        week: isoWeek(d),
        city: fm.city,
        location: fm.field,
        fieldKey: fm.key,
        memberSpots: 0, freeSpots: 0, dppSpots: 0, totalSpots: 0,
        dppRevenue: 0,
        fieldCost: fm.costPerMatch,
      };
      acc.set(r.matchApiId, row);
    }

    const pt = r.paymentType;
    if (pt === "DAILY PAID") {
      row.dppSpots += 1;
      row.dppRevenue += Number(r.matchPricePaid ?? 0) || 0;
    } else if (pt === "PROMOCODE" || pt === "FREE_NON_MEMBER") {
      row.freeSpots += 1;
    } else if (pt === "MEMBER") {
      // Re-split the blanket FREE→MEMBER classification against the real windows.
      if (hasMembershipAtMatchTime(r.userId, r.matchStartUtcIso, windows)) row.memberSpots += 1;
      else row.freeSpots += 1;
    } else {
      continue; // WAITING and anything else occupies no spot
    }
    row.totalSpots += 1;
  }
  return [...acc.values()].sort((a, b) => b.start.getTime() - a.start.getTime());
}

// ===== Rollups =====
//
// Every total is a SUM OF THE ROWS ABOVE IT. City = its fields; All cities = its cities. Built
// bottom-up on purpose: the alternative (a separate city-level query) is how two figures on one
// page start disagreeing. Unknown-cost rows contribute their revenue and no cost, and are
// counted so the gap stays visible instead of being averaged away.

export type CostRollup = {
  cost: number;
  revenue: number;
  // Revenue at fields whose cost IS known, MINUS event revenue — the only denominator a ratio may
  // use, because it is the only one counting the same matches the cost counts.
  revenueWithKnownCost: number;
  ratio: number | null;
  unknownFields: number;
  unknownRevenue: number;
  eventRevenue: number;
  matches: number;
};

export function rollup(rows: FieldMonth[]): CostRollup {
  let cost = 0, revenue = 0, revenueWithKnownCost = 0, unknownFields = 0, unknownRevenue = 0, eventRevenue = 0, matches = 0;
  for (const r of rows) {
    revenue += r.revenue;
    matches += r.matches;
    eventRevenue += r.eventRevenue;
    if (r.cost == null) {
      unknownFields += 1;
      unknownRevenue += r.revenue;
      continue;
    }
    cost += r.cost;
    // Event play is billed to nobody, so it cannot sit under a cost in a ratio.
    revenueWithKnownCost += r.revenue - r.eventRevenue;
  }
  return {
    cost,
    revenue,
    revenueWithKnownCost,
    // A ratio against revenue that includes unknown-cost fields would flatter the number by
    // adding revenue with no cost behind it. Denominator is known-cost revenue only.
    ratio: revenueWithKnownCost > 0 ? cost / revenueWithKnownCost : null,
    unknownFields,
    unknownRevenue,
    eventRevenue,
    matches,
  };
}

export function byCity(rows: FieldMonth[]): Map<string, FieldMonth[]> {
  const m = new Map<string, FieldMonth[]>();
  for (const r of rows) {
    const k = r.city;
    const a = m.get(k);
    if (a) a.push(r); else m.set(k, [r]);
  }
  return m;
}

export function byField(rows: FieldMonth[]): Map<string, FieldMonth[]> {
  const m = new Map<string, FieldMonth[]>();
  for (const r of rows) {
    const a = m.get(r.key);
    if (a) a.push(r); else m.set(r.key, [r]);
  }
  return m;
}

export function byMonth(rows: FieldMonth[]): Map<Q2Month, FieldMonth[]> {
  const m = new Map<Q2Month, FieldMonth[]>();
  for (const r of rows) {
    const a = m.get(r.month);
    if (a) a.push(r); else m.set(r.month, [r]);
  }
  return m;
}

// THE HIGHEST-RATIO FIELD for a set of rows — measured, not a target anybody set. Only fields
// with BOTH a known cost and revenue can have a ratio at all; a field with cost and no revenue is
// not "infinitely bad", it is a field that did not trade, and it is left out rather than
// dominating the tile forever.
export function highestRatioField(rows: FieldMonth[]): { field: string; city: string; ratio: number } | null {
  let best: { field: string; city: string; ratio: number } | null = null;
  for (const [, group] of byField(rows)) {
    const r = rollup(group);
    if (r.ratio == null || r.revenueWithKnownCost <= 0) continue;
    if (!best || r.ratio > best.ratio) {
      best = { field: group[0].field, city: group[0].city, ratio: r.ratio };
    }
  }
  return best;
}

// Fields carrying revenue with no cost basis on file, deduped across the months in scope. This is
// the fillable-gap list — it exists so the hole is visible and closable, not so it can be ignored.
export function costNotRecorded(rows: FieldMonth[]): Array<{ field: string; city: string; basis: CostBasis; revenue: number; months: Q2Month[] }> {
  const m = new Map<string, { field: string; city: string; basis: CostBasis; revenue: number; months: Q2Month[] }>();
  for (const r of rows) {
    if (r.cost != null) continue;
    const e = m.get(r.key);
    if (e) { e.revenue += r.revenue; e.months.push(r.month); }
    else m.set(r.key, { field: r.field, city: r.city, basis: r.basis, revenue: r.revenue, months: [r.month] });
  }
  return [...m.values()].sort((a, b) => b.revenue - a.revenue);
}

// ===== Revenue side =====
//
// DPP comes from the field rows above, so the Revenue page and the Cost page are reading the SAME
// per-field numbers. Membership is a city-level fact (a subscription is not bought at a pitch) and
// comes from fin_revenue via the same helper the Cities table uses.

// ===== The four-month window =====
//
// Revenue plots the anchor month plus the prior three. Four months ALWAYS cross a quarter
// boundary, so this also reports which quarter owns the earlier ones — the page mounts that
// quarter's loader and hands both to mergeFinanceDataByMonth.
//
// A month whose quarter predates the selector's floor is DROPPED, not zeroed: the cockpit's
// finance record starts in 2026, and a month drawn at $0 because nobody fetched it is a lie in
// the shape of a fact.
export type RevenueWindow = {
  months: Q2Month[];              // oldest → newest, up to four
  anchor: Q2Month;                // the newest — the month the tiles describe
  anchorIsPartial: boolean;       // true when the anchor is the calendar month we are living in
  prevQuarter: QuarterInfo | null;
  prevMonths: Set<Q2Month>;
};

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthKeyOf = (y: number, mi: number): Q2Month => `${SHORT[mi]} ${y}`;

export function revenueWindow(quarter: QuarterInfo, now: Date): RevenueWindow {
  // Anchor: the current calendar month when the selected quarter contains it, otherwise the
  // quarter's last month — selecting a past quarter should describe that quarter, not today.
  const inQuarter = quarter.months.find(
    (m) => m.year === now.getFullYear() && m.monthIndex === now.getMonth(),
  );
  const anchorMonth = inQuarter ?? quarter.months[quarter.months.length - 1];
  const anchorIsPartial =
    anchorMonth.year === now.getFullYear() && anchorMonth.monthIndex === now.getMonth();

  const months: Q2Month[] = [];
  const owners = new Map<Q2Month, QuarterInfo>();
  for (let back = 3; back >= 0; back--) {
    const d = new Date(anchorMonth.year, anchorMonth.monthIndex - back, 1);
    const q = getQuarterByKey(`${d.getFullYear()}Q${Math.floor(d.getMonth() / 3) + 1}`);
    if (!q) continue; // below the record's floor — omit rather than draw an empty month
    const key = monthKeyOf(d.getFullYear(), d.getMonth());
    months.push(key);
    owners.set(key, q);
  }

  const anchor = monthKeyOf(anchorMonth.year, anchorMonth.monthIndex);
  const prevMonths = new Set<Q2Month>();
  let prevQuarter: QuarterInfo | null = null;
  for (const m of months) {
    const q = owners.get(m);
    if (!q || q.key === quarter.key) continue;
    prevQuarter = q;
    prevMonths.add(m);
  }
  return { months, anchor, anchorIsPartial, prevQuarter, prevMonths };
}

export type RevenueMonth = {
  month: Q2Month;
  dpp: number;
  membership: number;
  total: number;
};

export function revenueByMonth(
  data: FinanceData,
  fieldRows: FieldMonth[],
  months: Q2Month[],
  cities: string[],
): RevenueMonth[] {
  const rowsByMonth = byMonth(fieldRows);
  return months.map((month) => {
    const dpp = (rowsByMonth.get(month) ?? []).reduce((s, r) => s + r.revenue, 0);
    let membership = 0;
    for (const c of cities) membership += cityMembershipRevenueFor(data, c, month);
    return { month, dpp, membership, total: dpp + membership };
  });
}
