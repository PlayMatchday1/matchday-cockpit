/* LAPSED-MEMBER SPOTS — the model. READ-ONLY: nothing here writes and nothing calls a write.
 *
 * ── THE ONE THING THIS PAGE MUST NOT LET YOU BELIEVE ─────────────────────────────────────────
 * FREE DOES NOT MEAN "MEMBER BENEFIT". No column anywhere records that a spot was taken on a
 * membership:
 *   - `match_registrations.payment_type = 'MEMBER'` is a STALE MANUAL UPLOAD whose last match is
 *     2026-05-12, and it holds ZERO future rows. It cannot answer a question about next week.
 *   - `mdapi_match_players.user_is_member` is `false` on ALL 246,216 rows. The column exists and
 *     has never been populated.
 * FREE is therefore the NEAREST AVAILABLE SIGNAL, not proof of a member benefit. `is_first_match`
 * is carried per row so a first-match-free is visible rather than mistaken for a lapsed member.
 *
 * THIS USED TO BE AN AMBER BOX ON THE PAGE. It was removed on 2026-09-01 — the caveat is real and
 * unchanged, it is simply not screen furniture on a sheet where the operator is deciding who to
 * remove. It lives HERE and in docs/matchday-api-facts.md, and it does not get weaker for being
 * off-screen. Anyone about to treat FREE as "was a member" must read this first.
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

export type MembershipState = "PAST_DUE" | "LAPSED" | "ACTIVE" | "NEVER_A_MEMBER";

/* WHY BLOCKED IS NOT THE SAME AS UNCHECKED.
 *   ok       — safe to act on; checked by default.
 *   caution  — actionable, but the operator must opt in. Unchecked, with a visible reason.
 *   blocked  — CANNOT be selected at all. Only one thing is blocked: a spot the player PAID for.
 *              What happens to that money on removal is recorded UNCONFIRMED in the facts doc,
 *              and "warn about it" is not good enough when the unknown is a charge on a player's
 *              card and there is no undo. */
export type Selectability = "ok" | "caution" | "blocked";

export type SpotGuard = { selectability: Selectability; reason: string | null };

/** Staff accounts. The SAME regex membershipStats uses — imported, not re-typed, because two
 *  copies of "who is internal" is how the four @playmatchday.com accounts got counted as members
 *  for a month. buildLapsedSpots had NO staff filter until 2026-08-31; this is it. */
export { INTERNAL_EMAIL_RX } from "./membershipStats";
import { INTERNAL_EMAIL_RX } from "./membershipStats";

export type SubRow = { user_id: unknown; status: unknown; canceled_at?: unknown; cancel_reason?: unknown; member_email?: unknown };
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
  /** HH:MM wall clock, straight off start_date. "" when the string carries no time. */
  kickoff: string;
  /** Today only: the match has already kicked off. Shown, never hidden — but never ticked. */
  alreadyStarted: boolean;
  /** Today's match, at any hour. Drives the "today first" sort and the funnel line. */
  isToday: boolean;
  amountCents: number; isFirstMatch: boolean;
  state: MembershipState;
  lapsedOn: string | null;      // yyyy-mm-dd, LAPSED only
  lapseReason: string | null;
  guestsOnMatch: number;        // guests sharing this match, adjacent to the decision
  /* THE REMOVAL CALL KEYS ON THIS. mdapi_match_players.api_id IS the roster row's `id`, which the
   * API calls userMatchId. It is NOT the player's userId. DELETE /admin/matches/user-matches/{id}
   * takes this; DELETE /admin/matches/{id}/players/{userId} returns 403 USER_NOT_JOINED and is
   * recorded in the facts doc as a conflict where the API beat the inventory. */
  userMatchId: number;
  userId: number;
  isStaff: boolean;
  guard: SpotGuard;
  /** Context that does NOT affect selection — see contextChipFor. */
  contextChip: string | null;
};

export type LapsedSpotsView = {
  /** THE DENOMINATOR. Printed whether or not anything is found — it is what proves the query ran. */
  futureMatches: number;
  liveSpots: number;
  fakeSpots: number;
  freeSpots: number;
  /** Free spots whose match starts TODAY — the number the old `>` predicate hid entirely. */
  todaySpots: number;
  groups: { state: MembershipState; rows: LapsedSpot[] }[];
};

/** WALL CLOCK, AS TEXT. start_date carries a Z it does not mean, so it is compared as
 *  YYYY-MM-DD string against today's YYYY-MM-DD — never through a Date, which would re-shift it
 *  by the machine's offset and move matches across the midnight boundary.
 *
 *  ── TODAY IS IN, AS OF 2026-09-01 ───────────────────────────────────────────────────────────
 *  This was `>` and it silently discarded everything the SQL had already fetched: route.ts asks
 *  for `.gte("start_date", today)` and the model then threw the same day away. Measured on the
 *  morning it was fixed: 21 matches and 8 lapsed-member spots hidden, including five people
 *  playing that evening — the people most likely to walk onto a pitch before anyone looks.
 *  A match earlier today is NOT excluded here; it is shown and left unticked (see hasStarted). */
export const isFutureWall = (startDate: unknown, todayYmd: string): boolean =>
  typeof startDate === "string" && startDate.slice(0, 10) >= todayYmd;

/** THE KICKOFF, AS TEXT. Same wall-clock rule: HH:MM straight out of the string, never a Date. */
export const kickoffOf = (startDate: unknown): string =>
  typeof startDate === "string" && startDate.length >= 16 ? startDate.slice(11, 16) : "";

/** HAS IT ALREADY KICKED OFF? Only today's matches can have. Compared in America/Chicago against
 *  the caller's `nowHm`, which the route derives in that zone — the two must be the same clock or
 *  a 7pm match reads as started at 2pm somewhere else. A future day is never "started". */
export const hasStarted = (startDate: unknown, todayYmd: string, nowHm: string): boolean => {
  if (typeof startDate !== "string") return false;
  const d = startDate.slice(0, 10);
  if (d !== todayYmd) return false;
  const t = kickoffOf(startDate);
  return t !== "" && t <= nowHm;
};

/** ANY row ACTIVE, never the newest. See the header — 153 people would be wrong the other way.
 *
 * ── PAST_DUE IS NOT LAPSED, AND IT USED TO BE ────────────────────────────────────────────────
 * Until 2026-08-31 this returned LAPSED for anyone with no ACTIVE row, which swept PAST_DUE in
 * with it: a member whose card declined and is being retried in dunning would have appeared on a
 * removal list. They have not left — Stripe is still trying. It reads 0 today and read 59 for
 * 2026-05-01 in members_monthly_snapshots, so this WILL fire, and it will fire on the day after a
 * billing run, which is exactly when someone is looking at this page.
 *
 * ORDER MATTERS: PAST_DUE is checked BEFORE ACTIVE. Someone holding an old ACTIVE row and a
 * current PAST_DUE one is mid-dunning, and reporting them as a healthy member hides the thing the
 * operator needs to see. */
export function membershipStateOf(userId: unknown, subsByUser: Map<string, SubRow[]>): MembershipState {
  const rows = subsByUser.get(String(userId));
  if (!rows || rows.length === 0) return "NEVER_A_MEMBER";
  if (rows.some((r) => r.status === "PAST_DUE")) return "PAST_DUE";
  return rows.some((r) => r.status === "ACTIVE") ? "ACTIVE" : "LAPSED";
}

/* THE GUARD, PER SPOT. Everything the confirm dialog and the checkbox read comes from here, so
 * the reason chip on screen and the reason a row is unchecked cannot drift apart. */
export function guardFor(args: {
  amountCents: number; isStaff: boolean; state: MembershipState; guestsOnMatch: number;
  alreadyStarted?: boolean;
}): SpotGuard {
  // BLOCKED FIRST, and it is absolute. Removal is not a refund; refund-and-cancel is on the
  // endpoint deny-list; what happens to the charge is UNCONFIRMED. There is no undo.
  if (args.amountCents > 0) {
    return { selectability: "blocked", reason: `Paid $${(args.amountCents / 100).toFixed(2)} — cannot be removed here` };
  }
  /* ALREADY KICKED OFF. Shown, never hidden — the operator asked to see them — but never ticked:
   * removing someone from a match that is under way frees a spot nobody can take and erases a
   * record of who was there. */
  if (args.alreadyStarted) return { selectability: "caution", reason: "Already started" };
  if (args.isStaff) return { selectability: "caution", reason: "Internal staff account" };
  if (args.guestsOnMatch > 0) {
    return { selectability: "caution", reason: `${args.guestsOnMatch} guest${args.guestsOnMatch === 1 ? "" : "s"} on this match` };
  }
  /* PAST_DUE IS NOT AN EXCLUSION ANY MORE (2026-09-01). It was caution — unticked — on the
   * reasoning that a member mid-dunning has not left. The ruling reversed it: removing them IS
   * the lever that gets a failed card fixed, so they are ticked like anyone else. The dunning
   * note survives as CONTEXT on the row (see contextChipFor), not as a reason to skip them —
   * a chip that says "excluded" beside a ticked checkbox is worse than no chip. */
  return { selectability: "ok", reason: null };
}

/** CONTEXT, NOT AN EXCLUSION. Rendered on the row beside the guard chip; never changes whether a
 *  row is ticked. Today this is the dunning note, which the operator asked to keep. */
export const contextChipFor = (state: MembershipState): string | null =>
  state === "PAST_DUE" ? "Payment pending — still in dunning" : null;

/** Checked on arrival = "ok" only. caution and blocked both start unchecked; blocked can never
 *  be checked at all, which the view enforces by disabling the input. */
export const defaultChecked = (g: SpotGuard): boolean => g.selectability === "ok";

/** The most recent cancellation among a lapsed member's rows. Null when no row carries a date —
 *  644 CANCELED rows have no canceled_at, so "unknown" is a real answer and not a bug. */
export function lapseInfoOf(userId: unknown, subsByUser: Map<string, SubRow[]>): { on: string | null; reason: string | null } {
  const rows = (subsByUser.get(String(userId)) ?? []).filter((r) => typeof r.canceled_at === "string" && r.canceled_at);
  if (!rows.length) return { on: null, reason: null };
  const newest = rows.sort((a, b) => String(b.canceled_at).localeCompare(String(a.canceled_at)))[0];
  return { on: String(newest.canceled_at).slice(0, 10), reason: (newest.cancel_reason as string | null) ?? null };
}

const ORDER: MembershipState[] = ["LAPSED", "PAST_DUE", "ACTIVE", "NEVER_A_MEMBER"];

export function buildLapsedSpots(
  matches: MatchRow[], spots: SpotRow[], subs: SubRow[], todayYmd: string,
  /** HH:MM in America/Chicago, from the caller. Defaults to end-of-day, which makes every one of
   *  today's matches "already started" — the SAFE default: it never ticks something by accident. */
  nowHm = "23:59",
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
    const started = hasStarted(m.start_date, todayYmd, nowHm);
    const state = membershipStateOf(s.user_id, subsByUser);
    const lapse = state === "LAPSED" || state === "PAST_DUE" ? lapseInfoOf(s.user_id, subsByUser) : { on: null, reason: null };
    const nm = `${s.user_first_name ?? ""} ${s.user_last_name ?? ""}`.trim();
    /* STAFF IS CHECKED ON BOTH SIDES. The roster row's email is what the operator sees, but a
     * staff member can hold a subscription under a different address — so the subscription rows
     * are tested too. Either one internal makes the spot caution. */
    const subEmails = (subsByUser.get(String(s.user_id)) ?? []).map((r) => String(r.member_email ?? ""));
    const isStaff = INTERNAL_EMAIL_RX.test(String(s.user_email ?? "")) || subEmails.some((e) => INTERNAL_EMAIL_RX.test(e));
    const amountCents = Number(s.amount) || 0;
    const guestsOnMatch = guestsByMatch.get(s.match_api_id) ?? 0;
    return {
      spotId: s.api_id, matchId: s.match_api_id,
      // api_id IS the roster row id the API calls userMatchId. Carried under its API name so the
      // removal call cannot accidentally be built from userId.
      userMatchId: s.api_id, userId: Number(s.user_id),
      name: nm || "—", email: String(s.user_email ?? "—"),
      matchName: String(m.name ?? "—"), date: String(m.start_date ?? "").slice(0, 10),
      field: String(m.field_title ?? "—"), city: String(m.city_name ?? "—"),
      amountCents, isFirstMatch: s.is_first_match === true,
      state, lapsedOn: lapse.on, lapseReason: lapse.reason,
      guestsOnMatch, isStaff,
      kickoff: kickoffOf(m.start_date),
      alreadyStarted: started,
      isToday: String(m.start_date ?? "").slice(0, 10) === todayYmd,
      guard: guardFor({ amountCents, isStaff, state, guestsOnMatch, alreadyStarted: started }),
      contextChip: contextChipFor(state),
    };
  });

  /* SORTED BY LAPSE DATE, NEWEST FIRST, AND NO RECENCY WINDOW. The 1 September cohort arrives at
   * the top on its own; a window is a number to get wrong and would hide anyone outside it.
   * A lapse with no date sorts last within its group rather than first — an unknown date is not
   * evidence of recency. */
  /* TODAY FIRST — it is the only day that can still be acted on before it happens, so it leads
   * regardless of when the person lapsed. Within today, by kickoff, so the next match to start is
   * at the top. After that the original rule: newest lapse first, then date. */
  const sortRows = (a: LapsedSpot, b: LapsedSpot) =>
    (a.isToday ? 0 : 1) - (b.isToday ? 0 : 1) ||
    (a.isToday ? a.kickoff.localeCompare(b.kickoff) : 0) ||
    String(b.lapsedOn ?? "").localeCompare(String(a.lapsedOn ?? "")) ||
    a.date.localeCompare(b.date) || a.email.localeCompare(b.email);

  return {
    futureMatches: future.length,
    liveSpots: live.length,
    fakeSpots: fake.length,
    freeSpots: free.length,
    todaySpots: rows.filter((r) => r.isToday).length,
    groups: ORDER.map((state) => ({ state, rows: rows.filter((r) => r.state === state).sort(sortRows) })),
  };
}

export const STATE_LABEL: Record<MembershipState, string> = {
  LAPSED: "Lapsed — membership cancelled, no active row",
  PAST_DUE: "Payment pending, not lapsed — a card declined and is being retried",
  ACTIVE: "Active member — a subscription row is ACTIVE",
  NEVER_A_MEMBER: "Never a member — no subscription row has ever existed",
};




/* ── THE CONFIRM SENTENCE ──────────────────────────────────────────────────────────────────────
 * Computed from the ROWS ACTUALLY SELECTED, never from the page total. Those two numbers are the
 * same only when nothing is unchecked, and every default-off rule above guarantees they usually
 * are not. A dialog that says "remove 20 spots" over a selection of 3 is worse than no dialog. */
export type ConfirmCounts = { spots: number; people: number; matches: number };

export function confirmCounts(selected: readonly LapsedSpot[]): ConfirmCounts {
  return {
    spots: selected.length,
    people: new Set(selected.map((r) => r.userId)).size,
    matches: new Set(selected.map((r) => r.matchId)).size,
  };
}

export const CONFIRM_TAIL =
  "This cannot be undone — a freed spot can be taken by a new registration immediately, and " +
  "re-adding requires an open slot.";

export function confirmSentence(selected: readonly LapsedSpot[]): string {
  const c = confirmCounts(selected);
  const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `Remove ${pl(c.spots, "spot", "spots")} from ${pl(c.people, "person", "people")} across ` +
    `${pl(c.matches, "match", "matches")}. ${CONFIRM_TAIL}`;
}

/* ── THE RUN ───────────────────────────────────────────────────────────────────────────────────
 * SEQUENTIAL, NEVER PARALLEL, AND NEVER RETRIED. There is no Idempotency-Key on any MatchDay
 * write, so a row that failed is reported failed and is not sent again — a duplicate removal is
 * not idempotent, it is a second write against a roster that has already moved.
 *
 * UNKNOWN HALTS EVERYTHING. FAILED and NOT APPLIED are settled facts about one row and the run
 * continues past them. UNKNOWN means the write may or may not have happened, so every assumption
 * the rest of the plan rests on is void — the operator must reload and look before anything else
 * is sent. */
export type RemovalVerdict = "landed" | "failed" | "notapplied" | "unknown";

export type RemovalResult = {
  spot: LapsedSpot;
  verdict: RemovalVerdict;
  detail: string | null;   // the API's own words on a failure; never a phone number
};

export const HALTS_RUN = (v: RemovalVerdict): boolean => v === "unknown";

/** The CSV the operator keeps. It is the only record they see, and there is no rollback. */
export function removalCsv(results: readonly RemovalResult[], whenIso: string): string {
  const cell = (v: string | number) => {
    const t = String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = ["Person", "user_id", "userMatchId", "Match", "Date", "Field", "City", "Verdict", "Detail"];
  return [
    `# Lapsed-spot removals run ${whenIso}. Verdicts are from a read-back, not from an HTTP status.`,
    head.map(cell).join(","),
    ...results.map((r) => [
      r.spot.name, r.spot.userId, r.spot.userMatchId, r.spot.matchName, r.spot.date,
      r.spot.field, r.spot.city, r.verdict.toUpperCase(), r.detail ?? "",
    ].map(cell).join(",")),
  ].join("\n");
}
