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
import MatchPanel from "@/components/MatchPanel";
import { useCrmConversationOptional } from "@/lib/crmConversation";
import LogHealthBanner from "@/components/LogHealthBanner";
import MatchOpsSectionSheet from "@/app/(internal)/match-ops/MatchOpsSectionSheet";
import MatchOpsMobileBar from "@/app/(internal)/match-ops/MatchOpsMobileBar";
import type { RailItem } from "@/app/(internal)/match-ops/sections";
import RefreshIcon from "@/components/RefreshIcon";
import {
  type ApiMatch, type BoardFilter, type MatchGroup, GROUPS, byKickoff, matchGroup, minsUntil, fmtDur, localClock, deadlineClock, tzAbbr,
  realCount, fakeCount, capacity, openSpots, teamCount, short, shortBy, fill, flags, attention,
  acLevel, minsToDeadline, nextRelease, nextMark, inCities, passesFilter, stillToCome, riskTier, snapRail, vsMin, vsMinDelta, STD_LEAD, MARKS, autoCancels,
} from "@/lib/gamedayModel";

const ENV = DRAWER_ENV; // the board reads and edits the same environment as the drawer

const localYMD = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (ymd: string, n: number) => { const [y, m, d] = ymd.split("-").map(Number); const dt = new Date(y, m - 1, d + n); return localYMD(dt); };
const dayLabel = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }); };
// Phone day label: "Sun, Aug 9" — the long weekday+month+year won't fit a 44px band.
const shortDay = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); };
const clockNow = (nowMs: number) => new Date(nowMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

async function authFetch(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }, cache: "no-store" });
}

const PANEL_W = 600; // the in-place match panel (replaces the old side drawer + "Open full editor")
// WIDER WHEN THERE IS ROOM. The panel's teams grid holds a name AND a phone number per row, two
// columns of them at four teams; 600px squeezed both. It only widens when the chat dock is NOT
// sharing the edge — coexisting at 600 + 360 already leaves the board little enough.
const PANEL_W_WIDE = 820;
const DOCK_W = 360;  // the CRM chat dock's expanded width — they sit side-by-side at ≥1600

// ONE BOARD, TWO CALLERS. Match Ops renders it bare; the city-manager tier passes three props.
// Everything else — the rails, the bands, the fake-spot ladder, the decide-by countdown, the
// grouping, both layouts — is the same component, because the difference between the two pages is
// WHICH MATCHES, not what a match looks like.
//
//   endpoint    where the day comes from. Default is the admin route (every city). The city tier
//               passes its own, which is scoped server-side from the session.
//   lockedCity  renders the city control as a single locked chip instead of the chip row. The lock
//               is a UI fact, not the security: the scoped endpoint has already decided.
//   onOpenMatch replaces "open the match panel". The city tier sends the operator to the match's
//               Manager Pay row instead — the panel, the roster and the cancel preview are all
//               things this tier must not reach, and the routes behind them refuse it anyway.
//               When this is set the panel is never mounted at all.
//   nav         the board renders the app bar itself (its refresh + freshness stamp share that
//               44px band), so the caller's nav list has to reach it here rather than from the
//               layout. Omitted = the Match Ops list, as before.
export default function GamedayBoard({
  endpoint,
  lockedCity = null,
  onOpenMatch,
  nav,
}: {
  endpoint?: string;
  lockedCity?: string | null;
  onOpenMatch?: (id: number) => void;
  nav?: { items: RailItem[]; title: string };
} = {}) {
  const router = useRouter();
  const [today] = useState(() => localYMD(new Date()));
  const [date, setDate] = useState(today);
  const [matches, setMatches] = useState<ApiMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // When the DATA landed — not the wall clock. null until the first successful fetch.
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [staleFail, setStaleFail] = useState(false); // last manual refresh failed; rows are old but kept
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [cities, setCities] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [drawerDirty, setDrawerDirty] = useState(false);
  // The dock collision. The CRM chat dock is already a right-edge column; the panel wants the same
  // edge. ≥1600 they coexist (panel sits left of the dock, main shrinks). <1600 opening the panel
  // COLLAPSES the dock to its rail — the thread and draft live in the provider, so nothing is lost;
  // it is not reopened when the panel closes (the operator's choice). Said once, the first time.
  // NULL in the city-manager shell, which mounts no CRM provider on purpose. Every use below is
  // guarded — see useCrmConversationOptional.
  const crm = useCrmConversationOptional();
  const [wide, setWide] = useState(false);
  const [dockNotice, setDockNotice] = useState(false);
  const dockNoticeShown = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1600px)");
    const on = () => setWide(mq.matches); on();
    mq.addEventListener("change", on); return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (drawerId == null || wide) return;
    if (crm?.dockedThreadId && crm.dockOpen) {
      crm.setDockOpen(false); // collapse only — dockedThreadId + drafts stay in the provider
      if (!dockNoticeShown.current) { dockNoticeShown.current = true; setDockNotice(true); }
    }
  }, [drawerId, wide, crm?.dockedThreadId, crm?.dockOpen, crm]);
  const coexist = drawerId != null && wide && !!crm?.dockedThreadId && crm.dockOpen;
  const panelW = wide && !coexist ? PANEL_W_WIDE : PANEL_W;
  const [toast, setToast] = useState<{ t: string; bad?: boolean } | null>(null);
  // Snapshot is the ONLY layout. The Detail card view and its Snapshot/Detail toggle were removed
  // — the whole day on one screen is the job, and a second layout was a fork nobody chose.
  // A stale ?view=detail bookmark is simply ignored: nothing reads the param, so the page loads.
  // Phone-only: the "Gameday Ops ▾" title opens the screen picker (replaces the tab strip).
  const [pickerOpen, setPickerOpen] = useState(false);
  const mheadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
  }, []);
  const badge = envBadge(ENV);
  const updatedLabel = updatedAt == null ? "—" : clockNow(updatedAt);
  // `now` already ticks every 30s, so the "Nm ago" figure stays honest without its own timer.
  const staleMins = updatedAt == null ? 0 : Math.floor((now - updatedAt) / 60000);

  const say = (t: string, bad = false) => { setToast({ t, bad }); setTimeout(() => setToast(null), 2800); };

  // `quiet` = a manual refresh: keep the current rows on screen instead of flashing the loader,
  // and NEVER blank the table on failure. Stale data the manager knows is stale beats an empty page.
  const load = useCallback(async (d: string, quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    if (!quiet) setErr(null);
    setStaleFail(false);
    let landed = false;
    try {
      const res = await authFetch(`${endpoint ?? `/api/matchday/${ENV}/gameday`}?date=${d}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (quiet) setStaleFail(true); else { setErr(j?.error ?? `HTTP ${res.status}`); setMatches([]); }
      } else { setMatches((j.matches ?? []) as ApiMatch[]); landed = true; }
    } catch (e) {
      if (quiet) setStaleFail(true); else { setErr(e instanceof Error ? e.message : String(e)); setMatches([]); }
    }
    // THE TIMESTAMP MOVES ONLY WHEN DATA LANDED. A clock that ticks regardless is a clock
    // pretending to be a freshness indicator.
    if (landed) setUpdatedAt(Date.now());
    setLoading(false); setRefreshing(false);
  }, [endpoint]);
  useEffect(() => { void load(date); }, [date, load]);
  // 15s, not 30s: this clock drives the freshness age, and at 30s the "2 minutes" threshold
  // could be reported up to half a minute late — which reads as "the stamp is not ageing".
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);
  // Phone: glue the sticky group subheads directly under the sticky header. The header
  // is 3 fixed 44px bands + the 3px prod strip (~135px), but measure it so a wrapped
  // chip row can't shove a group header under the wrong offset. Harmless on desktop
  // (mhead is display:none → 0, and desktop group heads aren't sticky).
  useEffect(() => {
    const set = () => { const h = mheadRef.current?.getBoundingClientRect().height ?? 0; document.documentElement.style.setProperty("--gd-hdrh", `${Math.round(h) + 3}px`); };
    set(); window.addEventListener("resize", set); return () => window.removeEventListener("resize", set);
  }, []); // the mhead is 3 fixed bands — height is constant; only mount + viewport resize matter

  const guardLeave = () => { if (drawerDirty) { say("Save or revert first.", true); return false; } return true; };
  const goDay = (d: string) => { if (!guardLeave()) return; if (drawerId != null) setDrawerId(null); setDate(d); };

  // scope = the city selection; the STATS (filter counts, band counts) derive from it,
  // not just the grid.
  const scope = useMemo(() => matches.filter((m) => inCities(m, cities)), [matches, cities]);
  const counts = useMemo(() => ({
    all: scope.length,
    att: scope.filter((m) => attention(m, now)).length,
    upc: scope.filter((m) => stillToCome(m, now)).length, // §0: the ONE predicate the group + rows use
  }), [scope, now]);
  const cityNames = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of matches) { const c = m.field?.city?.name; if (c) map.set(c, (map.get(c) ?? 0) + 1); }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [matches]);
  const visible = useMemo(() => scope.filter((m) => passesFilter(m, now, filter)).sort(byKickoff), [scope, now, filter]);

  const drawerSiblings = useMemo(() => visible.map((m) => m.id), [visible]);

  const money = (c: number | null | undefined) => (c == null ? "—" : "$" + centsToDollars(c));

  // A read-only caller never opens the panel — it is not hidden, it is not built.
  const openDrawer = (id: number) => {
    if (onOpenMatch) { onOpenMatch(id); return; }
    if (drawerId != null && drawerId !== id && !guardLeave()) return;
    setDrawerId(id);
  };
  const stepIdx = drawerId != null ? drawerSiblings.indexOf(drawerId) : -1;
  const step = (d: number) => { if (!guardLeave()) return; const i = stepIdx + d; if (i >= 0 && i < drawerSiblings.length) setDrawerId(drawerSiblings[i]); };
  const toggleCity = (c: string) => setCities((prev) => { const n = new Set(prev); if (c === "") return new Set(); n.has(c) ? n.delete(c) : n.add(c); return n; });

  // THE grouping — four groups (still-to-come, in-play, cancelled, finished), from the ONE
  // matchGroup() function, shared by BOTH views so they can never disagree. Every group sorts
  // by kickoff (`visible` is already byKickoff). The Risk sort was removed in Phase 21 §8: it
  // duplicated the "Needs attention" filter — sorting risk to the top and filtering to it
  // answer the same question, and the filter answers it better without reshuffling the day.
  const grouped = useMemo(() => GROUPS.map((G) => ({ G, rows: visible.filter((m) => matchGroup(m, now) === G.k) }))
    .filter((x) => x.rows.length), [visible, now]);
  const anyRows = grouped.some((x) => x.rows.length > 0);

  return (
    <div className="gdo" data-testid="gameday" data-env={ENV} style={{ ["--drawer-w" as string]: `${panelW + (coexist ? DOCK_W : 0)}px` }}>
      <style>{CSS}</style>
      <div className={"gmain" + (drawerId != null ? " drawering" : "")}>
        {/* ── PHONE header (≤759px). Desktop shows the .head card below; this is
            display:none there. Three 44px bands under a 3px prod strip, ~135px total,
            replacing 600px of chrome. The horizontal tab strip is gone (the layout
            suppresses it on this route); the title itself is the screen picker. ── */}
        <span className={"prodstrip " + (badge.tone === "prod" ? "live" : "stg")} data-testid="prodstrip" aria-hidden />
        <div className="mhead" data-testid="mhead" ref={mheadRef}>
          {/* THE SHARED HEADER. Gameday Ops used to build its own picker row here and Chats used a
              different system entirely; this is the one component both now render, so they cannot
              drift again. The page's own controls go in `actions`. */}
          <MatchOpsMobileBar
            items={nav?.items}
            sheetTitle={nav?.title}
            showSwitch={!nav}
            leading={badge.tone === "prod" ? <span className="livedot" aria-hidden /> : null}
            actions={
              <span className="mfresh" data-testid="m-fresh">
                <span className={"mstamp" + (staleFail ? " failed" : staleMins >= 2 ? " stale" : "")} data-testid="m-updated-at">
                  {/* KEEP THE TIME and APPEND the age — "11:51 PM · 3m ago". */}
                  {staleFail ? "not refreshed" : updatedAt == null ? "…" : staleMins >= 2 ? `${updatedLabel} · ${staleMins}m ago` : updatedLabel}
                </span>
                <button type="button" className="mrefresh" data-testid="m-gday-refresh" disabled={refreshing}
                  aria-label="Refresh the board" onClick={() => void load(date, true)}>
                  <RefreshIcon size={19} spinning={refreshing} />
                </button>
              </span>
            }
          />
          <div className="mband">
            <span className="mdaynav">
              <button className="marw" data-testid="m-day-prev" aria-label="Previous day" onClick={() => goDay(addDays(date, -1))}>‹</button>
              <span className="mdaylab"><b data-testid="m-daylab">{shortDay(date)}</b>{date === today && <i>TODAY</i>}</span>
              <button className="marw" data-testid="m-day-next" aria-label="Next day" onClick={() => goDay(addDays(date, 1))}>›</button>
              <input type="date" className="daypick" data-testid="m-day-pick" aria-label="Jump to a date"
                value={date} onChange={(e) => { if (e.target.value) goDay(e.target.value); }} />
            </span>
            <button className="chip mtoday" data-testid="m-day-today" disabled={date === today} onClick={() => goDay(today)}>Today</button>
          </div>
          {/* ONE scroller: filters + cities together, the only horizontal scroll on the page. */}
          <div className="mchips" data-testid="mchips">
            <button className={"chip" + (filter === "all" ? " on" : "")} onClick={() => setFilter("all")}>All<span className="b">{counts.all}</span></button>
            <button className={"chip att" + (filter === "att" ? " on" : "")} onClick={() => setFilter("att")}>Needs attention<span className="b">{counts.att}</span></button>
            <button className={"chip" + (filter === "upc" ? " on" : "")} onClick={() => setFilter("upc")}>Still to come<span className="b">{counts.upc}</span></button>
            <span className="msep" aria-hidden />
            {/* LOCKED, NOT REMOVED — the control still says which city this is. */}
            {lockedCity ? (
              <button className="chip on" data-testid="city-locked" disabled aria-disabled="true"
                title={`Scoped to ${lockedCity}`}>{lockedCity}<span className="b">{counts.all}</span></button>
            ) : (<>
              <button className={"chip" + (cities.size === 0 ? " on" : "")} onClick={() => toggleCity("")}>All cities</button>
              {cityNames.map(([c, n]) => <button key={c} className={"chip" + (cities.has(c) ? " on" : "")} onClick={() => toggleCity(c)}>{c}<span className="b">{n}</span></button>)}
            </>)}
          </div>
        </div>
        <LogHealthBanner />
        <div className="panel head">
          <div className="r1">
            <h1>Gameday Ops</h1>
            {/* Refresh + freshness, in the space the Snapshot/Detail toggle vacated. The stamp is
                when the DATA landed; it goes muted with "· Nm ago" after 2 minutes so staleness is
                visible without being loud. NO AUTO-POLLING: this page has live edit controls and
                rows re-sort by kickoff, so a background refetch could reorder the list under a
                cursor mid-click. Manual only. */}
            <span className="fresh" data-testid="fresh">
              <button type="button" className="refresh" data-testid="gday-refresh" disabled={refreshing}
                aria-label="Refresh the board" title="Refresh the board"
                onClick={() => void load(date, true)}>
                <RefreshIcon size={14} spinning={refreshing} />
                <span className="rlab">{refreshing ? "Refreshing…" : "Refresh"}</span>
              </button>
              <span className={"stamp" + (staleFail ? " failed" : staleMins >= 2 ? " stale" : "")} data-testid="updated-at">
                {staleFail ? `Couldn't refresh · showing ${updatedLabel}`
                  : updatedAt == null ? "Loading…"
                  : staleMins >= 2 ? `Updated ${updatedLabel} · ${staleMins}m ago`
                  : `Updated ${updatedLabel}`}
              </span>
            </span>
          </div>
          <div className="chips">
            <div className="daynav">
              <button className="arw" data-testid="day-prev" aria-label="Previous day" onClick={() => goDay(addDays(date, -1))}>‹</button>
              <div className="daylab"><b data-testid="daylab">{dayLabel(date)}</b><i>{date === today ? "TODAY" : ""}</i></div>
              <button className="arw" data-testid="day-next" aria-label="Next day" onClick={() => goDay(addDays(date, 1))}>›</button>
              {/* THE PICKER DOES NO DATE ARITHMETIC AT ALL, and that is the whole design.
                  <input type="date"> yields "YYYY-MM-DD" — the exact shape `date` already holds —
                  so the value goes straight into goDay(), the same function the arrows call. There
                  is no parse, no format, no new Date(), and therefore no way for the picker and the
                  arrows to disagree about what day it is: they are the same state and the same
                  setter. A day boundary can only be wrong here if it is already wrong for ‹ ›. */}
              <input type="date" className="daypick" data-testid="day-pick" aria-label="Jump to a date"
                value={date} onChange={(e) => { if (e.target.value) goDay(e.target.value); }} />
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
              {lockedCity ? (
                <button className="chip on" data-testid="city-locked" disabled aria-disabled="true"
                  title={`Scoped to ${lockedCity}`}>{lockedCity}<span className="b">{counts.all}</span></button>
              ) : (<>
                <button className={"chip" + (cities.size === 0 ? " on" : "")} data-testid="city-all" onClick={() => toggleCity("")}>All cities</button>
                {cityNames.map(([c, n]) => <button key={c} className={"chip" + (cities.has(c) ? " on" : "")} data-testid={`city-${c}`} onClick={() => toggleCity(c)}>{c}<span className="b">{n}</span></button>)}
              </>)}
            </span>
          </div>
          <span className={"pill " + (badge.tone === "prod" ? "live" : "stg")} data-testid="gameday-env">{badge.tone === "prod" ? <><i />PRODUCTION — LIVE EDITS</> : badge.label}</span>
        </div>

        {loading ? <div className="empty" data-testid="loading">Loading {dayLabel(date)}…</div>
          : err ? <div className="empty err" data-testid="board-err">Couldn’t load the board: {err}</div>
          : !anyRows ? <div className="empty" data-testid="empty">Nothing to show for {dayLabel(date)} with these filters.</div>
          : <div className="sheet" data-testid="snapshot">
                <div className="colhead"><span /><span>KICKOFF</span><span>MATCH · FIELD</span><span>SPOTS</span><span>vs MIN</span><span>CANCEL TIME</span><span>MANAGER</span><span className="ra">PRICE</span></div>
                {grouped.map(({ G, rows }) => (
                  <section className={"grp grp-" + G.k} data-testid={`snap-group-${G.k}`} key={G.k}>
                    <h2 className="grouphd">{G.t}<span className="n">{rows.length}</span></h2>
                    <div className="rowlist">{rows.map((m) => <SnapRow key={m.id} m={m} now={now} group={G.k} selected={drawerId === m.id} onOpen={openDrawer} money={money} />)}</div>
                  </section>
                ))}
              </div>}
      </div>

      {/* NOT HIDDEN — NOT BUILT. A read-only caller sets onOpenMatch, drawerId therefore never
          leaves null, and MatchPanel is never mounted: no roster fetch, no cancel preview, no
          control that looks live. The routes behind it refuse this tier as well; this is the UI
          half of the same statement. */}
      {drawerId != null && !onOpenMatch && (
        <aside className={"gpanel" + (coexist ? " coexist" : "")} data-testid="gday-panel" style={{ ["--panel-w" as string]: `${panelW}px`, right: coexist ? DOCK_W : 0 }}>
          <div className="gpanel-bar">
            <button className="gpanel-x" data-testid="gday-panel-close" aria-label="Close panel" onClick={() => { if (guardLeave()) setDrawerId(null); }}>✕ Close</button>
            <span className="gpanel-step">
              <button data-testid="gday-prev" aria-label="Previous match" disabled={stepIdx <= 0} onClick={() => step(-1)}>‹</button>
              <button data-testid="gday-next" aria-label="Next match" disabled={stepIdx < 0 || stepIdx >= drawerSiblings.length - 1} onClick={() => step(1)}>›</button>
            </span>
          </div>
          {dockNotice && (
            <div className="gpanel-notice" data-testid="gday-dock-notice">
              Chat dock collapsed to make room — reopen it any time from the tab on the right; the thread and your draft are kept.
              <button onClick={() => setDockNotice(false)} aria-label="Dismiss">Got it</button>
            </div>
          )}
          <div className="gpanel-body">
            <MatchPanel key={drawerId} matchId={String(drawerId)} onDirtyChange={setDrawerDirty} />
          </div>
        </aside>
      )}
      {toast && <div className={"toast" + (toast.bad ? " bad" : "")} data-testid="toast">{toast.t}</div>}
      <MatchOpsSectionSheet open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </div>
  );
}

function SnapRow({ m, now, group, selected, onOpen, money }: {
  m: ApiMatch; now: number; group: MatchGroup; selected: boolean; onOpen: (id: number) => void; money: (c: number | null | undefined) => string;
}) {
  const isTodo = group === "todo", isCx = group === "cancelled", isDone = group === "finished", isInPlay = group === "inplay";
  const cap = capacity(m), real = realCount(m), fk = fakeCount(m), open = openSpots(m), total = real + fk;
  const min = Number(m.minPlayerCount ?? 0);
  const rk = riskTier(m, now), rail = snapRail(m, now), t = minsUntil(m, now);
  const f = fill(m);
  const moreFake = fk > real;
  const mgr = m.manager ? [m.manager.firstName, m.manager.lastName].filter(Boolean).join(" ").trim() || "—" : "none";
  const price = money(m.registrationPrice);
  // Countdown reads off the GROUP, not a second time threshold — §0 unified the predicate, so
  // a STILL TO COME row is always "in Xm" and only an IN PLAY row ever says "in play".
  const cd = isCx ? "was due" : isDone ? `finished ${fmtDur(t)} ago` : isInPlay ? "in play" : `in ${fmtDur(t)}`;
  // ── vs MIN (§3/§5): ONE relationship — real − min — drives the marker glyph+fill AND this
  // chip AND the printed minimum, so they are consistent by construction. over/at/short. ──
  const vm = vsMin(m), d = vsMinDelta(m); // d is signed: +over / 0 / −short
  const gapNum = vm === "over" ? `+${d}` : vm === "at" ? "0" : `−${Math.abs(d)}`; // prominent number
  const gapWord = vm === "over" ? "over" : vm === "at" ? "at min" : "short";       // one short word
  const vsMinCls = vm === "over" ? "over" : vm === "at" ? "atmin" : "short";
  const markGlyph = vm === "short" ? "!" : "✓";                 // only below-min gets the bang (§3)
  const markTitle = vm === "short" ? `${Math.abs(d)} short of the ${min} real players needed` : `Minimum ${min} real players`;
  const ac = minsToDeadline(m, now);
  // CANCEL TIME (cancel-time-v1). Kickoff is a FIXED POINT; this is a COUNTDOWN. They used to
  // share a format — both 16px tabular clocks — so a row read as two kickoffs. The cell is now a
  // DURATION over a caption, and the clock moves to the title attribute, leaving exactly ONE
  // time-shaped thing in the row. `left`/`passed` wording goes with it: the duration IS the
  // budget, and "1h 56m left / until auto-cancel" says it twice.
  const decideDur = ac <= 0 ? "passed" : fmtDur(ac);
  const leadDiffers = Number(m.autoCanceledMinutes ?? 0) !== STD_LEAD; // name the lead only if non-standard (§7e)
  // OVER THE MINIMUM = NO LIVE DEADLINE. Auto-cancel only fires below the minimum, so a match
  // that has made it has nothing counting down. On a healthy day that is most rows, and drawing a
  // countdown on all of them was most of the noise. At-min is NOT over — it is one drop from
  // short — so it keeps its countdown.
  const hasLiveDeadline = isTodo && autoCancels(m) && vm !== "over";
  // The clock, and the lead when it is not the standard one, live HERE now — hover on desktop.
  // There is no tooltip on touch, which is why mobile shows the countdown and not the clock.
  const decideTitle = `Auto-cancels at ${deadlineClock(m)} ${tzAbbr(m)}`
    + (leadDiffers ? ` · ${m.autoCanceledMinutes ?? 0} minutes before kickoff` : "");
  // Risk rail ONLY for still-to-come (green/amber/red incl. the at-min amber); in-play &
  // finished = grey (muted), cancelled = red.
  const railCls = isCx ? "cxrow" : (isDone || isInPlay) ? "donerow" : "tier-" + rail;
  return (
    <button className={"r " + railCls + (selected ? " sel" : "")} data-testid="snap-row" data-id={m.id} data-group={group}
      data-risk={isTodo ? rk : ""} data-rail={isTodo ? rail : (isCx ? "cx" : "done")} data-vsmin={isTodo ? vm : ""}
      data-real={real} data-fake={fk} data-open={open ?? ""} data-total={total} data-min={min} data-short={shortBy(m)}
      onClick={() => onOpen(m.id)} aria-label={`${m.name} at ${m.field?.title ?? ""}, ${localClock(m)} ${tzAbbr(m)}`}>
      <span className="rail" />
      <span className="cell c-time"><span className="t1">{localClock(m)}<em>{tzAbbr(m)}</em></span><span className="t2">{cd}</span></span>
      <span className="cell c-match">
        <span className="m1">{m.name}{isTodo && moreFake && <span className="flag" data-testid="more-fake">MORE FAKE</span>}</span>
        <span className="m2">{(m.field?.title ?? "—")} · {m.field?.city?.name ?? "—"}</span>
      </span>
      <span className="cell c-spots">
        {cap == null ? <span className="spotln" data-testid="snap-spots">special event · no cap</span> : <>
          {/* Bar in flow; the marker (centred on it) and the printed minimum (below it) are its
              children so the marker stays centred whatever the bar height and the label hangs
              directly under the line. Marker reads the SOLID edge only — hatch may run past it. */}
          <span className="barwrap">
            <span className="bar">
              <span className="seg1" style={{ width: `${Math.min(100, f!.realPct)}%` }} />
              {/* clamp the hatch to the track (over-redemption can push real+fake past capacity);
                  the bar is overflow:visible for the marker, so an unclamped hatch would spill. */}
              {fk > 0 && <span className="seg2" style={{ left: `${Math.min(100, f!.realPct)}%`, width: `${Math.max(0, Math.min(f!.fakePct, 100 - f!.realPct))}%` }} />}
              {isTodo && <span className="minlab" data-testid="snap-min" style={{ left: `clamp(20px, ${f!.minPct}%, calc(100% - 20px))` }}>min {min}</span>}
              {isTodo && <span className={"marker " + vsMinCls} data-testid="snap-marker" data-state={vm} style={{ left: `${f!.minPct}%` }} title={markTitle}>{markGlyph}</span>}
            </span>
            {/* §1: real · fake · TOTAL of CAP spots — four numbers, no "open", no arithmetic to do. */}
            <span className="spotln" data-testid="snap-spots"><b>{real}</b> real · <span className={"fk" + (fk === 0 ? " z" : "")}><b>{fk}</b> fake</span> · <b>{total}</b> total <span className="ofcap">of {cap} spots</span></span>
          </span>
        </>}
      </span>
      <span className="cell c-short">
        {/* §5: one prominent signed number + one short word. Cancelled keeps its solid badge;
            in-play/finished have no minimum to make, so a dash. Only still-to-come shows vs MIN. */}
        {isCx ? <span className="vsmin cxbadge" data-testid="snap-cx-badge">CANCELLED</span>
          : (isDone || isInPlay) ? <span className="vsmin none" data-testid="snap-short">—</span>
          : cap == null ? <span className="vsmin none" data-testid="snap-short">—</span>
          : <span className={"vsmin " + vsMinCls} data-testid="snap-short"><b>{gapNum}</b>{" "}<span className="w">{gapWord}</span></span>}
        {/* MOBILE ONLY — the deadline joins the shortfall here, because they are ONE THOUGHT:
            this match is two short, and in 1h 56m that becomes final. Desktop hides it (the cell
            carries it). THE CLOCK IS NOT HERE, DELIBERATELY: there is no tooltip on touch, and
            putting 6:45 back inline restores the second time-shaped thing that was the bug. */}
        {hasLiveDeadline && (
          <span className="mcnt" data-testid="snap-cxl-mcnt"><span className="w">cancels in</span> {decideDur}</span>
        )}
        {/* Auto-cancel switched off keeps its state on the phone too. Without this the card would
            be indistinguishable from an over-the-minimum one, which is a different fact. */}
        {isTodo && !autoCancels(m) && (
          <span className="mnoac" data-testid="snap-cxl-mnoac">no auto-cancel</span>
        )}
      </span>
      <span className="cell c-cxl" title={isTodo && autoCancels(m) ? decideTitle : undefined}>
        {/* NO AUTO-CANCEL => NO DECIDE-BY. The minutes field is still populated upstream on these
            matches, so drawing a countdown from it invented a deadline that can never arrive. */}
        {isTodo && !autoCancels(m) ? <>
          <span className="c1 dash" data-testid="snap-noac">—</span>
          <span className="c2" style={{ color: "#5C6B62" }}>no auto-cancel</span>
        </> : hasLiveDeadline ? <>
          {/* A duration where a time used to be, over a caption naming what it counts down to.
              No box, no border — shape does the work. */}
          <span className="cxbig" data-testid="snap-cxl-dur">{decideDur}</span>
          <span className="cxcap">until <b>auto-cancel</b></span>
        </> : (
          <span className="c1 dash" data-testid="snap-cxl-none">—</span>
        )}
        {/* THE META LINE (mobile only): who and how much. Nothing else. The deadline used to sit
            here in a run-on line with the manager and the price — four unrelated facts, one
            weight, the same dots. It now lives in the status stack with the shortfall. */}
        <span className="cxlmob" data-testid="snap-cxlmob">{mgr} · {price}</span>
      </span>
      <span className="cell c-mgr"><span className="mgr">{mgr}</span></span>
      <span className="cell c-price"><span className="price">{price}</span></span>
    </button>
  );
}

const CSS = `
.gdo{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:#0B1F17;background:#EDF2EF;min-height:100vh}
.gdo .gmain{padding:20px 24px 70px;transition:margin-right .17s ease-out}
.gdo .gmain.drawering{margin-right:var(--drawer-w,480px)}
/* the in-place match panel (replaces the old drawer). Fixed right edge; the right offset is set
   inline to the dock width when they coexist (>=1600) so the two never overlap. */
.gdo .gpanel{position:fixed;top:0;bottom:0;height:100dvh;width:var(--panel-w,600px);max-width:100vw;background:#eef2f0;border-left:1px solid #d4e0da;box-shadow:-8px 0 26px rgba(4,26,18,.12);z-index:60;display:flex;flex-direction:column}
/* SAFE AREA. The panel is position:fixed top:0, so without this the header renders beneath the iOS
   status bar and the Dynamic Island — "× Close" was drawn straight through the clock and could not
   be tapped without rotating the device. The bar is STICKY and starts BELOW the inset; the body
   scrolls under it. env() is 0 on desktop, so this changes nothing there. */
.gdo .gpanel-bar{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#04291d;color:#fff;flex:0 0 auto;
  position:sticky;top:0;z-index:2;padding-top:calc(9px + var(--sat));
  padding-left:calc(12px + var(--sal, 0px));padding-right:calc(12px + var(--sar, 0px))}
/* >=44px: this is the only way out of the panel on a phone. */
.gdo .gpanel-x{border:1px solid #2a5644;background:transparent;color:#cfe7dc;border-radius:8px;padding:7px 13px;
  min-height:44px;min-width:44px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.gdo .gpanel-x:hover{background:#14432f;color:#fff}
.gdo .gpanel-step{margin-left:auto;display:inline-flex;gap:5px}
.gdo .gpanel-step button{border:1px solid #2a5644;background:transparent;color:#cfe7dc;border-radius:8px;min-width:36px;min-height:34px;font:inherit;font-size:17px;cursor:pointer}
.gdo .gpanel-step button:disabled{opacity:.4;cursor:not-allowed}
.gdo .gpanel-notice{display:flex;align-items:center;gap:10px;background:#fdf2e0;border-bottom:1px solid #e8c383;color:#6b4400;font-size:12px;line-height:1.4;padding:9px 12px;flex:0 0 auto}
.gdo .gpanel-notice button{margin-left:auto;border:1px solid #e8c383;background:#fff;border-radius:6px;padding:4px 10px;font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap}
/* THE DRAWER NO LONGER SCROLLS — THE PANEL INSIDE IT DOES, and that is the whole of the save-bar
   fix. This was overflow-y:auto, so MatchPanel sat inside it as ordinary content: .mp-panel's own
   display:flex + overflow:hidden never received a bounded height, it grew to its content, and
   .mp-foot scrolled away with it — measured at top:2782px in a 950px viewport on desktop and
   top:4112px in 780px on a phone. Master Schedule never had the problem because MatchDrawer mounts
   MatchEditor as a direct flex child and the EDITOR owns its scroll. This makes the Gameday drawer
   do the same thing.
   The bottom padding moves to .mp-foot, which is now the element actually touching the bottom. */
.gdo .gpanel-body{flex:1;min-height:0;overflow:hidden;padding:12px;display:flex;flex-direction:column}
/* Only in the drawer. The standalone /match-ops/match-panel/[id] page is a document that scrolls
   with the window, and giving it a viewport height there would trap it in a box. */
.gdo .gpanel-body>.mp{min-height:0;flex:1 1 auto;display:flex}
.gdo .gpanel-body>.mp>.mp-panel{height:100%}
/* THE FIELDSET IS THE FLEX CHILD, not .mp-body. .mp-body lives inside <fieldset class="mp-fs">,
   which wraps the whole form so a read-only viewer gets a genuinely disabled control set rather
   than one that only looks disabled. Without this the fieldset takes its content height, .mp-body
   never shrinks (measured 2626px inside an 864px panel) and the foot is pushed off the bottom —
   which is what the first attempt at this fix missed. */
.gdo .gpanel-body>.mp>.mp-panel>.mp-fs{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.gdo .gpanel-body>.mp>.mp-panel>.mp-fs>.mp-body{flex:1 1 auto;min-height:0}
.gdo .panel{background:#fff;border:1px solid #DCE5E0;border-radius:14px}
.gdo .head{padding:18px 20px 16px;margin-bottom:14px;position:relative}
.gdo .r1{display:flex;align-items:baseline;gap:12px}.gdo h1{margin:0;font-size:23px;letter-spacing:-.2px}
/* The lede and the duplicate date beside the title were removed (cosmetic pass): the chips row
   now supplies the gap the paragraph used to, so the header closes up instead of leaving a hole. */
.gdo .chips{margin-top:12px}
.gdo .chips{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.gdo .daynav{display:flex;align-items:center;gap:8px;margin-right:4px}
.gdo .arw{width:34px;height:34px;border-radius:8px;border:1px solid #DCE5E0;background:#fff;color:#20372C;line-height:1;font-size:16px}
/* The match drawer's WHEN > DATE field, in this page's palette — same 1px border, same radius,
   same white ground, sized to sit level with .arw rather than towering over it. Native picker;
   nothing custom is drawn. */
.gdo .daypick{height:34px;border:1px solid #DCE5E0;border-radius:8px;background:#fff;color:#20372C;
  font:inherit;font-size:13.5px;padding:0 10px;min-width:0}
.gdo .daypick:focus{outline:2px solid #4FE07E;outline-offset:-1px}
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
.gdo .rows{display:flex;flex-direction:column;gap:8px}
.gdo .row{display:block;width:100%;text-align:left;color:inherit;background:#fff;border:1px solid #DCE5E0;border-radius:12px;padding:11px 13px 10px;cursor:pointer}
.gdo .row:hover{border-color:#9FC4B2;box-shadow:0 2px 8px rgba(0,42,28,.08)}
.gdo .row:focus-visible{outline:2px solid #046B45;outline-offset:2px}
.gdo .row.sel{box-shadow:0 0 0 3px #2CDB87,0 6px 18px rgba(0,42,28,.18)}
.gdo .row.done{opacity:.66;background:#FAFBFA;box-shadow:inset 4px 0 0 #C3CCC7}
.gdo .row.warn{background:#FEF9EF;border-color:#E3C88A}
.gdo .row.crit{background:#FDF1EE;border-color:#E9B6AC;box-shadow:inset 3px 0 0 #A83120}
/* CANCELLED — unmissable: red left rail + red-tinted bg, NOT dimmed. */
.gdo .row.cx{background:#FBE4E0;border-color:#E9A79F;box-shadow:inset 4px 0 0 #A83120}.gdo .row.cx .nm{text-decoration:line-through;text-decoration-color:#C98B83}
.gdo .hdr{display:grid;grid-template-columns:118px minmax(0,1fr) auto auto 18px;gap:12px;align-items:center}
.gdo .hdr>*{min-width:0}
.gdo .when b{font-size:15.5px;font-weight:700;letter-spacing:-.2px;font-variant-numeric:tabular-nums}
.gdo .when .tz{font-size:10px;font-weight:800;letter-spacing:.07em;color:#5C6B62;margin:0 4px}
.gdo .when .cd{font-size:12px;color:#5C6B62;font-variant-numeric:tabular-nums;display:block}
.gdo .when .cd.soon{color:#A83120;font-weight:700}.gdo .when .cd.live{color:#046B45;font-weight:700}
.gdo .ttl .nm{font-weight:700;font-size:16px;letter-spacing:-.15px}
.gdo .cxb{font-size:10px;font-weight:800;letter-spacing:.06em;background:#A83120;color:#fff;border:1px solid #A83120;border-radius:5px;padding:2px 7px;margin-left:7px}
.gdo .minlab .tag.cxtag{background:#A83120;color:#fff;border:1px solid #A83120}
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
/* DECIDE BY on the card (21b item 3): absolute clock leads, then "N left"/"passed". */
.gdo .ac .clk{display:block;font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.1px}
.gdo .ac .clk em{font-style:normal;font-size:10px;font-weight:800;color:#5C6B62;letter-spacing:.06em;margin-left:3px}
.gdo .ac .line{display:block;font-size:12.5px;font-variant-numeric:tabular-nums;margin-top:1px}.gdo .ac .line b{font-weight:700}.gdo .ac .line.dash{color:#5C6B62}
.gdo .ac .line .lead{color:#5C6B62;font-weight:400}
.gdo .ac .cnt{display:block;font-size:12px;color:#5C6B62;font-variant-numeric:tabular-nums;margin-top:2px}
.gdo .ac.ok .cnt{color:#046B45;font-weight:600}
.gdo .ac.ok .line b{color:#5C6B62;font-weight:600}
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

/* ── header: refresh + freshness ──────────────────────────────────────────────
   The old "now HH:MM" span sat in .r1 and collided with the absolutely-positioned
   PRODUCTION — LIVE EDITS pill, which covered half of it at 1600. The block now sits at the row
   end with right padding reserved for the pill, so the two can never share pixels. */
.gdo .head .r1{position:relative;padding-right:220px}
.gdo .fresh{margin-left:auto;display:inline-flex;align-items:center;gap:8px}
.gdo .refresh{display:inline-flex;align-items:center;gap:6px;min-height:32px;border:1px solid #D8E2DC;
  border-radius:9px;background:#fff;color:#20402F;font:inherit;font-size:12px;font-weight:700;padding:0 10px;
  cursor:pointer}
.gdo .refresh:disabled{opacity:.6;cursor:default}
/* the spinner replaces the glyph IN PLACE — a fixed 12px box, so nothing shifts while it spins */
@keyframes gdspin{to{transform:rotate(360deg)}}
.gdo .stamp{font-size:12px;color:#3D5349;white-space:nowrap}
.gdo .stamp.stale{color:#7C8A83}
.gdo .stamp.failed{color:#A8391A;font-weight:600}
@media(prefers-reduced-motion:reduce){.gdo .rspin.on{animation:none}}

/* ── Snapshot view: one line per match, whole day on one screen ── */
.gdo .seg{display:inline-flex;background:#E4EAE7;border-radius:10px;padding:3px;gap:3px;margin-left:auto}
.gdo .seg button{border:0;background:transparent;border-radius:8px;padding:7px 15px;min-height:34px;font-size:13px;font-weight:700;color:#5C6B62;cursor:pointer;white-space:nowrap}
.gdo .seg button.on{background:#fff;color:#0B1F17;box-shadow:0 1px 2px rgba(0,0,0,.10)}
.gdo .legend{display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin:0 2px 10px;color:#5C6B62;font-size:12px}
.gdo .legend .lg{display:inline-flex;align-items:center;gap:6px}
.gdo .legend .sw{width:11px;height:11px;border-radius:3px;display:inline-block;flex:0 0 11px}
.gdo .legend .sw.red{background:#A83120}.gdo .legend .sw.amb{background:#B8860B}.gdo .legend .sw.grn{background:#046B45}
/* the decide-by mechanism, stated ONCE (§7e) instead of on every row */
.gdo .legend .legnote{flex-basis:100%;margin-top:2px;color:#3D5349;font-size:11.5px}
.gdo .chip.sm{padding:5px 11px;font-size:12px;min-height:30px}.gdo .chip.sm.on{background:#003326;border-color:#003326;color:#fff}
.gdo .sheet{background:#fff;border:1px solid #DCE5E0;border-radius:14px;overflow:hidden}
.gdo .colhead,.gdo .sheet .r{display:grid;align-items:center;gap:12px;grid-template-columns:5px 108px minmax(150px,1fr) minmax(232px,1.6fr) 94px 122px 78px 56px}
.gdo .colhead{padding:9px 14px 9px 0;border-bottom:1px solid #DCE5E0;background:#FAFCFB;font-size:10px;font-weight:800;letter-spacing:.11em;color:#536258}
.gdo .colhead .ra{text-align:right}
/* Rows grow to ~76px to carry the marker + printed minimum under the bar (§2). A firm
   min-height keeps EVERY row (todo, in-play, cancelled, finished, special-event) the same
   height within a pixel — the marker content fits inside it, so nothing overflows past ~76px. */
.gdo .sheet .r{padding:0 14px 0 0;border:0;border-bottom:1px solid #DCE5E0;background:#fff;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer;min-height:76px}
.gdo .sheet .r:last-child{border-bottom:0}.gdo .sheet .r:hover{background:#F7FBF9}
.gdo .sheet .r:focus-visible{outline:2px solid #046B45;outline-offset:-2px}
.gdo .sheet .r.sel{background:#EAF9F1}
.gdo .sheet .rail{align-self:stretch;display:block;background:#CCD7D1}
/* Three distinct rail colours (§6): green over-min, amber at-line/short-far, red short-and-
   imminent. The at-min tier joins amber (snapRail), so exactly-on-the-line never reads green. */
.gdo .sheet .r.tier-red .rail{background:#A83120}.gdo .sheet .r.tier-amber .rail{background:#B8860B}.gdo .sheet .r.tier-green .rail{background:#046B45}
.gdo .sheet .r.tier-red{background:#FDEEEB}.gdo .sheet .r.tier-red:hover{background:#FBE2DF}
/* snapshot CANCELLED — red rail + red bg, struck name; FINISHED — grey rail, muted. */
.gdo .sheet .r.cxrow .rail{background:#A83120}.gdo .sheet .r.cxrow{background:#FBE4E0}.gdo .sheet .r.cxrow:hover{background:#F7D6D0}.gdo .sheet .r.cxrow .m1{text-decoration:line-through;text-decoration-color:#C98B83}
.gdo .sheet .r.donerow .rail{background:#C3CCC7}.gdo .sheet .r.donerow{opacity:.66}
.gdo .sheet .c1.dash{color:#536258;font-weight:600}
.gdo .grouphd{margin:0 0 9px 3px;font-size:12px;letter-spacing:.11em;color:#55635B;font-weight:700;display:flex;align-items:center;gap:8px}
.gdo .grouphd .n{color:#4E5A54;letter-spacing:0;font-weight:600;font-size:12.5px}
.gdo .sheet .grp{margin-top:18px}.gdo .sheet .grp:first-of-type{margin-top:8px}
.gdo .sheet .cell{display:block;padding:9px 0;min-width:0}
.gdo .sheet .t1{display:block;font-weight:700;font-variant-numeric:tabular-nums}.gdo .sheet .t1 em{font-style:normal;font-size:10px;font-weight:800;color:#536258;letter-spacing:.06em;margin-left:4px}
.gdo .sheet .t2{display:block;font-size:12px;color:#536258;font-variant-numeric:tabular-nums}
.gdo .sheet .m1{display:block;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdo .sheet .m2{display:block;font-size:12px;color:#536258;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdo .sheet .flag{display:inline-block;margin-left:6px;vertical-align:1px;background:#FBF0DC;color:#7A5200;border:1px solid #E3C88A;font-size:9.5px;font-weight:800;letter-spacing:.05em;padding:1px 5px;border-radius:4px;white-space:nowrap}
/* ── the bar + the minimum MARKER + the printed minimum (§2/§3/§4) ──
   Bar in normal flow; the marker (centred on it) and the "min N" label (hanging just below)
   are its children, and the counts sit under the bar with a fixed gap. overflow:visible so the
   17px marker isn't clipped by the 10px bar. */
.gdo .sheet .barwrap{display:block;position:relative;padding:2px 0 0}
.gdo .sheet .bar{display:block;position:relative;height:10px;border-radius:6px;background:#E7EEEA;overflow:visible}
.gdo .sheet .seg1,.gdo .sheet .seg2{position:absolute;top:0;bottom:0;display:block;border-radius:6px}
.gdo .sheet .seg1{left:0;background:#046B45;z-index:2}
.gdo .sheet .seg2{background:repeating-linear-gradient(135deg,#E5A83A 0 4px,#F3CD8E 4px 8px);z-index:1}
/* the ~17px marker, centred on the minimum. GLYPH + FILL both change with state, never colour
   alone (§3): solid green ✓ over-min; hollow white/amber ✓ AT the line; solid amber ! below.
   Driven only by (real − min) — the hatch may run past it and must not change it (§4). */
.gdo .sheet .marker{position:absolute;top:50%;transform:translate(-50%,-50%);z-index:4;width:17px;height:17px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;line-height:1;border:1.5px solid;box-sizing:border-box}
.gdo .sheet .marker.over{background:#046B45;border-color:#0E5433;color:#fff}
.gdo .sheet .marker.atmin{background:#fff;border-color:#8a5600;color:#8a5600}
.gdo .sheet .marker.short{background:#8a5600;border-color:#6D4400;color:#fff;font-size:12px}
/* the printed minimum, hanging under the marker, clamped to stay inside the bar (§2/§11).
   #4a6157, not the standard muted grey (4.44:1 was just under 4.5 on the row bg). */
.gdo .sheet .minlab{position:absolute;top:100%;margin-top:4px;transform:translateX(-50%);z-index:3;font-size:10px;font-weight:700;color:#4a6157;white-space:nowrap;font-variant-numeric:tabular-nums;letter-spacing:.02em}
/* ── counts line: four numbers, no "open", nothing to subtract (§1). zero fakes render muted. ── */
.gdo .sheet .spotln{display:block;margin-top:20px;font-size:12px;color:#3D5349;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdo .sheet .spotln b{color:#0B1F17;font-weight:800}
.gdo .sheet .spotln .fk b{color:#7A5200}.gdo .sheet .spotln .fk.z b{color:#4a6157;font-weight:700}
.gdo .sheet .spotln .ofcap{color:#4a6157;font-weight:600;margin-left:3px}
/* ── vs MIN chip (§5): a PROMINENT signed number + one small word, ALL chips the same height. ── */
.gdo .sheet .c-short{display:flex;align-items:center}
.gdo .sheet .vsmin{display:inline-flex;align-items:baseline;gap:5px;height:24px;padding:0 9px;border-radius:8px;font-variant-numeric:tabular-nums;white-space:nowrap;box-sizing:border-box;border:1px solid}
.gdo .sheet .vsmin b{font-size:13px;font-weight:800;line-height:24px}
.gdo .sheet .vsmin .w{font-size:10px;font-weight:700;letter-spacing:.03em}
.gdo .sheet .vsmin.over{background:#E6F4EC;color:#046B45;border-color:#9FD3B6}
.gdo .sheet .vsmin.atmin{background:#FBF0DC;color:#7A5200;border-color:#E3C88A}
.gdo .sheet .vsmin.short{background:#FDEEEB;color:#A83120;border-color:#F0A9A4}
.gdo .sheet .vsmin.none{border-color:transparent;background:transparent;color:#536258;padding:0}
.gdo .sheet .vsmin.cxbadge{border-color:#A83120;background:#A83120;color:#fff;padding:0 9px;font-weight:800;letter-spacing:.05em;align-items:center}
/* ── CANCEL TIME (cancel-time-v1) ───────────────────────────────────────────
   A DURATION, then what it is a countdown to. 15px against kickoff's inherited
   16px: strictly smaller, so the two stop reading as the same kind of fact. The
   clock is in the cell's title attribute, not in the cell. */
.gdo .sheet .cxbig{display:block;font-size:15px;font-weight:800;color:#8A5A00;font-variant-numeric:tabular-nums;line-height:1.05}
.gdo .sheet .cxcap{display:block;font-size:11.5px;color:#536258;margin-top:1px;line-height:1.3}
.gdo .sheet .cxcap b{color:#8A5A00;font-weight:700}
/* mobile-only members of the status stack */
.gdo .sheet .mcnt,.gdo .sheet .mnoac{display:none}
/* .c2 still styles the "no auto-cancel" caption, the one remaining user of this cell's sub
   line. The shortfall-tinted variants (.cleared/.atmin/.short/.short.hot) and .c1.clk went with
   the clock they coloured — prominence now comes from the countdown's own weight, not from
   re-stating the shortfall a third time in the same row. */
.gdo .sheet .c2{display:block;font-size:11.5px;margin-top:1px;color:#536258;line-height:1.35}
.gdo .sheet .mgr{display:block;font-size:13px;color:#3D5349;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdo .sheet .price{display:block;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
.gdo .sheet .cxlmob{display:none}
/* cancelled time slot reads "was due" (red), never blank — both views. */
.gdo .sheet .r.cxrow .t2{color:#A83120;font-weight:700}

/* ── PHONE header + prod strip: built here, hidden on desktop (the .head card and
      the legend own the ≥760px layout). Kept out of the media block so the desktop
      default is unambiguously "not shown". ── */
.gdo .mfresh{margin-left:auto;display:inline-flex;align-items:center;gap:7px}
.gdo .mstamp{font-size:11.5px;color:#41514A;font-variant-numeric:tabular-nums;white-space:nowrap}
.gdo .mstamp.stale{color:#5C6B62}  /* muted vs #41514A, but still >=4.5:1 on the bar */
.gdo .mstamp.failed{color:#A8391A;font-weight:700}
.gdo .mrefresh{width:44px;height:44px;flex:none;display:inline-flex;align-items:center;justify-content:center;
  border:1px solid #D3DED8;border-radius:11px;background:#EEF3F0;color:#20402F;cursor:pointer}
.gdo .ricon{display:block;transform-origin:50% 50%}
.gdo .ricon.on{animation:gdspin .8s linear infinite}
.gdo .mrefresh:disabled{opacity:.6;cursor:default}
.gdo .prodstrip,.gdo .mhead{display:none}

/* ── Phone: this is used one-handed at a field. Edge to edge, cities scroll. ── */
@media (max-width: 759px){
  /* desktop chrome off; phone chrome on */
  .gdo .head{display:none}
  .gdo .legend{display:none}                      /* sort moved into the header band */
  .gdo .prodstrip{display:block;position:sticky;top:0;z-index:40;height:3px}
  .gdo .prodstrip.live{background:#C0201B}.gdo .prodstrip.stg{background:#F2E31D}
  /* Break out of the app shell's horizontal padding (max-w px-8) so the board is
     truly edge to edge — full viewport width regardless of the parent's inset. */
  .gdo{width:100vw;margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw)}
  .gdo .gmain{padding:0 0 90px;margin-right:0 !important}
  .gdo .gmain.drawering{margin-right:0}
  .gdo .gpanel{width:100vw;right:0 !important}

  /* three 44px bands under the strip */
  .gdo .mhead{display:block;position:sticky;top:3px;z-index:30;background:#F6F9F7;border-bottom:1px solid #D3DED8}
  .gdo .mband{display:flex;align-items:center;gap:10px;padding:0 12px;min-height:44px}
  .gdo .mband + .mband{border-top:1px solid #E9EFEB}
  .gdo .mpick{display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:4px 2px;color:#0B1F17;cursor:pointer;min-height:36px;font-size:17px;font-weight:700;letter-spacing:-.02em}
  .gdo .mpick .livedot{width:7px;height:7px;border-radius:50%;background:#C0201B;flex:0 0 auto}
  .gdo .mpick .caret{font-size:11px;color:#5C7168}
  .gdo .mseg{margin-left:auto;flex:0 0 auto}
  .gdo .mseg button{padding:0 11px;min-height:32px;font-size:12.5px}
  .gdo .mdaynav{display:flex;align-items:center;gap:4px;min-width:0}
  .gdo .marw{width:32px;height:32px;border:1px solid #D3DED8;background:#fff;border-radius:8px;color:#3D5349;font-size:15px;line-height:1;flex:0 0 auto}
  .gdo .marw:active{background:#EEF4F1}
  .gdo .mdaylab{display:flex;align-items:baseline;gap:6px;font-weight:700;font-size:14px;padding:0 4px;white-space:nowrap}
  .gdo .mdaylab i{font-style:normal;font-size:9.5px;font-weight:800;letter-spacing:.1em;color:#046B45}
  .gdo .mtoday{margin-left:auto;flex:0 0 auto;min-height:34px;padding:0 14px;font-size:12.5px}
  .gdo .mtoday:disabled{opacity:.45}
  .gdo .mchips{display:flex;align-items:center;gap:7px;overflow-x:auto;padding:6px 12px;min-height:44px;scrollbar-width:none;-webkit-overflow-scrolling:touch;background:#F6F9F7}
  .gdo .mchips::-webkit-scrollbar{display:none}
  .gdo .mchips .chip{flex:0 0 auto;min-height:32px;padding:0 12px;display:inline-flex;align-items:center;font-size:12.5px}
  .gdo .mchips .msep{flex:0 0 auto;width:1px;align-self:stretch;background:#D3DED8;margin:6px 3px}

  /* the day's list, edge to edge — no cards, no side margins, no radius */
  .gdo .sheet{border:0;border-radius:0;background:transparent}
  .gdo .sheet{overflow:visible}
  /* group subheads: full-bleed, sticky UNDER the header */
  .gdo .sheet .grp,.gdo .sheet .grp:first-of-type,.gdo .band{margin:0}
  .gdo .grouphd{position:sticky;top:var(--gd-hdrh,135px);z-index:20;margin:0;display:flex;align-items:baseline;gap:8px;
    padding:6px 12px;background:#EEF3F0;border-top:1px solid #D3DED8;border-bottom:1px solid #D3DED8;
    font-size:10.5px;letter-spacing:.12em;color:#3D5349}
  .gdo .grouphd .n{margin-left:auto;color:#5C7168;letter-spacing:.04em}
  .gdo .rows{gap:0}
  .gdo .row{border-radius:0;border-left:0;border-right:0;border-top:0;border-bottom:1px solid #DCE5E0;padding:12px 12px 11px}
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
  /* ── SNAPSHOT rows: four-line stack, full-bleed, names WRAP (never truncated). ── */
  .gdo .colhead{display:none}
  .gdo .sheet .r{grid-template-columns:5px 1fr auto;grid-template-areas:"rail time short" "rail match short" "rail spots spots" "rail cxl cxl";gap:0 11px;padding:0 12px 0 0;min-height:0}
  .gdo .sheet .rail{grid-area:rail}
  .gdo .sheet .c-time{grid-area:time;padding:8px 0 0}
  .gdo .sheet .c-match{grid-area:match;padding:0}
  .gdo .sheet .c-spots{grid-area:spots;padding:7px 0 0}
  /* THE STATUS STACK — the shortfall pill and its deadline, top right, where the eye
     already goes. Column so the countdown sits directly under the pill. */
  .gdo .sheet .c-short{grid-area:short;padding:8px 0 0;align-self:start;display:flex;flex-direction:column;align-items:flex-end;gap:5px}
  .gdo .sheet .mcnt{display:block;font-size:13px;font-weight:800;color:#8A5A00;white-space:nowrap;font-variant-numeric:tabular-nums}
  /* The mockup mutes "cancels in" with a lighter amber (#A8813A). Measured on the real card
     backgrounds that is 3.17–3.58:1 — below 4.5. WEIGHT carries the hierarchy instead, at the
     same accessible amber as the duration. */
  .gdo .sheet .mcnt .w{font-weight:600;color:#8A5A00}
  .gdo .sheet .mnoac{display:block;font-size:12px;font-weight:700;color:#5C6B62;white-space:nowrap}
  .gdo .sheet .c-cxl{grid-area:cxl;padding:4px 0 9px}
  .gdo .sheet .c-mgr,.gdo .sheet .c-price{display:none}
  /* The desktop cell's contents are ALL hidden on the phone — the duration and its caption
     included. Missing them here put "cancels in 7m" in the stack AND "7m until auto-cancel" in
     the cell: two countdowns on one card, which is the bug in a new costume. */
  .gdo .sheet .c-cxl .c1,.gdo .sheet .c-cxl .c2,.gdo .sheet .c-cxl .cxbig,.gdo .sheet .c-cxl .cxcap{display:none}
  .gdo .sheet .cxlmob{display:block;font-size:12px;color:#536258;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gdo .sheet .m1{white-space:normal;overflow:visible;text-overflow:clip}   /* match name never truncates */
  .gdo .sheet .t1{display:inline}.gdo .sheet .t2{display:inline;margin-left:8px}
}
`;
