"use client";

// THE SUPPORT AGENT'S SETTINGS, behind the info icon. Admins change them; the route checks is_admin itself,
// so this panel is a courtesy. Saves each control as it changes.
//
// THE DIAL (Ryan 2026-11-08): each category is Auto (the agent sends on its own), Draft (a person sends it)
// or Off (the agent stays out, no draft). The always-a-person categories offer Draft and Off only. Off is
// greyed until migration 0263 is applied. "Can act" is separate: whether the agent may also give the credit
// or create the guest code in that category.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { bearerHeaders } from "@/lib/crmConversation";
import { categoryMode, type CategoryMode } from "@/lib/aiDraftModel";

type Config = { auto_categories: string[]; action_categories: string[]; off_categories?: string[]; credit_cap_cents: number; hold_minutes: number; enabled: boolean; shadow: boolean; disabled_reason: string | null };
type Lists = { auto: string[]; dial: string[]; action: string[]; offSupported: boolean };

const LABEL: Record<string, string> = {
  veo: "Veo videos", logistics: "Field and match calls", booking: "Booking help", age: "Age", strike: "Strikes",
  membership_billing: "Membership how-tos", player_cancel: "Player cancels", match_cancelled: "Match cancelled",
  needs_credit: "Credits", guest_pass: "Guest passes", promo_code: "Promo codes", field_rental: "Field rentals",
  refund: "Refunds", complaint: "Complaints", payment: "Payments", account: "Account problems", other: "Other",
};
const MODES: { mode: CategoryMode; label: string }[] = [{ mode: "auto", label: "Auto" }, { mode: "draft", label: "Draft" }, { mode: "off", label: "Off" }];

export default function AutoSendPanel() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [lists, setLists] = useState<Lists>({ auto: [], dial: [], action: [], offSupported: false });
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const headers = await bearerHeaders();
      if (!headers) return;
      const res = await fetch("/api/crm/auto-send/config", { headers });
      const j = (await res.json().catch(() => ({}))) as { config?: Config; can_edit?: boolean; categories?: string[]; dial_categories?: string[]; action_categories?: string[]; off_supported?: boolean; error?: string };
      if (!res.ok || !j.config) { setError(j.error ?? `HTTP ${res.status}`); return; }
      setCfg(j.config); setCanEdit(j.can_edit === true);
      setLists({ auto: j.categories ?? [], dial: j.dial_categories ?? j.categories ?? [], action: j.action_categories ?? [], offSupported: j.off_supported === true });
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
  const setMode = (c: string, mode: CategoryMode) => {
    const auto = cfg.auto_categories.filter((x) => x !== c), off = (cfg.off_categories ?? []).filter((x) => x !== c);
    if (mode === "auto") auto.push(c);
    if (mode === "off") off.push(c);
    void save(lists.offSupported ? { auto_categories: auto, off_categories: off } : { auto_categories: auto });
  };
  const chip = (on: boolean) => `rounded-full border px-2 py-0.5 text-[11px] font-semibold disabled:opacity-40 ${on ? "border-deep-green bg-deep-green text-cream" : "border-deep-green/25 bg-white text-deep-green"}`;

  return (
    <div data-testid="auto-send-panel" className="w-[340px] p-3 text-[12px] text-deep-green">
      <div className="mb-1 font-bold">Support agent</div>
      <p data-testid="auto-send-state" className="mb-2 text-deep-green/70">
        {live ? "Live: Auto categories send on their own after a hold." : cfg.shadow ? "Shadow: decisions are stored, nothing sends and no action is written." : "Off: nothing sends. Decisions are still stored."}
      </p>
      {cfg.disabled_reason && <p className="mb-2 rounded-md border border-coral/40 bg-coral-soft px-2 py-1 text-coral-hover">{cfg.disabled_reason}</p>}
      <label className="mb-1 flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={cfg.enabled} onChange={(e) => void save({ enabled: e.target.checked })} /> Enabled</label>
      <label className="mb-2 flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={cfg.shadow} onChange={(e) => void save({ shadow: e.target.checked })} /> Shadow (send nothing)</label>

      <div className="mb-1 grid grid-cols-[1fr_auto_auto] items-center gap-x-2 font-semibold text-deep-green/70"><span>Category</span><span>Setting</span><span title="May also give the credit or create the guest code">Can act</span></div>
      <div data-testid="auto-send-dial" className="mb-2 grid max-h-[320px] grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-1 overflow-y-auto">
        {lists.dial.map((c) => {
          const mode = categoryMode(cfg, c);
          const canAuto = lists.auto.includes(c), canAct = lists.action.includes(c);
          return (
            <div key={c} className="contents" data-testid={`dial-${c}`}>
              <span>{LABEL[c] ?? c}</span>
              <span className="flex gap-0.5">
                {MODES.map(({ mode: m, label }) => {
                  const unavailable = (m === "auto" && !canAuto) || (m === "off" && !lists.offSupported);
                  return (
                    <button key={m} type="button" aria-pressed={mode === m} disabled={!canEdit || unavailable}
                      title={m === "auto" && !canAuto ? "Always goes to a person" : m === "off" && !lists.offSupported ? "Needs migration 0263" : undefined}
                      className={chip(mode === m)} onClick={() => mode !== m && setMode(c, m)}>{label}</button>
                  );
                })}
              </span>
              <span className="text-center">
                {canAct ? <input type="checkbox" aria-label={`${LABEL[c] ?? c} can act`} disabled={!canEdit} checked={cfg.action_categories.includes(c)} onChange={() => void save({ action_categories: toggle(cfg.action_categories, c) })} /> : <span className="text-deep-green/30">·</span>}
              </span>
            </div>
          );
        })}
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
