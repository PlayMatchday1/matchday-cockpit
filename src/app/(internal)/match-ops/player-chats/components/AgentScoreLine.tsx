"use client";

// THE SUPPORT AGENT'S WEEK, one line at the top of Player Chats (Ryan 2026-11-08): resolved by the agent,
// sent from a draft, handled by a person, median first reply. GET /api/crm/agent-scoreboard; the rule is
// src/lib/agentScoreboard.ts. A failed read says so instead of showing zeros.

import { useEffect, useState } from "react";
import { freshAccessToken } from "@/lib/crmSession";
import { fmtMinutes } from "@/lib/inbox2Model";
import type { Scoreboard } from "@/lib/agentScoreboard";

export default function AgentScoreLine() {
  const [s, setS] = useState<Scoreboard | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let off = false;
    void (async () => {
      const token = await freshAccessToken();
      const r = token ? await fetch("/api/crm/agent-scoreboard", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null) : null;
      if (off) return;
      if (!r?.ok) { setError(true); return; }
      setS((await r.json()) as Scoreboard);
    })();
    return () => { off = true; };
  }, []);
  const cell = "whitespace-nowrap";
  return (
    <div data-testid="agent-score-line" title="Player requests started in the last 7 days. Resolved: the agent replied and no person wrote in the next 24 hours. Median first reply in support hours (9am to 9pm Central)."
      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b px-[18px] py-1.5 text-[11.5px]" style={{ borderColor: "#e3e3db", color: "#5e6b66", background: "#fafaf7" }}>
      <span className="font-semibold" style={{ color: "#13241d" }}>This week</span>
      {error ? <span>Couldn&apos;t read the agent&apos;s week.</span> : !s ? <span>Loading…</span> : (
        <>
          <span className={cell} data-testid="score-agent"><b style={{ color: "#12704a" }}>{s.resolvedByAgent}</b> resolved by the agent</span>
          <span className={cell} data-testid="score-drafted"><b>{s.drafted}</b> drafted</span>
          <span className={cell} data-testid="score-person"><b>{s.byPerson}</b> by a person</span>
          <span className={cell} data-testid="score-median">median first reply <b>{fmtMinutes(s.medianFirstReplyMin)}</b></span>
        </>
      )}
    </div>
  );
}
