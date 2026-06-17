// Run: `npm test` (or `node --test src/lib/telnyxSmsClassify.test.ts`)
//
// Examples are the real bodies captured by the one-time probe over a
// 7-day window (242 outbound seen, 126 bodies), phone-redacted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySmsBody } from "./telnyxSmsClassify.ts";

test("player_match_reminder: 'Your match at ... starts in'", () => {
  assert.equal(
    classifySmsBody(
      "Your match at Jun 16 - 8:30 PM at San Juan Diego Catholic High School starts in 2 hours!!",
    ),
    "player_match_reminder",
  );
});

test("manager_match_reminder: 'The match you're managing ... kicks off in'", () => {
  assert.equal(
    classifySmsBody(
      "The match you're managing at Jun 16 - 8:30 PM at NEMP Tournaments kicks off in 3 hours!",
    ),
    "manager_match_reminder",
  );
});

test("manager_match_reminder: curly apostrophe still matches", () => {
  assert.equal(
    classifySmsBody(
      "The match you’re managing at Jun 16 - 8:30 PM at NEMP kicks off in 3 hours!",
    ),
    "manager_match_reminder",
  );
});

test("match_cancellation: MatchDay: ... is cancelled + match credit", () => {
  assert.equal(
    classifySmsBody(
      "MatchDay: PAC GLOBAL (Jun 16 - 9:00 PM) is cancelled.\nA match credit has been added.",
    ),
    "match_cancellation",
  );
});

test("welcome_intro: 'MatchDay SC: Welcome' + $1 variant", () => {
  assert.equal(
    classifySmsBody(
      "MatchDay SC: Welcome! Your first month is just $1. Enjoy unlimited matches.",
    ),
    "welcome_intro",
  );
});

test("welcome_intro: 'Welcome!' + intro period variant", () => {
  assert.equal(
    classifySmsBody(
      "Welcome! You're in your intro period — book as many matches as you like.",
    ),
    // 'you're in' (booking_confirmation) appears in this body, but
    // welcome_intro is matched first (rule 5 before rule 7), which is
    // the intended precedence.
    "welcome_intro",
  );
});

test("ops_broadcast: 'Hi this is MatchDay' (no comma)", () => {
  assert.equal(
    classifySmsBody(
      "Hi this is MatchDay, due to the issue with the bibs we will be using pinnies tonight.",
    ),
    "ops_broadcast",
  );
});

test("ops_broadcast: 'Hi, this is MatchDay' (comma)", () => {
  assert.equal(
    classifySmsBody(
      "Hi, this is MatchDay, RRMPC on Wednesday has been moved to the turf field.",
    ),
    "ops_broadcast",
  );
});

test("booking_confirmation: future-coverage phrases", () => {
  assert.equal(
    classifySmsBody("Your booking confirmed for Saturday 10am."),
    "booking_confirmation",
  );
  assert.equal(classifySmsBody("Spot confirmed, see you there!"), "booking_confirmation");
});

test("other: unmatched body", () => {
  assert.equal(classifySmsBody("Reply STOP to unsubscribe."), "other");
});

test("other: empty / null / undefined", () => {
  assert.equal(classifySmsBody(""), "other");
  assert.equal(classifySmsBody(null), "other");
  assert.equal(classifySmsBody(undefined), "other");
});

test("anchored prefixes do not match mid-body", () => {
  // "Your match at" must be a prefix — a reminder quoted inside a
  // broadcast should not be miscategorised as player_match_reminder.
  assert.equal(
    classifySmsBody(
      "Hi this is MatchDay, reminder: Your match at 8:30 PM starts in 2 hours.",
    ),
    "ops_broadcast",
  );
});
