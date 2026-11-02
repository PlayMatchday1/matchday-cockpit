"use client";

// THE AUTO-SEND SETTINGS, behind the info icon. Admins change them; the route checks is_admin itself, so
// this panel is a courtesy. Saves each control as it changes.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { bearerHeaders } from "@/lib/crmConversation";

type Config = { auto_categories: string[]; action_categories: string[]; credit_cap_cents: number; hold_minutes: number; enabled: boolean; shadow: boolean; disabled_reason: string | null };

export default function AutoSendPanel() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [cats, setCats] = useState<{ auto: string[]; action: string[] }>({ auto: [], action: [] });
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const headers = await bearerHeaders();
      if (!headers) return;
      const res = await fetch("/api/crm/auto-send/config", { headers });
      const j = (await res.json().catch(() => ({}))) as { config?: Config; can_edit?: boolean; categories?: string[]; action_categories?: string[]; error?: string };
      if (!res.ok || !j.config) { setError(j.error ?? `HTTP ${res.status}`); return; }
      setCfg(j.config); setCanEdit(j.can_edit === true); setCats({ auto: j.categories ?? [], action: j.action_categories ?? [] });
    })();
  }, []);

  const save = useCallback(async (patch: Partial<Config>) => {
    setError(null);
    const headers = await bearerHeaders();
    if (!headers) { setError("Sign in again."); return; }
    const res = await fetch("/api/crm/auto-send/config", { method: "PATCH", headers, body: JSON.stringify(patch) });
    const j = (await res.json().catch(() => ({}))) as { config?: Config; error?: string };
    if (!res.ok || !j.config) { setError(j.error ?? `Didn't save (HTTP ${res.status}).`); return; }
    setCfg(j.config);
  }, []);

  if (!cfg) return <div className="p-3 text-[12px] text-deep-green/60">{error ?? "Loading…"}</div>;
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const live = cfg.enabled && !cfg.shadow;
  const chip = (on: boolean) => `rounded-full border px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50 ${on ? "border-deep-green bg-deep-green text-cream" : "border-deep-green/25 bg-white text-deep-green"}`;

  return (
    <div data-testid="auto-send-panel" className="w-[300px] p-3 text-[12px] text-deep-green">
      <div className="mb-1 font-bold">Auto-send</div>
      <p data-testid="auto-send-state" className="mb-2 text-deep-green/70">
        {live ? "Live: replies in the chosen categories send after a hold." : cfg.shadow ? "Shadow: decisions are stored, nothing sends and no action is written." : "Off: nothing sends. Decisions are still stored."}
      </p>
      {cfg.disabled_reason && <p className="mb-2 rounded-md border border-coral/40 bg-coral-soft px-2 py-1 text-coral-hover">{cfg.disabled_reason}</p>}
      <label className="mb-1 flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={cfg.enabled} onChange={(e) => void save({ enabled: e.target.checked })} /> Enabled</label>
      <label className="mb-2 flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={cfg.shadow} onChange={(e) => void save({ shadow: e.target.checked })} /> Shadow (send nothing)</label>
      <div className="mb-1 font-semibold">Categories that can send</div>
      <div className="mb-2 flex flex-wrap gap-1">
        {cats.auto.map((c) => <button key={c} type="button" disabled={!canEdit} className={chip(cfg.auto_categories.includes(c))} onClick={() => void save({ auto_categories: toggle(cfg.auto_categories, c) })}>{c}</button>)}
      </div>
      <div className="mb-1 font-semibold">Categories that can act</div>
      <div className="mb-2 flex flex-wrap gap-1">
        {cats.action.map((c) => <button key={c} type="button" disabled={!canEdit} className={chip(cfg.action_categories.includes(c))} onClick={() => void save({ action_categories: toggle(cfg.action_categories, c) })}>{c}</button>)}
      </div>
      <div className="mb-2 flex items-center gap-3">
        <label className="flex items-center gap-1">Credit cap $
          <input type="number" min={0} max={200} disabled={!canEdit} defaultValue={cfg.credit_cap_cents / 100} onBlur={(e) => { const c = Math.round(Number(e.target.value) * 100); if (c !== cfg.credit_cap_cents) void save({ credit_cap_cents: c }); }} className="w-14 rounded border border-deep-green/25 px-1" />
        </label>
        <label className="flex items-center gap-1">Hold
          <input type="number" min={1} max={60} disabled={!canEdit} defaultValue={cfg.hold_minutes} onBlur={(e) => { const m = Number(e.target.value); if (m !== cfg.hold_minutes) void save({ hold_minutes: m }); }} className="w-12 rounded border border-deep-green/25 px-1" /> min
        </label>
      </div>
      {!canEdit && <p className="mb-2 text-deep-green/60">Only an admin can change these.</p>}
      {error && <p className="mb-2 font-semibold text-coral-hover">{error}</p>}
      <Link href="/match-ops/player-chats/auto-send-review" data-testid="auto-send-review-link" className="font-semibold underline">Auto-send review</Link>
    </div>
  );
}
