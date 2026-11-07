"use client";

// CHAT STATS — the ⋯ menu's popover. The old page's metrics strip is one 52px band built for a
// full-width header; in a dialog it overflowed and the range toggle was clipped (Ryan 2026-11-07).
// Here: the range toggle on its own row, then the five numbers as a two-row grid. Same route
// (GET /api/crm/metrics?period=), same numbers (statsCells in src/lib/inbox2Model).

import { useEffect, useState } from "react";
import { freshAccessToken } from "@/lib/crmSession";
import { statsCells, type StatsResponse } from "@/lib/inbox2Model";

type Period = "week" | "month" | "all";
const LABEL: Record<Period, string> = { week: "This week", month: "This month", all: "All time" };
const TONE = { plain: "#7c8782", good: "#12704a", bad: "#a83b1c", amber: "#8a6300" } as const;

export default function ChatStats() {
  const [period, setPeriod] = useState<Period>("week");
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    setData(null); setError(null);
    void (async () => {
      const token = await freshAccessToken();
      if (!token) { if (!off) setError("Sign in again to read the stats."); return; }
      const r = await fetch(`/api/crm/metrics?period=${period}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
      if (off) return;
      if (!r?.ok) { setError(`Couldn't read the stats${r ? ` (HTTP ${r.status})` : ""}.`); return; }
      setData((await r.json()) as StatsResponse);
    })();
    return () => { off = true; };
  }, [period]);

  return (
    <div data-testid="chat-stats" className="flex flex-col gap-4 p-4">
      <div role="tablist" data-testid="chat-stats-range" className="flex gap-1 self-start rounded-[10px] bg-[#f3f3ef] p-1">
        {(Object.keys(LABEL) as Period[]).map((p) => (
          <button key={p} role="tab" type="button" aria-selected={period === p} onClick={() => setPeriod(p)}
            className="rounded-[8px] px-3 py-[6px] text-[12px]"
            style={period === p ? { background: "#fff", color: "#13241d", fontWeight: 600, boxShadow: "0 1px 2px rgba(9,30,20,.06)" } : { color: "#5e6b66", fontWeight: 500 }}>
            {LABEL[p]}
          </button>
        ))}
      </div>
      {error && <p className="text-[12px] text-[#a83b1c]">{error}</p>}
      <div data-testid="chat-stats-grid" className="grid grid-cols-2 gap-2 min-[440px]:grid-cols-3">
        {statsCells(data).map((c) => (
          <div key={c.key} data-testid={`chat-stat-${c.key}`} className="min-w-0 rounded-[10px] bg-[#f7f7f3] px-3 py-[10px]">
            <div className="text-[18px] font-bold tabular-nums text-[#13241d]">{c.value}</div>
            <div className="truncate text-[11px] font-medium text-[#7c8782]">{c.label}</div>
            {c.sub && <div className="text-[11px] font-semibold" style={{ color: TONE[c.tone] }}>{c.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
