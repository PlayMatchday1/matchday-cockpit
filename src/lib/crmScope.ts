// THE CITY BOUNDARY FOR PLAYER CHATS, in one place. crm_threads carries no city and no match link,
// so a thread belongs to a city through its ASSIGNEE (see the long note in
// /api/crm/threads/route.ts). The listing used to work this out inline and every other thread route
// did not work it out at all: a confined account that knew a thread id could read it, send to it,
// resolve it and mark it read. Ryan, 2026-10-30: every route that names a thread refuses one
// outside the caller's scope by the listing's own rule, and every count counts only that scope.
//
// Unconfined callers get null / ok with no query, so desktop behaviour for them is unchanged.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONFINED_CITY_ERROR } from "./cityConfinement";

type Scoped = { confinedCity: string | null; supabase: SupabaseClient };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No assignee in the city => nothing can belong to it. A sentinel keeps the filter ON. */
export const NO_ASSIGNEE = "00000000-0000-0000-0000-000000000000";

/**
 * The app_users ids whose threads a confined caller may see, or null when unconfined. Unassigned
 * threads belong to nobody: the list never contains null, so .in() excludes them.
 */
export async function crmScopedAssignees(auth: Scoped): Promise<{ ok: true; ids: string[] | null } | { ok: false; status: number; error: string }> {
  if (!auth.confinedCity) return { ok: true, ids: null };
  const ur = await auth.supabase.from("app_users").select("id, city_identifier");
  if (ur.error) return { ok: false, status: 500, error: "Could not resolve city scope" };
  const ids = (ur.data ?? []).filter((u) => u.city_identifier === auth.confinedCity).map((u) => String(u.id));
  return { ok: true, ids: ids.length > 0 ? ids : [NO_ASSIGNEE] };
}

/**
 * May this caller act on this thread? Deny by default for a confined caller: a thread that cannot be
 * read, does not exist, is unassigned, or is assigned outside the city is refused. The refusal is
 * the same 403 whether or not the thread exists, so an id cannot be probed.
 */
export async function assertThreadInScope(auth: Scoped, threadId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!auth.confinedCity) return { ok: true };
  if (!UUID_RX.test(threadId)) return { ok: false, status: 403, error: CONFINED_CITY_ERROR };
  const scope = await crmScopedAssignees(auth);
  if (!scope.ok) return scope;
  const t = await auth.supabase.from("crm_threads").select("assigned_to_user_id").eq("id", threadId).maybeSingle();
  if (t.error) return { ok: false, status: 500, error: "Could not verify the thread's city" };
  const who = t.data?.assigned_to_user_id ? String(t.data.assigned_to_user_id) : null;
  if (!who || !scope.ids!.includes(who)) return { ok: false, status: 403, error: CONFINED_CITY_ERROR };
  return { ok: true };
}
