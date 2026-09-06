"use client";

/* VEO — one day of camera matches, and what happened to each one's film.
 *
 * THE PAGE HOLDS ONLY THE MATCHES A CAMERA WAS ON. Ryan: "only a few matches per day so dont need
 * to show all the matches just the ones the veo will relate to for the day." A row exists because
 * some veo_codes row names the match's field; that selection happens in /api/veo/day, and the
 * consequence is that a missing film shows up as a gap between the posted count and the total
 * rather than by hunting through matches that were never going to be filmed.
 *
 * THE TALLY IS THE FILTER, and its five counts partition the day exactly — see src/lib/veoDay.ts
 * for why that identity is a pure function and an assertion rather than an arithmetic hope.
 *
 * THE SCORE TRACE IS READ, NEVER RECOMPUTED. It comes off score_parts on the row. A trace derived
 * a second time can disagree with the number beside it, and the hand-written one was out by 32.
 *
 * THERE IS NO IFRAME. Measured 2026-09-05, verbatim: app.veo.co answers x-frame-options: DENY and
 * frame-ancestors https://stage.controlcentre.ai.io https://controlcentre.ai.io app.veo.co
 * https://www.veo.com. Clubhouse is on neither list, so an embed cannot work whatever the markup
 * says. The panel keeps its shape and the film area holds the REAL still frame — the recording
 * page publishes one as og:image — with an Open in Veo button under it. A dark rectangle with a
 * play glyph would have been the empty black box the brief forbids.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import MatchSidePanel, { MATCH_SIDE_PANEL_CSS, type PanelTab } from "@/components/MatchSidePanel";
import {
  FILM_STATES, FILM_STATE_LABEL, emptyTally, gapLabel, scoreTrace, tallyAddsUp,
  type AssignCandidate, type FilmState, type VeoDayRecording, type VeoDayRow, type VeoDayTally,
} from "@/lib/veoDay";
import {
  ARRIVAL_ZONE, RECENT_STATE_LABEL, RECENT_STATE_TONE, WAIT_ALARM_DAYS, daySourceOf, isResolved, lagDays,
  lagLabel, lagWorthSaying, waitDays, waitLabel, type RecentState,
} from "@/lib/veoRecent";

type Payload = {
  date: string;
  rows: VeoDayRow[];
  tally: VeoDayTally;
  unplaced: VeoDayRecording[];
  strays: Record<number, { apiId: number; name: string; fieldId: number | null; date: string | null }>;
  candidates: Record<number, AssignCandidate>;
  codedFields: number[];
  cities: string[];
  emojiWithoutCode: number;
  confinedCity: string | null;
};

async function authFetch(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }, cache: "no-store" });
}

/* CALENDAR ARITHMETIC ON THE STRING, NEVER THROUGH A Date. A day view that steps with
 * setDate()/getDate() drifts across a DST boundary and lands on the same day twice. */
const days = (y: number, m: number, d: number) => {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};
const fromDays = (z: number) => {
  let zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  zz = 0;
  return { y: m <= 2 ? y + 1 : y, m, d };
};
const shiftDate = (iso: string, delta: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  const p = fromDays(days(y, m, d) + delta);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
};
const todayIso = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};
const longDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });
};

const STATE_TONE: Record<FilmState, string> = {
  posted: "ok", flagged: "flag", assigned: "hand", held: "hold", needs_look: "look", no_film: "none",
};
const TALLY_LABEL: Record<FilmState, string> = {
  posted: "posted itself",
  flagged: "posted, flagged",
  assigned: "assigned by hand",
  held: "held on purpose",
  needs_look: "needs a look",
  no_film: "no film yet",
};

export default function VeoDayOps() {
  /* YESTERDAY, NOT TODAY. Veo processes overnight, so today's films do not exist yet and a page
   * defaulting to today would open empty every morning. ?date= overrides it, so a particular day
   * can be sent to somebody — read off window.location rather than useSearchParams, which would
   * opt the whole route into client-side rendering for one string. */
  const [date, setDate] = useState(() => {
    if (typeof window === "undefined") return shiftDate(todayIso(), -1);
    const q = new URLSearchParams(window.location.search).get("date");
    return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : shiftDate(todayIso(), -1);
  });
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilmState | null>(null);
  const [city, setCity] = useState<string>("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [assignId, setAssignId] = useState<string | null>(null);
  /* THE MATCH CHAT, in the panel Gameday Ops already built. Ryan: "there should be a button match
   * chat to that match so you can see the thread where its posted in side editor like gameday ops
   * does and check in on the chat where the link got posted." It opens on CHAT, because on a posted
   * row the chat is the question, not the match's details. */
  const [panelMatch, setPanelMatch] = useState<number | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("chat");

  const load = useCallback(async (d: string) => {
    setLoading(true); setErr(null);
    try {
      const res = await authFetch(`/api/veo/day?date=${d}`);
      const j = await res.json();
      if (!res.ok) { setErr(j?.error || `Load failed (${res.status})`); setData(null); return; }
      setData(j as Payload);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e)); setData(null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(date); setOpenId(null); setAssignId(null); }, [date, load]);

  // Keep the address bar on the day being shown, without a navigation — the dock and every other
  // Match Ops surface survive because this route never remounts, and a router.push would remount.
  useEffect(() => {
    const u = new URL(window.location.href);
    if (u.searchParams.get("date") === date) return;
    u.searchParams.set("date", date);
    window.history.replaceState(null, "", u.toString());
  }, [date]);

  /* THE CITY FILTER NARROWS THE LIST AND THE TALLY TOGETHER. They are derived from ONE array, so
   * they cannot disagree — a tally computed over the day while the list showed one city is the
   * failure this shape removes. */
  const cityRows = useMemo(
    () => (data?.rows ?? []).filter((r) => city === "all" || r.city === city),
    [data, city],
  );
  const shownTally = useMemo<VeoDayTally>(() => {
    const t = emptyTally(cityRows.length);
    for (const r of cityRows) t[r.state] += 1;
    return t;
  }, [cityRows]);
  const rows = useMemo(
    () => cityRows.filter((r) => filter === null || r.state === filter),
    [cityRows, filter],
  );

  const isToday = date === todayIso();

  return (
    <div className="veo">
      <style>{CSS}</style>

      <div className="head">
        <div>
          <h1 className="h1">Veo</h1>
          <p className="hsub">One day at a time, holding only the matches a camera was on.</p>
        </div>
        <div className="nav">
          <button className="nb" data-testid="veo-prev" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">‹</button>
          <div className="dt">
            <b data-testid="veo-date">{longDate(date)}</b>
            <span>{date === shiftDate(todayIso(), -1) ? "yesterday" : isToday ? "today" : date}</span>
          </div>
          <button className="nb" data-testid="veo-next" onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day">›</button>
          <button className="nb wide" onClick={() => setDate(todayIso())}>Today</button>
          {data && data.cities.length > 1 && (
            <select className="sel" data-testid="veo-city" value={city} onChange={(e) => { setCity(e.target.value); setOpenId(null); }}>
              <option value="all">All cities</option>
              {data.cities.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {data?.confinedCity && <span className="conf" data-testid="veo-confined">{data.confinedCity} only</span>}
          <button className="nb" onClick={() => void load(date)}>Refresh</button>
        </div>
      </div>

      {/* THE TALLY IS THE FILTER. Clicking a count narrows the list to it; clicking it again clears. */}
      <div className="tally" data-testid="veo-tally">
        {FILM_STATES.map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`veo-tal-${s}`}
            data-count={shownTally[s]}
            className={`tal ${STATE_TONE[s]}${filter === s ? " on" : ""}`}
            onClick={() => { setFilter(filter === s ? null : s); setOpenId(null); }}
          >
            <b>{shownTally[s]}</b>
            <span>{TALLY_LABEL[s]}</span>
          </button>
        ))}
        <div className="tal total" data-testid="veo-tal-total" data-count={shownTally.total}>
          <b>{shownTally.total}</b>
          <span>on camera that day</span>
        </div>
      </div>

      {/* The identity the strip depends on, stated on screen rather than assumed. It is asserted in
          scripts/veo-day-test.ts; this is the operator-visible half. */}
      {data && !tallyAddsUp(shownTally) && (
        <p className="warn" data-testid="veo-tally-broken">
          The five states do not add to the total — this page is miscounting and should not be trusted.
        </p>
      )}

      {loading && <p className="empty">Loading…</p>}
      {err && <p className="warn" data-testid="veo-error">{err}</p>}

      {!loading && !err && rows.length === 0 && (
        <p className="empty" data-testid="veo-empty">
          {shownTally.total === 0
            ? "No camera matches on this day."
            : `No matches in "${FILM_STATE_LABEL[filter as FilmState]}" — clear the filter to see the other ${shownTally.total}.`}
        </p>
      )}

      <div className="rows">
        {rows.map((r) => (
          <Row key={r.apiId} r={r} data={data!} open={openId === r.apiId}
            onToggle={() => setOpenId(openId === r.apiId ? null : r.apiId)}
            onDone={() => { setOpenId(null); void load(date); }}
            onOpenChat={(apiId) => { setPanelTab("chat"); setPanelMatch(apiId); }} />
        ))}
      </div>

      {/* Recordings that name this day and no match on it. They belong to the day — this is the
          review queue's content — but they cannot be a row against a match, and inventing one
          would break the tally above. */}
      {/* THE ORPHAN STRIP, WHICH NOW HAS SOMEWHERE TO GO. It offered Open in Veo and nothing else —
          a link that opens the film in another tab and leaves the recording exactly as unassigned
          as it was. No matcher is ever good enough to have no queue, so the queue needs an exit. */}
      {data && data.unplaced.length > 0 && (
        <div className="unplaced" data-testid="veo-unplaced">
          <h3>{data.unplaced.length} recording{data.unplaced.length === 1 ? "" : "s"} for this day with no row above</h3>
          {data.unplaced.map((u) => (
            <Orphan
              key={u.id}
              u={u}
              data={data}
              open={assignId === u.id}
              onToggle={() => setAssignId(assignId === u.id ? null : u.id)}
              onDone={() => { setAssignId(null); void load(date); }}
            />
          ))}
        </div>
      )}

      {data && data.emojiWithoutCode > 0 && (
        <p className="foot" data-testid="veo-emoji-gap">
          {data.emojiWithoutCode} match{data.emojiWithoutCode === 1 ? "" : "es"} on this day carr{data.emojiWithoutCode === 1 ? "ies" : "y"} the
          camera emoji in the name but sit{data.emojiWithoutCode === 1 ? "s" : ""} on a field no <code>veo_codes</code> row names, so no recording can
          arrive for {data.emojiWithoutCode === 1 ? "it" : "them"}. They are not listed above — the code table decides this page, not the emoji.
        </p>
      )}

      {/* THE SECOND AXIS. Everything above is indexed by the day a match was PLAYED; this is the
          same recordings ordered by when the FILM ARRIVED. It is day-independent on purpose — it
          does not refetch when the day nav moves, because a film that landed today for last Tuesday
          is exactly what you cannot find by walking the days. */}
      <RecentlyUploaded city={city} />

      {/* The same panel, the same two tabs, the same ChatPane. The Veo page has no CRM dock to
          collapse and no sibling list to step through, so it passes neither — the component assumes
          neither either. */}
      {panelMatch != null && (
        <MatchSidePanel matchId={panelMatch} width={600} tab={panelTab}
          onTab={setPanelTab} onClose={() => setPanelMatch(null)} />
      )}

      <p className="foot">
        A row is here because some <code>veo_codes</code> row names its field. A score appears only when it is below 100 —
        eight rows reading 100 say nothing eight times. A row with no score at all was decided before scoring existed.
      </p>
    </div>
  );
}

/* ── RECENTLY UPLOADED: THE PAGE'S SECOND AXIS ─────────────────────────────────────────────────
 * Everything above is indexed by the day a match was PLAYED. Films arrive on Veo's schedule, and
 * measured over every recording with a match day: 18 arrived same-day, 46 next-day, and four
 * arrived two, three or five days later. The five-day one is real — SCISS | 1 sep | 8pm, played
 * Sep 1, arrived Sep 6 — and on a page organised by Sep 1 it is invisible unless you already knew
 * to go back and look, which is the thing you would be using this page to find out.
 *
 * DAY-INDEPENDENT ON PURPOSE. It does not refetch when the day nav moves; it refetches when the
 * city filter does, because that changes which rows an operator is looking at.
 */
type RecentRow = {
  id: string; recordingId: string; subject: string | null; videoUrl: string | null;
  receivedAt: string | null; state: RecentState; queueReason: string | null; score: number | null;
  candidateApiIds: number[]; parsedCode: string | null; parsedMatchDate: string | null;
  parsedTimeMinutes: number | null; city: string | null;
  match: { apiId: number; name: string; venue: string | null; city: string | null; day: string | null } | null;
};

const arrivedLabel = (iso: string | null): string => {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "—";
  // The arrival is a TRUE INSTANT, so it is rendered in a named zone rather than in UTC — the
  // opposite of the match dates above, which are wall clocks. See src/lib/veoRecent.ts.
  return new Date(Date.parse(iso)).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: ARRIVAL_ZONE,
  });
};

function RecentlyUploaded({ city }: { city: string }) {
  const [rows, setRows] = useState<RecentRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [unpostedOnly, setUnpostedOnly] = useState(false);
  const [limit, setLimit] = useState(30);
  const [more, setMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true); setErr(null);
    void (async () => {
      try {
        const q = new URLSearchParams({ limit: String(limit) });
        if (unpostedOnly) q.set("filter", "unposted");
        if (city !== "all") q.set("city", city);
        const res = await authFetch(`/api/veo/recent?${q.toString()}`);
        const j = await res.json();
        if (!live) return;
        if (!res.ok) { setErr(j?.error || `Load failed (${res.status})`); setRows([]); return; }
        setRows(j.rows as RecentRow[]);
        setMore(j.more === true);
      } catch (e) {
        if (live) { setErr(e instanceof Error ? e.message : String(e)); setRows([]); }
      } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [limit, unpostedOnly, city, nonce]);

  const shown = rows ?? [];

  return (
    <section className="recent" data-testid="veo-recent">
      <div className="rhead">
        <div>
          <h3>Recently uploaded</h3>
          <p>Every film that has arrived, newest arrival first, whatever day it was played on.</p>
        </div>
        {/* ONE FILTER, NOT A STATUS DROPDOWN WITH FIVE ENTRIES NOBODY WILL USE. */}
        <div className="rfilter">
          <button type="button" data-testid="veo-recent-all" className={!unpostedOnly ? "on" : ""}
            onClick={() => { setUnpostedOnly(false); setOpenId(null); }}>All</button>
          <button type="button" data-testid="veo-recent-unposted" className={unpostedOnly ? "on" : ""}
            onClick={() => { setUnpostedOnly(true); setOpenId(null); }}>Not posted</button>
        </div>
      </div>

      {loading && !rows && <p className="empty">Loading arrivals…</p>}
      {err && <p className="warn" data-testid="veo-recent-error">{err}</p>}
      {rows && shown.length === 0 && !err && (
        <p className="empty" data-testid="veo-recent-empty">
          {unpostedOnly ? "Every film that has arrived has gone somewhere." : "No films have arrived."}
        </p>
      )}

      {shown.map((r) => <RecentRowView key={r.id} r={r} open={openId === r.id}
        onToggle={() => setOpenId(openId === r.id ? null : r.id)}
        onDone={() => { setOpenId(null); setNonce((n) => n + 1); }} />)}

      {/* DERIVED FROM THE ROWS ON SCREEN, so it follows the filter rather than describing the table. */}
      {rows && shown.length > 0 && (
        <div className="rfoot">
          <span data-testid="veo-recent-count">
            {shown.length} {unpostedOnly ? "not posted" : "arrival"}{shown.length === 1 ? "" : unpostedOnly ? "" : "s"} shown
          </span>
          {more && (
            <button type="button" className="more" data-testid="veo-recent-more" onClick={() => setLimit(limit + 30)}>
              Load 30 more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function RecentRowView({ r, open, onToggle, onDone }: {
  r: RecentRow; open: boolean; onToggle: () => void; onDone: () => void;
}) {
  const matchDay = r.match?.day ?? null;
  const source = daySourceOf(matchDay, r.parsedMatchDate);
  const day = matchDay ?? r.parsedMatchDate;
  const lag = lagDays(r.receivedAt, day);
  const wait = isResolved(r.state) ? null : waitDays(r.receivedAt);

  return (
    <div className={`rrow ${RECENT_STATE_TONE[r.state]}${open ? " open" : ""}`}
      data-testid="veo-recent-row" data-state={r.state} data-recording-id={r.id}>
      <div className="rtop">
        <span className="rwhen">
          <b>{arrivedLabel(r.receivedAt)}</b>
          {/* HOW LATE THE FILM WAS — Veo's clock. Same-day and next-day are the normal case and
              earn no room; two or more days is the case this section exists for. */}
          {lagWorthSaying(lag) && (
            <em data-testid="veo-recent-lag" data-days={lag ?? ""} data-source={source}>
              {lagLabel(lag)}{source === "title" ? " (from the title)" : ""}
            </em>
          )}
        </span>
        <span className="rwhat">
          <b>{r.subject ?? r.recordingId}</b>
          <small>
            {r.match
              ? <>went into {r.match.name}{r.match.venue ? ` · ${r.match.venue}` : ""}{day ? ` · ${day}` : ""}</>
              : <>went nowhere{r.queueReason ? ` · ${r.queueReason}` : ""}{day ? ` · for ${day}` : ""}</>}
          </small>
        </span>
        {/* HOW LONG IT HAS WAITED FOR A PERSON — our clock, and only on a row nobody has acted on. */}
        <span className="rwait">
          {wait != null && (
            <em data-testid="veo-recent-wait" data-days={wait}
              className={wait >= WAIT_ALARM_DAYS ? "alarm" : ""}>{waitLabel(wait)}</em>
          )}
        </span>
        <span className={`pill ${RECENT_STATE_TONE[r.state]}`} data-testid="veo-recent-state">
          {RECENT_STATE_LABEL[r.state]}
        </span>
        <span className="ractions">
          {/* BACK TO ITS OWN DAY. That is the whole point of finding it here. */}
          {day && <a className="btn" data-testid="veo-recent-day" href={`/match-ops/veo?date=${day}`}>Its day</a>}
          {r.state === "queued" && (
            <button type="button" className="btn" data-testid="veo-recent-assign" onClick={onToggle}>
              {open ? "Close" : "Assign"}
            </button>
          )}
        </span>
      </div>
      {open && r.state === "queued" && (
        <RecentAssign r={r} onDone={onDone} />
      )}
    </div>
  );
}

/* ASSIGN FROM HERE TOO, using the day the recording belongs to rather than the day on screen —
 * a film found in this list is usually not from the day being viewed, which is why it is here. */
function RecentAssign({ r, onDone }: { r: RecentRow; onDone: () => void }) {
  const [day, setDay] = useState<Payload | null>(null);
  const [confirming, setConfirming] = useState<AssignCandidate | null>(null);
  const { busy, err, assign, dismiss } = useAssign(r.id, onDone);
  const target = r.match?.day ?? r.parsedMatchDate ?? null;

  useEffect(() => {
    if (!target) return;
    let live = true;
    void (async () => {
      try {
        const res = await authFetch(`/api/veo/day?date=${target}`);
        const j = await res.json();
        if (live && res.ok) setDay(j as Payload);
      } catch { /* the panel simply offers nothing */ }
    })();
    return () => { live = false; };
  }, [target]);

  const rec: VeoDayRecording = {
    id: r.id, recordingId: r.recordingId, subject: r.subject, videoUrl: r.videoUrl,
    receivedAt: r.receivedAt, status: "queued", queueReason: r.queueReason,
    matchedApiId: null, candidateApiIds: r.candidateApiIds, score: r.score, scoreParts: null,
    flagged: false, parsedCode: r.parsedCode, parsedMatchDate: r.parsedMatchDate,
    parsedTimeLabel: null, parsedTimeMinutes: r.parsedTimeMinutes, postedByUserId: null,
  };

  return (
    <div className="assign" data-testid="veo-recent-panel">
      {!target && <p className="pnote">The title gave no date, so there is no day to offer matches from.</p>}
      {target && !day && <p className="pnote">Loading {target}…</p>}
      {day && <CandidateList rec={rec} data={day} busy={busy} onPick={setConfirming} />}
      <div className="assignfoot">
        <span className="pnote">Assigning posts the film into that match&apos;s chat. One attempt, never retried.</span>
        <button type="button" className="btn" data-testid="veo-recent-dismiss" disabled={busy} onClick={() => void dismiss()}>Not our film</button>
      </div>
      {err && <p className="warn">{err}</p>}
      {confirming && (
        <Confirm rec={rec} target={confirming} busy={busy}
          onCancel={() => setConfirming(null)} onGo={() => void assign(confirming.apiId)} />
      )}
    </div>
  );
}

/* ── ASSIGNING AN ORPHAN BY HAND ───────────────────────────────────────────────────────────────
 * POST /api/veo/[id] { apiId } has existed and worked all along — the old automation dashboard has
 * been calling it. This page simply did not. So this is wiring, not building.
 *
 * TWO GROUPS, NEVER MERGED INTO ONE SORTED LIST. The top group is the row's stored
 * candidate_api_ids: for a multiple_matches recording those are exactly the matches the matcher
 * weighed and could not separate, so the common case is two lines and one click. Sorting them in
 * with the rest of the day would destroy the only thing that makes them the top two.
 */
/* The two writes, in one place. Both are one attempt with no retry — there is no Idempotency-Key
 * anywhere in this pipeline and a duplicate film is visible to every player in the chat. */
function useAssign(recordingId: string, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const call = async (init: RequestInit, what: string) => {
    if (busy) return false;
    setBusy(true); setErr(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(`/api/veo/${recordingId}`, {
        ...init,
        headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(`${j?.error || `${what} failed (${res.status})`} — the recording is still queued.`);
        return false;
      }
      onDone();
      return true;
    } catch (e) {
      setErr(`${e instanceof Error ? e.message : String(e)} — the recording is still queued.`);
      return false;
    } finally { setBusy(false); }
  };
  return {
    busy, err, setErr,
    assign: (apiId: number) => call({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiId }) }, "Assign"),
    dismiss: () => call({ method: "DELETE" }, "Dismiss"),
  };
}

/** The confirm, which names BOTH sides. This puts a video link in a chat real players read. */
function Confirm({ rec, target, busy, onCancel, onGo }: {
  rec: VeoDayRecording; target: AssignCandidate; busy: boolean; onCancel: () => void; onGo: () => void;
}) {
  return (
    <div className="confirm" data-testid="veo-confirm">
      <p>
        Post <b>{rec.subject ?? rec.recordingId}</b> into{" "}
        <b>{target.name}, {target.time}{target.players != null ? `, ${target.players} players` : ""}</b>?
      </p>
      <p className="pnote">The film appears in that match&apos;s chat straight away. It can be removed, but not unseen.</p>
      <div className="acts">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn pri" data-testid="veo-confirm-post" disabled={busy} onClick={onGo}>
          {busy ? "Posting…" : "Post it"}
        </button>
      </div>
    </div>
  );
}

/* THE CANDIDATE LIST, IN TWO GROUPS THAT ARE NEVER MERGED. The top group is the row's stored
 * candidate_api_ids: for a multiple_matches recording those are exactly the matches the matcher
 * weighed and could not separate, so the common case is two lines and one click. Sorting them in
 * with the rest of the day would destroy the only thing that makes them the top two. */
function CandidateList({ rec, data, busy, onPick }: {
  rec: VeoDayRecording; data: Payload; busy: boolean; onPick: (c: AssignCandidate) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shortlist = rec.candidateApiIds.map((id) => data.candidates[id]).filter(Boolean);
  const shortIds = new Set(shortlist.map((c) => c.apiId));
  const rest = Object.values(data.candidates)
    .filter((c) => !shortIds.has(c.apiId))
    .sort((a, b) => {
      if (rec.parsedTimeMinutes == null) return a.minutes - b.minutes;
      return Math.abs(a.minutes - rec.parsedTimeMinutes) - Math.abs(b.minutes - rec.parsedTimeMinutes);
    });
  const REST_SHOWN = 4;
  const restShown = showAll ? rest : rest.slice(0, REST_SHOWN);

  const line = (c: AssignCandidate) => {
    const gap = gapLabel(c.minutes, rec.parsedTimeMinutes);
    return (
      <div className={`cand${gap === "exact" ? " exact" : ""}`} key={c.apiId} data-testid={`veo-cand-${c.apiId}`} data-gap={gap ?? ""}>
        <span className="ct">{c.time}</span>
        <span className="cn">
          <b>{c.name}</b>
          <small>
            {c.venue} · {c.city}
            {/* INFORMATION, NOT A BLOCK. A person assigning by hand is the deliberate override. */}
            {!c.coded && <em data-testid="veo-cand-uncoded"> · no code names this field</em>}
          </small>
        </span>
        <span className="cg">{gap ?? "—"}</span>
        <span className="cf">{c.players ?? "—"}{c.capacity ? `/${c.capacity}` : ""}</span>
        <button type="button" className={`btn${gap === "exact" ? " pri" : ""}`} data-testid={`veo-assign-${c.apiId}`}
          disabled={busy} onClick={() => onPick(c)}>Assign</button>
      </div>
    );
  };

  return (
    <>
      {shortlist.length > 0 && (
        <>
          <h4 data-testid="veo-shortlist-head">
            {shortlist.length === 2 ? "Both of these, and it could not choose" : `The ${shortlist.length} it weighed and could not choose between`}
          </h4>
          <div data-testid="veo-shortlist">{shortlist.map(line)}</div>
        </>
      )}
      <h4>{shortlist.length > 0 ? "Everything else on camera that day" : "On camera that day"}</h4>
      <div data-testid="veo-rest">{restShown.map(line)}</div>
      {rest.length > REST_SHOWN && !showAll && (
        <button type="button" className="more" onClick={() => setShowAll(true)}>Show the other {rest.length - REST_SHOWN}</button>
      )}
      {rest.length === 0 && shortlist.length === 0 && <p className="pnote">No camera matches on this day to assign it to.</p>}
    </>
  );
}

function Orphan({ u, data, open, onToggle, onDone }: {
  u: VeoDayRecording;
  data: Payload;
  open: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState<AssignCandidate | null>(null);
  const { busy, err, assign, dismiss } = useAssign(u.id, onDone);

  const stray = u.matchedApiId != null ? data.strays[u.matchedApiId] : undefined;
  const uncoded = stray?.fieldId != null && !data.codedFields.includes(stray.fieldId);

  return (
    <div className="up-wrap" data-testid="veo-orphan" data-recording-id={u.id}>
      <div className="up">
        <span className="upsub">{u.subject ?? u.recordingId}</span>
        {stray ? (
          <span className={uncoded ? "upwhy" : "upnote"} data-testid="veo-stray">
            {uncoded
              ? `posted to match ${stray.apiId} on field ${stray.fieldId} — no veo_codes row names that field, so it cannot be a row here`
              : `posted to match ${stray.apiId}${stray.date && stray.date !== data.date ? ` on ${stray.date}` : ""}`}
          </span>
        ) : (
          <span className="upwhy">{u.queueReason ?? u.status}</span>
        )}
        {u.status !== "posted" && (
          <button type="button" className="btn" data-testid="veo-open-assign" onClick={onToggle}>
            {open ? "Close" : "Assign"}
          </button>
        )}
        {u.videoUrl && <a className="btn" href={u.videoUrl} target="_blank" rel="noreferrer">Open in Veo</a>}
      </div>

      {open && (
        <div className="assign" data-testid="veo-assign-panel">
          <CandidateList rec={u} data={data} busy={busy} onPick={setConfirming} />
          <div className="assignfoot">
            <span className="pnote">Assigning posts the film into that match&apos;s chat. One attempt, never retried.</span>
            <button type="button" className="btn" data-testid="veo-dismiss" disabled={busy} onClick={() => void dismiss()}>Not our film</button>
          </div>
          {err && <p className="warn" data-testid="veo-assign-error">{err}</p>}
        </div>
      )}

      {confirming && (
        <Confirm rec={u} target={confirming} busy={busy}
          onCancel={() => setConfirming(null)}
          onGo={() => void assign(confirming.apiId)} />
      )}
    </div>
  );
}


function Row({ r, data, open, onToggle, onDone, onOpenChat }: {
  r: VeoDayRow; data: Payload; open: boolean; onToggle: () => void; onDone: () => void; onOpenChat: (apiId: number) => void;
}) {
  const rec = r.primary;
  const score = rec?.score ?? null;
  return (
    <div className={`row ${STATE_TONE[r.state]}${open ? " open" : ""}`} data-testid="veo-row" data-api-id={r.apiId} data-state={r.state}>
      <button type="button" className="rowtop" onClick={onToggle} data-testid={`veo-row-${r.apiId}`}>
        <span className="t">{r.time}</span>
        <span className="code">{r.code}</span>
        <span className="nm">
          <b>{r.name}</b>
          <small>{r.venue} · {r.city}</small>
        </span>
        <span className={`pill ${STATE_TONE[r.state]}`} data-testid="veo-row-state">{FILM_STATE_LABEL[r.state]}</span>
        <span className="pl">{r.players ?? "—"}{r.capacity ? `/${r.capacity}` : ""}</span>
        {/* SHOWN ONLY WHEN IT WAS A JUDGEMENT CALL. 100 is a clean read and says nothing; null is a
            row decided before scoring existed and must show NOTHING, not a zero. */}
        <span className="sc" data-testid="veo-row-score">{score != null && score < 100 ? score : ""}</span>
        <span className="chev" aria-hidden>{open ? "▾" : "›"}</span>
      </button>
      {open && <Viewer r={r} data={data} onDone={onDone} onOpenChat={onOpenChat} />}
    </div>
  );
}

function Viewer({ r, data, onDone, onOpenChat }: { r: VeoDayRow; data: Payload; onDone: () => void; onOpenChat: (apiId: number) => void }) {
  const rec = r.primary;
  /* The still frame AND the film URL are fetched when the row opens, never with the day — a day of
   * rows would be a scrape of app.veo.co per row for pictures nobody had asked to see yet. ONE
   * request returns both; the film itself is not touched until somebody presses play. */
  const [media, setMedia] = useState<{ thumb: string | null; video: string | null } | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const recId = rec?.id ?? null;
  useEffect(() => {
    if (!recId) return;
    let live = true;
    setPlaying(false); setVideoFailed(false);
    void (async () => {
      try {
        const res = await authFetch(`/api/veo/thumb?id=${recId}`);
        const j = await res.json();
        if (live) setMedia(res.ok ? { thumb: (j.thumbnail as string | null) ?? null, video: (j.video as string | null) ?? null } : { thumb: null, video: null });
      } catch { if (live) setMedia({ thumb: null, video: null }); }
    })();
    return () => { live = false; };
  }, [recId]);
  const thumb = media?.thumb;
  const video = media?.video ?? null;
  const trace = scoreTrace(rec?.scoreParts ?? null);
  const posted = r.state === "posted" || r.state === "flagged" || r.state === "assigned";
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState<AssignCandidate | null>(null);
  // Hooks are unconditional; the id is a placeholder when there is nothing to assign, and every
  // control that could call it is absent in that case.
  const { busy, err, assign, dismiss } = useAssign(rec?.id ?? "", onDone);
  const thisMatch = data.candidates[r.apiId] ?? null;
  return (
    <div className="viewer" data-testid="veo-viewer">
      <div className="player" data-testid="veo-player">
        {rec?.videoUrl ? (
          <>
            {/* NO IFRAME IS ATTEMPTED. Measured: app.veo.co sends x-frame-options: DENY and a
                frame-ancestors list this origin is not on. A thumbnail and a link is the whole of
                what is possible, so that is what ships. */}
            {/* THE PLAY GLYPH IS A BUTTON NOW, AND IT PLAYS THE FILM. It was a <span> with
                pointer-events:none, which is the literal answer to "what does this do" — nothing.
                No iframe is involved: the mp4 sits in the same CDN folder as the still frame and is
                public, so a plain <video> works where an embed never could.

                NOTHING IS FETCHED UNTIL THE CLICK. The <video> is not created until then and
                carries preload="none", so a day of expanded rows streams nothing.

                THE STAGE KEEPS ITS BOX. The video replaces the poster inside the same 16:9
                container rather than appearing below it, so nothing on the page moves. */}
            <div className="thumb" data-testid="veo-stage">
              {playing && video && !videoFailed ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  data-testid="veo-video"
                  src={video}
                  controls
                  autoPlay
                  playsInline
                  preload="none"
                  poster={thumb ?? undefined}
                  onError={() => { setVideoFailed(true); setPlaying(false); }}
                />
              ) : (
                <>
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb} alt="" data-testid="veo-thumb" />
                  ) : (
                    <span className="tnote" data-testid="veo-thumb-none">
                      {thumb === undefined ? "Loading the still frame…" : "No still frame published for this film."}
                    </span>
                  )}
                  {video && (
                    <button
                      type="button"
                      className="play"
                      data-testid="veo-play"
                      aria-label="Play the film"
                      onClick={() => { setVideoFailed(false); setPlaying(true); }}
                    >
                      ▶
                    </button>
                  )}
                </>
              )}
            </div>
            {/* THE RECORDING'S OWN SUBJECT, not the row's time. More than one recording can attach
                to a match (the Pearland pair shortlists both), so a panel headed with the MATCH's
                time cannot tell you which film you are about to post. */}
            <div className="pmeta">
              <b data-testid="veo-rec-subject">{rec.subject ?? `${r.code} · ${r.time}`}</b>
              <span className="rid">{rec.recordingId}</span>
            </div>
            {/* DEMOTED TO A TEXT LINK. Veo's own page has the tactical tools and the highlights;
                this page is for checking in on a match in ten seconds. */}
            <p className="pnote">
              {videoFailed
                ? <>That film would not play — Veo may still be processing it. <a href={rec.videoUrl} target="_blank" rel="noreferrer" data-testid="veo-open-in-veo">Open in Veo</a>.</>
                : video
                  ? <>Streams from Veo&apos;s CDN, about 1.8 GB a match, and only the part you watch is fetched. <a href={rec.videoUrl} target="_blank" rel="noreferrer" data-testid="veo-open-in-veo">Open in Veo</a> for the tactical tools.</>
                  : <>No playable file for this recording yet. <a href={rec.videoUrl} target="_blank" rel="noreferrer" data-testid="veo-open-in-veo">Open in Veo</a>.</>}
            </p>
          </>
        ) : (
          <div className="nofilm" data-testid="veo-no-film">
            <b>No film yet</b>
            <span>Nothing has arrived for this match.</span>
          </div>
        )}
      </div>

      <div className="side">
        <h4>This match</h4>
        <dl className="facts">
          <div><dt>Match</dt><dd>{r.apiId}</dd></div>
          <div><dt>Field</dt><dd>{r.venue}</dd></div>
          <div><dt>Kick-off</dt><dd>{r.time}</dd></div>
          <div><dt>Players</dt><dd>{r.players ?? "—"}{r.capacity ? ` of ${r.capacity}` : ""}</dd></div>
          <div><dt>Code</dt><dd>{r.code}{r.codeConfirmed ? "" : " · queue-only"}</dd></div>
        </dl>

        {/* THE BUTTONS FOLLOW THE STATE. A recording that already posted is never offered a send —
            a send button under a trace saying it has already sent is a control that lies.
            THE OTHER HALF USED TO BE DEAD, and once ATHP covered both Pearland field ids the
            Pearland recordings stopped being orphans and became rows — so the assign panel had to
            be reachable from HERE, which is now the common case, not only from the orphan strip. */}
        <div className="acts" data-testid="veo-actions">
          {/* THE CHAT THE LINK LANDED IN, one click away. The thread id IS the match api id —
              proven, and no second lookup. It opens on the Chat tab because on a posted row the
              chat is the question, not the match's details. */}
          <button type="button" className="btn" data-testid="veo-match-chat"
            onClick={() => onOpenChat(r.apiId)}>
            Match chat · {r.apiId}
          </button>
          {posted ? (
            <>
              {/* THERE IS NO FLAG ON A CLEAN POST, SO THERE IS NOTHING TO CLEAR. The buttons used
                  to branch on "has it posted", which swept a score of 100 in with a flagged one and
                  offered "Right match, clear the flag" directly above a trace reading "Nothing was
                  guessed, so it posted without a flag". Only a FLAGGED post is on a list to come
                  off. */}
              {r.state === "flagged" && (
                <button type="button" className="btn pri" data-testid="veo-clear-flag" disabled>Right match, clear the flag</button>
              )}
              <button type="button" className="btn" data-testid="veo-move" disabled>Wrong match, move it</button>
              <button type="button" className="btn" data-testid="veo-not-ours" disabled>Not our film</button>
            </>
          ) : rec ? (
            <>
              <button
                type="button"
                className="btn pri"
                data-testid="veo-send-to-chat"
                disabled={busy || !thisMatch}
                onClick={() => thisMatch && setConfirming(thisMatch)}
              >
                Send to the chat
              </button>
              <button type="button" className="btn" data-testid="veo-different-match" disabled={busy} onClick={() => setPicking(!picking)}>
                {picking ? "Close" : "Different match"}
              </button>
              <button type="button" className="btn" data-testid="veo-row-dismiss" disabled={busy} onClick={() => void dismiss()}>Not our film</button>
            </>
          ) : (
            <span className="find" data-testid="veo-find-film">Find the film</span>
          )}
        </div>
        {posted && (
          <p className="pnote" data-testid="veo-posted-note">
            {r.state === "flagged"
              ? "It posted on an inferred read, so it is still on the flagged list until somebody says it is right."
              : "Nothing was inferred, so this row is already off the review list — there is no flag to clear."}
          </p>
        )}
        {rec && !posted && (
          <p className="pnote">Assigning posts the film into that match&apos;s chat. One attempt, never retried.</p>
        )}
        {err && <p className="warn" data-testid="veo-assign-error">{err}</p>}
        {rec && !posted && picking && (
          <div className="assign" data-testid="veo-assign-panel">
            <CandidateList rec={rec} data={data} busy={busy} onPick={setConfirming} />
          </div>
        )}
        {rec && confirming && (
          <Confirm rec={rec} target={confirming} busy={busy}
            onCancel={() => setConfirming(null)}
            onGo={() => void assign(confirming.apiId)} />
        )}

        {trace && rec?.score != null && (
          <div className="trace" data-testid="veo-trace" data-total={rec.score}>
            <h4>Why it scored {rec.score}</h4>
            {trace.map((l) => (
              <div className="tl" key={l.label} data-testid={`veo-trace-${l.label.toLowerCase()}`} data-points={l.points}>
                <span>{l.label}</span>
                <em>{l.detail}</em>
                <b>{l.points}</b>
              </div>
            ))}
            <div className="tl sum" data-testid="veo-trace-sum">
              <span>Total</span><em /><b>{rec.score}</b>
            </div>
            <p className="pnote">
              {rec.score >= 100
                ? "Nothing was guessed, so it posted without a flag."
                : rec.score >= 45
                  ? "Below a perfect read, so it posted and stayed flagged here. Under 45 it would have waited for you."
                  : "Below 45, so nothing was sent."}
            </p>
          </div>
        )}
        {rec && rec.score == null && (
          <p className="pnote" data-testid="veo-no-score">
            This recording was decided before the matcher scored anything, so there is no trace to show.
          </p>
        )}
        {rec?.queueReason && <p className="pnote">Queued as <code>{rec.queueReason}</code>.</p>}
      </div>
    </div>
  );
}

/* The panel's own rules, because this page is not `.gdo` and does not inherit Gameday's. */
const CSS = MATCH_SIDE_PANEL_CSS + `
.veo{--ink1:#0f1c17;--ink2:#3d5049;--ink3:#7c8f88;--line:#e3e9e6;--bg:#fbfcfc;
  --ok:#128a5c;--flag:#b8791f;--hand:#2f7d8f;--hold:#5b6b9e;--look:#c0563a;--none:#8a9691;
  padding:18px 20px 60px;max-width:1180px;margin:0 auto;color:var(--ink1);
  font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.veo .head{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;justify-content:space-between;margin-bottom:14px}
.veo .h1{margin:0;font-size:23px;font-weight:800;letter-spacing:-.02em}
.veo .hsub{margin:3px 0 0;color:var(--ink3);font-size:13px}
.veo .nav{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.veo .nb{border:1px solid var(--line);background:#fff;border-radius:8px;min-width:32px;height:32px;padding:0 9px;
  font-size:14px;font-weight:700;color:var(--ink2);cursor:pointer}
.veo .nb:hover{background:var(--bg)}
.veo .nb.wide{font-size:12px}
.veo .dt{display:flex;flex-direction:column;line-height:1.15;padding:0 4px;min-width:172px;text-align:center}
.veo .dt b{font-size:14px;font-weight:800}
.veo .dt span{font-size:11px;color:var(--ink3)}
.veo .sel{border:1px solid var(--line);background:#fff;border-radius:8px;height:32px;padding:0 8px;font-size:12.5px;color:var(--ink2)}
.veo .conf{font-size:11px;font-weight:700;color:var(--hold);background:#eef1f8;border-radius:999px;padding:4px 9px}

.veo .tally{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;margin:0 0 14px}
.veo .tal{border:1px solid var(--line);background:#fff;border-radius:11px;padding:11px 12px;text-align:left;cursor:pointer;
  display:flex;flex-direction:column;gap:1px}
.veo .tal b{font-size:22px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.veo .tal span{font-size:11px;color:var(--ink3)}
.veo .tal.on{outline:2px solid currentColor;outline-offset:-2px}
.veo .tal.ok b{color:var(--ok)} .veo .tal.ok.on{color:var(--ok)}
.veo .tal.flag b{color:var(--flag)} .veo .tal.flag.on{color:var(--flag)}
.veo .tal.hold b{color:var(--hold)} .veo .tal.hold.on{color:var(--hold)}
.veo .tal.look b{color:var(--look)} .veo .tal.look.on{color:var(--look)}
.veo .tal.none b{color:var(--none)} .veo .tal.none.on{color:var(--none)}
.veo .tal.hand b{color:var(--hand)} .veo .tal.hand.on{color:var(--hand)}
.veo .tal.total{background:var(--bg);cursor:default}

.veo .rows{display:flex;flex-direction:column;gap:7px}
.veo .row{border:1px solid var(--line);border-radius:11px;background:#fff;overflow:hidden}
.veo .row.open{border-color:#c9d4cf;box-shadow:0 1px 0 rgba(15,28,23,.04)}
.veo .rowtop{display:grid;grid-template-columns:78px 58px minmax(0,1fr) 132px 62px 40px 22px;gap:10px;align-items:center;
  width:100%;padding:11px 13px;background:none;border:0;text-align:left;cursor:pointer;font:inherit;color:inherit}
.veo .rowtop:hover{background:var(--bg)}
.veo .t{font-weight:800;font-variant-numeric:tabular-nums;font-size:13px}
.veo .code{font-weight:800;font-size:11.5px;color:var(--ink2);letter-spacing:.03em}
.veo .nm{display:flex;flex-direction:column;min-width:0}
.veo .nm b{font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.veo .nm small{color:var(--ink3);font-size:11.5px}
.veo .pill{border-radius:999px;padding:3px 9px;font-size:11px;font-weight:800;text-align:center;white-space:nowrap}
.veo .pill.ok{background:#e6f5ee;color:var(--ok)}
.veo .pill.flag{background:#fdf3e2;color:var(--flag)}
.veo .pill.hold{background:#eef1f8;color:var(--hold)}
.veo .pill.look{background:#fdeee9;color:var(--look)}
.veo .pill.none{background:#f2f4f3;color:var(--none)}
.veo .pill.hand{background:#e6f2f5;color:var(--hand)}
.veo .pl{font-size:12.5px;color:var(--ink2);font-variant-numeric:tabular-nums;text-align:right}
.veo .sc{font-size:12.5px;font-weight:800;color:var(--flag);font-variant-numeric:tabular-nums;text-align:right}
.veo .chev{color:var(--ink3);text-align:center}

.veo .viewer{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:16px;padding:0 13px 15px;border-top:1px solid var(--line);padding-top:14px}
.veo .player{display:flex;flex-direction:column;gap:9px}
.veo .thumb{position:relative;aspect-ratio:16/9;border-radius:10px;overflow:hidden;
  background:linear-gradient(160deg,#16211d,#0c130f);display:flex;align-items:center;justify-content:center}
.veo .thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.veo .tnote{color:rgba(255,255,255,.6);font-size:12px;padding:0 14px;text-align:center}
/* A REAL CONTROL: 64px, focusable, and big enough to hit. */
.veo .play{position:relative;width:64px;height:64px;border:0;border-radius:999px;background:rgba(12,19,15,.62);color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:22px;backdrop-filter:blur(2px);cursor:pointer;padding:0}
.veo .play:hover{background:rgba(12,19,15,.78)}
.veo .play:focus-visible{outline:3px solid #fff;outline-offset:2px}
/* The film takes the SAME box the poster had, so replacing one with the other moves nothing. */
.veo .thumb video{position:absolute;inset:0;width:100%;height:100%;background:#000}
.veo .pmeta{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.veo .pmeta b{font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.veo .rid{font-size:11px;color:var(--ink3);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.veo .nofilm{aspect-ratio:16/9;border:1px dashed var(--line);border-radius:10px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:3px;color:var(--ink3);background:var(--bg)}
.veo .nofilm b{color:var(--ink2)}
.veo .side h4{margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)}
.veo .facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:0 0 13px}
.veo .facts dt{font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3)}
.veo .facts dd{margin:1px 0 0;font-size:13px}
.veo .acts{display:flex;flex-wrap:wrap;gap:7px}
.veo .btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;
  color:var(--ink2);cursor:pointer;text-decoration:none;display:inline-block}
.veo .btn.pri{background:var(--ink1);border-color:var(--ink1);color:#fff}
.veo .btn:disabled{opacity:.45;cursor:not-allowed}
/* AN ITEM THAT NEEDS DOING MUST NOT LOOK DISABLED. */
.veo .find{color:var(--look);font-weight:800;font-size:12.5px;background:#fdeee9;border-radius:8px;padding:6px 11px}
.veo .pnote{margin:8px 0 0;font-size:11.5px;color:var(--ink3);line-height:1.45}
.veo .trace{margin-top:14px;border-top:1px solid var(--line);padding-top:11px}
.veo .tl{display:grid;grid-template-columns:56px minmax(0,1fr) 34px;gap:8px;align-items:baseline;padding:3px 0;font-size:12.5px}
.veo .tl span{font-weight:700}
.veo .tl em{font-style:normal;color:var(--ink3);font-size:11.5px}
.veo .tl b{text-align:right;font-variant-numeric:tabular-nums}
.veo .tl.sum{border-top:1px solid var(--line);margin-top:4px;padding-top:6px;font-weight:800}

.veo .unplaced{margin-top:18px;border:1px solid var(--line);border-radius:11px;background:#fff;padding:12px 13px}
.veo .unplaced h3{margin:0 0 8px;font-size:12.5px;font-weight:800}
.veo .up-wrap{border-top:1px solid var(--line)}
.veo .up{display:flex;align-items:center;gap:9px;padding:6px 0;font-size:12.5px}
.veo .assign{padding:4px 0 12px}
.veo .assign h4{margin:10px 0 5px;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)}
/* FIVE COLUMNS, ONE x EACH DOWN THE LIST: when, what, how far off, how full, and the button. */
.veo .cand{display:grid;grid-template-columns:78px minmax(0,1fr) 96px 58px 74px;gap:10px;align-items:center;
  padding:6px 9px;border:1px solid var(--line);border-radius:9px;margin-bottom:5px;background:#fff}
/* ONLY THE EXACT ROW GETS COLOUR. It is the whole decision for the Pearland pair. */
.veo .cand.exact{border-color:#b7e0cd;background:#f4fbf7}
.veo .cand .ct{font-weight:800;font-variant-numeric:tabular-nums;font-size:12.5px}
.veo .cand .cn{display:flex;flex-direction:column;min-width:0}
.veo .cand .cn b{font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.veo .cand .cn small{color:var(--ink3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.veo .cand .cn em{font-style:normal;color:var(--flag);font-weight:700}
.veo .cand .cg{font-size:11.5px;color:var(--ink3);font-weight:700}
.veo .cand.exact .cg{color:var(--ok)}
.veo .cand .cf{font-size:11.5px;color:var(--ink2);font-variant-numeric:tabular-nums;text-align:right}
.veo .more{border:0;background:none;color:var(--ink2);font-size:11.5px;font-weight:700;cursor:pointer;padding:3px 0;text-decoration:underline}
.veo .assignfoot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;flex-wrap:wrap}
.veo .assignfoot .pnote{margin:0}
.veo .confirm{border:1px solid #c9d4cf;border-radius:10px;background:var(--bg);padding:11px 13px;margin:4px 0 10px}
.veo .confirm p{margin:0 0 6px;font-size:13px}
.veo .confirm .acts{margin-top:9px}
.veo .upsub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.veo .upwhy{color:var(--look);font-weight:700;font-size:11.5px;text-align:right}
.veo .upnote{color:var(--ink3);font-size:11.5px;text-align:right}
/* RECENTLY UPLOADED — the second axis, under the day list. */
.veo .recent{margin-top:26px;border-top:1px solid var(--line);padding-top:16px}
.veo .rhead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.veo .rhead h3{margin:0;font-size:15px;font-weight:800;letter-spacing:-.01em}
.veo .rhead p{margin:2px 0 0;font-size:11.5px;color:var(--ink3)}
.veo .rfilter{display:flex;gap:6px}
.veo .rfilter button{border:1px solid var(--line);background:#fff;border-radius:999px;padding:4px 11px;font-size:11.5px;font-weight:700;color:var(--ink2);cursor:pointer}
.veo .rfilter button.on{background:var(--ink1);border-color:var(--ink1);color:#fff}
.veo .rrow{border:1px solid var(--line);border-radius:10px;background:#fff;margin-bottom:6px;overflow:hidden}
.veo .rtop{display:grid;grid-template-columns:150px minmax(0,1fr) 118px 128px 132px;gap:10px;align-items:center;padding:9px 12px}
.veo .rwhen{display:flex;flex-direction:column;min-width:0}
.veo .rwhen b{font-size:12.5px;font-weight:800;font-variant-numeric:tabular-nums}
.veo .rwhen em{font-style:normal;font-size:10.5px;font-weight:800;color:var(--flag)}
.veo .rwhat{display:flex;flex-direction:column;min-width:0}
.veo .rwhat b{font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.veo .rwhat small{color:var(--ink3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.veo .rwait{text-align:right}
.veo .rwait em{font-style:normal;font-size:10.5px;font-weight:700;color:var(--ink3)}
/* OUR clock, once it has been days. A film nobody has acted on is a match whose players never got it. */
.veo .rwait em.alarm{color:var(--look)}
.veo .ractions{display:flex;gap:6px;justify-content:flex-end}
.veo .ractions .btn{padding:4px 9px;font-size:11px}
.veo .rrow .assign{padding:0 12px 12px}
.veo .rfoot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;font-size:11.5px;color:var(--ink3)}
.veo .empty{padding:26px 0;text-align:center;color:var(--ink3);font-size:13px}
.veo .warn{border:1px solid #f0c9bd;background:#fdeee9;color:var(--look);border-radius:9px;padding:9px 12px;font-size:12.5px;font-weight:600}
.veo .foot{margin:16px 0 0;font-size:11.5px;color:var(--ink3);line-height:1.5}
.veo code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--bg);padding:1px 4px;border-radius:4px}

@media (max-width:900px){
  .veo .rtop{grid-template-columns:minmax(0,1fr) 120px;row-gap:6px}
  .veo .rwait{grid-column:1;text-align:left}
  .veo .ractions{grid-column:2}
  .veo .tally{grid-template-columns:repeat(3,minmax(0,1fr))}
  .veo .viewer{grid-template-columns:1fr}
  .veo .rowtop{grid-template-columns:64px minmax(0,1fr) 40px 22px;row-gap:5px}
  .veo .code{display:none}
  .veo .pill{grid-column:2}
  .veo .pl{display:none}
}
`;
