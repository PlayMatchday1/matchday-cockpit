"use client";

import { useEffect, useState } from "react";
import FinanceUploadCard from "@/components/FinanceUploadCard";
import { supabase } from "@/lib/supabase";
import {
  commitStripe,
  previewStripe,
  type StripePreview,
  type StripeVenueResolution,
} from "@/lib/financeImport";

// Stripe data section. Composed of three blocks, top-to-bottom:
//   1. Sync from Stripe API (primary path — button + status)
//   2. Recent syncs log
//   3. Manual CSV upload (fallback — visually deprioritized)
// Section header (mint stripe + title + subtitle) is rendered by
// the parent page; this component is just the body.
export default function StripeUploader() {
  return (
    <div className="space-y-6">
      <StripeApiSyncCard />
      <RecentSyncsCard />

      {/* Manual CSV — fallback only. Smaller eyebrow + lighter
          framing so the operator's eye lands on the API sync block
          first. Same FinanceUploadCard mechanics underneath. */}
      <div>
        <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-deep-green/45">
          Fallback · use only if the API sync is unavailable
        </div>
        <FinanceUploadCard<StripePreview>
          index={2}
          title="Stripe Activity (manual CSV)"
          subtitle="Manual fallback — replaces Stripe-source rows in fin_revenue between the earliest and latest dates in this upload. Membership payments are allocated to the member's city via email lookup; match payments use the cityIdentifier code."
          expectedColumns="Created date (UTC), Amount, Fee, Status, Description, Customer Email, cityIdentifier (metadata), type (metadata) — falls back to Description if type is blank"
          preview={previewStripe}
          commit={(p) =>
            p.earliestDate && p.latestDate
              ? commitStripe({
                  rows: p.parsed,
                  earliestDate: p.earliestDate,
                  latestDate: p.latestDate,
                })
              : Promise.resolve({
                  count: 0,
                  note: "No paid Stripe rows in the upload.",
                })
          }
          renderPreview={renderStripePreview}
          confirmLabel="Confirm Replace"
        />
      </div>
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

      const res = await fetch("/api/sync/stripe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
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

// ===== Manual Stripe CSV preview helpers =====

function renderStripePreview(p: StripePreview): React.ReactNode {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <span className="text-deep-green/60">Paid rows: </span>
        <span className="font-mono font-bold tabular-nums">
          {p.paidRows.toLocaleString()}
        </span>
        <span className="ml-1 text-xs text-deep-green/45">
          of {p.totalRows.toLocaleString()} total
          {p.skippedRows > 0
            ? ` · ${p.skippedRows.toLocaleString()} skipped (non-paid or no date)`
            : ""}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-md border border-cream-line bg-white p-3">
          <div className="text-xs font-bold uppercase tracking-wider text-deep-green/60">
            Membership payments
          </div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-deep-green">
            {p.membershipPayments.toLocaleString()}
          </div>
          <ul className="mt-2 space-y-0.5 text-xs text-deep-green/80">
            <li className="flex items-baseline gap-2">
              <span className="text-mint-hover">•</span>
              <span>Allocated via email:</span>
              <span className="font-mono font-bold tabular-nums">
                {p.emailAllocated.toLocaleString()}
              </span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="text-coral">•</span>
              <span>Unmatched:</span>
              <span className="font-mono font-bold tabular-nums">
                {p.unmatchedEmails.length.toLocaleString()}
              </span>
            </li>
          </ul>
          {p.unmatchedEmails.length > 0 && (
            <UnmatchedEmailsList emails={p.unmatchedEmails} />
          )}
        </div>
        <div className="rounded-md border border-cream-line bg-white p-3">
          <div className="text-xs font-bold uppercase tracking-wider text-deep-green/60">
            Match payments
          </div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-deep-green">
            {p.matchPayments.toLocaleString()}
          </div>
          <ul className="mt-2 space-y-0.5 text-xs text-deep-green/80">
            <li className="flex items-baseline gap-2">
              <span className="text-mint-hover">•</span>
              <span>Venue resolved:</span>
              <span className="font-mono font-bold tabular-nums">
                {p.matchRowsWithVenue.toLocaleString()}
              </span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="text-coral">•</span>
              <span>No venue:</span>
              <span className="font-mono font-bold tabular-nums">
                {p.matchRowsWithoutVenue.toLocaleString()}
              </span>
            </li>
          </ul>
          {p.matchUnmatchedCityCodes.length > 0 && (
            <div className="mt-2 text-xs text-coral">
              Unrecognized city codes:{" "}
              <span className="font-mono">
                {p.matchUnmatchedCityCodes.join(", ")}
              </span>{" "}
              → Deleted Account Revenue
            </div>
          )}
          {p.matchVenueResolutions.length > 0 && (
            <VenueResolutionsList resolutions={p.matchVenueResolutions} />
          )}
        </div>
      </div>
      {(p.strikePayments > 0 || p.strikeSkipped > 0) && (
        <div className="rounded-md border border-cream-line bg-white p-3">
          <div className="text-xs font-bold uppercase tracking-wider text-deep-green/60">
            Strike payments
          </div>
          <ul className="mt-1 space-y-0.5 text-xs text-deep-green/80">
            <li className="flex items-baseline gap-2">
              <span className="text-mint-hover">•</span>
              <span>Imported (Paid):</span>
              <span className="font-mono font-bold tabular-nums">
                {p.strikePayments.toLocaleString()}
              </span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="text-coral">•</span>
              <span>Skipped (non-Paid status):</span>
              <span className="font-mono font-bold tabular-nums">
                {p.strikeSkipped.toLocaleString()}
              </span>
            </li>
          </ul>
        </div>
      )}
      <div className="text-xs text-deep-green/65">
        Date range:{" "}
        <span className="font-mono">
          {p.earliestDate ?? "—"} → {p.latestDate ?? "—"}
        </span>{" "}
        · Months: {p.monthsAffected.join(", ") || "—"}
      </div>
      <div className="text-xs text-deep-green/65">
        Total gross:{" "}
        <span className="font-mono">
          ${Math.round(p.totalGross).toLocaleString("en-US")}
        </span>{" "}
        · Aggregates to{" "}
        <span className="font-mono font-bold">
          {p.aggregatedRowCount.toLocaleString()}
        </span>{" "}
        row{p.aggregatedRowCount === 1 ? "" : "s"} (one per date · city · type
        · venue)
      </div>
      <div className="rounded-md border border-coral/30 bg-coral-soft/30 px-3 py-2 text-xs text-coral">
        This will replace existing Stripe-source rows in fin_revenue between{" "}
        {p.earliestDate ?? "—"} and {p.latestDate ?? "—"}.
      </div>
    </div>
  );
}

function VenueResolutionsList({
  resolutions,
}: {
  resolutions: StripeVenueResolution[];
}) {
  const [open, setOpen] = useState(false);
  const distinctCount = resolutions.length;
  const unresolvedCount = resolutions.filter((r) => !r.canonical).length;
  const top = resolutions.slice(0, 8);
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-bold uppercase tracking-wider text-mint-hover hover:text-deep-green"
      >
        {open ? "Hide" : "Show"} venue resolutions ({distinctCount} distinct
        {unresolvedCount > 0 ? `, ${unresolvedCount} unresolved` : ""})
      </button>
      {open && (
        <div className="mt-2 max-h-72 overflow-auto rounded-md border border-cream-line bg-cream-soft/50 p-2 text-xs">
          <table className="w-full">
            <thead className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
              <tr>
                <th className="py-1 pr-3 text-left">#</th>
                <th className="py-1 pr-3 text-left">Raw matchName</th>
                <th className="py-1 pr-3 text-left">Canonical venue</th>
                <th className="py-1 text-right">Rows</th>
              </tr>
            </thead>
            <tbody>
              {(open ? resolutions : top).map((r, i) => (
                <tr
                  key={`${r.original}-${i}`}
                  className="border-t border-cream-line/40"
                >
                  <td className="py-0.5 pr-3 font-mono text-deep-green/55">
                    {i + 1}
                  </td>
                  <td className="py-0.5 pr-3 font-mono text-deep-green/85">
                    {r.original || "(blank)"}
                  </td>
                  <td className="py-0.5 pr-3 font-mono">
                    {r.canonical ? (
                      <span className="text-mint-hover">{r.canonical}</span>
                    ) : (
                      <span className="text-coral">unresolved</span>
                    )}
                  </td>
                  <td className="py-0.5 text-right font-mono tabular-nums text-deep-green/75">
                    {r.count.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UnmatchedEmailsList({ emails }: { emails: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-bold uppercase tracking-wider text-mint-hover hover:text-deep-green"
      >
        {open ? "Hide" : "Show"} {emails.length} email
        {emails.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul className="mt-2 max-h-48 overflow-auto rounded-md border border-cream-line bg-cream-soft/50 p-2 text-xs">
          {emails.map((e) => (
            <li
              key={e}
              className="font-mono text-deep-green/75 leading-relaxed"
            >
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
