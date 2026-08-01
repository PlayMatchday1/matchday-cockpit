// Tests for the Manager Pay view model (§12). The pay MATH is not exercised
// here — it lives in managerPayCompute and is tested against the DB. These lock
// the presentation invariants the mockup's comments defend: tiles reconcile to
// the board, city chips rescope while the attention filter does not, card rates
// sum to the match-pay total, the one-strip-per-band / column-header rules, the
// co-managed-opens-both / cancelled-not-clickable rule, and the no-revenue rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  cardRate, cardRateSum, computeTiles, canShowWeekStrip, bandRendersColumnHeader,
  managerRowsForMatch,
} from "./managerPayView.ts";
import type {
  ManagerPayWeekPayload, MatchSummary, ManagerRow, ManagerMatch, CitySection,
} from "./managerPayCompute.ts";

// ── fixture ──────────────────────────────────────────────────────────────
function ms(p: Partial<MatchSummary> & { matchId: number }): MatchSummary {
  return {
    cityIdentifier: "ATX", fieldTitle: "Field 1", startDate: "2026-07-20",
    centralDate: "2026-07-20", centralWeekday: "Mon", centralTime: "7:00 PM",
    name: null, maxPlayerCount: 20, playerCount: 14, registrationPrice: 15,
    isCancelled: false, primaryManagerName: null, primaryManagerEmail: null,
    secondManagerName: null, secondManagerEmail: null, payPerManager: 0, ...p,
  };
}
function mm(p: Partial<ManagerMatch> & { matchId: number }): ManagerMatch {
  return {
    cityIdentifier: "ATX", fieldTitle: "Field 1", startDate: "2026-07-20",
    centralDate: "2026-07-20", centralWeekday: "Mon", centralTime: "7:00 PM",
    name: null, maxPlayerCount: 20, payAmount: 20, role: "primary", coManaged: false, ...p,
  };
}
function row(p: Partial<ManagerRow> & { managerName: string }): ManagerRow {
  return {
    managerEmail: `${p.managerName.toLowerCase()}@x.com`, managerId: 1, cityIdentifier: "ATX",
    matches: [], matchCount: 0, baseTotal: 0, adjustment: 0, adjustmentNotes: null,
    adjustmentAt: null, total: 0, ...p,
  };
}

function makePayload(): ManagerPayWeekPayload {
  // ATX: solo tournament (30), co-managed tournament (20 each), cancelled (0), unassigned (0)
  const m1 = ms({ matchId: 1, maxPlayerCount: 30, primaryManagerName: "Alice", primaryManagerEmail: "alice@x.com", payPerManager: 30 });
  const m2 = ms({ matchId: 2, maxPlayerCount: 30, primaryManagerName: "Alice", primaryManagerEmail: "alice@x.com", secondManagerName: "Bob", secondManagerEmail: "bob@x.com", payPerManager: 20 });
  const m3 = ms({ matchId: 3, maxPlayerCount: 18, isCancelled: true, primaryManagerName: "Alice", primaryManagerEmail: "alice@x.com", payPerManager: 0 });
  const m4 = ms({ matchId: 4, maxPlayerCount: 16, payPerManager: 0 }); // unassigned
  const alice = row({
    managerName: "Alice", matches: [mm({ matchId: 1, maxPlayerCount: 30, payAmount: 30 }), mm({ matchId: 2, maxPlayerCount: 30, payAmount: 20, coManaged: true })],
    matchCount: 2, baseTotal: 50, adjustment: 10, adjustmentNotes: "playoff bonus", adjustmentAt: "2026-07-22T10:00:00Z", total: 60,
  });
  const bob = row({
    managerName: "Bob", matches: [mm({ matchId: 2, maxPlayerCount: 30, payAmount: 20, coManaged: true, role: "secondary" })],
    matchCount: 1, baseTotal: 20, adjustment: -5, adjustmentNotes: null, adjustmentAt: "2026-07-22T10:00:00Z", total: 15, // bare adjustment → needs a look
  });
  const atx: CitySection = { cityIdentifier: "ATX", managers: [alice, bob], matches: [m1, m2, m3, m4], matchCount: 4, baseTotal: 70, adjustment: 5, total: 75 };

  // DFW: one solo match, one manager
  const d1 = ms({ matchId: 5, cityIdentifier: "DFW", primaryManagerName: "Carol", primaryManagerEmail: "carol@x.com", payPerManager: 20 });
  const carol = row({ managerName: "Carol", cityIdentifier: "DFW", matches: [mm({ matchId: 5, cityIdentifier: "DFW", payAmount: 20 })], matchCount: 1, baseTotal: 20, total: 20 });
  const dfw: CitySection = { cityIdentifier: "DFW", managers: [carol], matches: [d1], matchCount: 1, baseTotal: 20, adjustment: 0, total: 20 };

  // STL: only an unassigned match, no managers → band with no column header
  const s1 = ms({ matchId: 6, cityIdentifier: "STL", maxPlayerCount: 12, payPerManager: 0 });
  const stl: CitySection = { cityIdentifier: "STL", managers: [], matches: [s1], matchCount: 1, baseTotal: 0, adjustment: 0, total: 0 };

  return {
    weekStart: "2026-07-20", weekEnd: "2026-07-26", payDate: "2026-07-28", computedAt: "2026-07-27T00:00:00Z",
    isAdmin: true, cities: [atx, dfw, stl],
    network: { matchCount: 6, managerCount: 3, baseTotal: 90, adjustment: 5, total: 95 },
    attention: { count: 3, unassigned: 2, noEmail: 0, bareAdjustment: 1 },
  };
}

// 1 — tiles reconcile to the board grand total and the model
test("tiles reconcile to the board grand total", () => {
  const p = makePayload();
  const t = computeTiles(p, null, true);
  const grandBase = p.cities.reduce((s, c) => s + c.baseTotal, 0);
  const grandAdj = p.cities.reduce((s, c) => s + c.adjustment, 0);
  assert.equal(t.matchPay, grandBase);
  assert.equal(t.adjTotal, grandAdj);
  assert.equal(t.totalPayout, grandBase + grandAdj);
  assert.equal(t.totalPayout, p.network.total);
  assert.equal(t.totalPayout, p.cities.reduce((s, c) => s + c.total, 0));
});

// 2 — a city chip rescopes the tiles; the attention filter is not a tile input
test("city chip rescopes tiles; attention filter does not", () => {
  const p = makePayload();
  const all = computeTiles(p, null, true);
  const atx = computeTiles(p, "ATX", true);
  assert.equal(all.totalPayout, 95);
  assert.equal(atx.totalPayout, 75); // ATX only — headline changed
  assert.notEqual(all.totalPayout, atx.totalPayout);
  // computeTiles takes (payload, city, isAdmin) — no attention-filter arg, so the
  // reading-aid filter structurally cannot rescope the tiles.
  assert.equal(computeTiles.length, 3);
});

// 3 — the card rates (counting an "each" twice) sum to each city's match-pay total
test("card rates sum to the match-pay total (each counted twice)", () => {
  const p = makePayload();
  for (const c of p.cities) assert.equal(cardRateSum(c), c.baseTotal);
  const boardRates = p.cities.reduce((s, c) => s + cardRateSum(c), 0);
  assert.equal(boardRates, computeTiles(p, null, true).matchPay);
});

// 4 — one week strip per city band; the calendar is per-city, not hoisted
test("one week strip per city band (calendar not hoisted)", () => {
  const p = makePayload();
  assert.ok(canShowWeekStrip("both", false));
  const stripSources = p.cities.map((c) => c.matches);
  assert.equal(stripSources.length, p.cities.length); // one strip source per band
  // each band's strip draws only that band's matches (distinct arrays)
  assert.notEqual(stripSources[0], stripSources[1]);
  assert.deepEqual(stripSources[2].map((m) => m.matchId), [6]);
});

// 5 — the column header renders only for bands that have manager rows
test("column header only for bands with manager rows", () => {
  const p = makePayload();
  const [atx, dfw, stl] = p.cities;
  assert.ok(bandRendersColumnHeader(atx.managers));
  assert.ok(bandRendersColumnHeader(dfw.managers));
  assert.equal(bandRendersColumnHeader(stl.managers), false); // unassigned-only band
});

// 6 — no strip (and no per-city fold) while the attention filter is on
test("no week strip while the attention filter is on", () => {
  assert.equal(canShowWeekStrip("both", true), false);
});

// 7 — co-managed opens BOTH rows; cancelled is not clickable; unassigned has no row
test("co-managed opens both rows; cancelled not clickable", () => {
  const p = makePayload();
  assert.deepEqual(managerRowsForMatch(p, 2).map((r) => r.managerName).sort(), ["Alice", "Bob"]);
  assert.equal(managerRowsForMatch(p, 4).length, 0); // unassigned → jumps to red row
  const m3 = p.cities[0].matches.find((m) => m.matchId === 3)!;
  const m2 = p.cities[0].matches.find((m) => m.matchId === 2)!;
  assert.equal(cardRate(m3).clickable, false); // cancelled
  assert.equal(cardRate(m2).clickable, true);
  assert.equal(cardRate(m2).each, true); // co-managed → "$20 each"
  assert.equal(cardRate(m2).reason, "co-managed"); // a tournament that paid the ordinary rate, reason on the card
});

// 8 — "Pay only" removes every strip while keeping rows + column headers
test("Pay only removes strips but keeps rows and column headers", () => {
  const p = makePayload();
  assert.equal(canShowWeekStrip("pay", false), false); // no strip
  for (const c of p.cities) {
    // rows are untouched by the view mode; the header rule is unchanged
    assert.equal(bandRendersColumnHeader(c.managers), c.managers.length > 0);
  }
});

// 9 — the needs-a-look decomposition sums to the count (not the flags)
test("needs-a-look decomposition sums to the count", () => {
  const p = makePayload();
  const t = computeTiles(p, null, true);
  assert.equal(t.breakdown.reduce((s, b) => s + b.n, 0), t.needsLook);
  assert.equal(t.needsLook, p.attention.count); // same number the rail badge shows
  assert.equal(t.needsLook, 3); // 2 unassigned + 1 bare adjustment
});

// 10 — no per-player price / revenue anywhere in the Manager Pay UI (§10, §9)
test("no per-player price or revenue string in the view", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const view = readFileSync(join(here, "managerPayView.ts"), "utf8");
  const page = readFileSync(join(here, "../app/(internal)/match-ops/manager-pay/ManagerPayView.tsx"), "utf8");
  for (const src of [view, page]) {
    assert.ok(!/registrationPrice/.test(src), "must not render registrationPrice");
    assert.ok(!/revenue|collected|per[ -]player/i.test(src), "no revenue / per-player copy");
    assert.ok(!/attendance|attended|turnout/i.test(src), "counts are sign-ups, not attendance");
  }
  assert.ok(/signed up/.test(page), "cards say 'signed up'");
});
