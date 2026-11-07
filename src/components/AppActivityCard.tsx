"use client";

// APP ACTIVITY card (Player Lookup, under the player card, above Credits). Figma 9TgSk4sYqq4nNoTH73wRRs
// frames 1 and 3. What the player's app sent to our servers, from the backend request log (0257),
// worded by src/lib/appActivity.ts.
//
// EXPAND RULES (frame 3): opens expanded when the player had a failure in the last 7 days, or when
// the page was opened with &activity=open (Player Chats' "See all"); otherwise collapsed to the
// summary line. A collapsed card with a recent failure shows it on the header line. Show/Hide is
// per player: the card is keyed by player id, so a choice does not carry to the next player.
//
// PRODUCTION ONLY on the deployed site (Ryan, 2026-11-06): no staging toggle. `env` is the page's
// own FULL_EDITOR_ENV, which is staging only under local `next dev` with NEXT_PUBLIC_DEV_MATCH_ENV.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  annotate, summarize, groupDays, recentFailure, matchLine, timeIn, shortStamp, engineeringText, FILTERS,
  type ActivityRow, type BackgroundHour, type Filter, type Item, type MatchInfo,
} from "@/lib/appActivity";
import { zoneOfCity } from "@/lib/matchTimezone";

const FALLBACK_TZ = "America/Chicago";
const RANGES = [
  { days: 1, label: "Last 24 hours", short: "24 hours" },
  { days: 7, label: "Last 7 days", short: "7 days" },
  { days: 30, label: "Last 30 days", short: "30 days" },
  { days: 90, label: "Last 90 days", short: "90 days" },
];
const KEPT_DAYS = 90;

async function authFetch(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" });
}

export type ActivityData = { rows: ActivityRow[]; background?: BackgroundHour[]; matches: Record<number, MatchInfo>; truncated: boolean; isAdmin: boolean; notes: string[] };
type Load = { phase: "loading" } | { phase: "error"; error: string } | { phase: "ok"; data: ActivityData; since: string };

export function useAppActivity(env: string, playerId: number | null, days: number) {
  const [state, setState] = useState<Load>({ phase: "loading" });
  const [extraDays, setExtraDays] = useState(0);
  useEffect(() => { setExtraDays(0); }, [playerId, days]);
  useEffect(() => {
    if (playerId == null) return;
    let live = true;
    setState((s) => (s.phase === "ok" ? s : { phase: "loading" }));
    const since = new Date(Date.now() - Math.min(days + extraDays, KEPT_DAYS) * 86_400_000).toISOString();
    authFetch(`/api/lookup/${env}/activity?id=${playerId}&since=${encodeURIComponent(since)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) setState({ phase: "error", error: j?.error || `Load failed (${r.status})` });
        else setState({ phase: "ok", data: j as ActivityData, since });
      })
      .catch((e) => { if (live) setState({ phase: "error", error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [env, playerId, days, extraDays]);
  const loadOlder = useCallback(() => setExtraDays((d) => d + days), [days]);
  return { state, loadOlder, spanDays: Math.min(days + extraDays, KEPT_DAYS) };
}

export default function AppActivityCard({ env, playerId, city, startOpen }: {
  env: string; playerId: number; city: string | null; startOpen: boolean;
}) {
  const [rangeIdx, setRangeIdx] = useState(2);
  const range = RANGES[rangeIdx];
  const { state, loadOlder, spanDays } = useAppActivity(env, playerId, range.days);
  const [open, setOpen] = useState<boolean | null>(startOpen ? true : null);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [shownBg, setShownBg] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<number | null>(null);

  const zone = zoneOfCity(city);
  const tz = zone ?? FALLBACK_TZ;
  const tzNote = zone ? `Times in ${city} time` : `Times in Central time${city ? ` (no zone for ${city})` : " (no city on file)"}`;

  const items = useMemo(() => (state.phase === "ok" ? annotate(state.data.rows) : []), [state]);
  const hours = useMemo(() => (state.phase === "ok" ? state.data.background ?? [] : []), [state]);
  const sum = useMemo(() => summarize(items, hours), [items, hours]);
  const recent = useMemo(() => recentFailure(items), [items]);
  const days = useMemo(() => groupDays(items, tz, filter, new Date(), hours), [items, tz, filter, hours]);
  const matches = state.phase === "ok" ? state.data.matches : {};

  // First load decides the default: expanded if a failure in the last 7 days, else collapsed.
  useEffect(() => {
    if (open === null && state.phase === "ok") setOpen(recent != null);
  }, [open, state.phase, recent]);
  const isOpen = open === true;
  const spanLabel = spanDays === range.days ? range.short : `${spanDays} days`;

  const subline = (i: Item): string | null => i.matchRef != null ? matchLine(matches[i.matchRef], i.matchRef) : i.detail;

  const header = (
    <div className="aa-head">
      <span className="aa-h3">APP ACTIVITY</span>
      {!isOpen && state.phase === "ok" && (
        <span className="aa-collapsed" data-testid="aa-collapsed-line">
          {sum.lastSeen ? <>Last seen{recent ? "" : " in the app"} <b>{shortStamp(sum.lastSeen, tz)}</b></> : "No app activity"}
          {recent ? (
            <> · <span className="aa-pill fail">FAILED</span> <span className="aa-red">{recent.title} at {timeIn(recent.ts, tz)}{recent.matchRef != null ? ` · ${matchLine(matches[recent.matchRef], recent.matchRef)}` : ""}</span></>
          ) : sum.lastSeen ? (
            <> · {sum.actions} action{sum.actions === 1 ? "" : "s"} in {spanLabel} · {sum.failures ? <span className="aa-red">{sum.failures} failed</span> : "no failures"}</>
          ) : null}
        </span>
      )}
      {!isOpen && state.phase === "loading" && <span className="aa-collapsed muted">Loading…</span>}
      {!isOpen && state.phase === "error" && <span className="aa-collapsed aa-red">{state.error}</span>}
      {isOpen && <span className="aa-tz">{tzNote}</span>}
      {isOpen && (
        <select className="aa-range" aria-label="Range" value={rangeIdx} onChange={(e) => { setRangeIdx(Number(e.target.value)); setExpanded(null); }}>
          {RANGES.map((r, i) => <option key={r.days} value={i}>{r.label}</option>)}
        </select>
      )}
      <button className="aa-link" data-testid="aa-toggle" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>{isOpen ? "Hide" : "Show"}</button>
    </div>
  );

  return (
    <section className={`aa${isOpen ? " open" : ""}${recent ? " hasfail" : ""}`} data-testid="app-activity">
      <style>{CSS}</style>
      {header}
      {isOpen && state.phase === "loading" && <p className="aa-empty">Loading app activity…</p>}
      {isOpen && state.phase === "error" && <p className="aa-empty aa-red">Couldn&apos;t load app activity: {state.error}</p>}
      {isOpen && state.phase === "ok" && (
        <>
          <div className="aa-summary" data-testid="aa-summary">
            <span>Last seen in the app <b>{sum.lastSeen ? shortStamp(sum.lastSeen, tz) : "—"}</b></span>
            <span className={sum.failures ? "aa-red" : ""}>{sum.failures ? `${sum.failures} failed action${sum.failures === 1 ? "" : "s"}` : "No failures"} in {spanLabel}</span>
            <span>{sum.actions} action{sum.actions === 1 ? "" : "s"}</span>
          </div>
          <div className="aa-chips" role="tablist">
            {FILTERS.map((f) => (
              <button key={f.key} role="tab" aria-selected={filter === f.key} data-testid={`aa-chip-${f.key}`}
                className={`aa-chip${filter === f.key ? " on" : ""}${f.key === "failures" && sum.counts.failures ? " red" : ""}`}
                onClick={() => { setFilter(f.key); setExpanded(null); }}>
                {f.label} · {sum.counts[f.key]}
              </button>
            ))}
          </div>
          {state.data.notes.map((n) => <p key={n} className="aa-note">{n}</p>)}
          {days.length === 0 && <p className="aa-empty">{items.length || hours.length ? "Nothing in this filter." : `No app activity in the last ${spanLabel}.`}</p>}
          {days.map((d) => (
            <div key={d.ymd} className="aa-day">
              <div className="aa-dayh">{d.label.toUpperCase()}</div>
              {d.lines.map((ln) => ln.kind === "bgsum" ? (
                <div key={ln.key} className="aa-bg" data-testid="aa-bgsum">
                  <div className="aa-bgrow">
                    <span>{ln.count} background request{ln.count === 1 ? "" : "s"} · loading screens, refreshing sign-in and similar</span>
                  </div>
                </div>
              ) : ln.kind === "bg" ? (
                <div key={ln.key} className="aa-bg" data-testid="aa-bg">
                  <div className="aa-bgrow">
                    <span>{ln.items.length} background request{ln.items.length === 1 ? "" : "s"} · {ln.labels.join(", ")}</span>
                    <button className="aa-link" onClick={() => setShownBg((s) => { const n = new Set(s); if (n.has(ln.key)) n.delete(ln.key); else n.add(ln.key); return n; })}>
                      {shownBg.has(ln.key) ? "Hide" : "Show"}
                    </button>
                  </div>
                  {shownBg.has(ln.key) && ln.items.map((i) => (
                    <div key={i.id} className="aa-bgitem"><span className="aa-time">{timeIn(i.ts, tz)}</span><span>{i.title}</span><span className="aa-mono">{i.method} {i.route ?? i.path} · {i.status}</span></div>
                  ))}
                </div>
              ) : (
                <Row key={ln.item.id} i={ln.item} tz={tz} sub={subline(ln.item)} open={expanded === ln.item.id}
                  onToggle={() => setExpanded(expanded === ln.item.id ? null : ln.item.id)}
                  copied={copied === ln.item.id}
                  onCopy={() => { void navigator.clipboard?.writeText(engineeringText(ln.item, playerId, env)).then(() => { setCopied(ln.item.id); setTimeout(() => setCopied(null), 1500); }); }} />
              ))}
            </div>
          ))}
          <div className="aa-foot">
            <span>{`From MatchDay's own server logs, kept ${KEPT_DAYS} days. Match chat messages don't appear here. Only what the app sent to our servers. Background requests that succeeded are counted by the hour, not kept one by one.${state.data.truncated ? " Showing the newest 3,000 requests in this range." : ""}`}</span>
            <button className="aa-btn" data-testid="aa-older" onClick={loadOlder} disabled={spanDays >= KEPT_DAYS}
              title={spanDays >= KEPT_DAYS ? `Nothing older than ${KEPT_DAYS} days is kept` : undefined}>
              {spanDays >= KEPT_DAYS ? `All ${KEPT_DAYS} days shown` : "Load older"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Row({ i, tz, sub, open, onToggle, onCopy, copied }: {
  i: Item; tz: string; sub: string | null; open: boolean; onToggle: () => void; onCopy: () => void; copied: boolean;
}) {
  return (
    <div className={`aa-row${i.failed ? " fail" : ""}${open ? " open" : ""}`} data-testid="aa-row" data-failed={i.failed ? "1" : "0"}>
      <button className="aa-rowbtn" aria-expanded={open} onClick={onToggle}>
        <span className="aa-time">{timeIn(i.ts, tz)}</span>
        <span className={`aa-dot${i.failed ? " red" : ""}`} />
        <span className="aa-main">
          <span className={`aa-title${i.known ? "" : " aa-mono"}`}>{i.title}</span>
          {sub && <span className="aa-sub">{sub}</span>}
          {i.reason && <span className="aa-reason">{i.reason}</span>}
        </span>
        {i.failed && <span className="aa-code"><span className="aa-mono">{i.errorCode ?? "no code"} · {i.status}</span> <span className="aa-pill fail">FAILED</span></span>}
        <span className="aa-chev">{open ? "⌄" : "›"}</span>
      </button>
      {open && (
        <div className="aa-detail">
          <div className="aa-boxes">
            <div className="aa-box"><span className="aa-k">WHAT THE APP ASKED</span><span className="aa-mono">{i.method} {i.route ?? i.path}</span>{i.route && i.route !== i.path && <span className="aa-mono aa-dim">{i.path}</span>}</div>
            <div className="aa-box"><span className="aa-k">ANSWER</span><span className="aa-mono">{i.status} · {i.errorCode ?? "no code"} · {i.durationMs} ms</span></div>
            <div className="aa-box"><span className="aa-k">REQUEST ID</span><span className="aa-mono aa-wrap">{i.reqId}</span></div>
            {i.ip !== undefined && <div className="aa-box"><span className="aa-k">IP ADDRESS <span className="aa-admin">ADMINS ONLY</span></span><span className="aa-mono">{i.ip ?? "—"}</span></div>}
          </div>
          <div className="aa-actions">
            {i.matchRef != null && <a className="aa-btn dark" href={`/match-ops/matches/${i.matchRef}`}>Open match ›</a>}
            <button className="aa-btn" onClick={onCopy}>{copied ? "Copied" : "Copy details for engineering"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

const CSS = `
.aa{--ink:#0e1a13;--ink2:#3d5349;--ink3:#5c7168;--line:#dde6e1;--red:#b3241f;--redbg:#fdf1f0;--redln:#f0a9a4;--grn:#1fae5b;
  background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:14px;font-size:14px;color:var(--ink)}
.aa.open{border:1.5px solid #3fcf86}
.aa *{box-sizing:border-box}
.aa-head{display:flex;align-items:center;gap:12px;padding:13px 16px;flex-wrap:wrap}
.aa-h3{font-size:11.5px;font-weight:800;letter-spacing:.1em;color:var(--ink2)}
.aa-collapsed{flex:1 1 300px;min-width:0;color:var(--ink);font-size:13.5px}
.aa-collapsed.muted{color:var(--ink3)}
.aa-tz{margin-left:auto;font-size:12px;color:var(--ink3)}
.aa-range{border:1px solid var(--line);border-radius:9px;padding:6px 8px;font:inherit;font-size:13px;background:#fff;color:var(--ink)}
.aa-link{background:none;border:0;font:inherit;font-weight:700;font-size:13px;color:#12301f;cursor:pointer;padding:4px 2px;margin-left:auto}
.aa.open .aa-link[data-testid=aa-toggle]{margin-left:0}
.aa-red{color:var(--red)}
.aa-pill{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.05em;padding:2px 8px;border-radius:999px}
.aa-pill.fail{background:#fbdcd9;color:var(--red)}
.aa-summary{display:flex;gap:18px;flex-wrap:wrap;margin:0 16px 12px;padding:10px 12px;background:#f3f6f4;border-radius:10px;font-size:13px}
.aa-chips{display:flex;gap:8px;flex-wrap:wrap;padding:0 16px 12px}
.aa-chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 12px;font:inherit;font-size:12.5px;cursor:pointer;color:var(--ink)}
.aa-chip.red{color:var(--red);border-color:var(--redln)}
.aa-chip.on{background:#12301f;color:#fff;border-color:#12301f}
.aa-note{margin:0 16px 10px;font-size:12px;color:var(--ink3)}
.aa-empty{padding:18px 16px;margin:0;color:var(--ink3)}
.aa-dayh{padding:8px 16px;background:#f3f6f4;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--ink3)}
.aa-row{border-bottom:1px solid var(--line)}
.aa-row:last-child{border-bottom:0}
.aa-row.fail{background:var(--redbg)}
.aa-rowbtn{display:flex;align-items:flex-start;gap:12px;width:100%;padding:11px 16px;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.aa-time{flex:0 0 70px;color:var(--ink2);font-size:13px;font-variant-numeric:tabular-nums}
.aa-dot{flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:var(--grn);margin-top:6px}
.aa-dot.red{background:#d93a33}
.aa-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.aa-title{font-weight:700;overflow-wrap:anywhere}
.aa-sub{font-size:12.5px;color:var(--ink2)}
.aa-reason{font-size:12.5px;color:var(--red)}
.aa-code{flex:0 0 auto;display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--ink3)}
.aa-chev{flex:0 0 14px;color:var(--ink3)}
.aa-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.aa-dim{color:var(--ink3)}
.aa-wrap{overflow-wrap:anywhere}
.aa-detail{padding:0 16px 14px 98px}
.aa-boxes{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.aa-box{display:flex;flex-direction:column;gap:3px;background:#fff;border:1px solid var(--line);border-radius:9px;padding:9px 11px;min-width:0}
.aa-k{font-size:10px;font-weight:800;letter-spacing:.08em;color:var(--ink3)}
.aa-admin{display:inline-block;margin-left:6px;font-size:9px;background:#eef2f0;border-radius:999px;padding:1px 6px}
.aa-actions{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
.aa-btn{display:inline-flex;align-items:center;border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 12px;font:inherit;font-size:12.5px;font-weight:700;color:var(--ink);cursor:pointer;text-decoration:none}
.aa-btn.dark{background:#12301f;color:#fff;border-color:#12301f}
.aa-btn:disabled{opacity:.5;cursor:not-allowed}
.aa-bg{border-bottom:1px solid var(--line)}
.aa-bgrow{display:flex;align-items:center;gap:10px;padding:9px 16px 9px 98px;font-size:12.5px;color:var(--ink3)}
.aa-bgrow .aa-link{font-size:12.5px}
.aa-bgitem{display:flex;gap:12px;padding:4px 16px 4px 98px;font-size:12px;color:var(--ink3)}
.aa-bgitem .aa-time{flex:0 0 64px;font-size:12px}
.aa-foot{display:flex;align-items:center;gap:14px;padding:12px 16px;border-top:1px solid var(--line);font-size:12px;color:var(--ink3)}
.aa-foot .aa-btn{margin-left:auto;flex:0 0 auto}
@media (max-width:700px){.aa-detail,.aa-bgrow,.aa-bgitem{padding-left:16px}.aa-time{flex-basis:58px}.aa-code{display:none}.aa-row.fail .aa-code{display:flex;flex-basis:100%}}
`;
