"use client";

// PLAYER LOCATIONS — the Data page's card for the player-areas sync (moved from the Locations page
// header, 2026-10-08: nobody can start a sync from Locations any more). The same pass the cron runs,
// logged as triggered_by "manual". ADMIN ONLY to start: the button is greyed for everyone else as a
// courtesy; the server refuses non-admins (403), a pass in progress (409), the evening block (409)
// and the 30-minute cooldown (429).
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
  if (p.ok) return { tone: "ok", text: `Complete · ${pages} · ${p.rowsInserted} new, ${p.rowsUpdated} changed` };
  return { tone: "err", text: shortError(p.error) ?? `Stopped${pages ? ` · ${pages}` : ""}` };
}

type Outcome = { kind: "ok" | "err"; text: string } | null;

export default function PlayerAreasSyncCard() {
  const { appUser } = useAuth();
  const [status, setStatus] = useState<(SyncStatus & { canSync: boolean }) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
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
  const live = !!status?.running || starting || awaiting;
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
      const res = await fetch("/api/sync/player-areas", { method: "POST", headers: await headers() });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) {
        watching.current = { since: Date.now() - 2000 };
        setAwaiting(true);
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
    : cooling ? `One sync per 30 minutes, to protect the MatchDay API. Available again at ${fmtTime(cooling)}.`
    : "Reads every player's home area from MatchDay, 50 a page, 2 seconds apart (about 30 minutes). Never retried.";

  return (
    <section id="player-locations" data-testid="player-areas-card"
      className="scroll-mt-24 rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-deep-green">Sync player locations</h3>
          <p className="mt-1 text-xs text-deep-green/65">
            Reads every player&apos;s home area from MatchDay (/admin/players) into player_area_seen, for Growth › Locations.
            Runs at 05:10, 11:10 and 17:10 UTC; nothing runs from 5 PM to 11 PM Central. A pass reads 50 players a page,
            2 seconds apart, checks the server&apos;s response time every 10 pages and stops if it is slow.
          </p>
          <p className="mt-1 text-[11px] text-deep-green/50" data-testid="player-areas-fresh">
            {loadError ? <span className="text-coral">Couldn&apos;t read sync state: {loadError}</span>
              : !status ? "Loading…"
              : r ? <>Running since {fmtTime(r.startedAt)} ({r.triggeredBy}) · {r.pagesTotal ? `${Math.round((r.pagesDone / r.pagesTotal) * 100)}%, ` : ""}
                  about {Math.max(1, Math.round(((r.pagesTotal ?? 700) - r.pagesDone) * 2.3 / 60))} min left</>
              : status.last ? (status.last.ok
                ? <>Last pass complete: {fmtWhen(status.last.finishedAt)} · {status.last.rowsInserted} new, {status.last.rowsUpdated} changed</>
                : <span className="text-coral">Last pass stopped: {fmtWhen(status.last.finishedAt)} · {shortError(status.last.error)}</span>)
              : "No pass yet"}
          </p>
        </div>
        <button type="button" data-testid="player-areas-sync-now" onClick={() => void start()} title={why}
          disabled={!isAdmin || !status || starting || awaiting || !!r || !!cooling || !!paused || !!blocked}
          className="rounded-md bg-mint px-4 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:cursor-not-allowed disabled:opacity-50">
          {label}
        </button>
      </div>
      {(!isAdmin || blocked || paused || cooling) && status && (
        <p className="mt-2 text-[11px] text-deep-green/55" data-testid="player-areas-why">{why}</p>
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
