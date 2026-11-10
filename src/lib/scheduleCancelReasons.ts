import "server-only"; // no-op under --conditions=react-server
// WHY EACH CANCELLED MATCH ON THE MASTER SCHEDULE WAS CANCELLED (Ryan, 2026-11-10). The same rule Health
// uses (cancelReasons.cancelReasonFor, with the stored reason first), fed from the production mirror:
// updated_at as the cancel time, auto_canceled and auto_canceled_minutes, and the real count the tile shows
// (monthGrid.realCount). Measured on Oct 1 to Nov 10 2026: of 305 cancels, 174 read as MatchDay's
// auto-cancel and 1 as a stored "Not enough players"; about 30 have no saved reason and read faded.

import type { SupabaseClient } from "@supabase/supabase-js";
import { cancelReasonFor, type CancelShown } from "./cancelReasons";
import { loadCancelFacts } from "./cancelReasonsLoad";
import { realCount } from "./monthGrid";

const CHUNK = 200;

type Cancelled = { apiId: number; startDateUtc?: string | null; players: number | null; fakePlayers: number | null; minPlayers: number | null };

/** A reason per cancelled match id. Throws on a failed read; the caller shows every tile faded then. */
export async function scheduleCancelReasons(sb: SupabaseClient, cancelled: Cancelled[]): Promise<Map<number, CancelShown>> {
  const out = new Map<number, CancelShown>();
  if (cancelled.length === 0) return out;
  const ids = cancelled.map((m) => m.apiId);
  const extra = new Map<number, { updatedAt: string | null; autoCanceled: boolean; autoCanceledMinutes: number | null }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await sb.from("mdapi_matches").select("api_id, updated_at, auto_canceled, auto_canceled_minutes").in("api_id", ids.slice(i, i + CHUNK));
    if (error) throw new Error(`mdapi_matches: ${error.message}`);
    for (const r of data ?? []) extra.set(Number(r.api_id), { updatedAt: (r.updated_at as string | null) ?? null, autoCanceled: r.auto_canceled === true, autoCanceledMinutes: (r.auto_canceled_minutes as number | null) ?? null });
  }
  const facts = await loadCancelFacts(sb, "production", ids);
  if (facts.storedUnavailable) throw new Error("match_cancel_reasons unreadable");
  for (const m of cancelled) {
    const x = extra.get(m.apiId);
    const st = facts.stored.get(m.apiId) ?? null;
    if (!x || !m.startDateUtc) { out.set(m.apiId, { reason: st?.reason ?? "unknown", stored: !!st, note: st?.note ?? null }); continue; }
    const reason = cancelReasonFor({
      stored: st?.reason ?? null, loggedByClubhouse: facts.logged.has(m.apiId),
      autoCanceled: x.autoCanceled, autoCanceledMinutes: x.autoCanceledMinutes,
      startDateUtc: m.startDateUtc, updatedAt: x.updatedAt,
      realPlayers: realCount(m) ?? 0, minPlayerCount: m.minPlayers,
    });
    out.set(m.apiId, { reason, stored: !!st, note: st?.note ?? null });
  }
  return out;
}
