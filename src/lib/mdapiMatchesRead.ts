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

const MATCHES_COLS =
  "api_id, city_identifier, field_title, start_date, is_cancelled";
const PLAYERS_COLS =
  "api_id, match_api_id, user_id, user_email, user_type, paid_status, promocode_id, is_cancelled, canceled_at, amount, created_at, is_absent, user_is_fake_player";

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
  field_title: string | null;
  start_date: string | null;
  is_cancelled: boolean | null;
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
  playerApiId: number;
  userId: number;
  matchPricePaid: number; // amount in dollars
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

// Drop-in shape for secondary readers that previously did
// `from("match_registrations").select("user_id, email, field, ...")`.
// All fields snake_case; timestamps as strings. Internal consumer
// logic (matchPnL's bucket builder, partnerStats' isStaff/isCanceled
// filters, etc.) operates on this shape unchanged.
export type LegacyMatchRegRow = {
  user_id: string;
  email: string | null;
  field: string;
  match_start: string;
  match_canceled: boolean;
  player_canceled_at: string | null;
  payment_type: string | null;
  promocode: string | null;
  match_price_paid: number;
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

// Derive the cockpit's CSV-era "Type Of Payment" string from the
// API's paid_status + promocode_id. Cross-tab probe (Phase 5b
// investigation) confirmed:
//   paid_status='FREE'    → MEMBER (no FREE+promo overlap in 38k rows)
//   paid_status='PAID' + promocode_id  → PROMOCODE
//   paid_status='PAID' (no promo)      → DAILY PAID
//   paid_status='WAITING' → null (filtered upstream; defensive null here)
function derivePaymentType(p: PlayerSelect): string | null {
  if (p.paid_status === "FREE") return "MEMBER";
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
): JoinedMatchPlayerRow | null {
  if (player.paid_status === "WAITING") return null;
  // user_is_fake_player: synthetic fill placeholder (dummy roster slot
  // used when a host needs a body for headcount but no real person
  // showed up). is_absent: registered + paid but didn't physically
  // show up. Both inflate spot-count metrics; drop at the mapper so
  // every downstream consumer (Match P&L, partner stats, projections,
  // partner detail) gets honest counts.
  if (player.user_is_fake_player === true) return null;
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
    paymentType: derivePaymentType(player),
    promocode,
    email: player.user_email?.toLowerCase() ?? null,
    matchApiId: match.api_id,
    playerApiId: player.api_id,
    userId: player.user_id,
    // API stores `amount` in cents (Stripe convention). Single
    // conversion site — fixes Match P&L, partner stats, projections,
    // and partner detail in one shot. Any consumer of matchPricePaid
    // (or the snake_case match_price_paid via toLegacyShape) gets
    // dollars by default. Matches the Phase 3b convention: read-time
    // conversion, don't transform on ingest.
    matchPricePaid: (player.amount ?? 0) / 100,
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
    match_start: dateToLocalIso(r.matchStart),
    match_canceled: r.matchCanceled,
    player_canceled_at: r.playerCanceledAt
      ? dateToLocalIso(r.playerCanceledAt)
      : null,
    payment_type: r.paymentType,
    promocode: r.promocode,
    match_price_paid: r.matchPricePaid,
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
): Promise<JoinedMatchPlayerRow[]> {
  // 1. Fetch matches in scope
  const matches = await selectAll<MatchSelect>(() => {
    let q = supabase.from("mdapi_matches").select(MATCHES_COLS);
    if (opts.fromDate) q = q.gte("start_date", opts.fromDate);
    if (opts.toDate) q = q.lte("start_date", opts.toDate);
    if (opts.fieldLike) q = q.ilike("field_title", opts.fieldLike);
    return q.order("api_id");
  });
  if (matches.length === 0) return [];

  const matchById = new Map<number, MatchSelect>();
  for (const m of matches) matchById.set(m.api_id, m);

  // 2. Fetch players. Two paths (see comment above).
  const hasFilter = !!(opts.fromDate || opts.toDate || opts.fieldLike);
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
    const row = mapJoinedRow(m, p, promocodeMap);
    if (row) out.push(row);
  }

  // 5. Sort by matchStart asc (legacy useMatchData order).
  out.sort((a, b) => a.matchStart.getTime() - b.matchStart.getTime());
  return out;
}

// Convenience wrapper for secondary readers that want the CSV-era
// row shape directly. Each consumer's internal logic stays unchanged.
export async function fetchLegacyMatchRegistrations(
  supabase: SupabaseClient,
  opts: FetchJoinedOpts = {},
): Promise<LegacyMatchRegRow[]> {
  const joined = await fetchJoinedMatchPlayers(supabase, opts);
  return joined.map(toLegacyShape);
}
