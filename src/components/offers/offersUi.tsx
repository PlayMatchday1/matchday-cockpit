"use client";

// GROWTH › OFFERS, the shared parts: the mock's palette (Figma 20571:44), the authed fetch, the write
// outcome, and the small pieces the page and the panel draw. Same grammar as the Match Manager
// Recruiting page (list on the left, one panel on the right), in the Offers mock's colours.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { CampaignState } from "@/lib/offersModel";

export const O = {
  ink: "#0b2e22", muted: "#5d7a6f", label: "#7d948a", line: "#e0e0db", subtle: "#f4f7f5", mint: "#e0f7eb", ok: "#16794a",
  chipOn: "#063d2c", accent: "#2cdb87", accentInk: "#003326", surface: "#ffffff",
  warnBg: "#fcf2d9", warnInk: "#8a6b12", critBg: "#fdeae4", critInk: "#a8391a", critLine: "#f0bda9",
};

const GENERIC = "Something went wrong and nothing was changed. Try again, and tell Ryan if it keeps happening.";
const OFFLINE = "Couldn't reach the Clubhouse. Check your connection; nothing was sent.";

export type ApiResult = { ok: boolean; status: number; json: Record<string, unknown> };
export async function authed(path: string, init: RequestInit = {}): Promise<ApiResult> {
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  let res: Response;
  try {
    res = await fetch(path, {
      ...init, cache: "no-store",
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch (e) {
    console.error(`[offers] ${init.method ?? "GET"} ${path} did not reach the Clubhouse:`, e);
    return { ok: false, status: 0, json: { error: OFFLINE } };
  }
  let json: Record<string, unknown>;
  try { json = await res.json(); } catch {
    console.error(`[offers] ${init.method ?? "GET"} ${path}: HTTP ${res.status}, the answer was not JSON`);
    return { ok: false, status: res.status, json: { error: GENERIC } };
  }
  if (!res.ok && typeof json.error !== "string" && !json.verdict) json = { ...json, error: GENERIC };
  return { ok: res.ok, status: res.status, json };
}

// One write as the screen reports it. ERROR = the route refused before sending anything.
// SENT: the backend took it and nothing here can read it back (Send to my phone only).
export type Verdict = "LANDED" | "SENT" | "FAILED" | "NOT APPLIED" | "UNKNOWN";
export type WriteOutcome = { verdict: Verdict | "ERROR"; text: string };
export function outcomeOf(r: ApiResult, landedText: string): WriteOutcome {
  const verdict = r.json.verdict as Verdict | undefined;
  if (!verdict) return { verdict: "ERROR", text: String(r.json.error ?? `HTTP ${r.status}`) };
  if (verdict === "LANDED" || verdict === "SENT") return { verdict, text: landedText };
  if (verdict === "UNKNOWN") return { verdict, text: "The backend may or may not have done this. Refresh and check before doing anything else; it was not retried." };
  if (verdict === "NOT APPLIED") return { verdict, text: String(r.json.detail ?? "The backend answered, but the read-back does not show the change.") };
  return { verdict, text: String(r.json.error ?? "the backend refused it") };
}
// After anything but a clean failure a control stays put: re-sending an UNKNOWN is the double write.
export const settled = (o: WriteOutcome | null) => o !== null && o.verdict !== "FAILED" && o.verdict !== "ERROR";

export function VerdictLine({ outcome }: { outcome: WriteOutcome }) {
  const good = outcome.verdict === "LANDED" || outcome.verdict === "SENT";
  return (
    <div data-testid="offers-verdict" data-verdict={outcome.verdict} className="rounded-[8px] border px-2.5 py-2 text-[12px]"
      style={good ? { background: O.mint, borderColor: "#bfe2cf", color: O.ok } : outcome.verdict === "UNKNOWN" ? { background: O.warnBg, borderColor: "#e3c369", color: O.warnInk } : { background: O.critBg, borderColor: O.critLine, color: O.critInk }}>
      {outcome.verdict === "SENT" ? outcome.text : <><b>{outcome.verdict}</b> · {outcome.text}</>}
    </div>
  );
}

// Fixed in the corner, not in the flow, so a landed write never shifts the list under the next click.
export function Banner({ outcome, onDismiss }: { outcome: WriteOutcome; onDismiss: () => void }) {
  return (
    <div role="status" className="fixed bottom-4 right-4 z-50 flex max-w-[min(520px,calc(100vw-32px))] items-start gap-2 rounded-[10px] p-1.5 shadow-lg" style={{ background: O.surface }}>
      <div className="flex-1"><VerdictLine outcome={outcome} /></div>
      <button type="button" onClick={onDismiss} className="rounded-[8px] border px-2.5 py-2 text-[12px] font-semibold" style={{ borderColor: O.line, color: O.muted, background: O.surface }}>Dismiss</button>
    </div>
  );
}

export function Btn({ children, onClick, kind = "plain", disabled, title, testId }: {
  children: React.ReactNode; onClick?: () => void; kind?: "plain" | "primary" | "danger" | "dangerSolid"; disabled?: boolean; title?: string; testId?: string;
}) {
  const s = kind === "primary" ? { background: O.accent, borderColor: O.accent, color: O.accentInk }
    : kind === "danger" ? { background: O.surface, borderColor: O.line, color: O.critInk }
    : kind === "dangerSolid" ? { background: O.critInk, borderColor: O.critInk, color: "#fff" }
    : { background: O.surface, borderColor: O.line, color: O.ink };
  return (
    <button type="button" data-testid={testId} onClick={onClick} disabled={disabled} title={title}
      className="inline-flex items-center whitespace-nowrap rounded-[8px] border px-4 py-[8px] text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-50" style={s}>
      {children}
    </button>
  );
}

export function Chip({ on, onClick, children, testId, disabled, title }: { on: boolean; onClick?: () => void; children: React.ReactNode; testId?: string; disabled?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} data-on={on ? "1" : "0"} disabled={disabled} title={title}
      className={`inline-flex items-center whitespace-pre rounded-full border px-3 py-[6px] text-[12px] ${on ? "font-semibold" : "font-medium"} disabled:cursor-not-allowed ${disabled && !on ? "opacity-50" : ""}`}
      style={on ? { background: O.chipOn, borderColor: O.chipOn, color: "#fff" } : { background: O.surface, borderColor: O.line, color: O.ink }}>
      {children}
    </button>
  );
}

const STATE_CHIP: Record<CampaignState, { bg: string; ink: string; border?: string }> = {
  LIVE: { bg: O.mint, ink: O.ok }, SCHEDULED: { bg: O.warnBg, ink: O.warnInk }, PAUSED: { bg: "#e6effc", ink: "#2456a6" },
  ENDED: { bg: "#eef0ee", ink: O.muted }, DRAFT: { bg: O.surface, ink: O.muted, border: O.line },
};
export function StateChip({ state, label }: { state: CampaignState; label: string }) {
  const s = STATE_CHIP[state];
  return (
    <span data-testid="offers-state" data-state={state} className="inline-flex items-center whitespace-nowrap rounded-full px-2 py-[3px] text-[11px] font-semibold"
      style={{ background: s.bg, color: s.ink, border: s.border ? `1px solid ${s.border}` : undefined }}>{label}</span>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-semibold tracking-[0.6px]" style={{ color: O.label }}>{children}</div>;
}
export function PanelSection({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="flex flex-col gap-2.5 border-t p-4" style={{ borderColor: O.line }}>
      <SectionLabel>{title.toUpperCase()}</SectionLabel>
      {children}
    </section>
  );
}
export function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[12px] font-medium" style={{ color: O.ink }}>{label}</div>
      {children}
    </div>
  );
}
export const inputCls = "w-full rounded-[8px] border px-3 py-[9px] text-[13px] outline-none disabled:cursor-not-allowed disabled:opacity-60";
export const inputStyle = { borderColor: O.line, color: O.ink, background: O.surface } as const;

// List on the left, one panel on the right; on narrow screens the panel drops under the list.
export function Split({ main, panel }: { main: React.ReactNode; panel: React.ReactNode | null }) {
  return (
    <div className={`grid items-start gap-5 ${panel ? "xl:grid-cols-[minmax(0,1fr)_430px]" : ""}`}>
      <div className="min-w-0">{main}</div>
      {panel ? <aside className="min-w-0 xl:sticky xl:top-[72px] xl:max-h-[calc(100vh-88px)] xl:overflow-y-auto xl:rounded-[12px]">{panel}</aside> : null}
    </div>
  );
}

// For big one-way actions: launch, pause, end. LANDED closes it (the caller reports it); anything else
// stays open with its verdict, and the action stays locked once settled (never a double write).
export function ConfirmDialog({ title, note, action, kind = "primary", onConfirm, onCancel }: {
  title: string; note?: string | null; action: string; kind?: "primary" | "dangerSolid";
  onConfirm: () => Promise<WriteOutcome | null>; onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [busy, onCancel]);
  async function go() {
    setBusy(true);
    const o = await onConfirm();
    setBusy(false);
    if (o && o.verdict !== "LANDED") setOutcome(o);
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(7,42,32,.18)" }} onClick={() => { if (!busy) onCancel(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} data-testid="offers-confirm" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[360px] rounded-[12px] border px-5 pb-4 pt-5 shadow-[0_12px_40px_rgba(7,42,32,.18)]" style={{ background: O.surface, borderColor: O.line }}>
        <div className="text-[16px] font-bold" style={{ color: O.ink }}>{title}</div>
        {note ? <div className="mt-1.5 text-[12.5px] leading-[18px]" style={{ color: O.muted }}>{note}</div> : null}
        {outcome && <div className="mt-3"><VerdictLine outcome={outcome} /></div>}
        <div className="mt-4 flex justify-end gap-2">
          <Btn testId="offers-confirm-cancel" disabled={busy} onClick={onCancel}>Cancel</Btn>
          <Btn kind={kind} testId="offers-confirm-yes" disabled={busy || settled(outcome)} onClick={go}>{busy ? "Working…" : action}</Btn>
        </div>
      </div>
    </div>
  );
}

export function NotFound() {
  return (
    <div data-testid="offers-not-found" className="flex min-h-[50vh] items-center justify-center px-6 py-12 text-center">
      <div>
        <div className="text-[13px] font-bold" style={{ color: O.muted }}>404</div>
        <div className="mt-1 text-[15px]" style={{ color: O.ink }}>This page could not be found.</div>
      </div>
    </div>
  );
}
