// STAFF APP MATCH v2: the pure rules (Ryan, 2026-10-30). The routes under /api/app/{env}/matches/{id}
// call the desktop write handlers; this file only decides WHICH desktop path a request takes, what
// the app may offer, and how a read-back is worded. No I/O, so scripts/app-match-v2-test.ts can
// assert every rule offline.

import { TEAM_SIZE_MAX, TEAM_SIZE_MIN, teamCountWrites, teamShapeError, teamSizes } from "./rosterEditModel";
export { TEAM_SIZE_MAX as SIZE_MAX, TEAM_SIZE_MIN as SIZE_MIN };
const REDUCE_MIN_PER_TEAM = TEAM_SIZE_MIN, REDUCE_MAX_PER_TEAM = TEAM_SIZE_MAX;

/* WHICH DESKTOP PATH A TEAM COUNT CHANGE TAKES. Ryan: "use the desktop's exact paths (the
 * teamNumbers picker, Convert to 4, Reduce to 2), no custom spreading."
 *   2 -> 4        Convert to 4 (convert-4 refuses anything but a 2-team match)
 *   3 or 4 -> 2   Reduce to 2 (reduce-2 refuses a match with 2 or fewer teams)
 *   anything else the staged picker: PUT {teamNumbers}, then the capacity, as the desktop Save does */
export type TeamsPath = "picker" | "convert-4" | "reduce-2";
export function teamsPath(current: number, target: number): TeamsPath | null {
  if (![2, 3, 4].includes(target) || current === target) return null;
  if (current === 2 && target === 4) return "convert-4";
  if (target === 2 && current > 2) return "reduce-2";
  return "picker";
}

/* THE PICKER'S CAPACITY WRITE WHEN NO SIZE WAS CHOSEN (an app build from before 2026-11-05), exactly
 * what the desktop stages (MatchPanel stageTeamCount): the current per-team figure carried into the
 * new count, through teamCountWrites, which writes the new mode's rung for 2 and 4 and only
 * maxPlayerCount for 3. A capacity that does not divide by the current count has no honest per-team
 * figure, so nothing is written beside the count, as on the desktop. Only keys whose value changes
 * are returned: the desktop PUT sends the diff. With a chosen size the write is sizeWrites. */
export function pickerCapacityWrites(match: Record<string, unknown>, current: number, target: number): Record<string, number> {
  const cap = Number(match.maxPlayerCount) || 0;
  if (current <= 0 || cap % current !== 0) return {};
  const per = cap / current;
  const rungKey = target === 2 ? "maxTeamSize2Team" : target === 4 ? "maxTeamSize4Team" : null;
  const rung = rungKey ? Number(match[rungKey]) : null;
  const w = teamCountWrites(target, per, Number.isFinite(rung) ? rung : null);
  return Object.fromEntries(Object.entries(w).filter(([k, v]) => Number(match[k]) !== v));
}

/* THE TEAM SIZE STEPPER AND THE ADJUST SHEET'S CHIPS. Ryan: "for 2 and 4 teams write the stored team
 * size; for 3 teams write the total and show size as total divided by 3. Only offer values the
 * desktop's teamShapeError accepts." EVERY TEAM SIZE CONTROL OFFERS 6 TO 12 A SIDE (Ryan, 2026-11-02):
 * the Match screen stepper, the Adjust chips (SIZE_CHIPS, the same for every team count), the
 * desktop's SPOTS PER TEAM and its format dropdowns, and Reduce to 2.
 *
 * ONLY REAL PLAYERS BLOCK A SIZE (Ryan, 2026-11-02). A size is refused when the real players on any
 * team, or all of them together, would not fit. Fakes never block it: a smaller size first takes the
 * fakes off the teams that would overflow (overflowFakes), as "Fakes leave the roster first" says. */
export const SIZE_CHIPS = [6, 7, 8, 9, 10, 11, 12] as const;
export function sizeBounds(teamCount: number, teamReals: readonly number[]): { min: number; max: number } {
  return { min: Math.max(REDUCE_MIN_PER_TEAM, ...teamReals), max: REDUCE_MAX_PER_TEAM };
}
export function sizeRefusal(teamCount: number, perTeam: number, teamReals: readonly number[], realTotal = 0): string | null {
  if (!Number.isInteger(perTeam) || perTeam < 1) return "Team size must be a whole number of players.";
  const b = sizeBounds(teamCount, teamReals);
  if (perTeam < REDUCE_MIN_PER_TEAM) return `The smallest team size is ${REDUCE_MIN_PER_TEAM} a side.`;
  if (perTeam > b.max) return `The largest team size is ${b.max} a side.`;
  if (perTeam < b.min) return `A team has ${b.min} real players, so the size cannot go below ${b.min} a side.`;
  if (realTotal > perTeam * teamCount) return `${realTotal} real players do not fit ${teamCount} teams of ${perTeam}.`;
  return teamShapeError(perTeam * teamCount, teamCount);
}
/** The fakes a smaller size takes off first: on each team, every fake on a bib above the new size
 *  (a bib 10 left from 12 a side would otherwise sit on a 9-a-side team), then as many more as the
 *  team still holds past the size, highest bib first. Never a real player; null when a team's real
 *  players alone overflow it. */
export function overflowFakes(players: readonly { userMatchId: number | null; team: number | null; bib: number | null; fake: boolean }[], perTeam: number): number[] | null {
  const out: number[] = [];
  const teams = new Set(players.map((p) => p.team).filter((t): t is number => t != null));
  for (const t of teams) {
    const on = players.filter((p) => p.team === t);
    const fakes = on.filter((p) => p.fake && p.userMatchId != null).sort((a, b) => (b.bib ?? 0) - (a.bib ?? 0));
    const high = fakes.filter((p) => (p.bib ?? 0) > perTeam);
    const over = on.length - perTeam - high.length;
    const rest = fakes.filter((p) => (p.bib ?? 0) <= perTeam);
    if (over > rest.length) return null;
    out.push(...high.map((p) => p.userMatchId as number), ...rest.slice(0, Math.max(0, over)).map((p) => p.userMatchId as number));
  }
  return out;
}
/** The size write: the desktop's own teamCountWrites, diffed against the match. */
export function sizeWrites(match: Record<string, unknown>, teamCount: number, perTeam: number): Record<string, number> {
  const rungKey = teamCount === 2 ? "maxTeamSize2Team" : teamCount === 4 ? "maxTeamSize4Team" : null;
  const rung = rungKey ? Number(match[rungKey]) : null;
  const w = teamCountWrites(teamCount, perTeam, Number.isFinite(rung) ? rung : null);
  return Object.fromEntries(Object.entries(w).filter(([k, v]) => Number(match[k]) !== v));
}

/* THE SIZES A TEAM COUNT CHANGE MAY OFFER: 6 TO 12 A SIDE ON EVERY PATH (Ryan, 2026-11-05). Reduce
 * to 2 had the rule since 2026-10-31 (never capped at the current size since 2026-11-02); Convert
 * to 4 and the 3-team picker carried the current per-side figure instead, so a 22-spot match could
 * only become 4 x 11. One rule now, rosterEditModel's teamSizes: every size where target x size
 * holds all the real players, never below the team with the most real players among the teams that
 * keep their players through the change. Which teams those are depends on the path:
 *   convert-4   the desktop deals every real player over 4 teams again, so none;
 *   reduce-2    the desktop plan moves whoever must move, so none;
 *   picker      nobody moves: the teams that survive (1 to target) keep everyone on them.
 * Fakes never block a size: they come off first and follow the stored spots left afterwards. */
export function teamChangeSizes(path: TeamsPath, target: number, real: number, teamReals: readonly { teamNumber: number; real: number }[]): { sizes: number[]; reason: string | null } {
  const kept = path === "picker" ? teamReals.filter((t) => t.teamNumber <= target).map((t) => t.real) : [];
  return teamSizes(target, real, kept);
}
/** Reduce to 2's own list: the shared rule at 2 teams. */
export const reduceSizes = (real: number): { sizes: number[]; reason: string | null } => teamSizes(2, real);

/* WHAT AN ADD COST, read off the roster row AFTER the add. Clubhouse sends no price and no credit;
 * MatchDay decides. Cents on the wire. Never a prediction: Ryan, "After the add, read the roster row
 * back and show the money result". */
export function moneyLine(row: { paidStatus?: unknown; amount?: unknown; totalAmount?: unknown; creditAmount?: unknown } | null): string {
  if (!row) return "Added · not on the roster when read back";
  const total = Number(row.totalAmount) || 0, credit = Number(row.creditAmount) || 0;
  const usd = (c: number) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
  const parts: string[] = [];
  if (total > 0) parts.push(`charged ${usd(total)}`);
  if (credit > 0) parts.push(`${usd(credit)} credit used`);
  if (parts.length === 0) return String(row.paidStatus ?? "").toUpperCase() === "FREE" || String(row.paidStatus ?? "") === "" ? "Added · free" : `Added · ${String(row.paidStatus).toLowerCase()}, nothing charged`;
  return `Added · ${parts.join(", ")}`;
}

/* SEARCH TERMS. Ryan: "search by phone, email or player ID". A short run of digits is an id; a
 * longer one is a phone, matched by MatchDay's own ?email= parameter, which matches email AND phone
 * digits (docs/matchday-api-facts.md). Formatting characters are dropped from a phone first. */
export type SearchTerm = { kind: "id"; id: string } | { kind: "phone"; digits: string } | { kind: "email"; text: string } | null;
export function searchTerm(raw: string): SearchTerm {
  const t = raw.trim();
  if (t.includes("@") || /[a-z]/i.test(t)) return t.length >= 3 ? { kind: "email", text: t } : null;
  const digits = t.replace(/[\s()+.-]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length <= 6) return { kind: "id", id: digits };
  return digits.length >= 7 ? { kind: "phone", digits: digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits } : null;
}

/** "(512) ••••-0188": the last four only, the standing rule for phones. */
export const phoneLast4 = (phone: unknown): string | null => {
  const d = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
  return d.length >= 4 ? d.slice(-4) : null;
};

/* THE ADJUST PAYLOAD'S PEOPLE. Ryan, 2026-11-03: "trim the Adjust payload's manager to id and display
 * name for every account". The desktop editor's GET carries the manager and second manager as whole
 * user records (home coordinates, zip, address, credit); the app reads only the id, so only id and
 * name leave the server, for every caller. */
export function detailsPerson(v: unknown): { id: unknown; firstName: unknown; lastName: unknown } | null {
  if (!v || typeof v !== "object") return null;
  const u = v as Record<string, unknown>;
  return { id: u.id ?? null, firstName: u.firstName ?? null, lastName: u.lastName ?? null };
}
export const detailsMatch = (m: Record<string, unknown>) => ({ ...m, manager: detailsPerson(m.manager), secondManager: detailsPerson(m.secondManager) });
