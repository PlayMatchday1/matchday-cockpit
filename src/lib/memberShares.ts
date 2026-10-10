/* MEMBERSHIP ONTO FIELDS — the Cities page's rule (cityPnl.ts, "ALLOCATE membership onto the
 * pitches"), as Finance › Revenue applies it to fin_txn membership (revenueTxn.allocateMembership):
 * a field's share of a city-month's membership = the field's member spots that month ÷ the city's
 * member spots that month. ONE implementation for Revenue, Cost and Cities (2026-10-10).
 *
 * TWO SOURCES OF THE SAME COUNT. `sharesFromData` reads the roster index the finance loader builds
 * (buildMdapiMemberSpotIndex); `sharesFromSpots` reads fin_member_spots_by_venue_month (0222), the
 * same count summed in the database — equal venue-month for venue-month (Jul–Oct 2026: 86 of 86;
 * Jan–Jun 2025: 35 of 35, measured 2026-10-10). The city total is the bucket of the FIRST leg's city
 * string, exactly as cityTotalMemberSpotsFor keys it. Null when the month has no member spots. */
import type { FinanceData } from "./useFinanceData";
import { cityTotalMemberSpotsFor, venueMemberSpotsFor } from "./financeStats";
import { canonCity } from "./fieldEconomics";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-01" → "Sep 2026", the roster loader's month label. */
const monthLabel = (periodKey: string) => `${MON[Number(periodKey.slice(5, 7)) - 1]} ${periodKey.slice(0, 4)}`;

export type Share = { venueId: number; share: number };

export function sharesFromData(d: FinanceData, city: string, periodKey: string): Share[] | null {
  const month = monthLabel(periodKey) as Parameters<typeof cityTotalMemberSpotsFor>[2];
  const legs = d.venues.filter((v) => canonCity(v.city) === canonCity(city));
  if (legs.length === 0) return null;
  const citySpots = cityTotalMemberSpotsFor(d, legs[0].city, month);
  if (!(citySpots > 0)) return null;
  return legs
    .map((v) => ({ venueId: Number(v.id), share: venueMemberSpotsFor(d, v.id, month).member / citySpots }))
    .filter((x) => x.share > 0);
}

export type SpotMap = Map<string, { ym: string; city: string | null; spots: number }>; // `${venueId}|YYYY-MM`

export function sharesFromSpots(venues: readonly { id: number; city: string | null }[], spots: SpotMap, city: string, periodKey: string): Share[] | null {
  const ym = periodKey.slice(0, 7);
  const legs = venues.filter((v) => canonCity(v.city) === canonCity(city));
  if (legs.length === 0) return null;
  const of = (vid: number) => spots.get(`${vid}|${ym}`)?.spots ?? 0;
  let citySpots = 0;
  for (const x of spots.values()) if (x.ym === ym && x.city === legs[0].city) citySpots += x.spots;
  if (!(citySpots > 0)) return null;
  return legs.map((v) => ({ venueId: Number(v.id), share: of(Number(v.id)) / citySpots })).filter((x) => x.share > 0);
}
