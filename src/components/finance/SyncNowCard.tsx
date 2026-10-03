"use client";

/* SYNC NOW + LAST SYNCED — the Finance pages' freshness control.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────────────────────────
 * The Stripe sync ran once a day at 06:00 Central, so on 1 October the Revenue page showed a
 * September that was $1,821 short until the morning job caught up — and nothing on the page said
 * the number was waiting on a sync. This states the freshness and lets an admin close the gap.
 *
 * ── IT ONLY EVER UPSERTS INTO fin_txn ───────────────────────────────────────────────────────────
 * It never deletes and never touches fin_revenue, whose own nightly job is unchanged. That is what
 * makes a button safe to put in front of a person: the worst case of a double click is the same
 * rows written twice, and balance_txn_id is unique.
 *
 * ── "LAST SYNCED" NAMES THE SYNC THAT FEEDS THE PAGE ────────────────────────────────────────────
 * Before the switch that is 'stripe-api' (fin_revenue); after it, 'stripe-txn'. One prop, so the
 * switch is a one-line change and not a hunt. Rendered in Central, labelled Central — a bare
 * timestamp in an unnamed zone is how the UTC/Central confusion started.
 */

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type State =
  | { k: "idle" }
  | { k: "running" }
  | { k: "busy"; since: string }
  | { k: "done"; inserted: number; updated: number }
  | { k: "error"; msg: string };

const CENTRAL = "America/Chicago";

/** "Oct 1, 1:23 PM Central" — never a bare instant. */
function centralStamp(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return `${d.toLocaleString("en-US", {
    timeZone: CENTRAL, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  })} Central`;
}

/* ── THE BUTTON IS HIDDEN UNTIL THE SWITCH, AND THE LABEL IS NOT ────────────────────────────────
 * Until fin_txn becomes the page's source, a Sync now click would fill fin_txn while every figure
 * on screen still comes from fin_revenue — a control that visibly does nothing to the numbers
 * beside it. Ryan's ruling: show the freshness, hide the button, enable it as part of the switch.
 * ONE FLAG, flipped with `source`, so the switch is one edit and not a hunt. */
export default function SyncNowCard({
  source = "stripe-api",
  canSync = false,
  compact = false,
}: {
  source?: "stripe-api" | "stripe-txn";
  /** False until fin_txn is the page's source. The button is not rendered at all when false. */
  canSync?: boolean;
  /** Small type, for a page that draws its own header (OpEx). */
  compact?: boolean;
}) {
  const [last, setLast] = useState<string | null>(null);
  const [state, setState] = useState<State>({ k: "idle" });

  /* THE MOST RECENT SUCCESSFUL RUN, not the most recent attempt. A failed sync must not make the
   * page look fresh — completed_at non-null and error_message null is what "succeeded" means here. */
  const readLast = useCallback(async () => {
    const { data } = await supabase
      .from("fin_sync_log")
      .select("completed_at")
      .eq("source", source)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(1);
    setLast((data ?? [])[0]?.completed_at ?? null);
  }, [source]);

  useEffect(() => { void readLast(); }, [readLast]);

  const run = useCallback(async () => {
    setState({ k: "running" });
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch("/api/sync/fin-txn?days=3", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const j = await res.json().catch(() => ({}));
      // 409 IS NOT AN ERROR, IT IS AN ANSWER. Ryan: if one is running, the button says so and does
      // not start a second.
      if (res.status === 409) { setState({ k: "busy", since: String(j.startedAt ?? "") }); return; }
      if (!res.ok || j?.outcome !== "LANDED") {
        setState({ k: "error", msg: String(j?.error ?? `HTTP ${res.status}`) });
        return;
      }
      setState({ k: "done", inserted: Number(j.inserted ?? 0), updated: Number(j.updated ?? 0) });
      await readLast();
      /* REFRESH THE PAGE'S OWN DATA. A sync that updates the label and leaves the figures stale is
       * worse than no button: it tells the reader the number is current when it is not. */
      window.location.reload();
    } catch (e) {
      setState({ k: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  }, [readLast]);

  const busy = state.k === "running";
  return (
    <div className={compact ? "sn sn-compact" : "sn"} data-testid="sync-now-card">
      {canSync && (
        <button
          type="button" data-testid="sync-now" onClick={() => void run()} disabled={busy}
          aria-busy={busy || undefined}
        >
          {busy ? "Syncing…" : "Sync now"}
        </button>
      )}
      <span className="sn-last" data-testid="sync-last" data-iso={last ?? ""}>
        Last synced {centralStamp(last)}
      </span>
      {state.k === "busy" && (
        <span className="sn-note" data-testid="sync-busy">
          A sync is already running (started {centralStamp(state.since)}).
        </span>
      )}
      {state.k === "error" && (
        <span className="sn-err" data-testid="sync-error">Sync failed — {state.msg}</span>
      )}
      <style jsx>{`
        .sn { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 13px; }
        .sn button {
          border: 1px solid #e3e7e1; background: #fff; border-radius: 999px;
          padding: 7px 15px; font: inherit; font-weight: 700; color: #3c4f44; cursor: pointer;
        }
        .sn button:hover:not(:disabled) { background: #f4f7f4; }
        .sn button:disabled { opacity: 0.55; cursor: default; }
        .sn-last { color: #7a8a81; white-space: nowrap; }
        .sn-compact { font-size: 11.5px; }
        .sn-note { color: #8a6d1f; font-weight: 600; }
        .sn-err { color: #b42318; font-weight: 600; }
      `}</style>
    </div>
  );
}
