/* THE ADS OVERVIEW'S SHAPING. Pure: no network, no clock, no database.
 *
 * Three decisions here are invisible on screen and all three fail toward a plausible table:
 *
 *   WHICH MARKET A ROW IS. Grouped by the ad set's PARENT, not by the served market. Group by
 *   served market instead and home share is 100% by construction, Unknown becomes a market of its
 *   own belonging to nobody, and the Houston story — 39.9% of its money landing nowhere Meta would
 *   name — becomes invisible. Every figure still renders.
 *
 *   WHAT THE EXPANSION HIDES. The tail runs to 50 markets of pennies. A rollup that swallowed
 *   Unknown would bury the one row worth looking at.
 *
 *   WHAT IS LEFT OUT ENTIRELY. Ad sets below the confidence floor and markets we do not buy in are
 *   both excluded from the rows, and both have to be counted somewhere or the page quietly loses
 *   money and players.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/ads-overview-test.ts
 */
import {
  buildAdsOverview, servedBreakdown, shareOf, perUnit, PAID_MARKETS,
  type GeoRow, type FlatRow, type DimRow, type AcqRow,
} from "../src/lib/adsOverview";
import { UNKNOWN_MARKET } from "../src/lib/metaAdSpend";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  XX  ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("ADS OVERVIEW\n");

console.log("the expansion: 99% cumulative, and Unknown is never rolled up");
{
  /* A LONG THIN TAIL, the real shape: Dallas reached 50 markets with 99.2% of the money in one. */
  const rows = [{ marketRaw: "Dallas-Ft. Worth, TX", spendCents: 99200 },
    ...Array.from({ length: 40 }, (_, i) => ({ marketRaw: `Tiny ${String(i).padStart(2, "0")}, TX`, spendCents: 20 }))];
  const out = servedBreakdown(rows);
  is("the dominant market is shown", out[0].marketRaw, "Dallas-Ft. Worth, TX");
  is("…and the 40-market tail is ONE row", out.filter((r) => r.rolled > 0).map((r) => r.marketRaw), ["other markets (40)"]);
  is("nothing is lost across the rollup",
    out.reduce((a, r) => a + r.spendCents, 0), rows.reduce((a, r) => a + r.spendCents, 0));
  /* THE GUARANTEE THE RULE EXISTS TO MAKE: the rolled row is never more than 1% of the spend. */
  const rolled = out.find((r) => r.rolled > 0)!;
  is("the rolled row is at most 1% of the total", rolled.spendCents / 100000 <= 0.01, true);
  // CONTROL: the tail is genuinely long, so "one rolled row" is doing work rather than describing
  // a list that was already short.
  is("control — the input really had 41 markets", rows.length, 41);

  /* UNKNOWN IS NOT A SMALL MARKET, IT IS THE ABSENCE OF ONE. At 39.9% it was the whole Houston
   * story; at 0.01% it is still a different fact from a town nobody targeted. */
  const withUnknown = servedBreakdown([
    { marketRaw: "Houston, TX", spendCents: 54028 },
    { marketRaw: UNKNOWN_MARKET, spendCents: 36049 },
    ...Array.from({ length: 30 }, (_, i) => ({ marketRaw: `Tiny ${i}, TX`, spendCents: 5 })),
  ]);
  is("Unknown gets its own row even beside a 30-market tail",
    withUnknown.some((r) => r.marketRaw === UNKNOWN_MARKET), true);
  is("…and is NOT inside the rolled row",
    withUnknown.find((r) => r.rolled > 0)?.rolled, 30);
  const tiny = servedBreakdown([{ marketRaw: "Austin, TX", spendCents: 100000 }, { marketRaw: UNKNOWN_MARKET, spendCents: 1 }]);
  is("control — a ONE CENT Unknown still gets its own row rather than being rolled",
    tiny.map((r) => r.marketRaw), ["Austin, TX", UNKNOWN_MARKET]);
  is("an empty input is an empty breakdown, not a crash", servedBreakdown([]), []);
}

console.log("\na row is the ad set's PARENT market, not the market its money landed in");
{
  /* THE GEO-AUTOMATION EPISODE, as the table has to render it: an ad set parented to Houston whose
   * money mostly landed in Unknown. Its spend belongs to HOUSTON — it is Houston's budget — and the
   * unattributed share is what says the delivery went wrong. */
  const geo: GeoRow[] = [
    { spend_date: "2026-09-01", adset_id: "a", market_raw: "Houston, TX", market_key: "HTX", spend_cents: 54028, clicks: 10 },
    { spend_date: "2026-09-01", adset_id: "a", market_raw: UNKNOWN_MARKET, market_key: null, spend_cents: 36049, clicks: 5 },
    { spend_date: "2026-09-01", adset_id: "a", market_raw: "Waco-Killeen, TX", market_key: null, spend_cents: 271, clicks: 1 },
  ];
  const flat: FlatRow[] = [{ spend_date: "2026-09-01", adset_id: "a", spend_cents: 90348, installs: 40, clicks: 16, registrations: 4 }];
  const dim: DimRow[] = [{ adset_id: "a", adset_name: "HTX", campaign_name: "c", market_key: "HTX", market_raw: "Houston, TX", market_confidence: 0.986 }];
  const o = buildAdsOverview({ geo, flat, dim, acq: [] });
  const htx = o.rows.find((r) => r.marketKey === "HTX")!;
  is("the whole ad set's spend is Houston's", htx.spendCents, 54028 + 36049 + 271);
  is("…split home / unattributed / other named", [htx.homeCents, htx.unknownCents, htx.otherNamedCents], [54028, 36049, 271]);
  is("the three shares add to the whole",
    htx.homeCents + htx.unknownCents + htx.otherNamedCents, htx.spendCents);
  is("installs come through the ad set, which is the only grain Meta reports them at", htx.installs, 40);
  /* CONTROL: grouping by SERVED market would have made home share 100% and lost the story. */
  is("control — home share is NOT 100%, which is the whole point",
    Math.round((htx.homeCents / htx.spendCents) * 1000) / 10, 59.8);
  is("control — and the unattributed share is the thing worth seeing",
    Math.round((htx.unknownCents / htx.spendCents) * 1000) / 10, 39.9);
}

console.log("\nwhat is left out is counted, never dropped");
{
  const geo: GeoRow[] = [
    { spend_date: "2026-09-01", adset_id: "good", market_raw: "Austin, TX", market_key: "ATX", spend_cents: 10000, clicks: 3 },
    { spend_date: "2026-09-01", adset_id: "elpaso", market_raw: "El Paso, TX", market_key: null, spend_cents: 34863, clicks: 9 },
    { spend_date: "2026-09-01", adset_id: "split", market_raw: "Austin, TX", market_key: "ATX", spend_cents: 55 },
    { spend_date: "2026-09-01", adset_id: "split", market_raw: "Houston, TX", market_key: "HTX", spend_cents: 45 },
  ] as GeoRow[];
  const dim: DimRow[] = [
    { adset_id: "good", adset_name: "ATX", campaign_name: "c", market_key: "ATX", market_raw: "Austin, TX", market_confidence: 1 },
    // Unmapped dominant market: named, and NOT defaulted into any city.
    { adset_id: "elpaso", adset_name: "ELP", campaign_name: "c", market_key: null, market_raw: "El Paso, TX", market_confidence: 0.984 },
    // Below the 60% floor: market_key is null even though the dominant market maps.
    { adset_id: "split", adset_name: "SPLIT", campaign_name: "c", market_key: null, market_raw: "Austin, TX", market_confidence: 0.55 },
  ];
  const acq: AcqRow[] = [
    { signup_date: "2026-09-01", declared_city_raw: "Austin", registrations: 10, became_players: 4, played_within_7d: 3, played_within_30d: 4 },
    { signup_date: "2026-09-01", declared_city_raw: "Warsaw", registrations: 7, became_players: 5, played_within_7d: 5, played_within_30d: 5 },
    { signup_date: "2026-09-01", declared_city_raw: "New York City", registrations: 2, became_players: 1, played_within_7d: 1, played_within_30d: 1 },
  ];
  const o = buildAdsOverview({ geo, flat: [], dim, acq });

  is("both unattributable ad sets are NAMED, with their spend",
    o.notAttributed.map((n) => `${n.adsetName} ${n.spendCents}`), ["ELP 34863", "SPLIT 100"]);
  is("…and their money is in NO market row",
    o.rows.reduce((a, r) => a + r.spendCents, 0), 10000);
  // CONTROL: the excluded spend is large, so "not in any row" is a real exclusion rather than a
  // rounding difference that would pass either way.
  is("control — the excluded spend dwarfs what was kept", 34863 + 100 > 10000, true);

  is("markets we do not buy in are counted separately", [o.excluded.registrations, o.excluded.becamePlayers], [9, 6]);
  is("…and named, so the page can state the gap", o.excluded.cities, ["New York City", "Warsaw"]);
  is("…and are in no row", o.totals.registrations, 10);
  is("every paid market has a row even with no spend", o.rows.map((r) => r.marketKey).sort(), [...PAID_MARKETS].sort());
}

console.log("\nrates refuse a zero denominator rather than inventing one");
{
  is("no spend means no share", shareOf(5, 0), null);
  is("no installs means no CPI", perUnit(10000, 0), null);
  is("…and a null installs is not a zero", perUnit(10000, null), null);
  is("control — a real denominator does divide", perUnit(10000, 40), 250);
  is("control — and a real share is a fraction", shareOf(25, 100), 0.25);
  /* ABSENT IS NOT ZERO, carried through the fold: a market with no install figure at all reports
   * null, while one whose ad sets genuinely produced none reports 0. */
  const dim: DimRow[] = [{ adset_id: "a", adset_name: "x", campaign_name: "c", market_key: "ATX", market_raw: "Austin, TX", market_confidence: 1 }];
  const geo: GeoRow[] = [{ spend_date: "2026-09-01", adset_id: "a", market_raw: "Austin, TX", market_key: "ATX", spend_cents: 100, clicks: 0 }];
  const noneReported = buildAdsOverview({ geo, flat: [{ spend_date: "2026-09-01", adset_id: "a", spend_cents: 100, installs: null, clicks: 0, registrations: null }], dim, acq: [] });
  const zeroReported = buildAdsOverview({ geo, flat: [{ spend_date: "2026-09-01", adset_id: "a", spend_cents: 100, installs: 0, clicks: 0, registrations: null }], dim, acq: [] });
  is("a market with no install figure reports null", noneReported.rows.find((r) => r.marketKey === "ATX")!.installs, null);
  is("control — one that reported zero reports 0", zeroReported.rows.find((r) => r.marketKey === "ATX")!.installs, 0);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log(`  XX  ${f}`)); process.exit(1); }
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
