"use client";

// Generic sync card for mdapi sources (mdapi_reviews,
// mdapi_subscriptions). Renders title, description, last-synced
// freshness from fin_sync_log, and a "Sync now" button.
//
// NOT used for Stripe — StripeApiSyncCard in StripeUploader.tsx has a
// Stripe-specific success-result block (charges fetched/skipped/etc.)
// that doesn't generalize. Visual styling here matches that card by
// convention but no shared code.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Source = "mdapi-reviews" | "mdapi-subscriptions";

type LastSyncRow = {
  completed_at: string;
  rows_imported: number | null;
  error_message: string | null;
};

type SyncResponseOk = {
  triggeredBy: "manual" | "cron";
  durationMs: number;
  ok: true;
  result: { upserted?: number; fetched?: number };
};
type SyncResponseErr = {
  triggeredBy?: "manual" | "cron";
  durationMs?: number;
  ok: false;
  error: string;
};
type SyncResponse = SyncResponseOk | SyncResponseErr;

type Props = {
  title: string;
  description: string;
  source: Source;
  endpoint: string;
  // Optional helper text shown alongside the button, e.g. "~60 seconds".
  estimatedDuration?: string;
};

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default function SyncCard({
  title,
  description,
  source,
  endpoint,
  estimatedDuration,
}: Props) {
  const [lastSync, setLastSync] = useState<LastSyncRow | null>(null);
  const [lastSyncLoading, setLastSyncLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResponseOk | null>(null);

  // Fetch the most recent COMPLETED log row for this source. Skips
  // rows that are still running (completed_at IS NULL) so the
  // freshness display reflects actual data state, not transient
  // in-flight attempts.
  async function refreshLastSync() {
    setLastSyncLoading(true);
    const { data } = await supabase
      .from("fin_sync_log")
      .select("completed_at, rows_imported, error_message")
      .eq("source", source)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle<LastSyncRow>();
    setLastSync(data ?? null);
    setLastSyncLoading(false);
  }

  useEffect(() => {
    refreshLastSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  async function handleSync() {
    setError(null);
    setResult(null);
    setSyncing(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("No active session — please sign in again.");

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as SyncResponse;
      if (!res.ok || !json.ok) {
        const msg =
          (!json.ok && "error" in json && json.error) ||
          `Sync failed (HTTP ${res.status})`;
        throw new Error(msg);
      }
      setResult(json);
      await refreshLastSync();
      // The global RecentSyncsCard (in StripeUploader) listens for
      // this event so it can re-pull fin_sync_log without a hard
      // page refresh.
      window.dispatchEvent(new CustomEvent("fin-sync-log:refresh"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-deep-green">{title}</h3>
          <p className="mt-1 text-xs text-deep-green/65">{description}</p>
          <p className="mt-1 text-[11px] text-deep-green/50">
            <FreshnessLine
              loading={lastSyncLoading}
              row={lastSync}
              estimatedDuration={estimatedDuration}
            />
          </p>
        </div>
        <button
          type="button"
          onClick={handleSync}
          disabled={syncing}
          className="rounded-md bg-mint px-4 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral">
          {error}
        </div>
      )}

      {result && result.ok && (
        <div className="mt-3 rounded-md border border-cream-line bg-cream-soft/40 p-3 text-xs text-deep-green">
          <div className="font-bold">
            ✓ Synced{" "}
            {(result.result.upserted ?? 0).toLocaleString()} rows
            <span className="font-normal text-deep-green/55">
              {" "}
              ({(result.durationMs / 1000).toFixed(1)}s)
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function FreshnessLine({
  loading,
  row,
  estimatedDuration,
}: {
  loading: boolean;
  row: LastSyncRow | null;
  estimatedDuration?: string;
}) {
  if (loading) return <span>Loading…</span>;
  if (!row) {
    return (
      <span>
        Never synced{estimatedDuration ? ` · ${estimatedDuration} sync` : ""}
      </span>
    );
  }
  const ago = timeAgo(row.completed_at);
  if (row.error_message) {
    return (
      <span title={row.completed_at} className="text-coral">
        Last sync FAILED · {ago} · {row.error_message}
      </span>
    );
  }
  const rowsText =
    row.rows_imported != null
      ? ` · ${row.rows_imported.toLocaleString()} rows`
      : "";
  return (
    <span title={row.completed_at}>
      Last synced: {ago}
      {rowsText}
      {estimatedDuration ? ` · ${estimatedDuration} sync` : ""}
    </span>
  );
}
