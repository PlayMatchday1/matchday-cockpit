"use client";

// MARK A PUSH SENT. ONE CONTROL, BOTH SURFACES.
//
// Ryan: "we need a way to mark these things complete it should be really simple so you can show
// them done and not overdue but they still show so everyone has visibility."
//
// ══ IT IS ADDRESSED TO A PUSH, NOT A MATCH ═══════════════════════════════════════════════════
// Migration 0176 moved the stamp onto the push row, so a match with three pushes has three
// independent sent states and marking the WhatsApp one leaves the Klaviyo one overdue. Before
// that, one stamp per match was the only shape the table allowed.
//
// ══ WHY THERE IS NO CONFIRM ══════════════════════════════════════════════════════════════════
// It is reversible, it moves no money, and it is the thing somebody does twelve times in a row on
// a phone. A mis-tap costs one tap. A dialog on each of twelve is the reason nobody marks anything.
//
// ══ IT GOES THROUGH THE PLAN'S OWN ROUTE ═════════════════════════════════════════════════════
// The same POST, the same capability check and the same fin_change_log audit as every other plan
// edit. A second write path for one boolean is a second place for the audit to be forgotten.

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { canMarkSent, isPushSent, type PromoPush } from "@/lib/matchPromotion";

export default function MarkPushSent({
  push,
  onDone,
  onError,
}: {
  push: PromoPush;
  onDone: () => void | Promise<void>;
  onError?: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const sent = isPushSent(push);

  /* ── A PUSH WITH NO DATE GETS NO CONTROL AT ALL ───────────────────────────────────────────
   * DISABLED WAS THE OTHER OPTION AND IT IS WORSE HERE. Migration 0128 is explicit that a NULL
   * push_at means "needs a decision" — the push is not late, it is unscheduled — and a greyed
   * "Mark sent" invites the reading that it is something you could do once you worked out how.
   * There is nothing to have sent. The route refuses it too, because a UI check is not a rule. */
  if (!canMarkSent(push)) return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch("/api/match-promotion", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          pushId: push.id,
          /* TAPPING AGAIN UN-MARKS IT. */
          pushed: !sent,
        }),
      });
      const json = (await res.json()) as { outcome?: string; error?: string };
      if (json.outcome === "LANDED") await onDone();
      else onError?.(`${json.outcome ?? "FAILED"} — ${json.error ?? "nothing was written."}`);
    } catch {
      onError?.("Network error — nothing was written.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="mark-sent"
      data-push-id={push.id}
      data-sent={sent ? "1" : "0"}
      disabled={busy}
      aria-pressed={sent}
      onClick={(e) => { e.stopPropagation(); void toggle(); }}
      title={sent ? "Tap again to un-mark it" : "Mark this push as sent"}
      className={`ml-auto flex-none rounded-[8px] border px-2.5 text-[11.5px] font-extrabold disabled:opacity-50 ${
        sent
          ? "border-mint/50 bg-mint-soft/50 text-emerald-700"
          : "border-cream-line bg-white text-deep-green/70"}`}
      style={{ minHeight: 32 }}
    >
      {busy ? "…" : sent ? "Sent" : "Mark sent"}
    </button>
  );
}
