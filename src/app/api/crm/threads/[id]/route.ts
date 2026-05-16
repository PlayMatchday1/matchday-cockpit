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
      // 2026 played count — registrations the player actually
      // attended in the current calendar year. Mirrors the
      // deriveMatchStatus() rules below: not cancelled on either
      // side, not absent, and the match started before "now"
      // (future 2026 matches haven't been played yet).
      //
      // Replaces the older "all-time non-cancelled registrations"
      // count which conflated cancelled-but-still-non-flagged
      // history with attended matches. Surfaced as
      // "MATCHES (2026)" in the context panel.
      const played_in_2026 = await loadPlayed2026Count(
        supabase,
        thread.player_id as number,
      );
      player = { ...playerRes.data, played_in_2026 };
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

  // Upcoming bookings (Phase 3 of Chats context panel). Same
  // mdapi_match_players → mdapi_matches join shape as Recent,
  // but filtered to start_date > now() and unbounded in count —
  // the system only books ~1 week out so per-player volume stays
  // small. Cancelled future bookings ARE included; the UI
  // de-emphasizes them so operators can see at a glance whether
  // the player has already cancelled before they reply.
  const upcoming_matches =
    thread.player_id != null
      ? await loadUpcomingMatches(supabase, thread.player_id as number)
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
      upcoming_matches,
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

// ============================================================
// Upcoming matches helpers
// ============================================================

// One row per future booking the player has — used by the context
// panel's "UPCOMING" section. Includes cancelled rows so operators
// can see at a glance whether the player has already withdrawn.
type UpcomingRegRow = {
  match_api_id: number;
  team: number | null;
  player_number: number | null;
  is_cancelled: boolean | null;
};

type UpcomingMatchRow = {
  api_id: number;
  field_title: string | null;
  start_date: string | null;
  is_cancelled: boolean | null;
};

type UpcomingMatch = {
  match_api_id: number;
  venue: string | null;
  start_date: string | null;
  team: number | null;
  player_number: number | null;
  is_cancelled: boolean;
};

async function loadUpcomingMatches(
  supabase: SupabaseClient,
  playerId: number,
): Promise<UpcomingMatch[]> {
  const nowIso = new Date().toISOString();

  // Same two-step shape as recent_matches because the mdapi_match
  // _players → mdapi_matches join is a soft FK (no enforced
  // constraint per migration 0016) and PostgREST can't embed.
  // Step 1: matches starting in the future. Limited to a finite
  // window even though the system only books ~1 week out — a
  // bound keeps a future sync glitch from returning thousands of
  // rows here.
  const FUTURE_WINDOW_DAYS = 60;
  const cutoff = new Date(
    Date.now() + FUTURE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const matches = await supabase
    .from("mdapi_matches")
    .select("api_id, field_title, start_date, is_cancelled")
    .gt("start_date", nowIso)
    .lt("start_date", cutoff)
    .order("start_date", { ascending: true });
  if (matches.error || !matches.data?.length) return [];

  const matchIds = (matches.data as UpcomingMatchRow[]).map((m) => m.api_id);
  if (matchIds.length === 0) return [];

  // Step 2: the player's registrations on those matches.
  const regs = await supabase
    .from("mdapi_match_players")
    .select("match_api_id, team, player_number, is_cancelled")
    .eq("user_id", playerId)
    .in("match_api_id", matchIds);
  if (regs.error || !regs.data?.length) return [];

  const matchById = new Map<number, UpcomingMatchRow>();
  for (const m of matches.data as UpcomingMatchRow[]) {
    matchById.set(m.api_id, m);
  }

  // Combine into the response shape. is_cancelled is true if
  // EITHER the registration was cancelled OR the match itself
  // was cancelled — operators just want to know it's a no-op.
  const out: UpcomingMatch[] = [];
  for (const r of regs.data as UpcomingRegRow[]) {
    const m = matchById.get(r.match_api_id);
    if (!m) continue;
    out.push({
      match_api_id: m.api_id,
      venue: m.field_title,
      start_date: m.start_date,
      team: r.team,
      player_number: r.player_number,
      is_cancelled: r.is_cancelled === true || m.is_cancelled === true,
    });
  }

  // Already ordered ASC by match.start_date from the query, but
  // the regs.data scrambled the order — re-sort by start_date.
  out.sort((a, b) => {
    const at = a.start_date ? Date.parse(a.start_date) : Infinity;
    const bt = b.start_date ? Date.parse(b.start_date) : Infinity;
    return at - bt;
  });
  return out;
}

// ============================================================
// 2026-played count
// ============================================================
// Counts the player's registrations that satisfy ALL of:
//   - registration not cancelled
//   - match not cancelled
//   - player not marked absent
//   - match.start_date is within 2026-01-01..2026-12-31 inclusive
//   - match.start_date < now (Upcoming 2026 matches don't count
//     as "played" yet)
//
// PostgREST limitation: we can't filter across two tables in a
// single .select() — we have to two-step it (fetch player rows,
// fetch match rows, intersect). For most players the result set
// is small (single-digit matches per month), so this stays cheap.

const YEAR = 2026;
const YEAR_START_ISO = `${YEAR}-01-01T00:00:00Z`;
const YEAR_END_ISO = `${YEAR + 1}-01-01T00:00:00Z`;

async function loadPlayed2026Count(
  supabase: SupabaseClient,
  playerId: number,
): Promise<number | null> {
  // Step 1: candidate registrations — not cancelled, not absent.
  const regs = await supabase
    .from("mdapi_match_players")
    .select("match_api_id")
    .eq("user_id", playerId)
    .not("is_cancelled", "is", true)
    .not("is_absent", "is", true);
  if (regs.error) return null;
  const matchIds = (regs.data ?? [])
    .map((r) => r.match_api_id as number | null)
    .filter((x): x is number => typeof x === "number");
  if (matchIds.length === 0) return 0;

  // Step 2: count matches in those that are 2026 + already
  // started + not match-cancelled.
  const nowIso = new Date().toISOString();
  const c = await supabase
    .from("mdapi_matches")
    .select("api_id", { count: "exact", head: true })
    .in("api_id", matchIds)
    .gte("start_date", YEAR_START_ISO)
    .lt("start_date", YEAR_END_ISO)
    .lt("start_date", nowIso)
    .not("is_cancelled", "is", true);
  if (c.error) return null;
  return c.count ?? 0;
}
