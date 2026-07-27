import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCompletion,
  isAutoAddEligible,
  matchLocalDateTime,
  SCHEDULE_RECONCILE_LOOKBACK_DAYS,
  type ReconcileMatch,
} from "./scheduleReconcile.ts";

const base: ReconcileMatch = {
  api_id: 1,
  end_date_utc: "2026-07-20T02:00:00Z",
  is_cancelled: false,
  player_count: null,
  min_player_count: null,
  star_rating_count: null,
};

test("classifyCompletion: is_cancelled=true is the only cancel signal", () => {
  // Even a fully-rated, well-filled match counts as didn't-happen if cancelled.
  assert.equal(
    classifyCompletion({ ...base, is_cancelled: true, player_count: 30, min_player_count: 10, star_rating_count: 8 }),
    "didnt_happen",
  );
});

test("classifyCompletion: star ratings prove it happened", () => {
  assert.equal(classifyCompletion({ ...base, star_rating_count: 3 }), "happened");
});

test("classifyCompletion: filled to minimum proves it happened", () => {
  assert.equal(classifyCompletion({ ...base, player_count: 12, min_player_count: 10 }), "happened");
});

test("classifyCompletion: null player data + no ratings is CAN'T TELL, never dropped", () => {
  // The whole reason the bucket exists — a NULL comparison is unknown, not false.
  assert.equal(classifyCompletion(base), "cant_tell");
  assert.equal(classifyCompletion({ ...base, player_count: 5, min_player_count: null }), "cant_tell");
  assert.equal(classifyCompletion({ ...base, player_count: null, min_player_count: 10 }), "cant_tell");
});

test("classifyCompletion: under minimum with no ratings is CAN'T TELL, not happened", () => {
  assert.equal(classifyCompletion({ ...base, player_count: 4, min_player_count: 10 }), "cant_tell");
});

test("classifyCompletion: auto_canceled is irrelevant (not a field we read)", () => {
  // Guard against regressing to the old predicate: a rated match is 'happened'
  // regardless of any policy flag, which this type doesn't even carry.
  assert.equal(classifyCompletion({ ...base, star_rating_count: 1 }), "happened");
});

const now = Date.parse("2026-07-26T12:00:00Z");
const cutoff = Date.parse("2026-07-20T00:00:00Z");
const ctx = { nowMs: now, cutoffMs: cutoff, lookbackDays: SCHEDULE_RECONCILE_LOOKBACK_DAYS };

test("isAutoAddEligible: happened + in window + after cutoff → eligible", () => {
  assert.equal(isAutoAddEligible({ ...base, star_rating_count: 2, end_date_utc: "2026-07-25T02:00:00Z" }, ctx), true);
});

test("isAutoAddEligible: future match is never eligible", () => {
  assert.equal(isAutoAddEligible({ ...base, star_rating_count: 2, end_date_utc: "2026-07-28T02:00:00Z" }, ctx), false);
});

test("isAutoAddEligible: before the hard cutoff is never eligible", () => {
  assert.equal(isAutoAddEligible({ ...base, star_rating_count: 2, end_date_utc: "2026-07-19T02:00:00Z" }, ctx), false);
});

test("isAutoAddEligible: cancelled is never eligible even if recent", () => {
  assert.equal(isAutoAddEligible({ ...base, is_cancelled: true, end_date_utc: "2026-07-25T02:00:00Z" }, ctx), false);
});

test("isAutoAddEligible: CAN'T TELL is never AUTO-added", () => {
  assert.equal(isAutoAddEligible({ ...base, end_date_utc: "2026-07-25T02:00:00Z" }, ctx), false);
});

test("matchLocalDateTime: reads wall-clock from the fake +00:00 offset", () => {
  assert.deepEqual(matchLocalDateTime("2026-07-25T19:30:00Z"), { date: "2026-07-25", timeLabel: "7:30 PM" });
  assert.deepEqual(matchLocalDateTime("2026-07-25T09:00:00Z"), { date: "2026-07-25", timeLabel: "9:00 AM" });
  assert.deepEqual(matchLocalDateTime("2026-07-25T12:00:00Z"), { date: "2026-07-25", timeLabel: "12:00 PM" });
  assert.deepEqual(matchLocalDateTime("2026-07-25T00:00:00Z"), { date: "2026-07-25", timeLabel: "12:00 AM" });
  assert.equal(matchLocalDateTime(null), null);
});
