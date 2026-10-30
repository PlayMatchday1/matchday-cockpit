// THE STAFF APP'S PURE RULES. No fetching, no Supabase, no imports from the app layer, so every
// decision the /api/app/* routes make can be asserted offline.
//
// THE APP READS LIVE. Every match, roster and city used to decide scope comes from the MatchDay API
// in the same request. Nothing here reads an mdapi_* mirror, and nothing should start to: a match
// created five minutes ago must answer the same as one created last week.

export type AppRow = Record<string, unknown>;

/** Who this account is to the app. Derived from the app_users row read fresh on every request. */
export type AppAccess = {
  /** May read the day's matches, rosters and players (subject to the city scope below). */
  canReadMatches: boolean;
  /** True when the row carries a city_identifier at all. A confined account sees one city. */
  confined: boolean;
  /** The resolved city identifier, or null. confined && scopeCity === null means "unresolvable". */
  scopeCity: string | null;
  tier: "operator" | "confined" | "city_manager" | "none";
};

/**
 * THE APP GATE. Any app_users row may sign in ("field team is anyone with a row"); what it can read
 * is what its existing flags allow on the desktop, with one deliberate widening Ryan ruled on
 * 2026-10-29: a city manager reads rosters and players for their own city here, read only.
 *
 * resolvedCity is cityConfinement.confinedCity(row): the identifier checked against the allowlist.
 */
export function appAccess(row: AppRow, resolvedCity: string | null): AppAccess {
  const raw = typeof row.city_identifier === "string" ? row.city_identifier.trim() : "";
  const confined = raw.length > 0;
  const isCm = row.is_city_manager === true;
  const canReadMatches = row.is_admin === true || row.can_access_matchops === true || isCm;
  const tier: AppAccess["tier"] = !canReadMatches ? "none"
    : isCm && row.is_admin !== true ? "city_manager"
    : confined ? "confined"
    : "operator";
  return { canReadMatches, confined, scopeCity: confined ? resolvedCity : null, tier };
}

/**
 * THE CITY BOUNDARY, ON A CITY NAME THE LIVE API JUST RETURNED.
 *
 * scopeCityName is cityNameFor(scopeCity). Unconfined: everything passes. Confined to a city the
 * allowlist cannot resolve: nothing passes. Otherwise exact equality with the live field.city.name;
 * a match with no city on the payload is refused, never assumed in scope.
 */
export function cityAllowed(access: Pick<AppAccess, "confined" | "scopeCity">, scopeCityName: string | null, liveCityName: string | null | undefined): boolean {
  if (!access.confined) return true;
  if (!access.scopeCity || !scopeCityName) return false;
  return typeof liveCityName === "string" && liveCityName === scopeCityName;
}

/* ── CHECK-IN ─────────────────────────────────────────────────────────────────────────────────
 * Ryan, 2026-10-29: check-in opens 15 minutes before kickoff, DISPLAY ONLY (no write is gated on
 * it), and "late" means checked in more than 10 minutes after kickoff. Both constants live here and
 * the today route hands them to the app, so the phone never carries a second copy. */
export const CHECKIN_OPENS_MINUTES = 15;
export const LATE_AFTER_MINUTES = 10;

export type Mark = { player_id: number; status: string; marked_at: string | null };
export type CheckinSummary = { in: number; total: number; late: number; noShow: number };

export const checkinOpen = (kickoffUtcMs: number, nowMs: number): boolean =>
  Number.isFinite(kickoffUtcMs) && nowMs >= kickoffUtcMs - CHECKIN_OPENS_MINUTES * 60_000;

/**
 * One match's summary. `rosterPlayerIds` has one entry per LIVE roster SPOT (real, counted rows),
 * so a mark left on someone who has since cancelled does not count.
 *
 * TOTAL IS SPOTS, NOT PEOPLE. A guest or an additional spot is a row under the BUYER's player id, so
 * the same id appears more than once. Counting distinct ids read 39 against the board's 40 on
 * production 19531 and 37 against 44 on 20042; the length of the list is the board's own number.
 * Marks are keyed (match, player), so a buyer's guests cannot be marked apart from the buyer; that
 * is how the desktop check-in stores them, and it is reported, not worked around here.
 *
 * "In" is a mark of ok or late. "Late" is an in-mark stamped more than LATE_AFTER_MINUTES after
 * kickoff, by Ryan's definition, which is a time rule and not the manager's "late" button.
 */
export function summarizeCheckin(rosterPlayerIds: readonly number[], marks: readonly Mark[], kickoffUtcMs: number): CheckinSummary {
  const onRoster = new Set(rosterPlayerIds);
  const lateCut = kickoffUtcMs + LATE_AFTER_MINUTES * 60_000;
  let inn = 0, late = 0, noShow = 0;
  for (const m of marks) {
    if (!onRoster.has(Number(m.player_id))) continue;
    if (m.status === "no_show") { noShow++; continue; }
    if (m.status !== "ok" && m.status !== "late") continue;
    inn++;
    const at = m.marked_at ? Date.parse(m.marked_at) : Number.NaN;
    if (Number.isFinite(at) && at > lateCut) late++;
  }
  return { in: inn, total: rosterPlayerIds.length, late, noShow };
}

/** Run `fn` over `items` with at most `limit` in flight. Order of results matches `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
