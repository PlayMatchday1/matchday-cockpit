"use client";

// THE STAFF APP PUSH KILL SWITCHES (Ryan, 2026-10-30): one per event, off stops it for everyone.
// The switch moves only when the server confirms it moved, like the permission boxes below it.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Sw = { event: "player_chat" | "match_at_risk"; enabled: boolean; updated_by: string | null; updated_at: string | null };
const LABEL: Record<Sw["event"], string> = { player_chat: "Player chats", match_at_risk: "Matches at risk" };
const HINT: Record<Sw["event"], string> = {
  player_chat: "A player message that leaves a conversation waiting on a reply",
  match_at_risk: "A match below its minimum an hour before it auto-cancels",
};

async function bearer(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export default function AppPushSwitches() {
  const [rows, setRows] = useState<Sw[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const t = await bearer();
    const r = await fetch("/api/admin/push-switches", { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    const j = (await r.json().catch(() => ({}))) as { switches?: Sw[]; error?: string };
    if (!r.ok) { setErr(j.error ?? `HTTP ${r.status}`); return; }
    setRows(j.switches ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function flip(s: Sw) {
    setBusy(s.event); setErr(null);
    try {
      const t = await bearer();
      const r = await fetch("/api/admin/push-switches", {
        method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
        body: JSON.stringify({ event: s.event, enabled: !s.enabled }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) setErr(j.error ?? `HTTP ${r.status}`);
      await load();
    } finally { setBusy(null); }
  }

  return (
    <section className="mb-6 rounded-2xl bg-white p-4 ring-1 ring-cream-line" data-testid="app-push-switches">
      <h2 className="text-sm font-semibold text-deep-green">Staff app notifications</h2>
      <p className="mt-0.5 text-xs text-deep-green/60">Turning one off stops it for every staff member at once.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        {(rows ?? []).map((s) => (
          <button key={s.event} type="button" disabled={busy === s.event} onClick={() => void flip(s)} aria-pressed={s.enabled}
            data-testid={`push-switch-${s.event}`}
            className={`flex min-w-[260px] items-center justify-between gap-3 rounded-xl px-3 py-2 text-left ring-1 ring-inset transition disabled:opacity-50 ${s.enabled ? "bg-mint/40 ring-mint" : "bg-cream-soft ring-cream-line"}`}>
            <span>
              <span className="block text-sm font-semibold text-deep-green">{LABEL[s.event]}</span>
              <span className="block text-[11px] text-deep-green/60">{HINT[s.event]}</span>
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${s.enabled ? "bg-deep-green text-white" : "bg-white text-deep-green/60 ring-1 ring-cream-line"}`}>{s.enabled ? "On" : "Off"}</span>
          </button>
        ))}
      </div>
      {err ? <p className="mt-2 text-xs text-coral" data-testid="push-switch-error">{err}</p> : null}
    </section>
  );
}
