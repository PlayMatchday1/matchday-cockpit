// Aggregation tests for the support-performance tiles. Business-minute
// correctness itself is covered in businessHours.finance-test.ts; here we
// test the conversation-level logic: which messages pair up, which
// conversations are in/out of each tile, and the trend deltas.
//
// Central summer offset (CDT, UTC−5): 9am = 14:00Z, 9pm = 02:00Z next.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstResponseBusinessMinutes,
  computePeriodMetrics,
  computeAwaitingNow,
  computeTrend,
  resolvePeriodBounds,
  parsePeriodKind,
  type MetricMessage,
  type MetricThread,
  type Period,
} from "./supportMetrics";

const iso = (s: string) => Date.parse(s);
const approx = (a: number | null, b: number, eps = 0.001) =>
  a != null && Math.abs(a - b) <= eps;

const msg = (
  threadId: string,
  direction: "inbound" | "outbound",
  at: string,
): MetricMessage => ({ threadId, direction, sentAtMs: iso(at) });

// A generous "all of July" period for the tiles that filter by opened-at.
const JULY: Period = {
  startMs: iso("2026-07-01T05:00:00Z"), // 7/1 00:00 CDT
  endMs: iso("2026-08-01T05:00:00Z"),
};

// ---------------------------------------------------------------
// firstResponseBusinessMinutes — pairing logic
// ---------------------------------------------------------------
test("first inbound → first following outbound, in business minutes", () => {
  const msgs = [
    msg("t", "inbound", "2026-07-22T15:00:00Z"), // 10:00am CDT
    msg("t", "outbound", "2026-07-22T15:30:00Z"), // 10:30am CDT
  ];
  assert.ok(approx(firstResponseBusinessMinutes(msgs), 30));
});

test("ignores outbound messages that predate the first inbound", () => {
  // We messaged first (outreach), THEN the customer replied, THEN we
  // answered. The response clock is customer-inbound → our next reply,
  // not the earlier outreach.
  const msgs = [
    msg("t", "outbound", "2026-07-22T14:30:00Z"), // 9:30am outreach
    msg("t", "inbound", "2026-07-22T15:00:00Z"), // 10:00am customer
    msg("t", "outbound", "2026-07-22T15:15:00Z"), // 10:15am our reply
  ];
  assert.ok(approx(firstResponseBusinessMinutes(msgs), 15));
});

test("no reply yet → null (excluded from the median)", () => {
  const msgs = [msg("t", "inbound", "2026-07-22T15:00:00Z")];
  assert.equal(firstResponseBusinessMinutes(msgs), null);
});

test("no inbound at all → null", () => {
  const msgs = [msg("t", "outbound", "2026-07-22T15:00:00Z")];
  assert.equal(firstResponseBusinessMinutes(msgs), null);
});

test("unordered message input still finds the true first pair", () => {
  const msgs = [
    msg("t", "outbound", "2026-07-22T16:00:00Z"),
    msg("t", "inbound", "2026-07-22T15:00:00Z"),
    msg("t", "outbound", "2026-07-22T15:20:00Z"), // the real first reply
    msg("t", "inbound", "2026-07-22T15:10:00Z"),
  ];
  assert.ok(approx(firstResponseBusinessMinutes(msgs), 20));
});

// ---------------------------------------------------------------
// computePeriodMetrics — tiles 1–3
// ---------------------------------------------------------------
const thread = (
  id: string,
  openedAt: string,
  closedAt: string | null = null,
): MetricThread => ({
  id,
  openedAtMs: iso(openedAt),
  closedAtMs: closedAt ? iso(closedAt) : null,
  status: closedAt ? "closed" : "open",
});

test("median + within-1h over opened-in-period conversations", () => {
  const threads = [
    thread("a", "2026-07-10T15:00:00Z"),
    thread("b", "2026-07-11T15:00:00Z"),
    thread("c", "2026-07-12T15:00:00Z"),
  ];
  const messages = [
    // a: 30 business min
    msg("a", "inbound", "2026-07-10T15:00:00Z"),
    msg("a", "outbound", "2026-07-10T15:30:00Z"),
    // b: 10 business min
    msg("b", "inbound", "2026-07-11T15:00:00Z"),
    msg("b", "outbound", "2026-07-11T15:10:00Z"),
    // c: 120 business min (over an hour)
    msg("c", "inbound", "2026-07-12T15:00:00Z"),
    msg("c", "outbound", "2026-07-12T17:00:00Z"),
  ];
  const m = computePeriodMetrics(threads, messages, JULY);
  assert.equal(m.respondedCount, 3);
  assert.ok(approx(m.medianFirstResponseMin, 30)); // median of 10,30,120
  // 2 of 3 within 60 min → 66.67%
  assert.ok(approx(m.answeredWithin1hPct, (2 / 3) * 100));
});

test("a single overnight outlier does not move the median", () => {
  // Four fast replies + one that spanned the closed band. Median holds
  // at the fast cluster; a mean would be dragged up.
  const threads = ["a", "b", "c", "d", "e"].map((id) =>
    thread(id, "2026-07-10T15:00:00Z"),
  );
  const messages = [
    msg("a", "inbound", "2026-07-10T15:00:00Z"),
    msg("a", "outbound", "2026-07-10T15:05:00Z"), // 5
    msg("b", "inbound", "2026-07-10T15:00:00Z"),
    msg("b", "outbound", "2026-07-10T15:06:00Z"), // 6
    msg("c", "inbound", "2026-07-10T15:00:00Z"),
    msg("c", "outbound", "2026-07-10T15:07:00Z"), // 7
    msg("d", "inbound", "2026-07-10T15:00:00Z"),
    msg("d", "outbound", "2026-07-10T15:08:00Z"), // 8
    // e: inbound 8:50pm, answered 9:10am next day = 20 business min.
    // (Even the "outlier" is tamed by business hours — the median still
    // sits in the single digits.)
    msg("e", "inbound", "2026-07-11T01:50:00Z"),
    msg("e", "outbound", "2026-07-11T14:10:00Z"),
  ];
  const m = computePeriodMetrics(threads, messages, JULY);
  assert.ok(approx(m.medianFirstResponseMin, 7)); // middle of 5,6,7,8,20
});

test("conversations opened outside the period are excluded from tiles 1–2", () => {
  const threads = [
    thread("in", "2026-07-10T15:00:00Z"),
    thread("before", "2026-06-10T15:00:00Z"), // June — out
  ];
  const messages = [
    msg("in", "inbound", "2026-07-10T15:00:00Z"),
    msg("in", "outbound", "2026-07-10T15:30:00Z"),
    msg("before", "inbound", "2026-06-10T15:00:00Z"),
    msg("before", "outbound", "2026-06-10T15:05:00Z"),
  ];
  const m = computePeriodMetrics(threads, messages, JULY);
  assert.equal(m.respondedCount, 1); // only "in"
  assert.ok(approx(m.medianFirstResponseMin, 30));
});

test("awaiting-first-reply conversations are counted but excluded from the median", () => {
  const threads = [
    thread("answered", "2026-07-10T15:00:00Z"),
    thread("waiting", "2026-07-10T16:00:00Z"),
  ];
  const messages = [
    msg("answered", "inbound", "2026-07-10T15:00:00Z"),
    msg("answered", "outbound", "2026-07-10T15:20:00Z"),
    msg("waiting", "inbound", "2026-07-10T16:00:00Z"), // no reply
  ];
  const m = computePeriodMetrics(threads, messages, JULY);
  assert.equal(m.respondedCount, 1);
  assert.equal(m.awaitingFirstReplyCount, 1);
  assert.ok(approx(m.medianFirstResponseMin, 20));
});

test("handled counts operator activity in the period regardless of open date; close rate is closed/opened", () => {
  const threads = [
    // opened in June, but we worked it in July → handled, not opened
    thread("old", "2026-06-20T15:00:00Z", "2026-07-15T15:00:00Z"),
    // opened + closed in July
    thread("new", "2026-07-05T15:00:00Z", "2026-07-06T15:00:00Z"),
    // opened in July, still open
    thread("open", "2026-07-08T15:00:00Z"),
  ];
  const messages = [
    msg("old", "outbound", "2026-07-15T14:50:00Z"), // July activity
    msg("new", "inbound", "2026-07-05T15:00:00Z"),
    msg("new", "outbound", "2026-07-05T15:10:00Z"),
    msg("open", "inbound", "2026-07-08T15:00:00Z"),
    msg("open", "outbound", "2026-07-08T15:10:00Z"),
  ];
  const m = computePeriodMetrics(threads, messages, JULY);
  assert.equal(m.handled.count, 3); // all three had July outbound
  assert.equal(m.handled.opened, 2); // new + open opened in July
  assert.equal(m.handled.resolved, 2); // old + new closed in July
  assert.ok(approx(m.handled.closeRatePct, 100)); // 2 resolved / 2 opened
});

test("empty period yields nulls, not NaN or zero-division", () => {
  const m = computePeriodMetrics([], [], JULY);
  assert.equal(m.medianFirstResponseMin, null);
  assert.equal(m.answeredWithin1hPct, null);
  assert.equal(m.handled.closeRatePct, null);
  assert.equal(m.respondedCount, 0);
  assert.equal(m.handled.count, 0);
});

// ---------------------------------------------------------------
// computeAwaitingNow — live tile 4
// ---------------------------------------------------------------
test("awaiting-now: count, oldest age (real hours), past-window count", () => {
  const now = iso("2026-07-24T18:00:00Z");
  const awaiting = [
    { lastInboundAtMs: iso("2026-07-24T17:00:00Z") }, // 1h ago
    { lastInboundAtMs: iso("2026-07-23T10:00:00Z") }, // ~32h ago — past window
    { lastInboundAtMs: iso("2026-07-24T15:00:00Z") }, // 3h ago
  ];
  const a = computeAwaitingNow(awaiting, now);
  assert.equal(a.count, 3);
  assert.ok(approx(a.oldestWaitingHours, 32)); // 17:00 7/23 → 18:00 7/24
  assert.equal(a.pastWindowCount, 1); // only the 32h one
});

test("awaiting-now uses REAL elapsed hours, not business hours", () => {
  // A thread waiting since 10pm answered-nothing overnight is still
  // 'waiting' by the WhatsApp clock even though zero business minutes
  // elapsed — the window is wall-clock.
  const now = iso("2026-07-24T13:00:00Z"); // 8am CDT
  const awaiting = [{ lastInboundAtMs: iso("2026-07-24T03:00:00Z") }]; // 10pm prev
  const a = computeAwaitingNow(awaiting, now);
  assert.ok(approx(a.oldestWaitingHours, 10));
});

test("awaiting-now: nothing waiting → zeros and null age", () => {
  const a = computeAwaitingNow([], iso("2026-07-24T18:00:00Z"));
  assert.equal(a.count, 0);
  assert.equal(a.oldestWaitingHours, null);
  assert.equal(a.pastWindowCount, 0);
});

// ---------------------------------------------------------------
// computeTrend — signed deltas
// ---------------------------------------------------------------
const metricsWith = (medianMin: number | null, within1h: number | null) =>
  ({
    medianFirstResponseMin: medianMin,
    answeredWithin1hPct: within1h,
    respondedCount: 0,
    awaitingFirstReplyCount: 0,
    handled: { count: 0, opened: 0, resolved: 0, closeRatePct: null },
  }) as const;

test("trend returns current − previous for both metrics", () => {
  const t = computeTrend(metricsWith(20, 80), metricsWith(30, 70));
  assert.equal(t.medianDeltaMin, -10); // 10 min faster (good)
  assert.equal(t.within1hDeltaPct, 10); // 10 points higher (good)
});

test("trend is null when either side lacks data", () => {
  const t = computeTrend(metricsWith(20, null), metricsWith(null, 70));
  assert.equal(t.medianDeltaMin, null);
  assert.equal(t.within1hDeltaPct, null);
});

// ---------------------------------------------------------------
// resolvePeriodBounds — period math
// ---------------------------------------------------------------
test("parsePeriodKind defaults to week; accepts month/all", () => {
  assert.equal(parsePeriodKind(null), "week");
  assert.equal(parsePeriodKind("today"), "week"); // NOT a valid option
  assert.equal(parsePeriodKind("month"), "month");
  assert.equal(parsePeriodKind("all"), "all");
});

test("week bounds run Monday 00:00 → next Monday 00:00 Central", () => {
  // Wed 2026-07-22 12:00 CDT (17:00Z). This week = Mon 7/20 → Mon 7/27.
  const now = iso("2026-07-22T17:00:00Z");
  const { current, previous } = resolvePeriodBounds("week", now, 0);
  assert.equal(current.startMs, iso("2026-07-20T05:00:00Z")); // Mon 00:00 CDT
  assert.equal(current.endMs, iso("2026-07-27T05:00:00Z")); // next Mon 00:00
  assert.equal(previous!.startMs, iso("2026-07-13T05:00:00Z"));
  assert.equal(previous!.endMs, current.startMs); // contiguous
});

test("week bounds on a Sunday still belong to the Mon–Sun week just ending", () => {
  // Sun 2026-07-26 20:00 CDT (2026-07-27 01:00Z) → week is Mon 7/20–7/27.
  const now = iso("2026-07-27T01:00:00Z");
  const { current } = resolvePeriodBounds("week", now, 0);
  assert.equal(current.startMs, iso("2026-07-20T05:00:00Z"));
  assert.equal(current.endMs, iso("2026-07-27T05:00:00Z"));
});

test("month bounds run 1st 00:00 → next 1st 00:00 Central, previous = prior month", () => {
  const now = iso("2026-07-22T17:00:00Z");
  const { current, previous } = resolvePeriodBounds("month", now, 0);
  assert.equal(current.startMs, iso("2026-07-01T05:00:00Z")); // Jul 1 00:00 CDT
  assert.equal(current.endMs, iso("2026-08-01T05:00:00Z")); // Aug 1 00:00 CDT
  assert.equal(previous!.startMs, iso("2026-06-01T05:00:00Z")); // Jun 1 00:00 CDT
  assert.equal(previous!.endMs, current.startMs);
});

test("month bounds roll the year over in January", () => {
  const now = iso("2026-01-10T18:00:00Z"); // Jan 2026, CST (UTC−6)
  const { current, previous } = resolvePeriodBounds("month", now, 0);
  assert.equal(current.startMs, iso("2026-01-01T06:00:00Z")); // Jan 1 00:00 CST
  assert.equal(previous!.startMs, iso("2025-12-01T06:00:00Z")); // Dec 1 00:00 CST
});

test("all-time runs earliest → now with no previous period", () => {
  const earliest = iso("2026-05-15T03:34:34Z");
  const now = iso("2026-07-24T18:00:00Z");
  const { current, previous } = resolvePeriodBounds("all", now, earliest);
  assert.equal(current.startMs, earliest);
  assert.equal(current.endMs, now);
  assert.equal(previous, null); // trend chip dropped for all-time
});
