"use client";

// "WHERE TO OPEN NEXT" — the Overview table of where one more field would reach the most players in a
// city we already serve who have no field in reach today. A table, not a map layer. Computed on the
// server (GET /api/growth/locations/open-next, src/lib/locationsInsights.ts openNextForCity) and cached
// there until the next sync; this file only filters and formats.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { downloadCsv } from "@/components/growth/format";
import { MIN_PLAYERS_PER_SUGGESTION, type CityOpenNext, type Suggestion } from "@/lib/locationsInsights";

const REACHES = [3, 5, 10, 15] as const;
type Payload = { reach: number; minPlayers: number; cities: { id: number; name: string }[]; results: CityOpenNext[] };
const int = (n: number) => n.toLocaleString("en-US");
const mi = (n: number | null) => (n == null ? "" : `${n < 10 ? n.toFixed(1) : Math.round(n)} mi`);

export default function LocationsOpenNext({ cities, reloadKey }: { cities: { id: number; name: string }[]; reloadKey: number }) {
  const [reach, setReach] = useState<number>(10);
  const [city, setCity] = useState<number | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (r: number) => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(`/api/growth/locations/open-next?reach=${r}`, {
        cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setData(body as Payload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(reach); }, [load, reach, reloadKey]);

  const nameOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of data?.cities ?? []) m.set(c.id, c.name);
    return (id: number) => m.get(id) ?? `City ${id}`;
  }, [data]);

  const rows = useMemo(() => {
    const out: Suggestion[] = [];
    for (const r of data?.results ?? []) if (r.status === "ok" && (city == null || r.cityId === city)) out.push(...r.suggestions);
    return out.sort((a, b) => b.playersReached - a.playersReached || a.cityId - b.cityId || a.rank - b.rank);
  }, [data, city]);
  const quiet = useMemo(() => (data?.results ?? []).filter((r) => (city == null || r.cityId === city)
    && (r.status === "too_few" || (r.status === "ok" && r.suggestions.length === 0))), [data, city]);

  const exportCsv = () => {
    const out: (string | number)[][] = [["City", "Area", "Players it would reach", "Coverage now (%)", "Coverage with a field there (%)", "Nearest field", "Nearest field (mi)", "Reach (mi)"]];
    for (const s of rows) out.push([nameOf(s.cityId), s.name, s.playersReached, s.coverageNowPct, s.coverageWithPct, s.nearestFieldTitle ?? "", s.nearestFieldMi ?? "", reach]);
    const tag = city != null ? `-${nameOf(city).replace(/[^A-Za-z0-9]+/g, "_")}` : "";
    downloadCsv(`where-to-open-next-${reach}mi${tag}.csv`, out);
  };

  return (
    <div className="loc-card" data-testid="loc-open-next">
      <div className="loc-sec-head">
        <div className="loc-sec-title">Where to open next</div>
        <button type="button" className="loc-btn" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</button>
      </div>
      <div className="loc-filter" role="group" aria-label="Where to open next city">
        <span className="loc-control-label">Cities</span>
        <button type="button" aria-pressed={city === null} className={"loc-chip" + (city === null ? " loc-chip-on" : "")} onClick={() => setCity(null)}>All cities</button>
        {cities.map((c) => (
          <button type="button" key={c.id} aria-pressed={city === c.id} className={"loc-chip" + (city === c.id ? " loc-chip-on" : "")}
            onClick={() => setCity(c.id)}>{c.name}</button>
        ))}
      </div>
      <div className="loc-filter" role="group" aria-label="Reach">
        <span className="loc-control-label">Reach</span>
        {REACHES.map((r) => (
          <button type="button" key={r} aria-pressed={reach === r} data-testid={`open-next-reach-${r}`}
            className={"loc-chip" + (reach === r ? " loc-chip-on" : "")} onClick={() => setReach(r)}>{r} mi</button>
        ))}
      </div>
      {error && !data ? (
        <div className="loc-state">{error} <button type="button" className="loc-btn" onClick={() => void load(reach)}>Retry</button></div>
      ) : !data ? (
        <div className="loc-state">Working out where a new field would reach the most players…</div>
      ) : (
        <div className="loc-tablewrap">
          <table className="loc-table" data-testid="open-next-table">
            <thead><tr><th>City</th><th>Area</th><th className="loc-num">Players it would reach</th><th>Coverage now and with a field there</th><th>Nearest field</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={`${s.cityId}-${s.rank}`}>
                  <td>{nameOf(s.cityId)}</td>
                  <td>{s.name}</td>
                  <td className="loc-num">{int(s.playersReached)}</td>
                  <td className="loc-nowrap">{s.coverageNowPct}% to {s.coverageWithPct}%</td>
                  <td>{s.nearestFieldTitle ? `${s.nearestFieldTitle}, ${mi(s.nearestFieldMi)}` : "No active field"}</td>
                </tr>
              ))}
              {quiet.map((r) => (
                <tr key={`q-${r.cityId}`} className="loc-row-muted">
                  <td>{nameOf(r.cityId)}</td>
                  <td colSpan={4}>{r.status === "too_few"
                    ? `Not enough players yet, ${int(r.players)} of ${int(r.needed)}`
                    : `No spot here would reach ${int(MIN_PLAYERS_PER_SUGGESTION)} or more players without a field in reach`}</td>
                </tr>
              ))}
              {rows.length === 0 && quiet.length === 0 && <tr><td colSpan={5} className="loc-td-empty">Nothing for this city.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="loc-foot">Based on players who have shared a location. Straight-line distance.</div>
    </div>
  );
}
