// Insights derived from user_analysis (match_registrations) — currently
// Member-Heavy Fields and High Promo Usage. Both group non-cancelled
// registrations for the active month by canonicalized field (same
// fin_venue_aliases + cross-alias + prefix pipeline as fin_revenue),
// then filter on a volume floor + a mix threshold. Sharing the
// canonicalization here means a venue with multiple raw spellings
// (e.g. "ATH Katy" + "ATH Katy Tournament" + "Tourney ATH Katy")
// collapses to one row instead of double-counting.

import type { MatchRow } from "./useMatchData";
import type { FinanceData, FinVenue } from "./useFinanceData";
import type { Q2Month } from "./financeStats";
import { normalizeMatchName } from "./venueNormalization";

// Pinned to 0.35 because no venue clears 0.50 at present (Apr 2026 high
// is San Juan Diego at 0.48). 0.35 surfaces venues that meaningfully
// over-index on members vs the company average. Bump as the membership
// program scales.
export const MEMBER_HEAVY_THRESHOLD = 0.35;
export const MEMBER_HEAVY_MIN_SPOTS = 30;

// 0.20 / 30+ spots flags venues where promo redemption is unusually
// high — typically a sign of an active acquisition push that's
// subsidising matches there. Useful for spotting which fields lean on
// discounts to fill.
export const HIGH_PROMO_THRESHOLD = 0.2;
export const HIGH_PROMO_MIN_SPOTS = 30;

const Q2_MONTH_PREFIX: Record<Q2Month, string> = {
  "Apr 2026": "2026-04",
  "May 2026": "2026-05",
  "Jun 2026": "2026-06",
};

export type MemberHeavyRow = {
  venue: string;
  city: string;
  total: number;
  memberCount: number;
  dailyCount: number;
  memberPct: number;
};

export type HighPromoRow = {
  venue: string;
  city: string;
  total: number;
  promoCount: number;
  promoPct: number;
};

export type TopPromoCodeRow = { code: string; count: number };
export type TopPromoCodesResult = {
  rows: TopPromoCodeRow[]; // sorted by count desc
  distinctCount: number; // total distinct codes used in the month
};

export type SpotMixCityRow = {
  city: string;
  total: number; // Member + DPP + Promo (excludes Free)
  member: number;
  dpp: number;
  promo: number;
  free: number;
  memberPct: number;
  dppPct: number;
  promoPct: number;
};
export type SpotMixCityResult = {
  rows: SpotMixCityRow[];
  grandTotal: number;
  freeCount: number; // diagnostic — not rendered, just a footer/log
};

function paymentBucket(paymentType: string | null): "member" | "daily" | "other" {
  if (!paymentType) return "other";
  const lc = paymentType.trim().toLowerCase();
  if (lc === "member") return "member";
  if (lc === "daily paid" || lc === "daily" || lc === "daily_paid") return "daily";
  return "other";
}

// Returns the canonical fin_venues.venue_name for the row's field, or
// null if the field doesn't resolve to a tracked venue (e.g. typo,
// archived test venue, or a venue that exists in user_analysis but not
// in fin_venues yet).
function resolveVenue(
  field: string,
  data: FinanceData,
  venueByName: Map<string, FinVenue>,
): FinVenue | null {
  const canonical = normalizeMatchName(field, data.venueAliases).canonical;
  if (!canonical) return null;
  return venueByName.get(canonical) ?? null;
}

function isInMonth(d: Date, monthPrefix: string): boolean {
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return iso === monthPrefix;
}

// Inclusion uses rounded-percent comparison so what the card renders
// matches what qualifies. A venue at 13/66 = 19.7% rounds to 20% on
// screen, so a "≥20%" subtitle should include it; a strict `pct >= 0.20`
// would silently drop it.
function meetsPctThreshold(pct: number, threshold: number): boolean {
  return Math.round(pct * 100) >= Math.round(threshold * 100);
}

export function memberHeavyFieldsFromMatches(
  matchRows: MatchRow[],
  data: FinanceData,
  month: Q2Month,
): MemberHeavyRow[] {
  const monthPrefix = Q2_MONTH_PREFIX[month];
  const venueByName = new Map<string, FinVenue>();
  for (const v of data.venues) venueByName.set(v.venue_name, v);

  type Bucket = { city: string; total: number; member: number; daily: number };
  const buckets = new Map<string, Bucket>();

  for (const r of matchRows) {
    if (r.matchCanceled) continue;
    if (!isInMonth(r.matchStart, monthPrefix)) continue;
    const venue = resolveVenue(r.field, data, venueByName);
    if (!venue) continue;
    const cur = buckets.get(venue.venue_name) ?? {
      city: venue.city,
      total: 0,
      member: 0,
      daily: 0,
    };
    cur.total += 1;
    const bucket = paymentBucket(r.paymentType);
    if (bucket === "member") cur.member += 1;
    else if (bucket === "daily") cur.daily += 1;
    buckets.set(venue.venue_name, cur);
  }

  const rows: MemberHeavyRow[] = [];
  for (const [venue, b] of buckets) {
    if (b.total < MEMBER_HEAVY_MIN_SPOTS) continue;
    const pct = b.total > 0 ? b.member / b.total : 0;
    if (!meetsPctThreshold(pct, MEMBER_HEAVY_THRESHOLD)) continue;
    rows.push({
      venue,
      city: b.city,
      total: b.total,
      memberCount: b.member,
      dailyCount: b.daily,
      memberPct: pct,
    });
  }
  rows.sort((a, b) => b.memberPct - a.memberPct);
  return rows;
}

export function highPromoUsageFromMatches(
  matchRows: MatchRow[],
  data: FinanceData,
  month: Q2Month,
): HighPromoRow[] {
  const monthPrefix = Q2_MONTH_PREFIX[month];
  const venueByName = new Map<string, FinVenue>();
  for (const v of data.venues) venueByName.set(v.venue_name, v);

  type Bucket = { city: string; total: number; promo: number };
  const buckets = new Map<string, Bucket>();

  for (const r of matchRows) {
    if (r.matchCanceled) continue;
    if (!isInMonth(r.matchStart, monthPrefix)) continue;
    const venue = resolveVenue(r.field, data, venueByName);
    if (!venue) continue;
    const cur = buckets.get(venue.venue_name) ?? {
      city: venue.city,
      total: 0,
      promo: 0,
    };
    cur.total += 1;
    if (r.promocode && r.promocode.trim() !== "") cur.promo += 1;
    buckets.set(venue.venue_name, cur);
  }

  const rows: HighPromoRow[] = [];
  for (const [venue, b] of buckets) {
    if (b.total < HIGH_PROMO_MIN_SPOTS) continue;
    const pct = b.total > 0 ? b.promo / b.total : 0;
    if (!meetsPctThreshold(pct, HIGH_PROMO_THRESHOLD)) continue;
    rows.push({
      venue,
      city: b.city,
      total: b.total,
      promoCount: b.promo,
      promoPct: pct,
    });
  }
  rows.sort((a, b) => b.promoPct - a.promoPct);
  return rows;
}

// Per-city spot mix in the active month, sourced from
// match_registrations (DB-side equivalent of user_analysis). Buckets
// payment_type into Member / DPP / Promo / Free; drops Free from the
// rendered totals (logged for verification only). Cities with fewer
// than MIN_TOTAL spots are filtered so a one-off rental doesn't get
// a card row. Sort: member% desc, total desc tiebreak.
const SPOT_MIX_MIN_TOTAL = 50;

function normalizeSpotMixCity(city: string | null | undefined): string {
  const t = (city ?? "").trim();
  // Defensive — current upload pipeline normalizes this at write
  // time, but keep the alias in case raw values reach the table later.
  if (t === "Dallas / Fort Worth") return "Dallas";
  return t;
}

type PaymentBucket = "Member" | "DPP" | "Promo" | "Free" | "Other";
function paymentTypeBucket(pt: string | null): PaymentBucket {
  const v = (pt ?? "").trim().toUpperCase();
  if (v === "MEMBER") return "Member";
  // PAID is dormant in current data; keeps the branch defensive.
  if (v === "DAILY PAID" || v === "PAID") return "DPP";
  if (v === "PROMOCODE") return "Promo";
  // FREE is dormant in current data; current data only emits
  // "DAILY FREE MATCH". Both fold here.
  if (v === "DAILY FREE MATCH" || v === "FREE") return "Free";
  return "Other";
}

export function spotMixByCityFromMatches(
  matchRows: MatchRow[],
  month: Q2Month,
): SpotMixCityResult {
  const monthPrefix = Q2_MONTH_PREFIX[month];
  type Bucket = { Member: number; DPP: number; Promo: number; Free: number };
  const byCity = new Map<string, Bucket>();
  let freeCount = 0;

  for (const r of matchRows) {
    if (r.matchCanceled) continue;
    if (!isInMonth(r.matchStart, monthPrefix)) continue;
    const city = normalizeSpotMixCity(r.city);
    if (!city) continue;
    const bucket = paymentTypeBucket(r.paymentType);
    if (bucket === "Other") continue;
    if (bucket === "Free") freeCount++;
    const cur = byCity.get(city) ?? { Member: 0, DPP: 0, Promo: 0, Free: 0 };
    cur[bucket] += 1;
    byCity.set(city, cur);
  }

  const rows: SpotMixCityRow[] = [];
  for (const [city, b] of byCity) {
    const total = b.Member + b.DPP + b.Promo;
    if (total < SPOT_MIX_MIN_TOTAL) continue;
    rows.push({
      city,
      total,
      member: b.Member,
      dpp: b.DPP,
      promo: b.Promo,
      free: b.Free,
      memberPct: total > 0 ? b.Member / total : 0,
      dppPct: total > 0 ? b.DPP / total : 0,
      promoPct: total > 0 ? b.Promo / total : 0,
    });
  }
  rows.sort((a, b) => {
    if (a.memberPct !== b.memberPct) return b.memberPct - a.memberPct;
    return b.total - a.total;
  });
  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
  return { rows, grandTotal, freeCount };
}

// Top promo codes by usage in the active month. Case-sensitive bucketing
// because "MATCHDAY" and "matchday" are different rows in the promo
// admin and a finance reader looking at this card likely needs to see
// them as separate entries (they may have different terms / expiries
// even when the strings rhyme). Returns top-N rows + the distinct-code
// total for the card header.
export function topPromoCodesFromMatches(
  matchRows: MatchRow[],
  month: Q2Month,
): TopPromoCodesResult {
  const monthPrefix = Q2_MONTH_PREFIX[month];
  const counts = new Map<string, number>();
  for (const r of matchRows) {
    if (r.matchCanceled) continue;
    if (!isInMonth(r.matchStart, monthPrefix)) continue;
    const code = r.promocode?.trim();
    if (!code) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const rows: TopPromoCodeRow[] = [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
  return { rows, distinctCount: counts.size };
}
