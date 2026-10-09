// MATCH P&L BY FIELD — one calculation, two pages (Ryan, 2026-10-08).
//
// Slate Review's "Match P&L by field" and Finance › Revenue's 4-week columns both call this module,
// so a field reads the same numbers on both. It was the body of SlateFieldPnL.tsx; the grouping and
// the per-match arithmetic moved here unchanged except for the two rulings below.
//
// PER-MATCH economics: average revenue and cost of ONE match at each field, so a field that ran 54
// matches compares directly with one that ran 6. Played matches only (is_cancelled=false); fakes,
// WAITING and player-cancelled rows are excluded upstream (matchPnL); absents count. Revenue is
// what Slate has always called "gross": play revenue before tax, refunds and Stripe fees — DAILY
// PAID price paid + member spots at the city's pre-tax membership rate + promo.
//
// ── THE TWO RULINGS ─────────────────────────────────────────────────────────────────────────────
//
// 1. PROFIT-SHARE FIELDS HAVE A COMPUTED COST. Not a flat rate and not the Field Costs ledger (which
//    is monthly, and carries hand-entered overrides): each match's cost is what the partner's own
//    terms pay for it, from the partner engine the partner page uses —
//      RENTAL_FLOOR_PROFIT_SHARE (PARMER)   buildRentalDashboard's per-match partnerTotalCents, plus
//                                           any cancelled date the operator charged the rental on
//                                           (a cost of the window, not a match);
//      REVENUE_SHARE, flat_percentage[_with_members] (Hattrick, Hattrick Tomball, Turf On)
//                                           share% × (the match's DAILY PAID price paid + its member
//                                           spots × the member rate of the period the match is in),
//                                           the same three terms periodOwed sums for the month.
//    A match whose cost uses the member rate of a month that has not closed is PROVISIONAL: the
//    rate is that month's average drop-in charge and moves until the month ends.
//    A model this module cannot split by match (per_match_minus_manager, whose $0 floor applies to
//    the monthly total) leaves the field without a cost: it shows the model's name and stays out of
//    every average.
//
// 2. SOCCER CENTRAL'S TWO-PITCH MATCHES ARE SOCCER CENTRAL. A match on both pitches resolves to
//    fin_venues 53 "Soccer Central Tournament" at $180. That row is INACTIVE, and the old grouping
//    tested is_active before it merged the two rows, so every two-pitch match fell into Unmapped.
//    The merge is now decided first, by the base venue (11): a two-pitch match is on the Soccer
//    Central line, costs $180, and counts as two matches (matchUnits).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MatchPnLRow } from "./matchPnL";
import type { FinVenue } from "./useFinanceData";
import { fieldCode } from "./slateFieldCodes";
import { canonicalVenueName } from "./venueResolver";
import { isFakePlayerEmail } from "./mdapiFakePlayer";
import { chicagoYmd } from "./weekBuckets";
import {
  fetchAllEnabledPartnerDashboards, fetchPartnerRows, fetchPartnerWeeklyPayments, fetchRentalOverrides,
  modelForPeriod, partnerPaymentFor, rentalParamsOf, type PartnerConfig, type PartnerRegRow,
} from "./partnerStats";
import { buildRentalDashboard } from "./partnerRentalDashboard";

const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (d: Date) => `${MO[d.getMonth()]} ${d.getDate()}`;
const round2 = (v: number) => Math.round(v * 100) / 100;
const ymdOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ── THE WINDOW ───────────────────────────────────────────────────────────────────────────────────
export type PnLWindow = { weeks: number; start: Date; end: Date; fromYmd: string; toYmd: string; label: string };

/** The last `weeks` COMPLETED Monday–Sunday weeks: the last Sunday on or before today, then back. */
export function completedWeeksWindow(weeks: number, now = new Date()): PnLWindow {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = d.getDay(); // Sun=0 → today is the last completed Sunday
  const lastSun = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  const start = new Date(lastSun.getFullYear(), lastSun.getMonth(), lastSun.getDate() - (7 * weeks - 1));
  const end = new Date(lastSun.getFullYear(), lastSun.getMonth(), lastSun.getDate(), 23, 59, 59);
  return { weeks, start, end, fromYmd: ymdOf(start), toYmd: ymdOf(end), label: `${fmtDay(start)} to ${fmtDay(end)}` };
}

// ── PROFIT-SHARE COSTS ───────────────────────────────────────────────────────────────────────────
export type MatchCost = { cost: number; provisional: boolean };
export type ShareCosts = {
  /** Keyed `${venueId}|${match_start}` — the key matchPnL rows carry (matchStartIso is match_start). */
  byMatch: Map<string, MatchCost>;
  /** Cost in the window that belongs to no played match: a cancelled date that owes the rental. */
  extraByVenue: Map<number, number>;
  /** A venue whose model cannot be split by match in this window, with the model's name. */
  modelOnly: Map<number, string>;
  /** Venue → the partner's terms, for the row's tag. */
  termsByVenue: Map<number, string>;
};

export const matchKey = (venueId: number, matchStart: string) => `${venueId}|${matchStart}`;

const MODEL_NAME: Record<string, string> = {
  per_match_minus_manager: "Match revenue minus manager pay",
  per_match_fee: "Per-match fee",
  flat_percentage: "Revenue share",
  flat_percentage_with_members: "Revenue share",
};

/** Last day of the month holding `ymd`. */
const monthEndYmd = (ymd: string) => {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7));
  return `${ymd.slice(0, 7)}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
};

/* ONE PARTNER'S PER-MATCH COSTS, inside the window. Exported for the September check against the
 * engine's monthly figure; the page calls fetchShareCosts. */
export async function shareCostsForPartner(
  supabase: SupabaseClient, partner: PartnerConfig, win: { fromYmd: string; toYmd: string }, now: Date,
): Promise<{ byMatch: Map<string, MatchCost>; extra: number; modelOnly: string | null; terms: string; rows: PartnerRegRow[] }> {
  const fetched = await fetchPartnerRows(supabase, partner.venueId);
  const inWin = (ymd: string) => ymd >= win.fromYmd && ymd <= win.toYmd;
  const byMatch = new Map<string, MatchCost>();
  const todayYmd = chicagoYmd(now.toISOString());

  const rental = rentalParamsOf(partner);
  if (rental) {
    const overrides = await fetchRentalOverrides(supabase, partner.id);
    const dash = buildRentalDashboard(fetched.rows, rental, {
      partnerName: partner.partnerName, venue: fetched.venueName, spotPriceCents: partner.spotPriceCents,
      payoutModel: partner.payoutModel, rentalOverrides: overrides, nowMs: now.getTime(),
    });
    // match_api_id → match_start, so a payout row meets the matchPnL row for the same match.
    const startOf = new Map<number, string>();
    for (const r of fetched.rows) if (r.match_api_id != null && !startOf.has(r.match_api_id)) startOf.set(r.match_api_id, r.match_start);
    let extra = 0;
    for (const m of dash.months) for (const p of m.rows) {
      if (!inWin(p.startYmd)) continue;
      if (p.cancelled) { extra += p.partnerTotalCents / 100; continue; }
      const start = startOf.get(p.matchApiId);
      if (start) byMatch.set(matchKey(partner.venueId, start), { cost: p.partnerTotalCents / 100, provisional: false });
    }
    const terms = `${partner.partnerSharePct}% share, $${(rental.fieldRentalCents / 100).toFixed(0)} rental floor`;
    return { byMatch, extra, modelOnly: null, terms, rows: fetched.rows };
  }

  const records = await fetchPartnerWeeklyPayments(supabase, partner.id);
  const pay = partnerPaymentFor(partner, fetched, records, now);
  const cfg = {
    revenueModel: partner.revenueModel, revenueSharePct: partner.revenueSharePct,
    managerPayBase: partner.managerPayBase, managerPayHigh: partner.managerPayHigh, managerPayThreshold: partner.managerPayThreshold,
    revenueModelNext: partner.revenueModelNext, revenueModelFrom: partner.revenueModelFrom,
  };
  // periodOwed's own row set: not a synthetic fill, not on a cancelled match.
  const active = fetched.rows.filter((r) => !isFakePlayerEmail(r.email) && !r.match_canceled);
  const periods = pay.weeklyPayments.filter((p) => !p.isPreSystem);
  const periodOf = (ymd: string) => periods.find((p) => ymd >= p.weekStartDate && ymd <= p.weekEndDate) ?? null;
  type Acc = { start: string; ymd: string; dp: number; members: number };
  const acc = new Map<string, Acc>();
  let modelOnly: string | null = null;
  for (const r of active) {
    const ymd = r.match_start.slice(0, 10);
    if (!inWin(ymd)) continue;
    const k = matchKey(partner.venueId, r.match_start);
    const a = acc.get(k) ?? { start: r.match_start, ymd, dp: 0, members: 0 };
    if (r.payment_type === "DAILY PAID") a.dp += Number(r.match_price_paid ?? 0) || 0;
    const cancelled = !!r.player_canceled_at && r.player_canceled_at.trim() !== "";
    if (r.payment_type === "MEMBER" && !cancelled && r.user_type !== "GUEST") a.members += 1;
    acc.set(k, a);
  }
  for (const [k, a] of acc) {
    const period = periodOf(a.ymd);
    const model = modelForPeriod(cfg, period?.weekStartDate ?? a.ymd);
    if (model !== "flat_percentage" && model !== "flat_percentage_with_members") { modelOnly = MODEL_NAME[model] ?? model; break; }
    let q = a.dp;
    let provisional = false;
    if (model === "flat_percentage_with_members") {
      const rate = period?.memberRateCents ?? null;
      if (rate == null) { modelOnly = "Revenue share (member rate not set)"; break; }
      q += (a.members * rate) / 100;
      // The rate is the month's average drop-in charge: final only once the month has ended.
      provisional = monthEndYmd(a.ymd) >= todayYmd;
    }
    byMatch.set(k, { cost: Math.round(q * partner.revenueSharePct) / 100, provisional });
  }
  const terms = `${partner.revenueSharePct}% revenue share`;
  return { byMatch: modelOnly ? new Map() : byMatch, extra: 0, modelOnly, terms, rows: fetched.rows };
}

/** Every enabled partner on an active profit_share venue, in parallel. */
export async function fetchShareCosts(
  supabase: SupabaseClient, venues: FinVenue[], win: { fromYmd: string; toYmd: string }, now: Date,
): Promise<ShareCosts> {
  const out: ShareCosts = { byMatch: new Map(), extraByVenue: new Map(), modelOnly: new Map(), termsByVenue: new Map() };
  const shareVenues = new Set(venues.filter((v) => v.billing_type === "profit_share" && v.is_active !== false).map((v) => v.id));
  const partners = (await fetchAllEnabledPartnerDashboards(supabase)).filter((p) => shareVenues.has(p.venueId));
  const results = await Promise.all(partners.map((p) => shareCostsForPartner(supabase, p, win, now).then((r) => ({ p, r }))));
  for (const { p, r } of results) {
    for (const [k, c] of r.byMatch) out.byMatch.set(k, c);
    if (r.extra) out.extraByVenue.set(p.venueId, (out.extraByVenue.get(p.venueId) ?? 0) + r.extra);
    if (r.modelOnly) out.modelOnly.set(p.venueId, r.modelOnly);
    out.termsByVenue.set(p.venueId, r.terms);
  }
  // A profit-share venue with no enabled partner has no terms to compute from.
  for (const id of shareVenues) if (!out.termsByVenue.has(id)) out.modelOnly.set(id, "Profit share (no partner terms)");
  return out;
}

// ── THE GROUPING ─────────────────────────────────────────────────────────────────────────────────
/* flat     a per-match rate (cost_per_match, weekday-aware)
 * share    a profit-share field with a computed cost — ranked beside flat, tagged "Profit share"
 * model    a cost this module cannot compute (shows the model's name, out of every average)
 * unmapped no usable venue (no fin_venue_fields link, or a link to a deactivated venue) */
export type Bucket = "flat" | "share" | "model" | "unmapped";
export type FieldAgg = {
  key: string; label: string; fullName: string; city: string; bucket: Bucket;
  /** The venue ids on this line (Soccer Central's two legs are one line). */
  venueIds: number[];
  /** "Profit share" rows: the partner's terms. "model" rows: the model's name. */
  costLabel: string;
  matches: number;
  dpp: number; member: number; promo: number; promoSpots: number; // window totals
  revenue: number; cost: number | null;
  // per-match (dollars, 2dp)
  dppPM: number; memberPM: number; promoPM: number; revPM: number; costPM: number | null; netPM: number | null;
  /** True when any match's cost uses a member rate from a month that has not closed. */
  provisional: boolean;
  /** The months whose rates are not final, as "October" — for the note on the cost. */
  provisionalMonths: string[];
  unmappedNames: string[];
  /* THE SPLIT, SHOWN NOT BURIED. A merged Soccer Central line has to say which of its matches took
   * both pitches, or a reader cannot tell a $90 night from a $180 one. */
  onePitchMatches: number; twoPitchMatches: number; twoPitchCost: number;
};

const SOCC_BASE = 11, SOCC_TOURNEY = 53;
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function aggregateFieldPnL(active: MatchPnLRow[], venueById: Map<number, FinVenue>, share: ShareCosts): FieldAgg[] {
  type Raw = Omit<FieldAgg, "revenue" | "dppPM" | "memberPM" | "promoPM" | "revPM" | "costPM" | "netPM">;
  const groups = new Map<string, Raw & { costKnown: boolean }>();
  for (const r of active) {
    // Special events carry no venue cost and must not dilute a pitch's per-match average.
    if (r.isEvent) continue;
    /* SOCCER CENTRAL IS ONE LINE, DECIDED BEFORE THE ACTIVE TEST (ruling 2 above). The base venue's
     * row decides the bucket; each match keeps its own cost (r.fieldCost: $90, or $180 for both
     * pitches) and its own unit count. Two venues, named, and that is all — the same special case
     * as COMBINE_BY_NAME in venueGroups.ts, for the one view that groups by venue id. */
    const isSocc = r.venueId === SOCC_BASE || r.venueId === SOCC_TOURNEY;
    const v = isSocc ? venueById.get(SOCC_BASE) : r.venueId != null ? venueById.get(r.venueId) : undefined;
    let bucket: Bucket; let costLabel = "";
    if (r.venueId == null || !v || v.is_active === false) bucket = "unmapped";
    else if (v.billing_type === "per_match") bucket = "flat";
    else if (v.billing_type === "profit_share") {
      const m = share.modelOnly.get(v.id);
      if (m) { bucket = "model"; costLabel = m; }
      else { bucket = "share"; costLabel = share.termsByVenue.get(v.id) ?? "Profit share"; }
    } else { bucket = "model"; costLabel = "Monthly fee"; }
    const key = bucket === "unmapped" ? `unmapped:${r.venueId ?? r.venueRawName}` : isSocc ? `v:${SOCC_BASE}` : `v:${r.venueId}`;
    let g = groups.get(key);
    if (!g) {
      // The merged line is named for the BASE venue, never "Soccer Central Tournament".
      const nm = isSocc ? (venueById.get(SOCC_BASE)?.venue_name ?? "Soccer Central") : (v?.venue_name ?? r.venueRawName);
      g = { key, label: fieldCode(canonicalVenueName(nm)), fullName: nm, city: r.city, bucket, costLabel,
        venueIds: [], matches: 0, dpp: 0, member: 0, promo: 0, promoSpots: 0,
        cost: bucket === "flat" || bucket === "share" ? 0 : null, costKnown: true, provisional: false, provisionalMonths: [],
        unmappedNames: [], onePitchMatches: 0, twoPitchMatches: 0, twoPitchCost: 0 };
      groups.set(key, g);
    }
    if (r.venueId != null && !g.venueIds.includes(r.venueId)) g.venueIds.push(r.venueId);
    /* TWO PITCHES IS TWO MATCHES — counts and denominators only. The COST doubling is already in the
     * rate ($180 on venue 53) and the charged unit count stays 1; doubling both would bill $360. */
    g.matches += r.matchUnits;
    if (r.matchUnits > 1) { g.twoPitchMatches += 1; g.twoPitchCost += r.fieldCost ?? 0; }
    else { g.onePitchMatches += 1; }
    g.dpp += r.grossRevenue;
    g.member += r.allocatedMemberRev;
    g.promo += r.promoRevenue;
    g.promoSpots += r.promoSpots;
    /* A MISSING COST IS NOT $0 (2026-10-09). Stony Point had no cost_per_match and read $0.00 a match
     * here (and net = all of its revenue). A flat match with no cost leaves the line without one. */
    if (bucket === "flat") {
      if (r.fieldCost == null) g.costKnown = false;
      else g.cost = (g.cost ?? 0) + r.fieldCost;
    }
    if (bucket === "share" && r.venueId != null) {
      const c = share.byMatch.get(matchKey(r.venueId, r.matchStartIso));
      // A played match the partner engine did not price: the line has no complete cost.
      if (!c) g.costKnown = false;
      else {
        g.cost = (g.cost ?? 0) + c.cost;
        if (c.provisional) {
          g.provisional = true;
          const mon = MONTH_FULL[Number(r.matchStartIso.slice(5, 7)) - 1];
          if (!g.provisionalMonths.includes(mon)) g.provisionalMonths.push(mon);
        }
      }
    }
    if (bucket === "unmapped" && !g.unmappedNames.includes(r.venueRawName)) g.unmappedNames.push(r.venueRawName);
  }
  const finalize = (g: Raw & { costKnown: boolean }): FieldAgg => {
    const { costKnown, ...rest } = g;
    let cost = rest.cost;
    let bucket = rest.bucket, costLabel = rest.costLabel;
    if (bucket === "flat" && !costKnown) { bucket = "model"; costLabel = "No cost per match set"; cost = null; }
    if (bucket === "share") {
      if (!costKnown) { bucket = "model"; costLabel = "Profit share (a match was not priced)"; cost = null; }
      // A cancelled date that owes the rental is a cost of the window with no match of its own.
      else cost = (cost ?? 0) + rest.venueIds.reduce((s, id) => s + (share.extraByVenue.get(id) ?? 0), 0);
    }
    const dppPM = round2(rest.dpp / rest.matches), memberPM = round2(rest.member / rest.matches), promoPM = round2(rest.promo / rest.matches);
    const revPM = round2(dppPM + memberPM + promoPM); // sum of components → drill-down always foots
    const costPM = cost == null ? null : round2(cost / rest.matches);
    return { ...rest, bucket, costLabel, cost, revenue: rest.dpp + rest.member + rest.promo, dppPM, memberPM, promoPM, revPM, costPM,
      netPM: costPM == null ? null : round2(revPM - costPM) };
  };
  return [...groups.values()].map(finalize);
}

/** Ranked first (by net per match, flat and profit share together), then fields with no computed
 *  cost, then unmapped. */
export function rankFields(fields: FieldAgg[]): { ranked: FieldAgg[]; model: FieldAgg[]; unmapped: FieldAgg[] } {
  return {
    ranked: fields.filter((g) => g.netPM != null && (g.bucket === "flat" || g.bucket === "share")).sort((a, b) => (b.netPM ?? 0) - (a.netPM ?? 0)),
    model: fields.filter((g) => g.bucket === "model").sort((a, b) => b.matches - a.matches),
    unmapped: fields.filter((g) => g.bucket === "unmapped").sort((a, b) => b.matches - a.matches),
  };
}

/* ── A CITY (OR THE NETWORK): MATCH-WEIGHTED ACROSS ITS FIELDS ─────────────────────────────────────
 * Over the fields WITH a cost only, so revenue, cost and net describe the same matches and net =
 * revenue − cost. `matches` is every match in the window; `covered` is how many the averages use,
 * printed as "60 of 113 matches" whenever they differ. */
export type PnLRollup = {
  matches: number; covered: number;
  revPM: number | null; costPM: number | null; netPM: number | null;
  provisional: boolean; provisionalMonths: string[];
};
export function rollupFields(fields: FieldAgg[]): PnLRollup {
  let matches = 0, covered = 0, rev = 0, cost = 0, provisional = false;
  const months: string[] = [];
  for (const g of fields) {
    matches += g.matches;
    if (g.cost == null || (g.bucket !== "flat" && g.bucket !== "share")) continue;
    covered += g.matches; rev += g.revenue; cost += g.cost;
    if (g.provisional) { provisional = true; for (const m of g.provisionalMonths) if (!months.includes(m)) months.push(m); }
  }
  if (covered === 0) return { matches, covered, revPM: null, costPM: null, netPM: null, provisional, provisionalMonths: months };
  const revPM = round2(rev / covered), costPM = round2(cost / covered);
  return { matches, covered, revPM, costPM, netPM: round2(revPM - costPM), provisional, provisionalMonths: months };
}

/** "provisional until October closes" / "until September and October close". */
export const provisionalNote = (months: string[]) =>
  months.length === 0 ? "" : `provisional until ${months.join(" and ")} ${months.length === 1 ? "closes" : "close"}`;
