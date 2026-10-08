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
import { clusterOutside, effectiveVerdict } from "./locationsInsights";
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
  /** Migration 0216: worked out by the sync from lat/lng. */
  state: string | null;
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
/** A "New markets" row: outside-coverage players clustered within 25 miles of each other. */
export type PlaceRow = { key: string; place: string; players: number; nearestCityId: number | null; nearestMi: number | null };

export type LocationsReport = {
  dataAsOf: string | null;
  lastRun: { startedAt: string; finishedAt: string | null; ok: boolean | null; error: string | null; complete: boolean | null } | null;
  trackingSince: string | null;
  cities: AreaCity[];
  playersTotal: number | null;
  kpis: { areaSet: number; gps: number; zip: number; never: number | null; outside: number; unidentified: number; seeded: number };
  /** Location set among ACTIVE players (src/lib/playerActivity.ts — the Users lens's active-30-day
   *  definition), staff accounts removed. null if the active set could not be read. */
  active: { withLocation: number; total: number } | null;
  /** Cities with an active field — the only ones offered as city pills. null = not known. */
  marketIds: number[] | null;
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
  /** Active player ids (any email) and the staff ids to remove from them. */
  activeIds?: Set<number> | null;
  /** Cities with an active field. A player "in market" for any other city counts as outside
   *  coverage (the sync stores the same; applying it here keeps the page right before the next run). */
  markets?: ReadonlySet<number> | null;
  internalIds?: Set<number> | null;
  now: Date;
}): LocationsReport {
  const { names, now } = input;
  // Labels become "City, ST" ONCE, here, so every group, name and export below carries the state —
  // and Grandview, MO and Grandview, WA are two places, not one.
  const live = input.rows.filter((r) => r.has_area && !r.is_internal)
    .map((r) => ({ ...r, area_label: placeName(r.area_label, r.state) }))
    .map((r) => (input.markets ? effectiveVerdict(r, input.markets) : r));
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
  let active: LocationsReport["active"] = null;
  if (input.activeIds) {
    const staff = input.internalIds ?? new Set<number>();
    let total = 0;
    for (const id of input.activeIds) if (!staff.has(id)) total++;
    active = { withLocation: live.filter((r) => input.activeIds!.has(r.player_id)).length, total };
  }

  const todayYmd = chicagoYmd(now.toISOString());
  const weekAgo = now.getTime() - 7 * DAY_MS;
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
  // "No area" is no longer a table row — the page states kpis.never in a line above the table.
  zips.sort((a, b) => b.players - a.players || a.key.localeCompare(b.key));

  const unid = new Map<string, number>();
  for (const r of live) if (r.verdict === "unidentified") {
    const z = r.zip ?? "(no zip)";
    unid.set(z, (unid.get(z) ?? 0) + 1);
  }
  const unidentified = [...unid].map(([zip, players]) => ({ zip, players }))
    .sort((a, b) => b.players - a.players || a.zip.localeCompare(b.zip));

  // NEW MARKETS: outside-coverage players clustered within 25 miles of each other — the same
  // clusters the Map tab lists (src/lib/locationsInsights.ts).
  const outside: PlaceRow[] = clusterOutside(
    live.filter((r) => r.verdict === "waitlist" && r.lat != null && r.lng != null)
      .map((r) => ({ lat: r.lat as number, lng: r.lng as number, label: r.area_label, zip: r.zip, key: String(r.player_id) })),
    cities,
  ).map((c) => ({ key: c.key, place: c.name, players: c.players, nearestCityId: c.nearestCityId, nearestMi: c.nearestCityMi }));

  return {
    dataAsOf: input.okRun?.finished_at ?? null,
    lastRun: input.run ? { startedAt: input.run.started_at, finishedAt: input.run.finished_at, ok: input.run.ok,
      error: input.run.error, complete: input.run.complete } : null,
    trackingSince: input.firstRunAt,
    cities, playersTotal, kpis, active, marketIds: input.markets ? [...input.markets] : null, today, last7, days, recent, zips, unidentified, outside,
  };
}
