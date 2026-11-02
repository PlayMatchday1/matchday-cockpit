"use client";

// PLAYER CHATS > AUTO-SEND REVIEW. Every shadow decision from the last 7 days beside what staff really
// sent, with Agree / Disagree. This is the evidence for turning categories on. Nothing here sends.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { DISCARD_CHIPS } from "@/lib/aiDraftModel";
import { fmtUsd } from "@/lib/creditsModel";
import { bearerHeaders } from "@/lib/crmConversation";

type Row = {
  id: string; thread_id: string; created_at: string; category: string | null; player_message: string; draft: string | null;
  action: { kind: string; amount_cents: number | null } | null; error: string | null;
  decision: string; reason: string | null; staff_sent: string | null; review_verdict: string | null; review_reason: string | null;
};

const DECISION_LABEL = (r: Row) =>
  r.decision === "human" ? "Goes to a person"
  : r.action?.kind === "credit" ? `Would credit ${fmtUsd(r.action.amount_cents ?? 0)} and send`
  : r.action ? "Would issue a guest code and send"
  : "Would auto-send";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function AutoSendReview() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disagreeing, setDisagreeing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [only, setOnly] = useState<"all" | "auto">("all");

  const load = useCallback(async () => {
    const headers = await bearerHeaders();
    if (!headers) { setError("Sign in again."); return; }
    const res = await fetch("/api/crm/auto-send/review", { headers });
    const j = (await res.json().catch(() => ({}))) as { rows?: Row[]; error?: string };
    if (!res.ok || !j.rows) { setError(j.error ?? `HTTP ${res.status}`); return; }
    setRows(j.rows);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const review = useCallback(async (id: string, verdict: "agree" | "disagree", chip?: string) => {
    const headers = await bearerHeaders();
    if (!headers) { setError("Sign in again."); return; }
    const res = await fetch("/api/crm/auto-send/review", { method: "POST", headers, body: JSON.stringify({ draft_id: id, verdict, chip, note }) });
    if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { error?: string }; setError(j.error ?? `HTTP ${res.status}`); return; }
    setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, review_verdict: verdict, review_reason: chip ? (note.trim() ? `${chip}: ${note.trim()}` : chip) : null } : r)) ?? rs);
    setDisagreeing(null); setNote("");
  }, [note]);

  const shown = (rows ?? []).filter((r) => only === "all" || r.decision !== "human");
  const wouldSend = (rows ?? []).filter((r) => r.decision !== "human").length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 text-deep-green">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[19px] font-bold">Auto-send review</h1>
        <Link href="/match-ops/player-chats" className="text-xs font-semibold underline">Back to Player Chats</Link>
      </div>
      <p className="mb-3 text-[13px] text-deep-green/70">
        Shadow decisions from the last 7 days. Nothing here was sent or written. Until categories are chosen, every category that could be turned on is treated as on, so this shows what each one would do.
      </p>
      {error && <p data-testid="auto-review-error" className="mb-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-[13px] text-coral-hover">{error}</p>}
      {rows && (
        <div className="mb-3 flex items-center gap-2 text-[12px]">
          <span data-testid="auto-review-count">{rows.length} decisions, {wouldSend} would send.</span>
          <button type="button" onClick={() => setOnly(only === "all" ? "auto" : "all")} className="rounded-full border border-deep-green/25 px-2.5 py-0.5 font-semibold hover:bg-cream-soft">
            {only === "all" ? "Only would-send" : "Show all"}
          </button>
        </div>
      )}
      {rows === null && !error && <p className="text-[13px] text-deep-green/60">Loading…</p>}
      {rows && shown.length === 0 && <p data-testid="auto-review-empty" className="text-[13px] text-deep-green/60">No shadow decisions yet.</p>}
      <ul className="flex flex-col gap-3">
        {shown.map((r) => (
          <li key={r.id} data-testid="auto-review-row" className="rounded-lg border border-deep-green/15 bg-white p-3 text-[13px]">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-deep-green/60">
              <span>{when(r.created_at)}</span>
              {r.category && <span className="rounded bg-cream-line/60 px-1.5 font-semibold">{r.category}</span>}
              <span className={`rounded px-1.5 font-bold ${r.decision === "human" ? "bg-cream-line/60 text-deep-green/70" : "bg-mint-soft text-deep-green"}`}>{DECISION_LABEL(r)}</span>
              <Link href={`/match-ops/player-chats?threadId=${encodeURIComponent(r.thread_id)}`} className="underline">Open thread</Link>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <div><div className="text-[11px] font-semibold text-deep-green/55">Player</div><p className="whitespace-pre-wrap">{r.player_message || "(no text)"}</p></div>
              <div><div className="text-[11px] font-semibold text-deep-green/55">Draft</div><p className="whitespace-pre-wrap">{r.draft ?? r.error ?? "(no draft)"}</p></div>
              <div><div className="text-[11px] font-semibold text-deep-green/55">Staff sent</div><p className="whitespace-pre-wrap">{r.staff_sent ?? "(nothing yet)"}</p></div>
            </div>
            {r.reason && <p className="mt-2 text-[12px] text-deep-green/70"><span className="font-semibold">Why: </span>{r.reason}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {r.review_verdict ? (
                <span data-testid="auto-review-verdict" className="text-[12px] font-semibold">{r.review_verdict === "agree" ? "Agreed" : `Disagreed: ${r.review_reason ?? ""}`}</span>
              ) : (
                <>
                  <button type="button" data-testid="auto-review-agree" onClick={() => void review(r.id, "agree")} className="rounded-full bg-deep-green px-3 py-1 text-xs font-bold text-cream hover:bg-deep-green-soft">Agree</button>
                  <button type="button" data-testid="auto-review-disagree" onClick={() => { setDisagreeing(disagreeing === r.id ? null : r.id); setNote(""); }} className="rounded-full border border-deep-green/25 px-3 py-1 text-xs font-bold hover:bg-cream-soft">Disagree</button>
                </>
              )}
            </div>
            {disagreeing === r.id && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Anything to add? (optional)" className="w-full rounded-md border border-deep-green/20 px-2 py-1 text-[12px]" />
                {DISCARD_CHIPS.map((chip) => (
                  <button key={chip} type="button" onClick={() => void review(r.id, "disagree", chip)} className="rounded-full border border-deep-green/25 px-2.5 py-0.5 text-[11px] font-semibold hover:bg-cream-soft">{chip}</button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
