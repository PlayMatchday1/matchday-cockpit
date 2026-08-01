"use client";

// Player Chats metrics strip (mockup playerchats-v1) — ONE 52px band, ONE
// period, ONE denominator. Replaces the old dark title band + four metric
// cards, which showed four competing denominators for a single week (replied
// EPISODES 45, distinct THREADS handled 31, closed-in-range 30, live-open 0).
//
// Here every number is a straight thread count over the SAME cohort:
//   N = conversations opened in the period (fakes excluded, server-side).
//   median first reply / answered-within-1h / resolved are all measured
//   against that N (see supportMetrics.cohort + the metrics route).
//
// Right side: the "waiting on a reply" pill — amber when N_awaiting > 0, mint
// "All caught up" at zero — the same live awaiting count the rail badge shows
// (both derive from the shared isAwaitingReply rule). Owns its own period
// toggle; fetches /api/crm/metrics itself.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Period = "week" | "month" | "all";

type MetricsResponse = {
  metrics: {
    cohort: {
      conversations: number;
      repliedCount: number;
      medianFirstResponseMin: number | null;
      answeredWithin1h: number;
      answeredWithin1hPct: number | null;
      resolved: number;
      resolvedPct: number | null;
    };
  };
  trend: { cohortMedianDeltaMin: number | null } | null;
  awaiting: { count: number };
};

const PERIOD_LABEL: Record<Period, string> = {
  week: "This week",
  month: "This month",
  all: "All time",
};

function fmtMin(min: number | null): string {
  if (min == null) return "—";
  if (min < 1) return "<1m";
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const r = Math.round(min % 60);
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

export default function MetricsStrip() {
  const [period, setPeriod] = useState<Period>("week");
  const [data, setData] = useState<MetricsResponse | null>(null);

  const load = useCallback(async (p: Period) => {
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s.session?.access_token;
      if (!token) return;
      const res = await fetch(`/api/crm/metrics?period=${p}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) return;
      setData((await res.json()) as MetricsResponse);
    } catch {
      // leave last value; the strip degrades to blanks, never throws
    }
  }, []);

  useEffect(() => {
    void load(period);
    const t = setInterval(() => void load(period), 60_000);
    return () => clearInterval(t);
  }, [period, load]);

  const c = data?.metrics.cohort ?? null;
  const N = c?.conversations ?? null;
  const awaiting = data?.awaiting.count ?? 0;
  const delta = data?.trend?.cohortMedianDeltaMin ?? null;

  return (
    <div
      className="flex h-[52px] flex-none items-center gap-0 overflow-hidden whitespace-nowrap border-b pl-[18px] pr-4"
      style={{ background: "linear-gradient(180deg,#fafbfa,#f6f9f7)", borderColor: "#e6ebe8" }}
    >
      <span className="flex-none text-[9.5px] font-extrabold uppercase tracking-[0.13em]" style={{ color: "#93a49b" }}>
        {PERIOD_LABEL[period]}
      </span>
      <span className="mx-[15px] h-5 w-px flex-none" style={{ background: "#e6ebe8" }} />

      <Stat value={N == null ? "—" : String(N)} label="conversations" />
      <Stat
        value={fmtMin(c?.medianFirstResponseMin ?? null)}
        label="median first reply"
        delta={
          delta != null && delta !== 0
            ? { good: delta < 0, text: `${fmtMin(Math.abs(delta))} ${delta < 0 ? "faster" : "slower"}` }
            : undefined
        }
      />
      <Stat
        drop
        value={c ? String(c.answeredWithin1h) : "—"}
        label="answered within 1h"
        sub={c?.answeredWithin1hPct != null ? `${Math.round(c.answeredWithin1hPct)}%` : undefined}
      />
      <Stat
        drop
        value={c ? String(c.resolved) : "—"}
        label="resolved"
        sub={N != null ? `of ${N}` : undefined}
      />

      <span className="min-w-[8px] flex-1" />

      <span
        className="mr-3 inline-flex h-[29px] flex-none items-center gap-[7px] rounded-full border px-3 text-[12px] font-[750]"
        style={
          awaiting > 0
            ? { background: "#fdf1d0", color: "#8a6300", borderColor: "#e3c369" }
            : { background: "#e0f2e7", color: "#12704a", borderColor: "#c9e8d8" }
        }
      >
        <i
          className="h-1.5 w-1.5 flex-none rounded-full"
          style={{ background: awaiting > 0 ? "#d99a12" : "#35c77f", animation: awaiting > 0 ? "mc-pulse 2.4s infinite" : undefined }}
        />
        {awaiting > 0 ? `${awaiting} waiting on a reply` : "All caught up"}
      </span>

      <span className="flex flex-none gap-0.5 rounded-[9px] p-[2px]" style={{ background: "rgba(0,0,0,.045)" }}>
        {(["week", "month", "all"] as Period[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className="h-[25px] rounded-[7px] px-[10px] text-[11.5px] font-[650] transition"
            style={period === p ? { background: "#ffffff", color: "#0f3d2e", fontWeight: 750, boxShadow: "0 1px 2px rgba(7,42,32,.09)" } : { color: "#5c7267" }}
          >
            {PERIOD_LABEL[p]}
          </button>
        ))}
      </span>

      <style>{`@keyframes mc-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}`}</style>
    </div>
  );
}

function Stat({
  value,
  label,
  sub,
  delta,
  drop,
}: {
  value: string;
  label: string;
  sub?: string;
  delta?: { good: boolean; text: string };
  drop?: boolean;
}) {
  return (
    <span className={`mr-[22px] flex flex-none items-baseline gap-1.5 ${drop ? "hidden min-[1400px]:flex" : ""}`}>
      <b className="text-[16px] font-[780] tabular-nums tracking-[-0.02em]" style={{ color: "#12241d" }}>{value}</b>
      <span className="text-[11.5px] font-semibold" style={{ color: "#6d7b74" }}>{label}</span>
      {sub && <span className="text-[11px] font-[650]" style={{ color: "#a4b0aa" }}>{sub}</span>}
      {delta && (
        <span className="rounded-[6px] px-1.5 py-px text-[10px] font-extrabold" style={{ background: "#e0f2e7", color: "#12704a" }}>
          {delta.text}
        </span>
      )}
    </span>
  );
}
