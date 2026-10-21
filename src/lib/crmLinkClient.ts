"use client";

// LINKING A THREAD FROM THE BROWSER. One function, used by both places a person can link: the draft
// card's "Matches Sam, link?" and the context pane's "Link to account" / "Change account". After a
// link lands, an event tells the other one to refresh, so the pane shows the new account and the
// card drafts again from it.

import { supabase } from "@/lib/supabase";

export const THREAD_LINKED_EVENT = "crm:thread-linked";

export type LinkResponse =
  | { ok: true; outcome: string; action: "link" | "change" | "confirm"; first_name: string | null; to_player_id: number }
  | { ok: false; error: string };

export async function linkThreadToPlayer(threadId: string, playerId: number): Promise<LinkResponse> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { ok: false, error: "Sign in again." };
  const res = await fetch(`/api/crm/threads/${threadId}/link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ player_id: playerId }),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { ok: false, error: typeof j.error === "string" ? j.error : `HTTP ${res.status}` };
  window.dispatchEvent(new CustomEvent(THREAD_LINKED_EVENT, { detail: { threadId, playerId } }));
  return { ok: true, outcome: String(j.outcome ?? ""), action: j.action as "link" | "change" | "confirm", first_name: (j.first_name as string | null) ?? null, to_player_id: playerId };
}
