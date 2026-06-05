// Shared read layer for mdapi_matches + mdapi_match_players. Used by
// useMatchData (the central hook) and 5 secondary readers
// (matchPnL, projectionsStats, partnerStats, PartnerDetailAdmin,
// membershipSnapshots). Replaces the CSV-era `match_registrations`
// table reads — same predicate logic, different data source.
//
// === Two output shapes ===
//
// 1. JoinedMatchPlayerRow: canonical, camelCase, parsed dates.
//    Used by useMatchData via re-exported MatchRow alias.
//
// 2. LegacyMatchRegRow (via toLegacyShape adapter): snake_case,
//    string timestamps, nullable field. Drop-in for secondary
//    readers whose internal logic still expects the CSV-era row
//    shape — minimizes blast radius for the cutover. Each consumer
//    can migrate to JoinedMatchPlayerRow incrementally later.
//
// === Predicates (resolved Phase 5b) ===
//
// - "MEMBER spot"     ← paid_status === "FREE"
// - "PROMOCODE spot"  ← paid_status === "PAID" && promocode_id IS NOT NULL
// - "DAILY PAID spot" ← paid_status === "PAID" && promocode_id IS NULL
// - "WAITING"         ← row dropped (not yet a real spot — payment pending)
//
// Filter parity with the CSV path: WAITING rows excluded, unknown
// cities excluded (cityFromAbbr → null), unparseable match dates
// excluded.

import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { cityFromAbbr } from "./cityMap";
import { normField } from "./normField";
import { isFakePlayerRow } from "./mdapiFakePlayer";

const MATCHES_COLS =
  "api_id, city_identifier, field_id, field_title, start_date, is_cancelled, max_player_count";
const PLAYERS_COLS =
  "api_id, match_api_id, user_id, user_email, user_type, paid_status, promocode_id, is_cancelled, canceled_at, amount, credit_amount, created_at, is_absent, user_is_fake_player";

// chunk size for .in("match_api_id", chunk) — keeps URL length under
// PostgREST's ~2KB practical limit (200 ids × ~7 chars = ~1.4KB).
const IN_CHUNK = 200;

// Max in-flight chunk requests when fan-out is parallel (filtered path
// in fetchJoinedMatchPlayers). 4 keeps us well under any plausible
// PostgREST/PgBouncer concurrency budget while still capturing most of
// the wall-clock win versus the old sequential loop.
const CHUNK_CONCURRENCY = 4;

// Minimal worker-pool fan-out. Caps concurrency at `limit` and rejects
// on the first failure (matching the sequential loop's behavior — caller
// gets a clean single error, no partial data). In-flight requests after
// the first failure can't be cancelled (no AbortController plumbed
// through supabase-js here), but their resolutions are discarded once
// Promise.all rejects, so callers never observe them.
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

// ===== Raw selects from the new tables =====

type MatchSelect = {
  api_id: number;
  city_identifier: string | null;
  field_id: number | null;
  field_title: string | null;
  start_date: string | null;
  is_cancelled: boolean | null;
  max_player_count: number | null;
};

type PlayerSelect = {
  api_id: number;
  match_api_id: number;
  user_id: number;
  user_email: string | null;
  user_type: string | null;
  paid_status: string | null;
  promocode_id: number | null;
  is_cancelled: boolean | null;
  canceled_at: string | null;
  amount: number | null;
  credit_amount: number | null;
  created_at: string | null;
  is_absent: boolean | null;
  user_is_fake_player: boolean | null;
};

// ===== Public output shapes =====

// Canonical post-mapping shape. Camel-cased, dates parsed.
// Superset of MatchRow — re-exported as MatchRow for backward-compat.
export type JoinedMatchPlayerRow = {
  // === MatchRow fields (preserve shape so 13 useMatchData consumers
  //     don't need to change) ===
  city: string;
  field: string;
  matchStart: Date;
  matchCanceled: boolean;
  playerCanceledAt: Date | null;
  paymentType: string | null;
  promocode: string | null;
  email: string | null;
  // === Extras for matchPnL / projections / partner / snapshots ===
  matchApiId: number;
  // mdapi field_id — the canonical numeric venue id, populated since
  // migration 0016. Threaded through here so PR-E's Finance read paths
  // can join via fin_venue_fields instead of normalizing field_title
  // through alias tables.
  fieldId: number | null;
  // Match capacity (mdapi_matches.max_player_count). The "tournament"
  // signal: ≥ TOURNAMENT_THRESHOLD (25) matches are paid at the higher
  // manager rate. Carried through so the partner per-match-minus-manager
  // revenue model can reconcile its manager-pay subtraction with the
  // actual manager payout (managerPayCompute.ts uses the same column).
  maxPlayerCount: number | null;
  playerApiId: number;
  userId: number;
  matchPricePaid: number; // amount in dollars
  // Portion of matchPricePaid funded by the player's MatchDay credit
  // balance (cents in the API; converted to dollars at read time).
  // Always <= matchPricePaid. Cash paid = matchPricePaid - creditPaid.
  creditPaid: number;
  registrationAt: Date | null;
  // Raw API user_type. "PLAYER" = registered platform user, "GUEST"
  // = guest brought by a player, occasionally null/other for legacy
  // rows. Carried through so partner stats can count guests/MD
  // registrations directly from this field instead of inferring
  // them from (user_id, match_start) duplicate grouping.
  userType: string | null;
};

// MatchRow is the legacy hook output type. Identical to a Pick of
// JoinedMatchPlayerRow over its first 8 fields. Re-exported from
// useMatchData so existing imports don't change.
export type MatchRow = Pick<
  JoinedMatchPlayerRow,
  | "city"
  | "field"
  | "matchStart"
  | "matchCanceled"
  | "playerCanceledAt"
  | "paymentType"
  | "promocode"
  | "email"
>;

// Per-match shape — one row per distinct scheduled match (not per
// player). Includes matches with zero player bookings so any
// run-rate / cancellation / scheduled-count aggregator can derive
// the *real* denominator instead of "matches with at least one
// player," which is what falls out of the player-join.
//
// `field` is normField'd and `city` is cityFromAbbr'd to match
// JoinedMatchPlayerRow's normalization — that way the dedup key
// `(matchStart.getTime(), field)` reconciles across the two arrays.
export type ScheduledMatch = {
  city: string;
  field: string;
  matchStart: Date;
  matchCanceled: boolean;
};

// New return shape for fetchJoinedMatchPlayers. `rows` is the legacy
// per-player output, unchanged. `scheduledMatches` is the per-match
// view, complete (incl. empty matches) within the query window.
export type MatchDataset = {
  rows: JoinedMatchPlayerRow[];
  scheduledMatches: ScheduledMatch[];
};

// Drop-in shape for secondary readers that previously did
// `from("match_registrations").select("user_id, email, field, ...")`.
// All fields snake_case; timestamps as strings. Internal consumer
// logic (matchPnL's bucket builder, partnerStats' isStaff/isCanceled
// filters, etc.) operates on this shape unchanged.
export type LegacyMatchRegRow = {
  user_id: string;
  email: string | null;
  field: string;
  field_id: number | null;
  // Stable per-match identity (mdapi_matches.api_id). Carried so
  // consumers can group player rows into distinct matches without
  // colliding on (match_start, field) — two matches can share an
  // identical start timestamp at the same field.
  match_api_id: number;
  // Match capacity. See JoinedMatchPlayerRow.maxPlayerCount.
  max_player_count: number | null;
  match_start: string;
  match_canceled: boolean;
  player_canceled_at: string | null;
  payment_type: string | null;
  promocode: string | null;
  match_price_paid: number;
  // Dollars; portion of match_price_paid funded via player credit
  // balance. See JoinedMatchPlayerRow.creditPaid for the source.
  credit_paid: number;
  user_type: string | null;
};

// ===== Helpers =====

// Wall-clock parse: same approach as the legacy useMatchData hook.
// Slices the first 16 chars (YYYY-MM-DDTHH:MM) and treats them as
// LOCAL time, ignoring any timezone offset. Matches the cockpit's
// platform-storage convention.
function parseLocal(s: string | null | undefined): Date | null {
  if (!s) return null;
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 5) return null;
  const [yr, mo, dy, hr, mn] = parts.map(Number);
  if ([yr, mo, dy, hr, mn].some((n) => Number.isNaN(n))) return null;
  return new Date(yr, mo - 1, dy, hr, mn);
}

// Wall-clock ISO. Round-trip-safe with parseLocal (slice first 16
// gives back the same components). Used by toLegacyShape so consumer
// code that calls parseLocalTimestamp on these strings still works.
function dateToLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

// Active-subscription record used to decide whether a paid_status=FREE
// row is a real member vs a non-member free spot (first-match-free
// signup, guest pass, manager-added fill). Strings are raw ISO from
// mdapi_subscriptions — compared lexicographically against the
// match's ISO start_date, which is correct for any consistent ISO
// format (date-only or full timestamp).
export type ActiveSubscription = {
  activation_date: string;
  canceled_at: string | null;
};

export type ActiveSubscriptionsByEmail = Map<string, ActiveSubscription[]>;

// Load every status=ACTIVE subscription, keyed by lowercased-trimmed
// email. Returns a multimap because the same email can hold multiple
// historical subscriptions (cancel + resubscribe). Callers ask
// "did any of this email's subs cover the match timestamp?".
//
// Reads mdapi_subscriptions unfiltered by city — Phase 3b's
// city-filtered FinMember mapping silently drops subs in unmapped
// cities (e.g., Phoenix), which would misclassify those members'
// FREE spots as FREE_NON_MEMBER.
export async function loadActiveSubscriptionsByEmail(
  supabase: SupabaseClient,
): Promise<ActiveSubscriptionsByEmail> {
  const rows = await selectAll<{
    member_email: string | null;
    activation_date: string | null;
    canceled_at: string | null;
  }>(() =>
    supabase
      .from("mdapi_subscriptions")
      .select("member_email, activation_date, canceled_at")
      .eq("status", "ACTIVE")
      .order("membership_id"),
  );
  const map: ActiveSubscriptionsByEmail = new Map();
  for (const r of rows) {
    if (!r.member_email || !r.activation_date) continue;
    const key = r.member_email.toLowerCase().trim();
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push({
      activation_date: r.activation_date,
      canceled_at: r.canceled_at,
    });
    map.set(key, list);
  }
  return map;
}

// True if at least one ACTIVE subscription for this email was
// activated on or before matchStartIso AND was not yet canceled at
// matchStartIso. Cancel-window semantics: a cancellation strictly
// after the match means the member was still active at match time.
//
// Exported so consumers (matchPnL.ts) can independently mark
// paid-status='PAID' rows whose email has an active subscription as
// member spots — those rows are correctly classified DAILY PAID by
// derivePaymentType (since paid_status is PAID, not FREE) but still
// represent a member's attendance for the per-row Member Spots
// column.
export function hasActiveSubAtMatchTime(
  email: string | null,
  matchStartIso: string,
  subs: ActiveSubscriptionsByEmail,
): boolean {
  if (!email) return false;
  const key = email.toLowerCase().trim();
  if (!key) return false;
  const list = subs.get(key);
  if (!list) return false;
  for (const s of list) {
    if (s.activation_date > matchStartIso) continue;
    if (s.canceled_at && s.canceled_at <= matchStartIso) continue;
    return true;
  }
  return false;
}

// Derive the cockpit's payment-type string from paid_status +
// promocode_id, with FREE further split by subscription join:
//   paid_status='FREE' + active sub at match time   → MEMBER
//   paid_status='FREE' + no active sub              → FREE_NON_MEMBER
//   paid_status='PAID' + promocode_id               → PROMOCODE
//   paid_status='PAID' (no promo)                   → DAILY PAID
//   paid_status='WAITING' / other                   → null
//
// When `subscriptionsByEmail` is undefined, falls back to the legacy
// `FREE → MEMBER` behavior so consumers that haven't migrated to the
// join-based classifier (e.g., useMatchData, PartnerDetailAdmin)
// retain prior semantics. Pass the map from `loadActiveSubscriptions
// ByEmail` to opt into the new, accurate classification.
function derivePaymentType(
  p: PlayerSelect,
  matchStartIso: string,
  subscriptionsByEmail?: ActiveSubscriptionsByEmail,
): string | null {
  if (p.paid_status === "FREE") {
    if (!subscriptionsByEmail) return "MEMBER";
    return hasActiveSubAtMatchTime(p.user_email, matchStartIso, subscriptionsByEmail)
      ? "MEMBER"
      : "FREE_NON_MEMBER";
  }
  if (p.paid_status === "PAID") {
    return p.promocode_id != null ? "PROMOCODE" : "DAILY PAID";
  }
  return null;
}

// Map a (match, player) pair to a JoinedMatchPlayerRow. Returns null
// if the row should be dropped:
//   - paid_status === "WAITING" (incomplete payment, not yet a spot)
//   - city_identifier doesn't map to a cockpit city
//   - start_date doesn't parse
//
// promocodeMap resolves promocode_id → code text (sourced from
// mdapi_promocodes). Falls back to String(id) if the id isn't in the
// map — preserves the "did this player use a promo?" boolean signal
// downstream consumers rely on (e.g., the High Promo Usage insight),
// even if the specific promocode hasn't synced yet or was hard-deleted.
function mapJoinedRow(
  match: MatchSelect,
  player: PlayerSelect,
  promocodeMap: Map<number, string>,
  subscriptionsByEmail?: ActiveSubscriptionsByEmail,
): JoinedMatchPlayerRow | null {
  if (player.paid_status === "WAITING") return null;
  // Fake player: synthetic fill placeholder (dummy roster slot
  // used when a host needs a body for headcount but no real person
  // showed up). is_absent: registered + paid but didn't physically
  // show up. Both inflate spot-count metrics; drop at the mapper so
  // every downstream consumer (Match P&L, partner stats, projections,
  // partner detail) gets honest counts.
  //
  // Detection via isFakePlayerRow combines the platform's boolean
  // flag with an anchored @matchday.com email check — defense-in-
  // depth against the API's sparse use of the boolean. Safe against
  // @playmatchday.com staff emails (which are real, not fakes).
  if (isFakePlayerRow(player)) return null;
  if (player.is_absent === true) return null;
  const city = cityFromAbbr(match.city_identifier);
  if (!city) return null;
  const matchStart = parseLocal(match.start_date);
  if (!matchStart) return null;

  let promocode: string | null = null;
  if (player.promocode_id != null) {
    promocode =
      promocodeMap.get(player.promocode_id) ?? String(player.promocode_id);
  }

  return {
    city,
    field: normField(match.field_title ?? ""),
    matchStart,
    matchCanceled: !!match.is_cancelled,
    playerCanceledAt: parseLocal(player.canceled_at),
    paymentType: derivePaymentType(
      player,
      match.start_date ?? "",
      subscriptionsByEmail,
    ),
    promocode,
    email: player.user_email?.toLowerCase() ?? null,
    matchApiId: match.api_id,
    fieldId: match.field_id,
    maxPlayerCount: match.max_player_count,
    playerApiId: player.api_id,
    userId: player.user_id,
    // API stores `amount` in cents (Stripe convention). Single
    // conversion site — fixes Match P&L, partner stats, projections,
    // and partner detail in one shot. Any consumer of matchPricePaid
    // (or the snake_case match_price_paid via toLegacyShape) gets
    // dollars by default. Matches the Phase 3b convention: read-time
    // conversion, don't transform on ingest.
    matchPricePaid: (player.amount ?? 0) / 100,
    creditPaid: (player.credit_amount ?? 0) / 100,
    registrationAt: parseLocal(player.created_at),
    userType: player.user_type,
  };
}

// Look up promocode codes for a set of ids. Chunked to keep URL
// length under PostgREST's ~2KB practical limit (200 ids × ~7 chars
// = ~1.4KB). Returns Map<api_id, code>; missing entries fall back to
// String(id) at the call site.
async function fetchPromocodeCodes(
  supabase: SupabaseClient,
  ids: Set<number>,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.size === 0) return out;
  const list = [...ids];
  const CHUNK = 200;
  for (let from = 0; from < list.length; from += CHUNK) {
    const chunk = list.slice(from, from + CHUNK);
    const { data, error } = await supabase
      .from("mdapi_promocodes")
      .select("api_id, code")
      .in("api_id", chunk);
    if (error) {
      throw new Error(`mdapi_promocodes lookup failed: ${error.message}`);
    }
    for (const r of (data ?? []) as { api_id: number; code: string }[]) {
      out.set(r.api_id, r.code);
    }
  }
  return out;
}

// Adapter: JoinedMatchPlayerRow → LegacyMatchRegRow. For consumers
// whose internal logic operates on the snake_case CSV-era shape.
export function toLegacyShape(r: JoinedMatchPlayerRow): LegacyMatchRegRow {
  return {
    user_id: String(r.userId),
    email: r.email,
    field: r.field,
    field_id: r.fieldId,
    match_api_id: r.matchApiId,
    max_player_count: r.maxPlayerCount,
    match_start: dateToLocalIso(r.matchStart),
    match_canceled: r.matchCanceled,
    player_canceled_at: r.playerCanceledAt
      ? dateToLocalIso(r.playerCanceledAt)
      : null,
    payment_type: r.paymentType,
    promocode: r.promocode,
    match_price_paid: r.matchPricePaid,
    credit_paid: r.creditPaid,
    user_type: r.userType,
  };
}

// ===== Public fetch =====

export type FetchJoinedOpts = {
  // YYYY-MM-DD bound on mdapi_matches.start_date (inclusive). Both
  // optional. Pass at least one for windowed reads (matchPnL,
  // projectionsStats); omit both for full-population reads
  // (useMatchData, membershipSnapshots).
  fromDate?: string;
  toDate?: string;
  // ILIKE pattern on mdapi_matches.field_title. e.g. "%PRUMC%"
  // for partner views.
  fieldLike?: string;
  // Exact match on mdapi_matches.city_identifier (e.g. "ATX").
  // Drives the per-city detail-page payload reduction — Austin
  // alone is ~40% of network volume; STL/ATL are ~5% each. With
  // a city filter, the player IN-list shrinks proportionally
  // (typically 1-5 chunks instead of 11), and the upstream byte
  // count drops by 50-96% depending on the city.
  cityIdentifier?: string;
};

// Fetch matches in scope, then their players, joined and mapped.
//
// Performance:
// - Full population (no filter): ~2k matches + ~38k players paginated
//   1k/page → ~40 round trips, ~5–15s on a healthy connection.
// - Single-week window: ~50 matches + ~1k players → 1–2 round trips,
//   sub-second.
// - Single-venue partner view: ~50 matches × ~15 players → ~750
//   players in 1 round trip.
//
// Why two paths (with-filter vs without):
// - Without filter, we fetch all matches AND all players, in-memory
//   join. Avoids the chunked .in() complexity. Players whose
//   match_api_id doesn't appear in the matches map get dropped.
// - With filter, we collect match ids first, then chunk-fetch
//   players via .in("match_api_id", chunk). The 200-id chunk size
//   keeps URLs under PostgREST's practical limit.
//
// Output is sorted by matchStart asc to preserve the order
// downstream consumers may rely on (the legacy useMatchData ordered
// by match_start).
export async function fetchJoinedMatchPlayers(
  supabase: SupabaseClient,
  opts: FetchJoinedOpts = {},
  // Optional subscription map for the join-based payment-type
  // classifier. When provided, paid_status='FREE' rows split into
  // MEMBER (active sub at match time) vs FREE_NON_MEMBER. Omit to
  // keep the legacy "FREE → MEMBER" behavior — current callers that
  // rely on the old shape (useMatchData, PartnerDetailAdmin) don't
  // need to change. See loadActiveSubscriptionsByEmail.
  subscriptionsByEmail?: ActiveSubscriptionsByEmail,
): Promise<MatchDataset> {
  // 1. Fetch matches in scope
  const matches = await selectAll<MatchSelect>(() => {
    // Exclude soft-deleted phantoms (deleted upstream in MatchDay). The
    // player-join path drops zero-player phantoms already, but the
    // scheduledMatches view (run-rate / cancel-rate denominators) reads
    // these rows directly, so filter at the source. Defense-in-depth.
    let q = supabase
      .from("mdapi_matches")
      .select(MATCHES_COLS)
      .is("deleted_at", null);
    if (opts.fromDate) q = q.gte("start_date", opts.fromDate);
    if (opts.toDate) q = q.lte("start_date", opts.toDate);
    if (opts.fieldLike) q = q.ilike("field_title", opts.fieldLike);
    if (opts.cityIdentifier) q = q.eq("city_identifier", opts.cityIdentifier);
    return q.order("api_id");
  });
  if (matches.length === 0) return { rows: [], scheduledMatches: [] };

  const matchById = new Map<number, MatchSelect>();
  for (const m of matches) matchById.set(m.api_id, m);

  // 2. Fetch players. Two paths (see comment above).
  const hasFilter = !!(
    opts.fromDate ||
    opts.toDate ||
    opts.fieldLike ||
    opts.cityIdentifier
  );
  const players: PlayerSelect[] = [];
  if (!hasFilter) {
    const all = await selectAll<PlayerSelect>(() =>
      supabase
        .from("mdapi_match_players")
        .select(PLAYERS_COLS)
        .order("api_id"),
    );
    players.push(...all);
  } else {
    const matchIds = [...matchById.keys()];
    const chunks: number[][] = [];
    for (let from = 0; from < matchIds.length; from += IN_CHUNK) {
      chunks.push(matchIds.slice(from, from + IN_CHUNK));
    }
    // Fan out chunks with a hard concurrency cap (see mapWithLimit
    // header). Was a sequential for-await loop; the parallel form is
    // ~3-4× faster on multi-chunk windows like the /cities 12-week
    // pull (9 chunks → 4 concurrent waves vs 9 serial round-trip
    // bundles). Order doesn't matter — players are joined back to
    // matches by match_api_id at step 4.
    const chunkResults = await mapWithLimit(
      chunks,
      CHUNK_CONCURRENCY,
      (chunk) =>
        selectAll<PlayerSelect>(() =>
          supabase
            .from("mdapi_match_players")
            .select(PLAYERS_COLS)
            .in("match_api_id", chunk)
            .order("api_id"),
        ),
    );
    for (const chunkPlayers of chunkResults) {
      players.push(...chunkPlayers);
    }
  }

  // 3. Resolve promocode_id → code text. Targeted lookup: only the
  // distinct ids referenced by the players we just fetched, not the
  // whole 6k-row mdapi_promocodes table. For typical loads this is
  // 0–200 distinct ids, fits in one round trip.
  const promoIds = new Set<number>();
  for (const p of players) {
    if (p.promocode_id != null) promoIds.add(p.promocode_id);
  }
  const promocodeMap = await fetchPromocodeCodes(supabase, promoIds);

  // 4. Join + map + filter
  const out: JoinedMatchPlayerRow[] = [];
  for (const p of players) {
    const m = matchById.get(p.match_api_id);
    if (!m) continue;
    const row = mapJoinedRow(m, p, promocodeMap, subscriptionsByEmail);
    if (row) out.push(row);
  }

  // 5. Sort by matchStart asc (legacy useMatchData order).
  out.sort((a, b) => a.matchStart.getTime() - b.matchStart.getTime());

  // 6. Build the per-match view directly from `matches` (not from
  //    `out`) — empty matches with zero player rows must survive
  //    into scheduledMatches so denominators like run-rate /
  //    cancel-rate / "matches scheduled this week" can include them.
  //    Dedup by (matchStart, normField'd field): same key the
  //    cancel-rate aggregator uses across rows[], so the two arrays
  //    reconcile. Cancellation propagates: if any record of a key
  //    is matchCanceled=true, the deduped entry is too.
  const scheduledByKey = new Map<string, ScheduledMatch>();
  for (const m of matches) {
    const city = cityFromAbbr(m.city_identifier);
    if (!city) continue;
    const matchStart = parseLocal(m.start_date);
    if (!matchStart) continue;
    const field = normField(m.field_title ?? "");
    if (!field) continue;
    const key = `${matchStart.getTime()}|${field}`;
    const prior = scheduledByKey.get(key);
    if (prior) {
      // Multiple mdapi_matches rows can share a (start, field) key
      // when the same match is represented twice (rare; defensive).
      if (m.is_cancelled) prior.matchCanceled = true;
    } else {
      scheduledByKey.set(key, {
        city,
        field,
        matchStart,
        matchCanceled: !!m.is_cancelled,
      });
    }
  }
  const scheduledMatches = [...scheduledByKey.values()].sort(
    (a, b) => a.matchStart.getTime() - b.matchStart.getTime(),
  );

  return { rows: out, scheduledMatches };
}

// Convenience wrapper for secondary readers that want the CSV-era
// row shape directly. Each consumer's internal logic stays unchanged.
export async function fetchLegacyMatchRegistrations(
  supabase: SupabaseClient,
  opts: FetchJoinedOpts = {},
  subscriptionsByEmail?: ActiveSubscriptionsByEmail,
): Promise<LegacyMatchRegRow[]> {
  const { rows } = await fetchJoinedMatchPlayers(
    supabase,
    opts,
    subscriptionsByEmail,
  );
  return rows.map(toLegacyShape);
}
