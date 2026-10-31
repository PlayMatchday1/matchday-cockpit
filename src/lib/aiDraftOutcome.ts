// WHAT HAPPENED TO A DRAFT — sent unchanged, sent edited, or discarded. This record is how we will
// know when auto-send is safe, so it is written by the server from the text that actually went
// out, never from a claim the browser makes.
//
// The decision is pure (draftOutcomePatch / discardPatch); the two writers below are thin. Both
// update ONLY a row that is still `pending` and belongs to the same thread, so a stale or forged
// draft_id cannot rewrite another thread's record or overwrite an outcome already recorded.

import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyDraftOutcome } from "@/lib/aiDraftModel";

export type PendingDraft = { id: string; thread_id: string; outcome: string; draft_text: string | null; reply_without_action?: string | null };

export function draftOutcomePatch(
  draft: PendingDraft | null,
  args: { threadId: string; sentBody: string; messageId: string; userId: string | null; nowIso: string },
) {
  if (!draft || draft.thread_id !== args.threadId || draft.outcome !== "pending" || draft.draft_text == null) return null;
  // Staff had two versions when an action was proposed. It counts against whichever is closer.
  const versions = [draft.draft_text, draft.reply_without_action].filter((t): t is string => !!t);
  const { outcome, edit_distance } = versions
    .map((t) => classifyDraftOutcome(t, args.sentBody))
    .reduce((best, c) => (c.edit_distance < best.edit_distance ? c : best));
  return { outcome, edit_distance, sent_message_id: args.messageId, outcome_at: args.nowIso, outcome_by_user_id: args.userId };
}

export function discardPatch(draft: PendingDraft | null, args: { threadId: string; userId: string | null; nowIso: string; reason?: string | null }) {
  if (!draft || draft.thread_id !== args.threadId || draft.outcome !== "pending") return null;
  return { outcome: "discarded" as const, outcome_at: args.nowIso, outcome_by_user_id: args.userId, discard_reason: args.reason ?? null };
}

async function loadDraft(sb: SupabaseClient, draftId: string): Promise<PendingDraft | null> {
  const r = await sb.from("crm_ai_drafts").select("id, thread_id, outcome, draft_text, reply_without_action").eq("id", draftId).maybeSingle();
  if (r.error) throw new Error(r.error.message);
  return (r.data as PendingDraft | null) ?? null;
}

// Called by /api/crm/send AFTER a successful send. Best-effort: a failure here is logged and never
// turns a delivered message into an error the operator would resend.
export async function recordDraftSent(
  sb: SupabaseClient,
  args: { draftId: string; threadId: string; sentBody: string; messageId: string; userId: string | null },
): Promise<void> {
  try {
    const patch = draftOutcomePatch(await loadDraft(sb, args.draftId), { ...args, nowIso: new Date().toISOString() });
    if (!patch) return;
    const u = await sb.from("crm_ai_drafts").update(patch).eq("id", args.draftId).eq("outcome", "pending");
    if (u.error) console.error("[ai-draft] outcome update failed", u.error.message);
  } catch (e) {
    console.error("[ai-draft] outcome record failed (message already sent)", e instanceof Error ? e.message : e);
  }
}

export async function recordDraftDiscarded(
  sb: SupabaseClient,
  args: { draftId: string; threadId: string; userId: string | null; reason?: string | null },
): Promise<boolean> {
  const patch = discardPatch(await loadDraft(sb, args.draftId), { ...args, nowIso: new Date().toISOString() });
  if (!patch) return false;
  const u = await sb.from("crm_ai_drafts").update(patch).eq("id", args.draftId).eq("outcome", "pending").select("id");
  if (u.error) throw new Error(u.error.message);
  return (u.data ?? []).length === 1;
}
