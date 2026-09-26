/* THE DAY QUEUE — what is planned for one day, what has slipped, and what has gone out.
 *
 * Ryan: "Look how ugly and long the list of planned pushes is ... Maybe it should show matches of
 * the day to push, with a way to easily change the day, defaulting to the current day, and tab
 * between days." And: "The top part is where you see the planned pushes and the operator can mark
 * if they are sent, or if it's past due it will show."
 *
 * IT IS DERIVED FROM THE WEEK AND CARRIES NOTHING OF ITS OWN. A push on the queue and a push on a
 * tile that disagree is the one failure this page cannot afford, so the queue is a projection of
 * `week.matches` and never a second list. It creates nothing: the plans are made on the week below.
 */
import { datedPushes, isPushOverdue, isPushSent, type PromoMatch, type PromoWeek, type PromoPush } from "./matchPromotion";

export type QueueEntry = { m: PromoMatch; p: PromoPush; at: number };
export type DayQueue = {
  dayIdx: number;
  /** Unsent and the moment has gone. Shown first, in its own group. */
  late: QueueEntry[];
  /** Unsent and the moment has not arrived. */
  todo: QueueEntry[];
  /** Already marked sent. Folded away, never removed. */
  done: QueueEntry[];
  /** Matches cancelled on this day, for the tab's pip. */
  cancelled: PromoMatch[];
};

/** Every dated push in the week, tagged with the day column it belongs to. */
export function weekQueueEntries(week: PromoWeek): QueueEntry[] {
  return week.matches.flatMap((m) =>
    datedPushes(m.plan).map((p) => ({ m, p, at: Date.parse(p.pushAt as string) })));
}

/* A PAST WEEK HAS NOTHING OUTSTANDING. Nothing in a week that has been and gone should ask the
 * operator to do something they can no longer do, so past due is suppressed and Mark sent is not
 * offered. The week is HISTORY, and its unsent pushes are a fact about the past rather than a
 * task. Decided on the week, not the push, so one rule covers the whole screen. */
export function isPastWeek(week: PromoWeek, now: number = Date.now()): boolean {
  const [y, m, d] = week.weekStart.split("-").map(Number);
  // The instant the week's Sunday ends, in the reader's own clock — the same clock every other
  // time on this page is shown in.
  return new Date(y, m - 1, d + 7).getTime() <= now;
}

/** One day's queue, split into the three states, each sorted by push time. */
export function dayQueue(week: PromoWeek, dayIdx: number, now: number = Date.now()): DayQueue {
  const past = isPastWeek(week, now);
  const mine = weekQueueEntries(week)
    .filter((e) => e.m.dayIdx === dayIdx)
    .sort((a, b) => a.at - b.at);
  const done = mine.filter((e) => isPushSent(e.p));
  const unsent = mine.filter((e) => !isPushSent(e.p));
  /* PAST DUE AND TO-SEND ARE DIFFERENT STATES. A push whose moment has gone is late; one whose
   * moment has not arrived is not, however soon it is. isPushOverdue owns that call. */
  const late = past ? [] : unsent.filter((e) => isPushOverdue(e.p, now));
  const todo = unsent.filter((e) => !late.includes(e));
  return {
    dayIdx, late, todo, done,
    cancelled: week.matches.filter((m) => m.dayIdx === dayIdx && m.state === "cancelled"),
  };
}

/** All seven, in order. The tabs read this so choosing a day never means opening one. */
export function weekQueues(week: PromoWeek, now: number = Date.now()): DayQueue[] {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => dayQueue(week, i, now));
}

/* THE DAY THE QUEUE OPENS ON. Today when today is in the week on screen, and the first day
 * otherwise — a past or future week has no "today" to default to, and opening on a day that is not
 * in the week would show an empty queue for a reason nobody could see. */
export function defaultDayIdx(week: PromoWeek, now: Date = new Date()): number {
  const i = week.days.findIndex((d) => d.today);
  return i >= 0 ? i : 0;
}

/** The count the tab carries, so the operator can choose a day without opening any. */
export function tabCounts(q: DayQueue): { late: number; todo: number; done: number; cancelled: number } {
  return { late: q.late.length, todo: q.todo.length, done: q.done.length, cancelled: q.cancelled.length };
}

/* ── THE ARITHMETIC THE WHOLE SPLIT RESTS ON ─────────────────────────────────────────────────
 * The seven day queues must hold exactly the pushes the week's tiles carry. A push that appears
 * in two days, or in none, shows up nowhere else on the page — the tile still looks right and the
 * strip still looks right, and only the total disagrees. */
export function queueTotal(week: PromoWeek, now: number = Date.now()): number {
  return weekQueues(week, now).reduce((s, q) => s + q.late.length + q.todo.length + q.done.length, 0);
}
