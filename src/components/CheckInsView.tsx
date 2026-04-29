"use client";

import Link from "next/link";
import { MANAGERS } from "@/lib/checkIns";
import { useCheckIns } from "@/lib/useCheckIns";
import CheckInsCalendar from "./CheckInsCalendar";
import CheckInsNextPayments from "./CheckInsNextPayments";
import CheckInsStatusGrid from "./CheckInsStatusGrid";

export default function CheckInsView() {
  const { data, loading, syncing, lastSyncedAt, error, autoRefresh, refresh, setAutoRefresh } =
    useCheckIns();

  const lastSyncedLabel = lastSyncedAt
    ? lastSyncedAt.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return (
    <>
      <div className="mb-6 text-sm">
        <Link
          href="/admin/finance"
          className="text-deep-green/60 transition hover:text-deep-green"
        >
          ← Back to Finance
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
            City Manager Check-Ins
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
            Monthly status submissions from each city manager · live from the Google Sheet.
          </p>
        </div>
      </div>

      <div className="mb-8 flex flex-wrap items-center gap-3 rounded-2xl border-[1.5px] border-cream-line bg-white px-4 py-3 shadow-md shadow-deep-green/10">
        <SyncDot state={error ? "error" : syncing ? "loading" : "ok"} />
        <div className="flex-1 text-xs font-medium text-deep-green/65">
          {error
            ? `Connection error: ${error}`
            : loading
              ? "Connecting to sheet…"
              : lastSyncedLabel
                ? `Live · last synced ${lastSyncedLabel}${autoRefresh ? " · auto-refresh on" : " · paused"}`
                : "Connected"}
        </div>
        <button
          type="button"
          onClick={() => refresh()}
          disabled={syncing}
          className="rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
        >
          {syncing ? "Refreshing…" : "↻ Refresh now"}
        </button>
        <button
          type="button"
          onClick={() => setAutoRefresh(!autoRefresh)}
          className="rounded-full border border-cream-line bg-white px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-cream-soft"
        >
          Auto-refresh: {autoRefresh ? "ON" : "OFF"}
        </button>
      </div>

      <SectionHeader
        title="Payment Calendar"
        subtitle={`Pay days for ${MANAGERS.length} managers · current month`}
      />
      <div className="mb-10">
        <CheckInsCalendar />
      </div>

      <SectionHeader title="Next Payments" subtitle="Sorted by upcoming pay date" />
      <div className="mb-10">
        <CheckInsNextPayments />
      </div>

      <SectionHeader
        title="Monthly Check-In Status"
        subtitle={
          data
            ? `${data.submittedCount} of ${MANAGERS.length} submitted this month`
            : "Loading…"
        }
      />
      <div className="mb-10">
        {loading && !data ? (
          <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
            Loading responses…
          </div>
        ) : !data ? null : (
          <CheckInsStatusGrid statuses={data.statuses} />
        )}
      </div>
    </>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-5 flex items-stretch gap-3">
      <span aria-hidden className="w-1 rounded-full bg-mint" />
      <div className="flex-1 py-0.5">
        <h2 className="text-2xl font-bold tracking-tight text-deep-green">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-deep-green/60">{subtitle}</p>
      </div>
    </div>
  );
}

function SyncDot({ state }: { state: "ok" | "loading" | "error" }) {
  const cls =
    state === "error"
      ? "bg-coral animate-pulse"
      : state === "loading"
        ? "bg-blue-info animate-pulse"
        : "bg-mint";
  return <span aria-hidden className={`h-2 w-2 rounded-full ${cls}`} />;
}
