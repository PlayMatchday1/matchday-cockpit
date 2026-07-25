// Equipment Inventory — shared domain logic.
//
// This file holds the WRITE-PATH pieces that are fully specified and
// style-independent: server-side submission validation and the public
// rate-limiter. The READ-PATH logic ported from the existing tool
// (calcCoverage, dedup-latest, stale, requested) is added alongside once
// that HTML is in hand, so it can be reproduced exactly rather than
// guessed.

import { CITIES, type City } from "./types";

// Allowed cities = the 8 canonical labels (same as fin_venues.city), so a
// submission can join to the city_managers roster later.
export const INVENTORY_CITIES: readonly City[] = CITIES;

// Sane bounds. Counts over MAX_COUNT are "absurd payload" spam; the DB
// CHECK enforces the same ceiling as defense-in-depth.
export const MAX_ITEM_COUNT = 999;
export const MAX_NAME_LEN = 120;
export const MAX_NEEDS_LEN = 500;

// The raw shape the public form POSTs. Counts arrive as strings or
// numbers; everything is validated/coerced below.
export type InventorySubmissionInput = {
  name?: unknown;
  city?: unknown;
  white?: unknown;
  green?: unknown;
  orange?: unknown;
  blue?: unknown;
  balls?: unknown;
  needs?: unknown;
  // Honeypot — a hidden field real users never fill. Any value here means
  // a bot; the caller drops the submission.
  website?: unknown;
};

// The clean, DB-ready row (minus server-set columns).
export type InventorySubmission = {
  name: string;
  city: City;
  white: number;
  green: number;
  orange: number;
  blue: number;
  balls: number;
  needs: string | null;
};

export type ValidationResult =
  | { ok: true; value: InventorySubmission }
  | { ok: false; error: string };

function isKnownCity(city: string): city is City {
  return (INVENTORY_CITIES as readonly string[]).includes(city);
}

// Strict non-negative integer in [0, MAX_ITEM_COUNT]. Accepts a number or
// a numeric string; rejects floats, negatives, junk, and absurd values.
function parseCount(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0 || raw > MAX_ITEM_COUNT) return null;
    return raw;
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "") return 0; // blank count → 0
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isInteger(n) || n > MAX_ITEM_COUNT) return null;
    return n;
  }
  if (raw == null) return 0;
  return null;
}

// Whether the honeypot was tripped (any non-empty value). A tripped
// honeypot should be dropped SILENTLY (return a success to the bot).
export function isHoneypotTripped(input: InventorySubmissionInput): boolean {
  return typeof input.website === "string" && input.website.trim() !== "";
}

// Server-side validation. Name non-empty (≤120), city in the allowed set,
// each count a non-negative int ≤999, needs length-capped (→ null when
// blank). Returns a clean row or a human error.
export function validateInventorySubmission(
  input: InventorySubmissionInput,
): ValidationResult {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Name is required." };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Name must be ${MAX_NAME_LEN} characters or fewer.` };
  }

  const city = typeof input.city === "string" ? input.city.trim() : "";
  if (!city) return { ok: false, error: "City is required." };
  if (!isKnownCity(city)) return { ok: false, error: "Unrecognized city." };

  const counts: Record<string, number> = {};
  for (const key of ["white", "green", "orange", "blue", "balls"] as const) {
    const n = parseCount(input[key]);
    if (n == null) {
      return {
        ok: false,
        error: `${key[0].toUpperCase()}${key.slice(1)} must be a whole number between 0 and ${MAX_ITEM_COUNT}.`,
      };
    }
    counts[key] = n;
  }

  let needs: string | null = null;
  if (typeof input.needs === "string") {
    const trimmed = input.needs.trim();
    if (trimmed.length > MAX_NEEDS_LEN) {
      return {
        ok: false,
        error: `Requests must be ${MAX_NEEDS_LEN} characters or fewer.`,
      };
    }
    needs = trimmed || null;
  }

  return {
    ok: true,
    value: {
      name,
      city,
      white: counts.white,
      green: counts.green,
      orange: counts.orange,
      blue: counts.blue,
      balls: counts.balls,
      needs,
    },
  };
}

// ============================================================
// Read-path logic (ported from the current tool)
// ============================================================
// One stored submission row (server columns included).
export type InventoryRow = {
  id: string;
  submitted_at: string;
  name: string;
  city: string;
  white: number;
  green: number;
  orange: number;
  blue: number;
  balls: number;
  needs: string | null;
};

export type BibCounts = { white: number; green: number; orange: number; blue: number };
export type BibColorKey = "white" | "green" | "orange" | "blue";

// --- Coverage optimizer (ported EXACTLY from the current tool) --------
// A game needs two visually-distinct bib colors. There are 3 ways to pair
// the 4 colors into 2 team-pairs; each pair yields min(a,b) games. The
// tool tries all 3 and keeps the matching with the MOST total games,
// preferring the earlier option on a tie (so [White·Orange][Green·Blue]
// wins ties). Leftovers = the counts still unmatched under the winner.
//
// NB: the approved visual mock's card numbers are placeholder and do NOT
// reflect this algorithm — the logic here is the source of truth, ported
// verbatim from the tool being replaced.
const COVERAGE_OPTIONS: [BibColorKey, BibColorKey][][] = [
  [["white", "orange"], ["green", "blue"]],
  [["white", "green"], ["orange", "blue"]],
  [["white", "blue"], ["orange", "green"]],
];
// Leftover display order matches the tool's `{white, orange, green, blue}`
// remainder-object iteration order.
const LEFTOVER_ORDER: BibColorKey[] = ["white", "orange", "green", "blue"];

export type CoveragePairing = { a: BibColorKey; b: BibColorKey; games: number };
export type CoverageLeftover = { color: BibColorKey; count: number };
export type Coverage = {
  pairings: CoveragePairing[];
  total: number;
  leftovers: CoverageLeftover[];
};

export function calcCoverage(c: BibCounts): Coverage {
  let bestTotal = 0;
  let bestPairings: CoveragePairing[] = [];
  let bestLeftovers: CoverageLeftover[] = [];
  for (const option of COVERAGE_OPTIONS) {
    const rem: BibCounts = { ...c };
    const pairings: CoveragePairing[] = [];
    for (const [a, b] of option) {
      const games = Math.min(rem[a], rem[b]);
      rem[a] -= games;
      rem[b] -= games;
      if (games > 0) pairings.push({ a, b, games });
    }
    const total = pairings.reduce((s, p) => s + p.games, 0);
    if (total > bestTotal) {
      bestTotal = total;
      bestPairings = pairings;
      bestLeftovers = LEFTOVER_ORDER.filter((k) => rem[k] > 0).map((color) => ({
        color,
        count: rem[color],
      }));
    }
  }
  return { pairings: bestPairings, total: bestTotal, leftovers: bestLeftovers };
}

// --- Dedup to latest per manager ------------------------------------
// The dashboard shows the LATEST report per (lower(name) + lower(city)).
// Keeps history intact (every submit is a row); this only picks the
// newest per manager for display.
export function dedupeLatest(rows: InventoryRow[]): InventoryRow[] {
  const byKey = new Map<string, InventoryRow>();
  for (const r of rows) {
    const key = `${r.name.trim().toLowerCase()}|${r.city.trim().toLowerCase()}`;
    const cur = byKey.get(key);
    if (!cur || Date.parse(r.submitted_at) > Date.parse(cur.submitted_at)) {
      byKey.set(key, r);
    }
  }
  return [...byKey.values()];
}

// --- Stale -----------------------------------------------------------
// Ported EXACTLY from the tool: stale when floor(days elapsed) > 45, i.e.
// 46+ whole days old (Math.floor((now - t) / day) > 45). Slightly
// stricter than a literal ">45.0 days".
export const STALE_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;
export function daysAgo(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((nowMs - t) / DAY_MS);
}
export function isStale(submittedAtIso: string, nowMs: number): boolean {
  const t = Date.parse(submittedAtIso);
  if (!Number.isFinite(t)) return false;
  return Math.floor((nowMs - t) / DAY_MS) > STALE_DAYS;
}

// --- Requested -------------------------------------------------------
// Ported from the tool's card check: present and not none / n/a / nothing.
const NONE_NEEDS = new Set(["", "none", "n/a", "nothing"]);
export function isRequested(needs: string | null | undefined): boolean {
  if (!needs) return false;
  return !NONE_NEEDS.has(needs.trim().toLowerCase());
}

// --- Display helpers (ported from the tool) --------------------------
// "Today" / "Yesterday" / "N days ago" / "~1 month ago" / "N months ago".
export function relativeTime(iso: string, nowMs: number): string {
  const d = daysAgo(iso, nowMs);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 30) return `${d} days ago`;
  if (d < 60) return "~1 month ago";
  return `${Math.floor(d / 30)} months ago`;
}
// Up-to-two-letter initials, e.g. "Garrett Meyer" → "GM".
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// --- Summary strip ---------------------------------------------------
export type InventorySummary = {
  managers: number;
  totalBalls: number;
  bib: BibCounts;
  requested: number;
  stale: number;
};
export function summarize(latest: InventoryRow[], nowMs: number): InventorySummary {
  const bib = { white: 0, green: 0, orange: 0, blue: 0 };
  let totalBalls = 0;
  let requested = 0;
  let stale = 0;
  for (const r of latest) {
    bib.white += r.white;
    bib.green += r.green;
    bib.orange += r.orange;
    bib.blue += r.blue;
    totalBalls += r.balls;
    if (isRequested(r.needs)) requested++;
    if (isStale(r.submitted_at, nowMs)) stale++;
  }
  return { managers: latest.length, totalBalls, bib, requested, stale };
}

// ============================================================
// Rate limiter — the public-endpoint screen door
// ============================================================
// In-memory sliding window keyed by client IP. Serverless memory is
// per-instance, so this bounds a single hot instance rather than being a
// global limit — the right posture for a "screen door" on a public form
// (paired with the honeypot + payload sanity + DB CHECKs). Pure and
// testable: the clock and the store are injectable.

export const RATE_LIMIT_MAX = 5; // submits allowed per window per IP
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export type RateLimitStore = Map<string, number[]>;

// Returns whether the request is allowed, and records it when allowed.
// `now` and `store` are injected so tests don't touch the wall clock or
// module state.
export function checkRateLimit(
  ip: string,
  store: RateLimitStore,
  now: number,
  max: number = RATE_LIMIT_MAX,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
): { allowed: boolean; retryAfterMs: number } {
  const cutoff = now - windowMs;
  const recent = (store.get(ip) ?? []).filter((t) => t > cutoff);
  if (recent.length >= max) {
    const oldest = recent[0];
    return { allowed: false, retryAfterMs: Math.max(0, oldest + windowMs - now) };
  }
  recent.push(now);
  store.set(ip, recent);
  return { allowed: true, retryAfterMs: 0 };
}
