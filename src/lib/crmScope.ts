// THE CITY BOUNDARY FOR PLAYER CHATS, in one place.
//
// SINCE 2026-11-02 A THREAD CARRIES ITS OWN CITY: crm_threads.city_code (migration 0250), set from the
// linked player's city, a field named in the conversation, the draft's read of the text, or a person
// on the thread header. It replaced the rule that a thread belonged to a city through its ASSIGNEE,
// which left every unassigned thread outside every city.
//
// A confined account sees, counts, opens, drafts on and acts on ONLY threads whose city_code is its
// city. A thread with no city yet is outside every confined scope: unconfined staff see it, confined
// staff don't. Every route that names a thread refuses one outside the caller's scope, and every count
// counts only that scope (Ryan, 2026-10-30, unchanged).
//
// Unconfined callers get null / ok with no query, so desktop behaviour for them is unchanged.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONFINED_CITY_ERROR } from "./cityConfinement";

type Scoped = { confinedCity: string | null; supabase: SupabaseClient };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The city a caller's thread queries filter on, or null when unconfined. */
export const crmScopeCity = (auth: Pick<Scoped, "confinedCity">): string | null => auth.confinedCity ?? null;

/** Narrow a crm_threads query to the caller's city. Unconfined: unchanged. */
export function scopeThreads<Q extends { eq: (col: string, val: string) => Q }>(q: Q, city: string | null): Q {
  return city ? q.eq("city_code", city) : q;
}

/** The pure decision, so the gate suite can assert it without a database. */
export function threadInScope(confinedCity: string | null, threadCity: string | null | undefined): boolean {
  if (!confinedCity) return true;
  return typeof threadCity === "string" && threadCity === confinedCity;
}

/**
 * May this caller act on this thread? Deny by default for a confined caller: a thread that cannot be
 * read, does not exist, has no city yet, or is in another city is refused. The refusal is the same
 * 403 whether or not the thread exists, so an id cannot be probed.
 */
export async function assertThreadInScope(auth: Scoped, threadId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!auth.confinedCity) return { ok: true };
  if (!UUID_RX.test(threadId)) return { ok: false, status: 403, error: CONFINED_CITY_ERROR };
  const t = await auth.supabase.from("crm_threads").select("city_code").eq("id", threadId).maybeSingle();
  if (t.error) return { ok: false, status: 500, error: "Could not verify the thread's city" };
  if (!threadInScope(auth.confinedCity, (t.data?.city_code as string | null | undefined) ?? null)) return { ok: false, status: 403, error: CONFINED_CITY_ERROR };
  return { ok: true };
}
