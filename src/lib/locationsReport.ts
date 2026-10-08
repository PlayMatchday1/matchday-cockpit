// THE LOCATIONS PAGE, aggregated — pure. The route reads player_area_seen + the latest sync run and
// hands them here; the browser receives only these totals and groups, never the raw rows.
//
// CLOCK: first_seen_at is a TRUE UTC instant (our own sync's now()), bucketed into America/Chicago
// days with chicagoYmd. Never wallClockYmd — that is for match dates.
//
// SEEDED ROWS are areas set before tracking began. They count toward coverage, but they are kept out
// of Today / Last 7 days / Last 30 days and out of the per-day bars, because their first_seen_at is
// the first sync run, not the day the player set anything.

import { chicagoYmd } from "./weekBuckets";
import { areaGroupKey, areaGroupName, placeName, sourceKind, type AreaCity, type SourceKind, type Verdict } from "./playerAreaModel";

export type SeenRow = {
  player_id: number;
  first_seen_at: string;
  seeded: boolean;
  has_area: boolean;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  area_label: string | null;
  area_source: string | null;
  is_internal: boolean;
  verdict: Verdict;
  verdict_city_id: number | null;
  nearest_city_id: number | null;
  nearest_city_mi: number | null;
};

export type DayPoint = { day: string; zip: number; gps: number; cumulative: number; coveragePct: number | null };
export type RecentRow = {
  playerId: number; name: string | null; firstSeenAt: string; seeded: boolean;
  zip: string | null; label: string | null; sourceRaw: string | null; source: SourceKind;
  verdict: Verdict; cityId: number | null;
};
/** `area` is what the row is called: its zip, or for a no-zip ~1-mile grid cell the area label its
 *  players share, else "GPS, no zip" (playerAreaModel.areaGroupName). */
export type ZipRow = {
  key: string; zip: string | null; area: string; label: string | null; players: number;
  nearestCityId: number | null; nearestMi: number | null;
  verdict: Verdict | "no_area"; verdictCityId: number | null;
};
export type PlaceRow = { key: string; place: string; players: number; last30: number; nearestCityId: number | null; nearestMi: number | null };

export type LocationsReport = {
  dataAsOf: string | null;
  lastRun: { startedAt: string; finishedAt: string | null; ok: boolean | null; error: string | null; complete: boolean | null } | null;
  trackingSince: string | null;
  cities: AreaCity[];
  playersTotal: number | null;
  kpis: { areaSet: number; gps: number; zip: number; never: number | null; outside: number; unidentified: number; seeded: number };
  today: number;
  last7: number;
  days: DayPoint[];
  recent: RecentRow[];
  zips: ZipRow[];
  unidentified: { zip: string; players: number }[];
  outside: PlaceRow[];
};

const DAY_MS = 86_400_000;
const kindOf = (r: SeenRow) => sourceKind(r.area_source);
/** A set area with no zip at all — not expected (GPS shares get a zip looked up), kept so none is lost. */
/** A set area with neither a zip nor coordinates — nothing to group it on. Not expected. */
const NO_LOCATION = "No zip or location";

/** Next calendar day of a YYYY-MM-DD, by UTC-noon arithmetic on the date alone (no time zone). */
function nextYmd(ymd: string): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

function mode<T>(xs: T[]): T {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1])[0][0];
}

export function buildLocationsReport(input: {
  rows: SeenRow[];
  names: Map<number, string>;
  run: { started_at: string; finished_at: string | null; ok: boolean | null; error: string | null; complete: boolean | null } | null;
  okRun: { finished_at: string; players_total: number | null; players_internal: number | null; cities: unknown } | null;
  firstRunAt: string | null;
  now: Date;
}): LocationsReport {
  const { names, now } = input;
  const live = input.rows.filter((r) => r.has_area && !r.is_internal);
  const cities = (Array.isArray(input.okRun?.cities) ? input.okRun!.cities : []) as AreaCity[];
  const playersTotal = input.okRun?.players_total != null
    ? input.okRun.players_total - (input.okRun.players_internal ?? 0) : null;

  const kinds = live.map(kindOf);
  const kpis = {
    areaSet: live.length,
    gps: kinds.filter((k) => k === "gps").length,
    zip: kinds.filter((k) => k === "zip").length,
    never: playersTotal == null ? null : Math.max(0, playersTotal - live.length),
    outside: live.filter((r) => r.verdict === "waitlist").length,
    unidentified: live.filter((r) => r.verdict === "unidentified").length,
    seeded: live.filter((r) => r.seeded).length,
  };

  const todayYmd = chicagoYmd(now.toISOString());
  const weekAgo = now.getTime() - 7 * DAY_MS;
  const monthAgo = now.getTime() - 30 * DAY_MS;
  const fresh = live.filter((r) => !r.seeded);
  const today = fresh.filter((r) => chicagoYmd(r.first_seen_at) === todayYmd).length;
  const last7 = fresh.filter((r) => Date.parse(r.first_seen_at) >= weekAgo).length;

  // Per-day bars from the first real (non-seeded) first_seen day through today; coverage includes
  // the seeded baseline so the line starts where adoption actually was.
  const days: DayPoint[] = [];
  if (fresh.length > 0) {
    const byDay = new Map<string, { zip: number; gps: number }>();
    for (const r of fresh) {
      const d = chicagoYmd(r.first_seen_at);
      const b = byDay.get(d) ?? { zip: 0, gps: 0 };
      if (kindOf(r) === "gps") b.gps++; else b.zip++;
      byDay.set(d, b);
    }
    let cum = kpis.seeded;
    const start = [...byDay.keys()].sort()[0];
    for (let d = start; d <= todayYmd; d = nextYmd(d)) {
      const b = byDay.get(d) ?? { zip: 0, gps: 0 };
      cum += b.zip + b.gps;
      days.push({ day: d, zip: b.zip, gps: b.gps, cumulative: cum,
        coveragePct: playersTotal ? (cum / playersTotal) * 100 : null });
    }
  }

  const recent: RecentRow[] = [...live]
    .sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at) || b.player_id - a.player_id)
    .slice(0, 100)
    .map((r) => ({
      playerId: r.player_id, name: names.get(r.player_id) ?? null, firstSeenAt: r.first_seen_at,
      seeded: r.seeded, zip: r.zip, label: r.area_label, sourceRaw: r.area_source,
      source: kindOf(r), verdict: r.verdict, cityId: r.verdict_city_id,
    }));

  // Grouped by zip; a player with no zip groups by ~1-mile grid cell of their coordinates — the same
  // rule as the Map (playerAreaModel.areaGroupKey), so one city-wide "no zip" row never averages
  // players miles apart.
  const groups = new Map<string, SeenRow[]>();
  for (const r of live) {
    const key = areaGroupKey(r.zip, r.lat, r.lng) ?? "no-location";
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const zips: ZipRow[] = [...groups].map(([key, g]) => {
    const verdict = mode(g.map((r) => r.verdict));
    const mis = g.map((r) => r.nearest_city_mi).filter((m): m is number => m != null);
    return {
      key, zip: g[0].zip,
      area: key === "no-location" ? NO_LOCATION : areaGroupName(g[0].zip, g.map((r) => r.area_label)),
      label: g.find((r) => r.area_label)?.area_label ?? null, players: g.length,
      nearestCityId: mode(g.map((r) => r.nearest_city_id)),
      nearestMi: mis.length ? Math.min(...mis) : null,
      verdict, verdictCityId: verdict === "in_market" ? mode(g.map((r) => r.verdict_city_id)) : null,
    };
  });
  if (kpis.never != null) {
    zips.push({ key: "no_area", zip: null, area: "No area", label: null, players: kpis.never, nearestCityId: null,
      nearestMi: null, verdict: "no_area", verdictCityId: null });
  }
  zips.sort((a, b) => b.players - a.players || a.key.localeCompare(b.key));

  const unid = new Map<string, number>();
  for (const r of live) if (r.verdict === "unidentified") {
    const z = r.zip ?? "(no zip)";
    unid.set(z, (unid.get(z) ?? 0) + 1);
  }
  const unidentified = [...unid].map(([zip, players]) => ({ zip, players }))
    .sort((a, b) => b.players - a.players || a.zip.localeCompare(b.zip));

  const places = new Map<string, SeenRow[]>();
  for (const r of live) if (r.verdict === "waitlist") {
    // Label, else zip, else grid cell — two unlabelled no-zip players miles apart are two places.
    const p = r.area_label ? `label:${r.area_label}` : areaGroupKey(r.zip, r.lat, r.lng) ?? "no-location";
    const g = places.get(p) ?? [];
    g.push(r);
    places.set(p, g);
  }
  const outside: PlaceRow[] = [...places].map(([key, g]) => {
    const mis = g.map((r) => r.nearest_city_mi).filter((m): m is number => m != null);
    const raw = key.startsWith("label:") ? key.slice(6)
      : key === "no-location" ? NO_LOCATION : areaGroupName(g[0].zip, g.map((r) => r.area_label));
    const place = placeName(raw) ?? raw;
    return {
      key, place, players: g.length,
      last30: g.filter((r) => !r.seeded && Date.parse(r.first_seen_at) >= monthAgo).length,
      nearestCityId: mode(g.map((r) => r.nearest_city_id)),
      nearestMi: mis.length ? Math.min(...mis) : null,
    };
  }).sort((a, b) => b.players - a.players || a.place.localeCompare(b.place));

  return {
    dataAsOf: input.okRun?.finished_at ?? null,
    lastRun: input.run ? { startedAt: input.run.started_at, finishedAt: input.run.finished_at, ok: input.run.ok,
      error: input.run.error, complete: input.run.complete } : null,
    trackingSince: input.firstRunAt,
    cities, playersTotal, kpis, today, last7, days, recent, zips, unidentified, outside,
  };
}
