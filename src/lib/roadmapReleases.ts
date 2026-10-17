// Releases on the Tech Roadmap (migration 0225), and everything the page derives from them: a
// release's status, the timeline's geometry, the stats row and the Done column's blocks. Pure, so
// every number on the page has one home.
//
// TWO TIME MODELS, AND THEY ARE NOT MIXED:
//   · starts_on / out_by are CALENDAR DAYS (Postgres `date`, 'YYYY-MM-DD'). They are split into
//     integer parts and formatted in UTC, so no zone can move them a day.
//   · done_at is an INSTANT (timestamptz). It is read as the day it fell on in America/Chicago,
//     through chicagoYmd, never by slicing.

import { chicagoYmd } from "./weekBuckets";
import type { KanbanCard, RoadmapAssignee, RoadmapBoard } from "./kanban";

export type Release = {
  id: string;
  board: RoadmapBoard;
  version: string;
  name: string;
  starts_on: string; // YYYY-MM-DD
  out_by: string; // YYYY-MM-DD
  created_at: string;
  updated_at: string;
};

export type ReleaseStatus = "planned" | "building" | "out";

export const ASSIGNEE_LABEL: Record<RoadmapAssignee, string> = { ryan: "Ryan", scrumlaunch: "ScrumLaunch" };

// ── calendar days ──────────────────────────────────────────────────────────
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
const utcMsToYmd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** "Oct 14" */
export function fmtDay(ymd: string): string {
  const x = new Date(ymdToUtcMs(ymd));
  return `${MO[x.getUTCMonth()]} ${x.getUTCDate()}`;
}
/** "Fri, Nov 14" */
export function fmtDayWithWeekday(ymd: string): string {
  return `${WD[new Date(ymdToUtcMs(ymd)).getUTCDay()]}, ${fmtDay(ymd)}`;
}
/** "Oct 14 to Nov 14" */
export const fmtRange = (a: string, b: string): string => `${fmtDay(a)} to ${fmtDay(b)}`;

/** Today, as the calendar day it is in America/Chicago. */
export const todayYmd = (nowMs: number = Date.now()): string => chicagoYmd(new Date(nowMs).toISOString());

/** The day a card was finished, in America/Chicago, or null. This is the STORED done_at; what the
 *  page shows is shownDoneYmd below. */
export const doneYmd = (c: Pick<KanbanCard, "done_at">): string | null => (c.done_at ? chicagoYmd(c.done_at) : null);

/** THE date a Done card shows, and the only one the page reads (cards, "Out this year", its "Last
 *  one" line, the Releases tab). A card in a release whose out-by date is already behind us shows
 *  that release's date: done_at is when the card was MOVED to Done, which for work typed in after it
 *  shipped is the day it was typed in, not the day it went out. Every other card (no release, or a
 *  release still to come) shows its own done_at. Every release has an out-by (NOT NULL, 0225), so
 *  "a release with no date" cannot occur. */
export function shownDoneYmd(
  c: Pick<KanbanCard, "done_at" | "release_id">,
  releaseById: ReadonlyMap<string, Pick<Release, "out_by">>,
  today: string,
): string | null {
  const r = c.release_id ? releaseById.get(c.release_id) : undefined;
  if (r && r.out_by < today) return r.out_by;
  return doneYmd(c);
}

// ── status ─────────────────────────────────────────────────────────────────
/** Out once every card in it is Done; otherwise Building from its start date, Planned before it.
 *  An empty release is never Out: nothing in it has been finished. */
export function releaseStatus(r: Release, cards: KanbanCard[], today: string): ReleaseStatus {
  const mine = cards.filter((c) => c.release_id === r.id);
  if (mine.length > 0 && mine.every((c) => c.stage === "shipped")) return "out";
  return today >= r.starts_on ? "building" : "planned";
}

/** Releases in the order the page lists them: earliest start first, then version. */
export function sortReleases(rs: Release[]): Release[] {
  return [...rs].sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.version.localeCompare(b.version, undefined, { numeric: true }));
}

// ── timeline ───────────────────────────────────────────────────────────────
export type Timeline = {
  startMs: number;
  endMs: number;
  months: { label: string; ms: number }[];
  /** 0..1 across the chart for a calendar day; a bar runs from its start to the END of its last day. */
  at: (ymd: string) => number;
  endOf: (ymd: string) => number;
  title: string; // "Oct 2026 to Mar 2027"
};

/** Whole months, from the month of the earliest start (or today) to the month of the latest out-by
 *  (or today), so the today line is always on the chart. */
export function buildTimeline(releases: Release[], today: string): Timeline {
  const days = [today, ...releases.flatMap((r) => [r.starts_on, r.out_by])];
  const min = days.reduce((a, b) => (a < b ? a : b));
  const max = days.reduce((a, b) => (a > b ? a : b));
  const [y0, m0] = min.split("-").map(Number);
  const [y1, m1] = max.split("-").map(Number);
  const startMs = Date.UTC(y0, m0 - 1, 1);
  const endMs = Date.UTC(y1, m1, 1); // first day of the month after the last one
  const months: { label: string; ms: number }[] = [];
  for (let y = y0, m = m0 - 1; Date.UTC(y, m, 1) < endMs; m === 11 ? (y++, (m = 0)) : m++) {
    months.push({ label: MO[m], ms: Date.UTC(y, m, 1) });
  }
  const span = endMs - startMs;
  const at = (ymd: string) => (ymdToUtcMs(ymd) - startMs) / span;
  const endOf = (ymd: string) => (ymdToUtcMs(ymd) + 86_400_000 - startMs) / span;
  const last = utcMsToYmd(endMs - 86_400_000);
  const title = `${MO[m0 - 1]} ${y0} to ${MO[Number(last.slice(5, 7)) - 1]} ${last.slice(0, 4)}`;
  return { startMs, endMs, months, at, endOf, title };
}

// ── stats row ──────────────────────────────────────────────────────────────
export type RoadmapStats = {
  next: Release | null;
  working: { total: number; ryan: number; scrumlaunch: number; none: number };
  scrum: { total: number; releases: number; noRelease: number };
  outThisYear: { total: number; last: KanbanCard | null; lastDay: string | null };
};

/**
 * All four are facts about the BOARD, never the filtered view.
 *  · Next release: the not-yet-Out release with the earliest out-by date.
 *  · Being worked on: cards in Working on it, split by who.
 *  · Waiting on ScrumLaunch: ScrumLaunch's open cards, Up next plus Working on it.
 *  · Out this year: Done cards whose SHOWN date (shownDoneYmd) falls in this calendar year and that
 *    are not sitting inside a release that is still being built. A release's done cards count once
 *    the whole release is Out. "Last one" is the latest shown date, so it agrees with the cards.
 */
export function deriveStats(cards: KanbanCard[], releases: Release[], today: string): RoadmapStats {
  const status = new Map(releases.map((r) => [r.id, releaseStatus(r, cards, today)]));
  const next =
    [...releases].filter((r) => status.get(r.id) !== "out").sort((a, b) => a.out_by.localeCompare(b.out_by))[0] ?? null;

  const inProg = cards.filter((c) => c.stage === "in_progress");
  const working = {
    total: inProg.length,
    ryan: inProg.filter((c) => c.assignee === "ryan").length,
    scrumlaunch: inProg.filter((c) => c.assignee === "scrumlaunch").length,
    none: inProg.filter((c) => !c.assignee).length,
  };

  const scrumOpen = cards.filter((c) => c.assignee === "scrumlaunch" && (c.stage === "in_plan" || c.stage === "in_progress"));
  const scrum = {
    total: scrumOpen.length,
    releases: new Set(scrumOpen.map((c) => c.release_id).filter(Boolean)).size,
    noRelease: scrumOpen.filter((c) => !c.release_id).length,
  };

  const year = today.slice(0, 4);
  const byId = new Map(releases.map((r) => [r.id, r]));
  const shown = new Map(cards.map((c) => [c.id, c.stage === "shipped" ? shownDoneYmd(c, byId, today) : null]));
  const out = cards.filter((c) => {
    if (c.stage !== "shipped") return false;
    const d = shown.get(c.id);
    if (!d || d.slice(0, 4) !== year) return false;
    return !c.release_id || status.get(c.release_id) === "out";
  });
  // Latest shown day wins; on a tie, the card moved to Done last.
  const key = (c: KanbanCard) => `${shown.get(c.id) ?? ""}|${c.done_at ?? ""}`;
  const last = out.reduce<KanbanCard | null>((m, c) => (!m || key(c) > key(m) ? c : m), null);
  return { next, working, scrum, outThisYear: { total: out.length, last, lastDay: last ? shown.get(last.id) ?? null : null } };
}

// ── the Done column, one block per release ─────────────────────────────────
export type DoneGroup = { key: string; release: Release | null; cards: KanbanCard[] };
export const NO_RELEASE_KEY = "none";

/** One block per release that has done cards, newest out-by first, then "No release" last. Cards
 *  inside a block keep the order they are given. A card whose release_id names a release that is
 *  not in `releases` (it cannot, by the foreign key, but a stale list could) lands in No release
 *  rather than vanishing. */
export function doneGroups(done: KanbanCard[], releases: Release[]): DoneGroup[] {
  const byId = new Map(releases.map((r) => [r.id, r]));
  const groups = new Map<string, DoneGroup>();
  for (const c of done) {
    const r = c.release_id ? byId.get(c.release_id) ?? null : null;
    const key = r ? r.id : NO_RELEASE_KEY;
    if (!groups.has(key)) groups.set(key, { key, release: r, cards: [] });
    groups.get(key)!.cards.push(c);
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.release) return 1;
    if (!b.release) return -1;
    return b.release.out_by.localeCompare(a.release.out_by) || b.release.version.localeCompare(a.release.version, undefined, { numeric: true });
  });
}

// ── open / closed, per viewer, in this browser ─────────────────────────────
// A convenience, not state anyone else reads: every access is wrapped, and a failure answers with
// the caller's default (open for a release card; "most recent release" for the Done column).
export function readOpen(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key);
    return v === "1" ? true : v === "0" ? false : fallback;
  } catch {
    return fallback;
  }
}
export function writeOpen(key: string, open: boolean): void {
  try {
    window.localStorage.setItem(key, open ? "1" : "0");
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
}
export const releaseOpenKey = (viewer: string, releaseId: string) => `roadmap.release-open:${viewer}:${releaseId}`;
export const doneOpenKey = (viewer: string, board: RoadmapBoard, groupKey: string) => `roadmap.done-open:${viewer}:${board}:${groupKey}`;
