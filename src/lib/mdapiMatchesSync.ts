// Sync /admin/matches + /admin/matches/{id}/players → mdapi_matches +
// mdapi_match_players. Server-only.
//
// Pipeline:
//   1. Authenticate via the Phase 1 MatchDay API helper.
//   2. Paginate /admin/matches with date-window query (fromDate/toDate).
//   3. Upsert match rows (column-rename + raw jsonb).
//   4. For each match, fetch /admin/matches/{id}/players (the list
//      endpoint embeds a TRUNCATED players array — cancelled/bumped
//      registrations are filtered out, so the dedicated endpoint is
//      required for the row-per-registration data the cockpit wants).
//   5. Upsert player rows in batches.
//   6. Per-match error isolation: a failed /players call captures the
//      error and continues; doesn't crash the whole sync.
//
// Endpoint contract (resolved 2026-05-06 from /api-docs-json):
//   - GET /admin/matches: page, limit, fromDate, toDate (YYYY-MM-DD),
//     sortColumn (id|name|startDate|registrationPrice|isCancelled|field),
//     sortDirection (asc|desc).
//   - Without explicit fromDate, API defaults to "current UTC date" —
//     ~recent matches only. Backfill MUST pass fromDate.
//   - Response: PaginatedResponseDto = { page, limit, totalItems,
//     data: Match[] }. totalItems is reliable (declared required).
//   - Deprecated params (do not use): startDateMin, startDateMax,
//     endDate.
//
// Conflict resolution: onConflict=api_id on both upserts. Last-write-
// wins; idempotent. Re-running after a crash is safe.
//
// Caller provides the Supabase client. Writes use service role for
// scripts (bypasses RLS); manual UI/API mode would use the user's
// session (RLS allows authenticated INSERT/UPDATE per migration 0016).

import type { SupabaseClient } from "@supabase/supabase-js";
import { getMatchdayApiClient, MatchdayApiError } from "./matchdayApi";

const PAGE_LIMIT = 100;
const UPSERT_BATCH = 500;

// ===== API row shapes (camelCase, source of truth from probe + spec) =====

type ApiManager = {
  id?: number;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

type ApiCity = {
  abbr?: string | null;
  name?: string | null;
};

type ApiField = {
  id?: number;
  title?: string | null;
  address?: string | null;
  // API returns zipcode as `number`. Stored as text for forward-compat.
  zipcode?: number | string | null;
  city?: ApiCity;
};

type ApiCount = {
  players?: number;
  fakePlayers?: number;
};

type ApiMatch = {
  id: number;
  fieldId?: number;
  field?: ApiField;
  managerId?: number | null;
  manager?: ApiManager;
  secondManagerId?: number | null;
  name?: string | null;
  description?: string | null;
  type?: string | null;
  category?: string | null;
  startDate?: string | null;
  startDateUtc?: string | null;
  endDate?: string | null;
  endDateUtc?: string | null;
  minPlayerCount?: number | null;
  maxPlayerCount?: number | null;
  registrationPrice?: number | null;
  additionalSpotPrice?: number | null;
  isFreeMember?: boolean | null;
  isAutoBump?: boolean | null;
  hasOrganizer?: boolean | null;
  maxTeamSize2Team?: number | null;
  maxTeamSize4Team?: number | null;
  guestCount?: number | null;
  isCancelled?: boolean | null;
  autoCanceled?: boolean | null;
  autoCanceledMinutes?: number | null;
  starRating?: number | null;
  starRatingCount?: number | null;
  _count?: ApiCount;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type ApiUser = {
  id?: number;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phoneNumber?: string | null;
  isMember?: boolean | null;
  isFakePlayer?: boolean | null;
};

type ApiPlayer = {
  id: number;
  matchId?: number;
  userId?: number;
  user?: ApiUser;
  paidStatus?: string | null;
  userType?: string | null;
  userStatus?: string | null;
  team?: number | null;
  playerNumber?: number | null;
  isReserved?: boolean | null;
  isFirstMatch?: boolean | null;
  isAbsent?: boolean | null;
  amount?: number | null;
  totalAmount?: number | null;
  creditAmount?: number | null;
  paymentIntentId?: string | null;
  refunded?: boolean | null;
  isMigratedStripePaymentIntent?: boolean | null;
  promocodeId?: number | null;
  isCancelled?: boolean | null;
  canceledAt?: string | null;
  cancelledBefore24Hours?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type MatchPage = {
  page?: number;
  limit?: number;
  totalItems?: number;
  data?: ApiMatch[];
};

// ===== DB row shapes (snake_case) =====

type MatchDbRow = {
  api_id: number;
  field_id: number;
  field_title: string | null;
  field_address: string | null;
  field_zipcode: string | null;
  city_identifier: string | null;
  city_name: string | null;
  manager_id: number | null;
  manager_email: string | null;
  manager_first_name: string | null;
  manager_last_name: string | null;
  second_manager_id: number | null;
  name: string | null;
  description: string | null;
  type: string | null;
  category: string | null;
  start_date: string | null;
  start_date_utc: string | null;
  end_date: string | null;
  end_date_utc: string | null;
  min_player_count: number | null;
  max_player_count: number | null;
  registration_price: number | null;
  additional_spot_price: number | null;
  is_free_member: boolean | null;
  is_auto_bump: boolean | null;
  has_organizer: boolean | null;
  max_team_size_2team: number | null;
  max_team_size_4team: number | null;
  guest_count: number | null;
  is_cancelled: boolean | null;
  auto_canceled: boolean | null;
  auto_canceled_minutes: number | null;
  star_rating: number | null;
  star_rating_count: number | null;
  player_count: number | null;
  fake_player_count: number | null;
  created_at: string | null;
  updated_at: string | null;
  raw: unknown;
  synced_at: string;
  // Cleared (null) on every upsert: a match the API returns is alive,
  // so a previously-tombstoned match that reappears is resurrected.
  deleted_at: string | null;
};

type PlayerDbRow = {
  api_id: number;
  match_api_id: number;
  user_id: number;
  user_email: string | null;
  user_first_name: string | null;
  user_last_name: string | null;
  user_phone_number: string | null;
  user_is_member: boolean | null;
  user_is_fake_player: boolean | null;
  paid_status: string | null;
  user_type: string | null;
  user_status: string | null;
  team: number | null;
  player_number: number | null;
  is_reserved: boolean | null;
  is_first_match: boolean | null;
  is_absent: boolean | null;
  amount: number | null;
  total_amount: number | null;
  credit_amount: number | null;
  payment_intent_id: string | null;
  refunded: boolean | null;
  is_migrated_stripe_pi: boolean | null;
  promocode_id: number | null;
  is_cancelled: boolean | null;
  canceled_at: string | null;
  cancelled_before_24h: boolean | null;
  created_at: string | null;
  updated_at: string | null;
  raw: unknown;
  synced_at: string;
};

// ===== Public API =====

export type MdapiMatchesSyncOptions = {
  // YYYY-MM-DD. If omitted, API defaults to "current UTC date" —
  // ~recent matches only. Backfill should always pass this.
  fromDate?: string;
  // YYYY-MM-DD. Optional upper bound. Daily incremental passes both.
  toDate?: string;
};

// Default window for daily incremental refresh: now - 14 days through
// now + 60 days (per design doc Section 3.4).
//   - 14 days back: past matches stable after that, no point re-fetching
//   - 60 days forward: catches all open registration windows + a buffer
// Shared between scripts/sync-mdapi-matches-incremental.ts and the
// cron orchestrator so the window is defined in exactly one place.
export function defaultIncrementalWindow(now: Date = new Date()): {
  fromDate: string;
  toDate: string;
} {
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    fromDate: ymd(new Date(now.getTime() - 14 * 86_400_000)),
    toDate: ymd(new Date(now.getTime() + 60 * 86_400_000)),
  };
}

export type MdapiMatchesSyncResult = {
  matchesFetched: number; // pre-upsert; matches the API list response
  matchesUpserted: number;
  playersFetched: number; // total players across all match-rosters
  playersUpserted: number;
  pages: number;
  apiCalls: number;
  // Per-match errors (matchId → message). Don't crash the sync; the
  // affected match's player roster stays stale (or empty on first
  // backfill) until a re-run.
  perMatchErrors: Record<string, string>;
  // Rows tombstoned (deleted_at set) this run because they went unseen
  // upstream for >=2 consecutive runs. 0 unless a bounded incremental
  // window ran and the sanity guards passed.
  rowsSoftDeleted: number;
  durationMs: number;
};

export async function syncMdapiMatches(
  supabase: SupabaseClient,
  opts: MdapiMatchesSyncOptions = {},
): Promise<MdapiMatchesSyncResult> {
  const startedAt = Date.now();
  const client = getMatchdayApiClient();

  // === 1. Paginate /admin/matches ===
  const matches: ApiMatch[] = [];
  let pages = 0;
  let apiCalls = 0;
  for (let page = 1; ; page++) {
    const query: Record<string, string | number> = {
      page,
      limit: PAGE_LIMIT,
      sortColumn: "startDate",
      sortDirection: "asc",
    };
    if (opts.fromDate) query.fromDate = opts.fromDate;
    if (opts.toDate) query.toDate = opts.toDate;

    let res: MatchPage;
    try {
      res = await client.get<MatchPage>("/admin/matches", query);
    } catch (e) {
      if (e instanceof MatchdayApiError) {
        throw new Error(
          `mdapi_matches list failed on page ${page} (HTTP ${e.status}): ${e.message}`,
        );
      }
      throw e;
    }
    apiCalls++;
    pages++;
    const rows = Array.isArray(res?.data) ? res.data : [];
    matches.push(...rows);

    // Three-way termination — any signals "we're done":
    if (rows.length === 0) break;
    if (rows.length < PAGE_LIMIT) break;
    if (
      typeof res.totalItems === "number" &&
      matches.length >= res.totalItems
    ) {
      break;
    }
  }

  // === 2. Upsert match rows ===
  const syncedAt = new Date().toISOString();
  const matchRows: MatchDbRow[] = [];
  for (const m of matches) {
    if (typeof m.id !== "number" || typeof m.fieldId !== "number") continue;
    matchRows.push(mapMatchToRow(m, syncedAt));
  }

  let matchesUpserted = 0;
  for (let i = 0; i < matchRows.length; i += UPSERT_BATCH) {
    const chunk = matchRows.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase
      .from("mdapi_matches")
      .upsert(chunk, { onConflict: "api_id" });
    if (error) {
      throw new Error(
        `mdapi_matches upsert failed at offset ${i}: ${error.message}`,
      );
    }
    matchesUpserted += chunk.length;
  }

  // === 3. Per-match: fetch /players and accumulate ===
  const allPlayerRows: PlayerDbRow[] = [];
  const perMatchErrors: Record<string, string> = {};
  let playersFetched = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (typeof match.id !== "number") continue;

    let players: ApiPlayer[];
    try {
      players = await client.get<ApiPlayer[]>(
        `/admin/matches/${match.id}/players`,
      );
      apiCalls++;
    } catch (e) {
      const msg =
        e instanceof MatchdayApiError
          ? `HTTP ${e.status}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      perMatchErrors[String(match.id)] = msg;
      continue;
    }
    if (!Array.isArray(players)) continue;
    playersFetched += players.length;

    for (const p of players) {
      if (typeof p.id !== "number" || typeof p.userId !== "number") continue;
      allPlayerRows.push(mapPlayerToRow(p, match.id, syncedAt));
    }

    // Periodic progress log so the operator knows it's not stuck on
    // long-running backfills.
    if ((i + 1) % 100 === 0) {
      console.log(
        `... ${i + 1}/${matches.length} matches processed (${allPlayerRows.length.toLocaleString()} players collected)`,
      );
    }
  }

  // === 4. Upsert player rows ===
  let playersUpserted = 0;
  for (let i = 0; i < allPlayerRows.length; i += UPSERT_BATCH) {
    const chunk = allPlayerRows.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase
      .from("mdapi_match_players")
      .upsert(chunk, { onConflict: "api_id" });
    if (error) {
      throw new Error(
        `mdapi_match_players upsert failed at offset ${i}: ${error.message}`,
      );
    }
    playersUpserted += chunk.length;
  }

  // === 5. Tombstone pass: soft-delete phantoms (deleted upstream) ===
  // Only for bounded incremental windows (both dates set). Backfill
  // (fromDate only) spans an unbounded forward range; tombstoning there
  // could wrongly delete future matches the run didn't page deep enough
  // to reach.
  let rowsSoftDeleted = 0;
  if (opts.fromDate && opts.toDate) {
    rowsSoftDeleted = await tombstoneMissing(supabase, {
      fromDate: opts.fromDate,
      toDate: opts.toDate,
      thisRunStartIso: new Date(startedAt).toISOString(),
      thisRunRowCount: matchesUpserted + playersUpserted,
    });
    // Same pass for player rows: a registration dropped from a match's
    // roster upstream is upsert-only here too, so it lingers as a phantom.
    // Folded into the same rows_soft_deleted counter. Matches whose player
    // fetch errored this run are excluded so a transient upstream failure
    // can't tombstone a live roster.
    rowsSoftDeleted += await tombstonePlayersMissing(supabase, {
      fromDate: opts.fromDate,
      toDate: opts.toDate,
      thisRunStartIso: new Date(startedAt).toISOString(),
      thisRunRowCount: matchesUpserted + playersUpserted,
      erroredMatchIds: new Set(Object.keys(perMatchErrors).map(Number)),
    });
  }

  return {
    matchesFetched: matches.length,
    matchesUpserted,
    playersFetched,
    playersUpserted,
    pages,
    apiCalls,
    perMatchErrors,
    rowsSoftDeleted,
    durationMs: Date.now() - startedAt,
  };
}

// Soft-delete mdapi_matches rows inside [fromDate, toDate] that this run
// did not see, with a 2-run cooldown and an 80%-row-count sanity guard.
//
// Cooldown: the cutoff is the PREVIOUS run's start time. Live rows the
// API returned this run were just upserted with a fresh synced_at (>
// cutoff) and deleted_at cleared, so they never match. A row last seen
// in the previous run (synced_at > cutoff) is spared — it has missed
// only this run, which a single flaky upstream response could explain.
// Only a row last seen two-or-more runs ago (synced_at < cutoff) is
// tombstoned. Resurrection is automatic: if a tombstoned match later
// reappears upstream, its next upsert clears deleted_at.
async function tombstoneMissing(
  supabase: SupabaseClient,
  args: {
    fromDate: string;
    toDate: string;
    thisRunStartIso: string;
    thisRunRowCount: number;
  },
): Promise<number> {
  const { fromDate, toDate, thisRunStartIso, thisRunRowCount } = args;

  // Prior SUCCESSFUL mdapi-matches runs strictly before this one,
  // newest first. completed_at NOT NULL + error_message NULL excludes
  // (a) this run's own in-progress log row, which runWithLog inserts
  // before calling the sync, and (b) crashed runs that never refreshed
  // synced_at — counting those would prematurely tombstone live rows.
  const { data: prior, error: priorErr } = await supabase
    .from("fin_sync_log")
    .select("started_at, rows_imported")
    .eq("source", "mdapi-matches")
    .lt("started_at", thisRunStartIso)
    .not("completed_at", "is", null)
    .is("error_message", null)
    .order("started_at", { ascending: false })
    .limit(2);
  if (priorErr) {
    console.warn(
      `[mdapi-matches] tombstone skipped: prior-run lookup failed: ${priorErr.message}`,
    );
    return 0;
  }
  const prevRun = prior?.[0];
  if (!prevRun?.started_at) {
    console.log(
      "[mdapi-matches] tombstone skipped: no prior run to anchor the cooldown",
    );
    return 0;
  }

  // Row-count sanity guard: a partial/flaky run that returned far fewer
  // rows than usual must not tombstone live matches. Compare against the
  // most recent prior run that recorded a count.
  const baseline = prior.find(
    (r) => typeof r.rows_imported === "number",
  )?.rows_imported;
  if (
    typeof baseline === "number" &&
    baseline > 0 &&
    thisRunRowCount < 0.8 * baseline
  ) {
    console.warn(
      `[mdapi-matches] tombstone skipped: this run rows=${thisRunRowCount} < 80% of prior ${baseline}`,
    );
    return 0;
  }

  const cutoff = prevRun.started_at;
  const { data: tombstoned, error: updErr } = await supabase
    .from("mdapi_matches")
    .update({ deleted_at: new Date().toISOString() })
    .is("deleted_at", null)
    .lt("synced_at", cutoff)
    .gte("start_date", `${fromDate}T00:00:00Z`)
    .lte("start_date", `${toDate}T23:59:59Z`)
    .select("api_id");
  if (updErr) {
    console.warn(`[mdapi-matches] tombstone update failed: ${updErr.message}`);
    return 0;
  }
  const n = tombstoned?.length ?? 0;
  if (n > 0) {
    console.log(
      `[mdapi-matches] soft-deleted ${n} phantom row(s) in ${fromDate}..${toDate} (synced before ${cutoff})`,
    );
  }
  return n;
}

// Soft-delete mdapi_match_players rows whose match falls inside
// [fromDate, toDate] that this run did not refresh — the player-row
// analogue of tombstoneMissing. Mirrors it exactly: cooldown cutoff is
// the previous successful run's start (a row must miss >=2 runs), and the
// same 80% row-count sanity guard skips a partial run. Players carry no
// start_date, so the window is resolved through their match_api_id.
//
// One extra guard the matches pass doesn't need: players are fetched with
// a per-match API call, so a single match's fetch can fail in isolation.
// erroredMatchIds (this run's perMatchErrors) are excluded so a transient
// roster-fetch failure never tombstones a live roster — the 2-run cooldown
// already covers a one-run miss, this hardens the consecutive-failure case.
async function tombstonePlayersMissing(
  supabase: SupabaseClient,
  args: {
    fromDate: string;
    toDate: string;
    thisRunStartIso: string;
    thisRunRowCount: number;
    erroredMatchIds: Set<number>;
  },
): Promise<number> {
  const { fromDate, toDate, thisRunStartIso, thisRunRowCount, erroredMatchIds } =
    args;

  const { data: prior, error: priorErr } = await supabase
    .from("fin_sync_log")
    .select("started_at, rows_imported")
    .eq("source", "mdapi-matches")
    .lt("started_at", thisRunStartIso)
    .not("completed_at", "is", null)
    .is("error_message", null)
    .order("started_at", { ascending: false })
    .limit(2);
  if (priorErr) {
    console.warn(
      `[mdapi-players] tombstone skipped: prior-run lookup failed: ${priorErr.message}`,
    );
    return 0;
  }
  const prevRun = prior?.[0];
  if (!prevRun?.started_at) {
    console.log(
      "[mdapi-players] tombstone skipped: no prior run to anchor the cooldown",
    );
    return 0;
  }

  const baseline = prior.find(
    (r) => typeof r.rows_imported === "number",
  )?.rows_imported;
  if (
    typeof baseline === "number" &&
    baseline > 0 &&
    thisRunRowCount < 0.8 * baseline
  ) {
    console.warn(
      `[mdapi-players] tombstone skipped: this run rows=${thisRunRowCount} < 80% of prior ${baseline}`,
    );
    return 0;
  }

  const cutoff = prevRun.started_at;

  // Match ids inside the covered window, minus any whose roster we failed
  // to fetch this run.
  const matchIds: number[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("mdapi_matches")
      .select("api_id")
      .gte("start_date", `${fromDate}T00:00:00Z`)
      .lte("start_date", `${toDate}T23:59:59Z`)
      .order("api_id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.warn(
        `[mdapi-players] tombstone skipped: window match lookup failed: ${error.message}`,
      );
      return 0;
    }
    const rows = (data ?? []) as { api_id: number }[];
    for (const r of rows) {
      if (!erroredMatchIds.has(r.api_id)) matchIds.push(r.api_id);
    }
    if (rows.length < 1000) break;
  }
  if (matchIds.length === 0) return 0;

  // Chunk the IN() list to keep URLs under PostgREST's practical limit.
  let n = 0;
  const CHUNK = 200;
  for (let from = 0; from < matchIds.length; from += CHUNK) {
    const chunk = matchIds.slice(from, from + CHUNK);
    const { data: tombstoned, error: updErr } = await supabase
      .from("mdapi_match_players")
      .update({ deleted_at: new Date().toISOString() })
      .is("deleted_at", null)
      .lt("synced_at", cutoff)
      .in("match_api_id", chunk)
      .select("api_id");
    if (updErr) {
      console.warn(`[mdapi-players] tombstone update failed: ${updErr.message}`);
      return n;
    }
    n += tombstoned?.length ?? 0;
  }
  if (n > 0) {
    console.log(
      `[mdapi-players] soft-deleted ${n} phantom player row(s) in ${fromDate}..${toDate} (synced before ${cutoff})`,
    );
  }
  return n;
}

// ===== Mappers =====

function mapMatchToRow(m: ApiMatch, syncedAt: string): MatchDbRow {
  return {
    api_id: m.id,
    field_id: m.fieldId as number,
    field_title: m.field?.title ?? null,
    field_address: m.field?.address ?? null,
    field_zipcode: m.field?.zipcode != null ? String(m.field.zipcode) : null,
    city_identifier: m.field?.city?.abbr ?? null,
    city_name: m.field?.city?.name ?? null,
    manager_id: m.managerId ?? null,
    manager_email: m.manager?.email ?? null,
    manager_first_name: m.manager?.firstName ?? null,
    manager_last_name: m.manager?.lastName ?? null,
    second_manager_id: m.secondManagerId ?? null,
    name: m.name ?? null,
    description: m.description ?? null,
    type: m.type ?? null,
    category: m.category ?? null,
    start_date: m.startDate ?? null,
    start_date_utc: m.startDateUtc ?? null,
    end_date: m.endDate ?? null,
    end_date_utc: m.endDateUtc ?? null,
    min_player_count: m.minPlayerCount ?? null,
    max_player_count: m.maxPlayerCount ?? null,
    registration_price: m.registrationPrice ?? null,
    additional_spot_price: m.additionalSpotPrice ?? null,
    is_free_member: m.isFreeMember ?? null,
    is_auto_bump: m.isAutoBump ?? null,
    has_organizer: m.hasOrganizer ?? null,
    max_team_size_2team: m.maxTeamSize2Team ?? null,
    max_team_size_4team: m.maxTeamSize4Team ?? null,
    guest_count: m.guestCount ?? null,
    is_cancelled: m.isCancelled ?? null,
    auto_canceled: m.autoCanceled ?? null,
    auto_canceled_minutes: m.autoCanceledMinutes ?? null,
    star_rating: m.starRating ?? null,
    star_rating_count: m.starRatingCount ?? null,
    player_count: m._count?.players ?? null,
    fake_player_count: m._count?.fakePlayers ?? null,
    created_at: m.createdAt ?? null,
    updated_at: m.updatedAt ?? null,
    raw: m,
    synced_at: syncedAt,
    // The API returned this match, so it is alive — clear any prior
    // tombstone (resurrection on re-appearance upstream).
    deleted_at: null,
  };
}

function mapPlayerToRow(
  p: ApiPlayer,
  matchId: number,
  syncedAt: string,
): PlayerDbRow {
  return {
    api_id: p.id,
    match_api_id: matchId,
    user_id: p.userId as number,
    user_email: p.user?.email ?? null,
    user_first_name: p.user?.firstName ?? null,
    user_last_name: p.user?.lastName ?? null,
    user_phone_number: p.user?.phoneNumber ?? null,
    user_is_member: p.user?.isMember ?? null,
    user_is_fake_player: p.user?.isFakePlayer ?? null,
    paid_status: p.paidStatus ?? null,
    user_type: p.userType ?? null,
    user_status: p.userStatus ?? null,
    team: p.team ?? null,
    player_number: p.playerNumber ?? null,
    is_reserved: p.isReserved ?? null,
    is_first_match: p.isFirstMatch ?? null,
    is_absent: p.isAbsent ?? null,
    amount: p.amount ?? null,
    total_amount: p.totalAmount ?? null,
    credit_amount: p.creditAmount ?? null,
    payment_intent_id: p.paymentIntentId ?? null,
    refunded: p.refunded ?? null,
    is_migrated_stripe_pi: p.isMigratedStripePaymentIntent ?? null,
    promocode_id: p.promocodeId ?? null,
    is_cancelled: p.isCancelled ?? null,
    canceled_at: p.canceledAt ?? null,
    cancelled_before_24h: p.cancelledBefore24Hours ?? null,
    created_at: p.createdAt ?? null,
    updated_at: p.updatedAt ?? null,
    raw: p,
    synced_at: syncedAt,
  };
}
