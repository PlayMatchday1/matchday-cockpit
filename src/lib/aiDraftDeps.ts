import "server-only"; // no-op under --conditions=react-server
// THE REAL DATA BEHIND runDraft: Supabase, the MatchDay profile read and the Anthropic API. Shared by
// the card's route (a person asked) and the inbound tick (nobody asked yet), so a draft is built the
// same way whichever one started it.
//
// A field not named here cannot reach the API. There is no spread of a profile or a row on this path.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { apiGet } from "@/lib/matchdayStageApi";
import { buildProfile } from "@/lib/playerProfile";
import { loadMirrorHistory } from "@/lib/mirrorHistory";
import { cityNameFor, resolveCityScope } from "@/lib/cityScope";
import type { ScheduleRow } from "@/lib/aiDraftClock";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { loadPlaybook } from "@/lib/aiDraftPlaybook";
import { assertAnthropicHost, phoneShapes, priorCourtesyFromLog, ANTHROPIC_HOST, type CreditLogRow, type DraftContextIn, type DraftMsg } from "@/lib/aiDraftModel";
import { toNationalDigits } from "@/lib/phone";
import type { DraftDeps, StoredDraft } from "@/lib/aiDraftRun";
import { buildRecordedFields, CAMERA_LOOKAHEAD_DAYS, CAMERA_LOOKBACK_DAYS, type CameraRow } from "@/lib/aiDraftCamera";

const ENV = FULL_EDITOR_ENV;
const ANTHROPIC_BASE_URL = `https://${ANTHROPIC_HOST}`;

export type DraftDataArgs = { supabase: SupabaseClient; threadId: string; requestedBy: string | null; confinedCity: string | null; apiKey: string | undefined };
type DataDeps = Omit<DraftDeps, "threadId" | "requestedBy" | "regenerate" | "now" | "hasKey">;

export function draftDataDeps(args: DraftDataArgs): DataDeps {
  const { supabase, threadId, apiKey } = args;
  let threadPhone: string | null = null;
  return {
    async loadThread() {
      // account_confirmed_at: migration 0228. Applied before this code shipped.
      const r = await supabase.from("crm_threads").select("channel, phone_number, player_id, match_ambiguous, account_confirmed_at").eq("id", threadId).maybeSingle();
      if (r.error || !r.data) return null;
      threadPhone = (r.data.phone_number as string | null) ?? null;
      return {
        channel: (r.data.channel as string) ?? "sms", player_id: (r.data.player_id as number | null) ?? null,
        match_ambiguous: r.data.match_ambiguous === true, account_confirmed: r.data.account_confirmed_at != null,
      };
    },

    async countAccounts() {
      if (!threadPhone) return null;
      const national = toNationalDigits(threadPhone);
      const r = await supabase.from("mdapi_users").select("id", { count: "exact", head: true }).in("phone_number", [threadPhone, ...(national ? [national] : [])]);
      return r.error ? null : r.count ?? null;
    },

    async findAccountsByPhone(digits10) {
      const r = await supabase.from("mdapi_users").select("id, first_name").in("phone_number", phoneShapes(digits10)).limit(10);
      if (r.error) throw new Error(r.error.message);
      return (r.data ?? []) as { id: number; first_name: string | null }[];
    },

    async loadMessages() {
      // Newest 60, returned oldest first. The transcript keeps the last 40 of those.
      const r = await supabase
        .from("crm_messages")
        .select("id, direction, body, sent_at, is_auto_reply, media_kind, template_name, sent_by_user_id, auto_sent_draft_id")
        .eq("thread_id", threadId)
        .order("sent_at", { ascending: false })
        .limit(60);
      if (r.error) throw new Error(r.error.message);
      return ((r.data ?? []) as DraftMsg[]).reverse();
    },

    async latestDraftFor(basedOn) {
      const r = await supabase
        .from("crm_ai_drafts")
        .select("id, outcome, draft_text, staff_notes, category, error, created_at, context_keys, reply_without_action, action, action_status")
        .eq("thread_id", threadId)
        .eq("based_on_message_id", basedOn)
        .neq("outcome", "superseded")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return (r.data as StoredDraft | null) ?? null;
    },

    // Only a PENDING draft is superseded. A discarded or failed one keeps its outcome: that record
    // is the evidence for auto-send.
    async supersedePending() {
      await supabase.from("crm_ai_drafts").update({ outcome: "superseded", outcome_at: new Date().toISOString(), outcome_by_user_id: args.requestedBy })
        .eq("thread_id", threadId).eq("outcome", "pending");
    },

    async monthSpendUsd(sinceIso) {
      // Every row since the month began, including failed drafts: a failed call still cost money.
      let total = 0;
      for (let from = 0; ; from += 1000) {
        const r = await supabase.from("crm_ai_drafts").select("cost_usd").gte("created_at", sinceIso).range(from, from + 999);
        if (r.error) throw new Error(r.error.message);
        const rows = (r.data ?? []) as { cost_usd: number | string | null }[];
        for (const x of rows) total += Number(x.cost_usd ?? 0);
        if (rows.length < 1000) break;
      }
      return total;
    },

    async loadContext(thread) {
      const keys: string[] = ["account"];
      const ctxIn: DraftContextIn = {
        linked: thread.player_id != null, ambiguous: thread.match_ambiguous,
        firstName: null, city: null, isMember: null, membership: null,
        creditsCents: null, matchesPlayed: null, strikes: null, matches: [],
      };
      if (thread.player_id == null) return { ctx: ctxIn, keys };

      const u = await supabase.from("mdapi_users").select("first_name, preferable_city_name, preferable_city_normalized, is_member").eq("id", thread.player_id).maybeSingle();
      if (!u.error && u.data) {
        ctxIn.firstName = (u.data.first_name as string | null)?.trim() || null;
        ctxIn.city = (u.data.preferable_city_name as string | null) ?? null;
        ctxIn.cityCode = resolveCityScope(u.data.preferable_city_normalized as string | null)?.identifier ?? null;
        ctxIn.isMember = u.data.is_member === true;
        keys.push("first_name", "city");
      }

      const [rawRes, listRes] = await Promise.allSettled([
        apiGet<Record<string, unknown>>(ENV, `/admin/players/${thread.player_id}`),
        apiGet<{ data?: Record<string, unknown>[] }>(ENV, `/admin/players`, { id: thread.player_id, limit: 1, page: 1 })
          .then((r) => (Array.isArray(r) ? r[0] : (r.data ?? [])[0]) ?? null),
      ]);
      const raw = rawRes.status === "fulfilled" ? rawRes.value : null;
      const listRow = listRes.status === "fulfilled" ? listRes.value : null;

      // The same city boundary the context route repeats: a confined account cannot use drafts to
      // read a player outside its city.
      if (args.confinedCity) {
        const pc = ((listRow ?? {}) as Record<string, unknown>).preferableCity as Record<string, unknown> | undefined;
        if ((pc && typeof pc.name === "string" ? pc.name : null) !== cityNameFor(args.confinedCity)) return { forbidden: true };
      }

      if (raw) {
        try {
          const mirrorRows = await loadMirrorHistory(supabase, thread.player_id);
          // No Stripe read and no ban-actor lookup: card details and staff names stay out.
          const p = await buildProfile({ raw, listRow, mirrorRows, charges: null, resolveActor: async () => null });
          ctxIn.creditsCents = p.player.credits;
          ctxIn.matchesPlayed = p.player.matchesPlayed;
          ctxIn.city = p.player.city ?? ctxIn.city;
          ctxIn.strikes = { active: p.strikes.activeCount, limit: p.strikes.limit, suspended: p.strikes.isSuspended };
          if (p.membership) {
            ctxIn.membership = { status: p.membership.status, since: p.membership.since, renews: p.membership.renews, canceledAt: p.membership.canceledAt, price: p.membership.price };
          }
          ctxIn.matches = p.matches.map((m) => ({
            name: m.name, startDate: m.startDate, startDateUtc: m.startDateUtc, state: m.state,
            price: m.price, charged: m.charged, playerCancelledAt: m.playerCancelledAt,
          }));
          keys.push("credits", "matches_played", "strikes", "membership", "matches");
        } catch (e) {
          console.error("[ai-draft] profile build failed", e instanceof Error ? e.message.slice(0, 160) : e);
        }
      }

      // ONE COURTESY PER ACCOUNT. A failed read leaves this null, which is not eligible.
      const log = await supabase.from("change_log").select("env, outcome, changes").eq("endpoint", `/admin/players/${thread.player_id}/profile`);
      if (!log.error) {
        ctxIn.priorCourtesyCredit = priorCourtesyFromLog((log.data ?? []) as CreditLogRow[]);
        keys.push("prior_courtesy");
      }

      // CAMERA COVERAGE for their city: the marker in the match name, recent and upcoming, field by field.
      if (ctxIn.cityCode) {
        const now = Date.now();
        const cam = await supabase.from("mdapi_matches")
          .select("field_id, field_title, name, start_date, start_date_utc, is_cancelled")
          .eq("city_identifier", ctxIn.cityCode).is("deleted_at", null)
          .gte("start_date", new Date(now - CAMERA_LOOKBACK_DAYS * 86400e3).toISOString())
          .lt("start_date", new Date(now + CAMERA_LOOKAHEAD_DAYS * 86400e3).toISOString())
          .limit(1000);
        if (!cam.error) {
          ctxIn.recordedFields = buildRecordedFields((cam.data ?? []) as CameraRow[], now);
          keys.push("recorded_fields");
        }
      }
      return { ctx: ctxIn, keys };
    },

    // OUR schedule, from the mirror. start_date is WALL CLOCK, so the window is wall-clock bounds;
    // start_date_utc (an instant) decides "already started". Soft-deleted matches are left out.
    async loadScheduleRows({ fromWall, toWall }) {
      const r = await supabase
        .from("mdapi_matches")
        .select("api_id, field_title, start_date, start_date_utc, city_identifier, is_cancelled, player_count, max_player_count")
        .gte("start_date", fromWall)
        .lt("start_date", toWall)
        .is("deleted_at", null)
        .order("start_date_utc", { ascending: true })
        .limit(1000);
      if (r.error) throw new Error(r.error.message);
      return (r.data ?? []) as ScheduleRow[];
    },

    async priorCategory() {
      const r = await supabase.from("crm_ai_drafts").select("category").eq("thread_id", threadId).not("category", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return (r.data?.category as string | null) ?? null;
    },

    // The last staff messages in that category's threads, this thread left out (it's in the transcript).
    async loadExampleMessages(category) {
      let q = supabase.from("crm_messages").select("id, direction, body, sent_at, is_auto_reply, media_kind, template_name, auto_sent_draft_id")
        .eq("direction", "outbound").not("sent_by_user_id", "is", null).neq("thread_id", threadId)
        .order("sent_at", { ascending: false }).limit(300);
      if (category) {
        const t = await supabase.from("crm_ai_drafts").select("thread_id").eq("category", category).order("created_at", { ascending: false }).limit(500);
        if (t.error) throw new Error(t.error.message);
        const ids = [...new Set((t.data ?? []).map((x) => x.thread_id as string))];
        if (ids.length) q = q.in("thread_id", ids);
      }
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      return (r.data ?? []) as DraftMsg[];
    },

    async appliedActions() {
      const r = await supabase.from("crm_ai_drafts").select("action").eq("thread_id", threadId).in("action_status", ["applying", "landed", "unknown"])
        .gte("created_at", new Date(Date.now() - 7 * 86400e3).toISOString());
      if (r.error) throw new Error(r.error.message);
      return (r.data ?? []).map((x) => ({ kind: String((x.action as { kind?: unknown } | null)?.kind ?? "") }));
    },

    playbook: () => loadPlaybook(),

    async callModel(request) {
      const client = new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE_URL, maxRetries: 0, timeout: 50_000 });
      assertAnthropicHost(client.baseURL);
      const res = await client.messages.create(request);
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim() || null;
      return { text, stopReason: res.stop_reason, usage: res.usage };
    },

    async insertDraft(row) {
      const r = await supabase.from("crm_ai_drafts").insert(row).select("id, created_at").single();
      if (r.error || !r.data) throw new Error(r.error?.message ?? "insert failed");
      return { id: r.data.id as string, created_at: r.data.created_at as string };
    },
  };
}
