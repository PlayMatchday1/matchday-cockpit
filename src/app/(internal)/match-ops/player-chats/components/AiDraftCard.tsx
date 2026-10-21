"use client";

// THE CLAUDE DRAFT CARD — sits above the reply box in Player Chats (phase 1).
//
// When the latest message in the thread is from the player (and it isn't STOP, a bare greeting, or
// a closed WhatsApp window — the same rule the server applies, src/lib/aiDraftModel), the card asks
// /api/crm/threads/[id]/ai-draft for a draft and shows it with staff-only notes.
//
//   Use draft   fills the reply box. It NEVER sends. The staff member edits and presses the
//               existing Send, which carries draft_id so the server can record sent_unchanged or
//               sent_edited.
//   Discard     records `discarded` and hides the card.
//   Regenerate  asks for a fresh draft (one model call; the old pending one is superseded).
//
// A thread that already has a draft for this player message gets the stored one back for free.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Sparkles, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { draftEligibility, type DraftMsg } from "@/lib/aiDraftModel";
import type { ConversationMessage } from "./MessageBubble";

type Draft = { id: string; text: string; staff_notes: string; category: string | null; flags: string[] };
type Resp =
  | { status: "ok"; reused: boolean; draft: Draft }
  | { status: "skipped" | "not_configured" | "cap_reached" | "forbidden" | "not_found"; message: string }
  | { status: "discarded"; draft_id: string; message: string }
  | { status: "failed"; draft_id: string | null; message: string };

type View =
  | { kind: "loading" }
  | { kind: "draft"; draft: Draft }
  | { kind: "info"; message: string; canRegenerate: boolean }
  | { kind: "hidden" };

const FLAG_LABEL: Record<string, string> = {
  escalate: "Escalate",
  urgent: "Urgent",
  hold_requested: "Hold requested: tell Ryan",
  strike_dispute: "Strike dispute",
  guest_pass: "Guest passes",
  under_16: "Under 16",
  refund_pushback: "Refund pushback",
  needs_credit: "Needs a credit",
};

async function authHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : null;
}

export default function AiDraftCard({
  threadId,
  channel,
  messages,
  usedDraftId,
  onUse,
  onDiscarded,
}: {
  threadId: string;
  channel: string;
  messages: ConversationMessage[];
  /** The draft currently sitting in the reply box, if any. */
  usedDraftId: string | null;
  onUse: (text: string, draftId: string) => void;
  onDiscarded: (draftId: string) => void;
}) {
  const [view, setView] = useState<View>({ kind: "hidden" });
  const [busy, setBusy] = useState(false);

  // The same eligibility rule the server applies. Recomputed as messages arrive, so a reply from
  // a colleague hides the card and a new player message brings it back.
  const elig = useMemo(() => draftEligibility(messages as unknown as DraftMsg[], channel, Date.now()), [messages, channel]);
  const basedOnId = elig.ok ? elig.basedOn.id : null;

  const apply = useCallback((r: Resp) => {
    if (r.status === "ok") setView({ kind: "draft", draft: r.draft });
    else if (r.status === "skipped") setView({ kind: "hidden" });
    else setView({ kind: "info", message: r.message, canRegenerate: r.status === "failed" || r.status === "discarded" });
  }, []);

  const request = useCallback(async (regenerate: boolean) => {
    const headers = await authHeaders();
    if (!headers) { setView({ kind: "info", message: "Sign in again to get drafts.", canRegenerate: false }); return; }
    setView({ kind: "loading" });
    try {
      const res = await fetch(`/api/crm/threads/${threadId}/ai-draft`, { method: "POST", headers, body: JSON.stringify({ regenerate }) });
      const j = (await res.json().catch(() => null)) as Resp | null;
      if (!j) throw new Error(`HTTP ${res.status}`);
      apply(j);
    } catch (e) {
      setView({ kind: "info", message: `Couldn't get a draft (${e instanceof Error ? e.message : "error"}).`, canRegenerate: true });
    }
  }, [threadId, apply]);

  useEffect(() => {
    if (!basedOnId) { setView({ kind: "hidden" }); return; }
    void request(false);
  }, [threadId, basedOnId, request]);

  const discard = useCallback(async (draftId: string) => {
    setBusy(true);
    const headers = await authHeaders();
    try {
      if (headers) {
        await fetch(`/api/crm/threads/${threadId}/ai-draft/discard`, { method: "POST", headers, body: JSON.stringify({ draft_id: draftId }) });
      }
    } finally {
      setBusy(false);
      onDiscarded(draftId);
      setView({ kind: "info", message: "Draft discarded.", canRegenerate: true });
    }
  }, [threadId, onDiscarded]);

  if (view.kind === "hidden") return null;

  return (
    <div data-testid="ai-draft-card" className="mb-2 rounded-lg border border-deep-green/15 bg-cream-soft px-3 py-2 text-sm text-deep-green">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-deep-green/60">
        <Sparkles aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
        Claude draft
        <span className="font-normal normal-case tracking-normal text-deep-green/45">· nothing is sent until you press Send</span>
      </div>

      {view.kind === "loading" && <div data-testid="ai-draft-loading" className="text-xs text-deep-green/55">Drafting a reply…</div>}

      {view.kind === "info" && (
        <div className="flex items-center justify-between gap-2 text-xs text-deep-green/65">
          <span data-testid="ai-draft-info">{view.message}</span>
          {view.canRegenerate && (
            <button type="button" onClick={() => void request(true)} className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 font-semibold hover:bg-white">
              <RefreshCw aria-hidden className="h-3.5 w-3.5" /> Regenerate
            </button>
          )}
        </div>
      )}

      {view.kind === "draft" && (
        <>
          {view.draft.text ? (
            <p data-testid="ai-draft-text" className="whitespace-pre-wrap rounded-md bg-white px-2.5 py-2 text-[14px] leading-snug">{view.draft.text}</p>
          ) : (
            <p className="text-xs italic text-deep-green/60">Claude suggests no reply to this one.</p>
          )}
          {(view.draft.flags.length > 0 || view.draft.staff_notes) && (
            <div data-testid="ai-draft-notes" className="mt-1.5 text-[12px] text-deep-green/70">
              <span className="font-semibold">Staff only: </span>
              {view.draft.flags.map((f) => (
                <span key={f} className="mr-1 inline-block rounded-full border border-coral/40 bg-coral-soft px-1.5 text-[11px] font-semibold text-coral-hover">{FLAG_LABEL[f] ?? f}</span>
              ))}
              {view.draft.staff_notes}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {view.draft.text && (
              <button
                type="button"
                data-testid="ai-draft-use"
                disabled={busy}
                onClick={() => onUse(view.draft.text, view.draft.id)}
                className="rounded-full bg-deep-green px-3 py-1 text-xs font-bold text-cream hover:bg-deep-green-soft disabled:opacity-40"
              >
                {usedDraftId === view.draft.id ? "In the reply box" : "Use draft"}
              </button>
            )}
            <button type="button" data-testid="ai-draft-discard" disabled={busy} onClick={() => void discard(view.draft.id)} className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold text-deep-green/70 hover:bg-white disabled:opacity-40">
              <X aria-hidden className="h-3.5 w-3.5" /> Discard
            </button>
            <button type="button" data-testid="ai-draft-regenerate" disabled={busy} onClick={() => void request(true)} className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold text-deep-green/70 hover:bg-white disabled:opacity-40">
              <RefreshCw aria-hidden className="h-3.5 w-3.5" /> Regenerate
            </button>
          </div>
        </>
      )}
    </div>
  );
}
