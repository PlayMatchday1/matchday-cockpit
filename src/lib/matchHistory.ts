/* ONE PLAYER'S MATCH HISTORY: the four states, the merge, and the charge join.
 *
 * NO "server-only" HERE, DELIBERATELY. playerProfile.ts is server-only and assembles the history
 * on the server for the chat pane. Player Lookup fetches its Stripe charges from a SEPARATE
 * endpoint, in the browser, after the profile has already rendered — so the charge join has to be
 * callable from a client component too. Putting the rule in a pure module is what lets both
 * surfaces apply the same one; putting it in playerProfile would have forced Player Lookup to
 * re-implement it, which is the drift the last change existed to remove.
 */

/* ── "CANCELLED" WAS TWO DIFFERENT EVENTS WEARING ONE WORD ─────────────────────────────────────
 * The old mapping was:
 *
 *     const cancelled = um.isCancelled === true || m.isCancelled === true;
 *
 * `um.isCancelled` is THE PLAYER PULLED OUT. `m.isCancelled` is WE CALLED THE MATCH OFF. They have
 * opposite implications for money, and only the first can carry a strike.
 *
 * The second half of that OR was unreachable: /admin/players/{id}.matches[] omits every booking
 * whose match was cancelled (measured on five players — see docs/matchday-api-facts.md), so the
 * state it guarded could not arrive. Merging the mirror's rows back in is what makes it arrive,
 * which is what makes the split necessary now rather than merely tidy.
 *
 * NEITHER CANCELLATION IS RED. A player who pulled out is amber at most, because it may carry a
 * strike. A match we called off is informational — he did nothing wrong, and drawing his history in
 * red while he asks where his money went is the wrong note entirely. */
export type MatchState = "played" | "upcoming" | "player_cancelled" | "club_cancelled";

export const MATCH_STATE_LABEL: Record<MatchState, string> = {
  played: "Played",
  upcoming: "Upcoming",
  player_cancelled: "They cancelled",
  club_cancelled: "We cancelled",
};

export type MatchTone = "plain" | "amber" | "info";
export const MATCH_STATE_TONE: Record<MatchState, MatchTone> = {
  played: "plain",
  upcoming: "plain",
  player_cancelled: "amber",
  // The row an operator points at during a billing question, so it reads clearly and reads calm.
  club_cancelled: "info",
};

/** True for either kind, where the caller only needs "this did not happen". */
export const isCancelled = (s: MatchState): boolean => s === "player_cancelled" || s === "club_cancelled";

/* ── THE TWO DATE FIELDS, AND WHICH ONE DOES WHICH JOB ─────────────────────────────────────────
 *   startDateUtc ORDERS.   It is the genuine instant, so subtracting two of them is meaningful.
 *   startDate    DISPLAYS. It carries a Z it does not mean — it is the wall clock at the pitch, so
 *                          printed in UTC the characters come back out as they went in.
 *
 * Formatting the INSTANT as a date is what turned an 8pm Central Saturday match into Sunday on the
 * context pane, and shifted every other date on it by a day at the same time. Never sort on the
 * wall clock; never print the instant. */
export type HistoryRow = {
  umId: number | null;
  matchId: number | null;
  name: string;
  /** WALL CLOCK — display only. Print with timeZone: "UTC". */
  startDate: string | null;
  /** TRUE INSTANT — ordering and past/future only. Never format as a date. */
  startDateUtc: string | null;
  team: number | null;
  num: number | null;
  price: number;
  charged: number | null;
  userStatus: string | null;
  state: MatchState;
  removable: boolean;
  /** True when the row came from our mirror because the API did not send it. */
  mirrorOnly: boolean;
  /** The Stripe charge for this booking, once joined. Undefined means "not looked for yet". */
  charge?: ChargeOnRow | null;
};

export type MirrorRow = {
  matchId: number;
  name: string;
  startDate: string | null;
  startDateUtc: string | null;
  state: MatchState;
};

/* THE MERGE. The API's rows are authoritative where they exist — they carry the price, the charge
 * and the attendance status — and the mirror only ever FILLS GAPS. De-duplicated on match id,
 * because the mirror holds one row per registration and a player who booked two spots has two rows
 * for the same match. */
export function mergeHistory(apiRows: readonly HistoryRow[], mirrorRows: readonly MirrorRow[]): HistoryRow[] {
  const known = new Set(apiRows.map((r) => r.matchId).filter((x): x is number => x != null));
  const extra: HistoryRow[] = [];
  const seen = new Set<number>();
  for (const m of mirrorRows) {
    if (known.has(m.matchId) || seen.has(m.matchId)) continue;
    seen.add(m.matchId);
    extra.push({
      umId: null, matchId: m.matchId, name: m.name,
      startDate: m.startDate, startDateUtc: m.startDateUtc,
      team: null, num: null,
      // NOT ZERO. The mirror does not carry what this booking cost, and 0 is a claim about money.
      price: 0, charged: null,
      userStatus: null, state: m.state, removable: false, mirrorOnly: true,
    });
  }
  return sortHistory([...apiRows, ...extra]);
}

/** Newest first, BY THE INSTANT. */
export function sortHistory(rows: readonly HistoryRow[]): HistoryRow[] {
  return [...rows].sort((a, b) =>
    (Date.parse(b.startDateUtc ?? "") || 0) - (Date.parse(a.startDateUtc ?? "") || 0));
}

/* ── THE CHARGE JOIN, AND THE KEY THAT IS NOT WHAT IT SAYS ─────────────────────────────────────
 * stripePayments.toRow used to fold two different ids into one field:
 *
 *     const matchId = meta.matchId?.trim() || meta.userMatchId?.trim() || null;
 *
 * A charge carrying only `userMatchId` then stored a USER-MATCH id in a field called `matchId`.
 * Joined against a match api_id that puts a real dollar amount on the wrong match, and nothing
 * anywhere looks broken — the number is real, the row is real, and only the pairing is wrong. The
 * two ids share a namespace of small integers, so a collision is not exotic: 18321 is a real match
 * and could equally be a real user-match.
 *
 * So the keys are kept apart and each joins to its own column. A charge whose key is UNKNOWN joins
 * to NOTHING. Guessing is the failure mode this function exists to remove. */
export type ChargeLike = {
  id: string;
  amount: number;
  status: string;
  created: string;
  card: string | null;
  /** From metadata.matchId — a MATCH api id. */
  matchId: string | null;
  /** From metadata.userMatchId — a USER-MATCH id. A different namespace. */
  userMatchId: string | null;
  isMembership: boolean;
};

export type ChargeOnRow = { id: string; amount: number; status: string; created: string; card: string | null; via: "matchId" | "userMatchId" };

export function attachCharges<T extends HistoryRow>(rows: readonly T[], charges: readonly ChargeLike[] | null): T[] {
  // `charge: null` means "we looked and found none"; `undefined` means "we have not looked", and
  // the two must render differently — one says "no charge found", the other says nothing at all.
  if (!charges) return rows.map((r) => ({ ...r }));
  const byMatch = new Map<number, ChargeLike>();
  const byUserMatch = new Map<number, ChargeLike>();
  for (const c of charges) {
    if (c.isMembership) continue; // a subscription charge belongs to no match
    const m = c.matchId != null && /^\d+$/.test(c.matchId) ? Number(c.matchId) : null;
    const u = c.userMatchId != null && /^\d+$/.test(c.userMatchId) ? Number(c.userMatchId) : null;
    // A successful charge outranks a failed retry of the same booking on the row.
    const better = (prev: ChargeLike | undefined) =>
      !prev || (prev.status !== "succeeded" && c.status === "succeeded");
    if (m != null && better(byMatch.get(m))) byMatch.set(m, c);
    if (u != null && better(byUserMatch.get(u))) byUserMatch.set(u, c);
  }
  const asRow = (c: ChargeLike, via: ChargeOnRow["via"]): ChargeOnRow =>
    ({ id: c.id, amount: c.amount, status: c.status, created: c.created, card: c.card, via });
  return rows.map((r) => {
    const byM = r.matchId != null ? byMatch.get(r.matchId) : undefined;
    if (byM) return { ...r, charge: asRow(byM, "matchId") };
    const byU = r.umId != null ? byUserMatch.get(r.umId) : undefined;
    if (byU) return { ...r, charge: asRow(byU, "userMatchId") };
    return { ...r, charge: null };
  });
}

/** What the row prints for money. NEVER "$0.00" for an absent charge — zero is a claim. */
export function chargeLabel(row: Pick<HistoryRow, "charge">): string | null {
  if (row.charge === undefined) return null;
  if (row.charge === null) return "no charge found";
  const usd = "$" + (row.charge.amount / 100).toFixed(2);
  return row.charge.status === "succeeded" ? usd : `${usd} · ${row.charge.status}`;
}
