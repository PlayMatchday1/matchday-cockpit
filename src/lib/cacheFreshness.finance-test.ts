// Staleness predicate behind the client-cache invalidation. The bug it
// guards: the module-level caches in useMatchReviews / useReviewData had
// no expiry, so a tab left open rendered the first fetch forever.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStale,
  STALE_AFTER_MS,
  REVALIDATE_POLL_MS,
} from "./cacheFreshness";

const NOW = Date.parse("2026-07-23T20:00:00Z");

test("a never-loaded cache is stale", () => {
  assert.equal(isStale(null, NOW), true);
});

test("a just-loaded cache is fresh", () => {
  assert.equal(isStale(NOW, NOW), false);
});

test("fresh right up to the threshold", () => {
  assert.equal(isStale(NOW - (STALE_AFTER_MS - 1), NOW), false);
});

test("stale exactly at the threshold", () => {
  assert.equal(isStale(NOW - STALE_AFTER_MS, NOW), true);
});

test("stale well past the threshold", () => {
  assert.equal(isStale(NOW - 24 * 60 * 60 * 1000, NOW), true);
});

test("a future loadedAt is treated as stale, not fresh-forever", () => {
  // Clock skew / a system clock jumping backwards must not pin the
  // cache as permanently fresh.
  assert.equal(isStale(NOW + 60_000, NOW), true);
});

test("threshold is overridable per call", () => {
  const age = 90_000; // 1.5 min
  assert.equal(isStale(NOW - age, NOW, 60_000), true);
  assert.equal(isStale(NOW - age, NOW, 120_000), false);
});

test("the poll tick is finer-grained than the staleness window", () => {
  // Otherwise a visible-but-untouched tab could sit stale for up to
  // two poll intervals before revalidating.
  assert.ok(REVALIDATE_POLL_MS < STALE_AFTER_MS);
});

test("staleness window is tighter than the daily sync it replaces", () => {
  // The whole point: the client must not be the slowest link once the
  // server side goes hourly.
  assert.ok(STALE_AFTER_MS < 60 * 60 * 1000);
});
