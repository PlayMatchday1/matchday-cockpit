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

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import MatchSidePanel, { MATCH_SIDE_PANEL_CSS, type PanelTab } from "@/components/MatchSidePanel";
import { CITY_CODE_TO_DISPLAY } from "@/lib/scheduleReconcile";
import { parseVeoSubject, processingDateFromSlug, resolveMatchDates } from "@/lib/veo";
import {
  FILM_STATE_LABEL, TALLY_TILES, emptyTally, gapLabel, hasFilm, scoreTrace, tallyAddsUp, tileCount,
  type AssignCandidate, type EmojiOnlyMatch, type FilmState, type TallyTile, type VeoDayRecording,
  type VeoDayRow, type VeoDayTally,
} from "@/lib/veoDay";
import {
  ARRIVAL_ZONE, dayIn, RECENT_STATE_LABEL, RECENT_STATE_TONE, RECENT_TAB_LABEL, WAIT_ALARM_DAYS, daySourceOf, isResolved, lagDays,
  lagLabel, lagWorthSaying, tabOf, waitDays, waitLabel, type RecentState, type RecentTab,
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
  emojiMatches: EmojiOnlyMatch[];
  confinedCity: string | null;
};

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, cache: "no-store",
    headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
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
  /* THE FILTER IS A TILE, NOT A STATE. A tile can cover more than one state (auto posted is posted
   * + flagged), so the rows it shows are the union of its states. Rows in the four states no tile
   * covers still render with their own pills; they simply cannot be filtered to, which is the
   * stated cost of two tiles instead of seven. */
  const [filter, setFilter] = useState<TallyTile["key"] | null>(null);
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
  /* THE DEFAULT LIST IS THE FILMS. The parked rows are the coded matches nothing arrived for —
   * still one click away, because a genuine camera failure must be findable and an all-posted list
   * would never show it. */
  const withFilm = useMemo(() => cityRows.filter((r) => hasFilm(r.state)), [cityRows]);
  const parked = useMemo(() => cityRows.filter((r) => !hasFilm(r.state)), [cityRows]);
  const [showParked, setShowParked] = useState(false);
  const activeTile = TALLY_TILES.find((t) => t.key === filter) ?? null;
  const base = filter !== null || showParked ? cityRows : withFilm;
  const rows = useMemo(
    () => base.filter((r) => activeTile === null || activeTile.states.includes(r.state)),
    [base, activeTile],
  );
  /* ONE BUTTON, ONE NUMBER. The parked rows (coded fields nothing arrived for) and the emoji-only
   * matches (fields no code names at all) are two kinds of "no film" and were two different
   * controls, one of which was a paragraph you could not click. They open together now.
   * THE EMOJI ROWS ARE OUTSIDE THE TALLY — see the caption. Adding them here must not move it. */
  const emoji = useMemo(
    () => (data?.emojiMatches ?? []).filter((m) => city === "all" || (CITY_CODE_TO_DISPLAY[m.city ?? ""] ?? m.city) === city),
    [data, city],
  );
  const noFilmCount = parked.length + emoji.length;

  const isToday = date === todayIso();

  return (
    /* THE CONTENT SHRINKS WHEN THE PANEL OPENS, the way Gameday's board does. Without it the fixed
       600px panel simply covers the right of the page — including the chat control on the very
       candidate rows it was opened from, so a second candidate could not be reached at all. */
    <div className={`veo${panelMatch != null ? " paneled" : ""}`}>
      <style>{CSS}</style>

      <div className="head">
        <div>
          {/* THE PAGE IS ONE DAY AT A TIME, holding only the matches a camera was on. That was a
              subtitle; it says the same thing on every load, so it is a comment now. The date nav
              beside it and the rows below already show both halves. */}
          <h1 className="h1">Veo</h1>
        </div>
        <div className="nav">
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

      {/* SEVEN DAYS YOU CAN SEE, instead of two arrows that moved one day at a time and told you
          nothing about any other day. The address bar still carries ?date= and nothing navigates —
          same replaceState as before. */}
      <WeekStrip date={date} onPick={setDate} />

      {/* TWO TILES, AND THE TALLY IS STILL THE FILTER. Clicking one narrows the list to its states;
          clicking it again clears. Of the seven that were here, four read zero on the day this was
          cut and a fifth was the total of the other six. What each dropped tile became is written
          over TALLY_TILES in veoDay.ts. */}
      <div className="tally" data-testid="veo-tally">
        {TALLY_TILES.map((t) => (
          <button
            key={t.key}
            type="button"
            data-testid={`veo-tal-${t.key}`}
            data-count={tileCount(shownTally, t)}
            className={`tal ${t.key === "auto" ? "ok" : "hand"}${filter === t.key ? " on" : ""}`}
            onClick={() => { setFilter(filter === t.key ? null : t.key); setOpenId(null); }}
          >
            <b>{tileCount(shownTally, t)}</b>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* THE CHECK SURVIVES THE STRIP. It used to have a visual proof — all five states plus the
          total, adding up by eye — and that is genuinely lost. It is now an internal assertion with
          a VISIBLE FAILURE, which is why this must not be tidied away with the tiles: tallyAddsUp
          still sums all six FILM_STATES, so a miscount still surfaces here. */}
      {data && !tallyAddsUp(shownTally) && (
        <p className="warn" data-testid="veo-tally-broken">
          The film states do not add to the total — this page is miscounting and should not be trusted.
        </p>
      )}

      {/* PARKED, NOT DELETED. One line, default closed — and it now opens BOTH kinds of "no film". */}
      {!loading && !err && noFilmCount > 0 && filter === null && (
        <p className="parked" data-testid="veo-parked">
          <button type="button" data-testid="veo-parked-toggle" onClick={() => setShowParked(!showParked)}>
            {showParked ? "Hide" : "Show"} {noFilmCount} match{noFilmCount === 1 ? "" : "es"} with no film
          </button>
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
              onOpenChat={(apiId) => { setPanelTab("chat"); setPanelMatch(apiId); }}
              open={assignId === u.id}
              onToggle={() => setAssignId(assignId === u.id ? null : u.id)}
              onDone={() => { setAssignId(null); void load(date); }}
            />
          ))}
        </div>
      )}

      {/* THE GAP BETWEEN THE EMOJI AND THE CODE TABLE, SHOWN RATHER THAN ASSERTED. This was a
          paragraph at the foot of the page describing rows it did not show, so there was nothing to
          click and no way to check whether the claim was true — and the payload only carried a
          count, so nothing downstream COULD have shown them.
          THE SELECTOR HAS NOT CHANGED. /api/veo/day is emphatic that the code table decides this
          page and hasCameraEmoji is deliberately not the selector. This is a second, clearly
          labelled group outside the tally, not the emoji becoming the rule.
          NO STATE PILL, because these have no film state to be in, and one action: open the match. */}
      {showParked && emoji.length > 0 && (
        <div className="emojigrp" data-testid="veo-emoji-group">
          <h4>{emoji.length} match{emoji.length === 1 ? "" : "es"} named with 🎥 that no camera can film</h4>
          {emoji.map((m) => (
            <div className="erow" data-testid="veo-emoji-row" data-api-id={m.apiId} key={m.apiId}>
              <span className="etime">{m.time.label}</span>
              <span className="ename"><b>{m.name}</b><small>{m.venue ?? "no field"}{m.city ? ` · ${CITY_CODE_TO_DISPLAY[m.city] ?? m.city}` : ""}</small></span>
              <a className="btn" data-testid="veo-emoji-open" href={`/match-ops/matches/${m.apiId}`}>Open match</a>
            </div>
          ))}
        </div>
      )}

      {/* THE SECOND AXIS. Everything above is indexed by the day a match was PLAYED; this is the
          same recordings ordered by when the FILM ARRIVED. It is day-independent on purpose — it
          does not refetch when the day nav moves, because a film that landed today for last Tuesday
          is exactly what you cannot find by walking the days. */}
      <RecentlyUploaded city={city} onOpenChat={(apiId) => { setPanelTab("chat"); setPanelMatch(apiId); }} />

      {/* The same panel, the same two tabs, the same ChatPane. The Veo page has no CRM dock to
          collapse and no sibling list to step through, so it passes neither — the component assumes
          neither either. */}
      {panelMatch != null && (
        <MatchSidePanel matchId={panelMatch} width={600} tab={panelTab}
          onTab={setPanelTab} onClose={() => setPanelMatch(null)} />
      )}

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
  parsedTimeMinutes: number | null; slug: string; city: string | null;
  match: { apiId: number; name: string; venue: string | null; city: string | null; day: string | null } | null;
};

/* ── RE-READING THE TITLE, WHICH IS NOT THE SAME AS RE-DECIDING THE RECORDING ──────────────────
 * Ryan: "nothing to assign when i click it". Every queued row, not one. Assign opened onto "The
 * title gave no date, so there is no day to offer matches from" and offered only Not our film — the
 * one control that exists for rescuing a film could not rescue anything.
 *
 * Nothing was broken in the parser. The row rendered the parse STORED WHEN THE FILM ARRIVED, and
 * these rows arrived before the parser learned their shapes. "PRUMC |SEP 3 | 7 :00pm" is stored as
 * unparseable_subject with a null date; today's parser reads it fine. The page was showing
 * yesterday's verdict as though it were today's answer.
 *
 * So the title is read again, IN MEMORY, when the row renders — for what it shows and what Assign
 * offers. IT WRITES NOTHING: no update to the row, no status, no queue_reason, no post. The stored
 * decision stays frozen, because those films were posted into their chats by hand and reprocessing
 * them would put a second copy in front of players. The only thing that ever posts is a person
 * picking one film and one match and confirming.
 *
 * The year comes from the slug's processing date, exactly as it does at ingest — a title carries a
 * month and a day and never a year. */
export type Reread = { code: string; date: string | null; timeMinutes: number | null; timeLabel: string | null };

export function rereadTitle(subject: string | null, slug: string): Reread | null {
  const p = parseVeoSubject(subject);
  if (!p.ok) return null;
  const dates = resolveMatchDates(p.value, processingDateFromSlug(slug));
  const t = p.value.timeOptions[0] ?? null;
  return {
    code: p.value.code,
    date: dates[0] ?? null,
    // A bare 12-hour time carries TWO options and the schedule picks between them. For display and
    // for the gap the first (PM) is used, and `ampmKnown` is why it is not presented as certain.
    timeMinutes: p.value.ampmKnown && t ? t.minutes : t ? t.minutes : null,
    timeLabel: t ? t.label : null,
  };
}

/* ── THE WEEK STRIP ──────────────────────────────────────────────────────────────────────────
 * Ryan: "Instead of day selector at top it should be more like calendar with easy change the days."
 * Two arrows meant four clicks to reach last Thursday and no idea what was on any day you passed.
 *
 * EACH CHIP IS TWO BLOCKS, NOT INLINE SPANS. As inline spans inside a centred button, "MON" and "8"
 * concatenate into MON8 — which is what the first mock shipped and the whole of what looked wrong.
 * `display:block` on each, different size, different weight.
 *
 * ── THERE IS NO COUNT, AND THAT IS A MEASUREMENT RATHER THAN A SHORTCUT ──────────────────────
 * The design called for a per-day count of films still needing a person. I built the route, ran it,
 * and took it out again. Measured on production 2026-09-11:
 *
 *     156 queued recordings · only 33 carry a parsed_match_date at all
 *     queued-with-a-date in the viewed week (Sep 7-13): ZERO — the most recent is Aug 30
 *
 * So the number that was cheap to compute is empty on the week anyone is actually looking at. The
 * work is overwhelmingly in films whose title carried no date — the 96 unparseable_subject rows and
 * their kin — and those belong to NO day, which is exactly why the Recently Uploaded queue is
 * cross-day. A row of empty pills would point at nothing while costing a request per week change.
 *
 * The honest count is tally()'s "needs you", and that runs over buildDayRows: seven days of joins
 * to draw a navigation control. The brief called shipping dates with no counts "a perfectly good
 * outcome" and the data agrees. If this is revisited, the number to compute is the one the label
 * claims — not the one that happens to be one query away. */
function WeekStrip({ date, onPick }: { date: string; onPick: (d: string) => void }) {
  const today = todayIso();
  // Monday-first, from the selected day's own week.
  const monday = useMemo(() => {
    const [y, m, d] = date.split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
    return shiftDate(date, -((dow + 6) % 7));
  }, [date]);
  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDate(monday, i)), [monday]);

  return (
    <div className="wk" data-testid="veo-week">
      {week.map((d) => {
        const dow = new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay();
        return (
          <button
            key={d}
            type="button"
            data-testid={`veo-day-${d}`}
            data-selected={d === date ? "1" : "0"}
            data-today={d === today ? "1" : "0"}
            aria-current={d === date ? "date" : undefined}
            className={`wd${d === date ? " on" : ""}${d === today ? " today" : ""}`}
            onClick={() => onPick(d)}
          >
            <span className="dw">{["SUN","MON","TUE","WED","THU","FRI","SAT"][dow]}</span>
            <span className="dn">{Number(d.slice(8, 10))}</span>
          </button>
        );
      })}
      <span className="wsp" />
      <button type="button" className="nb" data-testid="veo-prev-week"
        onClick={() => onPick(shiftDate(date, -7))}>‹ Prev week</button>
      <button type="button" className="nb" data-testid="veo-today" onClick={() => onPick(today)}>Today</button>
      <button type="button" className="nb" data-testid="veo-next-week"
        onClick={() => onPick(shiftDate(date, 7))}>Next week ›</button>
    </div>
  );
}

/* ── queue_reason IS AN ENUM AND IT IS PRINTED TO A PERSON ────────────────────────────────────
 * "unknown_code" is a database value. It appears on the collapsed row and, before this, in the
 * parse strip. Every phrasing below is for a value MEASURED in production on 2026-09-11 across all
 * 236 veo_recordings rows — nothing here is invented for a value nobody has seen:
 *
 *     unparseable_subject  96    unknown_code     27    multiple_matches  14
 *     (null)               80    field_mismatch   19
 *
 * post_failed is written by /api/veo/inbound and has never occurred, so it gets no hand-written
 * phrasing. It falls through to the generic branch, which un-snakes the value rather than either
 * inventing a sentence for it or printing the raw enum. */
const QUEUE_REASON_LABEL: Record<string, string> = {
  unparseable_subject: "the title could not be read",
  unknown_code: "no field code in the title",
  field_mismatch: "the field code did not match this day",
  multiple_matches: "more than one match fitted",
};

export function queueReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return QUEUE_REASON_LABEL[reason] ?? reason.replace(/_/g, " ");
}

/* ── A CAMERA STAMP IS NOT A MATCH DATE OR TIME ──────────────────────────────────────────────
 * "Untitled recording 2026-09-11_01-11-51" is the camera naming a film nobody titled, and the stamp
 * is NOT a Central wall clock. Measured on production 2026-09-11 across all 30 recordings of that
 * shape, against their email's received_at (a true instant):
 *
 *     read as UTC      the email arrives AFTER the stamp in 30 of 30 (shortest gap 133 min)
 *     read as Central  the email arrives BEFORE the recording in 19 of 30 — impossible
 *
 * So the zone is UTC or east of it — UNKNOWN which; the recording page on app.veo.co carries no
 * timestamp to settle it. rereadTitle reads this row as "Friday, September 11 · 11:00 PM" when the
 * film was almost certainly the Thursday evening, so the Assign panel must not use that date to pick
 * the day, nor that time to rank candidates, nor print either as "read as". It asks for the day, as
 * it already does for any title with no readable date.
 *
 * rereadTitle itself is untouched (it is on the must-not-change list), and so is the collapsed row's
 * sentence — which still prints the misread. Stated in the report, not fixed here. */
const CAMERA_STAMP = /^untitled recording \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\b/i;

export function isCameraStamp(subject: string | null | undefined): boolean {
  return CAMERA_STAMP.test(subject ?? "");
}

const arrivedLabel = (iso: string | null): string => {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "—";
  // The arrival is a TRUE INSTANT, so it is rendered in a named zone rather than in UTC — the
  // opposite of the match dates above, which are wall clocks. See src/lib/veoRecent.ts.
  return new Date(Date.parse(iso)).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: ARRIVAL_ZONE,
  });
};

function RecentlyUploaded({ city, onOpenChat }: { city: string; onOpenChat: (apiId: number) => void }) {
  const [rows, setRows] = useState<RecentRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /* NEEDS YOU IS THE DEFAULT. The tab is a URL parameter, so a link to Done survives a refresh and
   * can be sent to somebody; an unrecognised value falls back to Needs you rather than erroring. */
  const [tab, setTabState] = useState<RecentTab>(() => {
    if (typeof window === "undefined") return "needs";
    return new URLSearchParams(window.location.search).get("veo") === "done" ? "done" : "needs";
  });
  const setTab = (t: RecentTab) => {
    setTabState(t);
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (t === "done") u.searchParams.set("veo", "done"); else u.searchParams.delete("veo");
    window.history.replaceState(null, "", u.toString());
  };
  const [counts, setCounts] = useState<Record<RecentTab, number> | null>(null);
  const [limit, setLimit] = useState(30);
  const [more, setMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  /* ONE REQUEST FOR THE WHOLE LIST, FROM HERE — not one per row. Ryan: "I need to be able to see
   * the videos so i can decide where it goes. Anything untitled i have no idea." Thirty rows each
   * calling /api/veo/thumb is thirty browser requests and thirty serverless invocations for one
   * screen; /api/veo/thumbs takes the ids and scrapes them in parallel behind one call.
   *
   * IT RUNS AFTER THE LIST, NOT WITH IT. The posters are an aid to scanning, not the list itself,
   * so the rows render immediately and the pictures arrive when they arrive. veo_recordings has no
   * thumbnail column — measured — so a first-time poster costs an external page fetch, and making
   * the list wait on that would trade a real delay for a cosmetic gain. */
  const [posters, setPosters] = useState<Record<string, string | null>>({});

  useEffect(() => {
    let live = true;
    setLoading(true); setErr(null);
    void (async () => {
      try {
        const q = new URLSearchParams({ limit: String(limit), tab });
        if (city !== "all") q.set("city", city);
        const res = await authFetch(`/api/veo/recent?${q.toString()}`);
        const j = await res.json();
        if (!live) return;
        if (!res.ok) { setErr(j?.error || `Load failed (${res.status})`); setRows([]); return; }
        setRows(j.rows as RecentRow[]);
        /* THE COUNTS COME FROM THE ROUTE, off the same scoped array the rows come from — never
           counted here from `rows`, which is one tab and one page of it. A confined operator's
           number has to match a list this component cannot see all of. */
        setCounts((j.counts as Record<RecentTab, number>) ?? null);
        setMore(j.more === true);
      } catch (e) {
        if (live) { setErr(e instanceof Error ? e.message : String(e)); setRows([]); }
      } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [limit, tab, city, nonce]);

  const shown = rows ?? [];

  /* Keyed on the ids on screen, so paging with "Load 30 more" fetches only the new ones — the
   * route's own cache makes the already-seen ids free anyway, but this avoids re-sending them. */
  const shownIds = shown.map((r) => r.id).join(",");
  useEffect(() => {
    if (!shownIds) return;
    let live = true;
    void (async () => {
      try {
        const res = await authFetch(`/api/veo/thumbs?ids=${encodeURIComponent(shownIds)}`);
        if (!res.ok) return;
        const j = await res.json();
        const next: Record<string, string | null> = {};
        for (const [id, v] of Object.entries((j.thumbs ?? {}) as Record<string, { thumbnail: string | null }>)) {
          next[id] = v?.thumbnail ?? null;
        }
        if (live) setPosters((p) => ({ ...p, ...next }));
      } catch { /* no poster is a box, not an error — see RecentRowView */ }
    })();
    return () => { live = false; };
  }, [shownIds]);

  return (
    <section className="recent" data-testid="veo-recent">
      <div className="rhead">
        <div>
          {/* EVERY FILM THAT HAS ARRIVED, newest arrival first, whatever day it was played on.
              That was the subtitle. It never changed, so it lives here instead. */}
          <h3>Recently uploaded</h3>
        </div>
        {/* TWO TABS, NOT A FILTER OVER ONE LIST. Measured on the nine live rows for Sep 6, in the
            page's own order: the first row wanting a person was 8th of 9, five finished rows sat
            above it, and two more that also wanted a person (Posted, flagged) were buried at
            positions 5 and 6 between the finished ones. The work was interleaved, not merely low.
            BOTH TABS CARRY A COUNT, and that is what makes the split worth building: an operator
            can tell from the top of the page that there is nothing to do without opening anything.
            A tab with no number is a tab you still have to click. */}
        <div className="rfilter" role="tablist">
          {(["needs", "done"] as RecentTab[]).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t}
              data-testid={`veo-recent-tab-${t}`} data-count={counts?.[t] ?? ""}
              className={tab === t ? "on" : ""}
              onClick={() => { setTab(t); setLimit(30); setOpenId(null); }}>
              {RECENT_TAB_LABEL[t]}
              {/* CALM, NOT AN ALARM. A zero here is the good news, and it is the whole message the
                  empty list needs — which is why the empty state says nothing at all. */}
              {counts && <em className="tcount">{counts[t]}</em>}
            </button>
          ))}
        </div>
      </div>

      {loading && !rows && <p className="empty">Loading arrivals…</p>}
      {err && <p className="warn" data-testid="veo-recent-error">{err}</p>}
      {/* THE EMPTY STATE SAYS NOTHING. The 0 on the tab is the message; a sentence under it would
          repeat the number in words on every load. The node stays for the layout and the testid. */}
      {rows && shown.length === 0 && !err && <div className="empty" data-testid="veo-recent-empty" />}

      {/* TWINS: two rows carrying the identical title, 17 minutes apart on the live page. If it is
          one film, assigning both puts two links in one chat — so each warns about the other, here
          and again on the confirm. WARN, DO NOT BLOCK: overriding it is legitimate, and so is the
          case where they really are two different films. */}
      {shown.map((r) => <RecentRowView key={r.id} r={r} open={openId === r.id}
        onOpenChat={onOpenChat} poster={posters[r.id]}
        twins={shown.filter((x) => x.id !== r.id && x.subject === r.subject).length}
        onToggle={() => setOpenId(openId === r.id ? null : r.id)}
        onDone={() => { setOpenId(null); setNonce((n) => n + 1); }} />)}

      {/* DERIVED FROM THE ROWS ON SCREEN, so it follows the filter rather than describing the table. */}
      {rows && shown.length > 0 && (
        <div className="rfoot">
          <span data-testid="veo-recent-count">
            {shown.length} of {counts?.[tab] ?? shown.length} shown
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

function RecentRowView({ r, open, onToggle, onDone, twins, onOpenChat, poster }: {
  r: RecentRow; open: boolean; onToggle: () => void; onDone: () => void; twins: number;
  onOpenChat: (apiId: number) => void;
  /* undefined = not fetched yet · null = fetched, this film has no published still frame. Both
     render the SAME empty box, so a row never changes height when the picture lands. */
  poster?: string | null;
}) {
  const matchDay = r.match?.day ?? null;
  // Read again, in memory. See rereadTitle: display and Assign only, never a write.
  const reread = useMemo(() => rereadTitle(r.subject, r.slug), [r.subject, r.slug]);
  const rereadRescues = !r.parsedMatchDate && !matchDay && Boolean(reread?.date);
  const source = daySourceOf(matchDay, r.parsedMatchDate ?? reread?.date ?? null);
  const day = matchDay ?? r.parsedMatchDate ?? reread?.date ?? null;
  const lag = lagDays(r.receivedAt, day);
  const wait = isResolved(r.state) ? null : waitDays(r.receivedAt);

  /* THE X, AND ITS UNDO. Dismiss and un-dismiss are the same two routes the panel already uses;
   * nothing new is written and nothing is destroyed. The row is replaced in place by a strip that
   * names the film and says what was kept, so nothing disappears without a trace. */
  const [dismissed, setDismissed] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  /* THE STRIP IS AN IN-SESSION AFFORDANCE AND LETS GO WHEN THE LIST REFRESHES. React keeps this
   * component across a refetch because the key is the row id, so without this the strip outlived
   * the data behind it: under "All" the row came back as Dismissed and still rendered as an undo
   * strip with no state pill. */
  useEffect(() => { setDismissed(false); }, [r.state]);
  const [dismissErr, setDismissErr] = useState<string | null>(null);
  /* CONFIRM. One boolean, one route, and the list refetches so the row moves to Done as Posted —
   * it does not vanish locally, because a row that leaves the screen without the server agreeing
   * is a lie the next refresh corrects. */
  const [confirming, setConfirming] = useState(false);
  const confirmFlag = async () => {
    if (confirming) return;
    setConfirming(true); setDismissErr(null);
    try {
      await call({ method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagged: false }) }, "/flag");
      onDone();
    } catch (e) { setDismissErr(e instanceof Error ? e.message : String(e)); }
    finally { setConfirming(false); }
  };
  const call = async (init: RequestInit, suffix = "") => {
    const res = await authFetch(`/api/veo/${r.id}${suffix}`, init);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  };
  const dismissRow = async () => {
    if (dismissing) return;
    setDismissing(true); setDismissErr(null);
    try { await call({ method: "DELETE" }); setDismissed(true); }
    catch (e) { setDismissErr(e instanceof Error ? e.message : String(e)); }
    finally { setDismissing(false); }
  };
  /* UNDO PUTS IT BACK WITH THE REASON IT HAD. It is a status change and nothing else: no post, no
   * re-decision, no touching parsed_match_date. */
  const undo = async () => {
    if (dismissing) return;
    setDismissing(true); setDismissErr(null);
    try {
      await call({ method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "queued", queue_reason: r.queueReason }) });
      setDismissed(false);
    } catch (e) { setDismissErr(e instanceof Error ? e.message : String(e)); }
    finally { setDismissing(false); }
  };

  if (dismissed) {
    return (
      <div className="rrow gone" data-testid="veo-recent-dismissed" data-recording-id={r.id}>
        {/* THE FILM AND ITS HISTORY ARE KEPT — a dismiss is a status change, not a deletion, and
            the row is still there under Done marked Dismissed. That was a sentence on every strip;
            what is left names the film, which is the part that changes. */}
        <span className="upsub"><b>{r.subject ?? r.recordingId}</b> is off the list.</span>
        {dismissErr && <span className="upwhy">{dismissErr}</span>}
        <button type="button" className="btn" data-testid="veo-recent-undo" disabled={dismissing} onClick={() => void undo()}>Undo</button>
      </div>
    );
  }

  return (
    /* A DONE ROW IS THE SAME ROW WITH LESS INK — same controls, same testids, lighter title and a
       plainer ground. `data-tab` is what the CSS scopes on, so a Needs you row is untouched. */
    <div className={`rrow ${RECENT_STATE_TONE[r.state]}${open ? " open" : ""}${tabOf(r.state) === "done" ? " done" : ""}`}
      data-testid="veo-recent-row" data-state={r.state} data-tab={tabOf(r.state)} data-recording-id={r.id}>
      <div className="rtop">
        {/* THE FILM, ON THE COLLAPSED ROW. 88px, 16:9, reusing the stage's own .thumb rules rather
            than a second set — a grid track auto-sizing to an image is the bug that bit the field
            cover, so the box is sized and the image is absolutely positioned inside it.
            NO PLAY TRIANGLE. This is a picture of the film, not a control: pressing it opens the
            row, exactly like Assign, and the film plays in the panel. A triangle here would promise
            a play that does not happen. */}
        <span className="qpo thumb" data-testid="veo-recent-poster" data-has={poster ? "1" : "0"}
          onClick={onToggle} aria-hidden>
          {poster
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={poster} alt="" data-testid="veo-recent-poster-img" />
            : null}
        </span>
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
              /* WHAT IT READS NOW, AND WHAT IT WAS QUEUED AS — both, never one. The operator needs
                 to see it is readable today; the struck-through reason is how anyone later knows
                 what the parser used to do. The stored reason is NOT overwritten to make the row
                 tidy — nothing on this page writes. */
              : rereadRescues && reread
                ? <span data-testid="veo-recent-reread">
                    reads now as <b>{reread.code}</b> · {longDate(reread.date as string)}{reread.timeLabel ? ` · ${reread.timeLabel}` : ""}
                    {r.queueReason && <> · queued on arrival as <s data-testid="veo-recent-was">{queueReasonLabel(r.queueReason)}</s>, before the parser learned this shape</>}
                  </span>
                : <>went nowhere{r.queueReason ? ` · ${queueReasonLabel(r.queueReason)}` : ""}{day ? ` · for ${day}` : ""}</>}
            {twins > 0 && (
              <em className="twin" data-testid="veo-recent-twin"> · {twins} other on this page has the same title</em>
            )}
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
          {/* VIEW DAY IS GONE. Ryan: "we can completely remove the view day which is crap". It
              full-page navigated away from the queue you were working, to reach a day that is now
              one chip in the week strip. */}
          {/* THE THREAD IT LANDED IN. The row already names the match; this is looking at where.
              A queued row with no match gets none — there is no thread to open yet. */}
          {r.match && (
            <button type="button" className="btn" data-testid="veo-recent-chat"
              aria-label={`Open the chat for ${r.match.name}`}
              onClick={() => onOpenChat(r.match!.apiId)}>Chat</button>
          )}
          {/* THE FLAG CLEAR. A flagged film posted on an inferred read, and until now there was no
              way to say it was right — the control existed and was `disabled`, with no route behind
              it. It clears one boolean; it posts nothing. See /api/veo/[id]/flag. */}
          {r.state === "flagged" && (
            <button type="button" className="btn go" data-testid="veo-recent-confirm" disabled={confirming}
              aria-label={`Confirm ${r.subject ?? r.recordingId} went to the right match`}
              onClick={() => void confirmFlag()}>{confirming ? "…" : "Confirm"}</button>
          )}
          {r.state === "queued" && (
            <>
              <button type="button" className="btn" data-testid="veo-recent-assign" onClick={onToggle}>
                {open ? "Close" : "Assign"}
              </button>
              {/* TAKES IT OFF THE LIST — it does not destroy anything. DELETE /api/veo/[id] already
                  means dismissed: the recording, its video_url and its history all stay, it just
                  stops asking to be assigned. Reversible in place, so no dialog: a confirm for
                  something undoable in one click is a tax, and the undo strip is a better guarantee
                  than the question was. */}
              <button type="button" className="btn x" data-testid="veo-recent-dismiss-x"
                aria-label="Take this film off the list" disabled={dismissing}
                onClick={() => void dismissRow()}>✕</button>
            </>
          )}
        </span>
      </div>
      {open && r.state === "queued" && (
        <RecentAssign r={r} onDone={onDone} day={day} twins={twins} onOpenChat={onOpenChat} />
      )}
    </div>
  );
}

/* ASSIGN FROM HERE TOO, using the day the recording belongs to rather than the day on screen —
 * a film found in this list is usually not from the day being viewed, which is why it is here. */
function RecentAssign({ r, onDone, day: readDay, twins, onOpenChat }: {
  r: RecentRow; onDone: () => void; day: string | null; twins: number; onOpenChat: (apiId: number) => void;
}) {
  const [dayData, setDayData] = useState<Payload | null>(null);
  // `confirming` moved into CandidateList — see its header. Three copies became none.
  const { busy, err, assign, dismiss } = useAssign(r.id, onDone);
  /* THE DAY COMES FROM THE RE-READ WHEN THE STORED PARSE HAS NONE. When even that reads nothing,
   * the operator picks the day — which is a perfectly good input the page simply never asked for.
   * Assign is no longer a control that opens onto nothing. */
  const [picked, setPicked] = useState<string | null>(null);
  // A camera stamp reads as a date and time that are not the match's — see isCameraStamp.
  const stamp = isCameraStamp(r.subject);
  const target = picked ?? (stamp ? null : readDay);
  const reread = useMemo(() => (stamp ? null : rereadTitle(r.subject, r.slug)), [stamp, r.subject, r.slug]);
  // The same number the collapsed row shows in veo-recent-wait, derived the same way.
  const wait = waitDays(r.receivedAt);
  /* A CODE ONLY COUNTS IF SOMETHING SAYS IT NAMES A FIELD. Two sources:
   *   - the ingest's stored code, UNLESS the ingest itself queued it as unknown_code — that is its
   *     verdict that the code resolved to no field. Measured: the untitled row stores parsed_code
   *     "UNTITLED RECORDING" with queue_reason unknown_code, and trusting it printed exactly that.
   *     A field_mismatch code is a real code on the wrong field, and it did read.
   *   - a re-read code that is one of the target day's own codes (VeoDayRow.code is the veo_codes
   *     code whose field_ids contain that match's field). */
  const codeRead = useMemo(() => {
    if (stamp) return null;
    if (r.parsedCode && r.queueReason !== "unknown_code") return r.parsedCode;
    const codes = new Set((dayData?.rows ?? []).map((x) => x.code));
    return reread?.code && codes.has(reread.code) ? reread.code : null;
  }, [stamp, r.parsedCode, r.queueReason, dayData, reread]);
  // The title's own time, re-read. Null when the title has none — the gap is then not invented.
  const titleMinutes = stamp ? null : (reread?.timeMinutes ?? r.parsedTimeMinutes ?? null);

  /* Days to offer when nothing reads: the day the film arrived and the three before it. Veo
   * processes overnight and the survey measured 18 same-day, 46 next-day and four at two to five,
   * so the match is almost always within that window of the arrival. */
  const nearby = useMemo(() => {
    const base = r.receivedAt ? dayIn(r.receivedAt) : null;
    if (!base) return [];
    return [0, -1, -2, -3].map((d) => shiftDate(base, d));
  }, [r.receivedAt]);

  useEffect(() => {
    if (!target) return;
    let live = true;
    setDayData(null);
    void (async () => {
      try {
        const res = await authFetch(`/api/veo/day?date=${target}`);
        const j = await res.json();
        if (live && res.ok) setDayData(j as Payload);
      } catch { /* the panel says it could not load the day */ }
    })();
    return () => { live = false; };
  }, [target]);

  const rec: VeoDayRecording = {
    id: r.id, recordingId: r.recordingId, subject: r.subject, videoUrl: r.videoUrl,
    receivedAt: r.receivedAt, status: "queued", queueReason: r.queueReason,
    matchedApiId: null, candidateApiIds: r.candidateApiIds, score: r.score, scoreParts: null,
    flagged: false, parsedCode: stamp ? null : (reread?.code ?? r.parsedCode), parsedMatchDate: r.parsedMatchDate,
    // THE RE-READ TIME, so the gap on each candidate is measured against what the title says today.
    parsedTimeLabel: reread?.timeLabel ?? null, parsedTimeMinutes: titleMinutes, postedByUserId: null,
  };

  return (
    <div className="assign" data-testid="veo-recent-panel">
      {twins > 0 && (
        <p className="warn" data-testid="veo-recent-twin-warn">
          {twins} other recording{twins === 1 ? "" : "s"} on this page carries the same title. If it is the same film,
          assigning both puts two links in one chat.
        </p>
      )}
      {/* NO DATE ANYWHERE: ask for one rather than dead-ending. */}
      {!target && (
        <div data-testid="veo-recent-picker">
          <h4>Which day was this?</h4>
          <p className="pnote">The title gives no date the parser can read. It arrived {r.receivedAt ? arrivedLabel(r.receivedAt) : "—"}.</p>
          <div className="pickdays">
            {nearby.map((d) => (
              <button type="button" key={d} className="btn" data-testid={`veo-recent-day-${d}`} onClick={() => setPicked(d)}>
                {longDate(d)}
              </button>
            ))}
          </div>
        </div>
      )}
      {target && !dayData && <p className="pnote">Loading {longDate(target)}…</p>}
      {target && dayData && (
        <>
          {picked && (
            <p className="pnote">
              Showing {longDate(target)} because you picked it.{" "}
              <button type="button" className="more" data-testid="veo-recent-repick" onClick={() => { setPicked(null); setDayData(null); }}>Choose another day</button>
            </p>
          )}
          {/* ── WHAT THE TITLE ACTUALLY READ, AS FACTS ────────────────────────────────────────
              Ryan: "Anything untitled i have no idea." Every chip here is data the page already
              held and never showed together. Three of them are the pieces that READ; the fourth is
              the one that did NOT, and it is marked differently because naming the missing piece is
              what turns "I have no idea" into a decision — when the date and time read and the
              field code did not, the candidate list is the whole day and you pick by time.

              A PIECE THAT READ FINE GETS A PLAIN CHIP AND NO APOLOGY, and a title that genuinely
              carried a code gets NO missing-code chip — three chips is then the right number.
              The raw queue_reason enum is never printed here.

              AN UNTITLED CAMERA STAMP READS NOTHING. It prints no "read as" date or time — the
              stamp is not the match's clock, see isCameraStamp — and gets two marked chips, not
              one: no field code, and no match date or time. */}
          <div className="parse" data-testid="veo-parse">
            {reread?.date && <span className="kv" data-testid="veo-parse-date">read as <b>{longDate(reread.date)}</b></span>}
            {reread?.timeLabel && <span className="kv" data-testid="veo-parse-time">read as <b>{reread.timeLabel}</b></span>}
            {/* Printing "read as UNTITLED RECORDING" — which the first build did, measured — is the
                page claiming to have read something it did not. See codeRead for what counts. */}
            {codeRead
              ? <span className="kv" data-testid="veo-parse-code">read as <b>{codeRead}</b></span>
              : <span className="kv miss" data-testid="veo-parse-nocode">no field code in the title</span>}
            {stamp
              ? <span className="kv miss" data-testid="veo-parse-notime">no match date or time in the title</span>
              : !reread && (
                <span className="kv miss" data-testid="veo-parse-none">
                  {queueReasonLabel(r.queueReason) ?? "the title could not be read"}
                </span>
              )}
            {wait != null && <span className="kv" data-testid="veo-parse-wait">{waitLabel(wait)}</span>}
          </div>

          {/* THE FILM, BESIDE THE CHOICE. The same player the day view uses — one player, not two. */}
          <div className="assignwrap" data-testid="veo-recent-assignwrap">
            <FilmPlayer rec={rec} fallbackTitle={r.subject ?? r.recordingId} />
            <div>
              <CandidateList rec={rec} data={dayData} busy={busy} twins={twins}
                onAssign={(apiId) => void assign(apiId)} onOpenChat={onOpenChat} />
            </div>
          </div>
        </>
      )}
      <div className="assignfoot">
        <button type="button" className="btn" data-testid="veo-recent-dismiss" disabled={busy} onClick={() => void dismiss()}>Not our film</button>
      </div>
      {err && <p className="warn">{err}</p>}
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
  const call = async (init: RequestInit, what: string, suffix = "") => {
    if (busy) return false;
    setBusy(true); setErr(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(`/api/veo/${recordingId}${suffix}`, {
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
    /* CONFIRM AN INFERRED PLACEMENT. One boolean on a route that cannot post — see
     * /api/veo/[id]/flag. It goes through the same one-attempt `call` as assign and dismiss, so it
     * cannot retry either. */
    clearFlag: () => call({ method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flagged: false }) }, "Confirm", "/flag"),
  };
}

/** The confirm, which names BOTH sides. This puts a video link in a chat real players read. */
function Confirm({ rec, target, busy, onCancel, onGo, twins = 0 }: {
  rec: VeoDayRecording; target: AssignCandidate; busy: boolean; onCancel: () => void; onGo: () => void; twins?: number;
}) {
  return (
    <div className="confirm" data-testid="veo-confirm">
      {twins > 0 && (
        <p className="warn" data-testid="veo-confirm-twin">
          {twins} other recording{twins === 1 ? "" : "s"} carries this same title. If it is the same film, this is a second link in that chat.
        </p>
      )}
      <p>
        Post <b>{rec.subject ?? rec.recordingId}</b> into{" "}
        <b>{target.name}, {target.time}{target.players != null ? `, ${target.players} players` : ""}</b>?
      </p>
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
/* THE CONFIRM LIVES HERE NOW, AND THAT IS THE WHOLE OF THE FIX. Ryan: "when i click the assign
 * button it doesnt even work" … "nevermind it does you have to click post it which is hard to see".
 * It was rendered after the panel's own footer — past every other candidate — so pressing Assign on
 * a candidate in the middle of a long list opened a confirm below the fold. The button read as
 * broken.
 *
 * Lifting `confirming` in here fixes three call sites at once: RecentAssign, Orphan and Viewer each
 * held an identical copy of the state and an identical `{confirming && <Confirm/>}` after their own
 * content. They now pass `onAssign` and render nothing.
 *
 * ONE CONFIRM AT A TIME, by construction: it is a single piece of state, so pressing Assign on a
 * second candidate MOVES it rather than opening a second. */
function CandidateList({ rec, data, busy, onAssign, onOpenChat, twins = 0 }: {
  rec: VeoDayRecording; data: Payload; busy: boolean; onAssign: (apiId: number) => void;
  onOpenChat?: (apiId: number) => void; twins?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const [confirming, setConfirming] = useState<AssignCandidate | null>(null);
  /* A CANDIDATE THAT LEFT THE LIST MUST NOT LEAVE ITS CONFIRM BEHIND. The day's candidates change
   * when the operator picks a different day inside RecentAssign. */
  useEffect(() => { setConfirming(null); }, [rec.id, data]);
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
    const row = (
      <div className={`cand${gap === "exact" ? " exact" : ""}`} data-testid={`veo-cand-${c.apiId}`} data-gap={gap ?? ""}>
        <span className="ct">{c.time}</span>
        <span className="cn">
          <b>{c.name}</b>
          <small>
            {c.venue} · {c.city}
            {/* INFORMATION, NOT A BLOCK. A person assigning by hand is the deliberate override. */}
            {!c.coded && <em data-testid="veo-cand-uncoded"> · no code names this field</em>}
          </small>
        </span>
        {/* NO TIME IN THE TITLE MEANS NO GAP. Not "0 min", not a guess — inventing a distance is
            the page pretending to know something it does not. */}
        <span className="cg">{gap ?? <em className="nogap">no time in the title</em>}</span>
        <span className="cf">{c.players ?? "—"}{c.capacity ? `/${c.capacity}` : ""}</span>
        {/* LOOK AT THE CHAT BEFORE POSTING INTO IT. Both production assigns so far dropped a second
            copy of a link somebody had already pasted by hand, and the automatic pre-assign thread
            scan is not built yet. This is that check, done by eye. It opens the thread and does NOT
            select the candidate or start an assign. */}
        {onOpenChat && (
          <button type="button" className="btn chatbtn" data-testid={`veo-cand-chat-${c.apiId}`}
            aria-label={`Open the chat for ${c.name}`}
            onClick={(e) => { e.stopPropagation(); onOpenChat(c.apiId); }}>Chat</button>
        )}
        <button type="button" className={`btn${gap === "exact" ? " pri" : ""}`} data-testid={`veo-assign-${c.apiId}`}
          disabled={busy} onClick={() => setConfirming(confirming?.apiId === c.apiId ? null : c)}>Assign</button>
      </div>
    );
    /* IMMEDIATELY UNDER THE ROW WHOSE ASSIGN WAS PRESSED — a fragment, so the confirm is a sibling
     * of the .cand rather than nested inside its grid. */
    if (confirming?.apiId !== c.apiId) return row;
    return (
      <Fragment key={`w-${c.apiId}`}>
        {row}
        <Confirm rec={rec} target={confirming} busy={busy} twins={twins}
          onCancel={() => setConfirming(null)} onGo={() => onAssign(confirming.apiId)} />
      </Fragment>
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

function Orphan({ u, data, open, onToggle, onDone, onOpenChat }: {
  u: VeoDayRecording;
  data: Payload;
  open: boolean;
  onToggle: () => void;
  onDone: () => void;
  onOpenChat: (apiId: number) => void;
}) {
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
          <CandidateList rec={u} data={data} busy={busy}
            onAssign={(apiId) => void assign(apiId)} onOpenChat={onOpenChat} />
          <div className="assignfoot">
            <button type="button" className="btn" data-testid="veo-dismiss" disabled={busy} onClick={() => void dismiss()}>Not our film</button>
          </div>
          {err && <p className="warn" data-testid="veo-assign-error">{err}</p>}
        </div>
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
      {/* THE EXPANDER AND THE CHAT CONTROL ARE SIBLINGS, NOT STACKED. Absolutely positioning the
          chat button over the row put it on top of the expander's own hit area, so it swallowed
          clicks meant for the row — caught because the browser suite could no longer expand a row
          that has a film. A button cannot nest inside a button, so they share a flex wrapper. */}
      <div className="rowline">
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
      {/* ON THE ROW, not only inside it. Checking where a film landed should not cost an expand.
          Only a row with a film gets it: a match with no film has a chat, but nothing to check on —
          and with the default above those rows are parked anyway. It opens the identical panel, tab
          and thread as the control inside the row. */}
      {hasFilm(r.state) && (
        <button type="button" className="rowchat" data-testid="veo-rowchat"
          aria-label={`Open the chat for ${r.name}`}
          onClick={() => onOpenChat(r.apiId)}>Chat</button>
      )}
      </div>
      {open && <Viewer r={r} data={data} onDone={onDone} onOpenChat={onOpenChat} />}
    </div>
  );
}

/* ── THE FILM, IN ONE PLACE ────────────────────────────────────────────────────────────────────
 * Lifted out of the day-view panel so the ASSIGN panel can show the same film beside the candidate
 * list. There is one player, not two: the day view is where watching is a convenience, and the
 * assign panel is where it is often the only evidence there is — 24 untitled recordings carry no
 * venue and no date, and two identical PRUMC titles seventeen minutes apart cannot be told apart
 * from a list at all. Ten seconds of each answers it.
 *
 * NOTHING LOADS UNTIL THE CLICK, which matters more here than on the day view: this list is long
 * and each film is about two gigabytes. */
function FilmPlayer({ rec, fallbackTitle }: { rec: VeoDayRecording | null; fallbackTitle: string }) {
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

  return (
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
            <b data-testid="veo-rec-subject">{rec.subject ?? fallbackTitle}</b>
            <span className="rid">{rec.recordingId}</span>
          </div>
          {/* THE LINK IS A CONTROL AND SURVIVES; THE SENTENCE AROUND IT DOES NOT. It used to read
              that the film streams from Veo's CDN, about 1.8 GB a match, with only the part you
              watch fetched — true on every recording, every day, so it is a comment now. Veo's own
              page has the tactical tools and the highlights; this page is for checking in on a
              match in ten seconds.
              THE TWO FAILURE STATES STILL SAY SOMETHING, because a player that shows nothing and
              says nothing is worse than a sentence. They keep a SHORT status beside the link — a
              condition that is true of this recording right now, which is data, not standing prose.
              All three branches keep veo-open-in-veo. */}
          <p className="pnote pplay">
            {videoFailed && <em data-testid="veo-play-state">Would not play — Veo may still be processing it</em>}
            {!videoFailed && !video && <em data-testid="veo-play-state">No playable file yet</em>}
            <a className="btn" href={rec.videoUrl} target="_blank" rel="noreferrer" data-testid="veo-open-in-veo">Open in Veo</a>
          </p>
        </>
      ) : (
        <div className="nofilm" data-testid="veo-no-film">
          <b>No film yet</b>
          <span>Nothing has arrived for this match.</span>
        </div>
      )}
    </div>
  );
}

function Viewer({ r, data, onDone, onOpenChat }: { r: VeoDayRow; data: Payload; onDone: () => void; onOpenChat: (apiId: number) => void }) {
  const rec = r.primary;
  const trace = scoreTrace(rec?.scoreParts ?? null);
  const posted = r.state === "posted" || r.state === "flagged" || r.state === "assigned";
  const [picking, setPicking] = useState(false);
  /* THE CANDIDATE CONFIRM MOVED INTO CandidateList, which renders it under the row that was
   * pressed. This one is a DIFFERENT question and stays: "Send to the chat" posts the film into
   * THIS row's own match, which is not a candidate in that list at all. It renders immediately
   * after the button that opens it, which is the same principle. */
  const [sending, setSending] = useState<AssignCandidate | null>(null);
  // Hooks are unconditional; the id is a placeholder when there is nothing to assign, and every
  // control that could call it is absent in that case.
  const { busy, err, assign, dismiss, clearFlag } = useAssign(rec?.id ?? "", onDone);
  const thisMatch = data.candidates[r.apiId] ?? null;
  return (
    <div className="viewer" data-testid="veo-viewer">
      <FilmPlayer rec={rec} fallbackTitle={`${r.code} · ${r.time}`} />

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
              {/* NO LONGER DISABLED. The page said a flagged film stays on the list "until somebody
                  says it is right" and gave nobody a way to say it; this is that way. It clears one
                  boolean and posts nothing. */}
              {r.state === "flagged" && (
                <button type="button" className="btn pri" data-testid="veo-clear-flag" disabled={busy}
                  onClick={() => void clearFlag()}>Right match, clear the flag</button>
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
                onClick={() => thisMatch && setSending(thisMatch)}
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
        {/* DIRECTLY UNDER THE BUTTON THAT OPENED IT, for the same reason the candidate confirm
            moved: a confirm rendered away from the click reads as a button that did nothing. */}
        {rec && sending && (
          <Confirm rec={rec} target={sending} busy={busy}
            onCancel={() => setSending(null)} onGo={() => void assign(sending.apiId)} />
        )}
        {/* THE POSTED NOTE IS GONE, BOTH BRANCHES. The pill already reads Posted or Posted,
            flagged, and a flagged row now carries a Confirm button in Recently uploaded, which
            says what to do about it better than a sentence could. */}
        {err && <p className="warn" data-testid="veo-assign-error">{err}</p>}
        {rec && !posted && picking && (
          <div className="assign" data-testid="veo-assign-panel">
            <CandidateList rec={rec} data={data} busy={busy}
              onAssign={(apiId) => void assign(apiId)} onOpenChat={onOpenChat} />
          </div>
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
            {/* THE THRESHOLDS, WHICH ARE REAL AND WORTH KEEPING IN THE FILE: 100 means nothing
                was guessed and it posted unflagged; 45 to 99 means it posted and stayed flagged for
                a person to confirm; under 45 nothing was sent at all. Three sentences that said
                that on screen are gone — the table above prints the number and its parts, and the
                pill says which side of the line it landed on. */
            }
          </div>
        )}
        {/* A NULL SCORE MEANS THE ROW WAS DECIDED BEFORE SCORING EXISTED, so there is no trace to
            show. Rendering nothing is the right answer: an absent table is already the whole
            message, and a sentence explaining an absence is read once and skipped forever. */
        }
        {rec?.queueReason && <p className="pnote">Queued as <code>{rec.queueReason}</code>.</p>}
      </div>
    </div>
  );
}

/* The panel's own rules, because this page is not `.gdo` and does not inherit Gameday's. */
const CSS = MATCH_SIDE_PANEL_CSS + `
.veo{--ink1:#0f1c17;--ink2:#3d5049;--ink3:#7c8f88;--line:#e3e9e6;--bg:#fbfcfc;
  --ok:#128a5c;--flag:#b8791f;--hand:#2f7d8f;--hold:#5b6b9e;--look:#c0563a;--none:#8a9691;
  padding:18px 20px 60px;max-width:1180px;margin:0 auto;color:var(--ink1);transition:padding-right .17s ease-out;
  font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.veo .head{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;justify-content:space-between;margin-bottom:14px}
.veo .h1{margin:0;font-size:23px;font-weight:800;letter-spacing:-.02em}
.veo .hsub{margin:3px 0 0;color:var(--ink3);font-size:13px}
.veo .nav{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
/* ── THE WEEK STRIP ─────────────────────────────────────────────────────────────────────────
   flex-wrap so a phone drops the nav buttons onto their own line instead of scrolling the page. */
.veo .wk{display:flex;gap:6px;align-items:stretch;margin:12px 0 10px;flex-wrap:wrap}
.veo .wd{min-width:66px;border:1px solid var(--line);background:#fff;border-radius:10px;
  padding:7px 9px 6px;cursor:pointer;text-align:center;line-height:1.15;position:relative;font:inherit;color:inherit}
.veo .wd:hover{background:var(--bg)}
/* THE THREE PIECES ARE BLOCKS. As inline spans they concatenate into MON812 — that shipped once
   already and is the whole of what looked wrong. Three lines, three sizes, three weights. */
.veo .wd .dw{display:block;font-size:9px;font-weight:800;letter-spacing:.1em;color:var(--ink3);text-transform:uppercase}
.veo .wd .dn{display:block;font-size:17px;font-weight:800;margin-top:3px;font-variant-numeric:tabular-nums}
/* SELECTED AND TODAY ARE DIFFERENT MARKS, because they are often the same day and often not:
   selected is a filled chip, today is a ring. A chip that is both wears both. */
.veo .wd.on{background:var(--ink1);border-color:var(--ink1);color:#fff}
.veo .wd.on .dw{color:#8fb5a3}
.veo .wd.today{border-color:var(--ok);box-shadow:inset 0 0 0 1px var(--ok)}
.veo .wsp{flex:1}
/* ── THE PARSE STRIP on the open assign panel ──────────────────────────────────────────────── */
.veo .parse{margin:0 0 12px;display:flex;gap:7px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--ink2)}
.veo .parse .kv{border:1px solid var(--line);background:var(--bg);border-radius:7px;padding:3px 9px}
.veo .parse .kv b{font-weight:800}
/* THE PIECE THAT DID NOT READ, marked. This is the chip that answers "I have no idea". */
.veo .parse .kv.miss{border-color:#f0cfc3;background:#fdf3ef;color:var(--look)}
@media (max-width:880px){
  .veo .wd{min-width:0;flex:1 1 44px;padding:6px 4px}
  .veo .nb{flex:1 1 auto}
  /* The poster stays, the columns stack — a 88px picture is still the fastest way to tell two
     untitled films apart on a phone. */
  .veo .rtop{grid-template-columns:88px minmax(0,1fr);row-gap:8px}
}
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

/* 612 = the panel's 600 plus its border and a hair of air. Below 1260 the panel is most of the
   screen anyway and the page scrolls behind it, which is what Gameday does too. */
@media (min-width:1260px){ .veo.paneled{padding-right:620px;max-width:none;margin:0} }
.veo .parked{margin:0 0 10px}
/* ── THE EMOJI GROUP. Outside the tally, and labelled as such by its own heading. ───────────── */
.veo .emojigrp{border:1px dashed var(--line2);border-radius:10px;padding:9px 11px 10px;margin:0 0 12px;background:var(--bg)}
.veo .emojigrp h4{margin:0 0 7px;font-size:12px;font-weight:800;color:var(--ink2)}
.veo .erow{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:10px;align-items:center;padding:5px 0;border-top:1px solid var(--line)}
.veo .erow:first-of-type{border-top:0}
.veo .etime{font-size:11.5px;font-weight:800;color:var(--ink2);font-variant-numeric:tabular-nums}
.veo .ename{display:flex;flex-direction:column;min-width:0}
.veo .ename b{font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.veo .ename small{font-size:11px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* THE PLAYER LINK IS A CONTROL and sits on its own line; the two failure states keep a short
   status beside it, because a player that shows nothing and says nothing is worse than a sentence. */
.veo .pplay{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.veo .pplay em{font-style:normal;font-size:11.5px;color:var(--ink3)}
.veo .parked button{border:1px dashed var(--line);background:#fff;border-radius:999px;padding:5px 12px;
  font-size:11.5px;font-weight:700;color:var(--ink3);cursor:pointer}
.veo .parked button:hover{color:var(--ink2);border-color:#c9d4cf}
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
.veo .rowline{display:flex;align-items:stretch}
.veo .rowline>.rowtop{flex:1;min-width:0}
.veo .rowchat{flex:0 0 auto;align-self:center;margin-right:11px;border:1px solid var(--line);background:#fff;border-radius:7px;
  padding:4px 10px;font-size:10.5px;font-weight:700;color:var(--ink2);cursor:pointer}
.veo .rowchat:hover{background:var(--bg)}

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
.veo .cand{display:grid;grid-template-columns:78px minmax(0,1fr) 96px 58px 58px 74px;gap:8px;align-items:center;
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
.veo .cand .cg .nogap{font-style:normal;color:var(--ink3);font-weight:600}
.veo .pickdays{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 4px}
.veo .rrow .warn{margin-bottom:8px}
.veo .twin{font-style:normal;color:var(--flag);font-weight:700}
.veo .cand .chatbtn{padding:4px 8px;font-size:11px}
/* THE FILM BESIDE THE CHOICE, not below it — it is evidence for a decision being made a few inches
   to its right. One column under 880px, where side-by-side stops being readable. */
.veo .assignwrap{display:grid;grid-template-columns:minmax(0,42fr) minmax(0,58fr);gap:14px;align-items:start}
@media (max-width:880px){ .veo .assignwrap{grid-template-columns:1fr} }
.veo .assignwrap .player{min-width:0}
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
/* THE COUNT ON THE TAB IS THE MESSAGE, and it is CALM. A zero here is the good news — nothing to
   do — so it gets no alarm colour and no red. It is the reason the empty list says nothing at all. */
.veo .rfilter .tcount{font-style:normal;margin-left:6px;font-size:10.5px;font-weight:800;color:var(--ink3);background:var(--bg);border-radius:999px;padding:1px 6px}
.veo .rfilter button.on .tcount{color:#fff;background:rgba(255,255,255,.18)}
.veo .rrow{border:1px solid var(--line);border-radius:10px;background:#fff;margin-bottom:6px;overflow:hidden}
/* THE ACTIONS TRACK SIZES TO ITS CONTENT. It was a fixed 132px, and two labels shrank and wrapped
   over two lines inside it, which made a flagged row 8px taller than every other row. The flexible
   track is the title and it is the one that gives, by truncating, as it already does. */
.veo .rtop{display:grid;grid-template-columns:88px 150px minmax(0,1fr) 118px 128px auto;gap:10px;align-items:center;padding:9px 12px}
/* THE POSTER ON A COLLAPSED ROW. 88px wide and 16:9 by aspect-ratio, so the box exists at its full
   height whether or not the picture ever lands — .qpo composes with .thumb, which already does
   position:relative + the absolutely-positioned img. A row with no still frame is the SAME HEIGHT
   as one with, which is the difference between a list and a ragged column. */
.veo .qpo{width:88px;border-radius:7px;cursor:pointer;align-self:center}
/* NO PLAY GLYPH HERE. The stage keeps its .play button; this is a picture, and pressing it opens
   the row. Stated in CSS as well as in the markup so a later "add a play button" has to delete a
   comment to do it. */
.veo .qpo .play{display:none}
.veo .rwhen{display:flex;flex-direction:column;min-width:0}
.veo .rwhen b{font-size:12.5px;font-weight:800;font-variant-numeric:tabular-nums}
.veo .rwhen em{font-style:normal;font-size:10.5px;font-weight:800;color:var(--flag)}
.veo .rwhat{display:flex;flex-direction:column;min-width:0}
.veo .rwhat b{font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.veo .rwhat small{color:var(--ink3);font-size:11px;overflow:hidden;text-overflow:ellipsis}
.veo .rwhat small s{opacity:.75}
.veo .rwait{text-align:right}
.veo .rwait em{font-style:normal;font-size:10.5px;font-weight:700;color:var(--ink3)}
/* OUR clock, once it has been days. A film nobody has acted on is a match whose players never got it. */
.veo .rwait em.alarm{color:var(--look)}
.veo .ractions{display:flex;gap:6px;justify-content:flex-end}
.veo .ractions .btn{padding:4px 9px;font-size:11px;white-space:nowrap}
.veo .ractions .btn.go{border-color:#8fbf9f;background:#eef8f1;color:#14512f;font-weight:800}
/* ── A DONE ROW IS QUIETER ─────────────────────────────────────────────────────────────────────
   Same row, same controls, less ink. Scoped to .done, so a Needs you row is untouched. */
.veo .rrow.done{background:var(--bg)}
.veo .rrow.done .rwhat b{font-weight:600;color:var(--ink2)}
/* AND THE LATENESS STOPS SHOUTING. "3 days late" in amber is right on a film nobody has placed and
   wrong on one that posted four days ago: an alarm about something nobody can act on. It stays on
   the row — it is still true — it just stops being an alarm. */
.veo .rrow.done .rwhen em{color:var(--ink3)}
.veo .rrow .assign{padding:0 12px 12px}
.veo .rrow .x{color:var(--look);font-weight:800;padding:4px 9px}
.veo .rrow.gone{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--bg);font-size:12.5px}
.veo .rrow.gone .upsub{flex:1;min-width:0;white-space:normal}
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
