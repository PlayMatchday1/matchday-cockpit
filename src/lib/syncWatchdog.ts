// THE SYNC WATCHDOG (Ryan, 2026-11-02), hourly from vercel.json through /api/sync/watchdog.
//
//   CUT OFF   a scheduled (cron) fin_sync_log row started over 30 minutes ago (every route's limit
//             is 300s) with no completion and no message is a step the platform killed mid-run: it gets "Cut off: ..." in error_message. Its
//             completed_at stays empty, so no duration is invented.
//   STALE     a watched source whose last clean completion (completed, no error, an ADVISORY note
//             counts as clean) is over 2 days old, or which has none in its last 200 rows.
//   ALERT     one push a day to Ryan's devices (event sync_stale, migration 0247) naming every stale
//             source, through the app's push (sendAppPush: logged, kill switch). Until 0247 is
//             applied the watchdog reports the stale sources and sends nothing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendAppPush } from "./appPush";
import { syncLogWritable, type SourceName } from "./syncLogging";

/** Every scheduled source. Not watched: stripe-txn-backfill (a one-off walk) and
 *  mdapi-users-lens-snapshot (its nightly rebuild was removed on purpose). */
export const WATCHED_SOURCES: SourceName[] = [
  "stripe-api", "google-calendar", "mdapi-users", "telnyx-sms",
  "mdapi-subscriptions", "membership-snapshots", "membership-prices", "mdapi-promocodes",
  "mdapi-matches", "mdapi-reviews", "firstmatch-ledger", "manager-pay-recompute",
  "play-installs", "app-store-installs", "mdapi-users-full", "meta-ad-spend", "wp-submissions",
  "stripe-txn", "stripe-customers", "stripe-member-invoices", "gsc-pages", "ga4-web", "ga4-app", "asc-analytics",
];
export const STALE_MS = 2 * 24 * 3_600_000;
export const CUT_OFF_AFTER_MS = 30 * 60_000;
export const ALERT_EMAIL = "rmancuso@playmatchday.com";

type LogRow = { completed_at: string | null; error_message: string | null };
export const isClean = (r: LogRow) => !!r.completed_at && (!r.error_message || r.error_message.startsWith("ADVISORY"));

/** Pure: is the source stale at nowMs, and when did it last complete cleanly. */
export function staleOf(rows: LogRow[], nowMs: number): { stale: boolean; lastClean: string | null } {
  const c = rows.find(isClean);
  return { stale: !c || nowMs - Date.parse(c.completed_at!) > STALE_MS, lastClean: c?.completed_at ?? null };
}

/** Pure: the push's words. */
export function alertText(stale: { source: string; lastClean: string | null }[]): { title: string; body: string } {
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" }) : "never");
  return {
    title: stale.length === 1 ? "A sync has stopped" : `${stale.length} syncs have stopped`,
    body: stale.map((s) => `${s.source} last completed ${day(s.lastClean)}`).join(", ").slice(0, 200),
  };
}

export async function runSyncWatchdog(sb: SupabaseClient, now = new Date()) {
  const nowMs = now.getTime();

  // CUT OFF
  const cutBefore = new Date(nowMs - CUT_OFF_AFTER_MS).toISOString();
  const open = await sb.from("fin_sync_log").select("id, source, started_at").is("completed_at", null).is("error_message", null)
    .eq("triggered_by", "cron").lt("started_at", cutBefore).limit(500);
  if (open.error) throw new Error(`fin_sync_log read: ${open.error.message}`);
  let markedCutOff = 0;
  for (const r of syncLogWritable() ? open.data ?? [] : []) {
    const at = String(r.started_at).slice(0, 16).replace("T", " ");
    const u = await sb.from("fin_sync_log").update({ error_message: `Cut off: started ${at} UTC and never completed (the function ended mid-step)` })
      .eq("id", r.id).is("completed_at", null).is("error_message", null);
    if (!u.error) markedCutOff++;
  }

  // STALE
  const stale: { source: SourceName; lastClean: string | null }[] = [];
  for (const source of WATCHED_SOURCES) {
    const q = await sb.from("fin_sync_log").select("completed_at, error_message").eq("source", source)
      .order("started_at", { ascending: false }).limit(200);
    if (q.error) throw new Error(`fin_sync_log read (${source}): ${q.error.message}`);
    const s = staleOf((q.data ?? []) as LogRow[], nowMs);
    if (s.stale) stale.push({ source, lastClean: s.lastClean });
  }

  // ALERT, once a day
  let alert: Record<string, unknown> = { sent: false };
  if (stale.length) {
    const ready = await sb.from("app_push_switches").select("event").eq("event", "sync_stale").maybeSingle();
    if (ready.error || !ready.data) {
      alert = { sent: false, why: "waiting on migration 0247 (sync_stale push event)" };
    } else {
      const subject = `sync-stale:${now.toISOString().slice(0, 10)}`;
      const seen = await sb.from("app_push_log").select("id").eq("event", "sync_stale").eq("subject", subject).limit(1);
      const me = await sb.from("app_users").select("id").eq("email", ALERT_EMAIL).maybeSingle();
      if (seen.error || me.error || !me.data) alert = { sent: false, why: `read failed: ${seen.error?.message ?? me.error?.message ?? "no app user for the alert email"}` };
      else if (seen.data?.length) alert = { sent: false, why: "already sent today" };
      else {
        const text = alertText(stale);
        const r = await sendAppPush(sb, { event: "sync_stale", subject, recipientIds: [String(me.data.id)], ...text,
          data: { kind: "sync_stale" }, reason: `Stale syncs: ${stale.map((s) => s.source).join(", ")}` });
        alert = { sent: !r.skipped && r.ok > 0, result: r };
      }
    }
  }
  return { markedCutOff, stale, alert };
}
