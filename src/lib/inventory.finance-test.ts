// Write-path tests for the public Equipment Inventory endpoint: server
// validation and the rate-limiter screen door. (Coverage/dedup/stale/
// requested tests land with the ported read-path logic.)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateInventorySubmission,
  isHoneypotTripped,
  checkRateLimit,
  calcCoverage,
  dedupeLatest,
  isStale,
  isRequested,
  relativeTime,
  initials,
  summarize,
  RATE_LIMIT_MAX,
  MAX_ITEM_COUNT,
  MAX_NEEDS_LEN,
  STALE_DAYS,
  type RateLimitStore,
  type InventoryRow,
} from "./inventory";

const good = {
  name: "Garrett",
  city: "Austin",
  white: "8",
  green: "6",
  orange: "4",
  blue: "2",
  balls: "10",
  needs: "more orange bibs",
};

// ---------------------------------------------------------------
// validation — happy path + coercion
// ---------------------------------------------------------------
test("valid submission is accepted and coerced to numbers", () => {
  const r = validateInventorySubmission(good);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.value, {
    name: "Garrett",
    city: "Austin",
    white: 8,
    green: 6,
    orange: 4,
    blue: 2,
    balls: 10,
    needs: "more orange bibs",
  });
});

test("blank counts default to 0; blank needs → null", () => {
  const r = validateInventorySubmission({
    ...good,
    white: "",
    balls: "",
    needs: "   ",
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.white, 0);
  assert.equal(r.value.balls, 0);
  assert.equal(r.value.needs, null);
});

test("number-typed counts are accepted too", () => {
  const r = validateInventorySubmission({ ...good, white: 8, green: 6 });
  assert.ok(r.ok);
});

// ---------------------------------------------------------------
// validation — rejections
// ---------------------------------------------------------------
test("name is required", () => {
  assert.equal(validateInventorySubmission({ ...good, name: "  " }).ok, false);
  assert.equal(validateInventorySubmission({ ...good, name: undefined }).ok, false);
});

test("city must be one of the 8 canonical labels", () => {
  assert.equal(validateInventorySubmission({ ...good, city: "Nashville" }).ok, false);
  assert.equal(validateInventorySubmission({ ...good, city: "austin" }).ok, false); // case-exact
  assert.equal(validateInventorySubmission({ ...good, city: "" }).ok, false);
  // all 8 canonical cities pass
  for (const c of ["Austin","Houston","San Antonio","Atlanta","Dallas","St. Louis","OKC","El Paso"]) {
    assert.equal(validateInventorySubmission({ ...good, city: c }).ok, true, `${c} allowed`);
  }
});

test("counts reject negatives, floats, junk, and absurd values", () => {
  assert.equal(validateInventorySubmission({ ...good, white: "-1" }).ok, false);
  assert.equal(validateInventorySubmission({ ...good, white: "2.5" }).ok, false);
  assert.equal(validateInventorySubmission({ ...good, white: "lots" }).ok, false);
  assert.equal(validateInventorySubmission({ ...good, white: String(MAX_ITEM_COUNT + 1) }).ok, false);
  assert.equal(validateInventorySubmission({ ...good, balls: "99999" }).ok, false);
  // exactly the max is fine
  assert.equal(validateInventorySubmission({ ...good, white: String(MAX_ITEM_COUNT) }).ok, true);
});

test("needs is length-capped", () => {
  const long = "x".repeat(MAX_NEEDS_LEN + 1);
  assert.equal(validateInventorySubmission({ ...good, needs: long }).ok, false);
  assert.equal(
    validateInventorySubmission({ ...good, needs: "x".repeat(MAX_NEEDS_LEN) }).ok,
    true,
  );
});

// ---------------------------------------------------------------
// honeypot
// ---------------------------------------------------------------
test("honeypot: a filled hidden field is detected (→ silent drop)", () => {
  assert.equal(isHoneypotTripped({ ...good, website: "http://spam" }), true);
  assert.equal(isHoneypotTripped({ ...good, website: "" }), false);
  assert.equal(isHoneypotTripped({ ...good }), false);
});

// ---------------------------------------------------------------
// rate limit
// ---------------------------------------------------------------
test("rate limit: allows up to MAX per window, then rejects", () => {
  const store: RateLimitStore = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    assert.equal(checkRateLimit("1.2.3.4", store, t0 + i).allowed, true, `submit ${i + 1}`);
  }
  const over = checkRateLimit("1.2.3.4", store, t0 + RATE_LIMIT_MAX);
  assert.equal(over.allowed, false);
  assert.ok(over.retryAfterMs > 0);
});

test("rate limit: separate IPs are independent", () => {
  const store: RateLimitStore = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < RATE_LIMIT_MAX; i++) checkRateLimit("1.1.1.1", store, t0 + i);
  assert.equal(checkRateLimit("2.2.2.2", store, t0).allowed, true);
});

test("rate limit: the window slides — old submits age out", () => {
  const store: RateLimitStore = new Map();
  const t0 = 1_000_000;
  const windowMs = 10 * 60 * 1000;
  for (let i = 0; i < RATE_LIMIT_MAX; i++) checkRateLimit("9.9.9.9", store, t0 + i);
  assert.equal(checkRateLimit("9.9.9.9", store, t0 + 5).allowed, false);
  // after the window passes, submits are allowed again
  assert.equal(checkRateLimit("9.9.9.9", store, t0 + windowMs + 1).allowed, true);
});

// ===============================================================
// Read-path logic — ported EXACTLY from the current tool
// ===============================================================

// --- calcCoverage (the 3-matching optimizer) ---
test("calcCoverage: optimizer totals match the ported algorithm", () => {
  // Garrett W5 O4 G4 B3 → best is [White·Orange 4][Green·Blue 3] = 7,
  // leftover White 1, Green 1. (The mock's card numbers are placeholder.)
  const g = calcCoverage({ white: 5, orange: 4, green: 4, blue: 3 });
  assert.equal(g.total, 7);
  assert.deepEqual(g.pairings, [
    { a: "white", b: "orange", games: 4 },
    { a: "green", b: "blue", games: 3 },
  ]);
  assert.deepEqual(g.leftovers, [
    { color: "white", count: 1 },
    { color: "green", count: 1 },
  ]);

  // Tanya W4 O4 G3 B3 → [W·O 4][G·B 3] = 7, no leftovers.
  const t = calcCoverage({ white: 4, orange: 4, green: 3, blue: 3 });
  assert.equal(t.total, 7);
  assert.deepEqual(t.leftovers, []);

  // Greg W4 O4 G3 B2 → [W·O 4][G·B 2] = 6, leftover Green 1.
  const gr = calcCoverage({ white: 4, orange: 4, green: 3, blue: 2 });
  assert.equal(gr.total, 6);
  assert.deepEqual(gr.leftovers, [{ color: "green", count: 1 }]);
});

test("calcCoverage: picks the best of the 3 matchings, not a fixed pairing", () => {
  // White & Blue are 0; only Orange↔Green can pair → option 3 wins.
  const c = calcCoverage({ white: 0, orange: 5, green: 5, blue: 0 });
  assert.equal(c.total, 5);
  assert.deepEqual(c.pairings, [{ a: "orange", b: "green", games: 5 }]);
});

test("calcCoverage: nothing pairs → zero games, no pairings, no leftovers-of-zero", () => {
  const c = calcCoverage({ white: 0, orange: 0, green: 0, blue: 0 });
  assert.equal(c.total, 0);
  assert.deepEqual(c.pairings, []);
  assert.deepEqual(c.leftovers, []);
});

// --- dedupeLatest ---
const row = (
  id: string,
  name: string,
  city: string,
  submitted_at: string,
  extra: Partial<InventoryRow> = {},
): InventoryRow => ({
  id,
  name,
  city,
  submitted_at,
  white: 0,
  green: 0,
  orange: 0,
  blue: 0,
  balls: 0,
  needs: null,
  ...extra,
});

test("dedupeLatest keeps only the newest per lower(name)+lower(city)", () => {
  const rows = [
    row("1", "Garrett", "Austin", "2026-07-01T00:00:00Z", { balls: 5 }),
    row("2", "garrett", "austin", "2026-07-20T00:00:00Z", { balls: 20 }), // newer, case-diff
    row("3", "Tanya", "Austin", "2026-07-10T00:00:00Z", { balls: 14 }),
    row("4", "Garrett", "Houston", "2026-07-25T00:00:00Z", { balls: 9 }), // diff city
  ];
  const latest = dedupeLatest(rows);
  assert.equal(latest.length, 3); // Garrett/Austin, Tanya/Austin, Garrett/Houston
  const gAustin = latest.find((r) => r.name.toLowerCase() === "garrett" && r.city.toLowerCase() === "austin");
  assert.equal(gAustin?.balls, 20); // the newer one won
});

// --- isStale (floor(days) > 45) ---
test("isStale: floor(days) > 45 — 45d current, 46d stale", () => {
  const now = Date.parse("2026-07-25T00:00:00Z");
  const daysBefore = (d: number) => new Date(now - d * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isStale(daysBefore(45), now), false); // exactly 45 → current
  assert.equal(isStale(daysBefore(45.9), now), false); // floor 45 → current
  assert.equal(isStale(daysBefore(46), now), true); // 46 → stale
  assert.equal(isStale(daysBefore(200), now), true);
  assert.equal(STALE_DAYS, 45);
});

// --- isRequested ---
test("isRequested: present and not none/n-a/nothing", () => {
  assert.equal(isRequested("2 more green sets"), true);
  assert.equal(isRequested("None"), false);
  assert.equal(isRequested("n/a"), false);
  assert.equal(isRequested("NOTHING"), false);
  assert.equal(isRequested("  none  "), false);
  assert.equal(isRequested(""), false);
  assert.equal(isRequested(null), false);
  assert.equal(isRequested(undefined), false);
});

// --- display helpers ---
test("relativeTime + initials match the tool", () => {
  const now = Date.parse("2026-07-25T12:00:00Z");
  const ago = (d: number) => new Date(now - d * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(relativeTime(ago(0), now), "Today");
  assert.equal(relativeTime(ago(1), now), "Yesterday");
  assert.equal(relativeTime(ago(4), now), "4 days ago");
  assert.equal(relativeTime(ago(40), now), "~1 month ago");
  assert.equal(relativeTime(ago(75), now), "2 months ago");
  assert.equal(initials("Garrett Meyer"), "GM");
  assert.equal(initials("Cher"), "C");
  assert.equal(initials("  jose  luis  garcia "), "JL"); // first two initials
});

// --- summarize ---
test("summarize aggregates the latest rows", () => {
  const now = Date.parse("2026-07-25T00:00:00Z");
  const old = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(); // stale
  const fresh = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
  const latest = [
    row("1", "A", "Austin", fresh, { white: 5, green: 4, orange: 3, blue: 2, balls: 20, needs: "more orange" }),
    row("2", "B", "Austin", old, { white: 2, green: 2, orange: 2, blue: 2, balls: 10, needs: "none" }),
  ];
  const s = summarize(latest, now);
  assert.equal(s.managers, 2);
  assert.equal(s.totalBalls, 30);
  assert.deepEqual(s.bib, { white: 7, green: 6, orange: 5, blue: 4 });
  assert.equal(s.requested, 1); // only "more orange"
  assert.equal(s.stale, 1); // the 60-day-old one
});
