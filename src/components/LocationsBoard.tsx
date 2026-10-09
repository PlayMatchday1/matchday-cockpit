"use client";

// LOCATIONS — where players say they live, and how fast they are telling us (Ryan, 2026-10-08).
// Data: GET /api/growth/locations, which reads player_area_seen (written every 6 hours by
// /api/sync/player-areas). This page never calls MatchDay. Aggregation is server-side; the only
// thing computed here is the filtered VIEW of rows the server already grouped.
//
// Styling borrows Master Schedule's card / chip / refresh vocabulary (VeoMasterSchedule's CSS),
// copied rather than imported because that CSS is a string private to that component.
//
// TWO TABS, KEPT IN THE URL: ?tab=map opens the Map (LocationsMapTab), and ?city=<id> opens a city
// inside it, so a link lands on exactly what was shared. No tab param = Overview.
//
// TODO(api): four fields the MatchDay API does not expose yet, so this page leaves them out entirely
// (no empty columns, no placeholder cards). Wire each in when /admin/players carries it:
//   - area city id        → replace the computed verdict with the backend's own assignment
//   - area set time        → replace "First seen" (accurate to one sync interval) with the real time
//   - location permission  → a permission column on Recent activity and a KPI split
//   - notify requested time → "tapped notify me" counts and the notify-me CSV on Outside coverage

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import LocationsMapTab from "@/components/LocationsMapTab";
import LocationsSyncNow from "@/components/LocationsSyncNow";
import LocationsPlayerDetail from "@/components/LocationsPlayerDetail";
import LocationsOpenNext from "@/components/LocationsOpenNext";
import { Fragment } from "react";
import { supabase } from "@/lib/supabase";
import RefreshIcon from "@/components/RefreshIcon";
import { downloadCsv } from "@/components/growth/format";
import { placeName } from "@/lib/playerAreaModel";
import { type LocationsReport, type ZipRow, type DayPoint } from "@/lib/locationsReport";

const CHI = "America/Chicago";
const fmtWhen = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: CHI, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const fmtDay = (ymd: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));
const int = (n: number) => n.toLocaleString("en-US");
const mi = (n: number | null) => (n == null ? "—" : `${n < 10 ? n.toFixed(1) : Math.round(n)} mi`);

const ZIP_COLOR = "#1baf7a";
const STALE_AFTER_MINS = 6 * 60 + 30;
const GPS_COLOR = "#2a78d6";

type VerdictFilter = "all" | "in_market" | "waitlist" | "unidentified" | "no_area";
const VERDICT_FILTERS: { key: VerdictFilter; label: string }[] = [
  { key: "all", label: "All" }, { key: "in_market", label: "In market" }, { key: "waitlist", label: "Outside coverage" },
  { key: "unidentified", label: "Unidentified" },
];

export default function LocationsBoard() {
  const [data, setData] = useState<LocationsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [city, setCity] = useState<number | null>(null);
  const [vf, setVf] = useState<VerdictFilter>("all");
  // ONE expanded Recent activity row at a time; clicking it again closes it.
  const [openPlayer, setOpenPlayer] = useState<number | null>(null);
  // The two long tables start COLLAPSED behind a "Show …" bar. Their open state lives here, above
  // the data, so a Refresh or the reload after Sync now never snaps them shut; it is also kept for
  // the browser session (sessionStorage) so a page reload keeps it too.
  const [showPlayers, setShowPlayers] = useSessionFlag("loc:showPlayers");
  const [showAreas, setShowAreas] = useSessionFlag("loc:showAreas");
  const [mapReload, setMapReload] = useState(0);

  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab: "overview" | "map" = params.get("tab") === "map" ? "map" : "overview";
  const mapCityRaw = Number(params.get("city"));
  const mapCity = Number.isInteger(mapCityRaw) && mapCityRaw > 0 ? mapCityRaw : null;
  const go = useCallback((next: { tab: "overview" | "map"; city?: number | null }) => {
    const p = new URLSearchParams();
    if (next.tab === "map") p.set("tab", "map");
    if (next.tab === "map" && next.city != null) p.set("city", String(next.city));
    const q = p.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }, [pathname, router]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch("/api/growth/locations", {
        cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setData(body as LocationsReport);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Refresh and a finished Sync now re-read BOTH tabs (Supabase only).
  const [openNextReload, setOpenNextReload] = useState(0);
  const reloadAll = useCallback(() => { void load(); setMapReload((k) => k + 1); setOpenNextReload((k) => k + 1); }, [load]);

  const cityName = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of data?.cities ?? []) m.set(c.id, c.name);
    return (id: number | null) => (id == null ? "—" : m.get(id) ?? `City ${id}`);
  }, [data]);

  const verdictLabel = useCallback((r: Pick<ZipRow, "verdict" | "verdictCityId">) =>
    r.verdict === "in_market" ? cityName(r.verdictCityId)
      : r.verdict === "waitlist" ? "Outside coverage"
      : r.verdict === "unidentified" ? "Unidentified" : "No area", [cityName]);
  // City pills: only cities with an active field (a city without one is not a market).
  const pillCities = useMemo(() => {
    const ids = data?.marketIds ? new Set(data.marketIds) : null;
    return (data?.cities ?? []).filter((c) => !ids || ids.has(c.id));
  }, [data]);

  const zipView = useMemo(() => (data?.zips ?? []).filter((r) => {
    if (vf !== "all" && r.verdict !== vf) return false;
    if (city == null) return true;
    return (r.verdict === "in_market" && r.verdictCityId === city) || (r.verdict === "waitlist" && r.nearestCityId === city);
  }), [data, vf, city]);

  const exportZips = () => {
    const rows: (string | number)[][] = [["Area", "Zip", "Place", "Players", "Nearest city", "Distance (mi)", "Status"]];
    for (const r of zipView) rows.push([
      r.zip ?? placeName(r.area) ?? r.area, r.zip ?? "", placeName(r.label) ?? "", r.players,
      r.verdict === "unidentified" ? "" : cityName(r.nearestCityId),
      r.verdict === "unidentified" ? "" : r.nearestMi ?? "",
      verdictLabel(r),
    ]);
    const tag = [city != null ? cityName(city) : "", vf !== "all" ? vf : ""].filter(Boolean).join("-").replace(/[^A-Za-z0-9-]+/g, "_");
    downloadCsv(`player-locations${tag ? "-" + tag : ""}.csv`, rows);
  };

  // Freshness stamp: the last SUCCESSFUL sync's finish time. A newer failed run is said out loud.
  const asOf = data?.dataAsOf ?? null;
  const staleMins = asOf ? Math.floor((Date.now() - Date.parse(asOf)) / 60000) : 0;
  // The sync runs every 6 hours at :40 UTC (vercel.json). Stale = one interval plus 30 minutes of
  // slack for a slow or in-progress run — so a single missed run is what turns the stamp grey.
  const stale = staleMins > STALE_AFTER_MINS;
  const lastFailed = data?.lastRun && data.lastRun.ok === false;

  return (
    <div className="loc">
      <style>{CSS}</style>

      <div className="loc-card">
        <div className="loc-head">
          <div>
            <div className="loc-h-title">Locations</div>
            <div className="loc-h-sub">Home areas players have shared in the app. Staff accounts are not counted.</div>
          </div>
          <div className="loc-h-right">
            <span className="loc-fresh">
              <button type="button" className="loc-refresh" data-testid="loc-refresh" disabled={refreshing}
                title="Re-read Clubhouse. The sync from MatchDay runs every 6 hours; this button does not call MatchDay."
                onClick={reloadAll}>
                <RefreshIcon size={14} spinning={refreshing} />
                <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
              </button>
              <span className={"loc-stamp" + (lastFailed ? " loc-stamp-failed" : stale ? " loc-stamp-stale" : "")} data-testid="data-as-of">
                {!data ? "Loading…"
                  : !asOf ? "No sync has completed yet"
                  : `Data as of ${fmtWhen(asOf)}${stale ? ` (${staleMins >= 120 ? `${Math.floor(staleMins / 60)} hours` : `${staleMins} minutes`} ago)` : ""}${lastFailed ? ". Last sync failed." : ""}`}
              </span>
            </span>
            <LocationsSyncNow onFinished={reloadAll} />
          </div>
        </div>
        <div className="loc-tabs" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={tab === "overview"} data-testid="tab-overview"
            className={"loc-tab" + (tab === "overview" ? " loc-tab-on" : "")} onClick={() => go({ tab: "overview" })}>Overview</button>
          <button type="button" role="tab" aria-selected={tab === "map"} data-testid="tab-map"
            className={"loc-tab" + (tab === "map" ? " loc-tab-on" : "")} onClick={() => go({ tab: "map", city: mapCity })}>Map</button>
        </div>
        {lastFailed && data?.lastRun?.error && (
          <div className="loc-warn">Last sync failed at {fmtWhen(data.lastRun.startedAt)}: {data.lastRun.error}</div>
        )}
        {data?.lastRun?.ok && data.lastRun.complete === false && (
          <div className="loc-warn">The last sync did not receive every player from MatchDay; counts may be short until the next run.</div>
        )}
      </div>

      {tab === "map" ? (
        <LocationsMapTab cityId={mapCity} reloadKey={mapReload}
          onCity={(id) => go({ tab: "map", city: id })} />
      ) : error && !data ? (
        <div className="loc-card"><div className="loc-state">{error} <button type="button" className="loc-btn" onClick={() => void load()}>Retry</button></div></div>
      ) : !data ? (
        <div className="loc-card"><div className="loc-state">Loading locations…</div></div>
      ) : !data.dataAsOf ? (
        <div className="loc-card"><div className="loc-state">The location sync has not completed a run yet. It runs every 6 hours.</div></div>
      ) : (
        <>
          {error && <div className="loc-card"><div className="loc-warn">Couldn&apos;t refresh: {error}. Showing the last data loaded.</div></div>}

          {/* 1 — KPI cards */}
          <div className="loc-kpis" data-testid="loc-kpis">
            {/* LOCATION SET — "coverage" means "near a field" on the Map tab, so here it is "Location
                set" everywhere. Main number: ACTIVE players (the Users lens's 30-day definition,
                src/lib/playerActivity.ts); underneath: all players. */}
            <Kpi label="Location set" testId="kpi-location-set"
              value={data.active
                // "or booked", not just "played": the Users lens definition counts an upcoming booking,
                // and on 2026-10-08 six of the nine active players with a location had booked but not
                // yet played. "Played" alone would have been false for most of them.
                ? <>{int(data.active.withLocation)} of {int(data.active.total)}<span className="loc-kpi-unit loc-kpi-unit-line">active players (played or booked in the last 30 days)</span></>
                : <>{int(data.kpis.areaSet)} <span className="loc-kpi-unit">players</span></>}
              sub={data.playersTotal != null ? `${int(data.kpis.areaSet)} of ${int(data.playersTotal)} including inactive and new signups` : `${int(data.kpis.areaSet)} players`}
              note={data.active ? undefined : "Active players could not be read just now."} />
            <Kpi label="GPS" value={int(data.kpis.gps)} sub="shared their location" />
            <Kpi label="Zip only" value={int(data.kpis.zip)} sub="typed a home zip" />
            <Kpi label="Never set a location" value={data.kpis.never == null ? "—" : int(data.kpis.never)} sub="have not set a location" />
            <Kpi label="Outside coverage" value={int(data.kpis.outside)} sub="no city within range" />
            <Kpi label="Unidentified zips" value={int(data.kpis.unidentified)} sub="zip we could not place" />
          </div>

          {/* 2 — Recent activity */}
          <div className="loc-card">
            <div className="loc-sec-head">
              <div className="loc-sec-title">Recent activity</div>
              <div className="loc-mini">
                <span><b data-testid="loc-today">{int(data.today)}</b> today</span>
                <span><b data-testid="loc-last7">{int(data.last7)}</b> last 7 days</span>
              </div>
            </div>
            <div className="loc-body">
              {data.days.length === 0 ? (
                <div className="loc-empty">
                  No new locations since tracking began{data.trackingSince ? ` on ${fmtWhen(data.trackingSince)}` : ""}.
                </div>
              ) : (
                <AdoptionCharts days={data.days} seeded={data.kpis.seeded} />
              )}
            </div>
            <ShowBar open={showPlayers} onToggle={() => setShowPlayers(!showPlayers)} testId="show-players"
              label={`Show players (${int(data.recent.length)})`} openLabel={`Hide players (${int(data.recent.length)})`} />
            {showPlayers && (
              <>
                <div className="loc-tablewrap">
                  <table className="loc-table" data-testid="loc-recent">
                    <thead><tr><th>First seen</th><th>Player</th><th>Area</th><th>Source</th><th>City</th></tr></thead>
                    <tbody>
                      {data.recent.length === 0 && <tr><td colSpan={5} className="loc-td-empty">No player has set a location yet.</td></tr>}
                      {data.recent.map((r) => {
                        const open = openPlayer === r.playerId;
                        return (
                          <Fragment key={r.playerId}>
                            <tr className={"loc-row-x" + (open ? " loc-row-open" : "")} tabIndex={0} aria-expanded={open}
                              data-testid={`recent-row-${r.playerId}`}
                              onClick={(e) => { if ((e.target as HTMLElement).closest("a")) return; setOpenPlayer(open ? null : r.playerId); }}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenPlayer(open ? null : r.playerId); } }}>
                              <td className="loc-nowrap">{r.seeded ? <span className="loc-muted" title="Set before tracking began">Before tracking</span> : fmtWhen(r.firstSeenAt)}</td>
                              <td><a className="loc-link" href={`/match-ops/player-lookup?id=${r.playerId}`}>{r.name ?? `Player ${r.playerId}`}</a></td>
                              <td>{r.zip ?? placeName(r.label) ?? "—"}{r.zip && r.label ? <span className="loc-muted"> ({placeName(r.label)})</span> : null}</td>
                              <td className="loc-nowrap">{r.source === "zip" ? "Zip" : "GPS"}</td>
                              <td>{r.verdict === "in_market" ? cityName(r.cityId) : r.verdict === "waitlist" ? "Outside coverage" : "Unidentified"}</td>
                            </tr>
                            {open && (
                              <tr className="loc-row-detail"><td colSpan={5} style={{ padding: 0 }}><LocationsPlayerDetail playerId={r.playerId} /></td></tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="loc-foot">First seen is when Clubhouse first saw the location, within 6 hours of when it was set.</div>
              </>
            )}
          </div>

          {/* 3 — Player locations */}
          <div className="loc-card">
            <div className="loc-sec-head">
              <div className="loc-sec-title">Player locations</div>
              {showAreas && <button type="button" className="loc-btn" onClick={exportZips} disabled={zipView.length === 0}>Export CSV</button>}
            </div>
            <ShowBar open={showAreas} onToggle={() => setShowAreas(!showAreas)} testId="show-areas"
              label={`Show areas (${int(zipView.length)})`} openLabel={`Hide areas (${int(zipView.length)})`} />
            {showAreas && (
              <>
                <div className="loc-filter" role="group" aria-label="Filter cities">
                  <span className="loc-control-label">Cities</span>
                  <button type="button" aria-pressed={city === null} className={"loc-chip" + (city === null ? " loc-chip-on" : "")} onClick={() => setCity(null)}>All cities</button>
                  {pillCities.map((c) => (
                    <button type="button" key={c.id} aria-pressed={city === c.id} className={"loc-chip" + (city === c.id ? " loc-chip-on" : "")}
                      onClick={() => setCity(c.id)}>{c.name}</button>
                  ))}
                </div>
                <div className="loc-filter" role="group" aria-label="Filter status">
                  <span className="loc-control-label">Status</span>
                  {VERDICT_FILTERS.map((f) => (
                    <button type="button" key={f.key} aria-pressed={vf === f.key} className={"loc-chip" + (vf === f.key ? " loc-chip-on" : "")}
                      onClick={() => setVf(f.key)}>{f.label}</button>
                  ))}
                </div>
                {data.kpis.never != null && (
                  <div className="loc-line" data-testid="loc-no-area">{int(data.kpis.never)} {data.kpis.never === 1 ? "player has" : "players have"} not set a location.</div>
                )}
                <div className="loc-tablewrap">
                  <table className="loc-table" data-testid="loc-zips">
                    <thead><tr><th>Area</th><th className="loc-num">Players</th><th>Nearest city</th><th className="loc-num">Distance</th><th>Status</th></tr></thead>
                    <tbody>
                      {zipView.length === 0 && <tr><td colSpan={5} className="loc-td-empty">Nothing matches these filters.</td></tr>}
                      {zipView.map((r) => {
                        const placed = r.verdict === "in_market" || r.verdict === "waitlist";
                        return (
                          <tr key={r.key}>
                            <td>{r.zip ?? placeName(r.area) ?? r.area}</td>
                            <td className="loc-num">{int(r.players)}</td>
                            <td>{placed ? cityName(r.nearestCityId) : "—"}</td>
                            <td className="loc-num">{placed ? mi(r.nearestMi) : "—"}</td>
                            <td><span className={`loc-badge loc-badge-${r.verdict}`}>{verdictLabel(r)}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {/* 4 — Unidentified zips: only when there are any */}
          {data.unidentified.length > 0 && (
            <div className="loc-card">
              <div className="loc-sec-head"><div className="loc-sec-title">Unidentified zips</div></div>
              <div className="loc-tablewrap">
                <table className="loc-table" data-testid="loc-unidentified">
                  <thead><tr><th>Zip entered</th><th className="loc-num">Players</th></tr></thead>
                  <tbody>
                    {data.unidentified.map((u) => <tr key={u.zip}><td>{u.zip}</td><td className="loc-num">{int(u.players)}</td></tr>)}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 5 — Where to open next: new fields inside the cities we serve (server-computed). */}
          <LocationsOpenNext cities={pillCities} reloadKey={openNextReload} />

          {/* 6 — New markets: clusters of players outside every city (within 25 miles of each other). */}
          <div className="loc-card">
            <div className="loc-sec-head"><div className="loc-sec-title">New markets</div></div>
            <div className="loc-tablewrap">
              <table className="loc-table" data-testid="loc-outside">
                <thead><tr><th>Place</th><th className="loc-num">Players</th><th>Nearest city</th><th className="loc-num">Distance</th></tr></thead>
                <tbody>
                  {data.outside.length === 0 && <tr><td colSpan={4} className="loc-td-empty">No players outside coverage yet.</td></tr>}
                  {data.outside.map((p) => (
                    <tr key={p.key}>
                      <td>{p.place}</td><td className="loc-num">{int(p.players)}</td>
                      <td>{cityName(p.nearestCityId)}</td><td className="loc-num">{mi(p.nearestMi)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** A boolean kept for the browser session. Read AFTER mount (the first render is the default, false)
 *  so server and client render the same markup; storage can be unavailable, so every access is
 *  guarded and the flag simply works for the page's lifetime without it. */
function useSessionFlag(key: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(false);
  useEffect(() => {
    try { if (window.sessionStorage.getItem(key) === "1") setV(true); } catch { /* storage unavailable */ }
  }, [key]);
  const set = useCallback((next: boolean) => {
    setV(next);
    try { window.sessionStorage.setItem(key, next ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [key]);
  return [v, set];
}

/** The bar a collapsed table hides behind: "Show players (18)" with a chevron. */
function ShowBar({ open, onToggle, label, openLabel, testId }: { open: boolean; onToggle: () => void; label: string; openLabel: string; testId: string }) {
  return (
    <button type="button" className="loc-showbar" aria-expanded={open} data-testid={testId} onClick={onToggle}>
      <span>{open ? openLabel : label}</span>
      <svg className={"loc-chev" + (open ? " loc-chev-open" : "")} width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
  );
}

function Kpi({ label, value, sub, note, testId }: { label: string; value: React.ReactNode; sub: string; note?: string; testId?: string }) {
  return (
    <div className="loc-kpi" data-testid={testId}>
      <div className="loc-kpi-label">{label}</div>
      <div className="loc-kpi-value">{value}</div>
      <div className="loc-kpi-sub">{sub}</div>
      {note && <div className="loc-kpi-note" data-testid="gps-note">{note}</div>}
    </div>
  );
}

// Two charts on one shared day axis rather than bars and a % line on two y-scales: daily counts
// stacked by source on top, the running share of players with a location beneath. Hovering a day highlights it in both.
function AdoptionCharts({ days, seeded }: { days: DayPoint[]; seeded: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, PADL = 40, PADR = 12, BAR_H = 150, LINE_H = 90;
  const n = days.length;
  const slot = (W - PADL - PADR) / n;
  const barW = Math.max(2, Math.min(28, slot - 2));
  const x = (i: number) => PADL + i * slot + slot / 2;
  const maxBar = Math.max(1, ...days.map((d) => d.zip + d.gps));
  const yBar = (v: number) => 10 + (BAR_H - 30) * (1 - v / maxBar);
  const covs = days.map((d) => d.coveragePct ?? 0);
  const maxCov = Math.max(0.01, ...covs) * 1.15;
  const yLine = (v: number) => 8 + (LINE_H - 28) * (1 - v / maxCov);
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const h = hover != null ? days[hover] : null;
  const pctFmt = (v: number) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`;

  return (
    <div className="loc-chart">
      <div className="loc-legend">
        <span><i style={{ background: ZIP_COLOR }} />Zip</span>
        <span><i style={{ background: GPS_COLOR }} />GPS</span>
        <span className="loc-legend-tip">
          {h ? <>{fmtDay(h.day)}: <b>{h.zip}</b> zip, <b>{h.gps}</b> GPS, location set <b>{h.coveragePct == null ? "—" : pctFmt(h.coveragePct)}</b></>
            : seeded > 0 ? `${seeded} set before tracking began are in the location-set share, not in the bars` : "Hover a day for its numbers"}
        </span>
      </div>
      <div className="loc-chart-title">Players setting a location, per day</div>
      <svg viewBox={`0 0 ${W} ${BAR_H}`} className="loc-svg" role="img" aria-label="Players setting an area per day, by source">
        <line x1={PADL} x2={W - PADR} y1={yBar(0)} y2={yBar(0)} stroke="#dfe4da" />
        <text x={PADL - 6} y={yBar(maxBar) + 4} textAnchor="end" className="loc-axis">{maxBar}</text>
        <text x={PADL - 6} y={yBar(0) + 4} textAnchor="end" className="loc-axis">0</text>
        {days.map((d, i) => {
          const zipTop = yBar(d.zip), gpsTop = yBar(d.zip + d.gps);
          return (
            <g key={d.day}>
              <g opacity={hover == null || hover === i ? 1 : 0.45}>
                {d.zip > 0 && <rect x={x(i) - barW / 2} y={zipTop} width={barW} height={yBar(0) - zipTop} rx={d.gps > 0 ? 0 : 3} fill={ZIP_COLOR} />}
                {d.gps > 0 && <rect x={x(i) - barW / 2} y={gpsTop} width={barW} height={Math.max(0, zipTop - gpsTop - (d.zip > 0 ? 2 : 0))} rx={3} fill={GPS_COLOR} />}
              </g>
              {i % labelEvery === 0 && <text x={x(i)} y={BAR_H - 4} textAnchor="middle" className="loc-axis">{fmtDay(d.day)}</text>}
              <rect x={x(i) - slot / 2} y={0} width={slot} height={BAR_H} fill="transparent"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            </g>
          );
        })}
      </svg>
      <div className="loc-chart-title">Share of players who have set a location</div>
      <svg viewBox={`0 0 ${W} ${LINE_H}`} className="loc-svg" role="img" aria-label="Running share of players who have set a location">
        <line x1={PADL} x2={W - PADR} y1={yLine(0)} y2={yLine(0)} stroke="#dfe4da" />
        <text x={PADL - 6} y={yLine(0) + 4} textAnchor="end" className="loc-axis">0%</text>
        <text x={PADL - 6} y={yLine(covs[n - 1]) + 4} textAnchor="end" className="loc-axis">{pctFmt(covs[n - 1])}</text>
        <polyline fill="none" stroke="#003326" strokeWidth={2} strokeLinejoin="round"
          points={days.map((d, i) => `${x(i)},${yLine(d.coveragePct ?? 0)}`).join(" ")} />
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={4} y2={yLine(0)} stroke="#9fb3a8" strokeDasharray="3 3" />}
        {days.map((d, i) => (
          <g key={d.day}>
            {(hover === i || i === n - 1) && <circle cx={x(i)} cy={yLine(d.coveragePct ?? 0)} r={4} fill="#003326" stroke="#fff" strokeWidth={2} />}
            {i % labelEvery === 0 && <text x={x(i)} y={LINE_H - 4} textAnchor="middle" className="loc-axis">{fmtDay(d.day)}</text>}
            <rect x={x(i) - slot / 2} y={0} width={slot} height={LINE_H} fill="transparent"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          </g>
        ))}
      </svg>
    </div>
  );
}

const CSS = `
.loc{
  --forest:#003326;--ink:#0d1f18;--muted:#5C6B62;--paper:#fff;
  --line:#dfe4da;--slot:#EFF4EF;--mint:#2CDB87;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
  color:var(--ink);-webkit-font-smoothing:antialiased;max-width:1360px;margin:0 auto}
.loc *{box-sizing:border-box}
.loc-card{background:var(--paper);border:1px solid var(--line);border-radius:16px;
  box-shadow:0 9px 26px rgba(0,43,34,.075);overflow:hidden;margin-bottom:18px}
.loc-tabs{display:flex;gap:4px;padding:0 20px;border-top:1px solid var(--line)}
.loc-tab{border:0;background:transparent;font:inherit;font-size:12.5px;font-weight:800;color:var(--muted);
  padding:11px 12px 10px;cursor:pointer;border-bottom:2.5px solid transparent;margin-bottom:-1px}
.loc-tab:hover{color:var(--forest)}
.loc-tab-on{color:var(--forest);border-bottom-color:var(--forest)}
.loc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:18px 20px;flex-wrap:wrap}
.loc-h-title{font-size:16px;font-weight:900;letter-spacing:-.2px;color:var(--forest)}
.loc-h-sub{font-size:12px;color:var(--muted);margin-top:3px}
.loc-h-right{display:flex;align-items:center;gap:11px;flex-wrap:wrap}
.loc-control-label{font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.loc-btn{border:1px solid var(--line);background:#fff;color:var(--forest);font-size:12px;font-weight:800;
  padding:8px 15px;border-radius:10px;cursor:pointer;font-family:inherit}
.loc-btn:hover{background:var(--slot)}
.loc-btn:disabled{opacity:.55;cursor:default}
.loc-sync{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.loc-fresh{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.loc-refresh{display:inline-flex;align-items:center;gap:6px;min-height:32px;border:1px solid var(--line);
  border-radius:9px;background:#fff;color:var(--forest);font:inherit;font-size:12px;font-weight:700;padding:0 10px;cursor:pointer}
.loc-refresh:hover:not(:disabled){background:var(--slot)}
.loc-refresh:disabled{opacity:.6;cursor:default}
.loc-stamp{font-size:12px;color:#3D5349}
.loc-stamp-stale{color:#7C8A83}
.loc-stamp-failed{color:#A8391A;font-weight:600}
.loc-warn{padding:10px 20px;font-size:12.5px;color:#A8391A;background:#FFF4F0;border-top:1px solid var(--line)}
.loc-state{padding:26px 20px;font-size:13px;color:var(--muted);font-weight:650;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.loc-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:18px}
.loc-kpi{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:14px 16px;box-shadow:0 9px 26px rgba(0,43,34,.05)}
.loc-kpi-label{font-size:9.5px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:var(--muted)}
.loc-kpi-value{font-size:24px;font-weight:900;color:var(--forest);margin-top:6px;letter-spacing:-.4px;font-variant-numeric:tabular-nums}
.loc-row-muted td{color:var(--muted)}
.loc-showbar{display:flex;width:100%;align-items:center;justify-content:space-between;gap:10px;padding:11px 20px;border:0;
  border-top:1px solid var(--line);background:#FAFCFA;font:inherit;font-size:12.5px;font-weight:800;color:var(--forest);cursor:pointer;text-align:left}
.loc-showbar:hover{background:var(--slot)}
.loc-showbar:focus-visible{outline:2px solid #2CDB87;outline-offset:-2px}
.loc-chev{transition:transform .15s ease;flex:0 0 auto}
.loc-chev-open{transform:rotate(180deg)}
.loc-line{padding:10px 20px;font-size:12.5px;color:var(--ink);border-bottom:1px solid var(--line)}
.loc-kpi-unit{font-size:12px;font-weight:700;color:var(--muted);letter-spacing:0}
.loc-kpi-unit-line{display:block;margin-top:3px;line-height:1.3}
.loc-kpi-sub{font-size:11.5px;color:var(--muted);margin-top:2px}
.loc-kpi-note{font-size:10.5px;line-height:1.35;color:#8A5300;margin-top:6px}
.loc-sec-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.loc-sec-title{font-size:14px;font-weight:900;color:var(--forest)}
.loc-mini{display:flex;gap:16px;font-size:12.5px;color:var(--muted)}
.loc-mini b{font-size:18px;color:var(--forest);margin-right:4px;font-variant-numeric:tabular-nums}
.loc-body{padding:14px 20px;border-bottom:1px solid var(--line)}
.loc-empty{font-size:13px;color:var(--muted);padding:8px 0}
.loc-filter{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--line)}
.loc-chip{border:1px solid var(--line);background:#fff;color:var(--forest);font-family:inherit;font-size:11.5px;font-weight:800;
  padding:6px 13px;border-radius:99px;cursor:pointer}
.loc-chip:hover{background:var(--slot)}
.loc-chip-on{background:var(--forest);border-color:var(--forest);color:#fff}
.loc-chip-on:hover{background:var(--forest)}
.loc-tablewrap{overflow-x:auto}
.loc-table{width:100%;border-collapse:collapse;font-size:12.5px}
.loc-table th{text-align:left;font-size:9.5px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);
  padding:9px 14px;border-bottom:1px solid var(--line);background:#FAFCFA;white-space:nowrap}
.loc-table td{padding:9px 14px;border-bottom:1px solid #EEF2EC;vertical-align:top}
.loc-table tr:last-child td{border-bottom:0}
.loc-num{text-align:right !important;font-variant-numeric:tabular-nums}
.loc-nowrap{white-space:nowrap}
.loc-td-empty{color:var(--muted);text-align:center;padding:22px 14px !important}
.loc-muted{color:var(--muted)}
.loc-raw{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:#7C8A83;background:var(--slot);border-radius:4px;padding:1px 5px}
.loc-row-x{cursor:pointer}
.loc-row-x:hover td{background:var(--slot)}
.loc-row-x:focus-visible{outline:2px solid #2CDB87;outline-offset:-2px}
.loc-row-open td{background:#EAF6EF}
.loc-row-detail td{border-bottom:1px solid var(--line)}
.loc-link{color:var(--forest);font-weight:700;text-decoration:none}
.loc-link:hover{text-decoration:underline}
.loc-foot{padding:10px 20px;font-size:11.5px;color:var(--muted);border-top:1px solid var(--line);background:#FAFCFA}
.loc-badge{display:inline-block;font-size:11px;font-weight:800;border-radius:99px;padding:2px 9px;white-space:nowrap;border:1px solid transparent}
.loc-badge-in_market{background:#E3F7EC;color:#04583A;border-color:#BFE8D2}
.loc-badge-waitlist{background:#FFF3DC;color:#8A5300;border-color:#F2D9A6}
.loc-badge-unidentified{background:#FDEAE4;color:#A8391A;border-color:#F0BDA9}
.loc-badge-no_area{background:var(--slot);color:var(--muted);border-color:var(--line)}
.loc-chart{max-width:900px}
.loc-legend{display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--ink);margin-bottom:8px}
.loc-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.loc-legend-tip{color:var(--muted);margin-left:auto}
.loc-chart-title{font-size:11px;font-weight:800;color:var(--muted);margin:6px 0 2px}
.loc-svg{width:100%;height:auto;display:block}
.loc-axis{font-size:10px;fill:#7C8A83}
@media (max-width:1100px){.loc-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:640px){.loc-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.loc-legend-tip{margin-left:0;width:100%}}
`;
