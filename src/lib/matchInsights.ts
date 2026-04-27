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
