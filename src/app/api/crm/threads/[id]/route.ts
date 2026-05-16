// GET /api/crm/threads/[id] — full thread for the center pane.
// Returns the thread, all messages chronological asc, and the
// player context payload for the right pane.
//
// Player context: name, city, phone, email, is_member, +
// total_match_count from mdapi_match_players (where player_id = X).
//
// Auth: dual-mode bearer via src/lib/crmAuth.
//
// Response:
//   {
//     thread: {...},
//     messages: [...],
//     player: { id, first_name, last_name, email, phone_number,
//               preferable_city_normalized, is_member,
//               total_match_count } | null
//   }

import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateCrm } from "@/lib/crmAuth";
import { toNationalDigits } from "@/lib/phone";

export const runtime = "nodejs";
export const maxDuration = 10;

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const { id: threadId } = await ctx.params;
  if (!threadId) {
    return Response.json({ error: "id required" }, { status: 400 });
  }

  const threadRes = await supabase
    .from("crm_threads")
    .select(
      "id, phone_number, player_id, match_ambiguous, last_message_at, last_message_preview, created_at, assigned_to_user_id, assigned_at, channel",
    )
    .eq("id", threadId)
    .maybeSingle();
  if (threadRes.error) {
    console.error("[crm:threads.detail] db error", threadRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!threadRes.data) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  const thread = threadRes.data;

  // Current assignee (Phase 1).
  let assignee: { id: string; email: string; full_name: string | null } | null =
    null;
  if (thread.assigned_to_user_id) {
    const a = await supabase
      .from("app_users")
      .select("id, email, full_name")
      .eq("id", thread.assigned_to_user_id)
      .maybeSingle();
    if (!a.error && a.data) {
      assignee = a.data as {
        id: string;
        email: string;
        full_name: string | null;
      };
    }
  }

  const messagesRes = await supabase
    .from("crm_messages")
    .select(
      "id, thread_id, direction, body, sent_at, sent_by_user_id, telnyx_message_id, external_message_id, segment_count, channel, delivery_status, delivery_status_updated_at",
    )
    .eq("thread_id", threadId)
    .order("sent_at", { ascending: true });
  if (messagesRes.error) {
    console.error(
      "[crm:threads.detail] messages query error",
      messagesRes.error,
    );
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  // sender_email for outbound rows so the UI can label bubbles.
  const senderIds = Array.from(
    new Set(
      (messagesRes.data ?? [])
        .map((m) => m.sent_by_user_id)
        .filter((x): x is string => typeof x === "string"),
    ),
  );
  const sendersById = new Map<string, { email: string; full_name: string | null }>();
  if (senderIds.length > 0) {
    const senders = await supabase
      .from("app_users")
      .select("id, email, full_name")
      .in("id", senderIds);
    if (!senders.error && senders.data) {
      for (const s of senders.data as {
        id: string;
        email: string;
        full_name: string | null;
      }[]) {
        sendersById.set(s.id, { email: s.email, full_name: s.full_name });
      }
    }
  }
  const messages = (messagesRes.data ?? []).map((m) => ({
    ...m,
    sender:
      typeof m.sent_by_user_id === "string"
        ? sendersById.get(m.sent_by_user_id) ?? null
        : null,
  }));

  // Player context — only if thread has a player_id.
  let player: unknown = null;
  if (thread.player_id != null) {
    const playerRes = await supabase
      .from("mdapi_users")
      .select(
        "id, first_name, last_name, email, phone_number, preferable_city_normalized, preferable_city_name, is_member, created_at",
      )
      .eq("id", thread.player_id)
      .maybeSingle();
    if (!playerRes.error && playerRes.data) {
      // Total matches "attended" (registrations not cancelled).
      // Counted on mdapi_match_players.user_id with head + count to
      // avoid pulling rows.
      const matchCount = await supabase
        .from("mdapi_match_players")
        .select("api_id", { count: "exact", head: true })
        .eq("user_id", thread.player_id)
        .not("is_cancelled", "is", true);
      const total_match_count = matchCount.error ? null : matchCount.count;
      player = { ...playerRes.data, total_match_count };
    }
  }

  // Recent matches panel (Phase 2A). Two-step fetch because the
  // mdapi_match_players → mdapi_matches join is a "soft FK" (no
  // enforced constraint, see migration 0016), so PostgREST can't
  // embed. Pull 50 most-recent registrations by mp.created_at DESC,
  // batch the matches, sort by start_date DESC client-side, slice 5.
  // 50 is enough to absorb a future-registration burst from a power
  // user without missing their actual most-recent played match.
  const recent_matches =
    thread.player_id != null
      ? await loadRecentMatches(supabase, thread.player_id as number)
      : [];

  // How many historical mdapi_users rows share this phone? Surfaced
  // in the softened "N historical accounts on file" info note. Only
  // computed for threads we've already flagged as ambiguous —
  // otherwise the count is meaningless (always 1) and not worth the
  // extra round-trips.
  let historical_account_count: number | null = null;
  if (thread.match_ambiguous === true) {
    historical_account_count = await countHistoricalAccounts(
      supabase,
      thread.phone_number as string,
    );
  }

  // Latest inbound message timestamp — used client-side to enforce
  // the WhatsApp 24-hour session window (compose disabled past it).
  // Derived from the already-loaded messages so no extra query.
  let latest_inbound_at: string | null = null;
  for (let i = (messagesRes.data?.length ?? 0) - 1; i >= 0; i--) {
    const m = messagesRes.data![i];
    if (m.direction === "inbound" && typeof m.sent_at === "string") {
      latest_inbound_at = m.sent_at;
      break;
    }
  }

  return Response.json(
    {
      thread,
      messages,
      player,
      assignee,
      recent_matches,
      historical_account_count,
      latest_inbound_at,
    },
    { status: 200 },
  );
}

async function countHistoricalAccounts(
  supabase: SupabaseClient,
  e164: string,
): Promise<number | null> {
  // Same two phone shapes the webhook matches on (E.164 and bare
  // 10-digit national). Sum the head counts. Doing two HEAD queries
  // is cheap because phone_number is indexed via the email_lower /
  // city / completed_sign_up indexes on mdapi_users; the planner
  // picks a btree on the equality predicate.
  const national = toNationalDigits(e164);
  const a = await supabase
    .from("mdapi_users")
    .select("id", { count: "exact", head: true })
    .eq("phone_number", e164);
  const aCount = a.error ? 0 : a.count ?? 0;
  if (!national) return aCount;
  const b = await supabase
    .from("mdapi_users")
    .select("id", { count: "exact", head: true })
    .eq("phone_number", national);
  const bCount = b.error ? 0 : b.count ?? 0;
  return aCount + bCount;
}

// ============================================================
// Recent matches helpers
// ============================================================

type RegRow = {
  match_api_id: number;
  is_cancelled: boolean | null;
  is_absent: boolean | null;
  created_at: string | null;
};

type MatchRow = {
  api_id: number;
  field_title: string | null;
  field_address: string | null;
  start_date: string | null;
  is_cancelled: boolean | null;
};

type RecentMatch = {
  match_api_id: number;
  venue: string | null;
  start_date: string | null;
  status: "Played" | "Upcoming" | "No-show" | "Canceled";
};

const REG_WINDOW = 50; // pre-sort window
const RECENT_LIMIT = 5; // final slice

async function loadRecentMatches(
  supabase: SupabaseClient,
  playerId: number,
): Promise<RecentMatch[]> {
  // 1) most-recent registrations (window).
  const regs = await supabase
    .from("mdapi_match_players")
    .select("match_api_id, is_cancelled, is_absent, created_at")
    .eq("user_id", playerId)
    .order("created_at", { ascending: false })
    .limit(REG_WINDOW);
  if (regs.error || !regs.data?.length) return [];

  const regList = regs.data as RegRow[];
  const matchIds = Array.from(
    new Set(
      regList
        .map((r) => r.match_api_id)
        .filter((x): x is number => typeof x === "number"),
    ),
  );
  if (matchIds.length === 0) return [];

  // 2) batch-fetch the matches.
  const matches = await supabase
    .from("mdapi_matches")
    .select("api_id, field_title, field_address, start_date, is_cancelled")
    .in("api_id", matchIds);
  if (matches.error) return [];

  const matchById = new Map<number, MatchRow>();
  for (const m of matches.data as MatchRow[]) matchById.set(m.api_id, m);

  // 3) derive status, sort by start_date DESC, slice top N.
  const now = Date.now();
  const joined: RecentMatch[] = [];
  for (const r of regList) {
    const m = matchById.get(r.match_api_id);
    if (!m) continue;
    joined.push({
      match_api_id: m.api_id,
      venue: m.field_title,
      start_date: m.start_date,
      status: deriveMatchStatus(r, m, now),
    });
  }
  joined.sort((a, b) => {
    // Nulls last on date — they shouldn't happen but defend anyway.
    const at = a.start_date ? Date.parse(a.start_date) : -Infinity;
    const bt = b.start_date ? Date.parse(b.start_date) : -Infinity;
    return bt - at;
  });
  return joined.slice(0, RECENT_LIMIT);
}

function deriveMatchStatus(
  r: RegRow,
  m: MatchRow,
  now: number,
): RecentMatch["status"] {
  if (r.is_cancelled === true || m.is_cancelled === true) return "Canceled";
  const startTs = m.start_date ? Date.parse(m.start_date) : NaN;
  const isPast = !Number.isNaN(startTs) && startTs < now;
  if (r.is_absent === true && isPast) return "No-show";
  if (isPast) return "Played";
  return "Upcoming";
}
