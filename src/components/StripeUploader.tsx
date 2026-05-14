"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// Stripe data section. Two blocks:
//   1. Sync from Stripe API (button + status)
//   2. Recent syncs log
// The manual CSV upload that used to sit beneath these was removed
// once the API sync proved reliable (commits 2b262fd / da1f05e were
// Phases 1–2 of that work; the manual fallback came out in this
// commit). If we ever need to restore it for an emergency reupload,
// `commitStripe` and `previewStripe` are still exported from
// financeImport.ts and the prior UI is reachable from git history.
//
// Section header (mint stripe + title + subtitle) is rendered by
// the parent page; this component is just the body.
export default function StripeUploader() {
  return (
    <div className="space-y-6">
      <StripeApiSyncCard />
      <RecentSyncsCard />
    </div>
  );
}

// ===== API sync card =====

type SyncResponse = {
  since: string;
  until: string;
  totalCharges: number;
  paidRows: number;
  skippedNonPaid: number;
  skippedNonUsd: number;
  rowsImported: number;
  earliestDate: string | null;
  latestDate: string | null;
  membershipPayments: number;
  matchPayments: number;
  strikePayments: number;
  unmatchedEmails: string[];
  unmatchedCityCodes: string[];
  durationMs: number;
  note?: string;
};

function StripeApiSyncCard() {
  const [latestCharge, setLatestCharge] = useState<string | null>(null);
  const [latestLoading, setLatestLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Optional backfill range. When BOTH inputs are blank, "Sync now"
  // preserves the existing daily-catch-up behavior (route defaults
  // since = latest Stripe row + 1, until = now). When set, the
  // values are passed as `since` / `until` in the POST body so
  // operators can do historical backfills (e.g. Q1 Stripe data not
  // yet in fin_revenue) without dropping a key into .env.local or
  // touching the CLI. Date-only strings — the route's parseDateParam
  // treats them as UTC midnight, matching Stripe's UTC charge.created
  // semantics.
  const [customSince, setCustomSince] = useState<string>("");
  const [customUntil, setCustomUntil] = useState<string>("");

  // Surface the most recent Stripe charge in fin_revenue as the
  // "data freshness" signal — proxy for "how up-to-date is what
  // we have." (The Phase-2 fin_sync_log table has the actual sync
  // history; the Recent syncs block below shows that.)
  async function refreshLatestCharge() {
    setLatestLoading(true);
    const { data } = await supabase
      .from("fin_revenue")
      .select("date")
      .eq("source", "Stripe")
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    setLatestCharge(data?.date ?? null);
    setLatestLoading(false);
  }

  useEffect(() => {
    refreshLatestCharge();
  }, []);

  async function handleSync() {
    setError(null);
    setResult(null);
    setSyncing(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("No active session — please sign in again.");

      // Only include since/until in the body when set. Empty body
      // preserves the route's daily-catch-up default behavior.
      const body: { since?: string; until?: string } = {};
      if (customSince) body.since = customSince;
      if (customUntil) body.until = customUntil;
      const res = await fetch("/api/sync/stripe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? `Sync failed (HTTP ${res.status})`);
      }
      setResult(json as SyncResponse);
      await refreshLatestCharge();
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
          <h3 className="text-base font-bold text-deep-green">
            Sync from Stripe API
          </h3>
          <p className="mt-1 text-xs text-deep-green/65">
            Pulls succeeded charges since the latest Stripe row in
            fin_revenue and replaces overlapping rows. Same classification
            as the manual CSV importer.
          </p>
          <p className="mt-1 text-[11px] text-deep-green/50">
            Latest Stripe charge in DB:{" "}
            <span className="font-mono">
              {latestLoading ? "…" : (latestCharge ?? "(none yet)")}
            </span>
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

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-md border border-cream-line bg-cream-soft/40 px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
          Backfill range (optional)
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-deep-green/70">
          <span className="font-bold">From</span>
          <input
            type="date"
            value={customSince}
            onChange={(e) => setCustomSince(e.target.value)}
            disabled={syncing}
            className="rounded border border-cream-line bg-white px-2 py-1 text-xs text-deep-green focus:border-deep-green focus:outline-none disabled:opacity-50"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-deep-green/70">
          <span className="font-bold">To</span>
          <input
            type="date"
            value={customUntil}
            onChange={(e) => setCustomUntil(e.target.value)}
            disabled={syncing}
            className="rounded border border-cream-line bg-white px-2 py-1 text-xs text-deep-green focus:border-deep-green focus:outline-none disabled:opacity-50"
          />
        </label>
        {(customSince || customUntil) && (
          <button
            type="button"
            onClick={() => {
              setCustomSince("");
              setCustomUntil("");
            }}
            disabled={syncing}
            className="text-[11px] font-bold text-deep-green/60 transition hover:text-deep-green disabled:opacity-50"
          >
            Clear
          </button>
        )}
        <div className="ml-auto text-[10px] text-deep-green/50">
          Leave blank for daily catch-up from the latest Stripe row.
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 space-y-2 rounded-md border border-cream-line bg-cream-soft/40 p-3 text-xs text-deep-green">
          <div className="font-bold">
            Synced {result.rowsImported.toLocaleString()} aggregated rows
            {result.earliestDate && result.latestDate
              ? ` · ${result.earliestDate} → ${result.latestDate}`
              : ""}{" "}
            <span className="font-normal text-deep-green/55">
              ({(result.durationMs / 1000).toFixed(1)}s)
            </span>
          </div>
          <ul className="space-y-0.5 pl-3 text-deep-green/75">
            <li>
              {result.totalCharges.toLocaleString()} charges fetched ·{" "}
              {result.paidRows.toLocaleString()} succeeded ·{" "}
              {result.skippedNonPaid.toLocaleString()} non-paid skipped
              {result.skippedNonUsd > 0 ? (
                <span className="text-coral">
                  {" "}
                  · {result.skippedNonUsd.toLocaleString()} non-USD skipped
                  ⚠
                </span>
              ) : null}
            </li>
            <li>
              By type: {result.membershipPayments.toLocaleString()} membership
              · {result.matchPayments.toLocaleString()} match ·{" "}
              {result.strikePayments.toLocaleString()} strike
            </li>
            {result.unmatchedEmails.length > 0 && (
              <li className="text-coral">
                {result.unmatchedEmails.length} unmatched membership email
                {result.unmatchedEmails.length === 1 ? "" : "s"} → Deleted
                Account Revenue
              </li>
            )}
            {result.unmatchedCityCodes.length > 0 && (
              <li className="text-coral">
                Unrecognized city codes:{" "}
                <span className="font-mono">
                  {result.unmatchedCityCodes.join(", ")}
                </span>
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

// ===== Recent syncs =====

type SyncLogRow = {
  id: string;
  source: string;
  triggered_by: "manual" | "cron";
  started_at: string;
  completed_at: string | null;
  rows_imported: number | null;
  rows_replaced: number | null;
  charges_fetched: number | null;
  charges_succeeded: number | null;
  charges_skipped: number | null;
  error_message: string | null;
};

function syncStatus(row: SyncLogRow): "ok" | "error" | "running" {
  if (row.error_message) return "error";
  if (!row.completed_at) return "running";
  return "ok";
}

function fmtSyncWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function RecentSyncsCard() {
  const [rows, setRows] = useState<SyncLogRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const { data, error: qErr } = await supabase
      .from("fin_sync_log")
      .select(
        "id, source, triggered_by, started_at, completed_at, rows_imported, rows_replaced, charges_fetched, charges_succeeded, charges_skipped, error_message",
      )
      .order("started_at", { ascending: false })
      .limit(10);
    if (qErr) {
      setError(qErr.message);
    } else {
      setRows((data ?? []) as SyncLogRow[]);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener("fin-sync-log:refresh", onRefresh);
    return () => {
      window.removeEventListener("fin-sync-log:refresh", onRefresh);
    };
  }, []);

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-base font-bold text-deep-green">Recent syncs</h3>
          <p className="mt-1 text-xs text-deep-green/65">
            Last 10 attempts (manual + cron). Click an error row to expand.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="text-[11px] font-bold uppercase tracking-wider text-mint-hover transition hover:text-deep-green"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral">
          {error}
        </div>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-cream-soft/60 text-[10px] font-semibold uppercase tracking-[0.06em] text-deep-green/55">
            <tr>
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2 text-right">Rows</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Trigger</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows === null ? (
              <tr>
                <td colSpan={4} className="px-3 py-3 text-deep-green/55">
                  Loading…
                </td>
              </tr>
            ) : rows && rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-3 text-deep-green/55 italic">
                  No sync attempts yet.
                </td>
              </tr>
            ) : (
              rows?.map((r) => {
                const status = syncStatus(r);
                const isError = status === "error";
                const isOpen = openId === r.id;
                const tone =
                  status === "ok"
                    ? "text-mint-hover"
                    : status === "error"
                      ? "text-coral"
                      : "text-deep-green/55";
                return (
                  <FragmentRow
                    key={r.id}
                    r={r}
                    isError={isError}
                    isOpen={isOpen}
                    tone={tone}
                    status={status}
                    onToggle={() =>
                      isError ? setOpenId(isOpen ? null : r.id) : null
                    }
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FragmentRow({
  r,
  isError,
  isOpen,
  tone,
  status,
  onToggle,
}: {
  r: SyncLogRow;
  isError: boolean;
  isOpen: boolean;
  tone: string;
  status: "ok" | "error" | "running";
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={`border-t border-cream-line/60 ${isError ? "cursor-pointer hover:bg-coral-soft/30" : ""}`}
        onClick={onToggle}
      >
        <td className="px-3 py-2 font-mono text-[11px] tabular-nums text-deep-green/75">
          {fmtSyncWhen(r.started_at)}
        </td>
        <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
          {r.rows_imported == null ? "—" : r.rows_imported.toLocaleString()}
        </td>
        <td className={`px-3 py-2 font-bold ${tone}`}>
          {status === "ok"
            ? "ok"
            : status === "error"
              ? `error${isOpen ? " ▾" : " ▸"}`
              : "running…"}
        </td>
        <td className="px-3 py-2 text-deep-green/65">{r.triggered_by}</td>
      </tr>
      {isError && isOpen && r.error_message && (
        <tr className="bg-coral-soft/30">
          <td colSpan={4} className="px-3 py-2 text-[11px] text-coral">
            <pre className="whitespace-pre-wrap break-words font-mono">
              {r.error_message}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

