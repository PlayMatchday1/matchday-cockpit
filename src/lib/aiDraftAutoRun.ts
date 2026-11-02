import "server-only"; // no-op under --conditions=react-server
// THE AUTO-SEND TICK, every minute (/api/crm/auto-send/tick, cron only). In order:
//
//   1. If auto-send isn't live, cancel any hold still waiting.
//   2. A send that never finished stops blocking its thread and goes to a person.
//   3. Holds that have ended: stop, or apply the action and send (src/lib/aiDraftAuto.ts).
//   4. The kill switch.
//   5. Draft threads whose latest inbound is 90 seconds to 15 minutes old with no draft yet, so a burst
//      of texts gets one reply. The 15 minutes bounds the scan: a greeting stores no row, so it would
//      otherwise be looked at every minute forever. Anything missed falls back to the card.
//
// Shadow, the shipped state, runs 4 and 5 with the decision stored and nothing sent or written.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runDraft, type StoredAction } from "@/lib/aiDraftRun";
import { draftDataDeps } from "@/lib/aiDraftDeps";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import {
  badAutoSendReplies, decideAutoSend, decisionConfig, draftEligibility, isAutoSendLive, isStaffReply, HUMAN_OWNS_THREAD_MS, KILL_MAX_BAD,
  type AutoSendConfig, type DraftMsg, type DecisionResult,
} from "@/lib/aiDraftModel";
import { whatsappWindowExpired } from "@/lib/crmWindow";
import { processHold, type HoldRow } from "@/lib/aiDraftAuto";
import {
  applyDraftAction, guestCodeApiBody, guestCodeFor, guestCodeRefusal, writeStatusFrom, AUTO_SEND_ACTOR, AUTO_SEND_SOURCE, type ActionDraft,
} from "@/lib/aiDraftAction";
import { loadGuestFacts } from "@/lib/aiDraftGuest";
import { applyCreditAdjustment } from "@/lib/creditWrite";
import { createPromoWrite } from "@/lib/promoWrite";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { sendPushNotificationToMany, type StoredSubscription } from "@/lib/webPush";
import { isAwaitingReply } from "@/lib/awaitingReply";
import { humanPushDue, humanPushPath, HUMAN_PUSH_WITHIN_MS } from "@/lib/crmAttention";
import { notifyAppNeedsHuman } from "@/lib/appPushHuman";
import { loadAttention, strikeHoldingThreadIds } from "@/lib/crmAttentionLoad";
import { POST as sendPOST } from "@/app/api/crm/send/route";

const ENV = FULL_EDITOR_ENV;
const DRAFT_AFTER_MS = 90e3;
const DRAFT_WITHIN_MS = 15 * 60e3;
const MAX_DRAFTS_PER_TICK = 5;
const STUCK_SENDING_MS = 10 * 60e3;
const KILL_NOTIFY_EMAIL = "rmancuso@playmatchday.com";
const CONFIG_COLS = "auto_categories, action_categories, credit_cap_cents, hold_minutes, enabled, shadow";
const HOLD_COLS = "id, thread_id, based_on_message_id, created_at, hold_until, draft_text, decision, action";
const MSG_COLS = "id, direction, body, sent_at, is_auto_reply, media_kind, template_name, sent_by_user_id, auto_sent_draft_id";

async function readConfig(sb: SupabaseClient): Promise<AutoSendConfig> {
  const r = await sb.from("crm_auto_send_config").select(CONFIG_COLS).maybeSingle();
  if (r.error || !r.data) throw new Error(r.error?.message ?? "crm_auto_send_config has no row");
  return r.data as AutoSendConfig;
}

export async function cancelAllHolds(sb: SupabaseClient, note: string): Promise<void> {
  const r = await sb.from("crm_ai_drafts").update({ hold_status: "cancelled", hold_note: note }).eq("hold_status", "holding");
  if (r.error) throw new Error(r.error.message);
}

// The reason goes first in the notes, where the card already shows them. At most 3 bullets, as always.
async function routeToHuman(sb: SupabaseClient, id: string, reason: string): Promise<void> {
  const cur = await sb.from("crm_ai_drafts").select("staff_notes").eq("id", id).maybeSingle();
  const notes = (cur.data?.staff_notes as string | null) ?? "";
  const flags = notes.match(/^\[flags: [^\]]*\]/)?.[0] ?? "";
  const bullets = notes.replace(/^\[flags: [^\]]*\]\s*/, "").split(/\n+/).filter(Boolean).slice(0, 2);
  const staff_notes = [flags, `- ${reason}`, ...bullets].filter(Boolean).join("\n");
  const r = await sb.from("crm_ai_drafts").update({ decision: "human", decision_reason: reason, staff_notes }).eq("id", id);
  if (r.error) console.error("[auto-send] route to human failed", r.error.message);
}

async function applyAutoAction(sb: SupabaseClient, d: HoldRow) {
  return applyDraftAction({
    threadId: d.thread_id,
    reasonPrefix: "Auto:",
    async loadDraft() {
      const r = await sb.from("crm_ai_drafts").select("id, thread_id, outcome, draft_text, action, action_status").eq("id", d.id).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return (r.data as ActionDraft | null) ?? null;
    },
    async threadPlayerId() {
      const r = await sb.from("crm_threads").select("player_id").eq("id", d.thread_id).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return (r.data?.player_id as number | null) ?? null;
    },
    rightsRefusal: async () => null,
    async guestPreflight(playerId) {
      const f = await loadGuestFacts({ supabase: sb, env: ENV, playerId, threadId: d.thread_id, confinedCity: null });
      if (!f.ok) return f;
      // No staff-message exception here: nobody is looking.
      const no = guestCodeRefusal({ ...f.facts, staffConfirmed: false });
      return no ? { ok: false, error: no } : { ok: true, code: guestCodeFor(f.facts.slug!) };
    },
    async claim() {
      const r = await sb.from("crm_ai_drafts").update({ action_status: "applying", action_at: new Date().toISOString() }).eq("id", d.id).eq("outcome", "pending").is("action_status", null).select("id");
      if (r.error) throw new Error(r.error.message);
      return (r.data ?? []).length === 1;
    },
    async writeCredit({ playerId, deltaCents, expectedBeforeCents, reason }) {
      const r = await applyCreditAdjustment({
        env: ENV, playerId: String(playerId), deltaCents, expectedBeforeCents, reason, source: AUTO_SEND_SOURCE,
        actor: { email: AUTO_SEND_ACTOR, userId: AUTO_SEND_ACTOR },
      });
      return { status: writeStatusFrom(r.status, r.json), error: typeof r.json.error === "string" ? r.json.error : undefined };
    },
    async writeGuestCode(code) {
      const body = guestCodeApiBody(code, Date.now());
      const r = await createPromoWrite({
        env: ENV, code, body, changeAfter: `${code} — 100% off, 3 uses, ALL_USERS · TOTAL_USAGE`, source: AUTO_SEND_SOURCE, saveId: randomUUID(),
        actor: { canEditMatches: false, canManagePlayers: false, canManagePromos: true, email: AUTO_SEND_ACTOR, userId: AUTO_SEND_ACTOR },
      });
      return { status: writeStatusFrom(r.status, r.json), error: typeof r.json.error === "string" ? r.json.error : undefined };
    },
    async finish(status, draftText) {
      const r = await sb.from("crm_ai_drafts").update({ action_status: status, ...(draftText ? { draft_text: draftText } : {}) }).eq("id", d.id);
      if (r.error) throw new Error(r.error.message);
    },
  });
}

// The one path to a player with nobody at the keyboard: the send route, which checks the shape itself.
async function sendAuto(d: HoldRow, text: string): Promise<{ ok: boolean; error?: string }> {
  const res = await sendPOST(new Request("https://clubhouse.internal/api/crm/send", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`, "content-type": "application/json" },
    body: JSON.stringify({ thread_id: d.thread_id, body: text, draft_id: d.id, auto_send: true }),
  }));
  if (res.ok) return { ok: true };
  const j = (await res.json().catch(() => ({}))) as { error?: unknown; send_error?: unknown };
  return { ok: false, error: String(j.send_error ?? j.error ?? `HTTP ${res.status}`).slice(0, 200) };
}

async function runDueHolds(sb: SupabaseClient, now: number): Promise<Record<string, number>> {
  const due = await sb.from("crm_ai_drafts").select(HOLD_COLS).eq("hold_status", "holding").lte("hold_until", new Date(now).toISOString()).limit(10);
  if (due.error) throw new Error(due.error.message);
  const tally: Record<string, number> = {};
  for (const d of (due.data ?? []) as (HoldRow & { action: StoredAction | null })[]) {
    const outcome = await processHold(d, {
      now: () => now,
      config: () => readConfig(sb),
      async thread(threadId) {
        const [t, m] = await Promise.all([
          sb.from("crm_threads").select("channel").eq("id", threadId).maybeSingle(),
          sb.from("crm_messages").select(MSG_COLS).eq("thread_id", threadId).order("sent_at", { ascending: false }).limit(60),
        ]);
        if (t.error || m.error) throw new Error(t.error?.message ?? m.error?.message);
        return { channel: (t.data?.channel as string) ?? "sms", msgs: ((m.data ?? []) as DraftMsg[]).reverse() };
      },
      async moveHold(id, from, to, note) {
        const r = await sb.from("crm_ai_drafts").update({ hold_status: to, ...(note ? { hold_note: note } : {}) }).eq("id", id).eq("hold_status", from).select("id");
        if (r.error) throw new Error(r.error.message);
        return (r.data ?? []).length === 1;
      },
      routeToHuman: (id, reason) => routeToHuman(sb, id, reason),
      applyAction: (row) => applyAutoAction(sb, row),
      send: sendAuto,
    }).catch(async (e: unknown) => {
      const msg = e instanceof Error ? e.message.slice(0, 200) : "unknown error";
      console.error("[auto-send] hold failed", d.id, msg);
      const note = `Auto-send stopped on an error, check the thread: ${msg}`;
      await sb.from("crm_ai_drafts").update({ hold_status: "failed", hold_note: note }).eq("id", d.id).in("hold_status", ["holding", "sending"]);
      await routeToHuman(sb, d.id, note);
      return "failed" as const;
    });
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  }
  return tally;
}

async function sweepStuckSends(sb: SupabaseClient, now: number): Promise<void> {
  const stuck = await sb.from("crm_ai_drafts").select("id").eq("hold_status", "sending").lte("hold_until", new Date(now - STUCK_SENDING_MS).toISOString());
  for (const s of stuck.data ?? []) {
    const note = "A send never finished. It may or may not have gone out, check the thread.";
    await sb.from("crm_ai_drafts").update({ hold_status: "failed", hold_note: note }).eq("id", s.id).eq("hold_status", "sending");
    await routeToHuman(sb, s.id as string, note);
  }
}

// More than 3 auto-sends in an hour drew a complaint-shaped reply: stop, cancel the rest, say why, tell Ryan.
async function checkKillSwitch(sb: SupabaseClient, now: number): Promise<boolean> {
  const since = new Date(now - 3600e3).toISOString();
  const sent = await sb.from("crm_messages").select("thread_id, sent_at").not("auto_sent_draft_id", "is", null).gte("sent_at", since);
  if (sent.error) throw new Error(sent.error.message);
  const rows = (sent.data ?? []) as { thread_id: string; sent_at: string }[];
  if (rows.length <= KILL_MAX_BAD) return false;
  const inbound = await sb.from("crm_messages").select("thread_id, sent_at, body").eq("direction", "inbound").in("thread_id", [...new Set(rows.map((r) => r.thread_id))]).gte("sent_at", since);
  if (inbound.error) throw new Error(inbound.error.message);
  const bad = badAutoSendReplies(rows, (inbound.data ?? []) as { thread_id: string; sent_at: string; body: string | null }[], now);
  if (bad <= KILL_MAX_BAD) return false;

  const reason = `Stopped automatically: ${bad} auto-sent replies in the last hour got a reply like "wrong", "no" or "refund" within 30 minutes.`;
  const at = new Date(now).toISOString();
  await recordWrite(
    {
      env: "production", source: "crm-auto-send", actorName: AUTO_SEND_ACTOR, actorEmail: null, saveId: randomUUID(), matchId: null, matchName: null,
      method: "PATCH", path: "/api/crm/auto-send/config", body: { enabled: false, reason: "kill switch", bad_replies: bad }, keys: [], label: (k) => k,
      applied: (_b, a) => a.enabled === false,
      changes: [{ key: "enabled", field: "Auto-send", before: "on", after: reason }],
    },
    {
      readResource: async () => ((await sb.from("crm_auto_send_config").select("enabled").maybeSingle()).data ?? {}) as Record<string, unknown>,
      write: async () => sb.from("crm_auto_send_config").update({ enabled: false, disabled_reason: reason, disabled_at: at, updated_at: at, updated_by_user_id: null }).eq("id", true),
      now: () => at,
    },
    supabaseLogStore(),
  );
  await cancelAllHolds(sb, reason);
  console.error(`[auto-send] kill switch tripped: ${reason}`);

  const u = await sb.from("app_users").select("id").ilike("email", KILL_NOTIFY_EMAIL).maybeSingle();
  const subs = u.data ? await sb.from("push_subscriptions").select("user_id, endpoint, p256dh, auth").eq("user_id", u.data.id) : null;
  if (subs?.data?.length) {
    await sendPushNotificationToMany(subs.data as StoredSubscription[], {
      title: "Auto-send stopped", body: reason, tag: "auto-send-kill", data: { route: "/match-ops/player-chats/auto-send-review" },
    }).catch((e: unknown) => console.error("[auto-send] push failed", e instanceof Error ? e.message : e));
  }
  return true;
}

// ONE PUSH PER THREAD PER INBOUND, 10 minutes after it landed in NEEDS A HUMAN with nothing sent. To the
// assignee, or all chat staff when unassigned. The marker is a change_log row keyed on the inbound id,
// written before the push, so a failed push isn't sent twice either.
async function notifyNeedsHuman(sb: SupabaseClient, now: number): Promise<number> {
  const COLS = "id, assigned_to_user_id, last_message_at, last_message_preview, last_message_direction, no_reply_needed_at, status";
  const open = await sb.from("crm_threads").select(COLS).eq("status", "open").eq("last_message_direction", "inbound").gte("last_message_at", new Date(now - HUMAN_PUSH_WITHIN_MS).toISOString());
  if (open.error) throw new Error(open.error.message);
  const rows = [...(open.data ?? [])] as { id: string; assigned_to_user_id: string | null; last_message_at: string; last_message_preview: string | null; last_message_direction: "inbound" | "outbound"; no_reply_needed_at: string | null; status: "open" | "closed" }[];
  const held = await strikeHoldingThreadIds(sb, now);
  const heldRows = held.length ? await sb.from("crm_threads").select(COLS).in("id", held).eq("status", "open").eq("last_message_direction", "outbound") : null;
  if (heldRows?.error) throw new Error(heldRows.error.message);
  rows.push(...((heldRows?.data ?? []) as typeof rows));
  const attention = await loadAttention(sb, rows.map((t) => ({ id: t.id, last_message_at: t.last_message_at, awaiting: isAwaitingReply(t) })));
  let sent = 0;
  for (const t of rows) {
    const a = attention.get(t.id);
    if (a?.section !== "human" || !a.inbound_id || !humanPushDue(Date.parse(a.entered_at), now)) continue;
    const path = humanPushPath(a.inbound_id);
    const seen = await sb.from("change_log").select("id").eq("endpoint", path).limit(1);
    if (seen.error) throw new Error(seen.error.message);
    if ((seen.data ?? []).length) continue;
    const at = new Date(now).toISOString();
    const logged = await recordWrite(
      {
        env: "production", source: "crm-human-push", actorName: "auto-send", actorEmail: null, saveId: randomUUID(), matchId: null, matchName: null,
        method: "POST", path, body: { thread_id: t.id, to: t.assigned_to_user_id ? "assignee" : "all chat staff" }, keys: [], label: (k) => k, applied: () => true,
        changes: [{ key: "push", field: "Needs a human push", before: "", after: a.reason ?? "" }],
      },
      { readResource: async () => ({}), write: async () => ({}), now: () => at },
      supabaseLogStore(),
    );
    if (!logged.logged) { console.error("[auto-send] push marker not written, not pushing", t.id); continue; }
    let recipients: string[] = t.assigned_to_user_id ? [t.assigned_to_user_id] : [];
    if (!t.assigned_to_user_id) {
      const staff = await sb.from("app_users").select("*");
      if (staff.error) throw new Error(staff.error.message);
      recipients = (staff.data ?? []).filter((u) => (u.is_admin === true || u.can_access_chats === true) && u.is_service_account !== true).map((u) => u.id as string);
    }
    const subs = recipients.length ? await sb.from("push_subscriptions").select("user_id, endpoint, p256dh, auth").in("user_id", recipients) : null;
    if (subs?.data?.length) {
      await sendPushNotificationToMany(subs.data as StoredSubscription[], {
        title: "Needs a human", body: a.reason ?? "A player is waiting.", tag: `human-${t.id}`,
        data: { thread_id: t.id, route: `/match-ops/player-chats?threadId=${encodeURIComponent(t.id)}` },
      }).catch((e: unknown) => console.error("[auto-send] push failed", e instanceof Error ? e.message : e));
      sent++;
    }
  }
  return sent;
}

async function draftOneThread(sb: SupabaseClient, threadId: string, channel: string, now: number, apiKey: string, config: AutoSendConfig): Promise<string> {
  const deps = draftDataDeps({ supabase: sb, threadId, requestedBy: null, confinedCity: null, apiKey });
  const msgs = await deps.loadMessages();
  const elig = draftEligibility(msgs, channel, now);
  if (!elig.ok) return "skipped";
  const any = await sb.from("crm_ai_drafts").select("id").eq("based_on_message_id", elig.basedOn.id).limit(1);
  if (any.error) throw new Error(any.error.message);
  if ((any.data ?? []).length) return "has_draft";

  const live = isAutoSendLive(config);
  const effective = decisionConfig(config);
  const store = async (id: string, d: DecisionResult) => {
    const r = await sb.from("crm_ai_drafts").update({ decision: d.decision, decision_reason: d.reason, decision_shadow: !live }).eq("id", id);
    if (r.error) throw new Error(r.error.message);
  };
  let decided = false;
  const result = await runDraft({
    ...deps, threadId, requestedBy: null, regenerate: false, now: () => now, hasKey: true,
    async afterDraft({ draftId, output, context, msgs: all }) {
      decided = true;
      let guest = null;
      if (output.action?.kind === "issue_guest_code" && output.action) {
        const t = await sb.from("crm_threads").select("player_id").eq("id", threadId).maybeSingle();
        const f = t.data?.player_id != null ? await loadGuestFacts({ supabase: sb, env: ENV, playerId: t.data.player_id as number, threadId, confinedCity: null }).catch(() => null) : null;
        if (f?.ok) {
          const since = f.facts.since ? Date.parse(f.facts.since) : NaN;
          guest = {
            active: !!f.facts.statusRaw && ["ACTIVE", "ADDED_FROM_ADMIN"].includes(f.facts.statusRaw.toUpperCase()) && !f.facts.canceledAt,
            over24Hours: Number.isFinite(since) && now - since >= 86400e3,
            hasActiveCode: f.facts.existingCodes.some((c) => !c.deleted_at && (!c.end_date_utc || Date.parse(c.end_date_utc) > now)),
          };
        }
      }
      const lastInbound = [...all].reverse().find((m) => m.direction === "inbound");
      const d = decideAutoSend(output, {
        context, guest, msgs: all,
        windowClosed: whatsappWindowExpired(channel, lastInbound?.sent_at ?? null, now),
        humanRepliedRecently: all.some((m) => isStaffReply(m) && now - Date.parse(m.sent_at) < HUMAN_OWNS_THREAD_MS),
      }, effective);
      await store(draftId, d);
      if (!live) return;
      if (d.decision === "human") { await routeToHuman(sb, draftId, d.reason); return; }
      const hold = await sb.from("crm_ai_drafts").update({ hold_status: "holding", hold_until: new Date(now + config.hold_minutes * 60e3).toISOString() }).eq("id", draftId);
      // One hold per thread (partial unique index). A second one waits for a person.
      if (hold.error) await routeToHuman(sb, draftId, "Another auto-send is already waiting on this thread.");
    },
  });
  if (result.status === "failed" && result.draft_id && !decided) {
    await store(result.draft_id, { decision: "human", reason: `The draft failed a check: ${result.message}` });
  }
  return result.status;
}

export async function runAutoSendTick(sb: SupabaseClient): Promise<Record<string, unknown>> {
  const now = Date.now();
  const out: Record<string, unknown> = {};
  let config = await readConfig(sb);
  out.live = isAutoSendLive(config);
  out.shadow = config.shadow;

  if (!isAutoSendLive(config)) await cancelAllHolds(sb, "Auto-send is off.");
  await sweepStuckSends(sb, now);
  if (isAutoSendLive(config)) {
    if (await checkKillSwitch(sb, now)) {
      out.killed = true;
      config = await readConfig(sb);
    } else {
      out.holds = await runDueHolds(sb, now);
    }
  }

  out.pushed = await notifyNeedsHuman(sb, now).catch((e: unknown) => {
    console.error("[auto-send] needs-human push failed", e instanceof Error ? e.message.slice(0, 200) : e);
    return "error";
  });

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  /* THE STAFF APP'S PUSH runs LAST, after this tick's drafts, so a thread its draft just sent to a
   * person pushes now rather than a minute later (appPushHuman). Isolated: it never fails the tick. */
  const appPush = async () => {
    const r = await notifyAppNeedsHuman(sb, Date.now(), { hasModelKey: !!apiKey }).catch((e: unknown) => {
      console.error("[auto-send] app needs-human push failed", e instanceof Error ? e.message.slice(0, 200) : e);
      return null;
    });
    if (!r) return "error";
    const tally: Record<string, number> = {};
    for (const x of r) tally[x.action] = (tally[x.action] ?? 0) + 1;
    return tally;
  };
  if (!apiKey) return { ...out, drafts: "no key", app_push: await appPush() };
  const threads = await sb.from("crm_threads").select("id, channel")
    .eq("status", "open").eq("last_message_direction", "inbound")
    .gte("last_message_at", new Date(now - DRAFT_WITHIN_MS).toISOString())
    .lte("last_message_at", new Date(now - DRAFT_AFTER_MS).toISOString())
    .order("last_message_at", { ascending: true }).limit(MAX_DRAFTS_PER_TICK * 3);
  if (threads.error) throw new Error(threads.error.message);
  const settled = await Promise.allSettled(((threads.data ?? []) as { id: string; channel: string }[]).slice(0, MAX_DRAFTS_PER_TICK).map((t) => draftOneThread(sb, t.id, t.channel ?? "sms", now, apiKey, config)));
  const tally: Record<string, number> = {};
  for (const s of settled) {
    const k = s.status === "fulfilled" ? s.value : "error";
    tally[k] = (tally[k] ?? 0) + 1;
    if (s.status === "rejected") console.error("[auto-send] draft failed", s.reason instanceof Error ? s.reason.message.slice(0, 200) : s.reason);
  }
  out.drafts = tally;
  out.app_push = await appPush();
  return out;
}
