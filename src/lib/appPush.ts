// STAFF APP PUSH NOTIFICATIONS through the Expo push service (Ryan, 2026-10-30). Two events only:
//
//   player_chat     a player message that makes a Player Chats thread wait on a reply. Recipients:
//                   staff who can read Player Chats, scoped by THE LISTING'S RULE (crmScope): an
//                   unconfined account gets every thread, a confined account only threads assigned
//                   to someone in its city, and an unassigned thread reaches unconfined staff only.
//   match_at_risk   a match below its minimum 60 minutes before its auto-cancel time, once per
//                   match. Recipients: staff with Match Ops in the staff app (appAccess), scoped to
//                   the match's city (cityAllowed).
//
// Rules for both: never the person who caused the event; each staff member's own switch
// (app_push_prefs, no row = on); the admin kill switch per event (app_push_switches); every push
// logged in app_push_log with its Expo ticket, then its receipt; a token Expo reports as
// DeviceNotRegistered is deleted.
//
// The rules are pure and exported, so scripts/app-push-test.ts asserts them offline.

import type { SupabaseClient } from "@supabase/supabase-js";
import { confinedCity } from "./cityConfinement";
import { cityNameFor } from "./cityScope";
import { appAccess, cityAllowed } from "./appModel";
import { isAwaitingReply } from "./awaitingReply";

export type PushEvent = "player_chat" | "match_at_risk";
const PREF_COLUMN: Record<PushEvent, "player_chats" | "matches_at_risk"> = { player_chat: "player_chats", match_at_risk: "matches_at_risk" };

/* WHILE TESTING (Ryan, 2026-10-30: "send only to my own token"), real pushes reach these accounts
 * and nobody else. Set to null to send to everyone the rules allow. */
export const PUSH_TEST_ONLY_EMAILS: readonly string[] | null = ["rmancuso@playmatchday.com"];

export type StaffRow = {
  id: string; email: string;
  is_admin?: boolean | null; can_access_chats?: boolean | null; can_access_matchops?: boolean | null;
  is_city_manager?: boolean | null; is_service_account?: boolean | null; city_identifier?: string | null;
};

const notService = (u: StaffRow) => u.is_service_account !== true;

/** PURE. Player chat: who can read Player Chats AND whose listing scope holds this thread. */
export function chatRecipients(staff: StaffRow[], assigneeId: string | null): string[] {
  const assignee = assigneeId ? staff.find((u) => u.id === assigneeId) ?? null : null;
  return staff.filter(notService).filter((u) => {
    if (!(u.is_admin === true || u.can_access_chats === true)) return false;
    const city = confinedCity(u);
    const raw = typeof u.city_identifier === "string" ? u.city_identifier.trim() : "";
    if (!raw) return true;                       // unconfined: every thread
    if (!city || !assignee) return false;        // confined to an unknown city, or unassigned: never
    return assignee.city_identifier === city;    // the listing: assigned to someone in this city
  }).map((u) => u.id);
}

/** PURE. Match at risk: staff-app Match Ops access, and the match's city in scope. */
export function matchRecipients(staff: StaffRow[], liveCityName: string | null): string[] {
  return staff.filter(notService).filter((u) => {
    const a = appAccess(u, confinedCity(u));
    if (!a.canReadMatches) return false;
    return cityAllowed(a, a.scopeCity ? cityNameFor(a.scopeCity) : null, liveCityName);
  }).map((u) => u.id);
}

/** PURE. Never the person who caused it; then the test-only gate. */
export function finalRecipients(ids: string[], staff: StaffRow[], causedBy: string | null, testOnly: readonly string[] | null = PUSH_TEST_ONLY_EMAILS): string[] {
  const allowed = testOnly ? new Set(staff.filter((u) => testOnly.includes(u.email.toLowerCase())).map((u) => u.id)) : null;
  return [...new Set(ids)].filter((id) => id !== causedBy && (!allowed || allowed.has(id)));
}

/** PURE. "Jordan: Do you know what fields are open on Saturd" (first 80 characters). */
export function chatPushText(firstName: string | null, body: string): { title: string; body: string } {
  const text = body.replace(/\s+/g, " ").trim();
  return { title: "Player chat", body: `${firstName?.trim() || "Player"}: ${text.slice(0, 80)}` };
}

/** PURE. "Bob Jones Park Field 6 · 8:00 PM · 3 short". */
export function matchRiskText(name: string, wallStart: string, short: number): { title: string; body: string } {
  return { title: "Match at risk", body: `${name} · ${wallClockOf(wallStart)} · ${short} short` };
}

/** "8:00 PM" from the API's wall-clock startDate ("2026-10-30T20:00:00.000Z" reads as local 8 PM). */
export function wallClockOf(startDate: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(startDate);
  if (!m) return "";
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

export type RiskRow = { isCancelled: boolean; autoCanceled: boolean; autoCanceledMinutes: number | null; startDateUtc: string; cushion: number; capacity: number | null };

/** PURE. Below its minimum, and inside the hour before its auto-cancel time (not yet past it). */
export function atRiskNow(m: RiskRow, nowMs: number): boolean {
  if (m.isCancelled || !m.autoCanceled || m.capacity == null || !(m.cushion < 0)) return false;
  const start = Date.parse(m.startDateUtc);
  if (!Number.isFinite(start)) return false;
  const cancelAt = start - (m.autoCanceledMinutes ?? 0) * 60_000;
  return nowMs >= cancelAt - 60 * 60_000 && nowMs < cancelAt;
}

/** PURE. Each staff member's waiting Player chats, by the listing's scope rule (the app's red badge). */
export function waitingCounts(staff: StaffRow[], waitingAssignees: (string | null)[], ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, 0);
  for (const assignee of waitingAssignees) for (const id of chatRecipients(staff, assignee)) if (out.has(id)) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

/** The badge for each recipient: their waiting Player chats right now. Null when it cannot be read. */
async function badgesFor(sb: SupabaseClient, ids: string[]): Promise<Map<string, number> | null> {
  const staff = await sb.from("app_users").select("id, email, is_admin, can_access_chats, can_access_matchops, is_city_manager, is_service_account, city_identifier");
  const open = await sb.from("crm_threads").select("assigned_to_user_id, last_message_preview, last_message_at, no_reply_needed_at").eq("status", "open").eq("last_message_direction", "inbound").limit(2000);
  if (staff.error || open.error) return null;
  const waiting = (open.data ?? []).filter((t) => isAwaitingReply({ ...t, status: "open", last_message_direction: "inbound" }));
  return waitingCounts((staff.data ?? []) as StaffRow[], waiting.map((t) => (t.assigned_to_user_id as string | null) ?? null), ids);
}

/* ── SENDING ─────────────────────────────────────────────────────────────────────────────────── */

const EXPO_SEND = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS = "https://exp.host/--/api/v2/push/getReceipts";

type Ticket = { status: "ok"; id: string } | { status: "error"; message?: string; details?: { error?: string } };

let logHasToken: boolean | null = null;
/** Whether app_push_log has the token column (needed to act on a receipt's DeviceNotRegistered). */
async function tokenColumn(sb: SupabaseClient): Promise<boolean> {
  if (logHasToken === null) logHasToken = !(await sb.from("app_push_log").select("token").limit(1)).error;
  return logHasToken;
}

export type SendResult = { event: PushEvent; skipped?: string; recipients: number; tokens: number; ok: number; errors: number; removed: number };

/**
 * Sends one notification to the given staff. Filters by the kill switch (unless a dry run), each
 * person's switch, and their tokens; logs every ticket; deletes a token at once when its ticket says
 * DeviceNotRegistered. Never throws: a push must never break the path that triggered it.
 */
export async function sendAppPush(sb: SupabaseClient, args: {
  event: PushEvent; subject: string; recipientIds: string[]; title: string; body: string;
  data: Record<string, unknown>; dryRun?: boolean;
}): Promise<SendResult> {
  const res: SendResult = { event: args.event, recipients: 0, tokens: 0, ok: 0, errors: 0, removed: 0 };
  try {
    if (!args.dryRun) {
      const sw = await sb.from("app_push_switches").select("enabled").eq("event", args.event).maybeSingle();
      if (sw.error) return { ...res, skipped: `switch read failed: ${sw.error.message}` };
      if (sw.data && sw.data.enabled === false) return { ...res, skipped: "turned off by an admin" };
    }
    if (args.recipientIds.length === 0) return { ...res, skipped: "no recipients" };
    const prefs = await sb.from("app_push_prefs").select(`app_user_id, ${PREF_COLUMN[args.event]}`).in("app_user_id", args.recipientIds);
    if (prefs.error) return { ...res, skipped: `prefs read failed: ${prefs.error.message}` };
    const off = new Set((prefs.data ?? []).filter((p) => (p as Record<string, unknown>)[PREF_COLUMN[args.event]] === false).map((p) => String(p.app_user_id)));
    const ids = args.recipientIds.filter((id) => !off.has(id));
    res.recipients = ids.length;
    if (ids.length === 0) return { ...res, skipped: "everyone has this switched off" };
    const toks = await sb.from("app_push_tokens").select("token, app_user_id").in("app_user_id", ids);
    if (toks.error) return { ...res, skipped: `token read failed: ${toks.error.message}` };
    const rows = (toks.data ?? []) as { token: string; app_user_id: string }[];
    res.tokens = rows.length;
    if (rows.length === 0) return { ...res, skipped: "no registered devices" };
    const withToken = await tokenColumn(sb);
    const badges = await badgesFor(sb, ids);

    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      // Shown and heard (Ryan, 2026-10-30): default sound, high priority, interruption level active, and
      // the recipient's own waiting chat count as the badge.
      const messages = batch.map((r) => ({
        to: r.token, title: args.title, body: args.body, data: args.data,
        sound: "default", priority: "high", interruptionLevel: "active",
        ...(badges?.has(r.app_user_id) ? { badge: badges.get(r.app_user_id) } : {}),
      }));
      let tickets: Ticket[] = [];
      try {
        const r = await fetch(EXPO_SEND, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(messages), signal: AbortSignal.timeout(5000) });
        const j = (await r.json().catch(() => ({}))) as { data?: Ticket[]; errors?: { message?: string }[] };
        tickets = Array.isArray(j.data) ? j.data : batch.map(() => ({ status: "error", message: j.errors?.[0]?.message ?? `HTTP ${r.status}` }) as Ticket);
      } catch (e) {
        tickets = batch.map(() => ({ status: "error", message: e instanceof Error ? e.message : String(e) }) as Ticket);
      }
      const logRows = batch.map((r, k) => {
        const t = tickets[k] ?? ({ status: "error", message: "no ticket" } as Ticket);
        const dead = t.status === "error" && t.details?.error === "DeviceNotRegistered";
        if (t.status === "ok") res.ok++; else res.errors++;
        return {
          event: args.event, app_user_id: r.app_user_id, subject: args.subject, dry_run: !!args.dryRun,
          ticket_id: t.status === "ok" ? t.id : null, ticket_status: t.status,
          ticket_error: t.status === "error" ? [t.details?.error, t.message].filter(Boolean).join(": ").slice(0, 300) : null,
          token_removed: dead, ...(withToken ? { token: r.token } : {}),
          _dead: dead ? r.token : null,
        };
      });
      for (const l of logRows) if (l._dead) { await sb.from("app_push_tokens").delete().eq("token", l._dead); res.removed++; }
      const ins = await sb.from("app_push_log").insert(logRows.map(({ _dead, ...rest }) => { void _dead; return rest; }));
      if (ins.error) console.error(`[app-push] log insert failed: ${ins.error.message}`);
    }
    console.log(`[app-push] ${args.event} subject=${args.subject}${args.dryRun ? " DRY RUN" : ""} recipients=${res.recipients} tokens=${res.tokens} ok=${res.ok} errors=${res.errors} removed=${res.removed}`);
  } catch (e) {
    console.error(`[app-push] ${args.event} failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ...res, skipped: "failed" };
  }
  return res;
}

/** Reads Expo receipts for tickets older than a minute and not yet checked; acts on DeviceNotRegistered. */
export async function sweepReceipts(sb: SupabaseClient): Promise<{ checked: number; ok: number; errors: number; removed: number; pending: number }> {
  const out = { checked: 0, ok: 0, errors: 0, removed: 0, pending: 0 };
  const withToken = await tokenColumn(sb);
  const q = await sb.from("app_push_log").select(withToken ? "id, ticket_id, created_at, token" : "id, ticket_id, created_at")
    .eq("ticket_status", "ok").is("receipt_checked_at", null).lt("created_at", new Date(Date.now() - 60_000).toISOString()).limit(1000);
  if (q.error || !q.data?.length) return out;
  const rows = q.data as unknown as { id: number; ticket_id: string; created_at: string; token?: string }[];
  const r = await fetch(EXPO_RECEIPTS, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ ids: rows.map((x) => x.ticket_id) }), signal: AbortSignal.timeout(8000) });
  const j = (await r.json().catch(() => ({}))) as { data?: Record<string, { status: "ok" | "error"; message?: string; details?: { error?: string } }> };
  const now = new Date().toISOString();
  for (const row of rows) {
    const rc = j.data?.[row.ticket_id];
    // No receipt after a day means Expo will never have one; record that rather than ask forever.
    if (!rc) {
      if (Date.now() - Date.parse(row.created_at) > 24 * 3_600_000) await sb.from("app_push_log").update({ receipt_checked_at: now, receipt_status: "error", receipt_error: "no receipt from Expo within 24 hours" }).eq("id", row.id);
      else out.pending++;
      continue;
    }
    out.checked++;
    const dead = rc.status === "error" && rc.details?.error === "DeviceNotRegistered";
    if (rc.status === "ok") out.ok++; else out.errors++;
    if (dead && row.token) { await sb.from("app_push_tokens").delete().eq("token", row.token); out.removed++; }
    await sb.from("app_push_log").update({
      receipt_checked_at: now, receipt_status: rc.status,
      receipt_error: rc.status === "error" ? [rc.details?.error, rc.message].filter(Boolean).join(": ").slice(0, 300) : null,
      ...(dead && row.token ? { token_removed: true } : {}),
    }).eq("id", row.id);
  }
  return out;
}
