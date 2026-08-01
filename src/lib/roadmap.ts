// Pure derivation for the Tech Roadmap board. Every number the page prints is
// computed here from the loaded cards — there is no typed-in total anywhere.
// Kept free of React/fetching so the thresholds have exactly one home (the page
// AND the disclosure footer read the same constants) and can be reasoned about.

import {
  cardEstimatedHours,
  type KanbanCard,
} from "./kanban";

// The four columns, in order. ids match kanban_cards.stage.
export const ROADMAP_COLS = [
  { id: "ideas", title: "Ideas" },
  { id: "in_plan", title: "In plan" },
  { id: "in_progress", title: "In progress" },
  { id: "shipped", title: "Shipped" },
] as const;
export type RoadmapStage = (typeof ROADMAP_COLS)[number]["id"];

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

// The one line a column header carries — the single thing that column is asked.
// An empty column says nothing (no "0 days").
export function columnMetaLine(stage: string, cards: KanbanCard[], nowMs: number): string | null {
  if (cards.length === 0) return null;
  if (stage === "ideas") {
    const oldest = Math.max(...cards.map((c) => daysInColumn(c, nowMs)));
    return `oldest has sat ${oldest} days · flagged past ${STALE_IDEA_DAYS}`;
  }
  if (stage === "shipped") {
    const mostRecent = Math.max(...cards.map((c) => movedAtMs(c)));
    return `most recent shipped ${dfull(mostRecent)}`;
  }
  const longest = Math.max(...cards.map((c) => daysInColumn(c, nowMs)));
  return `longest untouched ${longest} days · flagged past ${STALE_ACTIVE_DAYS}`;
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
