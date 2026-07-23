// Guards for the awaiting-reply escalation math. The tiers gate a real
// cost (past 24h, replying needs a billable template), so the 12h/24h
// boundaries and the age labels must not drift silently.
//
// Run: npx tsx --test src/lib/awaitingReply.finance-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  awaitingReplyState,
  awaitingAgeLabel,
  AWAITING_WINDOW_CLOSING_HOURS,
  AWAITING_WINDOW_CLOSED_HOURS,
} from "./awaitingReply";

const NOW = Date.parse("2026-07-22T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

test("fresh: under 12h replies normally, no note", () => {
  for (const h of [0, 1, 3, 11.9]) {
    const s = awaitingReplyState(hoursAgo(h), NOW);
    assert.equal(s.tier, "fresh", `${h}h should be fresh`);
    assert.equal(s.note, "");
  }
});

test("closing: 12h up to (not incl.) 24h", () => {
  for (const h of [12, 14, 18, 23.9]) {
    const s = awaitingReplyState(hoursAgo(h), NOW);
    assert.equal(s.tier, "closing", `${h}h should be closing`);
    assert.equal(s.note, "window closing");
  }
});

test("closed: 24h and beyond needs the template", () => {
  for (const h of [24, 27, 48, 72]) {
    const s = awaitingReplyState(hoursAgo(h), NOW);
    assert.equal(s.tier, "closed", `${h}h should be closed`);
    assert.equal(s.note, "window closed — template required");
  }
});

test("boundaries are inclusive at the top (urgency surfaces sooner)", () => {
  // Exactly 12h is already closing; exactly 24h is already closed.
  assert.equal(
    awaitingReplyState(hoursAgo(AWAITING_WINDOW_CLOSING_HOURS), NOW).tier,
    "closing",
  );
  assert.equal(
    awaitingReplyState(hoursAgo(AWAITING_WINDOW_CLOSED_HOURS), NOW).tier,
    "closed",
  );
  // A hair under each boundary is the lower tier.
  assert.equal(
    awaitingReplyState(hoursAgo(AWAITING_WINDOW_CLOSING_HOURS - 0.01), NOW).tier,
    "fresh",
  );
  assert.equal(
    awaitingReplyState(hoursAgo(AWAITING_WINDOW_CLOSED_HOURS - 0.01), NOW).tier,
    "closing",
  );
});

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

test("unparseable / future timestamps degrade to fresh, never crash", () => {
  assert.equal(awaitingReplyState("not-a-date", NOW).tier, "fresh");
  // A future timestamp clamps age to 0 (fresh), doesn't go negative-tier.
  const future = new Date(NOW + 3600_000).toISOString();
  assert.equal(awaitingReplyState(future, NOW).tier, "fresh");
  assert.equal(awaitingAgeLabel(future, NOW), "now");
});
