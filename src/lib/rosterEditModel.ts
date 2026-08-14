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

export type EditRow = {
  umId: number;
  team: number;
  playerNumber: number | null;   // NULL IS REAL in the type; it sorts LAST, never as zero
  name: string;
  phone: string | null;
  fake: boolean;
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
export function teamCountConsequence(origin: RosterOrigin, p: Pending, target: number): string | null {
  const now = teamCountOf(origin);
  if (target === now) return null;
  if (target > now) {
    const added = Array.from({ length: target - now }, (_, i) => now + i + 1);
    return `Teams ${added.join(" and ")} are added, empty. Nobody moves.`;
  }
  const n = normalizePending({ ...p, teamCount: null }, origin);
  const affected = origin.rows.filter((r) => !n.removes.includes(r.umId) && effectiveRow(r, n, origin).team > target);
  const gone = Array.from({ length: now - target }, (_, i) => target + i + 1);
  const kept = Array.from({ length: target }, (_, i) => i + 1);
  const dropped = Object.keys(n.moves).map(Number).filter((um) => n.moves[um].team > target).length;
  return `Team${gone.length === 1 ? "" : "s"} ${gone.join(" and ")} ${gone.length === 1 ? "is" : "are"} removed; ` +
    `${affected.length} player${affected.length === 1 ? "" : "s"} move to team${kept.length === 1 ? "" : "s"} ${kept.join(" and ")} — ` +
    `the SERVER decides where, and Clubhouse cannot say in advance.` +
    (dropped > 0 ? ` ${dropped} pending move${dropped === 1 ? "" : "s"} to a removed team will be dropped.` : "");
}
