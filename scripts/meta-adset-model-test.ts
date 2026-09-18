import "server-only"; // no-op under --conditions=react-server
/* THE AD-SET MODEL: which market an ad set belongs to, and when an install moved.
 *
 * Both decisions are invisible on screen and both fail toward a plausible number.
 *
 *   A WRONG PARENT files a market's whole CPI under another city, and every figure still renders.
 *   Names cannot be used: the convention held at 100% of spend for eight months and fell to 28.5%
 *   in six weeks when the account was rebuilt.
 *
 *   A MISSED OBSERVATION makes install restatement unmeasurable, which is the only reason the log
 *   exists. It fails silently — the table just has fewer rows than it should.
 *
 * Pure: no network, no clock, no database.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/meta-adset-model-test.ts
 */
import {
  deriveParentMarket, MARKET_CONFIDENCE_FLOOR, UNKNOWN_MARKET, UNALLOCATED_MARKET,
  actionValue, META_INSTALL_ACTION, META_REGISTRATION_ACTION,
  observationsToAppend, observationKey, isAtOrAfterAdsetFloor, META_ADSET_FLOOR_YMD,
  type AdsetMarketSpend, type FreshInstallRow,
} from "../src/lib/metaAdSpend";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  XX  ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("META AD SET MODEL\n");

console.log("the parent market is derived from delivery");
{
  const clean: AdsetMarketSpend[] = [
    { marketRaw: "Houston, TX", spendCents: 84189 },
    { marketRaw: "Waco-Killeen, TX", spendCents: 206 },
    { marketRaw: "Dallas-Ft. Worth, TX", spendCents: 103 },
  ];
  is("a single-market ad set resolves to its city",
    (({ marketKey, attributed }) => ({ marketKey, attributed }))(deriveParentMarket(clean)),
    { marketKey: "HTX", attributed: true });

  /* ── THE CASE THE WHOLE RULE EXISTS FOR, WITH THE REAL NUMBERS ──────────────────────────────
   * During the geo-automation episode the HTX ad set was 59.8% Houston, 39.9% Unknown, 0.3% other
   * named. A naive majority on TOTAL spend gives Houston 59.8% — which happens to clear the floor,
   * so the bug would NOT have shown here — but had Unknown gone one point further it would have
   * WON, and the ad set would have been attributed to a market called "Unknown".
   *
   * Voting on NAMED spend only, Houston is 98.6%. The fixture is built from the measured shape. */
  const episode: AdsetMarketSpend[] = [
    { marketRaw: "Houston, TX", spendCents: 54028 },
    { marketRaw: UNKNOWN_MARKET, spendCents: 36049 },
    { marketRaw: "Waco-Killeen, TX", spendCents: 271 },
    { marketRaw: "Beaumont, TX", spendCents: 200 },
  ];
  const d = deriveParentMarket(episode);
  is("Unknown does not win a vote about which place this is", d.marketRaw, "Houston, TX");
  is("…and the confidence is of NAMED spend, not of total",
    Math.round((d.confidence ?? 0) * 1000) / 10, 99.1);
  /* CONTROL: the two denominators are genuinely different here, so the assertion above is
   * distinguishing them rather than passing on a coincidence.
   *
   * THE PROPERTY, NOT A PINNED DECIMAL. This first asserted 59.8% — the share measured on the live
   * account — against a fixture whose invented cents give 59.7%. That pins fixture arithmetic and
   * fails on a rounding difference that means nothing. What matters is that the two denominators
   * are far apart, which is why voting on the wrong one is a bug rather than a nuance. */
  const totalAll = episode.reduce((a, r) => a + r.spendCents, 0);
  const onTotal = (54028 / totalAll) * 100;
  const onNamed = (d.confidence ?? 0) * 100;
  is("control — voting on TOTAL spend gives a materially lower share than voting on NAMED",
    onNamed - onTotal > 30, true);
  console.log(`       named ${onNamed.toFixed(1)}% against total ${onTotal.toFixed(1)}%`);
  is("control — and Unknown is a large enough slice to have won on a worse rule",
    36049 > 271 + 200, true);

  is("__unallocated__ cannot win either",
    deriveParentMarket([{ marketRaw: UNALLOCATED_MARKET, spendCents: 99999 },
                        { marketRaw: "Austin, TX", spendCents: 10 }]).marketKey, "ATX");

  // ── the floor ──────────────────────────────────────────────────────────────────────────────
  const split: AdsetMarketSpend[] = [
    { marketRaw: "Austin, TX", spendCents: 55 },
    { marketRaw: "Houston, TX", spendCents: 45 },
  ];
  const s = deriveParentMarket(split);
  is("a genuinely split ad set clears no floor and is NOT attributed",
    [s.attributed, s.marketKey], [false, null]);
  is("…but it still NAMES its dominant market and its confidence, so the block can report it",
    [s.marketRaw, Math.round((s.confidence ?? 0) * 100)], ["Austin, TX", 55]);
  /* CONTROL: the floor is a boundary, not a blanket refusal. 80.1% is the real minimum across all
   * 58 ad sets measured, so the floor must sit below it or the rule refuses live data. */
  is("control — the observed minimum (80.1%) clears the floor",
    deriveParentMarket([{ marketRaw: "San Antonio, TX", spendCents: 801 },
                        { marketRaw: "Austin, TX", spendCents: 199 }]).attributed, true);
  is("control — the floor is where it says it is", MARKET_CONFIDENCE_FLOOR, 0.6);

  // ── unmapped, and empty ────────────────────────────────────────────────────────────────────
  const ep = deriveParentMarket([{ marketRaw: "El Paso, TX", spendCents: 34863 },
                                 { marketRaw: "Albuquerque, NM", spendCents: 591 }]);
  is("an unmapped dominant market is NOT attributed but IS named",
    [ep.attributed, ep.marketKey, ep.marketRaw], [false, null, "El Paso, TX"]);
  is("an ad set with only Unknown has no named spend at all",
    deriveParentMarket([{ marketRaw: UNKNOWN_MARKET, spendCents: 500 }]),
    { marketRaw: null, marketKey: null, confidence: null, attributed: false });
  is("no rows at all is the same answer, not a crash", deriveParentMarket([]).attributed, false);

  // ── determinism ────────────────────────────────────────────────────────────────────────────
  const tie: AdsetMarketSpend[] = [{ marketRaw: "Houston, TX", spendCents: 100 },
                                   { marketRaw: "Atlanta, GA", spendCents: 100 }];
  is("an exact tie breaks on the market name, so two runs cannot disagree",
    [deriveParentMarket(tie).marketRaw, deriveParentMarket([...tie].reverse()).marketRaw],
    ["Atlanta, GA", "Atlanta, GA"]);
}

console.log("\nactions: absent is not zero");
{
  const acts = [{ action_type: "link_click", value: "1910" },
                { action_type: META_INSTALL_ACTION, value: "766" },
                { action_type: META_REGISTRATION_ACTION, value: "88" }];
  is("installs are read from the action list", actionValue(acts, META_INSTALL_ACTION), 766);
  is("…and registrations", actionValue(acts, META_REGISTRATION_ACTION), 88);
  /* THE DISTINCTION THAT MATTERS. Every geo row comes back with NO actions array, because
   * comscore_market suppresses installs. That is "we learned nothing", not "nobody installed" —
   * and a 0 there would make a suppressed breakdown look like a dead day. */
  is("a row with NO actions array returns null, not 0", actionValue(undefined, META_INSTALL_ACTION), null);
  is("…and so does an explicit null", actionValue(null, META_INSTALL_ACTION), null);
  is("a row WITH actions but no install action returns 0, because it genuinely had none",
    actionValue([{ action_type: "link_click", value: "3" }], META_INSTALL_ACTION), 0);
  is("control — null and 0 are distinguishable, which is the whole point",
    actionValue(undefined, META_INSTALL_ACTION) === actionValue([], META_INSTALL_ACTION), false);
  is("a non-numeric value contributes nothing rather than NaN",
    actionValue([{ action_type: META_INSTALL_ACTION, value: "oops" }], META_INSTALL_ACTION), 0);
}

console.log("\nthe observation log appends only what moved");
{
  const fresh: FreshInstallRow[] = [
    { spendDate: "2026-09-01", adsetId: "a", installs: 5, spendCents: 100 },
    { spendDate: "2026-09-02", adsetId: "a", installs: 7, spendCents: 200 },
    { spendDate: "2026-09-03", adsetId: "a", installs: null, spendCents: 300 },
  ];
  is("with nothing known, every non-null row is a first sighting",
    observationsToAppend(fresh, new Map()).map((o) => o.spendDate), ["2026-09-01", "2026-09-02"]);
  is("a NULL installs appends nothing — it is not an observation of zero",
    observationsToAppend(fresh, new Map()).some((o) => o.spendDate === "2026-09-03"), false);

  const known = new Map([[observationKey("2026-09-01", "a"), 5], [observationKey("2026-09-02", "a"), 7]]);
  is("an unchanged series appends NOTHING", observationsToAppend(fresh, known), []);
  /* CONTROL FOR THE ASSERTION ABOVE, which has an empty array as its passing value — exactly the
   * shape that also passes when the input is empty or the key format changed. One number moves. */
  const moved = new Map(known); moved.set(observationKey("2026-09-02", "a"), 4);
  is("control — move one number and exactly that row appends",
    observationsToAppend(fresh, moved).map((o) => `${o.spendDate}=${o.installs}`), ["2026-09-02=7"]);
  is("…including a DOWNWARD restatement, which is still a restatement",
    observationsToAppend([{ spendDate: "2026-09-02", adsetId: "a", installs: 3, spendCents: 200 }], known)
      .map((o) => o.installs), [3]);
  is("a known value of 0 is not treated as absent",
    observationsToAppend([{ spendDate: "2026-09-04", adsetId: "a", installs: 0, spendCents: 0 }],
      new Map([[observationKey("2026-09-04", "a"), 0]])), []);
  is("control — …and a 0 that was previously unseen DOES append",
    observationsToAppend([{ spendDate: "2026-09-04", adsetId: "a", installs: 0, spendCents: 0 }], new Map()).length, 1);
}

console.log("\nthe ad-set floor is its own, and it is not the ledger's");
{
  is("2026-07-31 is below it", isAtOrAfterAdsetFloor("2026-07-31"), false);
  is("2026-08-01 is on it", isAtOrAfterAdsetFloor("2026-08-01"), true);
  is("the floor is where it says it is", META_ADSET_FLOOR_YMD, "2026-08-01");
  /* A HISTORICAL LOAD REACHING THE DAILY FLOOR IS LEGITIMATE and must not try to write these
   * tables — the CHECK would refuse the row and take the whole run with it. */
  is("control — a December day, legal for the daily store, is refused here",
    isAtOrAfterAdsetFloor("2025-12-01"), false);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log(`  XX  ${f}`)); process.exit(1); }
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
