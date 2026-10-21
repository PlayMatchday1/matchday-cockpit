// POST /api/crm/threads/[id]/ai-draft — Claude drafts a reply for this thread (phase 1).
//
// Body: { regenerate?: boolean }
//
// Called by the draft card when someone opens a thread whose latest message is from the player.
// Returns a draft for a human to Use, edit or Discard. NOTHING IS SENT FROM HERE: the only way a
// draft reaches a player is a staff member pressing the existing Send, which goes through
// /api/crm/send exactly as a typed reply does.
//
// Auth: authenticateCrm — anyone with can_access_chats (or is_admin). No new right (Ryan,
// 2026-10-20). A city-confined account gets the same city check the context route applies.
//
// The decisions (skip, reuse, cap, guards) live in src/lib/aiDraftRun.ts and are tested there
// with fakes; this file wires them to Supabase, the MatchDay profile read and the Anthropic API.
// Key: ANTHROPIC_API_KEY, server-side only. Model: claude-sonnet-5-5 at low effort.

import Anthropic from "@anthropic-ai/sdk";
import { authenticateCrm } from "@/lib/crmAuth";
import { apiGet } from "@/lib/matchdayStageApi";
import { buildProfile } from "@/lib/playerProfile";
import { loadMirrorHistory } from "@/lib/mirrorHistory";
import { cityNameFor, resolveCityScope } from "@/lib/cityScope";
import type { ScheduleRow } from "@/lib/aiDraftClock";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { loadPlaybook } from "@/lib/aiDraftPlaybook";
import { assertAnthropicHost, phoneShapes, ANTHROPIC_HOST, type DraftContextIn, type DraftMsg } from "@/lib/aiDraftModel";
import { toNationalDigits } from "@/lib/phone";
import { runDraft, type StoredDraft } from "@/lib/aiDraftRun";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteCtx = { params: Promise<{ id: string }> };
const ENV = FULL_EDITOR_ENV;
const ANTHROPIC_BASE_URL = `https://${ANTHROPIC_HOST}`;

export async function POST(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase } = auth;
  const { id: threadId } = await ctx.params;
  if (!threadId) return Response.json({ error: "id required" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { regenerate?: unknown };
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  let threadPhone: string | null = null;

  const result = await runDraft({
    threadId,
    requestedBy: auth.appUserId,
    regenerate: body.regenerate === true,
    now: () => Date.now(),
    hasKey: !!apiKey,

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
        .select("id, direction, body, sent_at, is_auto_reply, media_kind, template_name")
        .eq("thread_id", threadId)
        .order("sent_at", { ascending: false })
        .limit(60);
      if (r.error) throw new Error(r.error.message);
      return ((r.data ?? []) as DraftMsg[]).reverse();
    },

    async latestDraftFor(basedOn) {
      const r = await supabase
        .from("crm_ai_drafts")
        .select("id, outcome, draft_text, staff_notes, category, error, created_at, context_keys")
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
      await supabase.from("crm_ai_drafts").update({ outcome: "superseded", outcome_at: new Date().toISOString(), outcome_by_user_id: auth.appUserId })
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
      if (auth.confinedCity) {
        const pc = ((listRow ?? {}) as Record<string, unknown>).preferableCity as Record<string, unknown> | undefined;
        if ((pc && typeof pc.name === "string" ? pc.name : null) !== cityNameFor(auth.confinedCity)) return { forbidden: true };
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
  }).catch((e: unknown) => {
    console.error("[ai-draft] failed", e instanceof Error ? e.message.slice(0, 200) : e);
    return { status: "failed" as const, draft_id: null, message: "Something went wrong making a draft." };
  });

  console.log(`[ai-draft] thread=${threadId} status=${result.status}${"reused" in result ? ` reused=${result.reused}` : ""}`);
  const http = result.status === "forbidden" ? 403 : result.status === "not_found" ? 404 : 200;
  return Response.json(result, { status: http, headers: { "cache-control": "no-store" } });
}
