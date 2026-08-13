// Phase 26 — the pure model behind Manager Check-In. No React, no fetching.
// Ported rule-for-rule from docs/mockups/cin-v1_1.html (2 teams) and cin4-v1_2.html (4 teams);
// the mockups carry the reasoning in comments and this file keeps it.

export type MarkStatus = "ok" | "late" | "no_show";

// THE WEIGHT IS OURS. Part 0 found no evidence the server derives a weight from a status (the one
// live strikeLog carried penaltyPoint 1; nothing showed a 2), so this map is the single place the
// rule exists. It is stored on the row as strike_value at mark time, so a later change to this map
// cannot silently rewrite what was already applied.
export const WEIGHT: Record<MarkStatus, number> = { ok: 0, late: 1, no_show: 2 };
export const LABEL: Record<MarkStatus, string> = { ok: "On time", late: "Late", no_show: "No show" };
export const GLYPH: Record<MarkStatus, string> = { ok: "✓", late: "◴", no_show: "✕" };

export const strikeValueFor = (s: MarkStatus): number => WEIGHT[s];

// ── names ───────────────────────────────────────────────────────────────────
// A manager on a touchline says "Ravi C.", not "Ravi Chandrasekaran". A name that will not fit is
// SHORTENED THE WAY A PERSON WOULD, never chopped mid-word: "Marcus O." is readable, "Marcu…" is
// not. Search still matches the FULL name, so nothing is lost by shortening the display.
const GUEST_RX = /\s*\((guest|gu\.?|g)\)\s*$/i;
export function displayName(full: string): { name: string; guest: boolean } {
  const guest = GUEST_RX.test(full ?? "");
  const base = (full ?? "").replace(GUEST_RX, "").trim();
  if (base.length <= 15) return { name: base, guest };
  const w = base.split(/\s+/);
  if (w.length === 1) return { name: base, guest };
  return { name: `${w[0]} ${w[w.length - 1][0].toUpperCase()}.`, guest };
}

// Two letters, and a stable colour per person — the same player looks the same every week. A
// colour that reshuffles is worse than no colour, because the manager stops trusting it.
export function initials(n: string): string {
  return (n ?? "").replace(/[^a-zA-Z ]/g, "").trim().split(/\s+/).slice(0, 2)
    .map((w) => (w[0] ? w[0].toUpperCase() : "")).join("") || "?";
}
export const AVATAR_COLORS = ["#8fd6a8", "#f0c987", "#e79f92", "#9fc4e8", "#d6b6e0", "#93d9cf", "#e8c0a0", "#b9d59a"];
export function avatarColor(n: string): string {
  const sum = [...(n ?? "")].reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

// Search matches the FULL name even when the row shows a shortened one.
export function matchesSearch(fullName: string, q: string): boolean {
  const needle = (q ?? "").trim().toLowerCase();
  if (!needle) return true;
  return (fullName ?? "").toLowerCase().includes(needle);
}

// ── capacity ────────────────────────────────────────────────────────────────
// PER-TEAM SIZE IS READ FROM THE MATCH. maxTeamSize2Team / maxTeamSize4Team are TOTALS, not
// per-side — proven on production match 17522: maxPlayerCount 36, maxTeamSize2Team 18,
// maxTeamSize4Team 36, teams 4 → 36 ÷ 4 = 9 per team. The mockups hardcode 9 and 10 as stand-ins;
// this function is why that never ships.
export function perTeamCapacity(m: {
  teamCount: number;
  maxTeamSize2Team?: number | null;
  maxTeamSize4Team?: number | null;
  maxPlayerCount?: number | null;
}): number | null {
  const n = Number(m.teamCount) || 0;
  if (n <= 0) return null;
  const total = n >= 4
    ? (m.maxTeamSize4Team ?? m.maxPlayerCount ?? null)
    : (m.maxTeamSize2Team ?? m.maxPlayerCount ?? null);
  if (total == null || !Number.isFinite(Number(total))) return null;
  const per = Math.floor(Number(total) / n);
  return per > 0 ? per : null;
}

// ── the list ────────────────────────────────────────────────────────────────
export type CheckinPlayer = {
  userMatchId: number;
  playerId: number;
  fullName: string;
  team: number | null;
  playerNumber: number | null;
  avatar: string | null;
  userType?: string | null;       // PLAYER | ADDITIONAL_SPOT | GUEST
  status: MarkStatus | null;      // null = unmarked
  sync?: "idle" | "pending" | "failed";
};
export type ListFilter = "todo" | "all" | MarkStatus;

// TO-DO IS THE DEFAULT VIEW and the list SHRINKS as the manager works — at a match the hard
// problem is finding a person, not marking them.
export function filterPlayers(players: CheckinPlayer[], filter: ListFilter, q = ""): CheckinPlayer[] {
  return players.filter((p) => {
    if (!matchesSearch(p.fullName, q)) return false;
    if (filter === "all") return true;
    if (filter === "todo") return !p.status;
    return p.status === filter;
  });
}

export const markedCount = (ps: CheckinPlayer[]) => ps.filter((p) => p.status).length;
export const todoCount = (ps: CheckinPlayer[]) => ps.filter((p) => !p.status).length;

// A team whose players are ALL marked collapses itself; the manager can re-open it and that choice
// sticks (the override is held by the caller, which is why it is a parameter here).
export function teamIsFinished(players: CheckinPlayer[], team: number): boolean {
  const on = players.filter((p) => p.team === team);
  return on.length > 0 && on.every((p) => !!p.status);
}
export function teamCollapsed(players: CheckinPlayer[], team: number, reopened: ReadonlySet<number>): boolean {
  return teamIsFinished(players, team) && !reopened.has(team);
}

// TAP-AGAIN-TO-CLEAR is the undo: tapping the mark a player already has returns null, at the same
// thumb position, with no dialog.
export function nextStatus(current: MarkStatus | null, tapped: MarkStatus): MarkStatus | null {
  return current === tapped ? null : tapped;
}

// The spot grid: every spot 1..capacity, with whoever holds it. An open spot and a swap are the
// same gesture, which is why both come out of one structure.
export type Spot = { n: number; who: CheckinPlayer | null };
export function spotGrid(players: CheckinPlayer[], team: number, capacity: number): Spot[] {
  const held = players.filter((p) => p.team === team);
  const out: Spot[] = [];
  for (let n = 1; n <= capacity; n++) out.push({ n, who: held.find((p) => p.playerNumber === n) ?? null });
  return out;
}

// A move onto an OCCUPIED spot is a SWAP — two writes, and there is no transaction. The plan is
// returned as an ordered list so the caller can perform them ONE AT A TIME, re-read between, and
// STOP if the second fails rather than attempting a third write to "fix" it.
export type MovePlan = { steps: Array<{ userMatchId: number; team: number; playerNumber: number }>; isSwap: boolean };
export function planMove(mover: CheckinPlayer, toTeam: number, toSpot: number, occupant: CheckinPlayer | null): MovePlan {
  if (!occupant || occupant.userMatchId === mover.userMatchId) {
    return { steps: [{ userMatchId: mover.userMatchId, team: toTeam, playerNumber: toSpot }], isSwap: false };
  }
  return {
    isSwap: true,
    steps: [
      { userMatchId: mover.userMatchId, team: toTeam, playerNumber: toSpot },
      { userMatchId: occupant.userMatchId, team: mover.team ?? toTeam, playerNumber: mover.playerNumber ?? toSpot },
    ],
  };
}
