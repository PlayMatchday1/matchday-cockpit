// STAFF APP MATCH v2: the pure rules (Ryan, 2026-10-30). The routes under /api/app/{env}/matches/{id}
// call the desktop write handlers; this file only decides WHICH desktop path a request takes, what
// the app may offer, and how a read-back is worded. No I/O, so scripts/app-match-v2-test.ts can
// assert every rule offline.

import { teamCountWrites, teamShapeError } from "./rosterEditModel";
import { REDUCE_MAX_PER_TEAM, REDUCE_MIN_PER_TEAM } from "./reduceTwoTeams";

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

/* THE PICKER'S CAPACITY WRITE, exactly what the desktop stages (MatchPanel stageTeamCount): the
 * current per-team figure carried into the new count, through teamCountWrites, which writes the
 * new mode's rung for 2 and 4 and only maxPlayerCount for 3. A capacity that does not divide by the
 * current count has no honest per-team figure, so nothing is written beside the count, as on the
 * desktop. Only keys whose value changes are returned: the desktop PUT sends the diff. */
export function pickerCapacityWrites(match: Record<string, unknown>, current: number, target: number): Record<string, number> {
  const cap = Number(match.maxPlayerCount) || 0;
  if (current <= 0 || cap % current !== 0) return {};
  const per = cap / current;
  const rungKey = target === 2 ? "maxTeamSize2Team" : target === 4 ? "maxTeamSize4Team" : null;
  const rung = rungKey ? Number(match[rungKey]) : null;
  const w = teamCountWrites(target, per, Number.isFinite(rung) ? rung : null);
  return Object.fromEntries(Object.entries(w).filter(([k, v]) => Number(match[k]) !== v));
}

/* THE TEAM SIZE STEPPER. Ryan: "for 2 and 4 teams write the stored team size; for 3 teams write the
 * total and show size as total divided by 3. Only offer values the desktop's teamShapeError
 * accepts." A size is offered when n x size passes teamShapeError (always, since it is a product)
 * and is not below the fullest team, so the stepper can never ask a team to hold fewer players
 * than are standing on it. 20 a side is the ceiling the app offers. */
export const SIZE_MAX = 20;
export function sizeBounds(teamCount: number, teamFills: readonly number[]): { min: number; max: number } {
  return { min: Math.max(1, ...teamFills), max: Math.max(SIZE_MAX, ...teamFills) };
}
export function sizeRefusal(teamCount: number, perTeam: number, teamFills: readonly number[]): string | null {
  if (!Number.isInteger(perTeam) || perTeam < 1) return "Team size must be a whole number of players.";
  const b = sizeBounds(teamCount, teamFills);
  if (perTeam < b.min) return `A team already has ${b.min} players, so the size cannot go below ${b.min}.`;
  if (perTeam > b.max) return `The app offers up to ${b.max} a side.`;
  return teamShapeError(perTeam * teamCount, teamCount);
}
/** The size write: the desktop's own teamCountWrites, diffed against the match. */
export function sizeWrites(match: Record<string, unknown>, teamCount: number, perTeam: number): Record<string, number> {
  const rungKey = teamCount === 2 ? "maxTeamSize2Team" : teamCount === 4 ? "maxTeamSize4Team" : null;
  const rung = rungKey ? Number(match[rungKey]) : null;
  const w = teamCountWrites(teamCount, perTeam, Number.isFinite(rung) ? rung : null);
  return Object.fromEntries(Object.entries(w).filter(([k, v]) => Number(match[k]) !== v));
}

/* THE SIZES A REDUCE TO 2 MAY OFFER (Ryan, 2026-10-31): every size where 2 x size holds all the real
 * players and teamShapeError accepts 2 x size, from the smallest that fits up to the current size,
 * and only inside the desktop Reduce to 2's own range (6 to 12 a side), which refuses anything else.
 * Empty, with the reason, when nothing fits. */
export function reduceSizes(real: number, currentSize: number | null): { sizes: number[]; reason: string | null } {
  const fit = Math.max(1, Math.ceil(real / 2));
  const lo = Math.max(fit, REDUCE_MIN_PER_TEAM);
  const hi = Math.min(currentSize ?? REDUCE_MAX_PER_TEAM, REDUCE_MAX_PER_TEAM);
  const sizes: number[] = [];
  for (let s = lo; s <= hi; s++) if (teamShapeError(2 * s, 2) == null) sizes.push(s);
  if (sizes.length > 0) return { sizes, reason: null };
  if (fit > REDUCE_MAX_PER_TEAM) return { sizes, reason: `${real} real players do not fit 2 teams of ${REDUCE_MAX_PER_TEAM}, the largest Reduce to 2 allows.` };
  if (currentSize != null && currentSize < lo) return { sizes, reason: `The current size is ${currentSize} a side, below the ${lo} a side that 2 teams would need here (Reduce to 2 allows ${REDUCE_MIN_PER_TEAM} to ${REDUCE_MAX_PER_TEAM}).` };
  return { sizes, reason: `No 2-team size fits ${real} real players.` };
}

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
