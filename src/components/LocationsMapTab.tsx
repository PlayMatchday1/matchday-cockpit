"use client";

// THE MAP TAB of /growth/locations. Data: GET /api/growth/locations/map — Supabase only, never
// MatchDay (the API dyno's 512 MB quota; Ryan's hard rule). Every number on this tab is computed on
// the server (src/lib/locationsMap.ts); this file only picks which of them to show.
//
// The city lives in the URL (?tab=map&city=<id>) via onCity, so a shared link opens that city.
// Reach (3 / 5 / 10 mi) and the selected pin or bubble are view state, not URL state.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { REACHES, type LocationsMap, type MapField, type MapZip, type NationalZip, type Reach } from "@/lib/locationsMap";
import type { NatFilter, Selection } from "@/components/LocationsLeaflet";
import { MARKS_CSS, bubbleHtml, cityTagHtml, pinHtml } from "@/components/locationsMarks";

// Legend samples: the SAME HTML the map draws (locationsMarks), shrunk — so the legend cannot drift
// from the marks. Static strings built from constants; nothing user-supplied goes into them.
const Sample = ({ html, scale = 0.72 }: { html: string; scale?: number }) => (
  <i className="lm-sample" style={{ transform: `scale(${scale})` }} dangerouslySetInnerHTML={{ __html: html }} />
);

// Leaflet needs `window` on import — client-only, and only once this tab is opened.
const LocationsLeaflet = dynamic(() => import("@/components/LocationsLeaflet"), {
  ssr: false,
  loading: () => <div className="lm-map lm-map-loading">Loading map…</div>,
});

const IN_REACH = "#1baf7a";
const GAP = "#eb6834";
const int = (n: number) => n.toLocaleString("en-US");
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
const mi = (n: number | null) => (n == null ? "—" : `${n < 10 ? n.toFixed(1) : Math.round(n)} mi`);
const NO_PLAYERS = "No players have set a location here yet.";
const NAT_FILTERS: { key: NatFilter; label: string }[] = [
  { key: "all", label: "All players" }, { key: "in_market", label: "In market" }, { key: "waitlist", label: "Outside coverage" },
];

export default function LocationsMapTab({ cityId, reloadKey, onCity }: {
  cityId: number | null;
  reloadKey: number;
  onCity: (id: number | null) => void;
}) {
  const [data, setData] = useState<LocationsMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reach, setReach] = useState<Reach>(10); // default reach is 10 miles everywhere (Ryan, 2026-10-08)
  const [selected, setSelected] = useState<Selection>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [natFilter, setNatFilter] = useState<NatFilter>("all");
  const [selNat, setSelNat] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; zoom: number; n: number } | null>(null);
  const [showRadius, setShowRadius] = useState(false);
  const [howOpen, setHowOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch("/api/growth/locations/map", {
        cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setData(body as LocationsMap);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load, reloadKey]);

  // A new city starts with nothing selected.
  useEffect(() => { setSelected(null); setHighlight(null); setSelNat(null); setFocus(null); }, [cityId]);

  const city = data?.cities.find((c) => c.id === cityId) ?? null;
  const fields = useMemo(() => (city ? (data?.fields ?? []).filter((f) => f.cityId === city.id) : []), [data, city]);
  const zips = useMemo(() => (city ? (data?.zips ?? []).filter((z) => z.cityId === city.id) : []), [data, city]);
  const fieldById = useMemo(() => new Map((data?.fields ?? []).map((f) => [f.id, f])), [data]);
  // Pills keep the city table's own order (by id), like Master Schedule; the list ranks by players.
  // Only cities with an active field are markets: they get pills and rows; the others are named once.
  const pillCities = useMemo(() => [...(data?.cities ?? [])].filter((c) => c.hasFields).sort((a, b) => a.id - b.id), [data]);
  const noFieldCities = useMemo(() => (data?.cities ?? []).filter((c) => !c.hasFields), [data]);
  const cityById = useMemo(() => new Map((data?.cities ?? []).map((c) => [c.id, c])), [data]);
  const national = useMemo(() => (data?.national ?? []).filter((z) => natFilter === "all" || z.verdict === natFilter), [data, natFilter]);
  // A selection the filter has hidden is dropped, so the detail card never describes an absent bubble.
  useEffect(() => { if (selNat && !national.some((z) => z.key === selNat)) setSelNat(null); }, [national, selNat]);

  if (error && !data) {
    return <div className="loc-card"><div className="loc-state">{error} <button type="button" className="loc-btn" onClick={() => void load()}>Retry</button></div></div>;
  }
  if (!data) return <div className="loc-card"><div className="loc-state">Loading map…</div></div>;
  if (data.cities.length === 0) {
    return <div className="loc-card"><div className="loc-state">No city centres yet: they come from the location sync, which has not completed a run.</div></div>;
  }

  const fieldsSorted = [...fields].sort((a, b) => b.reach[reach] - a.reach[reach] || a.title.localeCompare(b.title));
  const gaps = zips.filter((z) => !z.inReach[reach]).slice(0, 4);
  const covered = city ? city.coverage[reach] : 0;
  const selField: MapField | null = selected?.kind === "field" ? fieldById.get(selected.id) ?? null : null;
  const selZip: MapZip | null = selected?.kind === "zip" ? zips.find((z) => z.key === selected.key) ?? null : null;
  const selNational: NationalZip | null = selNat ? data.national.find((z) => z.key === selNat) ?? null : null;
  const cityLabel = (id: number | null) => (id == null ? "—" : cityById.get(id)?.name ?? `City ${id}`);

  return (
    <div className="loc-card" data-testid="loc-map-tab">
      <style>{CSS}</style>
      <style>{MARKS_CSS}</style>
      {error && <div className="loc-warn">Couldn&apos;t refresh the map: {error}. Showing the last data loaded.</div>}

      <div className="loc-filter" role="group" aria-label="Map city">
        <span className="loc-control-label">Cities</span>
        <button type="button" aria-pressed={!city} className={"loc-chip" + (!city ? " loc-chip-on" : "")} onClick={() => onCity(null)}>All cities</button>
        {pillCities.map((c) => (
          <button type="button" key={c.id} aria-pressed={city?.id === c.id} className={"loc-chip" + (city?.id === c.id ? " loc-chip-on" : "")}
            onClick={() => onCity(c.id)}>{c.name}</button>
        ))}
      </div>

      {!city && (
        <div className="lm-bar">
          <div className="lm-reach" role="group" aria-label="Players shown" style={{ marginLeft: 0 }}>
            <span className="loc-control-label">Show</span>
            <div className="lm-seg">
              {NAT_FILTERS.map((f) => (
                <button type="button" key={f.key} aria-pressed={natFilter === f.key} data-testid={`nat-${f.key}`}
                  className={"lm-seg-btn" + (natFilter === f.key ? " lm-seg-on" : "")} onClick={() => setNatFilter(f.key)}>{f.label}</button>
              ))}
            </div>
          </div>
          <label className="lm-check">
            <input type="checkbox" checked={showRadius} data-testid="show-radius" onChange={(e) => setShowRadius(e.target.checked)} />
            Show coverage radius
          </label>
        </div>
      )}

      {city && (
        <div className="lm-bar">
          <button type="button" className="loc-btn" data-testid="map-back" onClick={() => onCity(null)}>← All cities</button>
          <div className="lm-bar-title">{city.name}</div>
          <div className="lm-reach" role="group" aria-label="Field reach">
            <span className="loc-control-label">Reach</span>
            <div className="lm-seg">
              {REACHES.map((r) => (
                <button type="button" key={r} aria-pressed={reach === r} data-testid={`reach-${r}`}
                  className={"lm-seg-btn" + (reach === r ? " lm-seg-on" : "")} onClick={() => setReach(r)}>{r} mi</button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="lm-body">
        <div className="lm-left">
          <div className="lm-map" data-testid="loc-map">
            <LocationsLeaflet cities={data.cities} city={city} fields={fields} zips={zips} reach={reach}
              selected={selected} highlightFieldId={highlight}
              onCity={(id) => onCity(id)} onSelect={(s) => { setSelected(s); setHighlight(null); }}
              national={national} nationalAll={data.national} selectedNational={selNat}
              onSelectNational={setSelNat} focus={focus} natFilter={natFilter} showRadius={showRadius} />
          </div>
          <div className="lm-legend" data-testid="map-legend">
            <span><Sample html={bubbleHtml(3, "in")} />Players. Number = players in that area{city ? `, with a field within ${reach} mi` : ""}</span>
            <span><Sample html={bubbleHtml(3, "gap")} />{city ? `No field within ${reach} mi` : "Outside coverage"}</span>
            {city ? (
              <>
                <span><Sample html={pinHtml(false)} scale={0.8} />Field</span>
                <span><i className="lm-ring" />Field reach</span>
              </>
            ) : (
              <>
                <span><Sample html={cityTagHtml("City", null, "top")} scale={0.85} />City</span>
                {showRadius && <span><i className="lm-ring lm-ring-line" />Coverage radius</span>}
              </>
            )}
            <span className="lm-legend-note" data-testid="map-hint">
              {city ? "Tap a bubble or a field to see its details." : "Tap a city to see its players and fields."}
              {" "}<button type="button" className="lm-how" aria-expanded={howOpen} onClick={() => setHowOpen((o) => !o)}>How this works</button>
            </span>
            {howOpen && (
              <div className="lm-how-body" data-testid="map-how">
                <p>Each green bubble on the national map is a city. The number inside is how many players have shared a location there.</p>
                <p>Orange bubbles are players outside every city&apos;s area. Bubbles that overlap are combined and split apart as you zoom in.</p>
                <p>In a city, each bubble is a zip code. Players without a zip are grouped by the square mile they are in.</p>
                <p>Bubbles are placed a little off each player&apos;s exact spot, within about half a mile, to protect their privacy.</p>
                <p>Distances are in a straight line, not driving distance.</p>
                <p>A field shows if it has a match coming up or had one in the last {data.activeWindowDays} days.</p>
              </div>
            )}
          </div>
        </div>

        <div className="lm-panel">
          {/* The missing-field warning: every one on All cities, only the city's own inside a city. */}
          {(() => {
            const bad = city ? data.badFields.filter((f) => f.cityId === city.id) : data.badFields;
            if (bad.length === 0) return null;
            return (
              <div className="lm-warnrow" data-testid="map-missing-fields">
                {bad.length === 1
                  ? `1 field is missing from the map: ${bad[0].title}. Its location needs fixing in MatchDay.`
                  : `${bad.length} fields are missing from the map: ${bad.map((f) => f.title).join(", ")}. Their locations need fixing in MatchDay.`}
              </div>
            );
          })()}
          {!city ? (
            <>
            {selNational && (
              <div className="lm-pcard lm-detail" data-testid="map-nat-detail">
                <div className="lm-ptitle-row">
                  <div className="lm-ptitle">{selNational.zip ? `Zip ${selNational.zip}` : selNational.area}</div>
                  <button type="button" className="loc-btn lm-clear" onClick={() => setSelNat(null)}>Clear</button>
                </div>
                {selNational.label && selNational.label !== selNational.area && <div className="lm-sub">{selNational.label}</div>}
                <div className="lm-sub">{int(selNational.players)} {selNational.players === 1 ? "player" : "players"}, {selNational.verdict === "in_market" ? "inside a city's area" : "outside coverage"}</div>
                <div className="lm-sub">Nearest city: {cityLabel(selNational.nearestCityId)}, {mi(selNational.nearestCityMi)} away</div>
              </div>
            )}
            <div className="lm-pcard">
              <div className="lm-ptitle">Pick a city</div>
              <table className="lm-list" data-testid="map-city-list">
                <thead><tr><th>City</th><th className="loc-num">Players</th><th className="loc-num">Fields</th><th className="loc-num">Near a field</th></tr></thead>
                <tbody>
                  {data.cities.filter((c) => c.hasFields).map((c) => (
                    <tr key={c.id} className="lm-row" tabIndex={0} onClick={() => onCity(c.id)}
                      onKeyDown={(e) => { if (e.key === "Enter") onCity(c.id); }}>
                      <td>{c.name}</td>
                      <td className="loc-num">{int(c.players)}</td>
                      <td className="loc-num">{int(c.fields)}</td>
                      <td className="loc-num">{c.players ? pct(c.coverage[10], c.players) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="lm-note">Near a field = players within 10 miles of an active field.</div>
              {noFieldCities.length > 0 && (
                <div className="lm-note" data-testid="map-no-fields">No fields yet: {noFieldCities.map((c) => c.name).join(", ")}.</div>
              )}
            </div>
            <div className="lm-pcard">
              <div className="lm-ptitle">New markets</div>
              {data.outside.length === 0 ? (
                <div className="lm-empty" data-testid="map-outside-empty">No players outside coverage yet</div>
              ) : (
                <table className="lm-list" data-testid="map-outside">
                  <thead><tr><th>Place</th><th className="loc-num">Players</th><th>Nearest city</th></tr></thead>
                  <tbody>
                    {data.outside.map((o) => (
                      <tr key={`${o.place}|${o.zipKeys[0]}`} className={"lm-row" + (selNational && o.zipKeys.includes(selNational.key) ? " lm-row-on" : "")} tabIndex={0}
                        onClick={() => {
                          if (natFilter === "in_market") setNatFilter("all");
                          setFocus({ lat: o.lat, lng: o.lng, zoom: 10, n: Date.now() });
                          setSelNat(o.zipKeys[0] ?? null);
                        }}
                        onKeyDown={(e) => { if (e.key === "Enter") { setFocus({ lat: o.lat, lng: o.lng, zoom: 10, n: Date.now() }); setSelNat(o.zipKeys[0] ?? null); } }}>
                        <td>{o.place}</td><td className="loc-num">{int(o.players)}</td>
                        <td>{cityLabel(o.nearestCityId)}, {mi(o.nearestCityMi)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            </>
          ) : (
            <>
              <div className="lm-pcard" data-testid="map-coverage">
                <div className="lm-ptitle">Coverage at {reach} mi</div>
                {city.players === 0 ? (
                  <div className="lm-empty">{NO_PLAYERS}</div>
                ) : (
                  <>
                    <div className="lm-big">{pct(covered, city.players)}</div>
                    <div className="lm-sub">{int(covered)} of {int(city.players)} players have a field within {reach} mi</div>
                    <div className="lm-sub">{int(city.players - covered)} {city.players - covered === 1 ? "has" : "have"} no field within {reach} mi</div>
                  </>
                )}
                {city.unplaced > 0 && <div className="lm-note">{int(city.unplaced)} more {city.unplaced === 1 ? "player has" : "players have"} no location we can map.</div>}
              </div>

              {(selField || selZip) && (
                <div className="lm-pcard lm-detail" data-testid="map-detail">
                  <div className="lm-ptitle-row">
                    <div className="lm-ptitle">{selField ? selField.title : selZip!.zip ? `Zip ${selZip!.zip}` : selZip!.area}</div>
                    <button type="button" className="loc-btn lm-clear" onClick={() => setSelected(null)}>Clear</button>
                  </div>
                  {selField ? (
                    <div className="lm-sub">{city.players === 0 ? NO_PLAYERS : `${int(selField.reach[reach])} ${selField.reach[reach] === 1 ? "player" : "players"} within ${reach} mi`}</div>
                  ) : (
                    <>
                      <div className="lm-sub">{int(selZip!.players)} {selZip!.players === 1 ? "player" : "players"}</div>
                      {/* The fields inside THIS bubble's ring at the current reach (the ring is drawn on
                          the map). minReach is the server's exact-distance answer. */}
                      {(() => {
                        const inRing = selZip!.nearby.filter((n) => n.minReach <= reach);
                        return inRing.length === 0 ? (
                          <div className="lm-sub" data-testid="detail-no-field">No field within {reach} miles.</div>
                        ) : (
                          <ul className="lm-near" data-testid="detail-fields">
                            {inRing.map((n) => (
                              <li key={n.fieldId}><span>{fieldById.get(n.fieldId)?.title ?? `Field ${n.fieldId}`}</span><span>{mi(n.mi)}</span></li>
                            ))}
                          </ul>
                        );
                      })()}
                    </>
                  )}
                </div>
              )}

              <div className="lm-pcard">
                <div className="lm-ptitle">Fields</div>
                {fieldsSorted.length === 0 ? (
                  <div className="lm-empty">No active fields here.</div>
                ) : (
                  <table className="lm-list" data-testid="map-fields">
                    <thead><tr><th>Field</th><th className="loc-num">Players within {reach} mi</th></tr></thead>
                    <tbody>
                      {fieldsSorted.map((f) => (
                        <tr key={f.id} className={"lm-row" + (highlight === f.id ? " lm-row-on" : "")} tabIndex={0}
                          onClick={() => setHighlight(highlight === f.id ? null : f.id)}
                          onKeyDown={(e) => { if (e.key === "Enter") setHighlight(highlight === f.id ? null : f.id); }}>
                          <td>{f.title}</td><td className="loc-num">{int(f.reach[reach])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="lm-pcard">
                <div className="lm-ptitle">Biggest gaps</div>
                {city.players === 0 ? (
                  <div className="lm-empty">{NO_PLAYERS}</div>
                ) : gaps.length === 0 ? (
                  <div className="lm-empty">Every area here has a field within {reach} mi.</div>
                ) : (
                  <table className="lm-list" data-testid="map-gaps">
                    <thead><tr><th>Area</th><th className="loc-num">Players</th><th>Miles to nearest field</th></tr></thead>
                    <tbody>
                      {gaps.map((z) => (
                        <tr key={z.key} className={"lm-row" + (selZip?.key === z.key ? " lm-row-on" : "")} tabIndex={0}
                          onClick={() => { setSelected({ kind: "zip", key: z.key }); setHighlight(null); }}
                          onKeyDown={(e) => { if (e.key === "Enter") setSelected({ kind: "zip", key: z.key }); }}>
                          <td>{z.area}</td><td className="loc-num">{int(z.players)}</td>
                          <td>{z.nearestFieldMi == null ? "No active field"
                            : `${mi(z.nearestFieldMi)}, ${z.nearestFieldId != null ? fieldById.get(z.nearestFieldId)?.title ?? `Field ${z.nearestFieldId}` : ""}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>

    </div>
  );
}

const CSS = `
.lm-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--line)}
.lm-bar-title{font-size:15px;font-weight:900;color:var(--forest)}
.lm-reach{display:flex;align-items:center;gap:8px;margin-left:auto}
.lm-seg{display:inline-flex;background:var(--slot);border:1px solid var(--line);border-radius:10px;padding:3px}
.lm-seg-btn{border:0;background:transparent;font:inherit;font-size:11.5px;font-weight:800;color:var(--muted);padding:6px 12px;border-radius:8px;cursor:pointer}
.lm-seg-on{background:#fff;color:var(--forest);box-shadow:0 1px 3px rgba(0,43,34,.13)}
.lm-body{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:0}
.lm-left{min-width:0;border-right:1px solid var(--line)}
.lm-map{height:560px;position:relative;z-index:0}
.lm-map-loading{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;background:var(--slot)}
.loc-leaflet{height:100%;width:100%}
.lm-legend{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:10px 16px;font-size:12px;color:var(--ink);border-top:1px solid var(--line);background:#FAFCFA}
.lm-legend-note{color:var(--muted);flex-basis:100%}
.lm-how{border:0;background:none;padding:0;font:inherit;color:var(--forest);font-weight:700;text-decoration:underline;cursor:pointer}
.lm-how-body{flex-basis:100%;font-size:12px;color:var(--ink);line-height:1.45}
.lm-how-body p{margin:0 0 4px}
.lm-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--forest);cursor:pointer}
.lm-check input{accent-color:#046B45;width:15px;height:15px;margin:0}
.lm-ring-line{background:transparent}
.lm-warnrow{padding:10px 16px;font-size:12px;color:#8A5300;background:#FFF6E5;border-bottom:1px solid #F2D9A6}
/* Legend samples are the real marks, shrunk in place. */
.lm-sample{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;margin-right:2px;transform-origin:center;font-style:normal}
.lm-sample .loc-ct{position:static;transform:none}
.lm-sample .loc-ct::after{display:none}
.lm-near{list-style:none;margin:6px 0 0;padding:0;font-size:12.5px}
.lm-near li{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px solid #EEF2EC}
.lm-near li span:last-child{color:var(--muted);white-space:nowrap}
.lm-dot{display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid;margin-right:6px;vertical-align:-2px}
.lm-dot-gap{border-style:dashed}
.lm-pin{display:inline-block;width:10px;height:10px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#003326;margin-right:7px;vertical-align:-1px}
.lm-ring{display:inline-block;width:14px;height:14px;border-radius:50%;border:1.5px solid rgba(0,51,38,.55);background:rgba(0,51,38,.06);margin-right:6px;vertical-align:-3px}
.lm-panel{display:flex;flex-direction:column;gap:0;min-width:0}
.lm-pcard{padding:14px 16px;border-bottom:1px solid var(--line)}
.lm-pcard:last-child{border-bottom:0}
.lm-ptitle{font-size:10px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.lm-ptitle-row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.lm-ptitle-row .lm-ptitle{text-transform:none;letter-spacing:0;font-size:13px;color:var(--forest);margin:0}
.lm-clear{padding:4px 10px;font-size:11px}
.lm-detail{background:#F6FBF8}
.lm-big{font-size:28px;font-weight:900;color:var(--forest);letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.lm-sub{font-size:12.5px;color:var(--ink);margin-top:4px}
.lm-empty{font-size:12.5px;color:var(--muted)}
.lm-note{font-size:11.5px;color:var(--muted);margin-top:8px}
.lm-list{width:100%;border-collapse:collapse;font-size:12.5px}
.lm-list th{text-align:left;font-size:9.5px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);padding:6px 6px;border-bottom:1px solid var(--line)}
.lm-list td{padding:7px 6px;border-bottom:1px solid #EEF2EC}
.lm-row{cursor:pointer}
.lm-row:hover td{background:var(--slot)}
.lm-row:focus-visible{outline:2px solid #2CDB87;outline-offset:-2px}
.lm-row-on td{background:#E3F7EC}

@media (max-width:900px){
  .lm-body{grid-template-columns:1fr}
  .lm-left{border-right:0;border-bottom:1px solid var(--line)}
  .lm-map{height:420px}
  .lm-reach{margin-left:0}
}
`;
