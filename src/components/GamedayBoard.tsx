"use client";

// Gameday Ops (Phase 15) — a triage board, not a schedule. It answers "what is about
// to go wrong" for one day, read LIVE from the API, sorted by the REAL kickoff instant
// (startDateUtc), banded, with the fake-spot ladder as a countdown and auto-cancel
// driving each tile's colour. Built from today-v1_6.html; where the mockup and the API
// conflicted the API won (see docs/matchday-api-facts.md "Gameday Ops"):
//   • order by startDateUtc, no per-city offset maths (the API carries the instant);
//   • current fakes are OBSERVED (_count.fakePlayers), the ladder only forecasts;
//   • cancelled = isCancelled (not autoCanceled, a policy flag).
// All board maths live in the shared, tested gamedayModel. The tile is ONE <button>;
// the roster link and Veo control are SPANS with role + keyboard handling, because a
// <button> cannot nest inside a <button> (it silently ends the outer one).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { envBadge } from "@/lib/matchEnvBadge";
import { DRAWER_ENV } from "@/lib/matchEnv";
import { centsToDollars } from "@/lib/matchMoney";
import MatchDrawer, { DRAWER_W } from "@/components/MatchDrawer";
import {
  type ApiMatch, type BoardFilter, BANDS, byKickoff, bandOf, minsUntil, fmtDur, localClock, tzAbbr,
  realCount, fakeCount, capacity, openSpots, teamCount, short, shortBy, fill, flags, attention,
  acLevel, minsToDeadline, nextRelease, nextMark, inCities, passesFilter, MARKS,
} from "@/lib/gamedayModel";

const ENV = DRAWER_ENV; // the board reads and edits the same environment as the drawer

const localYMD = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (ymd: string, n: number) => { const [y, m, d] = ymd.split("-").map(Number); const dt = new Date(y, m - 1, d + n); return localYMD(dt); };
const dayLabel = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }); };
const clockNow = (nowMs: number) => new Date(nowMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

async function authFetch(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }, cache: "no-store" });
}

export default function GamedayBoard() {
  const router = useRouter();
  const [today] = useState(() => localYMD(new Date()));
  const [date, setDate] = useState(today);
  const [matches, setMatches] = useState<ApiMatch[]>([]);
  const [veo, setVeo] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [cities, setCities] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [drawerDirty, setDrawerDirty] = useState(false);
  const [toast, setToast] = useState<{ t: string; bad?: boolean } | null>(null);
  const badge = envBadge(ENV);

  const say = (t: string, bad = false) => { setToast({ t, bad }); setTimeout(() => setToast(null), 2800); };

  const load = useCallback(async (d: string) => {
    setLoading(true); setErr(null);
    try {
      const res = await authFetch(`/api/matchday/${ENV}/gameday?date=${d}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j?.error ?? `HTTP ${res.status}`); setMatches([]); }
      else setMatches((j.matches ?? []) as ApiMatch[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setMatches([]); }
    // Veo coverage (Clubhouse-side) for the week of this day — best effort.
    try {
      const vr = await authFetch(`/api/veo?week=${d}`);
      if (vr.ok) { const vj = await vr.json(); const map: Record<number, boolean> = {};
        for (const m of (vj?.matches ?? []) as { apiId: number; veo: boolean }[]) map[m.apiId] = !!m.veo;
        setVeo(map); }
    } catch { /* veo is non-critical to triage */ }
    setLoading(false);
  }, []);
  useEffect(() => { void load(date); }, [date, load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  const guardLeave = () => { if (drawerDirty) { say("Save or revert first.", true); return false; } return true; };
  const goDay = (d: string) => { if (!guardLeave()) return; if (drawerId != null) setDrawerId(null); setDate(d); };

  // scope = the city selection; the STATS (filter counts, band counts) derive from it,
  // not just the grid.
  const scope = useMemo(() => matches.filter((m) => inCities(m, cities)), [matches, cities]);
  const counts = useMemo(() => ({
    all: scope.length,
    att: scope.filter((m) => attention(m, now)).length,
    upc: scope.filter((m) => minsUntil(m, now) > 0).length,
  }), [scope, now]);
  const cityNames = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of matches) { const c = m.field?.city?.name; if (c) map.set(c, (map.get(c) ?? 0) + 1); }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [matches]);
  const visible = useMemo(() => scope.filter((m) => passesFilter(m, now, filter)).sort(byKickoff), [scope, now, filter]);

  const drawerSiblings = useMemo(() => visible.map((m) => m.id), [visible]);

  const money = (c: number | null | undefined) => (c == null ? "—" : "$" + centsToDollars(c));

  const openDrawer = (id: number) => { if (drawerId != null && drawerId !== id && !guardLeave()) return; setDrawerId(id); };
  const goRoster = (id: number) => { if (!guardLeave()) return; router.push(`/match-ops/matches/${id}/roster`); };
  const toggleCity = (c: string) => setCities((prev) => { const n = new Set(prev); if (c === "") return new Set(); n.has(c) ? n.delete(c) : n.add(c); return n; });
  const toggleVeo = async (id: number, enabled: boolean) => {
    setVeo((v) => ({ ...v, [id]: enabled }));
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetch(`/api/veo/intent`, { method: "POST", headers: { "Content-Type": "application/json", ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}) }, body: JSON.stringify({ matchApiId: id, enabled }) });
      if (!res.ok) throw new Error();
      say(enabled ? "Camera assigned" : "Camera removed");
    } catch { setVeo((v) => ({ ...v, [id]: !enabled })); say("Couldn't save the camera change", true); }
  };

  const banded = useMemo(() => BANDS.map((B) => ({ B, rows: visible.filter((m) => bandOf(m, now) === B.k) })).filter((x) => x.rows.length), [visible, now]);

  return (
    <div className="gdo" data-testid="gameday" data-env={ENV} style={{ ["--drawer-w" as string]: `${DRAWER_W}px` }}>
      <style>{CSS}</style>
      <div className={"gmain" + (drawerId != null ? " drawering" : "")}>
        <div className="panel head">
          <div className="r1">
            <h1>Gameday Ops</h1>
            <span className="dt" data-testid="date-label">{dayLabel(date)}</span>
            <span className="clock" data-testid="clock">now {clockNow(now)}</span>
          </div>
          <p className="lede">Everything for one day, soonest kickoff first in real time — cities in different timezones interleave by the actual instant, so clock order and kickoff order are not the same thing. Click a match to fix what looks wrong.</p>
          <div className="chips">
            <div className="daynav">
              <button className="arw" data-testid="day-prev" aria-label="Previous day" onClick={() => goDay(addDays(date, -1))}>‹</button>
              <div className="daylab"><b data-testid="daylab">{dayLabel(date)}</b><i>{date === today ? "TODAY" : ""}</i></div>
              <button className="arw" data-testid="day-next" aria-label="Next day" onClick={() => goDay(addDays(date, 1))}>›</button>
            </div>
            <button className="chip" data-testid="day-today" disabled={date === today} onClick={() => goDay(today)}>Today</button>
            <span className="filters">
              <button className={"chip" + (filter === "all" ? " on" : "")} data-testid="filter-all" onClick={() => setFilter("all")}>All<span className="b">{counts.all}</span></button>
              <button className={"chip att" + (filter === "att" ? " on" : "")} data-testid="filter-att" onClick={() => setFilter("att")}>Needs attention<span className="b">{counts.att}</span></button>
              <button className={"chip" + (filter === "upc" ? " on" : "")} data-testid="filter-upc" onClick={() => setFilter("upc")}>Still to come<span className="b">{counts.upc}</span></button>
            </span>
          </div>
          <div className="row2"><span className="lb">CITIES</span>
            <span className="cityf" data-testid="cityf">
              <button className={"chip" + (cities.size === 0 ? " on" : "")} data-testid="city-all" onClick={() => toggleCity("")}>All cities</button>
              {cityNames.map(([c, n]) => <button key={c} className={"chip" + (cities.has(c) ? " on" : "")} data-testid={`city-${c}`} onClick={() => toggleCity(c)}>{c}<span className="b">{n}</span></button>)}
            </span>
          </div>
          <span className={"pill " + (badge.tone === "prod" ? "live" : "stg")} data-testid="gameday-env">{badge.tone === "prod" ? <><i />PRODUCTION — LIVE EDITS</> : badge.label}</span>
        </div>

        {loading ? <div className="empty" data-testid="loading">Loading {dayLabel(date)}…</div>
          : err ? <div className="empty err" data-testid="board-err">Couldn’t load the board: {err}</div>
          : banded.length === 0 ? <div className="empty" data-testid="empty">Nothing to show for {dayLabel(date)} with these filters.</div>
          : <div className="bands" data-testid="bands">
            {banded.map(({ B, rows }) => (
              <section className="band" data-testid={`band-${B.k}`} key={B.k}>
                <h2>{B.t}<span className="n">{rows.length}</span></h2>
                <div className="rows">{rows.map((m) => <Tile key={m.id} m={m} now={now} veo={!!veo[m.id]} selected={drawerId === m.id} onOpen={openDrawer} onRoster={goRoster} onVeo={toggleVeo} money={money} />)}</div>
              </section>
            ))}
          </div>}
      </div>

      {drawerId != null && (
        <MatchDrawer
          apiId={drawerId} cardVeo={!!veo[drawerId]} siblings={drawerSiblings}
          onClose={() => { if (guardLeave()) setDrawerId(null); }}
          onDirtyChange={setDrawerDirty}
          onSaved={() => { void load(date); say("Saved"); }}
          onToggleVeo={(id, en) => void toggleVeo(id, en)}
          onStep={(id) => setDrawerId(id)}
          onToast={(m, w) => say(m, w)}
        />
      )}
      {toast && <div className={"toast" + (toast.bad ? " bad" : "")} data-testid="toast">{toast.t}</div>}
    </div>
  );
}

function Tile({ m, now, veo, selected, onOpen, onRoster, onVeo, money }: {
  m: ApiMatch; now: number; veo: boolean; selected: boolean;
  onOpen: (id: number) => void; onRoster: (id: number) => void; onVeo: (id: number, en: boolean) => void; money: (c: number | null | undefined) => string;
}) {
  const t = minsUntil(m, now), lvl = acLevel(m, now), band = bandOf(m, now);
  const cap = capacity(m), real = realCount(m), fk = fakeCount(m), open = openSpots(m);
  const f = fill(m), rel = nextRelease(m, now), mark = nextMark(m, now);
  const fl = flags(m, now);
  const cd = m.isCancelled ? "" : t <= -90 ? `finished ${fmtDur(t)} ago` : t <= 0 ? "in play" : `in ${fmtDur(t)}`;
  const cdCls = t <= 0 && t > -90 ? "live" : t > 0 && t <= 180 ? "soon" : "";
  const rosterKey = (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onRoster(m.id); } };
  const veoKey = (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onVeo(m.id, !veo); } };

  return (
    <button className={"row" + (band === "done" ? " done" : "") + (m.isCancelled ? " cx" : "") + (lvl ? " " + lvl : "") + (selected ? " sel" : "")}
      data-testid="tile" data-id={m.id} data-band={band} data-ac={lvl} data-cx={m.isCancelled ? 1 : 0}
      onClick={() => onOpen(m.id)} aria-label={`${m.name} at ${m.field?.title ?? ""}, ${localClock(m)} ${tzAbbr(m)}`}>
      <span className="hdr">
        <span className="when" data-testid="tile-when"><b>{localClock(m)}</b> <span className="tz">{tzAbbr(m)}</span><span className={"cd " + cdCls}>{cd}</span></span>
        <span className="ttl"><span className="nm">{m.name}{m.isCancelled && <span className="cxb">CANCELLED</span>}</span></span>
        <span className="price" data-testid="tile-price">{money(m.registrationPrice)}</span>
        <span className="veocell" data-testid="tile-veo">
          <span className={"veob" + (veo ? " on" : "")} role="switch" tabIndex={0} data-testid="veo-badge" data-veo={m.id} aria-checked={veo} aria-label={`Veo for ${m.name}`}
            onClick={(e) => { e.stopPropagation(); onVeo(m.id, !veo); }} onKeyDown={veoKey}>VEO</span>
        </span>
        <span className="go">›</span>
      </span>
      <span className="meta" data-testid="tile-meta">
        <span><span className="k">FIELD</span><span className="v">{m.field?.title ?? "—"}</span></span>
        <span><span className="k">CITY</span><span className="v">{m.field?.city?.name ?? "—"}</span></span>
        <span><span className="k">FORMAT</span><span className="v">{(m.category ?? "—")} · {teamCount(m)} teams</span></span>
        <span><span className="k">MANAGER</span><span className={"v" + (!m.manager ? " none" : "")}>{m.manager ? [m.manager.firstName, m.manager.lastName].filter(Boolean).join(" ") : "none assigned"}</span></span>
      </span>
      <span className="stats" data-testid="tile-stats">
        <span className="st fill">
          <span className="k">SPOTS{!m.isCancelled && (
            <span className="rosterlink" role="link" tabIndex={0} data-testid="roster-link" data-roster={m.id} aria-label={`Open the roster for ${m.name}`}
              onClick={(e) => { e.stopPropagation(); onRoster(m.id); }} onKeyDown={rosterKey}>ROSTER ›</span>)}</span>
          {cap == null ? <span className="nums" data-testid="fill-nums">special event · no cap</span> : <>
            <span className="barwrap">
              <span className={"bar" + (!m.isCancelled && !short(m) && t > -90 ? " cleared" : "")} data-testid="fill-bar">
                <i className="r" style={{ width: `${f!.realPct}%` }} data-testid="fill-real" /><i className="f" style={{ width: `${f!.fakePct}%` }} />
                {!m.isCancelled && short(m) && <b className="gap" data-testid="fill-gap" style={{ left: `${f!.realPct}%`, width: `${f!.gapPct}%` }} />}
              </span>
              {!m.isCancelled && <b className={"min" + (short(m) ? "" : " hit")} data-testid="fill-marker" style={{ left: `${f!.minPct}%` }} data-n={m.minPlayerCount} title={`${m.minPlayerCount} players needed to avoid an auto-cancel`} />}
            </span>
            <span className="nums" data-testid="fill-nums"><b>{real}</b> real{fk ? <> · <span className="fk">{fk} fake</span></> : null} · {open} open <span className="ofcap">of {cap}</span></span>
            {!m.isCancelled && <span className="minlab" data-testid="minlab">{short(m)
              ? <><span className="tag togo">{shortBy(m)} TO GO</span><span className="nn"><b>{real}</b> of {m.minPlayerCount} needed</span></>
              : <><span className="tag made"><span className="ck">✓</span>MADE IT</span><span className="nn"><b>{real - (m.minPlayerCount ?? 0)}</b> clear of {m.minPlayerCount}</span></>}</span>}
          </>}
        </span>
        <span className="st rel"><span className="k">SPOTS RELEASED</span>
          <span className="rungs">{t > 0 && !m.isCancelled
            ? [[6, m.fakeSpotLeft6h], [3, m.fakeSpotLeft3h]].map(([h, v]) => <span key={h} className={"rung" + (mark === h ? " next" : "")} data-testid={`rung-${h}`}>{h}h <b>{Math.min(Number(v) || 0, Math.max(0, (cap ?? (Number(v) || 0)) - real))}</b></span>)
            : <span className="rung dash">—</span>}</span>
          <span className={"nx" + (rel && !m.isCancelled ? "" : " none")} data-testid="next-release">{rel && !m.isCancelled ? `+${rel.drop} in ${fmtDur(rel.inMin)}, at the ${rel.mark}h mark` : (t > 0 && !m.isCancelled ? "no more releases" : "")}</span>
        </span>
        <span className={"st ac " + (t <= 0 || m.isCancelled ? "" : !short(m) ? "ok" : (lvl || "warn"))} data-testid="tile-ac">
          <span className="k">AUTO-CANCEL</span>
          {t <= 0 || m.isCancelled ? <span className="line dash">—</span> : <>
            <span className="line">Cancels <b>{m.autoCanceledMinutes}m</b> before · {minsToDeadline(m, now) > 0 ? <>in <b>{fmtDur(minsToDeadline(m, now))}</b></> : <b>deadline passed {fmtDur(minsToDeadline(m, now))} ago</b>}</span>
            <span className="cnt">{short(m) ? <>needs <b>{m.minPlayerCount}</b> — <b>{shortBy(m)} short</b></> : <>needs {m.minPlayerCount} — clear by {real - (m.minPlayerCount ?? 0)}</>}</span>
          </>}
        </span>
      </span>
      {fl.length > 0 && <span className="flags" data-testid="tile-flags">{fl.map((x, i) => <span key={i} className={"fl " + x.k}>{x.t}</span>)}</span>}
    </button>
  );
}

const CSS = `
.gdo{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:#0B1F17;background:#EDF2EF;min-height:100vh}
.gdo .gmain{padding:20px 24px 70px;transition:margin-right .17s ease-out}
.gdo .gmain.drawering{margin-right:var(--drawer-w,480px)}
.gdo .panel{background:#fff;border:1px solid #DCE5E0;border-radius:14px}
.gdo .head{padding:18px 20px 16px;margin-bottom:14px;position:relative}
.gdo .r1{display:flex;align-items:baseline;gap:12px}.gdo h1{margin:0;font-size:23px;letter-spacing:-.2px}
.gdo .dt{font-size:14px;color:#5C6B62}.gdo .clock{margin-left:auto;font-size:13px;color:#5C6B62;font-variant-numeric:tabular-nums}
.gdo .lede{margin:7px 0 14px;color:#5C6B62;font-size:14px;max-width:74ch}
.gdo .chips{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.gdo .daynav{display:flex;align-items:center;gap:8px;margin-right:4px}
.gdo .arw{width:34px;height:34px;border-radius:8px;border:1px solid #DCE5E0;background:#fff;color:#20372C;line-height:1;font-size:16px}
.gdo .arw:hover{background:#F2F7F4}
.gdo .daylab{min-width:184px;text-align:center}.gdo .daylab b{display:block;font-size:14.5px}.gdo .daylab i{display:block;font-style:normal;font-size:10px;letter-spacing:.1em;color:#046B45;font-weight:700;min-height:12px}
.gdo .chip{border:1px solid #DCE5E0;background:#fff;border-radius:20px;padding:8px 14px;color:#1B3227;font-size:14px;min-height:34px}
.gdo .chip:hover{background:#F2F7F4}.gdo .chip.on{background:#003326;border-color:#003326;color:#fff;font-weight:600}
.gdo .chip:disabled{opacity:.45}.gdo .chip.att{border-color:#E9B6AC;color:#A83120}.gdo .chip.att.on{background:#A83120;border-color:#A83120;color:#fff}
.gdo .chip .b{display:inline-block;margin-left:6px;font-weight:700;font-size:12px}
.gdo .filters{display:flex;gap:7px}
.gdo .row2{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid #E9EFEB}
.gdo .row2 .lb{font-size:10.5px;letter-spacing:.12em;color:#5C6B62;font-weight:700;margin-right:2px}
.gdo .cityf{display:flex;gap:7px;flex-wrap:wrap}
.gdo .pill{position:absolute;top:18px;right:20px;font-size:10.5px;font-weight:800;letter-spacing:.06em;border-radius:20px;padding:4px 10px}
.gdo .pill.live{background:#E5121B;color:#fff;display:inline-flex;align-items:center;gap:6px}.gdo .pill.live i{width:7px;height:7px;border-radius:50%;background:#fff}
.gdo .pill.stg{background:#F2E31D;color:#231F00}
.gdo .bands{display:flex;flex-direction:column;gap:14px}
.gdo .band h2{margin:0 0 9px 3px;font-size:12px;letter-spacing:.11em;color:#55635B;font-weight:700;display:flex;align-items:center;gap:8px}
.gdo .band h2 .n{color:#4E5A54;letter-spacing:0;font-weight:600;font-size:12.5px}
.gdo .rows{display:flex;flex-direction:column;gap:8px}
.gdo .row{display:block;width:100%;text-align:left;color:inherit;background:#fff;border:1px solid #DCE5E0;border-radius:12px;padding:11px 13px 10px;cursor:pointer}
.gdo .row:hover{border-color:#9FC4B2;box-shadow:0 2px 8px rgba(0,42,28,.08)}
.gdo .row:focus-visible{outline:2px solid #046B45;outline-offset:2px}
.gdo .row.sel{box-shadow:0 0 0 3px #2CDB87,0 6px 18px rgba(0,42,28,.18)}
.gdo .row.done{opacity:.72;background:#FAFBFA}
.gdo .row.warn{background:#FEF9EF;border-color:#E3C88A}
.gdo .row.crit{background:#FDF1EE;border-color:#E9B6AC;box-shadow:inset 3px 0 0 #A83120}
.gdo .row.cx{opacity:.7;background:#FAFAFA}.gdo .row.cx .nm{text-decoration:line-through;text-decoration-color:#A7B3AD}
.gdo .hdr{display:grid;grid-template-columns:118px minmax(0,1fr) auto auto 18px;gap:12px;align-items:center}
.gdo .hdr>*{min-width:0}
.gdo .when b{font-size:15.5px;font-weight:700;letter-spacing:-.2px;font-variant-numeric:tabular-nums}
.gdo .when .tz{font-size:10px;font-weight:800;letter-spacing:.07em;color:#5C6B62;margin:0 4px}
.gdo .when .cd{font-size:12px;color:#5C6B62;font-variant-numeric:tabular-nums;display:block}
.gdo .when .cd.soon{color:#A83120;font-weight:700}.gdo .when .cd.live{color:#046B45;font-weight:700}
.gdo .ttl .nm{font-weight:700;font-size:16px;letter-spacing:-.15px}
.gdo .cxb{font-size:10px;font-weight:800;letter-spacing:.06em;background:#FDEEEB;color:#A83120;border:1px solid #E9B6AC;border-radius:5px;padding:2px 7px;margin-left:7px}
.gdo .price{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.gdo .veob{display:inline-flex;align-items:center;justify-content:center;border-radius:6px;padding:6px 10px;font-size:10.5px;font-weight:800;letter-spacing:.06em;border:1px solid #C3CDC7;background:#fff;color:#41514A;cursor:pointer;min-height:32px}
.gdo .veob.on{background:#F2E31D;border-color:#F2E31D;color:#231F00}
.gdo .veob:focus-visible{outline:2px solid #046B45;outline-offset:1px}
.gdo .go{color:#5C6B62;text-align:right;font-size:15px}
.gdo .meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:9px;padding-top:9px;border-top:1px solid #E9EFEB}
.gdo .meta>span{min-width:0}
.gdo .meta .k{display:block;font-size:10px;letter-spacing:.09em;font-weight:700;color:#5C6B62;margin-bottom:3px}
.gdo .meta .v{display:block;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdo .meta .v.none{color:#A83120;font-weight:700}
.gdo .stats{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.85fr) minmax(0,1.3fr);gap:14px;align-items:start;margin-top:9px;padding-top:9px;border-top:1px solid #E9EFEB}
.gdo .st .k{display:flex;align-items:center;font-size:10px;letter-spacing:.09em;font-weight:700;color:#5C6B62;margin-bottom:6px}
.gdo .rosterlink{margin-left:auto;display:inline-flex;align-items:center;cursor:pointer;border:1px solid #DCE5E0;background:#fff;border-radius:6px;padding:4px 8px;font-size:10px;font-weight:800;letter-spacing:.06em;color:#046B45;text-transform:none;min-height:26px}
.gdo .rosterlink:hover{background:#EAF9F1;border-color:#A9E3C6}.gdo .rosterlink:focus-visible{outline:2px solid #046B45;outline-offset:1px}
.gdo .barwrap{display:block;position:relative;margin:16px 0 5px}
.gdo .bar{position:relative;display:flex;height:11px;border-radius:5px;overflow:hidden;background:#E4EAE7}
.gdo .bar i{display:block;height:100%}.gdo .bar .r{background:#046B45;transition:width .2s}.gdo .bar .f{background:#F2E31D}
.gdo .bar.cleared .r{background:linear-gradient(90deg,#046B45 0%,#0E7A50 70%,#17945F 100%)}
.gdo .bar .gap{position:absolute;top:0;bottom:0;background:repeating-linear-gradient(-45deg,rgba(168,49,32,.34) 0 3px,rgba(168,49,32,.12) 3px 6px)}
.gdo .barwrap .min{position:absolute;top:-3px;height:17px;width:2px;background:#0B1F17;border-radius:1px;z-index:2}
.gdo .barwrap .min::after{content:attr(data-n);position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% + 3px);background:#0B1F17;color:#fff;font-size:9.5px;font-weight:800;line-height:1;padding:3px 5px;border-radius:4px;white-space:nowrap}
.gdo .barwrap .min.hit{background:#046B45;box-shadow:0 0 0 3px rgba(44,219,135,.28)}
.gdo .barwrap .min.hit::after{content:"✓ " attr(data-n);background:#046B45}
.gdo .nums{font-size:12.5px;color:#5C6B62;font-variant-numeric:tabular-nums}.gdo .nums b{color:#0B1F17}.gdo .nums .fk{color:#7A5200;font-weight:700}.gdo .nums .ofcap{color:#5C6B62}
.gdo .minlab{display:block;margin-top:4px;font-size:11px;color:#5C6B62}
.gdo .minlab .tag{display:inline-flex;align-items:center;gap:4px;border-radius:20px;padding:2px 9px;font-size:10.5px;font-weight:800;letter-spacing:.05em}
.gdo .minlab .tag.made{background:#E4F8EE;color:#046B45;border:1px solid #A9E3C6}
.gdo .minlab .tag.togo{background:#FDEEEB;color:#A83120;border:1px solid #E9B6AC}
.gdo .minlab .nn{margin-left:7px}.gdo .minlab .nn b{color:#0B1F17}
.gdo .rungs{display:flex;gap:7px}
.gdo .rung{border:1px solid #DCE5E0;border-radius:7px;padding:4px 9px;background:#fff;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;min-height:28px}
.gdo .rung b{color:#1B4F9C}.gdo .rung.next{border-color:#C9DBF3;background:#F2F7FE}.gdo .rung.dash{color:#5C6B62}
.gdo .nx{display:block;font-size:11.5px;color:#1B4F9C;margin-top:5px;font-variant-numeric:tabular-nums}.gdo .nx.none{color:#5C6B62}
.gdo .ac .line{font-size:12.5px;font-variant-numeric:tabular-nums}.gdo .ac .line b{font-weight:700}.gdo .ac .line.dash{color:#5C6B62}
.gdo .ac .cnt{font-size:12.5px;margin-top:2px;font-variant-numeric:tabular-nums}
.gdo .ac.ok .cnt{color:#046B45;font-weight:600}
.gdo .ac.warn .line b,.gdo .ac.warn .cnt{color:#7A5200}
.gdo .ac.crit .line b,.gdo .ac.crit .cnt{color:#A83120}
.gdo .row.warn .k,.gdo .row.crit .k{color:#5A6560}
.gdo .flags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.gdo .fl{font-size:11px;font-weight:700;letter-spacing:.04em;border-radius:5px;padding:2px 8px}
.gdo .fl.bad{background:#FDEEEB;color:#A83120;border:1px solid #E9B6AC}
.gdo .fl.warn{background:#FBF0DC;color:#7A5200;border:1px solid #E3C88A}
.gdo .fl.info{background:#F2F7FE;color:#1B4F9C;border:1px solid #C9DBF3}
.gdo .empty{padding:22px;text-align:center;color:#5C6B62;font-size:14px;border:1px dashed #DCE5E0;border-radius:12px;background:#fff}
.gdo .empty.err{color:#A83120;border-color:#E9B6AC;background:#FDEEEB}
.gdo .toast{position:fixed;left:50%;top:16px;transform:translateX(-50%);background:#003326;color:#fff;padding:10px 19px;border-radius:10px;font-size:14px;z-index:90;box-shadow:0 6px 20px rgba(0,32,21,.28)}
.gdo .toast.bad{background:#A83120}

/* ── Phone: this is used one-handed at a field. Tiles reflow, cities scroll. ── */
@media (max-width: 820px){
  .gdo .gmain{padding:12px 12px 90px;margin-right:0 !important}
  .gdo .head{padding:14px 14px 13px}
  .gdo .lede{display:none}
  .gdo .clock{font-size:12px}
  .gdo .pill{position:static;display:inline-flex;margin-top:10px}
  .gdo .daynav{width:100%;justify-content:space-between;margin-right:0}
  .gdo .daylab{min-width:0;flex:1}
  .gdo .arw{width:40px;height:40px}
  .gdo .filters{flex:1;display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  .gdo .filters::-webkit-scrollbar{display:none}
  .gdo .filters .chip{flex:0 0 auto}
  .gdo .row2{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  .gdo .row2::-webkit-scrollbar{display:none}
  .gdo .row2 .lb{flex:0 0 auto}.gdo .cityf{flex-wrap:nowrap}.gdo .cityf .chip{flex:0 0 auto}
  .gdo .chip{padding:9px 14px}
  .gdo .row{padding:12px 12px 11px}
  .gdo .hdr{grid-template-columns:1fr auto auto 14px;grid-template-areas:"when price veo go" "ttl ttl ttl ttl";gap:8px 10px}
  .gdo .when{grid-area:when;display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}.gdo .when .cd{display:inline}
  .gdo .ttl{grid-area:ttl}.gdo .ttl .nm{white-space:normal}
  .gdo .price{grid-area:price}.gdo .veocell{grid-area:veo}.gdo .go{grid-area:go}
  .gdo .veob{padding:9px 13px;font-size:11px}
  .gdo .meta{grid-template-columns:1fr 1fr;gap:10px 14px}
  .gdo .stats{grid-template-columns:1fr;gap:12px}
  .gdo .st{border-top:1px solid #E9EFEB;padding-top:10px}.gdo .st.fill{border-top:0;padding-top:0}
  .gdo .rosterlink{min-height:32px;padding:6px 10px}
  .gdo .bar{height:14px}
  .gdo .toast{left:12px;right:12px;transform:none;text-align:center}
}
`;
