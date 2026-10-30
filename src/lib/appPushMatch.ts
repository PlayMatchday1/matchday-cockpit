// MATCH AT RISK PUSH TO THE STAFF APP (Ryan, 2026-10-30): a match below its minimum 60 minutes
// before its auto-cancel time. Once per match, never repeated: claiming the (env, match) row in
// app_push_match_risk IS the decision to send, so two overlapping runs cannot both notify.
// Read live, the same day list the Today screen and the board read.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchDayLive, todayRow } from "./appLive";
import { trimMatch, type Raw } from "./gamedayApiShape";
import type { MatchdayEnv } from "./matchdayStageApi";
import { atRiskNow, finalRecipients, matchRecipients, matchRiskText, sendAppPush, type StaffRow } from "./appPush";

export type RiskMatch = ReturnType<typeof todayRow>;

/* LOG ONLY (Ryan, 2026-10-30): the scheduled run records which matches it WOULD notify, and whom,
 * once per match, in app_push_log (dry_run, no ticket, "log only: not sent"). It sends nothing and
 * claims nothing, so switching this off later still notifies each match once. */
export const MATCH_RISK_LOG_ONLY = true;

/** UTC yesterday, today and tomorrow: every city's "today" near this moment is one of them. */
export function datesAround(nowMs: number): string[] {
  return [-1, 0, 1].map((d) => new Date(nowMs + d * 86_400_000).toISOString().slice(0, 10));
}

export async function staffRows(sb: SupabaseClient): Promise<StaffRow[]> {
  const r = await sb.from("app_users").select("id, email, is_admin, can_access_chats, can_access_matchops, is_city_manager, is_service_account, city_identifier");
  if (r.error) throw new Error(`app_users read failed: ${r.error.message}`);
  return (r.data ?? []) as StaffRow[];
}

export function riskPayload(env: MatchdayEnv, m: RiskMatch) {
  // Clamped at 0 so a dry run on a match that is not short never reads "-1 short".
  return { ...matchRiskText(m.name, m.startDate, Math.max(0, -m.cushion)), data: { kind: "match_at_risk", matchId: m.id, env } };
}

/** The cron's pass over one environment. Returns what it saw and what it sent. */
export async function runMatchRisk(sb: SupabaseClient, env: MatchdayEnv, nowMs = Date.now()) {
  const seen = new Map<number, RiskMatch>();
  for (const date of datesAround(nowMs)) {
    for (const raw of await fetchDayLive(env, date)) {
      const m = todayRow(trimMatch(raw), raw as Raw, null, nowMs);
      seen.set(m.id, m);
    }
  }
  const risky = [...seen.values()].filter((m) => atRiskNow(m, nowMs));
  // The kill switch is read BEFORE any claim: a match passed over while it is off is not marked as
  // notified, and an admin's off means off for every match in that window.
  const sw = await sb.from("app_push_switches").select("enabled").eq("event", "match_at_risk").maybeSingle();
  if (sw.error) throw new Error(`switch read failed: ${sw.error.message}`);
  if (sw.data?.enabled === false) return { env, scanned: seen.size, atRisk: risky.length, sent: [], skipped: "turned off by an admin" };
  const sent: { matchId: number; claimed: boolean; result?: unknown }[] = [];
  if (risky.length === 0) return { env, scanned: seen.size, atRisk: 0, sent };
  const staff = await staffRows(sb);
  if (MATCH_RISK_LOG_ONLY) {
    for (const m of risky) {
      const subject = `${env}:${m.id}`;
      const seenBefore = await sb.from("app_push_log").select("id").eq("event", "match_at_risk").eq("subject", subject).eq("dry_run", true).is("ticket_status", null).limit(1);
      if (seenBefore.error || (seenBefore.data?.length ?? 0) > 0) { sent.push({ matchId: m.id, claimed: false, result: "already logged" }); continue; }
      const recipientIds = finalRecipients(matchRecipients(staff, m.cityName), staff, null, null);
      const p = riskPayload(env, m);
      const rows = (recipientIds.length ? recipientIds : [null]).map((id) => ({ event: "match_at_risk", app_user_id: id, subject, dry_run: true, ticket_status: null, ticket_error: `log only: not sent · ${p.body}`.slice(0, 300) }));
      const ins = await sb.from("app_push_log").insert(rows);
      sent.push({ matchId: m.id, claimed: false, result: ins.error ? `log failed: ${ins.error.message}` : `logged for ${recipientIds.length} recipients` });
    }
    return { env, scanned: seen.size, atRisk: risky.length, logOnly: true, sent };
  }
  for (const m of risky) {
    const claim = await sb.from("app_push_match_risk").insert({ env, match_id: m.id });
    if (claim.error) { sent.push({ matchId: m.id, claimed: false }); continue; } // already notified (or the claim failed): never twice
    // Nobody caused this: it is the clock against the roster.
    const recipientIds = finalRecipients(matchRecipients(staff, m.cityName), staff, null);
    const result = await sendAppPush(sb, { event: "match_at_risk", subject: `${env}:${m.id}`, recipientIds, ...riskPayload(env, m) });
    sent.push({ matchId: m.id, claimed: true, result });
  }
  return { env, scanned: seen.size, atRisk: risky.length, sent };
}
