"use client";

// Support-performance strip that sits above the Chats filter row.
// Visual reference: docs/chats-metrics-header-mock.html. Four tiles:
//   1. Median first response  (business minutes)
//   2. Answered within 1 hour (%)
//   3. Handled this period    (+ resolved / close rate)
//   4. Awaiting now           (LIVE — not period-bound)
//
// Tiles 1–3 recompute on the period toggle (This week / This month / All
// time — deliberately NOT Today). Tile 4 is always live. Week/month show
// a trend chip vs the previous period on tiles 1–2; all-time has no prior
// period so the chips drop.
//
// All the math is server-side (business-hours aware, median not mean) in
// /api/crm/metrics. This component only renders what the route returns
// and owns the period toggle, the collapse toggle, and a 60s refresh so
// the live tile and the (barely-moving) period tiles stay current without
// a reload.

import { useCallback, useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { supabase } from "@/lib/supabase";

type PeriodKind = "week" | "month" | "all";

type PeriodMetrics = {
  medianFirstResponseMin: number | null;
  answeredWithin1hPct: number | null;
  respondedCount: number;
  awaitingFirstReplyCount: number;
  handled: {
    count: number;
    opened: number;
    resolved: number;
    closeRatePct: number | null;
  };
};

type MetricsResponse = {
  period: PeriodKind;
  generatedAt: string;
  metrics: PeriodMetrics;
  trend: {
    medianDeltaMin: number | null;
    within1hDeltaPct: number | null;
  } | null;
  awaiting: {
    count: number;
    oldestWaitingHours: number | null;
    pastWindowCount: number;
  };
};

const PERIOD_LABELS: Record<PeriodKind, string> = {
  week: "This week",
  month: "This month",
  all: "All time",
};

const REFRESH_MS = 60_000;
const COLLAPSE_KEY = "chats.metricsStrip.collapsed";

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

// "42", "—", or "1,204" — integer, thousands-separated, null-safe.
function intOrDash(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

// Waiting age: "0.9h" under ten hours (a support age people read at a
// glance), "32h" above, "—" when nothing waits.
function fmtHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 10) return `${h.toFixed(1)}h`;
  return `${Math.round(h)}h`;
}

export default function ChatsMetricsStrip() {
  const [period, setPeriod] = useState<PeriodKind>("week");
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Collapse persists per operator: someone who wants the bare inbox
  // keeps it hidden across visits. Defaults to expanded (the spec).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* private mode / storage disabled — stay expanded */
    }
  }, []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const load = useCallback(
    async (p: PeriodKind, silent: boolean) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      const headers = await bearerHeaders();
      if (!headers) {
        setError("No active session.");
        setLoading(false);
        return;
      }
      try {
        const res = await fetch(`/api/crm/metrics?period=${p}`, { headers });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        const j = (await res.json()) as MetricsResponse;
        // Guard against an out-of-order response for a period the user
        // has since toggled away from.
        if (j.period === p) {
          setData(j);
          setError(null);
        }
      } catch (e) {
        if (!silent) setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Refetch on period change (foreground) + a 60s silent poll so the live
  // Awaiting tile and the period tiles stay current without a reload.
  useEffect(() => {
    load(period, false);
    const timer = window.setInterval(() => load(period, true), REFRESH_MS);
    const onFocus = () => load(period, true);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [period, load]);

  const m = data?.metrics ?? null;
  const trend = data?.trend ?? null;
  const awaiting = data?.awaiting ?? null;

  const collapsedSummary =
    m != null
      ? `${intOrDash(m.medianFirstResponseMin)} min median · ${awaiting?.count ?? 0} awaiting`
      : "";

  return (
    <div className="border-b border-cream-line bg-cream">
      {/* Bar: title + collapse toggle on the left, period segment on the
          right. Always visible even when collapsed. */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 sm:px-4">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Show support metrics" : "Hide support metrics"}
          style={{ touchAction: "manipulation" }}
          className="flex min-w-0 items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-deep-green/70 transition hover:text-deep-green"
        >
          <ChevronDown
            aria-hidden
            size={14}
            strokeWidth={2.5}
            className={`shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
          <span className="shrink-0">Support performance</span>
          {collapsed && collapsedSummary && (
            <span className="truncate text-[11px] font-medium normal-case tracking-normal text-deep-green/45">
              · {collapsedSummary}
            </span>
          )}
        </button>

        <div className="flex shrink-0 overflow-hidden rounded-full border border-cream-line bg-white">
          {(Object.keys(PERIOD_LABELS) as PeriodKind[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              aria-pressed={period === p}
              style={{ touchAction: "manipulation" }}
              className={`px-2.5 py-1 text-[11px] font-bold transition sm:px-3 ${
                period === p
                  ? "rounded-full bg-deep-green text-cream"
                  : "text-deep-green/65 hover:text-deep-green"
              }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {!collapsed && (
        <div className="px-3 pb-3 sm:px-4">
          {error ? (
            <div className="rounded-lg border border-coral/30 bg-coral-soft/50 px-3 py-2 text-[11px] text-coral-hover">
              Couldn’t load metrics: {error}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {/* Tile 1 — Median first response */}
              <Tile
                label="Median first response"
                value={intOrDash(m?.medianFirstResponseMin ?? null)}
                unit="business min"
                loading={loading && !m}
                sub={
                  m
                    ? `${intOrDash(m.respondedCount)} conversation${m.respondedCount === 1 ? "" : "s"}${
                        m.awaitingFirstReplyCount > 0
                          ? ` · ${m.awaitingFirstReplyCount} still awaiting`
                          : ""
                      }`
                    : undefined
                }
                trend={
                  trend?.medianDeltaMin != null
                    ? medianTrend(trend.medianDeltaMin)
                    : undefined
                }
              />

              {/* Tile 2 — Answered within 1 hour */}
              <Tile
                label="Answered within 1 hour"
                value={
                  m?.answeredWithin1hPct == null
                    ? "—"
                    : String(Math.round(m.answeredWithin1hPct))
                }
                unit={m?.answeredWithin1hPct == null ? "" : "%"}
                loading={loading && !m}
                sub={
                  m && m.respondedCount > 0
                    ? `${Math.round((m.answeredWithin1hPct ?? 0) / 100 * m.respondedCount)} of ${m.respondedCount} within 60 min`
                    : undefined
                }
                trend={
                  trend?.within1hDeltaPct != null
                    ? within1hTrend(trend.within1hDeltaPct)
                    : undefined
                }
              />

              {/* Tile 3 — Handled this period */}
              <Tile
                label="Handled this period"
                value={intOrDash(m?.handled.count ?? null)}
                unit="conversations"
                loading={loading && !m}
                sub={
                  m
                    ? `${intOrDash(m.handled.resolved)} resolved${
                        m.handled.closeRatePct != null
                          ? ` · ${Math.round(m.handled.closeRatePct)}% close rate`
                          : ""
                      }`
                    : undefined
                }
                subTitle={
                  m && m.handled.closeRatePct != null && m.handled.closeRatePct > 100
                    ? "Closed / opened this period. Over 100% means more conversations were closed than opened — backlog is being cleared."
                    : undefined
                }
              />

              {/* Tile 4 — Awaiting now (LIVE) */}
              <AwaitingTile awaiting={awaiting} loading={loading && !awaiting} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type TrendChip = { arrow: "▲" | "▼"; text: string; tone: "good" | "bad" };

// Median response: LOWER is better. A negative delta (faster) is good.
function medianTrend(deltaMin: number): TrendChip | undefined {
  const d = Math.round(deltaMin);
  if (d === 0) return undefined;
  return d < 0
    ? { arrow: "▼", text: `${Math.abs(d)} min faster`, tone: "good" }
    : { arrow: "▲", text: `${d} min slower`, tone: "bad" };
}

// Answered-within-1h: HIGHER is better. A positive delta is good.
function within1hTrend(deltaPct: number): TrendChip | undefined {
  const d = Math.round(deltaPct);
  if (d === 0) return undefined;
  return d > 0
    ? { arrow: "▲", text: `${d} pts`, tone: "good" }
    : { arrow: "▼", text: `${Math.abs(d)} pts`, tone: "bad" };
}

function Tile({
  label,
  value,
  unit,
  sub,
  subTitle,
  trend,
  loading,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  subTitle?: string;
  trend?: TrendChip;
  loading?: boolean;
}) {
  return (
    <div className="rounded-xl border border-cream-line bg-white px-3 py-3">
      <div className="text-[10px] font-bold uppercase tracking-wide text-deep-green/45">
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-2xl font-extrabold leading-none tracking-tight text-deep-green">
          {loading ? "…" : value}
        </span>
        {unit && (
          <span className="text-[11px] font-bold text-deep-green/40">{unit}</span>
        )}
      </div>
      {trend && (
        <div
          className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
            trend.tone === "good"
              ? "bg-mint-soft text-mint-hover"
              : "bg-red-50 text-red-600"
          }`}
        >
          <span aria-hidden>{trend.arrow}</span>
          {trend.text}
        </div>
      )}
      {sub && (
        <div
          className="mt-1.5 text-[11px] text-deep-green/50"
          title={subTitle}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// Tile 4 gets its own component: it's live, amber/red by urgency, and
// carries a "Live" marker + a past-window badge instead of a trend chip.
function AwaitingTile({
  awaiting,
  loading,
}: {
  awaiting: MetricsResponse["awaiting"] | null;
  loading?: boolean;
}) {
  const count = awaiting?.count ?? 0;
  const past = awaiting?.pastWindowCount ?? 0;
  const hot = past > 0;
  return (
    <div
      className={`relative rounded-xl border px-3 py-3 ${
        hot ? "border-red-200 bg-red-50/40" : "border-cream-line bg-white"
      }`}
    >
      <span className="absolute right-3 top-3 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-deep-green/40">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-mint" />
        Live
      </span>
      <div className="text-[10px] font-bold uppercase tracking-wide text-deep-green/45">
        Awaiting now
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span
          className={`text-2xl font-extrabold leading-none tracking-tight ${
            hot ? "text-red-600" : count > 0 ? "text-amber-600" : "text-deep-green"
          }`}
        >
          {loading ? "…" : count}
        </span>
        <span className="text-[11px] font-bold text-deep-green/40">waiting</span>
      </div>
      {count > 0 ? (
        <div className="mt-1.5 text-[11px] text-deep-green/50">
          oldest <b className="font-semibold text-deep-green/70">{fmtHours(awaiting?.oldestWaitingHours ?? null)}</b>
          {hot ? (
            <span className="ml-1 font-semibold text-red-600">
              · {past} past 24h window
            </span>
          ) : (
            <span> · none past 24h</span>
          )}
        </div>
      ) : (
        <div className="mt-1.5 text-[11px] text-deep-green/40">all caught up</div>
      )}
    </div>
  );
}
