// The match panel's ROSTER EDIT model — pure, so the rules that matter can be tested without a
// browser and can never disagree between the preview and the request.
//
// WHY THIS EXISTS. The panel's TEAMS section used to fire every roster action the moment it was
// clicked: a move, a removal, a rename and the team count each went straight to a real player's
// record with no confirmation step and no way back. Save and Revert did not reach it, which is why
// it needed a red banner explaining that they did not. That is now gone — roster edits STAGE like
// every other section, and this model owns what "staged" means.
//
// THREE RULES CARRIED FROM THE MATCH-FIELD MODEL:
//
//  1. THE DIFF IS THE REQUEST BODY. A field touched and returned to its original value is NOT a
//     change and is not sent. normalizePending() is the only place that decides this, so the
//     "N changes" count, the pending marks and the write plan can never disagree.
//
//  2. ORDER IS LOAD-BEARING, AND THE WRITES ARE NOT ATOMIC. Team count goes FIRST: a move to team 3
//     is rejected while the match still has two teams. Renames go LAST because they are the only
//     edit that cannot invalidate another. savePlan() returns the order; the caller walks it one at
//     a time, re-reads between, and STOPS at the first failure.
//
//  3. NOTHING IS AUTO-REVERTED. A revert is another write that can also fail, and a failed revert
//     on top of a half-applied batch leaves nobody able to say what is true. Writes that landed
//     stay landed; the caller reports per write and leaves the rest pending for a deliberate retry.
//
// Writes never retry — there is no Idempotency-Key, and a duplicate move is visible to a player.

import { normalizePhone } from "./phone";

export type EditRow = {
  umId: number;
  team: number;
  playerNumber: number | null;   // NULL IS REAL in the type; it sorts LAST, never as zero
  name: string;
  phone: string | null;
  fake: boolean;
  /* THE PERSON BEHIND THE ROW. Two rows can carry the same playerId — that is what an additional
   * spot looks like, and it is the whole of the guest rule below. It is also the id the notify
   * route narrows on, so a selected row can name a recipient without the client sending a phone. */
  playerId: number;
  /* Off mdapi_subscriptions, resolved for the whole roster in ONE query by the roster route.
   * NOT off the API payload's `user.isMember`: measured across 5 production matches, that field
   * disagreed with the subscriptions mirror on 39 of 120 real rows, always by calling somebody
   * with an ACTIVE subscription a non-member. */
  member: boolean;
  email: string | null;
  /* MONEY, IN DOLLARS — converted once, in the roster route, from the cents the API returns.
   *   paid    `amount`       the spot price on this row, before the card fee
   *   charged `totalAmount`  what Stripe took, INCLUDING the card fee
   *   credit  `creditAmount` how much of it came off the player's credit balance
   * THE THREE DO NOT RECONCILE TO THE CENT and nothing here derives one from another — the
   * codebase describes the relationship in two places that disagree about the fee, and a real row
   * settles it against both: match 19104 has paid 8.00, credit 0.66, charged 7.95. */
  paid: number;
  charged: number;
  credit: number;
  /** The API's own word: PAID, FREE, WAITING. It is what separates a comped row from a shared one. */
  paidStatus: string | null;
};

/* ── THE THREE KINDS ──────────────────────────────────────────────────────────────────────────
 * MEMBER  an active subscription.
 * DAILY   no subscription. They paid for this match. The ordinary case.
 * GUEST   the SECOND (or third) row for the same person on this match — an additional spot they
 *         booked. It shares their phone and their email, which is why the notify recipient
 *         resolver has always deduped by E.164 and describes additional spots as "the same booker".
 *
 * DERIVED, NEVER STORED. Guest is a property of THIS roster, not of a person: the same player is a
 * guest on the match where they booked twice and an ordinary daily player on every other one.
 * A FAKE ROW HAS NO KIND — it is padding, not a person who is or is not a member. */
export type PlayerKind = "member" | "daily" | "guest";

const forKinds = (a: EditRow, b: EditRow) =>
  a.team - b.team
  || (a.playerNumber ?? Number.MAX_SAFE_INTEGER) - (b.playerNumber ?? Number.MAX_SAFE_INTEGER)
  || a.umId - b.umId;

export function playerKinds(rows: EditRow[]): Map<number, PlayerKind> {
  const seen = new Set<number>();
  const out = new Map<number, PlayerKind>();
  /* READ IN THE ORDER THE PANEL DRAWS THEM, so the row that reads Guest is the second one down the
   * screen and not whichever the API happened to return first. */
  for (const r of [...rows].sort(forKinds)) {
    if (r.fake) continue;
    if (seen.has(r.playerId)) { out.set(r.umId, "guest"); continue; }
    seen.add(r.playerId);
    out.set(r.umId, r.member ? "member" : "daily");
  }
  return out;
}

/* ── WHAT A ROW'S MONEY CELL SAYS ─────────────────────────────────────────────────────────────
 * `on-booking` is the row that was paid for on ANOTHER row of the same person's booking. It is not
 * the same thing as a comped row, and both are zero, so zero alone cannot tell them apart:
 * the API marks a shared spot PAID with no payment intent, and a comped one FREE.
 *
 * THE MONEY BELONGS TO THE ROW, AND THE ROW'S OWN AMOUNT IS ALWAYS SAFE TO ADD UP. Measured on
 * production: user 89343 on match 18281 booked two spots on ONE charge and the API put 24.00 on the
 * first row and 0 on the second — but user 74713 on match 18343 has FOUR rows and THREE payment
 * intents, 24.00 + 0 + 12.00 + 12.00, because they came back and booked again. Treating every
 * repeat as "already paid for on the booking" and dropping it from the total would report that
 * match 24.00 when 48.00 was taken. The API never puts the same money on two rows, so summing every
 * row's own amount is both safe and the only correct rule. */
export type MoneyKind = "paid" | "free" | "on-booking" | "fake";

export function moneyKinds(rows: EditRow[]): Map<number, MoneyKind> {
  const paying = new Set<number>();
  for (const r of rows) if (!r.fake && r.paid > 0) paying.add(r.playerId);
  const out = new Map<number, MoneyKind>();
  for (const r of [...rows].sort(forKinds)) {
    if (r.fake) { out.set(r.umId, "fake"); continue; }
    if (r.paid > 0) { out.set(r.umId, "paid"); continue; }
    /* Zero, and somebody with this player's id DID pay on this match — so this spot rode in on
     * that booking rather than being given away. */
    if (paying.has(r.playerId)) { out.set(r.umId, "on-booking"); continue; }
    out.set(r.umId, "free");
  }
  return out;
}

/* THE ONE MONEY FORMATTER FOR THIS PANEL, and it lives here rather than in the component on
 * purpose: money-input-test forbids `toFixed(2)}` inside MatchPanel, because binding a formatted
 * string into a field's value is the reformat-on-every-keystroke bug that made "9.00" impossible to
 * edit. These are read-only figures, but the guard is a source check and it is right to be blunt —
 * so the formatting happens out here and the panel keeps no way to reformat anything. */
export const usd = (n: number): string => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
export const usdPlain = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

export type MoneySum = { booked: number; charged: number; credit: number; rows: number };

/** Adds up the rows given. Every figure is a sum of one real column; none is derived from another. */
export const sumMoney = (rows: EditRow[]): MoneySum => rows.reduce(
  (a, r) => ({ booked: a.booked + r.paid, charged: a.charged + r.charged, credit: a.credit + r.credit, rows: a.rows + 1 }),
  { booked: 0, charged: 0, credit: 0, rows: 0 },
);

/** One team's own rows, added up. */
export const teamMoney = (rows: EditRow[], teamNumber: number): MoneySum =>
  sumMoney(rows.filter((r) => r.team === teamNumber));

/* WHAT THE ROSTER IS MADE OF, counted in SPOTS rather than people. A player holding two spots is
 * counted twice, because the line describes the field and not the address book — which is the
 * opposite of the text count beside it, where two spots on one phone is one message. The two
 * numbers disagree on purpose and each says which it means.
 *
 * Fakes are not counted: they hold a spot but they are not a member, a daily or a guest, and the
 * three figures are meant to add up to the real spots on the roster. */
export type RosterCounts = { members: number; daily: number; guests: number; real: number; fake: number };

export function rosterCounts(rows: EditRow[]): RosterCounts {
  const kinds = playerKinds(rows);
  let members = 0, daily = 0, guests = 0, fake = 0;
  for (const r of rows) {
    if (r.fake) { fake++; continue; }
    const k = kinds.get(r.umId);
    if (k === "member") members++;
    else if (k === "guest") guests++;
    else daily++;
  }
  return { members, daily, guests, real: members + daily + guests, fake };
}

/** How many of one team's own rows are members. Counted from the rows, never passed in. */
export const teamMemberCount = (rows: EditRow[], teamNumber: number): number => {
  const kinds = playerKinds(rows);
  return rows.filter((r) => r.team === teamNumber && kinds.get(r.umId) === "member").length;
};

/* HOW MANY TEXTS A SELECTION IS. One person with two spots is one text, and the panel must never
 * label a button with the row count — the number that matters is the number of phones. */
export const textsForSelection = (rows: EditRow[], selected: Set<number>): { texts: number; rows: number; noPhone: number } => {
  const picked = rows.filter((r) => selected.has(r.umId) && !r.fake);
  const phones = new Set<string>();
  let noPhone = 0;
  for (const r of picked) {
    /* THE SAME NORMALIZER THE SEND USES. Stripping punctuation by hand counted "+15125551000" and
     * "(512) 555-1000" as two people and would have promised two texts where the route sends one —
     * the panel's number has to be the route's number, not a second opinion about it. */
    const e164 = normalizePhone(r.phone);
    if (!e164) { noPhone++; continue; }
    phones.add(e164);
  }
  return { texts: phones.size, rows: picked.length, noPhone };
};
export type EditTeam = { id: number; teamNumber: number; name: string };
export type RosterOrigin = { rows: EditRow[]; teams: EditTeam[] };

export type MoveTarget = { team: number; playerNumber: number };
export type Pending = {
  teamCount: number | null;                 // null = unchanged
  moves: Record<number, MoveTarget>;        // umId → where it will land
  removes: number[];                        // umIds
  names: Record<number, string>;            // teamId → new name
};

export const emptyPending = (): Pending => ({ teamCount: null, moves: {}, removes: [], names: {} });

const teamCountOf = (o: RosterOrigin) => o.teams.length;

// ── RULE 1 — drop everything that is not actually a change ───────────────────────────────────────
// Called on every read of pending state, so a no-op edit can never reach the count, the marks or
// the request body. It also resolves the interactions BETWEEN pending edits, which is the part that
// is easy to get wrong:
//   • a move onto the row's own current team+spot is not a change
//   • a rename to the committed name is not a change
//   • a move belonging to a row that is also being REMOVED is dropped — sending a move for a row
//     you are about to delete is a wasted write against a real player
//   • a move onto a team that a pending team-count REDUCTION is about to delete is dropped, because
//     team count applies first and that move would be sent into a team that no longer exists
export function normalizePending(p: Pending, origin: RosterOrigin): Pending {
  const byUm = new Map(origin.rows.map((r) => [r.umId, r]));
  const liveTeams = p.teamCount ?? teamCountOf(origin);

  const removes = p.removes.filter((um) => byUm.has(um));
  const removed = new Set(removes);

  const moves: Record<number, MoveTarget> = {};
  for (const [k, t] of Object.entries(p.moves)) {
    const um = Number(k);
    const row = byUm.get(um);
    if (!row || removed.has(um)) continue;                       // gone, or being removed
    if (t.team > liveTeams) continue;                            // the target team will not exist
    if (row.team === t.team && row.playerNumber === t.playerNumber) continue; // back where it started
    moves[um] = t;
  }

  const names: Record<number, string> = {};
  for (const [k, v] of Object.entries(p.names)) {
    const id = Number(k);
    const team = origin.teams.find((t) => t.id === id);
    const nm = v.trim();
    if (!team || nm === "" || nm === team.name) continue;
    names[id] = nm;
  }

  const teamCount = p.teamCount != null && p.teamCount !== teamCountOf(origin) ? p.teamCount : null;
  return { teamCount, moves, removes, names };
}

export function pendingCount(p: Pending, origin: RosterOrigin): number {
  const n = normalizePending(p, origin);
  return (n.teamCount != null ? 1 : 0) + Object.keys(n.moves).length + n.removes.length + Object.keys(n.names).length;
}

// Where a row will BE once the pending edits are applied. Sorting reads this, not the stored row,
// so the list reads the way it will look after Save rather than the way the API last returned it.
export function effectiveRow(row: EditRow, p: Pending, origin: RosterOrigin): { team: number; playerNumber: number | null; moved: boolean; removed: boolean } {
  const n = normalizePending(p, origin);
  const mv = n.moves[row.umId];
  return {
    team: mv ? mv.team : row.team,
    playerNumber: mv ? mv.playerNumber : row.playerNumber,
    moved: !!mv,
    removed: n.removes.includes(row.umId),
  };
}

export type SortedRow = {
  row: EditRow;
  spot: number | null;
  moved: boolean;
  removed: boolean;
  collision: boolean;   // another row on this team holds the SAME spot number
};

// ── ITEM 5 — one team's roster, in the order a human reads it ────────────────────────────────────
// The API returns whatever order it likes: measured on production, 55 of 95 teams (58%) came back
// NOT in ascending spot order — e.g. [9,6,4,7,2] and [6,3,1,4,8,7,5].
//
// A NULL SPOT SORTS LAST, NOT AS ZERO. Treating null as 0 would park an unnumbered player at the
// top of the team, above spot 1, which reads as "first" — the opposite of what it means.
//
// A DUPLICATE SPOT IS NOT HIDDEN. The move control writes playerNumber, so two rows sharing a
// number is a real problem; silently rendering one of them lets it survive. They sort ADJACENT (a
// numeric sort already does that) and both are marked. Measured on production, 0 of 95 teams had a
// duplicate among the rows the panel actually renders — every duplicate in the raw payload came
// from hidden WAITING retries — so this marks a state that is rare, not routine, and would
// otherwise be invisible precisely because it is rare.
export function sortedTeam(origin: RosterOrigin, p: Pending, teamNumber: number): SortedRow[] {
  const n = normalizePending(p, origin);
  const here = origin.rows
    .map((row) => ({ row, eff: effectiveRow(row, n, origin) }))
    .filter((x) => x.eff.team === teamNumber);

  const counts = new Map<number, number>();
  for (const x of here) if (x.eff.playerNumber != null) counts.set(x.eff.playerNumber, (counts.get(x.eff.playerNumber) ?? 0) + 1);

  return here
    .map(({ row, eff }): SortedRow => ({
      row,
      spot: eff.playerNumber,
      moved: eff.moved,
      removed: eff.removed,
      collision: eff.playerNumber != null && (counts.get(eff.playerNumber) ?? 0) > 1,
    }))
    .sort((a, b) => {
      if (a.spot == null && b.spot == null) return a.row.umId - b.row.umId;
      if (a.spot == null) return 1;    // nulls LAST
      if (b.spot == null) return -1;
      return a.spot - b.spot || a.row.umId - b.row.umId; // stable within a collision
    });
}

// The spots of one team, for the move picker's second step. An occupied spot is offered, not
// blocked — picking it is a SWAP, which is the same gesture as picking an empty one.
export type PickSpot = { n: number; who: EditRow | null };
export function spotsOfTeam(origin: RosterOrigin, p: Pending, teamNumber: number, capacity: number): PickSpot[] {
  const rows = sortedTeam(origin, p, teamNumber).filter((s) => !s.removed);
  const out: PickSpot[] = [];
  for (let i = 1; i <= Math.max(capacity, 0); i++) out.push({ n: i, who: rows.find((s) => s.spot === i)?.row ?? null });
  return out;
}

// A move onto an OCCUPIED spot is a SWAP: two pending moves, the occupant taking the mover's old
// place. Staged, so both land in the same Save — but still as two separate writes, because the API
// has no swap and no transaction.
export function planMove(p: Pending, origin: RosterOrigin, mover: EditRow, toTeam: number, toSpot: number): Pending {
  const occupant = sortedTeam(origin, p, toTeam).find((s) => s.spot === toSpot && !s.removed && s.row.umId !== mover.umId)?.row;
  const from = effectiveRow(mover, p, origin);
  const moves = { ...p.moves, [mover.umId]: { team: toTeam, playerNumber: toSpot } };
  if (occupant) moves[occupant.umId] = { team: from.team, playerNumber: from.playerNumber ?? toSpot };
  return normalizePending({ ...p, moves }, origin);
}

// ── RULE 2 — the write plan, in the only order that can work ─────────────────────────────────────
export type PlannedWrite =
  | { kind: "shape"; label: string; fields: { teamNumbers: number } }
  | { kind: "move"; label: string; umId: number; team: number; playerNumber: number }
  | { kind: "remove"; label: string; umId: number }
  | { kind: "teams"; label: string; teamId: number; fields: { name: string } };

export function savePlan(p: Pending, origin: RosterOrigin): PlannedWrite[] {
  const n = normalizePending(p, origin);
  const byUm = new Map(origin.rows.map((r) => [r.umId, r]));
  const out: PlannedWrite[] = [];

  // 1 — TEAM COUNT FIRST. Every move below may name a team that does not exist yet.
  if (n.teamCount != null) out.push({ kind: "shape", label: `Set ${n.teamCount} teams`, fields: { teamNumbers: n.teamCount } });

  // 2 — moves and removals, ONE PLAYER AT A TIME. Deterministic order (by umId) so a retry after a
  //     partial failure walks the same sequence rather than a fresh shuffle.
  for (const um of Object.keys(n.moves).map(Number).sort((a, b) => a - b)) {
    const t = n.moves[um];
    out.push({ kind: "move", label: `Move ${byUm.get(um)?.name ?? `user-match ${um}`} to team ${t.team} spot ${t.playerNumber}`, umId: um, team: t.team, playerNumber: t.playerNumber });
  }
  for (const um of [...n.removes].sort((a, b) => a - b)) {
    out.push({ kind: "remove", label: `Remove ${byUm.get(um)?.name ?? `user-match ${um}`}`, umId: um });
  }

  // 3 — renames LAST: the only edit that cannot invalidate another.
  for (const id of Object.keys(n.names).map(Number).sort((a, b) => a - b)) {
    const t = origin.teams.find((x) => x.id === id);
    out.push({ kind: "teams", label: `Rename team ${t?.teamNumber ?? id} to “${n.names[id]}”`, teamId: id, fields: { name: n.names[id] } });
  }
  return out;
}

// Drop the edits a write has just applied, so what remains pending is exactly what did NOT land.
// Never used to "undo" anything — it only forgets an intention that is now reality.
export function clearApplied(p: Pending, w: PlannedWrite): Pending {
  if (w.kind === "shape") return { ...p, teamCount: null };
  if (w.kind === "move") { const moves = { ...p.moves }; delete moves[w.umId]; return { ...p, moves }; }
  if (w.kind === "remove") return { ...p, removes: p.removes.filter((x) => x !== w.umId) };
  const names = { ...p.names }; delete names[w.teamId]; return { ...p, names };
}

// ── THE CONSEQUENCE LINE, before the click ───────────────────────────────────────────────────────
// Same pattern as the manager-pay screen: say what this does to real people BEFORE it is chosen,
// not in a dialog after. Returns null when the choice costs nothing.
/* ── SWITCHING TEAM COUNT MUST CARRY THE CAPACITY WITH IT ─────────────────────────────────────
 *
 * WHAT WENT WRONG, on production match 18125 (San Antonio, 28 players) on 2026-08-28. The team
 * count went 2 -> 4 and the ONLY thing on the wire was:
 *
 *     PUT /admin/matches/18125   {"teamNumbers": 4}          <- change_log, outcome "landed"
 *
 * The API changes nothing else: proven on staging, where PUT {teamNumbers:4} moved a match from 2
 * teams to 4 and left maxPlayerCount, maxTeamSize2Team and maxTeamSize4Team exactly as they were.
 * So the match landed in 4-team mode reading a maxTeamSize4Team NOBODY HAD EVER SET for it, and the
 * player app divided that stale total by 4. A total that is not a multiple of 4 shows a FRACTIONAL
 * team size — 22/4 = 5.5 — which is what the players saw.
 *
 * THE TOTALS ARE TOTALS. maxTeamSize2Team and maxTeamSize4Team are the WHOLE match, not per side:
 * a 9-a-side 4-team match stores 36, not 9. This is the trap that a "10 x 10" control sending 20
 * is on record for, and it is the reason this function exists rather than a line at the call site.
 *
 * SO A TEAM-COUNT CHANGE WRITES THE MODE'S TOTAL IN THE SAME SAVE. Never leave the mode you are
 * switching INTO holding a number nobody chose.
 *
 * THREE TEAMS HAS NO RUNG. The API models only maxTeamSize2Team and maxTeamSize4Team, so a 3-team
 * match's capacity lives in maxPlayerCount alone — confirmed on 28 live 3-team matches. We still
 * write maxPlayerCount; there is simply no rung field to write beside it. */
export function teamCountWrites(target: number, perTeam: number): Record<string, number> {
  const total = Math.max(target, Math.round(perTeam) * target);
  const out: Record<string, number> = { maxPlayerCount: total };
  if (target === 2) out.maxTeamSize2Team = total;
  else if (target === 4) out.maxTeamSize4Team = total;
  return out;
}

/* THE BLOCK. The player app can render a fractional team size; Clubhouse must never be able to
 * produce one. A total that does not divide by the team count is refused with the reason on
 * screen, not rounded into something nobody asked for. */
export function teamShapeError(total: number, teamCount: number): string | null {
  if (!Number.isFinite(total) || !Number.isFinite(teamCount) || teamCount <= 0) return null;
  if (total % teamCount !== 0) {
    return `${total} spots does not divide into ${teamCount} teams — that shows as ${(total / teamCount).toFixed(1)} players per team in the app. Pick a total that is a multiple of ${teamCount}.`;
  }
  return null;
}

/* THE REDUCE-2 BRANCH. `Reduce to 2 teams` moves every real player itself before it touches the
 * shape, so unlike the staged team-count change below it CAN say where everyone goes — and its
 * numbers must come from that plan, not from a second count taken here. Passing these facts is the
 * only way to get that sentence; without them the function behaves exactly as it always has, which
 * is what the staged control needs, because on that path the server really does decide.
 *
 * `fromTeamCount` rides along because the caller with a plan has the match, not a RosterOrigin. */
export type ReduceFacts = { fromTeamCount: number; fakes: number; movers: number; perTeam: number };

export function teamCountConsequence(origin: RosterOrigin, p: Pending, target: number, reduce?: ReduceFacts): string | null {
  const now = reduce ? reduce.fromTeamCount : teamCountOf(origin);
  if (target === now) return null;
  if (target > now) {
    const added = Array.from({ length: target - now }, (_, i) => now + i + 1);
    return `Teams ${added.join(" and ")} are added, empty. Nobody moves.`;
  }
  const gone = Array.from({ length: now - target }, (_, i) => target + i + 1);
  const kept = Array.from({ length: target }, (_, i) => i + 1);
  const teamsGo = `Team${gone.length === 1 ? "" : "s"} ${gone.join(" and ")} ${gone.length === 1 ? "is" : "are"} removed`;
  if (reduce) {
    return `${teamsGo}. ${reduce.fakes} fake${reduce.fakes === 1 ? "" : "s"} come${reduce.fakes === 1 ? "s" : ""} out, ` +
      `${reduce.movers} real player${reduce.movers === 1 ? "" : "s"} move${reduce.movers === 1 ? "s" : ""} into ` +
      `team${kept.length === 1 ? "" : "s"} ${kept.join(" and ")}, and the match becomes ${target} teams of ${reduce.perTeam}. ` +
      `Nobody is dropped. This is not auto-bump.`;
  }
  const n = normalizePending({ ...p, teamCount: null }, origin);
  const affected = origin.rows.filter((r) => !n.removes.includes(r.umId) && effectiveRow(r, n, origin).team > target);
  const dropped = Object.keys(n.moves).map(Number).filter((um) => n.moves[um].team > target).length;
  return `${teamsGo}; ` +
    `${affected.length} player${affected.length === 1 ? "" : "s"} move to team${kept.length === 1 ? "" : "s"} ${kept.join(" and ")} — ` +
    `the SERVER decides where, and Clubhouse cannot say in advance.` +
    (dropped > 0 ? ` ${dropped} pending move${dropped === 1 ? "" : "s"} to a removed team will be dropped.` : "");
}
