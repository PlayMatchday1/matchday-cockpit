/* CITY MANAGER MEETING ACTION ITEMS — pure. Nothing here fetches, nothing renders.
 *
 * The month's city goals, the team's things to try, and the month's takeaways. One month and one
 * city filter govern the whole page (see CheckInsView), so every derivation those two controls
 * drive lives here and has exactly one implementation.
 */

import { CITY_SCOPES } from "./cityScope";
// THE ORDERING MATHS IS NOT KANBAN-SPECIFIC — it operates on { id, sort_order } and nothing else.
// Imported rather than copied: a second implementation of "where does this row land" is how two
// lists start disagreeing about what up means. See the comment on sortOrderForDrop.
import { sortOrderForDrop } from "./kanban";

/* ── THE FOUR STATUSES, AND THEY ARE THE GOALS TOOL'S ─────────────────────────────────────────
 * Slugs, labels, order and colours are matchday-goals.html's own (STATUSES/LABEL at line 165 and
 * the --green/--coral tokens), so the two can never disagree about what green means. They cycle in
 * this order, which is also that file's.
 *
 * NOT src/lib/types.ts's five. That vocabulary belongs to the quarterly goals tool — it carries an
 * "In progress" these do not have, and six of its ten live rows sit on it. Sharing one enum would
 * have meant rewriting those rows to suit a different feature. */
export const CM_STATUSES = ["open", "ontrack", "atrisk", "done"] as const;
export type CmStatus = (typeof CM_STATUSES)[number];

export const CM_STATUS_LABEL: Record<CmStatus, string> = {
  open: "Open", ontrack: "On track", atrisk: "At risk", done: "Done",
};

/** matchday-goals.html's tokens, verbatim. */
export const CM_GREEN = "#0C7A44";
export const CM_GREEN_TINT = "#EAF4EC";
export const CM_CORAL = "#C2452D";
export const CM_CORAL_TINT = "#F7ECE8";

export const nextStatus = (s: CmStatus): CmStatus =>
  CM_STATUSES[(CM_STATUSES.indexOf(s) + 1) % CM_STATUSES.length];

export type CmUpdate = {
  id: string; item_id: string; reported_on: string; author: string | null; body: string;
  created_at: string;
};

export type CmItem = {
  id: string;
  month: string;                       // 'YYYY-MM'
  scope: "city" | "team";
  kind: "goal" | "try" | "takeaway";
  city: string | null;                 // city_identifier; null for team items
  body: string;
  status: CmStatus | null;             // null ONLY on a takeaway
  owner: string | null;
  source: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/* ── THE MONTH KEY ────────────────────────────────────────────────────────────────────────────
 * 'YYYY-MM' throughout, and every step is done on the STRING or on UTC-midnight parts. A month is
 * a calendar bucket, not an instant; running it through a local Date is how a September board
 * renders as August for somebody in a different timezone. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonthKey = (m: string): boolean => MONTH_RE.test(m);

export function shiftMonth(month: string, delta: number): string {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
export const monthLabel = (month: string): string =>
  `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** The calendar month containing `todayIso` (YYYY-MM-DD). Sliced, never parsed. */
export const monthOf = (todayIso: string): string => todayIso.slice(0, 7);

/** Strictly before the current month — the record of a month that has run. */
export const isPastMonth = (month: string, currentMonth: string): boolean => month < currentMonth;

/* ── THE ROLLUP ───────────────────────────────────────────────────────────────────────────────
 * DERIVED FROM THE LIST, NEVER STORED. A summary that can disagree with what is under it is worse
 * than no summary — so cycling a status moves these because they are recomputed from the same
 * array the board renders, not because something remembered to update a counter.
 *
 * Takeaways are excluded: they carry no status, so counting them as "not started" would invent a
 * task out of a thing we simply now know. `total` therefore counts action items, which is what the
 * label says. */
export type CmRollup = { total: number } & Record<CmStatus, number>;

export function deriveRollup(items: readonly CmItem[]): CmRollup {
  const withStatus = items.filter((i) => i.kind !== "takeaway" && i.status !== null);
  const out: CmRollup = { total: withStatus.length, open: 0, ontrack: 0, atrisk: 0, done: 0 };
  for (const i of withStatus) out[i.status as CmStatus] += 1;
  return out;
}

/* ── GROUPING ─────────────────────────────────────────────────────────────────────────────────
 * City goals, by city, in CITY_SCOPES order so the board does not reshuffle when a city's goals
 * are all deleted and re-added. Cities with nothing this month are dropped rather than rendered
 * empty. */
export const CM_CITIES = CITY_SCOPES.map((c) => c.identifier);
export const cityNameOf = (identifier: string): string =>
  CITY_SCOPES.find((c) => c.identifier === identifier)?.name ?? identifier;

export function cityGoals(items: readonly CmItem[], city: string): CmItem[] {
  return items
    .filter((i) => i.scope === "city" && i.city === city)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** The cities with at least one goal this month, honouring the city filter. `null` = all. */
export function citiesWithGoals(items: readonly CmItem[], filter: string | null): string[] {
  return CM_CITIES.filter((c) => (!filter || c === filter) && items.some((i) => i.scope === "city" && i.city === c));
}

/* TEAM ITEMS ARE ORG-WIDE, so no function here takes a city filter. Filtering to Atlanta must not
 * hide a decision that applies to Atlanta — that is why these are read straight off `items` with
 * the city argument absent rather than optional. */
export function teamItems(items: readonly CmItem[], kind: "try" | "takeaway"): CmItem[] {
  return items
    .filter((i) => i.scope === "team" && i.kind === kind)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** The latest update for an item: the day reported about, then when it was written. */
export function latestUpdate(updates: readonly CmUpdate[], itemId: string): CmUpdate | null {
  const mine = updates.filter((u) => u.item_id === itemId);
  if (mine.length === 0) return null;
  return mine.sort((a, b) =>
    b.reported_on.localeCompare(a.reported_on) || b.created_at.localeCompare(a.created_at))[0];
}

/** "Sep 2" — from a YYYY-MM-DD, sliced. Never through a local Date. */
export function shortDate(isoDate: string): string {
  const m = Number(isoDate.slice(5, 7)), d = Number(isoDate.slice(8, 10));
  return `${MONTH_NAMES[m - 1]?.slice(0, 3) ?? "?"} ${d}`;
}


/* ── MOVING A ROW ─────────────────────────────────────────────────────────────────────────────
 * One place, so the menu's Up and Down cannot disagree with each other.
 *
 * `siblings` is the list the row lives in, IN RENDER ORDER. Returns the sort_order to write, or
 * null when the row is already at that end and the control should be disabled. One row is written,
 * never the whole list renumbered.
 *
 * The `beforeId` shape comes from sortOrderForDrop: it names the row the moving one lands AHEAD
 * of, in the list with the moving row removed. Removing index i shifts everything after it down
 * one, which is why moving DOWN reaches two places along.
 */
export function stepOrder(siblings: readonly CmItem[], id: string, delta: -1 | 1): number | null {
  const i = siblings.findIndex((x) => x.id === id);
  if (i === -1) return null;
  const at = i + delta;
  if (at < 0 || at > siblings.length - 1) return null;
  const rest = siblings.filter((x) => x.id !== id);
  const anchor = delta === -1 ? siblings[at] : siblings[at + 1];
  return sortOrderForDrop(rest, anchor ? anchor.id : null);
}

/** The next sort_order at the end of a list — where a newly added row goes. */
export const nextOrder = (siblings: readonly CmItem[]): number =>
  siblings.reduce((m, x) => Math.max(m, x.sort_order), 0) + 1;

/** Every update for an item, newest first. The table keeps the history; this is how it is read. */
export function updateHistory(updates: readonly CmUpdate[], itemId: string): CmUpdate[] {
  return updates.filter((u) => u.item_id === itemId)
    .sort((a, b) => b.reported_on.localeCompare(a.reported_on) || b.created_at.localeCompare(a.created_at));
}

/* ── WHAT AN INSERT MUST LOOK LIKE ────────────────────────────────────────────────────────────
 * Built here rather than in the form, because migration 0158's CHECK constraints are not
 * advisory and a form that ignores one builds a row Postgres rejects:
 *
 *   cm_ai_takeaway_shape — a takeaway MUST carry a source and MUST NOT carry a status or an owner.
 *   cm_ai_city_shape     — a city goal must have a city, kind 'goal', and a status.
 *   cm_ai_team_shape     — a team item must have city = NULL. The city FILTER must never leak in:
 *                          adding a thing to try while the board is filtered to Austin still
 *                          writes null, because the item is org-wide and the filter is a view.
 */
export type NewItem =
  | { kind: "goal"; city: string; body: string }
  | { kind: "try"; body: string; owner: string | null }
  | { kind: "takeaway"; body: string; source: string };

export function buildInsert(month: string, input: NewItem, sort_order: number): Record<string, unknown> {
  if (input.kind === "goal") {
    return { month, scope: "city", kind: "goal", city: input.city, body: input.body.trim(),
      status: "open", owner: null, source: null, sort_order };
  }
  if (input.kind === "try") {
    return { month, scope: "team", kind: "try", city: null, body: input.body.trim(),
      status: "open", owner: input.owner?.trim() || null, source: null, sort_order };
  }
  // A TAKEAWAY IS NOT A TASK: no status, no owner, and it must say where it came from.
  return { month, scope: "team", kind: "takeaway", city: null, body: input.body.trim(),
    status: null, owner: null, source: input.source.trim(), sort_order };
}
