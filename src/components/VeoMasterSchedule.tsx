"use client";

// Master Schedule — Veo coverage (spec: mockups/veo-v1.html).
//
// Two views over one week of the fleet:
//   Schedule     — per city, a 7-day grid of match cards; a Veo-marked card
//                  inverts to the dark forest card with a yellow camera chip.
//                  Toggling the chip persists camera INTENT (POST /api/veo/intent).
//   Veo coverage — the week as one grid (rows = cameras, cols = 7 days) plus a
//                  worklist diff between Clubhouse intent and the 🎥 app emoji.
//
// Data comes from GET /api/veo (VeoWeek). Mutations POST /api/veo/intent and
// /api/veo/cameras, then refetch so counters + grid + worklist update without a
// page reload. The whole VeoWeek lives in state; every derived number is
// recomputed from it. The raw MatchDay name (which may carry a 🎥) is never
// rendered — the API delivers an already emoji-stripped `name`, and `hasEmoji`
// carries the emoji fact separately.
//
// The three grid states stay QUIET→LOUD and are NOT inverted: covered is a faint
// mint wash (the norm), an idle owned camera is a hairline em-dash, an open
// city-day is a loud coral cell (the to-do). The dark inversion lives only on the
// Schedule cards, where a Veo match is the exception among many.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { downloadCsv, plural } from "@/components/growth/format";

type VeoDay = { dow: string; date: number; iso: string; today: boolean };
type VeoCity = { city: string; cameras: number };
type VeoMatch = {
  apiId: number; city: string; dayIdx: number; time: string; minutes: number;
  venue: string; name: string; veo: boolean; hasEmoji: boolean;
};
type VeoCode = { code: string; confirmed: boolean };
type VeoCodesRef = { city: string; codes: VeoCode[] };
type VeoWeek = {
  weekStart: string;
  days: VeoDay[];
  cities: VeoCity[];
  matches: VeoMatch[];
  codesRef: VeoCodesRef[];
  seededThisWeek: number;
  generatedAt: string;
};

type Unit = { venue: string; times: string[] };
type View = "schedule" | "veo";

// ── derived helpers (pure over VeoWeek) ─────────────────────────────────────
const camerasOf = (w: VeoWeek, city: string) => w.cities.find((c) => c.city === city)?.cameras ?? 0;
const veoMatchesOf = (w: VeoWeek, city: string) => w.matches.filter((m) => m.city === city && m.veo);
const cityCode = (city: string) => city.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase();

// A city-day needs one camera per DISTINCT VENUE (two matches at one venue are
// back-to-back on one camera). One row per owned camera ALWAYS — an idle second
// camera is still a row. More distinct venues on a night than cameras owned adds
// rows, flagged over capacity.
function unitsFor(w: VeoWeek, city: string): (Unit | null)[][] {
  const owned = camerasOf(w, city);
  const ms = veoMatchesOf(w, city);
  const byDay: Unit[][] = w.days.map((_, d) => {
    const dayMs = ms.filter((m) => m.dayIdx === d).sort((a, b) => a.minutes - b.minutes);
    const venues = [...new Set(dayMs.map((m) => m.venue))];
    return venues.map((v) => ({ venue: v, times: dayMs.filter((m) => m.venue === v).map((m) => m.time) }));
  });
  // At least one row so every fleet city surfaces (its Open/idle days show).
  const width = Math.max(1, owned, ...byDay.map((x) => x.length));
  return Array.from({ length: width }, (_, i) => byDay.map((day) => day[i] ?? null));
}

type Stats = { covered: number; total: number; used: number; capacity: number; gaps: number; over: number };
function computeStats(w: VeoWeek): Stats {
  const covered = w.matches.filter((m) => m.veo).length;
  const owned = w.cities.reduce((a, c) => a + c.cameras, 0);
  let used = 0, gaps = 0, over = 0;
  for (const { city } of w.cities) {
    const rows = unitsFor(w, city);
    const ownedC = camerasOf(w, city);
    w.days.forEach((_, d) => {
      const filled = rows.filter((r) => r[d]).length;
      if (filled === 0) gaps++; else used += filled;
      if (filled > ownedC) over++;
    });
  }
  return { covered, total: w.matches.length, used, capacity: owned * 7, gaps, over };
}

const sortMatches = (a: VeoMatch, b: VeoMatch) =>
  a.dayIdx - b.dayIdx || a.city.localeCompare(b.city) || a.minutes - b.minutes;

export default function VeoMasterSchedule() {
  const [week, setWeek] = useState<VeoWeek | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [view, setView] = useState<View>("schedule");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch("/api/veo", { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as VeoWeek;
      setWeek(json);
      setError("");
    } catch {
      setError("Couldn't load Veo coverage. Try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function post(url: string, body: unknown): Promise<boolean> {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setError("No active session."); return false; }
    try {
      const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { setError(`HTTP ${res.status} — nothing changed.`); return false; }
      return true;
    } catch { setError("Network error — nothing changed."); return false; }
  }

  // Optimistic: patch local state, POST, refetch on success / revert on failure.
  async function toggleIntent(apiId: number, enabled: boolean) {
    if (!week || busy) return;
    const snapshot = week;
    setWeek({ ...week, matches: week.matches.map((m) => (m.apiId === apiId ? { ...m, veo: enabled } : m)) });
    setBusy(true);
    const ok = await post("/api/veo/intent", { matchApiId: apiId, enabled });
    if (ok) await load(); else setWeek(snapshot);
    setBusy(false);
  }
  async function setCameras(city: string, cameras: number) {
    if (!week || busy || cameras < 0) return;
    const snapshot = week;
    setWeek({ ...week, cities: week.cities.map((c) => (c.city === city ? { ...c, cameras } : c)) });
    setBusy(true);
    const ok = await post("/api/veo/cameras", { city, cameras });
    if (ok) await load(); else setWeek(snapshot);
    setBusy(false);
  }

  const stats = useMemo<Stats | null>(() => (week ? computeStats(week) : null), [week]);

  // Worklist diff — two DISJOINT sections.
  const { needEmoji, needClubhouse } = useMemo(() => {
    if (!week) return { needEmoji: [] as VeoMatch[], needClubhouse: [] as VeoMatch[] };
    return {
      needEmoji: week.matches.filter((m) => m.veo && !m.hasEmoji).sort(sortMatches),
      needClubhouse: week.matches.filter((m) => !m.veo && m.hasEmoji).sort(sortMatches),
    };
  }, [week]);

  function exportWorklist() {
    if (!week) return;
    const dayLabel = (i: number) => { const d = week.days[i]; return d ? `${d.dow} ${String(d.date).padStart(2, "0")}` : "—"; };
    const rows: (string | number)[][] = [["Add the camera emoji"], ["Day", "City", "Venue", "Time", "Match name"]];
    for (const m of needEmoji) rows.push([dayLabel(m.dayIdx), m.city, m.venue, m.time, m.name]);
    rows.push([]);
    rows.push(["Marked in the app but not in Clubhouse"], ["Day", "City", "Venue", "Time", "Match name"]);
    for (const m of needClubhouse) rows.push([dayLabel(m.dayIdx), m.city, m.venue, m.time, m.name]);
    downloadCsv(`veo-worklist-${week.weekStart}.csv`, rows);
  }

  return (
    <div className="vms">
      <style>{CSS}</style>

      <div className="vms-card">
        <div className="vms-head">
          <div>
            <div className="vms-h-title">Master Schedule</div>
            <div className="vms-h-sub">Mark the matches a Veo camera will cover, then switch to Veo coverage to see the week as one grid — which nights are covered, which are open, and where a camera is idle or short.</div>
          </div>
          <div className="vms-h-right">
            <span className="vms-control-label">View</span>
            <div className="vms-segmented" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={view === "schedule"} className={"vms-seg-btn" + (view === "schedule" ? " vms-active" : "")} onClick={() => setView("schedule")}>Schedule</button>
              <button type="button" role="tab" aria-selected={view === "veo"} className={"vms-seg-btn" + (view === "veo" ? " vms-active" : "")} onClick={() => setView("veo")}>Veo coverage</button>
            </div>
            <button type="button" className="vms-btn" onClick={exportWorklist} disabled={!week}>Export worklist</button>
          </div>
        </div>

        {stats && (
          <div className="vms-stats">
            <Stat l="Matches with Veo" v={stats.covered} f={`of ${stats.total} this week`} />
            <Stat l="Camera nights used" v={stats.used} f={`of ${stats.capacity} available · ${stats.capacity ? Math.round((stats.used / stats.capacity) * 100) : 0}%`} />
            <Stat l="Open nights" v={stats.gaps} f="city-days with matches, no camera" />
            <Stat l="Over capacity" v={stats.over} f={stats.over ? "more venues than cameras owned" : "none"} />
          </div>
        )}
      </div>

      {loading && !week ? (
        <div className="vms-card"><div className="vms-state">Loading Veo coverage…</div></div>
      ) : error && !week ? (
        <div className="vms-card"><div className="vms-state">{error} <button type="button" className="vms-btn" onClick={() => { setLoading(true); void load(); }}>Retry</button></div></div>
      ) : !week ? null : view === "schedule" ? (
        <ScheduleView week={week} busy={busy} onToggle={toggleIntent} />
      ) : (
        <VeoView week={week} stats={stats!} busy={busy} onCameras={setCameras} needEmoji={needEmoji} needClubhouse={needClubhouse} onExport={exportWorklist} />
      )}

      {error && week && <div className="vms-toast" role="status">{error}</div>}
    </div>
  );
}

function Stat({ l, v, f }: { l: string; v: number; f: string }) {
  return <div className="vms-stat"><div className="vms-stat-l">{l}</div><div className="vms-stat-v">{v}</div><div className="vms-stat-f">{f}</div></div>;
}

const CamIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
  </svg>
);

// ── schedule view ───────────────────────────────────────────────────────────
function ScheduleView({ week, busy, onToggle }: { week: VeoWeek; busy: boolean; onToggle: (id: number, en: boolean) => void }) {
  return (
    <div className="vms-card">
      {week.cities.map(({ city, cameras }) => {
        const n = veoMatchesOf(week, city).length;
        return (
          <div className="vms-city-block" key={city}>
            <div className="vms-city-head">
              <span className="vms-city-name">{city}</span>
              <span className="vms-city-tag">{cameras} {plural(cameras, "camera")} · {n} with Veo</span>
            </div>
            <div className="vms-days">
              {week.days.map((day, d) => {
                const ms = week.matches.filter((m) => m.city === city && m.dayIdx === d).sort((a, b) => a.minutes - b.minutes);
                return (
                  <div className={"vms-day" + (day.today ? " vms-today" : "")} key={day.iso}>
                    <div className="vms-day-h"><span className="vms-dow">{day.dow}</span><span className="vms-dnum">{String(day.date).padStart(2, "0")}</span></div>
                    {ms.length ? ms.map((m) => (
                      <div className={"vms-slot" + (m.veo ? " vms-veo" : "")} key={m.apiId}>
                        <div className="vms-slot-t">{m.time}</div>
                        <div className="vms-slot-v">{m.venue}</div>
                        <button type="button" className={"vms-cam" + (m.veo ? " vms-on" : "")} disabled={busy} aria-pressed={m.veo} title={m.veo ? "Remove Veo" : "Assign Veo"} onClick={() => onToggle(m.apiId, !m.veo)}>
                          <CamIcon />Veo
                        </button>
                      </div>
                    )) : <div className="vms-none">No sessions</div>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── veo coverage view ───────────────────────────────────────────────────────
function VeoView({ week, stats, busy, onCameras, needEmoji, needClubhouse, onExport }: {
  week: VeoWeek; stats: Stats; busy: boolean;
  onCameras: (city: string, n: number) => void;
  needEmoji: VeoMatch[]; needClubhouse: VeoMatch[]; onExport: () => void;
}) {
  const dayLabel = (i: number) => { const d = week.days[i]; return d ? `${d.dow} ${String(d.date).padStart(2, "0")}` : "—"; };

  // veo_codes reference / drift vs inventory (computed, never hardcoded).
  const drift = week.cities.map(({ city, cameras }) => {
    const codes = week.codesRef.find((c) => c.city === city)?.codes ?? [];
    const confirmed = codes.filter((c) => c.confirmed).map((c) => c.code);
    const unconfirmed = codes.filter((c) => !c.confirmed).map((c) => c.code);
    const notes: string[] = [];
    if (confirmed.length !== cameras) {
      notes.push(confirmed.length === 0
        ? `owns ${cameras} ${plural(cameras, "camera")}, 0 codes`
        : `${confirmed.length} codes vs ${cameras} ${plural(cameras, "camera")}`);
    }
    if (unconfirmed.length) notes.push(`${unconfirmed.length} unconfirmed ${plural(unconfirmed.length, "code")} (${unconfirmed.join(", ")}) not counted`);
    return { city, cameras, confirmed, notes };
  });

  const worklistEmpty = needEmoji.length === 0 && needClubhouse.length === 0;

  return (
    <>
      <div className="vms-card">
        <div className="vms-grid-wrap">
          <table className="vms-grid">
            <thead>
              <tr>
                <th className="vms-corner">Veo</th>
                {week.days.map((d) => <th key={d.iso}>{d.dow} {String(d.date).padStart(2, "0")}</th>)}
              </tr>
            </thead>
            <tbody>
              {week.cities.flatMap(({ city }) => {
                const rows = unitsFor(week, city);
                const owned = camerasOf(week, city);
                const code = cityCode(city);
                return rows.map((row, ri) => {
                  const label = rows.length > 1 ? `${code}${ri + 1}` : code;
                  const spare = ri >= owned;
                  return (
                    <tr key={`${city}-${ri}`}>
                      <td className="vms-unit" title={city + (spare ? " — beyond the cameras this city owns" : "")}>
                        {label}{spare && <div className="vms-unit-x">unowned</div>}
                      </td>
                      {row.map((cell, d) => {
                        if (!cell) {
                          const anyThisDay = rows.some((r) => r[d]);
                          return ri === 0 && !anyThisDay
                            ? <td key={d}><div className="vms-cell vms-gapcell"><span className="vms-gap">Open</span></div></td>
                            : <td key={d}><div className="vms-cell vms-off"><span className="vms-empty">—</span></div></td>;
                        }
                        const over = ri >= owned;
                        return (
                          <td key={d}>
                            <div className={"vms-cell vms-on" + (over ? " vms-over" : "")}>
                              <div className="vms-cell-v">{cell.venue}</div>
                              <div className="vms-cell-t">{cell.times.join(" + ")}</div>
                              {over && <span className="vms-warn">no camera</span>}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>

        <div className="vms-foot">
          <b>One row per camera the city owns.</b> A city with two cameras keeps a second row all week even when it is idle. <b>A coral cell</b> is an open night: the city has matches but no camera on any of them — the coral cells are this week&apos;s to-do list. <b>An em-dash</b> means that camera is free that night, not that the night is uncovered.
        </div>
        <div className="vms-foot">
          {stats.over
            ? <><b>{stats.over} {plural(stats.over, "night")} over capacity.</b> More venues are marked than the city owns cameras, so the extra rows are flagged <em>no camera</em>. Either drop one venue or move a camera in from a nearby city.</>
            : <><b>No night is over capacity.</b> Every marked venue has a camera that can reach it.</>}
        </div>
        <div className="vms-foot">
          Seeded {week.seededThisWeek} matches from the 🎥 emoji — cities running coverage without the emoji will read as Open until marked.
        </div>
      </div>

      <div className="vms-card">
        <div className="vms-inv-head">
          <strong>Camera inventory</strong>
          <span>How many Veo cameras each city owns. The − / + buttons change a real setting.</span>
        </div>
        <div className="vms-inv">
          {week.cities.map(({ city, cameras }) => (
            <div className="vms-inv-row" key={city}>
              <span className="vms-inv-city">{city}</span>
              <div className="vms-inv-ctl">
                <button type="button" className="vms-inv-btn" disabled={busy || cameras <= 0} aria-label={`Fewer cameras in ${city}`} onClick={() => onCameras(city, cameras - 1)}>−</button>
                <span className="vms-inv-n">{cameras}</span>
                <button type="button" className="vms-inv-btn" disabled={busy} aria-label={`More cameras in ${city}`} onClick={() => onCameras(city, cameras + 1)}>+</button>
              </div>
            </div>
          ))}
        </div>

        <div className="vms-foot">
          <b>veo_codes reference.</b> Confirmed codes per city, with any drift from the inventory above.
        </div>
        <div className="vms-drift">
          {drift.map((d) => (
            <div className="vms-drift-row" key={d.city}>
              <span className="vms-drift-city">{d.city}</span>
              <span className="vms-drift-codes">{d.confirmed.length ? d.confirmed.join(", ") : "no confirmed codes"}</span>
              {d.notes.length > 0
                ? <span className="vms-drift-flag">{d.notes.join(" · ")}</span>
                : <span className="vms-drift-ok">matches inventory</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="vms-card">
        <div className="vms-wl-head">
          <strong>Camera icon worklist</strong>
          <span>{needEmoji.length + needClubhouse.length} to reconcile · <button type="button" className="vms-linkbtn" onClick={onExport}>Export CSV</button></span>
        </div>
        {worklistEmpty ? (
          <div className="vms-state">Clubhouse intent and the app emoji agree — nothing to reconcile this week.</div>
        ) : (
          <>
            <WlSection title="Add the camera emoji" hint="Marked in Clubhouse, but no 🎥 in the app yet." rows={needEmoji} dayLabel={dayLabel} />
            <WlSection title="Marked in the app but not in Clubhouse" hint="Has the 🎥 emoji, but no camera intent in Clubhouse." rows={needClubhouse} dayLabel={dayLabel} />
          </>
        )}
      </div>
    </>
  );
}

function WlSection({ title, hint, rows, dayLabel }: {
  title: string; hint: string; rows: VeoMatch[]; dayLabel: (i: number) => string;
}) {
  return (
    <div className="vms-wl-sec">
      <div className="vms-wl-sec-h"><strong>{title}</strong><span>{rows.length}</span></div>
      <div className="vms-wl-hint">{hint}</div>
      {rows.length === 0 ? (
        <div className="vms-wl-none">None.</div>
      ) : (
        <table className="vms-wl">
          <thead><tr><th>Day</th><th>City</th><th>Venue</th><th>Time</th><th>Match name</th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.apiId}>
                <td className="vms-nm">{dayLabel(m.dayIdx)}</td>
                <td>{m.city}</td>
                <td>{m.venue}</td>
                <td>{m.time}</td>
                <td>{m.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const CSS = `
.vms{
  --forest:#003326;--ink:#0d1f18;--muted:#5C6B62;--paper:#fff;
  --line:#dfe4da;--slot:#EFF4EF;--mint:#2CDB87;--mintSoft:#dcf7e9;
  --yellow:#FFFF3E;--coral:#FF6955;--coralInk:#A83120;--coralBg:#FFE0DA;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
  color:var(--ink);-webkit-font-smoothing:antialiased;max-width:1360px;margin:0 auto}
.vms *{box-sizing:border-box}
.vms-card{background:var(--paper);border:1px solid var(--line);border-radius:16px;
  box-shadow:0 9px 26px rgba(0,43,34,.075);overflow:hidden;margin-bottom:18px}

.vms-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;
  padding:18px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.vms-h-title{font-size:16px;font-weight:900;letter-spacing:-.2px;color:var(--forest)}
.vms-h-sub{font-size:12px;color:var(--muted);margin-top:5px;max-width:720px;line-height:1.45}
.vms-h-right{display:flex;align-items:center;gap:11px;flex-wrap:wrap}
.vms-control-label{font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.vms-segmented{display:inline-flex;background:var(--slot);border:1px solid var(--line);border-radius:10px;padding:3px}
.vms-seg-btn{border:0;background:transparent;font-size:11.5px;font-weight:800;color:var(--muted);
  padding:7px 14px;border-radius:8px;cursor:pointer;font-family:inherit}
.vms-seg-btn.vms-active{background:#fff;color:var(--forest);box-shadow:0 1px 3px rgba(0,43,34,.13)}
.vms-btn{border:1px solid var(--line);background:#fff;color:var(--forest);font-size:12px;font-weight:800;
  padding:8px 15px;border-radius:10px;cursor:pointer;font-family:inherit}
.vms-btn:hover{background:var(--slot)}
.vms-btn:disabled{opacity:.55;cursor:default}
.vms-linkbtn{border:0;background:transparent;color:var(--forest);font-weight:800;font-size:11px;cursor:pointer;font-family:inherit;text-decoration:underline;padding:0}

.vms-stats{display:flex;gap:0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.vms-stat{flex:1;min-width:150px;padding:14px 20px;border-right:1px solid var(--line)}
.vms-stat:last-child{border-right:0}
.vms-stat-l{font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.vms-stat-v{font-size:21px;font-weight:900;color:var(--forest);margin-top:5px;line-height:1;font-variant-numeric:tabular-nums}
.vms-stat-f{font-size:11px;color:var(--muted);margin-top:5px;font-weight:650}
.vms-state{padding:26px 20px;font-size:13px;color:var(--muted);font-weight:650;display:flex;gap:12px;align-items:center}

/* schedule view */
.vms-city-block{padding:16px 20px 18px;border-bottom:1px solid var(--line)}
.vms-city-block:last-child{border-bottom:0}
.vms-city-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;flex-wrap:wrap}
.vms-city-name{font-size:14px;font-weight:900;color:var(--forest)}
.vms-city-tag{font-size:10px;font-weight:850;color:var(--muted);background:var(--slot);border:1px solid var(--line);border-radius:99px;padding:4px 10px}
.vms-days{display:grid;grid-template-columns:repeat(7,1fr);gap:9px}
.vms-day{border:1px solid var(--line);border-radius:11px;padding:9px;min-height:96px;background:#fff}
.vms-day.vms-today{border-color:var(--mint);box-shadow:0 0 0 2px var(--mintSoft)}
.vms-day.vms-today .vms-dow,.vms-day.vms-today .vms-dnum{color:#046B45}
.vms-day-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.vms-dow{font-size:9px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
.vms-dnum{font-size:11px;font-weight:900;color:var(--ink)}
.vms-slot{border:1px solid var(--line);border-radius:8px;padding:7px 8px;margin-bottom:6px;background:#fff}
.vms-slot:last-child{margin-bottom:0}
/* A Veo match inverts: dark forest card, yellow chip. Solid bg under the gradient
   so contrast measures honestly. */
.vms-slot.vms-veo{border-color:#003326;background-color:#073E2E;
  background-image:linear-gradient(135deg,#003326 0%,#0a5741 100%);
  box-shadow:0 3px 12px rgba(0,51,38,.28);position:relative;overflow:hidden}
.vms-slot.vms-veo::after{content:"";position:absolute;right:-14px;top:-14px;width:52px;height:52px;
  border-radius:50%;background:rgba(255,255,62,.10);pointer-events:none}
.vms-slot.vms-veo .vms-slot-t{color:#fff;position:relative}
.vms-slot.vms-veo .vms-slot-v{color:#AEE6CB;position:relative}
.vms-slot.vms-veo .vms-cam.vms-on{background:var(--yellow);border-color:var(--yellow);color:var(--forest);
  position:relative;box-shadow:0 1px 4px rgba(0,0,0,.22)}
.vms-slot-t{font-size:11px;font-weight:900;color:var(--ink);letter-spacing:-.1px}
.vms-slot-v{font-size:10px;color:var(--muted);font-weight:700;margin-top:2px;line-height:1.3}
.vms-cam{margin-top:6px;display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);
  background:#fff;border-radius:7px;padding:3px 7px;cursor:pointer;font-family:inherit;
  font-size:9px;font-weight:900;letter-spacing:.4px;text-transform:uppercase;color:var(--muted)}
.vms-cam:hover{background:var(--slot)}
.vms-cam:disabled{cursor:default;opacity:.75}
.vms-cam.vms-on{background:var(--mintSoft);border-color:#8fd9b6;color:#046B45}
.vms-slot.vms-veo .vms-cam{border-color:rgba(255,255,255,.30);background:rgba(255,255,255,.07);color:#CBEBDA}
.vms-cam svg{width:11px;height:11px;display:block}
.vms-none{font-size:10.5px;color:var(--muted);font-weight:700;padding:6px 2px}

/* veo grid */
.vms-grid-wrap{overflow-x:auto}
.vms-grid{width:100%;border-collapse:collapse;min-width:1080px}
.vms-grid th,.vms-grid td{border:1px solid var(--line);padding:6px;vertical-align:top;text-align:left}
.vms-grid th{padding:10px 11px;font-size:10px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;
  color:var(--muted);background:var(--slot);white-space:nowrap}
.vms-grid th.vms-corner{width:92px}
.vms-grid td.vms-unit{font-size:12px;font-weight:900;color:var(--forest);background:var(--slot);
  white-space:nowrap;width:92px;padding:14px 11px}
/* Three states, loudest last — covered (quiet mint), idle (dash), open (loud coral). Not inverted. */
.vms-cell{border-radius:8px;padding:9px 10px;min-height:48px}
.vms-cell.vms-on{background:#F1FBF6;box-shadow:inset 3px 0 0 var(--mint)}
.vms-cell.vms-gapcell{background:#FFD3C9;box-shadow:inset 3px 0 0 var(--coral);display:flex;align-items:center;justify-content:center}
.vms-cell.vms-off{display:flex;align-items:center;justify-content:center;min-height:48px}
.vms-cell.vms-on.vms-over{background:var(--coralBg);box-shadow:inset 3px 0 0 var(--coral)}
.vms-cell-v{font-size:11.5px;font-weight:800;color:var(--forest);line-height:1.35}
.vms-cell-t{font-size:10.5px;color:var(--muted);font-weight:700;margin-top:3px}
.vms-gap{font-size:10px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:var(--coralInk)}
.vms-unit-x{font-size:8.5px;font-weight:850;letter-spacing:.4px;text-transform:uppercase;color:var(--coralInk);margin-top:3px}
.vms-empty{font-size:11px;color:#69756E;font-weight:700}
.vms-warn{display:inline-block;margin-top:6px;font-size:9px;font-weight:900;letter-spacing:.4px;
  text-transform:uppercase;background:var(--coral);color:var(--forest);border-radius:5px;padding:2px 7px}
.vms-foot{padding:14px 20px 18px;font-size:11px;color:var(--muted);line-height:1.6;max-width:1020px}
.vms-foot b{color:var(--ink);font-weight:800}
.vms-foot + .vms-foot{padding-top:0}

/* inventory + drift */
.vms-inv-head{padding:14px 20px;background:var(--slot);border-bottom:1px solid var(--line);display:flex;
  justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.vms-inv-head strong{font-size:12.5px;font-weight:900;color:var(--forest)}
.vms-inv-head span{font-size:11px;color:var(--muted);font-weight:700}
.vms-inv{display:flex;flex-wrap:wrap;gap:10px;padding:16px 20px}
.vms-inv-row{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:10px;padding:7px 10px}
.vms-inv-city{font-size:11.5px;font-weight:850;color:var(--forest)}
.vms-inv-ctl{display:inline-flex;align-items:center;gap:8px}
.vms-inv-btn{width:24px;height:24px;border:1px solid var(--line);background:#fff;border-radius:7px;
  font-size:14px;font-weight:900;color:var(--forest);cursor:pointer;line-height:1;font-family:inherit}
.vms-inv-btn:hover{background:var(--slot)}
.vms-inv-btn:disabled{opacity:.45;cursor:default}
.vms-inv-n{font-size:13px;font-weight:900;color:var(--forest);min-width:14px;text-align:center;font-variant-numeric:tabular-nums}
.vms-drift{padding:0 20px 16px;display:flex;flex-direction:column;gap:8px}
.vms-drift-row{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:11.5px}
.vms-drift-city{font-weight:900;color:var(--forest);min-width:96px}
.vms-drift-codes{color:var(--muted);font-weight:700}
.vms-drift-flag{color:var(--coralInk);font-weight:850;background:var(--coralBg);border-radius:6px;padding:2px 9px}
.vms-drift-ok{color:#046B45;font-weight:800;font-size:11px}

/* worklist */
.vms-wl-head{padding:14px 20px;background:var(--slot);border-bottom:1px solid var(--line);display:flex;
  justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.vms-wl-head strong{font-size:12.5px;font-weight:900;color:var(--forest)}
.vms-wl-head span{font-size:11px;color:var(--muted);font-weight:700}
.vms-wl-sec{border-bottom:1px solid var(--line)}
.vms-wl-sec:last-child{border-bottom:0}
.vms-wl-sec-h{display:flex;justify-content:space-between;align-items:center;padding:12px 20px 2px}
.vms-wl-sec-h strong{font-size:12px;font-weight:900;color:var(--forest)}
.vms-wl-sec-h span{font-size:11px;font-weight:850;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:99px;padding:1px 9px}
.vms-wl-hint{padding:0 20px 8px;font-size:11px;color:var(--muted);font-weight:650}
.vms-wl-none{padding:2px 20px 14px;font-size:11.5px;color:var(--muted);font-weight:700}
.vms-wl{width:100%;border-collapse:collapse}
.vms-wl th,.vms-wl td{border:0;border-top:1px solid var(--line);font-size:12px;font-variant-numeric:tabular-nums;padding:10px 20px;text-align:left}
.vms-wl th{background:#fff;font-size:10px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)}
.vms-wl td.vms-nm{font-weight:800}
.vms-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--coralInk);color:#fff;
  font-size:12.5px;font-weight:700;padding:9px 16px;border-radius:999px;z-index:80}
`;
