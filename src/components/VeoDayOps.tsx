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
import {
  FILM_STATES, FILM_STATE_LABEL, scoreTrace, tallyAddsUp,
  type FilmState, type VeoDayRecording, type VeoDayRow, type VeoDayTally,
} from "@/lib/veoDay";

type Payload = {
  date: string;
  rows: VeoDayRow[];
  tally: VeoDayTally;
  unplaced: VeoDayRecording[];
  strays: Record<number, { apiId: number; name: string; fieldId: number | null; date: string | null }>;
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
  posted: "ok", flagged: "flag", held: "hold", needs_look: "look", no_film: "none",
};
const TALLY_LABEL: Record<FilmState, string> = {
  posted: "film posted",
  flagged: "posted, flagged",
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

  useEffect(() => { void load(date); setOpenId(null); }, [date, load]);

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
    const t: VeoDayTally = { posted: 0, flagged: 0, held: 0, needs_look: 0, no_film: 0, total: cityRows.length };
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
          <Row key={r.apiId} r={r} open={openId === r.apiId} onToggle={() => setOpenId(openId === r.apiId ? null : r.apiId)} />
        ))}
      </div>

      {/* Recordings that name this day and no match on it. They belong to the day — this is the
          review queue's content — but they cannot be a row against a match, and inventing one
          would break the tally above. */}
      {data && data.unplaced.length > 0 && (
        <div className="unplaced" data-testid="veo-unplaced">
          <h3>{data.unplaced.length} recording{data.unplaced.length === 1 ? "" : "s"} for this day with no row above</h3>
          {data.unplaced.map((u) => {
            const stray = u.matchedApiId != null ? data.strays[u.matchedApiId] : undefined;
            const uncoded = stray?.fieldId != null && !data.codedFields.includes(stray.fieldId);
            return (
              <div className="up" key={u.id}>
                <span className="upsub">{u.subject ?? u.recordingId}</span>
                {/* THE USEFUL VERSION OF "could not place". A posted recording went somewhere real;
                    if its match is missing from the page, the reason is the code table. */}
                {stray ? (
                  <span className={uncoded ? "upwhy" : "upnote"} data-testid="veo-stray">
                    {uncoded
                      ? `posted to match ${stray.apiId} on field ${stray.fieldId} — no veo_codes row names that field, so it cannot be a row here`
                      : `posted to match ${stray.apiId}${stray.date && stray.date !== data.date ? ` on ${stray.date}` : ""}`}
                  </span>
                ) : (
                  <span className="upwhy">{u.queueReason ?? u.status}</span>
                )}
                {u.videoUrl && <a className="btn" href={u.videoUrl} target="_blank" rel="noreferrer">Open in Veo</a>}
              </div>
            );
          })}
        </div>
      )}

      {data && data.emojiWithoutCode > 0 && (
        <p className="foot" data-testid="veo-emoji-gap">
          {data.emojiWithoutCode} match{data.emojiWithoutCode === 1 ? "" : "es"} on this day carr{data.emojiWithoutCode === 1 ? "ies" : "y"} the
          camera emoji in the name but sit{data.emojiWithoutCode === 1 ? "s" : ""} on a field no <code>veo_codes</code> row names, so no recording can
          arrive for {data.emojiWithoutCode === 1 ? "it" : "them"}. They are not listed above — the code table decides this page, not the emoji.
        </p>
      )}

      <p className="foot">
        A row is here because some <code>veo_codes</code> row names its field. A score appears only when it is below 100 —
        eight rows reading 100 say nothing eight times. A row with no score at all was decided before scoring existed.
      </p>
    </div>
  );
}

function Row({ r, open, onToggle }: { r: VeoDayRow; open: boolean; onToggle: () => void }) {
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
      {open && <Viewer r={r} />}
    </div>
  );
}

function Viewer({ r }: { r: VeoDayRow }) {
  const rec = r.primary;
  /* The still frame is fetched when the row opens, never with the day — a day of rows would be a
   * scrape of app.veo.co per row for pictures nobody had asked to see yet. */
  const [thumb, setThumb] = useState<string | null | undefined>(undefined);
  const recId = rec?.id ?? null;
  useEffect(() => {
    if (!recId) return;
    let live = true;
    void (async () => {
      try {
        const res = await authFetch(`/api/veo/thumb?id=${recId}`);
        const j = await res.json();
        if (live) setThumb(res.ok ? (j.thumbnail as string | null) : null);
      } catch { if (live) setThumb(null); }
    })();
    return () => { live = false; };
  }, [recId]);
  const trace = scoreTrace(rec?.scoreParts ?? null);
  const posted = r.state === "posted" || r.state === "flagged";
  return (
    <div className="viewer" data-testid="veo-viewer">
      <div className="player" data-testid="veo-player">
        {rec?.videoUrl ? (
          <>
            {/* NO IFRAME IS ATTEMPTED. Measured: app.veo.co sends x-frame-options: DENY and a
                frame-ancestors list this origin is not on. A thumbnail and a link is the whole of
                what is possible, so that is what ships. */}
            <div className="thumb">
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumb} alt="" data-testid="veo-thumb" />
              ) : (
                <span className="tnote" data-testid="veo-thumb-none">
                  {thumb === undefined ? "Loading the still frame…" : "No still frame published for this film."}
                </span>
              )}
              <span className="play" aria-hidden>▶</span>
            </div>
            <div className="pmeta">
              <b>{r.code} · {r.time}</b>
              <span className="rid">{rec.recordingId}</span>
            </div>
            <a className="btn pri" data-testid="veo-open-in-veo" href={rec.videoUrl} target="_blank" rel="noreferrer">Open in Veo</a>
            <p className="pnote">Veo refuses to be embedded (<code>x-frame-options: DENY</code>), so the film plays on their site.</p>
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
            a send button under a trace saying it has already sent is a control that lies. */}
        <div className="acts" data-testid="veo-actions">
          {posted ? (
            <>
              <button className="btn pri" disabled>Right match, clear the flag</button>
              <button className="btn" disabled>Wrong match, move it</button>
            </>
          ) : rec ? (
            <>
              <button className="btn pri" disabled>Send to the chat</button>
              <button className="btn" disabled>Different match</button>
            </>
          ) : (
            <span className="find" data-testid="veo-find-film">Find the film</span>
          )}
        </div>
        <p className="pnote">
          These are not wired yet — they are drawn disabled rather than shipped live, because every one of them writes
          a message into a chat players read.
        </p>

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

const CSS = `
.veo{--ink1:#0f1c17;--ink2:#3d5049;--ink3:#7c8f88;--line:#e3e9e6;--bg:#fbfcfc;
  --ok:#128a5c;--flag:#b8791f;--hold:#5b6b9e;--look:#c0563a;--none:#8a9691;
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

.veo .tally{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin:0 0 14px}
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
.veo .pl{font-size:12.5px;color:var(--ink2);font-variant-numeric:tabular-nums;text-align:right}
.veo .sc{font-size:12.5px;font-weight:800;color:var(--flag);font-variant-numeric:tabular-nums;text-align:right}
.veo .chev{color:var(--ink3);text-align:center}

.veo .viewer{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:16px;padding:0 13px 15px;border-top:1px solid var(--line);padding-top:14px}
.veo .player{display:flex;flex-direction:column;gap:9px}
.veo .thumb{position:relative;aspect-ratio:16/9;border-radius:10px;overflow:hidden;
  background:linear-gradient(160deg,#16211d,#0c130f);display:flex;align-items:center;justify-content:center}
.veo .thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.veo .tnote{color:rgba(255,255,255,.6);font-size:12px;padding:0 14px;text-align:center}
.veo .play{position:relative;width:54px;height:54px;border-radius:999px;background:rgba(12,19,15,.55);color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:19px;backdrop-filter:blur(2px)}
.veo .pmeta{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.veo .pmeta b{font-size:13px}
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
.veo .up{display:flex;align-items:center;gap:9px;padding:6px 0;border-top:1px solid var(--line);font-size:12.5px}
.veo .upsub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.veo .upwhy{color:var(--look);font-weight:700;font-size:11.5px;text-align:right}
.veo .upnote{color:var(--ink3);font-size:11.5px;text-align:right}
.veo .empty{padding:26px 0;text-align:center;color:var(--ink3);font-size:13px}
.veo .warn{border:1px solid #f0c9bd;background:#fdeee9;color:var(--look);border-radius:9px;padding:9px 12px;font-size:12.5px;font-weight:600}
.veo .foot{margin:16px 0 0;font-size:11.5px;color:var(--ink3);line-height:1.5}
.veo code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--bg);padding:1px 4px;border-radius:4px}

@media (max-width:900px){
  .veo .tally{grid-template-columns:repeat(3,minmax(0,1fr))}
  .veo .viewer{grid-template-columns:1fr}
  .veo .rowtop{grid-template-columns:64px minmax(0,1fr) 40px 22px;row-gap:5px}
  .veo .code{display:none}
  .veo .pill{grid-column:2}
  .veo .pl{display:none}
}
`;
