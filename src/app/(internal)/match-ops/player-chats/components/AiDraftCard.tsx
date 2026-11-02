"use client";

// THE CLAUDE DRAFT CARD — sits above the reply box in Player Chats (phase 1).
//
// When the latest message in the thread is from the player (and it isn't STOP, a bare greeting, or
// a closed WhatsApp window — the same rule the server applies, src/lib/aiDraftModel), the card asks
// /api/crm/threads/[id]/ai-draft for a draft and shows it with staff-only notes.
//
//   Use draft   fills the reply box. It NEVER sends. The staff member edits and presses the
//               existing Send, which carries draft_id so the server can record sent_unchanged or
//               sent_edited. With an action proposed, this fills the version that doesn't claim it.
//   Credit $8.00 + use draft
//               applies the draft's action through /ai-draft/action, then fills the reply box with
//               the version that says it's done. If the write doesn't land the box stays as it was
//               and the error shows here. It never sends: Send stays the one path out.
//   Discard     opens the reason chips; choosing one records `discarded` and hides the card.
//   Regenerate  asks for a fresh draft (one model call; the old pending one is superseded).
//
// A thread that already has a draft for this player message gets the stored one back for free. A
// hidden tab asks for nothing until someone comes back to it: a draft is only ever requested with a
// person looking at the thread.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Sparkles, X } from "lucide-react";
import { DISCARD_CHIPS, draftEligibility, linkSuggestionText, type DraftMsg, type LinkSuggestion } from "@/lib/aiDraftModel";
import { fmtUsd } from "@/lib/creditsModel";
import { freshAccessToken } from "@/lib/crmSession";
import { linkThreadToPlayer, THREAD_LINKED_EVENT } from "@/lib/crmLinkClient";
import type { ConversationMessage } from "./MessageBubble";

type Draft = {
  id: string; text: string; staff_notes: string[]; category: string | null; flags: string[];
  text_without_action: string | null;
  action: { kind: "credit" | "issue_guest_code"; amount_cents: number | null } | null;
  action_status: string | null;
  decision?: string | null;
  decision_reason?: string | null;
};
type Resp = (
  | { status: "ok"; reused: boolean; draft: Draft }
  | { status: "skipped" | "not_configured" | "cap_reached" | "forbidden" | "not_found"; message: string }
  | { status: "discarded"; draft_id: string; message: string }
  | { status: "failed"; draft_id: string | null; message: string }
) & { link_suggestion?: LinkSuggestion | null; action_refusal?: string | null };

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

const ACTION_DONE = new Set(["applying", "landed", "unknown"]);
const actionLabel = (a: NonNullable<Draft["action"]>) =>
  a.kind === "credit" ? `Credit ${fmtUsd(a.amount_cents ?? 0)} + use draft` : "Issue guest code + use draft";
// The server fills the real code in after creating it. Until then the card says so.
const shown = (text: string) => text.replace("{code}", "[code, filled in when issued]");

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await freshAccessToken();
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
  // "Matches Sam, link?" — shown when the account is unconfirmed and the player typed a number.
  // Nothing links until a person presses Link.
  const [suggestion, setSuggestion] = useState<LinkSuggestion | null>(null);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const [actionRefusal, setActionRefusal] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [discardNote, setDiscardNote] = useState("");

  // The same eligibility rule the server applies. Recomputed as messages arrive, so a reply from
  // a colleague hides the card and a new player message brings it back.
  const elig = useMemo(() => draftEligibility(messages as unknown as DraftMsg[], channel, Date.now()), [messages, channel]);
  const basedOnId = elig.ok ? elig.basedOn.id : null;

  const apply = useCallback((r: Resp) => {
    setSuggestion(r.link_suggestion ?? null);
    setActionRefusal(r.action_refusal ?? null);
    setActionMsg(null);
    setDiscarding(false);
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
    setSuggestion(null); setLinkMsg(null);
    if (!basedOnId) { setView({ kind: "hidden" }); return; }
    if (document.visibilityState === "visible") { void request(false); return; }
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisible);
      void request(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [threadId, basedOnId, request]);

  // Linked from here or from the context pane: the stored draft was superseded on the server, so
  // asking again drafts from the newly linked account.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<{ threadId: string }>).detail?.threadId !== threadId || !basedOnId) return;
      setSuggestion(null);
      void request(false);
    };
    window.addEventListener(THREAD_LINKED_EVENT, on);
    return () => window.removeEventListener(THREAD_LINKED_EVENT, on);
  }, [threadId, basedOnId, request]);

  const confirmLink = useCallback(async (playerId: number) => {
    setBusy(true); setLinkMsg(null);
    const r = await linkThreadToPlayer(threadId, playerId);
    setBusy(false);
    setLinkMsg(r.ok ? `Linked to ${r.first_name ?? "that account"}.` : `Couldn't link: ${r.error}`);
  }, [threadId]);

  const discard = useCallback(async (draftId: string, chip: string, note: string) => {
    setBusy(true);
    const headers = await authHeaders();
    try {
      if (headers) {
        await fetch(`/api/crm/threads/${threadId}/ai-draft/discard`, { method: "POST", headers, body: JSON.stringify({ draft_id: draftId, chip, note }) });
      }
    } finally {
      setBusy(false);
      setDiscarding(false);
      setDiscardNote("");
      onDiscarded(draftId);
      setView({ kind: "info", message: "Draft discarded.", canRegenerate: true });
    }
  }, [threadId, onDiscarded]);

  const applyAction = useCallback(async (draft: Draft) => {
    setBusy(true); setActionMsg(null);
    const headers = await authHeaders();
    if (!headers) { setBusy(false); setActionMsg({ ok: false, text: "Sign in again, nothing was applied." }); return; }
    try {
      const res = await fetch(`/api/crm/threads/${threadId}/ai-draft/action`, { method: "POST", headers, body: JSON.stringify({ draft_id: draft.id }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: string; text?: string; message?: string; error?: string };
      if (j.ok === true && typeof j.text === "string") {
        // LANDED, so the reply saying so goes in the box. The reply box still needs a person to press Send.
        setView({ kind: "draft", draft: { ...draft, text: j.text, action_status: "landed" } });
        setActionMsg({ ok: true, text: j.message ?? "Applied. Nothing sent yet, press Send." });
        onUse(j.text, draft.id);
      } else {
        // NOT LANDED: the reply box is left alone.
        setView({ kind: "draft", draft: { ...draft, action_status: j.status && j.status !== "refused" ? j.status : draft.action_status } });
        setActionMsg({ ok: false, text: j.error ?? `Nothing was applied (HTTP ${res.status}).` });
      }
    } catch (e) {
      // No answer at all: it may have landed.
      setView({ kind: "draft", draft: { ...draft, action_status: "unknown" } });
      setActionMsg({ ok: false, text: `No answer from the server (${e instanceof Error ? e.message : "error"}). This may have landed, so check Player Lookup.` });
    } finally {
      setBusy(false);
    }
  }, [threadId, onUse]);

  if (view.kind === "hidden") return null;

  const suggestionRow = (suggestion || linkMsg) && (
    <div data-testid="ai-draft-link" data-kind={suggestion?.kind ?? "done"} className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-deep-green/75">
      {suggestion && <span><span className="font-semibold">Staff only: </span>{linkSuggestionText(suggestion)}</span>}
      {suggestion?.kind === "one" && !linkMsg && (
        <button type="button" data-testid="ai-draft-link-confirm" disabled={busy}
          onClick={() => void confirmLink(suggestion.player_id)}
          className="rounded-full bg-deep-green px-2.5 py-0.5 text-[11px] font-bold text-cream hover:bg-deep-green-soft disabled:opacity-40">
          Link
        </button>
      )}
      {linkMsg && <span data-testid="ai-draft-link-result" className="font-semibold">{linkMsg}</span>}
    </div>
  );

  return (
    <div data-testid="ai-draft-card" className="mb-2 rounded-lg border border-deep-green/15 bg-cream-soft px-3 py-2 text-sm text-deep-green">
      {view.kind === "draft" && view.draft.decision === "human" && (
        <div data-testid="ai-draft-needs-you" className="mb-1 text-[13px] font-[750]" style={{ color: "#a82a18" }}>
          Needs you: {view.draft.decision_reason ?? "this one needs a person"}
        </div>
      )}
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
      {view.kind === "info" && suggestionRow}

      {view.kind === "draft" && (
        <>
          {view.draft.text ? (
            <p data-testid="ai-draft-text" className="whitespace-pre-wrap rounded-md bg-white px-2.5 py-2 text-[14px] leading-snug">{shown(view.draft.text)}</p>
          ) : (
            <p className="text-xs italic text-deep-green/60">Claude suggests no reply to this one.</p>
          )}
          {view.draft.action && !ACTION_DONE.has(view.draft.action_status ?? "") && view.draft.text_without_action && (
            <p data-testid="ai-draft-text-without" className="mt-1 text-[12px] text-deep-green/70">
              <span className="font-semibold">Use draft alone: </span>{view.draft.text_without_action}
            </p>
          )}
          {(view.draft.flags.length > 0 || view.draft.staff_notes.length > 0) && (
            <div data-testid="ai-draft-notes" className="mt-1.5 text-[12px] text-deep-green/70">
              <span className="font-semibold">Staff only: </span>
              {view.draft.flags.map((f) => (
                <span key={f} className="mr-1 inline-block rounded-full border border-coral/40 bg-coral-soft px-1.5 text-[11px] font-semibold text-coral-hover">{FLAG_LABEL[f] ?? f}</span>
              ))}
              {/* At most 3 bullets, most important first (src/lib/aiDraftRun.ts). */}
              <ul className="mt-0.5 list-disc pl-4">
                {view.draft.staff_notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}
          {suggestionRow}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {view.draft.text && (
              <button
                type="button"
                data-testid="ai-draft-use"
                disabled={busy}
                onClick={() => {
                  // With an action not pressed, the box gets the version that doesn't claim it.
                  const done = view.draft.action_status === "landed";
                  onUse(view.draft.action && !done ? view.draft.text_without_action ?? "" : view.draft.text, view.draft.id);
                }}
                className="rounded-full bg-deep-green px-3 py-1 text-xs font-bold text-cream hover:bg-deep-green-soft disabled:opacity-40"
              >
                {usedDraftId === view.draft.id ? "In the reply box" : "Use draft"}
              </button>
            )}
            {view.draft.action && !view.draft.action_status && (
              <button
                type="button"
                data-testid="ai-draft-action"
                disabled={busy || !!actionRefusal}
                title={actionRefusal ?? undefined}
                onClick={() => void applyAction(view.draft)}
                className="rounded-full border border-deep-green bg-white px-3 py-1 text-xs font-bold text-deep-green hover:bg-cream-soft disabled:opacity-40"
              >
                {actionLabel(view.draft.action)}
              </button>
            )}
            <button type="button" data-testid="ai-draft-discard" disabled={busy} onClick={() => setDiscarding((v) => !v)} className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold text-deep-green/70 hover:bg-white disabled:opacity-40">
              <X aria-hidden className="h-3.5 w-3.5" /> Discard
            </button>
            <button type="button" data-testid="ai-draft-regenerate" disabled={busy || ACTION_DONE.has(view.draft.action_status ?? "")} title={ACTION_DONE.has(view.draft.action_status ?? "") ? "The action on this draft was pressed, so it can't be replaced." : undefined} onClick={() => void request(true)} className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold text-deep-green/70 hover:bg-white disabled:opacity-40">
              <RefreshCw aria-hidden className="h-3.5 w-3.5" /> Regenerate
            </button>
          </div>
          {actionRefusal && !view.draft.action_status && view.draft.action && (
            <p data-testid="ai-draft-action-refusal" className="mt-1 text-[12px] text-deep-green/65">{actionRefusal}</p>
          )}
          {actionMsg && (
            <p data-testid="ai-draft-action-result" data-ok={actionMsg.ok} className={`mt-1 text-[12px] font-semibold ${actionMsg.ok ? "text-deep-green" : "text-coral-hover"}`}>{actionMsg.text}</p>
          )}
          {discarding && (
            <div data-testid="ai-draft-discard-chips" className="mt-2 flex flex-wrap items-center gap-1.5">
              <input
                type="text"
                value={discardNote}
                onChange={(e) => setDiscardNote(e.target.value)}
                maxLength={300}
                placeholder="Anything to add? (optional)"
                className="w-full rounded-md border border-deep-green/20 bg-white px-2 py-1 text-[12px]"
              />
              {DISCARD_CHIPS.map((chip) => (
                <button key={chip} type="button" disabled={busy} onClick={() => void discard(view.draft.id, chip, discardNote)} className="rounded-full border border-deep-green/25 bg-white px-2.5 py-0.5 text-[11px] font-semibold hover:bg-cream-soft disabled:opacity-40">
                  {chip}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
