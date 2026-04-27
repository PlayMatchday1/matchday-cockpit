// Member-Heavy Fields insight, sourced from user_analysis (match_registrations)
// instead of the manually-maintained Member Spots Sheet. The sheet was
// retired because it was a stale, hand-curated proxy for what we already
// know per-registration: every paid match in user_analysis carries a
// "Type Of Payment" of MEMBER, DAILY PAID, or a promo / other tag.
//
// For each canonicalized field in the active month, we count
// non-cancelled registrations and compute the share that paid as a
// member. A field is flagged "member-heavy" when it clears both the
// volume floor (so a single 5-member private rental doesn't dominate)
// and the mix threshold below.

import type { MatchRow } from "./useMatchData";
import type { FinanceData, FinVenue } from "./useFinanceData";
import type { Q2Month } from "./financeStats";
import { normalizeMatchName } from "./venueNormalization";

// Pinned to 0.35 because no venue clears 0.50 at present (Apr 2026 high
// is San Juan Diego at 0.49). 0.35 surfaces ~6 venues that meaningfully
// over-index on members vs the company average. Bump as the membership
// program scales.
export const MEMBER_HEAVY_THRESHOLD = 0.35;
export const MEMBER_HEAVY_MIN_SPOTS = 30;

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

function paymentBucket(paymentType: string | null): "member" | "daily" | "other" {
  if (!paymentType) return "other";
  const lc = paymentType.trim().toLowerCase();
  if (lc === "member") return "member";
  if (lc === "daily paid" || lc === "daily" || lc === "daily_paid") return "daily";
  return "other";
}

export function memberHeavyFieldsFromMatches(
  matchRows: MatchRow[],
  data: FinanceData,
  month: Q2Month,
): MemberHeavyRow[] {
  const monthPrefix = Q2_MONTH_PREFIX[month];
  // Canonical venue_name → city, for the city column on the rendered list
  // and to discard fields that don't resolve to any tracked venue (e.g.
  // typos, archived test venues).
  const venueByName = new Map<string, FinVenue>();
  for (const v of data.venues) venueByName.set(v.venue_name, v);

  type Bucket = { city: string; total: number; member: number; daily: number };
  const buckets = new Map<string, Bucket>();

  for (const r of matchRows) {
    if (r.matchCanceled) continue;
    const isoMonth = `${r.matchStart.getFullYear()}-${String(
      r.matchStart.getMonth() + 1,
    ).padStart(2, "0")}`;
    if (isoMonth !== monthPrefix) continue;
    const canonical = normalizeMatchName(r.field, data.venueAliases).canonical;
    if (!canonical) continue;
    const venue = venueByName.get(canonical);
    if (!venue) continue; // not a tracked fin_venues entry

    const cur = buckets.get(canonical) ?? {
      city: venue.city,
      total: 0,
      member: 0,
      daily: 0,
    };
    cur.total += 1;
    const bucket = paymentBucket(r.paymentType);
    if (bucket === "member") cur.member += 1;
    else if (bucket === "daily") cur.daily += 1;
    buckets.set(canonical, cur);
  }

  const rows: MemberHeavyRow[] = [];
  for (const [venue, b] of buckets) {
    if (b.total < MEMBER_HEAVY_MIN_SPOTS) continue;
    const pct = b.total > 0 ? b.member / b.total : 0;
    if (pct < MEMBER_HEAVY_THRESHOLD) continue;
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
