// Pure derivation for the Tech Roadmap board: the columns and the two ways a card
// is written into one. Releases and the stats row live in roadmapReleases.ts.
// Kept free of React/fetching so it can be exercised from a node script.

import {
  compareBoardOrder,
  sortOrderForDrop,
  type KanbanCard,
  type RoadmapBoard,
} from "./kanban";

// The four columns, in order. ids match kanban_cards.stage.
// The stored values are the originals; only the labels changed (Roadmap 2.0).
export const ROADMAP_COLS = [
  { id: "ideas", title: "Ideas" },
  { id: "in_plan", title: "Up next" },
  { id: "in_progress", title: "Working on it" },
  { id: "shipped", title: "Done" },
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
