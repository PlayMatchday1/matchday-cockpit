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
  normalizeKeyPart,
  bibTotals,
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
    black: 0, // defaults when not submitted
    red: 0,
    balls: 10,
    needs: "more orange bibs",
  });
});

test("black and red sets are validated and coerced too", () => {
  const r = validateInventorySubmission({ ...good, black: "3", red: "5" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.black, 3);
  assert.equal(r.value.red, 5);
  // and they reject junk like the others
  assert.equal(validateInventorySubmission({ ...good, black: "-2" }).ok, false);
  assert.equal(validateInventorySubmission({ ...good, red: "1000" }).ok, false);
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

// --- calcCoverage (6-color optimizer: best of the 15 pair-partitions) ---
const bib = (o: Partial<Record<"white" | "green" | "orange" | "blue" | "black" | "red", number>>) => ({
  white: 0, green: 0, orange: 0, blue: 0, black: 0, red: 0, ...o,
});

test("calcCoverage: maximizes total games across the 15 partitions", () => {
  // Garrett W5 O4 G4 B3 (black/red 0) → 7 games.
  const g = calcCoverage(bib({ white: 5, orange: 4, green: 4, blue: 3 }));
  assert.equal(g.total, 7);
  assert.deepEqual(g.pairings, [
    { a: "white", b: "green", games: 4 },
    { a: "orange", b: "blue", games: 3 },
  ]);
  assert.deepEqual(g.leftovers, [
    { color: "white", count: 1 },
    { color: "orange", count: 1 },
  ]);

  // Tanya W4 O4 G3 B3 → 7 (a different partition wins here).
  assert.equal(calcCoverage(bib({ white: 4, orange: 4, green: 3, blue: 3 })).total, 7);
  // Greg W4 O4 G3 B2 → 6, leftover 1 green.
  const gr = calcCoverage(bib({ white: 4, orange: 4, green: 3, blue: 2 }));
  assert.equal(gr.total, 6);
  assert.deepEqual(gr.leftovers, [{ color: "green", count: 1 }]);
});

test("calcCoverage: any two DIFFERENT colors can pair (no fixed team sides)", () => {
  // Only Orange & Green have sets → they pair for 5 games.
  const og = calcCoverage(bib({ orange: 5, green: 5 }));
  assert.equal(og.total, 5);
  assert.deepEqual(og.pairings, [{ a: "green", b: "orange", games: 5 }]);
  // White & Black pair fine.
  const wb = calcCoverage(bib({ white: 3, black: 2 }));
  assert.equal(wb.total, 2);
  assert.deepEqual(wb.pairings, [{ a: "white", b: "black", games: 2 }]);
});

test("calcCoverage: all six colors used across three pairs", () => {
  // 2 of every color → 3 pairs × 2 = 6 games, no leftovers.
  const c = calcCoverage(bib({ white: 2, green: 2, orange: 2, blue: 2, black: 2, red: 2 }));
  assert.equal(c.total, 6);
  assert.equal(c.pairings.length, 3);
  assert.deepEqual(c.leftovers, []);
  // A lopsided 6-color case (verified against the implementation).
  const m = calcCoverage(bib({ white: 5, green: 1, orange: 3, blue: 4, black: 2, red: 6 }));
  assert.equal(m.total, 9);
});

test("calcCoverage: nothing pairs → zero games, no pairings, no leftovers", () => {
  const c = calcCoverage(bib({}));
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
  black: 0,
  red: 0,
  balls: 0,
  needs: null,
  ...extra,
});

test("dedupeLatest normalizes name+city (trim, collapse spaces, lowercase) → one manager", () => {
  const rows = [
    row("1", "Garrett ", "Austin", "2026-07-01T00:00:00Z", { balls: 5 }),
    row("2", "garrett", "austin", "2026-07-20T00:00:00Z", { balls: 20 }), // newest
    row("3", "  Garrett  ", "AUSTIN", "2026-07-10T00:00:00Z", { balls: 12 }),
  ];
  const latest = dedupeLatest(rows);
  assert.equal(latest.length, 1, "variants collapse to one card");
  assert.equal(latest[0].balls, 20, "keeps the newest submission");
});

test("dedupeLatest collapses internal whitespace so names don't fragment", () => {
  const rows = [
    row("1", "Jose  Luis", "Houston", "2026-07-01T00:00:00Z", { balls: 3 }),
    row("2", "Jose Luis", "Houston", "2026-07-05T00:00:00Z", { balls: 8 }),
  ];
  assert.equal(dedupeLatest(rows).length, 1);
  assert.equal(normalizeKeyPart("  Jose   Luis  "), "jose luis");
});

test("bibTotals: sums all 6 colors + balls, equals the manager sum, never NaN", () => {
  const rows = [
    row("1", "A", "Austin", "2026-07-20T00:00:00Z", { white: 5, green: 4, orange: 3, blue: 2, black: 1, red: 6, balls: 20 }),
    row("2", "B", "Austin", "2026-07-21T00:00:00Z", { white: 2, green: 2, orange: 2, blue: 2, black: 0, red: 0, balls: 10 }), // 0 black/red
  ];
  const t = bibTotals(rows);
  assert.deepEqual(t, { white: 7, green: 6, orange: 5, blue: 4, black: 1, red: 6, balls: 30 });
  for (const v of Object.values(t)) assert.ok(!Number.isNaN(v), "no NaN");
});

test("bibTotals: a missing/null count coerces to 0 — the black/red NaN bug can't recur", () => {
  const r = row("1", "A", "Austin", "2026-07-20T00:00:00Z", { white: 3, black: 2 });
  // Simulate the bug: black column absent from the fetched row, red null.
  delete (r as unknown as Record<string, unknown>).black;
  (r as unknown as Record<string, unknown>).red = null;
  const t = bibTotals([r]);
  assert.equal(t.white, 3);
  assert.equal(t.black, 0);
  assert.equal(t.red, 0);
  for (const v of Object.values(t)) assert.ok(!Number.isNaN(v), "no NaN");
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
    row("1", "A", "Austin", fresh, { white: 5, green: 4, orange: 3, blue: 2, black: 1, red: 6, balls: 20, needs: "more orange" }),
    row("2", "B", "Austin", old, { white: 2, green: 2, orange: 2, blue: 2, black: 1, red: 0, balls: 10, needs: "none" }),
  ];
  const s = summarize(latest, now);
  assert.equal(s.managers, 2);
  assert.equal(s.totalBalls, 30);
  assert.deepEqual(s.bib, { white: 7, green: 6, orange: 5, blue: 4, black: 2, red: 6 });
  assert.equal(s.requested, 1); // only "more orange"
  assert.equal(s.stale, 1); // the 60-day-old one
});

// ===============================================================
// RLS is DB-enforced (hard-guarded write path) — verified live, not here
// ===============================================================
// The unit suite covers the guards that reject BEFORE the insert
// (honeypot, rate-limit, invalid city / negative / huge counts — above).
// The RLS behavior itself — anon can neither INSERT nor SELECT directly,
// and only the service-role server route can insert — is enforced by
// Postgres (migration 0077: RLS on, NO anon policy, authenticated SELECT)
// and is verified against the live DB after 0077 is applied, since it
// can't be exercised without a real anon-key vs service-key round-trip.
