import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMetricGrid, metricValue, isAdditive } from "./growthMetricGrid";
import type { GrowthData, BehaviorPoint } from "./growthAnalytics";

const MONTHS = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
const bp = (m: string, spots: number | null, totalPlayers: number | null = null): BehaviorPoint => ({
  m, registrations: null, newPlayers: null, totalPlayers, spots,
});
// Mockup's live spots-by-city data (Feb–Jul 2026).
const CITY: Record<string, number[]> = {
  Austin: [3111, 3079, 3364, 3298, 3610, 3895],
  Houston: [1105, 1332, 1597, 1511, 1707, 2587],
  "San Antonio": [1363, 1279, 1422, 1702, 1782, 2153],
  Dallas: [280, 244, 382, 310, 198, 400],
  Atlanta: [233, 177, 262, 183, 186, 283],
  "St. Louis": [315, 322, 296, 103, 49, 169],
  OKC: [0, 140, 205, 163, 135, 224],
  "El Paso": [0, 0, 0, 0, 0, 0],
  "New York City": [0, 0, 0, 0, 0, 0],
};
const NET_SPOTS = [6407, 6573, 7528, 7270, 7667, 9711];
const NET_TOTP = [1793, 1923, 2243, 2170, 2300, 2896];

function makeData(netSpots = NET_SPOTS): GrowthData {
  const behaviorByCity: Record<string, BehaviorPoint[]> = {};
  for (const [c, v] of Object.entries(CITY)) behaviorByCity[c] = MONTHS.map((m, i) => bp(m, v[i]));
  return {
    cities: Object.keys(CITY),
    behaviorByCity,
    behaviorByField: {},
    behaviorOverall: MONTHS.map((m, i) => bp(m, netSpots[i], NET_TOTP[i])),
  } as unknown as GrowthData;
}

test("spots city grid foots — columns → network, rows → period, total 45,156", () => {
  const g = buildMetricGrid(makeData(), "spots", "city", MONTHS);
  assert.deepEqual(g.netByMonth, NET_SPOTS); // every column sums to the network month
  assert.equal(g.netPeriod, 45156);
  const byLabel = Object.fromEntries(g.rows.map((r) => [r.label, r.period]));
  assert.equal(byLabel["Austin"], 20357);
  assert.equal(byLabel["Houston"], 9839);
  assert.equal(byLabel["San Antonio"], 9701);
  assert.equal(g.rows[0].label, "Austin"); // ranked by period
});

test("footing assertion THROWS on a column/network mismatch", () => {
  const bad = makeData([6407, 6573, 7528, 7270, 7667, 9999]); // Jul network wrong
  assert.throws(() => buildMetricGrid(bad, "spots", "city", MONTHS), /column.*sum|network/i);
});

test("non-additive metrics are never summed — no period, no net row", () => {
  assert.equal(isAdditive("totalPlayers"), false);
  assert.equal(isAdditive("spotsPerPlayer"), false);
  const g = buildMetricGrid(makeData(), "totalPlayers", "city", MONTHS);
  assert.equal(g.additive, false);
  assert.equal(g.netByMonth, null);
  for (const r of g.rows) assert.equal(r.period, null);
});

test("spotsPerPlayer is derived spots/totalPlayers, null when totalPlayers is 0/absent", () => {
  assert.equal(metricValue(bp("m", 100, 25), "spotsPerPlayer"), 4);
  assert.equal(metricValue(bp("m", 100, 0), "spotsPerPlayer"), null);
  assert.equal(metricValue(bp("m", 100, null), "spotsPerPlayer"), null);
  assert.equal(metricValue(bp("m", null, 25), "spotsPerPlayer"), null);
});

test("dashes never become zeros — a null cell stays null", () => {
  const data = makeData();
  data.behaviorByCity["Austin"] = MONTHS.map((m, i) => bp(m, i < 2 ? null : CITY["Austin"][i]));
  // Network no longer equals the sum in the nulled months, so spots would throw;
  // use a non-additive read to confirm null passes through as null (not 0).
  const g = buildMetricGrid(data, "totalPlayers", "city", MONTHS);
  const austin = g.rows.find((r) => r.label === "Austin")!;
  assert.equal(austin.cells.every((c) => c === null), true); // totalPlayers absent → all null, not 0
});
