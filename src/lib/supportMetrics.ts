// Pure aggregation for the Chats support-performance strip. Takes plain
// rows (already fetched + auth-checked by the route) and computes the
// four tiles. No supabase, no I/O, no clock — `nowMs` and the period
// bounds are passed in — so every number here is unit-testable.
//
// Tiles 1–3 are period-scoped (This week / month / All time). Tile 4
// (Awaiting now) is LIVE, not period-bound, and is computed separately
// in the route from the current crm_threads state — it does not belong
// to a period and is intentionally absent from PeriodMetrics.

import {
  businessMinutesBetween,
  median,
  wallClockPartsInZone,
  zonedWallClockToUtcMs,
  type BusinessHoursConfig,
  DEFAULT_BUSINESS_HOURS,
  BUSINESS_TZ,
} from "./businessHours";

// Minimal message shape the metrics need. `sentAtMs` is crm_messages
// .sent_at parsed to epoch ms (the column is named sent_at, not
// created_at — the spec's "created_at" refers to the message's own
// timestamp, which is sent_at here).
export type MetricMessage = {
  threadId: string;
  direction: "inbound" | "outbound";
  sentAtMs: number;
  // True for the out-of-hours system auto-reply. Excluded from every
  // operator-response metric (first response, handled) so a courtesy
  // greeting never fakes a ~0-minute response time or an operator touch.
  isAutoReply?: boolean;
};

// A genuine operator reply — outbound and not the system auto-reply.
// Both response-time and handled counts pivot on this, so it lives in
// one place.
function isOperatorOutbound(m: MetricMessage): boolean {
  return m.direction === "outbound" && !m.isAutoReply;
}

// Minimal thread shape. openedAtMs = crm_threads.created_at;
// closedAtMs = crm_threads.closed_at (null while open);
// noReplyNeededAtMs = crm_threads.no_reply_needed_at (null unless an
// operator marked it "no reply needed").
export type MetricThread = {
  id: string;
  openedAtMs: number;
  closedAtMs: number | null;
  status: "open" | "closed";
  noReplyNeededAtMs?: number | null;
};

// Half-open period [startMs, endMs). Conversation membership is by
// opened-at for tiles 1 & 2 and by activity for tile 3 (see below).
export type Period = { startMs: number; endMs: number };

export type PeriodKind = "week" | "month" | "all";

export function parsePeriodKind(raw: string | null): PeriodKind {
  return raw === "month" || raw === "all" ? raw : "week";
}

const DAY = 24 * 60 * 60 * 1000;

// The Central calendar date `deltaDays` away from a given date, returned
// as {year, month, day}. Anchors at noon UTC of the source date so the
// ±day arithmetic never lands on a DST edge and always moves the Central
// date by exactly one per step.
function shiftCentralDate(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
  tz: string,
): { year: number; month: number; day: number } {
  const noon = Date.UTC(year, month - 1, day, 12) + deltaDays * DAY;
  const p = wallClockPartsInZone(noon, tz);
  return { year: p.year, month: p.month, day: p.day };
}

// 0 = Sunday … 6 = Saturday, for a Central calendar date.
function centralWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// Resolve the current and previous period bounds for a toggle selection.
//   week  → Monday 00:00 → next Monday 00:00 Central; previous = the week
//           before. (Mon–Sun, per the spec.)
//   month → 1st 00:00 → next 1st 00:00 Central; previous = prior month.
//   all   → earliestMs (or 0) → now; no previous period (trend dropped).
// Boundaries are true Central midnights, so DST never shifts a period
// edge by an hour.
export function resolvePeriodBounds(
  kind: PeriodKind,
  nowMs: number,
  earliestMs: number,
  tz: string = BUSINESS_TZ,
): { current: Period; previous: Period | null } {
  if (kind === "all") {
    return { current: { startMs: earliestMs, endMs: nowMs }, previous: null };
  }

  const today = wallClockPartsInZone(nowMs, tz);

  if (kind === "month") {
    const startThis = zonedWallClockToUtcMs(today.year, today.month, 1, 0, 0, tz);
    const nextMonth = today.month === 12 ? 1 : today.month + 1;
    const nextYear = today.month === 12 ? today.year + 1 : today.year;
    const endThis = zonedWallClockToUtcMs(nextYear, nextMonth, 1, 0, 0, tz);
    const prevMonth = today.month === 1 ? 12 : today.month - 1;
    const prevYear = today.month === 1 ? today.year - 1 : today.year;
    const startPrev = zonedWallClockToUtcMs(prevYear, prevMonth, 1, 0, 0, tz);
    return {
      current: { startMs: startThis, endMs: endThis },
      previous: { startMs: startPrev, endMs: startThis },
    };
  }

  // week — back up to Monday. dow: Sun=0..Sat=6 → days since Monday.
  const dow = centralWeekday(today.year, today.month, today.day);
  const sinceMonday = (dow + 6) % 7;
  const mon = shiftCentralDate(today.year, today.month, today.day, -sinceMonday, tz);
  const startThis = zonedWallClockToUtcMs(mon.year, mon.month, mon.day, 0, 0, tz);
  const nextMon = shiftCentralDate(mon.year, mon.month, mon.day, 7, tz);
  const endThis = zonedWallClockToUtcMs(nextMon.year, nextMon.month, nextMon.day, 0, 0, tz);
  const prevMon = shiftCentralDate(mon.year, mon.month, mon.day, -7, tz);
  const startPrev = zonedWallClockToUtcMs(prevMon.year, prevMon.month, prevMon.day, 0, 0, tz);
  return {
    current: { startMs: startThis, endMs: endThis },
    previous: { startMs: startPrev, endMs: startThis },
  };
}

export type PeriodMetrics = {
  // Tile 1 — median first-response time in BUSINESS minutes, over
  // conversations opened in the period that received a reply. null when
  // no conversation qualified.
  medianFirstResponseMin: number | null;
  // Tile 2 — share of those same conversations answered within 60
  // business minutes, as a 0–100 percent. null when none qualified.
  answeredWithin1hPct: number | null;
  // Denominator behind tiles 1 & 2: opened-in-period conversations that
  // got a reply. Surfaced so the UI can show "n conversations" and so a
  // tiny sample can be flagged rather than shown as a hard stat.
  respondedCount: number;
  // Opened in period but still awaiting a first reply — excluded from
  // the median per the spec, tracked for context.
  awaitingFirstReplyCount: number;

  // Tile 3 — "Handled this period".
  handled: {
    // Conversations with any operator (outbound) activity in the period.
    count: number;
    // Conversations opened in the period (the close-rate denominator).
    opened: number;
    // Conversations closed in the period (closed_at in range).
    resolved: number;
    // resolved / opened as a 0–100 percent. null when nothing opened.
    closeRatePct: number | null;
  };
};

// First-response business minutes for one conversation: first inbound →
// first operator outbound AT OR AFTER that inbound. Returns null when the
// conversation has no inbound, or no outbound following it (no reply yet
// → excluded from the median, per the spec).
export function firstResponseBusinessMinutes(
  messages: MetricMessage[],
  cfg: BusinessHoursConfig = DEFAULT_BUSINESS_HOURS,
): number | null {
  let firstInbound = Infinity;
  for (const m of messages) {
    if (m.direction === "inbound" && m.sentAtMs < firstInbound) {
      firstInbound = m.sentAtMs;
    }
  }
  if (!Number.isFinite(firstInbound)) return null;

  let firstReply = Infinity;
  for (const m of messages) {
    if (
      isOperatorOutbound(m) &&
      m.sentAtMs >= firstInbound &&
      m.sentAtMs < firstReply
    ) {
      firstReply = m.sentAtMs;
    }
  }
  if (!Number.isFinite(firstReply)) return null;

  return businessMinutesBetween(firstInbound, firstReply, cfg);
}

function groupByThread(
  messages: MetricMessage[],
): Map<string, MetricMessage[]> {
  const map = new Map<string, MetricMessage[]>();
  for (const m of messages) {
    const arr = map.get(m.threadId);
    if (arr) arr.push(m);
    else map.set(m.threadId, [m]);
  }
  return map;
}

const inPeriod = (ms: number | null, p: Period): boolean =>
  ms != null && ms >= p.startMs && ms < p.endMs;

// Compute tiles 1–3 for a single period. `threads` and `messages` may
// span more than the period (e.g. the route fetches current + previous
// in one go); membership is decided here by the timestamps, so passing a
// superset is fine and expected.
export function computePeriodMetrics(
  threads: MetricThread[],
  messages: MetricMessage[],
  period: Period,
  cfg: BusinessHoursConfig = DEFAULT_BUSINESS_HOURS,
): PeriodMetrics {
  const byThread = groupByThread(messages);

  // Conversations OPENED in the period drive tiles 1, 2 and the
  // close-rate denominator.
  const openedThreads = threads.filter((t) => inPeriod(t.openedAtMs, period));

  // Response-time metrics (median, answered-within-1h) count ONLY
  // conversations that received an actual operator outbound — no reply
  // means there is no response to time, so it never enters these
  // denominators and can never register as a slow response.
  // firstResponseBusinessMinutes returns null precisely in that case
  // (it pairs first inbound → first operator outbound and never falls
  // back to close-time or no_reply_needed_at as a response timestamp).
  const responseMinutes: number[] = [];
  let awaitingFirstReplyCount = 0;
  for (const t of openedThreads) {
    const msgs = byThread.get(t.id) ?? [];
    const rt = firstResponseBusinessMinutes(msgs, cfg);
    if (rt == null) {
      // No operator reply. It only "still awaits" if it's genuinely open
      // and unresolved — a closed / no-reply-needed thread was dealt
      // with, not left hanging, so it does not count as awaiting.
      const handledWithoutReply =
        t.closedAtMs != null || t.noReplyNeededAtMs != null || t.status === "closed";
      if (!handledWithoutReply) awaitingFirstReplyCount++;
    } else {
      responseMinutes.push(rt);
    }
  }

  const respondedCount = responseMinutes.length;
  const medianFirstResponseMin = median(responseMinutes);
  const within1h = responseMinutes.filter((m) => m <= 60).length;
  const answeredWithin1hPct =
    respondedCount === 0 ? null : (within1h / respondedCount) * 100;

  // Tile 3 — "handled" = every conversation we DEALT WITH in the period,
  // regardless of when it was opened or whether we replied. A ticket is
  // handled if any of these happened in the period:
  //   • an operator sent a reply (real outbound, not the auto-reply), OR
  //   • it was closed, OR
  //   • it was marked "no reply needed".
  // The last two capture tickets resolved without a reply (spam, a
  // duplicate, a self-resolved question we closed) — real volume we
  // handled, even though they correctly stay OUT of the response-time
  // metrics above.
  const handledThreadIds = new Set<string>();
  for (const m of messages) {
    // Auto-replies don't count as handling — a thread greeted overnight
    // but never worked by a person is not "handled".
    if (isOperatorOutbound(m) && inPeriod(m.sentAtMs, period)) {
      handledThreadIds.add(m.threadId);
    }
  }
  for (const t of threads) {
    if (inPeriod(t.closedAtMs, period) || inPeriod(t.noReplyNeededAtMs ?? null, period)) {
      handledThreadIds.add(t.id);
    }
  }

  const opened = openedThreads.length;
  const resolved = threads.filter((t) => inPeriod(t.closedAtMs, period)).length;
  const closeRatePct = opened === 0 ? null : (resolved / opened) * 100;

  return {
    medianFirstResponseMin,
    answeredWithin1hPct,
    respondedCount,
    awaitingFirstReplyCount,
    handled: {
      count: handledThreadIds.size,
      opened,
      resolved,
      closeRatePct,
    },
  };
}

// ---------------------------------------------------------------
// Live tile 4 — "Awaiting now"
// ---------------------------------------------------------------
// Not period-scoped. Waiting age uses REAL elapsed hours (not business
// minutes): the 24-hour figure is the WhatsApp customer-service window,
// which is wall-clock, so a thread that has waited past it needs a
// billable template regardless of business hours.

export const WHATSAPP_WINDOW_HOURS = 24;

export type AwaitingThread = {
  // crm_threads.last_message_at for an open, inbound-last thread.
  lastInboundAtMs: number;
};

export type AwaitingNow = {
  count: number;
  // Hours the longest-waiting thread has been waiting (real elapsed).
  // null when nothing is awaiting.
  oldestWaitingHours: number | null;
  // How many have waited past the 24h WhatsApp window.
  pastWindowCount: number;
};

export function computeAwaitingNow(
  awaiting: AwaitingThread[],
  nowMs: number,
  windowHours: number = WHATSAPP_WINDOW_HOURS,
): AwaitingNow {
  if (awaiting.length === 0) {
    return { count: 0, oldestWaitingHours: null, pastWindowCount: 0 };
  }
  let oldestMs = nowMs;
  let pastWindowCount = 0;
  const windowMs = windowHours * 60 * 60 * 1000;
  for (const t of awaiting) {
    if (t.lastInboundAtMs < oldestMs) oldestMs = t.lastInboundAtMs;
    if (nowMs - t.lastInboundAtMs >= windowMs) pastWindowCount++;
  }
  return {
    count: awaiting.length,
    oldestWaitingHours: Math.max(0, nowMs - oldestMs) / (60 * 60 * 1000),
    pastWindowCount,
  };
}

// ---------------------------------------------------------------
// Trend (tiles 1 & 2, week/month only)
// ---------------------------------------------------------------
// "Good" direction differs per tile: for median response time, LOWER is
// better (faster); for answered-within-1h, HIGHER is better. The UI
// colors green when the change is in the good direction. We return the
// raw signed deltas (current − previous) and let the UI apply the arrow
// + color, so the "which way is good" knowledge lives in one place there.

export type MetricTrend = {
  // current − previous, in business minutes. null when either side has
  // no data (can't form a comparison).
  medianDeltaMin: number | null;
  // current − previous, in percentage points. null when either side has
  // no data.
  within1hDeltaPct: number | null;
};

export function computeTrend(
  current: PeriodMetrics,
  previous: PeriodMetrics,
): MetricTrend {
  const medianDeltaMin =
    current.medianFirstResponseMin != null &&
    previous.medianFirstResponseMin != null
      ? current.medianFirstResponseMin - previous.medianFirstResponseMin
      : null;
  const within1hDeltaPct =
    current.answeredWithin1hPct != null && previous.answeredWithin1hPct != null
      ? current.answeredWithin1hPct - previous.answeredWithin1hPct
      : null;
  return { medianDeltaMin, within1hDeltaPct };
}
