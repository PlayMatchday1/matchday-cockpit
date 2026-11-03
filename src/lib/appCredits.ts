// STAFF APP CREDITS (Ryan, 2026-11-02). The Player Lookup profile's credit history and the source the
// app's Add credits is logged under. The write itself is the desktop credits route, unchanged.
//
//   ADDED / REMOVED   change_log rows for PUT /admin/players/{id}/profile that set creditAmount, in
//                     this environment and landed: the change, the reason, and the staff member's
//                     first name (never an email).
//   USED              the profile's own bookings that took credit at checkout (creditAmount), drawn
//                     by the app from the match history; this file adds nothing for them.
//
// Read only after the desktop profile route has answered for the same player, so its Match Ops gate
// and city boundary decide who may see a player's credit history.

import type { SupabaseClient } from "@supabase/supabase-js";

export const APP_CREDITS_SOURCE = "Staff app · Player Lookup credits";

export type CreditLogRow = { at: string; deltaCents: number; reason: string | null; by: string | null };
type Change = { key?: string; before?: unknown; after?: unknown };

/** Pure: one change_log row to a history row, or null when it did not set the balance. */
export function creditLogRow(r: { created_at: string; changes: unknown; actor_email: string | null }, firstNameOf: (email: string | null) => string | null): CreditLogRow | null {
  const cs = (Array.isArray(r.changes) ? r.changes : []) as Change[];
  const bal = cs.find((c) => c.key === "creditAmount");
  if (!bal) return null;
  const before = Number(bal.before), after = Number(bal.after);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return null;
  const reason = cs.find((c) => c.key === "reason")?.after;
  return { at: r.created_at, deltaCents: after - before, reason: typeof reason === "string" && reason.trim() ? reason.trim() : null, by: firstNameOf(r.actor_email) };
}

export async function creditLog(sb: SupabaseClient, env: string, playerId: number): Promise<CreditLogRow[]> {
  const { data, error } = await sb.from("change_log").select("created_at, changes, actor_email, outcome")
    .eq("env", env).eq("endpoint", `/admin/players/${playerId}/profile`).ilike("outcome", "landed")
    .order("created_at", { ascending: false }).limit(50);
  if (error || !data) return [];
  const emails = [...new Set(data.map((r) => String(r.actor_email ?? "").toLowerCase()).filter(Boolean))];
  const names = new Map<string, string>();
  if (emails.length) {
    const u = await sb.from("app_users").select("email, full_name").in("email", emails);
    for (const x of u.data ?? []) {
      const first = String(x.full_name ?? "").trim().split(/\s+/)[0];
      if (first) names.set(String(x.email).toLowerCase(), first);
    }
  }
  return data.map((r) => creditLogRow(r, (e) => (e ? names.get(e.toLowerCase()) ?? null : null))).filter((x): x is CreditLogRow => x != null);
}
