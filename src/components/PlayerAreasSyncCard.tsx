"use client";

// PLAYER LOCATIONS — the Data page's card for the player-areas sync (moved from the Locations page
// header, 2026-10-08: nobody can start a sync from Locations any more). Since 2026-10-21 Sync now runs
// an INCREMENTAL run (/api/sync/player-areas/recent: players whose location changed since the last
// successful run), logged as triggered_by "manual". RUN FULL SYNC (2026-10-23) opens the same full pass
// the nightly cron does (/api/sync/player-areas), also logged "manual", and is additionally refused in
// the evening block. ADMIN ONLY to start either: the buttons are greyed for everyone else as a
// courtesy; the server refuses non-admins (403), a run in progress (409) and the 10-minute cooldown
// (429) — one guard for both buttons, counted from the last run of either kind.
//
// It never retries. A stopped pass is shown as it stopped; the next one is a person's or the cron's.
// State comes from /api/sync/player-areas/status (Supabase), polled every 5 s while a pass is live.
// The passes also appear in Recent syncs (StripeUploader), from the same route.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import type { RecentPass, SyncStatus } from "@/lib/playerAreaSyncStatus";

const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const fmtWhen = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/** Reading time (~1.3 s a page, paced) plus the wait between legs (a leg is ~175 pages; the next
 *  starts on the 5-minute continuation tick, about a minute after the last ends). */
const minsLeft = (total: number | null, done: number) => {
  const left = Math.max(0, (total ?? 185) - done);
  return Math.max(1, Math.round(left * 1.3 / 60 + left / 175));
};

/** An error as one readable line: the API's HTML error page (the "Body: …" a 503 carries) is cut. */
export const shortError = (e: string | null) => {
  if (!e) return null;
  const head = e.split(/\s+Body:/)[0].trim();
  return head.length > 180 ? `${head.slice(0, 177)}…` : head;
};

/** One pass, in words: how it ended and how far it got. */
export function passOutcome(p: RecentPass): { tone: "ok" | "err" | "running"; text: string } {
  const pages = p.pagesRead != null ? `${p.pagesRead}${p.pagesTotal ? ` of ${p.pagesTotal}` : ""} pages` : "";
  if (p.live) return { tone: "running", text: `Running · ${pages}` };
  if (!p.finishedAt) return { tone: "err", text: `Did not finish${pages ? ` · ${pages}` : ""}` };
  const kind = p.kind === "incremental" ? "Changes" : "Full";
  if (p.ok) return { tone: "ok", text: `${kind} · ${p.kind === "incremental" ? `${p.apiCalls ?? 0} requests` : pages} · ${p.rowsInserted} new, ${p.rowsUpdated} changed` };
  return { tone: "err", text: `${kind} · ${shortError(p.error) ?? `Stopped${pages ? ` · ${pages}` : ""}`}` };
}

type Outcome = { kind: "ok" | "err"; text: string } | null;

export default function PlayerAreasSyncCard() {
  const { appUser } = useAuth();
  const [status, setStatus] = useState<(SyncStatus & { canSync: boolean }) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startingFull, setStartingFull] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const watching = useRef<{ since: number; runId?: number } | null>(null);
  const [awaiting, setAwaiting] = useState(false);

  const headers = useCallback(async () => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : ({} as Record<string, string>);
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/player-areas/status", { cache: "no-store", headers: await headers() });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const s = body as SyncStatus & { canSync: boolean };
      setStatus(s);
      setLoadError(null);
      const w = watching.current;
      if (s.running) {
        if (!w) { watching.current = { since: Date.parse(s.running.startedAt), runId: s.running.runId }; setAwaiting(true); }
        else if (w.runId == null) w.runId = s.running.runId;
      } else if (w && s.last && (w.runId != null ? s.last.runId >= w.runId : Date.parse(s.last.startedAt) >= w.since - 5000)) {
        watching.current = null;
        setAwaiting(false);
        setOutcome(s.last.ok
          ? { kind: "ok", text: `Sync finished at ${fmtTime(s.last.finishedAt)}: ${s.last.rowsInserted} new, ${s.last.rowsUpdated} changed.` }
          : { kind: "err", text: `Sync stopped at ${fmtTime(s.last.finishedAt)}: ${s.last.error ?? "no error recorded"}. Not retried.` });
        window.dispatchEvent(new CustomEvent("fin-sync-log:refresh"));
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [headers]);

  useEffect(() => { void poll(); }, [poll]);
  const live = !!status?.running || starting || startingFull || awaiting;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void poll(), 5000);
    return () => clearInterval(t);
  }, [live, poll]);
  // Re-check when a cooldown or the evening block ends, so the button wakes without a reload.
  useEffect(() => {
    if (!status?.availableAt) return;
    const ms = Date.parse(status.availableAt) - Date.now();
    if (ms <= 0 || ms > 6 * 3600_000) return;
    const t = setTimeout(() => void poll(), ms + 1000);
    return () => clearTimeout(t);
  }, [status?.availableAt, poll]);

  const start = async () => {
    setStarting(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/sync/player-areas/recent", { method: "POST", headers: await headers() });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.skipped) {
        setOutcome({ kind: "err", text: `Not run: ${body.skipped}` });
      } else if (res.ok && body?.ok) {
        setOutcome({ kind: "ok", text: `Synced: ${body.players} players changed since ${fmtWhen(body.since)} · ${body.inserted} new, ${body.updated} changed, ${body.cleared} cleared · ${body.apiCalls} MatchDay request${body.apiCalls === 1 ? "" : "s"}.` });
        window.dispatchEvent(new CustomEvent("fin-sync-log:refresh"));
      } else if (res.status === 429 && body?.availableAt) {
        setOutcome({ kind: "err", text: `Not started: cooling down until ${fmtTime(body.availableAt)}.` });
      } else {
        setOutcome({ kind: "err", text: `Not started: ${body?.error ?? `HTTP ${res.status}`}` });
      }
      await poll();
    } catch (e) {
      setOutcome({ kind: "err", text: `Not started: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setStarting(false);
    }
  };

  /* RUN FULL SYNC: answers 202 at once with the run id; the pass then runs in legs (about 5 minutes)
   * and the poll above reports how it ended, exactly as it does for a pass someone else started. */
  const startFull = async () => {
    setStartingFull(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/sync/player-areas", { method: "POST", headers: await headers() });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202 && body?.runId != null) {
        watching.current = { since: Date.now(), runId: body.runId };
        setAwaiting(true);
        setOutcome({ kind: "ok", text: `Full pass ${body.runId} started. It reads every player, about 5 minutes; this card reports how it ends.` });
      } else if (res.status === 429 && body?.availableAt) {
        setOutcome({ kind: "err", text: `Not started: cooling down until ${fmtTime(body.availableAt)}.` });
      } else {
        setOutcome({ kind: "err", text: `Not started: ${body?.skipped ?? body?.error ?? `HTTP ${res.status}`}` });
      }
      await poll();
    } catch (e) {
      setOutcome({ kind: "err", text: `Not started: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setStartingFull(false);
    }
  };

  const r = status?.running;
  const paused = !r ? status?.paused ?? null : null;
  const blocked = !r && !paused ? status?.blocked ?? null : null;
  const cooling = !r && !blocked && status?.availableAt ? status.availableAt : null;
  const isAdmin = !!appUser?.is_admin;
  const label = paused ? "Sync paused"
    : blocked ? "No syncs in match hours"
    : starting || (awaiting && !r) ? "Starting…"
    : r ? `Syncing… ${r.pagesDone}${r.pagesTotal ? ` / ${r.pagesTotal}` : ""} pages`
    : cooling ? `Available at ${fmtTime(cooling)}`
    : "Sync now";
  const why = !isAdmin ? "Only admins can start a location sync."
    : paused ? paused
    : blocked ? `${blocked} Available again at ${fmtTime(status!.availableAt!)}.`
    : r ? `A ${r.triggeredBy} pass started at ${fmtTime(r.startedAt)}.`
    : cooling ? `One sync per 10 minutes, to protect the MatchDay API. Available again at ${fmtTime(cooling)}.`
    : "Reads the players whose location changed since the last successful sync, 200 a page, one request a second. Never retried.";
  const fullBlocked = !r && !paused ? status?.fullBlocked ?? null : null;
  const fullLabel = paused ? "Sync paused"
    : fullBlocked ? "No full sync in match hours"
    : startingFull ? "Starting…"
    : cooling ? `Full sync at ${fmtTime(cooling)}`
    : "Run full sync";
  const fullWhy = !isAdmin ? "Only admins can start a location sync."
    : paused ? paused
    : fullBlocked ? fullBlocked
    : r ? `A ${r.triggeredBy} pass started at ${fmtTime(r.startedAt)}.`
    : cooling ? `One sync per 10 minutes, to protect the MatchDay API. Available again at ${fmtTime(cooling)}.`
    : "The same full pass the 3 AM cron runs: every player, 200 a page, one request a second, about 5 minutes. Picks up city changes, which Sync now does not. Never retried.";

  return (
    <section id="player-locations" data-testid="player-areas-card"
      className="scroll-mt-24 rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-deep-green">Sync player locations</h3>
          <p className="mt-1 text-xs text-deep-green/65">
            Player home areas from MatchDay (/admin/players) into player_area_seen, for Growth › Locations. Every hour at :35,
            only the players whose location changed since the last successful sync (usually one request). Once a night, at 3 AM Central
            (08:00 UTC), a full pass reads every player 200 a page, one request a second (about 5 minutes), refreshes the player
            copy, and clears removed locations. Run full sync starts that same pass now (admins, not in match hours). Any error stops a run;
            the next scheduled run is the retry.
          </p>
          <p className="mt-1 text-[11px] text-deep-green/50" data-testid="player-areas-fresh">
            {loadError ? <span className="text-coral">Couldn&apos;t read sync state: {loadError}</span>
              : !status ? "Loading…"
              : r ? <>Running since {fmtTime(r.startedAt)} ({r.triggeredBy}) · {r.pagesTotal ? `${Math.round((r.pagesDone / r.pagesTotal) * 100)}%, ` : ""}
                  about {minsLeft(r.pagesTotal, r.pagesDone)} min left</>
              : status.last ? (status.last.ok
                ? <>Last pass complete: {fmtWhen(status.last.finishedAt)} · {status.last.rowsInserted} new, {status.last.rowsUpdated} changed</>
                : <span className="text-coral">Last pass stopped: {fmtWhen(status.last.finishedAt)} · {shortError(status.last.error)}</span>)
              : "No pass yet"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-testid="player-areas-sync-full" onClick={() => void startFull()} title={fullWhy}
            disabled={!isAdmin || !status || starting || startingFull || awaiting || !!r || !!cooling || !!paused || !!fullBlocked}
            className="rounded-md border-[1.5px] border-deep-green/25 bg-white px-4 py-2 text-sm font-bold text-deep-green transition hover:bg-cream-soft disabled:cursor-not-allowed disabled:opacity-50">
            {fullLabel}
          </button>
          <button type="button" data-testid="player-areas-sync-now" onClick={() => void start()} title={why}
            disabled={!isAdmin || !status || starting || startingFull || awaiting || !!r || !!cooling || !!paused || !!blocked}
            className="rounded-md bg-mint px-4 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:cursor-not-allowed disabled:opacity-50">
            {label}
          </button>
        </div>
      </div>
      {(!isAdmin || blocked || paused || cooling) && status && (
        <p className="mt-2 text-[11px] text-deep-green/55" data-testid="player-areas-why">{why}</p>
      )}
      {isAdmin && fullBlocked && !blocked && !paused && status && (
        <p className="mt-1 text-[11px] text-deep-green/55" data-testid="player-areas-full-why">Run full sync: {fullBlocked}</p>
      )}
      {outcome && (
        <div data-testid="player-areas-outcome"
          className={outcome.kind === "err" ? "mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral"
            : "mt-3 rounded-md border border-cream-line bg-cream-soft/40 p-3 text-xs text-deep-green"}>
          {outcome.text}
        </div>
      )}
      {status && status.recent.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs" data-testid="player-areas-history">
            <thead><tr className="text-[10px] uppercase tracking-wider text-deep-green/50">
              <th className="py-1.5 pr-3 font-bold">Started</th><th className="py-1.5 pr-3 font-bold">By</th>
              <th className="py-1.5 pr-3 font-bold">Ended</th><th className="py-1.5 font-bold">Outcome</th>
            </tr></thead>
            <tbody>
              {status.recent.map((p) => {
                const o = passOutcome(p);
                return (
                  <tr key={p.runId} className="border-t border-cream-line align-top">
                    <td className="whitespace-nowrap py-1.5 pr-3 text-deep-green">{fmtWhen(p.startedAt)}</td>
                    <td className="py-1.5 pr-3 text-deep-green/70">{p.triggeredBy}</td>
                    <td className="whitespace-nowrap py-1.5 pr-3 text-deep-green/70">{p.finishedAt ? fmtTime(p.finishedAt) : "—"}</td>
                    <td className={"py-1.5 " + (o.tone === "err" ? "text-coral" : o.tone === "running" ? "text-deep-green/70" : "text-deep-green")}>{o.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
