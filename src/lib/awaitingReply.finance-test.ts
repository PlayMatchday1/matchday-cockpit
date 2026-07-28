// Guards for the awaiting-reply escalation math. The tiers gate a real
// cost (past 24h, replying needs a billable template), so the 12h/24h
// boundaries and the age labels must not drift silently.
//
// Run: npx tsx --test src/lib/awaitingReply.finance-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  awaitingAgeLabel,
  isAwaitingReply,
  isWrappingUp,
  isAcknowledgment,
  isFreshThreadUpdate,
  waitingSinceMs,
  firstResponseCue,
  firstResponseCueDescription,
  nextWaitingSince,
  type CueMessage,
} from "./awaitingReply";
import {
  zonedWallClockToUtcMs,
  FIRST_RESPONSE_SLA_MINUTES,
} from "./businessHours";

const NOW = Date.parse("2026-07-22T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

test("age labels: minutes, hours (legible past 24h), then days", () => {
  assert.equal(awaitingAgeLabel(minsAgo(0.5), NOW), "now");
  assert.equal(awaitingAgeLabel(minsAgo(45), NOW), "45m");
  assert.equal(awaitingAgeLabel(hoursAgo(3), NOW), "3h");
  assert.equal(awaitingAgeLabel(hoursAgo(18), NOW), "18h");
  // Past 24h stays in hours until 48h — matches the mock's "27h".
  assert.equal(awaitingAgeLabel(hoursAgo(27), NOW), "27h");
  assert.equal(awaitingAgeLabel(hoursAgo(48), NOW), "2d");
  assert.equal(awaitingAgeLabel(hoursAgo(72), NOW), "3d");
});

// ---------------------------------------------------------------
// Clearing rule: an OUTBOUND message flips a thread out of awaiting.
// This is the bug the +15127432386 thread hit — a reply updated the
// preview but the row stayed in the green Awaiting group.
// ---------------------------------------------------------------

const awaitingThread = {
  status: "open" as const,
  last_message_direction: "inbound" as const,
};

test("an operator reply (outbound) clears the awaiting indicator", () => {
  assert.equal(isAwaitingReply(awaitingThread), true, "inbound-last is awaiting");
  // Apply the outbound patch the way onSent does.
  const afterReply = { ...awaitingThread, last_message_direction: "outbound" as const };
  assert.equal(
    isAwaitingReply(afterReply),
    false,
    "after our reply the thread must be Answered, not Awaiting",
  );
});

test("only status=open + inbound is awaiting", () => {
  assert.equal(isAwaitingReply({ status: "open", last_message_direction: "inbound" }), true);
  assert.equal(isAwaitingReply({ status: "open", last_message_direction: "outbound" }), false);
  assert.equal(isAwaitingReply({ status: "open", last_message_direction: null }), false);
  // A closed thread is never awaiting, even if the customer spoke last.
  assert.equal(isAwaitingReply({ status: "closed", last_message_direction: "inbound" }), false);
});

test("a stale realtime payload can't revert a fresher reply", () => {
  // The reply landed at 00:52; a delayed crm_threads event from the
  // 00:48 inbound must be ignored so it can't drag the row back to
  // Awaiting.
  const replyAt = "2026-07-23T00:52:45Z";
  const staleInboundAt = "2026-07-23T00:48:11Z";
  assert.equal(isFreshThreadUpdate(replyAt, staleInboundAt), false, "older event is stale");
  assert.equal(isFreshThreadUpdate(staleInboundAt, replyAt), true, "newer event applies");
  // Equal timestamps (e.g. an assign event carrying the same
  // last_message_at) still apply.
  assert.equal(isFreshThreadUpdate(replyAt, replyAt), true);
});

test("missing/unparseable incoming timestamp never blocks an update", () => {
  assert.equal(isFreshThreadUpdate("2026-07-23T00:52:45Z", null), true);
  assert.equal(isFreshThreadUpdate("2026-07-23T00:52:45Z", undefined), true);
  assert.equal(isFreshThreadUpdate("2026-07-23T00:52:45Z", "garbage"), true);
});

test("awaitingAgeLabel: unparseable / future timestamps clamp to now, never crash", () => {
  assert.equal(awaitingAgeLabel("not-a-date", NOW), "");
  const future = new Date(NOW + 3600_000).toISOString();
  assert.equal(awaitingAgeLabel(future, NOW), "now");
});

// ============================================================
// Acknowledgment detection + refined awaiting predicate
// ============================================================

test("isAcknowledgment: whole-message closing courtesies are acks", () => {
  for (const s of [
    "Thank you", "thanks", "Thanks!", "thank you so much", "Okay thanks",
    "ok", "OK", "Ok.", "got it", "Perfect", "sounds good", "will do",
    "no problem", "much appreciated", "cheers", "all good", "np",
  ]) {
    assert.equal(isAcknowledgment(s), true, `"${s}" should be an ack`);
  }
});

test("isAcknowledgment: emoji-only thanks are acks (with modifiers/repeats)", () => {
  for (const s of ["👍", "🙏", "❤️", "👍👍", "🙏 🙏", "👍🏽", "👌", "✅"]) {
    assert.equal(isAcknowledgment(s), true, `"${s}" should be an ack`);
  }
});

test("isAcknowledgment: anything with a question is NOT an ack", () => {
  // The load-bearing case — a question must always stay awaiting.
  assert.equal(isAcknowledgment("thanks, can you move me to green?"), false);
  assert.equal(isAcknowledgment("ok but when does it start?"), false);
  assert.equal(isAcknowledgment("when does it start?"), false);
  assert.equal(isAcknowledgment("thanks?"), false); // even a bare "thanks?"
});

test("isAcknowledgment: substantive messages are NOT acks", () => {
  assert.equal(isAcknowledgment("I need to cancel my membership"), false);
  assert.equal(isAcknowledgment("thanks for that, one more thing"), false);
  assert.equal(isAcknowledgment("please move me to the green team"), false);
  assert.equal(isAcknowledgment("👍 but also I can't make it"), false); // emoji + words
  assert.equal(isAcknowledgment("😡"), false); // non-ack emoji
});

test("isAcknowledgment: empty / whitespace / over-length are NOT acks", () => {
  assert.equal(isAcknowledgment(null), false);
  assert.equal(isAcknowledgment(undefined), false);
  assert.equal(isAcknowledgment(""), false);
  assert.equal(isAcknowledgment("   "), false);
  // Under 20 chars but not a known phrase → stay awaiting (strict).
  assert.equal(isAcknowledgment("move me please"), false);
});

test("refined isAwaitingReply: an acknowledgment last-message is NOT awaiting", () => {
  const base = {
    status: "open" as const,
    last_message_direction: "inbound" as const,
    last_message_at: "2026-07-22T17:00:00Z",
    no_reply_needed_at: null,
  };
  // real example: "Thank you" / "Okay thanks" should drop out
  assert.equal(
    isAwaitingReply({ ...base, last_message_preview: "Thank you" }),
    false,
  );
  assert.equal(
    isAwaitingReply({ ...base, last_message_preview: "Okay thanks" }),
    false,
  );
  // ...while a genuine request stays awaiting
  assert.equal(
    isAwaitingReply({
      ...base,
      last_message_preview: "thanks, can you move me to green?",
    }),
    true,
  );
  assert.equal(
    isAwaitingReply({ ...base, last_message_preview: "when does it start?" }),
    true,
  );
});

test("refined isAwaitingReply: manual dismissal suppresses; a newer inbound revives it", () => {
  const preview = "I need to cancel"; // genuine, not an ack
  // Dismissed AFTER the last message → not awaiting (wrapping up).
  assert.equal(
    isAwaitingReply({
      status: "open",
      last_message_direction: "inbound",
      last_message_preview: preview,
      last_message_at: "2026-07-22T17:00:00Z",
      no_reply_needed_at: "2026-07-22T17:05:00Z",
    }),
    false,
  );
  // A NEW inbound (later last_message_at) supersedes the old dismissal.
  assert.equal(
    isAwaitingReply({
      status: "open",
      last_message_direction: "inbound",
      last_message_preview: preview,
      last_message_at: "2026-07-22T18:00:00Z",
      no_reply_needed_at: "2026-07-22T17:05:00Z",
    }),
    true,
  );
});

test("isWrappingUp is the inbound-last complement of awaiting", () => {
  const ack = {
    status: "open" as const,
    last_message_direction: "inbound" as const,
    last_message_preview: "Thank you",
    last_message_at: "2026-07-22T17:00:00Z",
    no_reply_needed_at: null,
  };
  assert.equal(isWrappingUp(ack), true);
  assert.equal(isAwaitingReply(ack), false);

  const genuine = { ...ack, last_message_preview: "can you help?" };
  assert.equal(isWrappingUp(genuine), false);
  assert.equal(isAwaitingReply(genuine), true);

  // Outbound-last is neither awaiting nor wrapping-up.
  const answered = { ...ack, last_message_direction: "outbound" as const };
  assert.equal(isWrappingUp(answered), false);
  assert.equal(isAwaitingReply(answered), false);
});

test("backward-compat: callers passing only status+direction keep old behavior", () => {
  // No preview / dismissal supplied → no suppression, exactly as before.
  assert.equal(
    isAwaitingReply({ status: "open", last_message_direction: "inbound" }),
    true,
  );
  assert.equal(
    isAwaitingReply({ status: "open", last_message_direction: "outbound" }),
    false,
  );
});

// ============================================================
// First-response cue — the SLA ↔ window ladder (Decision 1)
// ============================================================
// Central wall-clock → UTC ms. February = CST (UTC-6), no DST edge in play.
const ct = (y: number, mo: number, d: number, h: number, mi = 0) =>
  zonedWallClockToUtcMs(y, mo, d, h, mi);
const approx = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

test("cue: overnight wait counts BUSINESS minutes, not wall-clock hours", () => {
  // Inbound 8:50pm, evaluated 9:10am next day. Business time = 10m (8:50–9pm)
  // + 10m (9–9:10am) = ~20m, NOT ~12h. (The 12h20m real gap also puts it past
  // the window — asserted separately below; here we pin the minute count.)
  const waiting = ct(2026, 2, 10, 20, 50);
  const now = ct(2026, 2, 11, 9, 10);
  const cue = firstResponseCue(waiting, waiting, now)!;
  assert.ok(approx(cue.elapsedBusinessMinutes, 20), `got ${cue.elapsedBusinessMinutes}`);
});

test("cue: neutral vs warm vs breached thresholds derive from the SLA constant", () => {
  const start = ct(2026, 2, 10, 10, 0); // 10:00am, deep inside business hours
  const at = (mins: number) => firstResponseCue(start, start, start + mins * 60_000)!;
  assert.equal(at(FIRST_RESPONSE_SLA_MINUTES * 0.5 - 1).tier, "neutral");
  assert.equal(at(FIRST_RESPONSE_SLA_MINUTES * 0.5).tier, "warm");
  assert.equal(at(FIRST_RESPONSE_SLA_MINUTES - 1).tier, "warm");
  assert.equal(at(FIRST_RESPONSE_SLA_MINUTES).tier, "breached");
  assert.equal(at(4).label, "4m");
  assert.equal(at(72).label, "1h 12m");
  assert.equal(at(10).reason, "sla");
});

test("cue: warm on SLA but past the 12h window resolves red / window-closing", () => {
  // First inbound 8:20pm, last inbound 8:30pm, evaluated 9:00am next day.
  // SLA elapsed = 40 business min (warm), but the window is 12.5h → closing.
  // Severity is the max: red, and the chip text is the window fact.
  const waiting = ct(2026, 2, 10, 20, 20);
  const lastInbound = ct(2026, 2, 10, 20, 30);
  const now = ct(2026, 2, 11, 9, 0);
  const cue = firstResponseCue(waiting, lastInbound, now)!;
  assert.ok(approx(cue.elapsedBusinessMinutes, 40), `elapsed ${cue.elapsedBusinessMinutes}`);
  assert.equal(cue.tier, "breached");
  assert.equal(cue.reason, "window-closing");
  assert.match(cue.label, /window$/);
});

test("cue: past 24h window → template, regardless of SLA", () => {
  const waiting = ct(2026, 2, 10, 10, 0);
  const lastInbound = ct(2026, 2, 10, 8, 0); // 25h before now
  const now = ct(2026, 2, 11, 9, 0);
  const cue = firstResponseCue(waiting, lastInbound, now)!;
  assert.equal(cue.tier, "breached");
  assert.equal(cue.reason, "window-closed");
  assert.equal(cue.label, "template");
  assert.match(firstResponseCueDescription(cue), /template is required/);
});

test("cue: paused outside business hours — elapsed is frozen", () => {
  // Inbound 8:50pm; evaluated at 9:30pm and again at 11:00pm. Nothing accrues
  // after the 9pm close, so the two readings are identical (~10 business min).
  const waiting = ct(2026, 2, 10, 20, 50);
  const a = firstResponseCue(waiting, waiting, ct(2026, 2, 10, 21, 30))!;
  const b = firstResponseCue(waiting, waiting, ct(2026, 2, 10, 23, 0))!;
  assert.equal(a.elapsedBusinessMinutes, b.elapsedBusinessMinutes);
  assert.ok(approx(a.elapsedBusinessMinutes, 10), `got ${a.elapsedBusinessMinutes}`);
  assert.equal(a.tier, "neutral"); // window healthy, < 50% SLA
});

test("cue: null waitingSince → no cue", () => {
  assert.equal(firstResponseCue(null, "2026-02-10T10:00:00Z", Date.now()), null);
});

test("waitingSince: anchors on the FIRST inbound of a multi-message run", () => {
  const ep = ct(2026, 2, 10, 9, 0);
  const msgs: CueMessage[] = [
    { direction: "inbound", sentAtMs: ct(2026, 2, 10, 10, 0) },
    { direction: "inbound", sentAtMs: ct(2026, 2, 10, 10, 15) },
    { direction: "inbound", sentAtMs: ct(2026, 2, 10, 10, 30) },
  ];
  assert.equal(waitingSinceMs(msgs, ep), ct(2026, 2, 10, 10, 0));
});

test("waitingSince: first inbound AFTER our last genuine reply (auto-reply ignored)", () => {
  const ep = ct(2026, 2, 10, 9, 0);
  const msgs: CueMessage[] = [
    { direction: "inbound", sentAtMs: ct(2026, 2, 10, 9, 30) },
    { direction: "outbound", sentAtMs: ct(2026, 2, 10, 9, 45), isAutoReply: true }, // greeting: ignored
    { direction: "outbound", sentAtMs: ct(2026, 2, 10, 10, 0) }, // real reply
    { direction: "inbound", sentAtMs: ct(2026, 2, 10, 11, 0) }, // new wait starts here
    { direction: "inbound", sentAtMs: ct(2026, 2, 10, 11, 20) },
  ];
  assert.equal(waitingSinceMs(msgs, ep), ct(2026, 2, 10, 11, 0));
});

test("waitingSince: reopened thread starts at the reopen, not the original inbound", () => {
  const reopenMs = ct(2026, 2, 11, 11, 0);
  const msgs: CueMessage[] = [
    { direction: "inbound", sentAtMs: ct(2026, 2, 10, 10, 0) }, // original contact
    { direction: "outbound", sentAtMs: ct(2026, 2, 10, 10, 30) }, // answered, then closed
    { direction: "inbound", sentAtMs: reopenMs }, // reopen inbound
  ];
  // Episode scoped to the reopen: pre-reopen messages are excluded.
  assert.equal(waitingSinceMs(msgs, reopenMs), reopenMs);
});

// ============================================================
// nextWaitingSince — realtime maintenance of the SLA anchor (Decision 2).
// The highest-risk regression: if a new inbound moved the anchor, a customer
// could reset their own clock and the UI would still look correct.
// ============================================================
const T0 = "2026-02-10T16:00:00.000Z"; // first inbound
const T1 = "2026-02-10T16:20:00.000Z"; // a later message

test("nextWaitingSince: a SECOND inbound on an already-waiting thread does NOT move the anchor", () => {
  const prev = {
    status: "open" as const,
    last_message_direction: "inbound" as const,
    waiting_since: T0,
  };
  const next = nextWaitingSince(prev, { direction: "inbound", sentAt: T1 });
  assert.equal(next, T0, "follow-up inbound must keep the first unanswered inbound");
});

test("nextWaitingSince: an operator outbound clears the anchor to null (cue removed)", () => {
  const prev = {
    status: "open" as const,
    last_message_direction: "inbound" as const,
    waiting_since: T0,
  };
  assert.equal(nextWaitingSince(prev, { direction: "outbound", sentAt: T1 }), null);
});

test("nextWaitingSince: an is_auto_reply outbound does NOT clear the anchor", () => {
  const prev = {
    status: "open" as const,
    last_message_direction: "inbound" as const,
    waiting_since: T0,
  };
  const next = nextWaitingSince(prev, {
    direction: "outbound",
    sentAt: T1,
    isAutoReply: true,
  });
  assert.equal(next, T0, "the courtesy greeting must not stop the customer's clock");
});

test("nextWaitingSince: an inbound on a CLOSED thread (auto_reopen) anchors to that inbound", () => {
  // A closed thread carries a stale waiting_since from before it was closed;
  // the reopen inbound must start a fresh wait, not resurrect the old anchor.
  const prev = {
    status: "closed" as const,
    last_message_direction: "inbound" as const,
    waiting_since: "2026-02-01T10:00:00.000Z", // stale, pre-close
  };
  assert.equal(nextWaitingSince(prev, { direction: "inbound", sentAt: T1 }), T1);
});

test("nextWaitingSince: an inbound on an ANSWERED (outbound-last) thread starts a new wait", () => {
  const prev = {
    status: "open" as const,
    last_message_direction: "outbound" as const,
    waiting_since: null,
  };
  assert.equal(nextWaitingSince(prev, { direction: "inbound", sentAt: T1 }), T1);
});

test("cue fires for an awaiting thread with an EMPTY preview (no preview gate)", () => {
  // The row's cue condition is exactly isAwaitingReply(thread) — a text-less
  // inbound (location/photo/voice) is still awaiting and must render a cue.
  const thread = {
    status: "open" as const,
    last_message_direction: "inbound" as const,
    last_message_preview: "", // empty — the old gate suppressed this
    last_message_at: new Date(ct(2026, 2, 10, 10, 40)).toISOString(),
    no_reply_needed_at: null,
  };
  assert.equal(isAwaitingReply(thread), true, "empty preview must not suppress awaiting");
  const waiting = ct(2026, 2, 10, 10, 0);
  const cue = firstResponseCue(
    new Date(waiting).toISOString(),
    thread.last_message_at,
    ct(2026, 2, 10, 10, 40), // 40 business min later, window healthy → warm
  )!;
  assert.equal(cue.tier, "warm");
  assert.equal(cue.label, "40m");
});
