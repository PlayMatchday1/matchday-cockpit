// GET /api/crm/threads/[id]/context — player + match data for the
// ContextPanel right column / mobile sheet.
//
// Split out from /api/crm/threads/[id] so the chat pane can render
// the moment messages arrive. This endpoint holds the heavier
// player + recent/upcoming match queries and is fetched lazily by
// ContextPanel only when the panel becomes visible.
//
// Auth: dual-mode bearer via src/lib/crmAuth.
//
// Response:
//   {
//     player: { id, first_name, last_name, ..., played_in_2026 } | null,
//     membership: { member_id, status, canceled_at, cancel_reason } | null,
//     recent_matches: [...],
//     upcoming_matches: [...],
//     historical_account_count: number | null,
//   }
//
// `membership` is resolved by joining fin_members against the
// player's email (case-insensitive) or the thread's phone number
// (rightmost 10 digits — fin_members.phone is E.164 with +1 prefix
// per Retool sync). Used by ContextPanel to surface member_id and a
// "Cancelled on …" notice when an active member has scheduled their
// membership to end.

import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateCrm } from "@/lib/crmAuth";
import { toNationalDigits } from "@/lib/phone";
import { isPastMatch, matchStartMs } from "@/lib/matchTime";

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

  // Pull the thread row first — we need player_id, match_ambiguous,
  // and phone_number to drive the rest of this endpoint.
  const threadRes = await supabase
    .from("crm_threads")
    .select("id, phone_number, player_id, match_ambiguous")
    .eq("id", threadId)
    .maybeSingle();
  if (threadRes.error) {
    console.error("[crm:threads.context] db error", threadRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!threadRes.data) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  const thread = threadRes.data;

  // Player context — only if thread has a player_id.
  type PlayerContext = Record<string, unknown> & {
    email?: string | null;
    phone_number?: string | null;
  };
  let player: PlayerContext | null = null;
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
      // attended in the current calendar year (not cancelled, not
      // absent, match started before now). Surfaced as
      // "MATCHES (2026)" in the context panel.
      const played_in_2026 = await loadPlayed2026Count(
        supabase,
        thread.player_id as number,
      );
      player = { ...playerRes.data, played_in_2026 } as PlayerContext;
    }
  }

  // Membership lookup against the Retool-synced fin_members table.
  // Joins on player email (case-insensitive) OR phone (rightmost 10
  // digits, since fin_members.phone is E.164 with +1 prefix and the
  // cockpit-side phone may be stored without). Returns null when no
  // row matches — ContextPanel renders nothing in that case.
  const membership = await loadMembership(supabase, {
    email: player?.email ?? null,
    threadPhone: thread.phone_number as string | null,
    playerPhone: player?.phone_number ?? null,
  });

  // Recent matches (last 5). Two-step fetch because the
  // mdapi_match_players → mdapi_matches join is a "soft FK" (no
  // enforced constraint, see migration 0016), so PostgREST can't
  // embed.
  const recent_matches =
    thread.player_id != null
      ? await loadRecentMatches(supabase, thread.player_id as number)
      : [];

  // Upcoming bookings. Cancelled future bookings ARE included; the
  // UI de-emphasizes them so operators can see at a glance whether
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

  return Response.json(
    {
      player,
      membership,
      recent_matches,
      upcoming_matches,
      historical_account_count,
    },
    { status: 200 },
  );
}

// ============================================================
// Membership lookup (fin_members)
// ============================================================

type Membership = {
  member_id: string;
  status: string;
  canceled_at: string | null;
  cancel_reason: string | null;
};

async function loadMembership(
  supabase: SupabaseClient,
  args: {
    email: string | null;
    threadPhone: string | null;
    playerPhone: string | null;
  },
): Promise<Membership | null> {
  // Collect candidate predicates. Email gets a case-insensitive
  // equality match; phone gets a "ends-with-last-10-digits" match so
  // we tolerate the +1/national mismatch between fin_members (E.164)
  // and other cockpit phone surfaces.
  const orParts: string[] = [];
  if (args.email && args.email.trim().length > 0) {
    // ilike with no wildcards = case-insensitive equality. Email
    // values are unlikely to contain PostgREST's special characters
    // (comma, parens) — guard anyway by skipping any that do, since
    // those would need escaping for the .or() comma-separated form.
    const e = args.email.trim();
    if (!/[,()]/.test(e)) {
      orParts.push(`email.ilike.${e}`);
    }
  }
  const lastTen = (s: string | null) => {
    if (!s) return null;
    const digits = s.replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : null;
  };
  const phoneCandidates = new Set<string>();
  const t = lastTen(args.threadPhone);
  if (t) phoneCandidates.add(t);
  const p = lastTen(args.playerPhone);
  if (p) phoneCandidates.add(p);
  for (const last10 of phoneCandidates) {
    orParts.push(`phone.like.*${last10}`);
  }

  if (orParts.length === 0) return null;

  const res = await supabase
    .from("fin_members")
    .select("member_id, status, canceled_at, cancel_reason")
    .or(orParts.join(","))
    .limit(1)
    .maybeSingle();
  if (res.error) {
    console.error("[crm:threads.context] fin_members lookup failed", res.error);
    return null;
  }
  if (!res.data) return null;
  return {
    member_id: String(res.data.member_id ?? ""),
    status: String(res.data.status ?? ""),
    canceled_at:
      typeof res.data.canceled_at === "string" ? res.data.canceled_at : null,
    cancel_reason:
      typeof res.data.cancel_reason === "string"
        ? res.data.cancel_reason
        : null,
  };
}

async function countHistoricalAccounts(
  supabase: SupabaseClient,
  e164: string,
): Promise<number | null> {
  // Same two phone shapes the webhook matches on (E.164 and bare
  // 10-digit national). Sum the head counts. Doing two HEAD queries
  // is cheap because phone_number is indexed on mdapi_users; the
  // planner picks a btree on the equality predicate.
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
  start_date_utc: string | null;
  city_identifier: string | null;
  is_cancelled: boolean | null;
};

type RecentMatch = {
  match_api_id: number;
  venue: string | null;
  // Both start_date (mislabeled wall-clock-with-+00) and
  // start_date_utc (the genuine UTC value) are returned. The client
  // should prefer start_date_utc paired with city_identifier when
  // rendering match times in the venue's local zone.
  start_date: string | null;
  start_date_utc: string | null;
  city_identifier: string | null;
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
    .select(
      "api_id, field_title, field_address, start_date, start_date_utc, city_identifier, is_cancelled",
    )
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
      start_date_utc: m.start_date_utc,
      city_identifier: m.city_identifier,
      status: deriveMatchStatus(r, m, now),
    });
  }
  joined.sort((a, b) => {
    const at = matchStartMs(a.start_date_utc, a.start_date) ?? -Infinity;
    const bt = matchStartMs(b.start_date_utc, b.start_date) ?? -Infinity;
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
  // start_date_utc, not start_date. The latter is venue-local wall-clock
  // wearing a fake +00:00, so parsing it as an instant lands 4–5h early and
  // a match that kicks off tonight reads as already "Played" (or "No-show"
  // for an absent registration) from mid-afternoon onward.
  const isPast = isPastMatch(m.start_date_utc, m.start_date, now);
  if (r.is_absent === true && isPast) return "No-show";
  if (isPast) return "Played";
  return "Upcoming";
}

// ============================================================
// Upcoming matches helpers
// ============================================================

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
  start_date_utc: string | null;
  city_identifier: string | null;
  is_cancelled: boolean | null;
};

type UpcomingMatch = {
  match_api_id: number;
  venue: string | null;
  start_date: string | null;
  start_date_utc: string | null;
  city_identifier: string | null;
  team: number | null;
  player_number: number | null;
  is_cancelled: boolean;
};

async function loadUpcomingMatches(
  supabase: SupabaseClient,
  playerId: number,
): Promise<UpcomingMatch[]> {
  const nowIso = new Date().toISOString();

  const FUTURE_WINDOW_DAYS = 60;
  const cutoff = new Date(
    Date.now() + FUTURE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const matches = await supabase
    .from("mdapi_matches")
    .select(
      "api_id, field_title, start_date, start_date_utc, city_identifier, is_cancelled",
    )
    // Both bounds on start_date_utc — these are genuine instants
    // (now, now+60d). Filtering the wall-clock column against them
    // dropped every match starting within the next 4–5h, i.e. exactly
    // the imminent match a CRM conversation is most likely about.
    .gt("start_date_utc", nowIso)
    .lt("start_date_utc", cutoff)
    .order("start_date_utc", { ascending: true });
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

  const out: UpcomingMatch[] = [];
  for (const r of regs.data as UpcomingRegRow[]) {
    const m = matchById.get(r.match_api_id);
    if (!m) continue;
    out.push({
      match_api_id: m.api_id,
      venue: m.field_title,
      start_date: m.start_date,
      start_date_utc: m.start_date_utc,
      city_identifier: m.city_identifier,
      team: r.team,
      player_number: r.player_number,
      is_cancelled: r.is_cancelled === true || m.is_cancelled === true,
    });
  }

  out.sort((a, b) => {
    const at = matchStartMs(a.start_date_utc, a.start_date) ?? Infinity;
    const bt = matchStartMs(b.start_date_utc, b.start_date) ?? Infinity;
    return at - bt;
  });
  return out;
}

// ============================================================
// 2026-played count
// ============================================================

const YEAR = 2026;
const YEAR_START_ISO = `${YEAR}-01-01T00:00:00Z`;
const YEAR_END_ISO = `${YEAR + 1}-01-01T00:00:00Z`;

async function loadPlayed2026Count(
  supabase: SupabaseClient,
  playerId: number,
): Promise<number | null> {
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

  const nowIso = new Date().toISOString();
  const c = await supabase
    .from("mdapi_matches")
    .select("api_id", { count: "exact", head: true })
    .in("api_id", matchIds)
    // Year bounds stay on start_date: "played this YEAR" means the venue's
    // local calendar year, and wall-clock-vs-calendar-boundary is the
    // correct pairing. The already-happened check is a true-instant
    // question, so it uses start_date_utc. Mixing columns here is
    // deliberate — each comparison uses the column that matches its frame.
    .gte("start_date", YEAR_START_ISO)
    .lt("start_date", YEAR_END_ISO)
    .lt("start_date_utc", nowIso)
    .not("is_cancelled", "is", true);
  if (c.error) return null;
  return c.count ?? 0;
}
