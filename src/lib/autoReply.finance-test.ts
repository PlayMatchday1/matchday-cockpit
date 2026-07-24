// Out-of-hours auto-reply decision + debounce. Central summer offset
// (CDT, UTC−5): business window 9am–9pm = 14:00Z–02:00Z(next).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldAutoReply,
  OUT_OF_HOURS_AUTO_REPLY_TEXT,
} from "./autoReply";

const iso = (s: string) => Date.parse(s);

test("the reply copy is a non-empty config constant mentioning the hours", () => {
  assert.ok(OUT_OF_HOURS_AUTO_REPLY_TEXT.length > 0);
  assert.match(OUT_OF_HOURS_AUTO_REPLY_TEXT, /9am–9pm/);
  assert.match(OUT_OF_HOURS_AUTO_REPLY_TEXT, /Central/);
});

test("in-hours inbound never auto-replies", () => {
  // 10:00am CDT.
  const d = shouldAutoReply({
    nowMs: iso("2026-07-22T15:00:00Z"),
    autoReplySentAtMs: null,
  });
  assert.equal(d.send, false);
  assert.equal(d.closedPeriodStartMs, null);
});

test("first out-of-hours inbound with no prior auto-reply sends", () => {
  // 10:30pm CDT 7/22.
  const d = shouldAutoReply({
    nowMs: iso("2026-07-23T03:30:00Z"),
    autoReplySentAtMs: null,
  });
  assert.equal(d.send, true);
  assert.equal(d.closedPeriodStartMs, iso("2026-07-23T02:00:00Z")); // 9pm CDT
});

test("second inbound in the SAME gap does not re-send (debounce)", () => {
  // Already greeted at 10:30pm; a new message at 11:15pm same night.
  const greetedAt = iso("2026-07-23T03:30:00Z"); // 10:30pm 7/22
  const d = shouldAutoReply({
    nowMs: iso("2026-07-23T04:15:00Z"), // 11:15pm 7/22
    autoReplySentAtMs: greetedAt,
  });
  assert.equal(d.send, false);
});

test("greeted at 10pm, customer writes again at 6am — same gap, no re-send", () => {
  const greetedAt = iso("2026-07-23T03:00:00Z"); // 10pm 7/22
  const d = shouldAutoReply({
    nowMs: iso("2026-07-23T11:00:00Z"), // 6am 7/23 — still the 9pm→9am gap
    autoReplySentAtMs: greetedAt,
  });
  assert.equal(d.send, false);
});

test("a fresh out-of-hours gap on the next night greets again", () => {
  // Greeted last night at 10pm 7/22; new inbound 10pm 7/23 (a new gap).
  const greetedLastNight = iso("2026-07-23T03:00:00Z"); // 10pm 7/22
  const d = shouldAutoReply({
    nowMs: iso("2026-07-24T03:00:00Z"), // 10pm 7/23
    autoReplySentAtMs: greetedLastNight,
  });
  assert.equal(d.send, true);
  assert.equal(d.closedPeriodStartMs, iso("2026-07-24T02:00:00Z")); // 9pm 7/23
});

test("an inbound that arrives in-hours after an out-of-hours greeting doesn't send", () => {
  // Greeted overnight; the customer's follow-up lands at 10am — no greet.
  const d = shouldAutoReply({
    nowMs: iso("2026-07-23T15:00:00Z"), // 10am CDT
    autoReplySentAtMs: iso("2026-07-23T11:00:00Z"), // 6am greeting
  });
  assert.equal(d.send, false);
  assert.equal(d.closedPeriodStartMs, null);
});

test("a stale auto-reply from a PREVIOUS gap does not block a new gap", () => {
  // Last greeting was days ago; tonight is out of hours → greet.
  const d = shouldAutoReply({
    nowMs: iso("2026-07-23T03:30:00Z"), // 10:30pm 7/22
    autoReplySentAtMs: iso("2026-07-18T04:00:00Z"), // 11pm 7/17
  });
  assert.equal(d.send, true);
});
