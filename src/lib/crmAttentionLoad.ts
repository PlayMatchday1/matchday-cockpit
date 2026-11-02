import "server-only"; // no-op under --conditions=react-server
// THE DATA BEHIND attentionFor: each thread's latest inbound and the draft made for that exact message.

import type { SupabaseClient } from "@supabase/supabase-js";
import { attentionFor, isStrikeHolding, type Attention, type AttentionDraft } from "@/lib/crmAttention";

const STRIKE_WINDOW_MS = 14 * 86400e3;
const CHUNK = 100;
const chunks = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

export type LoadedAttention = Attention & { inbound_id: string | null; entered_at: string };

// Throws on a read error, so a caller can't mistake "couldn't read" for "No draft yet".
export async function loadAttention(sb: SupabaseClient, threads: readonly { id: string; awaiting: boolean; last_message_at: string }[]): Promise<Map<string, LoadedAttention>> {
  const out = new Map<string, LoadedAttention>();
  if (threads.length === 0) return out;
  const latestInbound = new Map<string, { id: string; sent_at: string }>();
  const drafts = new Map<string, AttentionDraft>();
  const ids = threads.map((t) => t.id);
  for (const part of chunks(ids)) {
    const m = await sb.from("crm_messages").select("id, thread_id, sent_at, media_kind").eq("direction", "inbound").in("thread_id", part).order("sent_at", { ascending: true });
    if (m.error) throw new Error(m.error.message);
    for (const r of m.data ?? []) if (r.media_kind !== "reaction") latestInbound.set(r.thread_id as string, { id: r.id as string, sent_at: r.sent_at as string });
    const d = await sb.from("crm_ai_drafts")
      .select("id, thread_id, based_on_message_id, created_at, outcome, error, decision, decision_reason, decision_shadow, hold_status, hold_note, hold_until, action_status, staff_notes, action")
      .in("thread_id", part).neq("outcome", "superseded").order("created_at", { ascending: true });
    if (d.error) throw new Error(d.error.message);
    for (const r of (d.data ?? []) as AttentionDraft[]) if (latestInbound.get(r.thread_id)?.id === r.based_on_message_id) drafts.set(r.thread_id, r);
  }
  const held = [...drafts.values()].filter(isStrikeHolding);
  const replied = new Set<string>();
  for (const part of chunks(held.map((d) => d.thread_id))) {
    const r = await sb.from("crm_messages").select("thread_id, sent_at").eq("direction", "outbound").not("sent_by_user_id", "is", null).in("thread_id", part);
    if (r.error) throw new Error(r.error.message);
    for (const d of held) if ((r.data ?? []).some((m) => m.thread_id === d.thread_id && (m.sent_at as string) > d.created_at)) replied.add(d.thread_id);
  }
  for (const t of threads) {
    const a = attentionFor({ awaiting: t.awaiting, draft: drafts.get(t.id) ?? null, humanRepliedSinceDraft: replied.has(t.id) });
    const inbound = latestInbound.get(t.id) ?? null;
    if (a) out.set(t.id, { ...a, inbound_id: inbound?.id ?? null, entered_at: inbound?.sent_at ?? t.last_message_at });
  }
  return out;
}

// Open threads that answered with a strike holding reply: outbound-last, so no inbound-last scan finds them.
export async function strikeHoldingThreadIds(sb: SupabaseClient, now: number): Promise<string[]> {
  const r = await sb.from("crm_ai_drafts").select("thread_id").eq("hold_status", "sent").like("staff_notes", "[flags:%strike_dispute%")
    .gte("created_at", new Date(now - STRIKE_WINDOW_MS).toISOString());
  if (r.error) throw new Error(r.error.message);
  return [...new Set((r.data ?? []).map((x) => x.thread_id as string))];
}
