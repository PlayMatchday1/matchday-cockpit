"use client";

// SYNC NOW — the Locations header button that starts the same player-areas sync the cron runs,
// logged as triggered_by "manual". ADMIN ONLY: hidden for everyone else here as a courtesy; the
// server refuses non-admins (403), a run in progress (409) and the 30-minute cooldown (429).
//
// It never retries. A failed run is shown as it failed; the next run is a person's or the cron's.
// Progress comes from /api/sync/player-areas/status (Supabase), polled every 4s while a run is live.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import type { SyncStatus } from "@/lib/playerAreaSyncStatus";

const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

type Outcome = { kind: "ok"; text: string } | { kind: "err"; text: string } | null;

export default function LocationsSyncNow({ onFinished }: { onFinished: () => void }) {
  const { appUser } = useAuth();
  const [status, setStatus] = useState<(SyncStatus & { canSync: boolean }) | null>(null);
  const [starting, setStarting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  // The run THIS page started (or saw running): when it finishes, report it and reload once. The ref
  // is what poll() reads; `awaiting` mirrors it as STATE so polling keeps going in the gap between a
  // 202 and the background run inserting its row (a ref change would not re-render the interval).
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
      const w = watching.current;
      // Once the run has been SEEN it is matched by id; a run that finished before the first poll
      // could see it falls back to "started after the click".
      if (s.running) {
        if (!w) { watching.current = { since: Date.parse(s.running.startedAt), runId: s.running.runId }; setAwaiting(true); }
        else if (w.runId == null) w.runId = s.running.runId;
      } else if (w && s.last && (w.runId != null ? s.last.runId >= w.runId : Date.parse(s.last.startedAt) >= w.since - 5000)) {
        watching.current = null;
        setAwaiting(false);
        setOutcome(s.last.ok
          ? { kind: "ok", text: `Sync finished at ${fmtTime(s.last.finishedAt)}: ${s.last.rowsInserted} new, ${s.last.rowsUpdated} changed.` }
          : { kind: "err", text: `Sync failed at ${fmtTime(s.last.finishedAt)}: ${s.last.error ?? "no error recorded"}. Not retried.` });
        onFinished();
      }
    } catch (e) {
      setOutcome({ kind: "err", text: `Couldn't read sync status: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [headers, onFinished]);

  useEffect(() => { if (appUser?.is_admin) void poll(); }, [appUser?.is_admin, poll]);
  const live = !!status?.running || starting || awaiting;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void poll(), 4000);
    return () => clearInterval(t);
  }, [live, poll]);
  // Re-check when a cooldown expires so the button wakes without a reload.
  useEffect(() => {
    if (!status?.availableAt) return;
    const ms = Date.parse(status.availableAt) - Date.now();
    if (ms <= 0) return;
    const t = setTimeout(() => void poll(), ms + 1000);
    return () => clearTimeout(t);
  }, [status?.availableAt, poll]);

  if (!appUser?.is_admin) return null;

  const start = async () => {
    setStarting(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/sync/player-areas", { method: "POST", headers: await headers() });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) {
        watching.current = { since: Date.now() - 2000 };
        setAwaiting(true);
        await poll();
      } else if (res.status === 429 && body?.availableAt) {
        setOutcome({ kind: "err", text: `Not started: cooling down until ${fmtTime(body.availableAt)}.` });
        await poll();
      } else {
        setOutcome({ kind: "err", text: `Not started: ${body?.error ?? `HTTP ${res.status}`}` });
        await poll();
      }
    } catch (e) {
      setOutcome({ kind: "err", text: `Not started: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setStarting(false);
    }
  };

  const r = status?.running;
  const cooling = !r && status?.availableAt ? status.availableAt : null;
  const paused = !r ? status?.paused ?? null : null;
  const label = paused ? "Sync paused"
    : starting || (awaiting && !r) ? "Starting…"
    : r ? `Syncing… ${r.pagesDone}${r.pagesTotal ? ` / ${r.pagesTotal}` : ""} pages`
    : cooling ? `Sync now (available at ${fmtTime(cooling)})`
    : "Sync now";

  return (
    <span className="loc-sync">
      <button type="button" className="loc-refresh" data-testid="loc-sync-now"
        disabled={!status || starting || awaiting || !!r || !!cooling || !!paused}
        title={paused ? paused : r ? `A ${r.triggeredBy} sync started at ${fmtTime(r.startedAt)}; a full pass takes about 3 minutes.`
          : cooling ? `One sync per 30 minutes, to protect the MatchDay API. Available again at ${fmtTime(cooling)}.`
          : "Pull every player's location from MatchDay now (about 3 minutes). Admins only; once per 30 minutes; never retried."}
        onClick={() => void start()}>
        {label}
      </button>
      {r && <span className="loc-stamp" data-testid="loc-sync-progress">about 3 min in total</span>}
      {outcome && (
        <span className={"loc-stamp" + (outcome.kind === "err" ? " loc-stamp-failed" : "")} data-testid="loc-sync-outcome">{outcome.text}</span>
      )}
    </span>
  );
}
