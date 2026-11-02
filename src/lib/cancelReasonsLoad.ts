import "server-only"; // no-op under --conditions=react-server
// The two reads behind cancelReasonFor: the stored reasons, and which matches the Clubhouse cancelled.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StaffReason } from "./cancelReasons";

const CHUNK = 200;

/* `storedUnavailable`: match_cancel_reasons could not be read (measured 2026-11-01: PGRST205, the
 * table did not exist yet). Every cancel then reads by inference alone. */
export async function loadCancelFacts(sb: SupabaseClient, env: string, matchIds: number[]): Promise<{ stored: Map<number, { reason: StaffReason; note: string | null }>; logged: Set<number>; storedUnavailable: boolean }> {
  const stored = new Map<number, { reason: StaffReason; note: string | null }>();
  const logged = new Set<number>();
  let storedUnavailable = false;
  for (let i = 0; i < matchIds.length; i += CHUNK) {
    const part = matchIds.slice(i, i + CHUNK);
    const s = storedUnavailable ? null : await sb.from("match_cancel_reasons").select("match_id, reason, note").eq("env", env).in("match_id", part);
    if (s?.error) {
      /* QUIETLY, FOR STAFF (Ryan, 2026-11-01): a failed read is logged here and every cancel falls back
       * to the inferred reason; no error text reaches the app. */
      storedUnavailable = true;
      console.error(`[cancel-reasons] match_cancel_reasons unreadable, falling back to inferred reasons: ${s.error.code ?? ""} ${s.error.message}`);
    }
    for (const r of s?.error ? [] : s?.data ?? []) stored.set(Number(r.match_id), { reason: r.reason as StaffReason, note: (r.note as string | null) ?? null });
    const l = await sb.from("change_log").select("match_id").eq("env", env).eq("method", "PATCH").like("endpoint", "/admin/matches/%/cancel").in("match_id", part);
    if (l.error) throw new Error(`change_log: ${l.error.message}`);
    for (const r of l.data ?? []) logged.add(Number(r.match_id));
  }
  return { stored, logged, storedUnavailable };
}
