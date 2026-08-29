/* LAPSED-MEMBER SPOTS — the model. READ-ONLY: nothing here writes and nothing calls a write.
 *
 * ── THE ONE THING THIS PAGE MUST NOT LET YOU BELIEVE ─────────────────────────────────────────
 * FREE DOES NOT MEAN "MEMBER BENEFIT". No column anywhere records that a spot was taken on a
 * membership. `match_registrations.payment_type = 'MEMBER'` is a stale manual upload whose last
 * match is 2026-05-12 and which holds ZERO future rows; `mdapi_match_players.user_is_member` is
 * `false` on all 246,216 rows. FREE is the nearest available signal, and `is_first_match` is
 * carried per row so a first-match-free is visible rather than mistaken for a lapsed member.
 * That sentence is on the page. It is load-bearing and it does not come out.
 *
 * ── MEMBERSHIP STATE HAS THREE VALUES AND THEY ARE THE REAL ONES ─────────────────────────────
 * mdapi_subscriptions.status holds exactly two values in production — ACTIVE (467) and CANCELED
 * (2,225). There is no PENDING and no FAILED, and the raw API payload has no payment, failure,
 * decline, invoice or card key at all. A failed payment does not present in this data.
 *
 *   ACTIVE          ANY of the user's subscription rows is ACTIVE. Never the newest row: 153
 *                   people hold an ACTIVE and a CANCELED row at the same time, and reading the
 *                   newest would mark every one of them lapsed.
 *   LAPSED          has rows, none of them ACTIVE. Carries the date and the cancel_reason.
 *   NEVER_A_MEMBER  no subscription row has ever existed. NOT "none" — that reads like a lapse,
 *                   and 50 of today's 90 free spots are held by these people.
 *
 * ── WHY THE DENOMINATOR IS PART OF THE ANSWER ────────────────────────────────────────────────
 * On 1 September this page shows either "nobody lapsed" or "the query failed", and those render
 * identically unless the page states what it counted. So the model returns the funnel — matches,
 * live spots, free spots — beside the rows, and the view prints it whether or not anything was
 * found. This is the same failure that let a swallowed error read as a confident zero.
 */

export type MembershipState = "ACTIVE" | "LAPSED" | "NEVER_A_MEMBER";

export type SubRow = { user_id: unknown; status: unknown; canceled_at?: unknown; cancel_reason?: unknown };
export type MatchRow = {
  api_id: number; name?: string | null; start_date?: string | null;
  is_cancelled?: unknown; city_name?: string | null; field_title?: string | null;
};
export type SpotRow = {
  api_id: number; match_api_id: number; user_id: unknown;
  user_email?: string | null; user_first_name?: string | null; user_last_name?: string | null;
  paid_status?: unknown; user_type?: unknown; amount?: unknown;
  is_cancelled?: unknown; user_is_fake_player?: unknown; is_first_match?: unknown;
};

export type LapsedSpot = {
  spotId: number; matchId: number;
  name: string; email: string;
  matchName: string; date: string; field: string; city: string;
  amountCents: number; isFirstMatch: boolean;
  state: MembershipState;
  lapsedOn: string | null;      // yyyy-mm-dd, LAPSED only
  lapseReason: string | null;
  guestsOnMatch: number;        // guests sharing this match, adjacent to the decision
};

export type LapsedSpotsView = {
  /** THE DENOMINATOR. Printed whether or not anything is found — it is what proves the query ran. */
  futureMatches: number;
  liveSpots: number;
  fakeSpots: number;
  freeSpots: number;
  groups: { state: MembershipState; rows: LapsedSpot[] }[];
};

/** WALL CLOCK, AS TEXT. start_date carries a Z it does not mean, so it is compared as
 *  YYYY-MM-DD string against today's YYYY-MM-DD — never through a Date, which would re-shift it
 *  by the machine's offset and move matches across the midnight boundary. */
export const isFutureWall = (startDate: unknown, todayYmd: string): boolean =>
  typeof startDate === "string" && startDate.slice(0, 10) > todayYmd;

/** ANY row ACTIVE, never the newest. See the header — 153 people would be wrong the other way. */
export function membershipStateOf(userId: unknown, subsByUser: Map<string, SubRow[]>): MembershipState {
  const rows = subsByUser.get(String(userId));
  if (!rows || rows.length === 0) return "NEVER_A_MEMBER";
  return rows.some((r) => r.status === "ACTIVE") ? "ACTIVE" : "LAPSED";
}

/** The most recent cancellation among a lapsed member's rows. Null when no row carries a date —
 *  644 CANCELED rows have no canceled_at, so "unknown" is a real answer and not a bug. */
export function lapseInfoOf(userId: unknown, subsByUser: Map<string, SubRow[]>): { on: string | null; reason: string | null } {
  const rows = (subsByUser.get(String(userId)) ?? []).filter((r) => typeof r.canceled_at === "string" && r.canceled_at);
  if (!rows.length) return { on: null, reason: null };
  const newest = rows.sort((a, b) => String(b.canceled_at).localeCompare(String(a.canceled_at)))[0];
  return { on: String(newest.canceled_at).slice(0, 10), reason: (newest.cancel_reason as string | null) ?? null };
}

const ORDER: MembershipState[] = ["LAPSED", "ACTIVE", "NEVER_A_MEMBER"];

export function buildLapsedSpots(
  matches: MatchRow[], spots: SpotRow[], subs: SubRow[], todayYmd: string,
): LapsedSpotsView {
  const future = matches.filter((m) => m.is_cancelled !== true && isFutureWall(m.start_date, todayYmd));
  const byMatch = new Map(future.map((m) => [m.api_id, m]));
  const onFuture = spots.filter((s) => byMatch.has(s.match_api_id));
  const live = onFuture.filter((s) => s.is_cancelled !== true);
  /* FAKE PLAYERS ARE PADDING, NOT PEOPLE. Excluded — and the count is returned so the exclusion
   * reads as a decision rather than an omission. 32 of today's 200. */
  const fake = live.filter((s) => s.user_is_fake_player === true);
  const real = live.filter((s) => s.user_is_fake_player !== true);

  /* GUESTS ARE NOT LISTED AS REMOVABLE. A guest shares its host's user_id and carries no other
   * link, so the only honest thing to show is how many sit on the same match — adjacent to the
   * decision, because acting on the host is not a decision only about the host. */
  const guestsByMatch = new Map<number, number>();
  for (const s of real) if (s.user_type === "GUEST") guestsByMatch.set(s.match_api_id, (guestsByMatch.get(s.match_api_id) ?? 0) + 1);

  const free = real.filter((s) => s.paid_status === "FREE" && s.user_type === "PLAYER");

  const subsByUser = new Map<string, SubRow[]>();
  for (const r of subs) {
    const k = String(r.user_id);
    subsByUser.set(k, [...(subsByUser.get(k) ?? []), r]);
  }

  const rows: LapsedSpot[] = free.map((s) => {
    const m = byMatch.get(s.match_api_id)!;
    const state = membershipStateOf(s.user_id, subsByUser);
    const lapse = state === "LAPSED" ? lapseInfoOf(s.user_id, subsByUser) : { on: null, reason: null };
    const nm = `${s.user_first_name ?? ""} ${s.user_last_name ?? ""}`.trim();
    return {
      spotId: s.api_id, matchId: s.match_api_id,
      name: nm || "—", email: String(s.user_email ?? "—"),
      matchName: String(m.name ?? "—"), date: String(m.start_date ?? "").slice(0, 10),
      field: String(m.field_title ?? "—"), city: String(m.city_name ?? "—"),
      amountCents: Number(s.amount) || 0, isFirstMatch: s.is_first_match === true,
      state, lapsedOn: lapse.on, lapseReason: lapse.reason,
      guestsOnMatch: guestsByMatch.get(s.match_api_id) ?? 0,
    };
  });

  /* SORTED BY LAPSE DATE, NEWEST FIRST, AND NO RECENCY WINDOW. The 1 September cohort arrives at
   * the top on its own; a window is a number to get wrong and would hide anyone outside it.
   * A lapse with no date sorts last within its group rather than first — an unknown date is not
   * evidence of recency. */
  const sortRows = (a: LapsedSpot, b: LapsedSpot) =>
    String(b.lapsedOn ?? "").localeCompare(String(a.lapsedOn ?? "")) ||
    a.date.localeCompare(b.date) || a.email.localeCompare(b.email);

  return {
    futureMatches: future.length,
    liveSpots: live.length,
    fakeSpots: fake.length,
    freeSpots: free.length,
    groups: ORDER.map((state) => ({ state, rows: rows.filter((r) => r.state === state).sort(sortRows) })),
  };
}

export const STATE_LABEL: Record<MembershipState, string> = {
  LAPSED: "Lapsed — membership cancelled, no active row",
  ACTIVE: "Active member — a subscription row is ACTIVE",
  NEVER_A_MEMBER: "Never a member — no subscription row has ever existed",
};

/** The sentence that must stay. Exported so the page cannot drift from it and the suite can pin it. */
export const FREE_IS_NOT_MEMBER_NOTE =
  "FREE does not mean “member benefit”. No column anywhere records that a spot was taken on a " +
  "membership — match_registrations.payment_type is a stale upload ending in May, and user_is_member is " +
  "false on all 246,216 rows. FREE is the nearest available signal, and IS FIRST MATCH is shown so a " +
  "first-match-free is visible.";
