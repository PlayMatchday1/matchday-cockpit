// Pure derivation for the Tech Roadmap board. Every number the page prints is
// computed here from the loaded cards — there is no typed-in total anywhere.
// Kept free of React/fetching so the thresholds have exactly one home (the page
// AND the disclosure footer read the same constants) and can be reasoned about.

import {
  cardEstimatedHours,
  compareBoardOrder,
  sortOrderForDrop,
  type KanbanCard,
  type RoadmapBoard,
} from "./kanban";

// The four columns, in order. ids match kanban_cards.stage.
export const ROADMAP_COLS = [
  { id: "ideas", title: "Ideas" },
  { id: "in_plan", title: "In plan" },
  { id: "in_progress", title: "In progress" },
  { id: "shipped", title: "Shipped" },
] as const;
export type RoadmapStage = (typeof ROADMAP_COLS)[number]["id"];

// Which of the two roadmap boards a card belongs to. `board` is optional on the
// type (it did not exist before migration 0090), so anything that is not
// explicitly clubhouse is App — matching the column's DEFAULT 'app'.
export const roadmapBoardOf = (c: KanbanCard): RoadmapBoard =>
  c.board === "clubhouse" ? "clubhouse" : "app";

// ── one column, and the two ways a card can be written into it ─────────────
//
// THE TWO WRITE PATHS ARE SEPARATE ON PURPOSE AND MUST STAY SEPARATE.
//
//   planMove    — a card changes column. Writes stage + sort_order +
//                 stage_entered_at, because that IS the stale clock resetting.
//   planReorder — a card changes position inside its own column. Writes
//                 sort_order and NOTHING else. Reordering is not a stage
//                 change; if it touched stage_entered_at, then "sitting too
//                 long", "longest untouched" and every age on the board would
//                 be reset by an act that changed nothing about the work.
//
// The DB trigger (20260801_field_pipeline_stage_entered_at) also leaves
// stage_entered_at alone when stage is unchanged — but only if the client does
// not send one, and planMove DOES send one. Client-side omission is the guard
// that matters, which is why these are two functions and not one with a flag.

// One column of one roadmap board, in the order it renders. The single place a
// roadmap column is built, so the board, the drag maths and the drawer's
// up/down controls can never disagree about what "the card above this one" is.
export function columnCards(
  cards: KanbanCard[],
  board: RoadmapBoard,
  stage: string,
): KanbanCard[] {
  return cards
    .filter((c) => roadmapBoardOf(c) === board && c.stage === stage)
    .sort(compareBoardOrder);
}

export type MovePlan =
  | { kind: "noop" }
  | { kind: "write"; patch: { stage: string; sort_order: number; stage_entered_at: string } };

export type ReorderPlan =
  | { kind: "noop" }
  | { kind: "write"; patch: { sort_order: number } };

// Moving a card to another column. It lands at the END of the target column and
// its stale clock resets. `nowIso` is passed in so the caller owns the clock
// (and so this is testable); the DB trigger stamps the authoritative value, and
// this local one only stops the age on screen lagging until the next reload.
export function planMove(
  cards: KanbanCard[],
  id: string,
  toStage: string,
  nowIso: string,
): MovePlan {
  const card = cards.find((c) => c.id === id);
  if (!card || card.stage === toStage) return { kind: "noop" };
  const siblings = columnCards(cards, roadmapBoardOf(card), toStage);
  return {
    kind: "write",
    patch: {
      stage: toStage,
      sort_order: sortOrderForDrop(siblings, null),
      stage_entered_at: nowIso,
    },
  };
}

// Reordering a card inside its own column: land it ahead of `beforeId`, or at
// the end when that is null. `column` is the card's own column in render order.
//
// Returns noop when the card is already where it would land. Dropping a card on
// the one directly below it computes a midpoint that changes nothing — writing
// that row would be a write with no effect, and a write with no effect is still
// a write.
export function planReorder(
  column: KanbanCard[],
  id: string,
  beforeId: string | null,
): ReorderPlan {
  if (beforeId === id) return { kind: "noop" }; // dropped on itself
  const from = column.findIndex((c) => c.id === id);
  if (from === -1) return { kind: "noop" };
  const siblings = column.filter((c) => c.id !== id);
  const found = beforeId === null ? -1 : siblings.findIndex((c) => c.id === beforeId);
  // Where in the sibling list the card would be re-inserted. Removing the card
  // from index `from` and re-inserting at the same index is the identity move.
  const at = found === -1 ? siblings.length : found;
  if (at === from) return { kind: "noop" };
  return { kind: "write", patch: { sort_order: sortOrderForDrop(siblings, beforeId) } };
}

// The drop target that moves a card one place up (-1) or down (+1) in its
// column — what the drawer's Up/Down buttons hand to planReorder. null means
// the card is already at that end and the control is disabled.
//
// `beforeId` names the card the moving one lands AHEAD of, in the column with
// the moving card removed. Removing index i shifts everything after it down
// one, which is why moving DOWN reaches two places along.
export function stepTarget(
  column: KanbanCard[],
  id: string,
  delta: -1 | 1,
): { beforeId: string | null } | null {
  const i = column.findIndex((c) => c.id === id);
  if (i === -1) return null;
  const at = i + delta;
  if (at < 0 || at > column.length - 1) return null;
  const anchor = delta === -1 ? column[at] : column[at + 1];
  return { beforeId: anchor ? anchor.id : null };
}

// Thresholds, stated once. A card is flagged when it has not changed column for
// longer than its column allows. An idea may sit far longer than work in flight
// before it is "stuck"; shipped work is never chased.
export const STALE_ACTIVE_DAYS = 30; // In plan / In progress
export const STALE_IDEA_DAYS = 120; // Ideas
export const FRESH_WINDOW_DAYS = 7; // "changed recently"

const DAY_MS = 86_400_000;

// The last time this card changed column. stage_entered_at is stamped by a DB
// trigger on every stage change (and backfilled for existing rows); updated_at /
// created_at are lower-bound fallbacks so a card always has an age to show.
export function movedAtMs(c: KanbanCard): number {
  const src = c.stage_entered_at ?? c.updated_at ?? c.created_at;
  return src ? new Date(src).getTime() : 0;
}
export function createdAtMs(c: KanbanCard): number {
  return c.created_at ? new Date(c.created_at).getTime() : 0;
}
export function daysSince(ms: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - ms) / DAY_MS));
}
// Days the card has sat in its current column.
export function daysInColumn(c: KanbanCard, nowMs: number): number {
  return daysSince(movedAtMs(c), nowMs);
}

// The stale limit for a column, or null where staleness does not apply (Shipped).
export function staleLimitFor(stage: string): number | null {
  if (stage === "ideas") return STALE_IDEA_DAYS;
  if (stage === "shipped") return null;
  return STALE_ACTIVE_DAYS; // in_plan, in_progress
}
export function isStale(c: KanbanCard, nowMs: number): boolean {
  const limit = staleLimitFor(c.stage);
  return limit !== null && daysInColumn(c, nowMs) > limit;
}
// Created or moved to another column inside the fresh window. Ideas do not
// change column, so for an idea this means it was written down that recently.
export function isFresh(c: KanbanCard, nowMs: number): boolean {
  return (
    daysSince(movedAtMs(c), nowMs) <= FRESH_WINDOW_DAYS ||
    daysSince(createdAtMs(c), nowMs) <= FRESH_WINDOW_DAYS
  );
}
// An estimate is only worth chasing once a card is committed to — nobody should
// be pricing every idea. So a missing estimate is a flag in In plan / In
// progress and nowhere else.
export function wantsEstimate(c: KanbanCard): boolean {
  return (c.stage === "in_plan" || c.stage === "in_progress") && cardEstimatedHours(c) === null;
}

const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dfull(ms: number): string {
  const x = new Date(ms);
  return `${MO[x.getUTCMonth()]} ${x.getUTCDate()}, ${x.getUTCFullYear()}`;
}

// Count + noun, singularised: "1 day" / "3 days", "1 card" / "0 cards". Used
// everywhere the page prints a number followed by a noun so "1 days" can never
// render — the whole class of defect, not the one instance the mockup showed.
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// The one line a column header carries — the single thing that column is asked.
// An empty column says nothing (no "0 days").
export function columnMetaLine(stage: string, cards: KanbanCard[], nowMs: number): string | null {
  if (cards.length === 0) return null;
  if (stage === "ideas") {
    const oldest = Math.max(...cards.map((c) => daysInColumn(c, nowMs)));
    return `oldest has sat ${plural(oldest, "day")} · flagged past ${STALE_IDEA_DAYS}`;
  }
  if (stage === "shipped") {
    const mostRecent = Math.max(...cards.map((c) => movedAtMs(c)));
    return `most recent shipped ${dfull(mostRecent)}`;
  }
  const longest = Math.max(...cards.map((c) => daysInColumn(c, nowMs)));
  return `longest untouched ${plural(longest, "day")} · flagged past ${STALE_ACTIVE_DAYS}`;
}

// ── board-level aggregates for the state bar (all derived, never typed) ──
export type StateBar = {
  total: number;
  inProgress: number;
  fresh: number;
  stale: number;
  withEstimate: number;
  noEstimate: number;
  estimatedHours: number;
};
export function deriveStateBar(cards: KanbanCard[], nowMs: number): StateBar {
  const withEst = cards.filter((c) => cardEstimatedHours(c) !== null);
  return {
    total: cards.length,
    inProgress: cards.filter((c) => c.stage === "in_progress").length,
    fresh: cards.filter((c) => isFresh(c, nowMs)).length,
    stale: cards.filter((c) => isStale(c, nowMs)).length,
    withEstimate: withEst.length,
    noEstimate: cards.length - withEst.length,
    estimatedHours: withEst.reduce((s, c) => s + (cardEstimatedHours(c) ?? 0), 0),
  };
}
