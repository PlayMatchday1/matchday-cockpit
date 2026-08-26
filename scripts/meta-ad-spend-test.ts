import "server-only"; // no-op under --conditions=react-server
// FINANCE › META AD SPEND — the mapping, the floor, the ownership predicate, and the money parse.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/meta-ad-spend-test.ts
//
// WHY A SUITE FOR THIS, when the testing bar says admin/reporting work gets a browser look and a
// push. Because this one writes fin_expenses. It is a background job that DELETES rows in the
// finance ledger and rewrites them, and three of its failure modes are silent:
//
//   1. A DROPPED MARKET. An unmapped Comscore market that vanishes instead of becoming unallocated
//      understates spend, and understated spend looks exactly like a quiet month.
//   2. THE OWNERSHIP PREDICATE WIDENING. One wrong clause and the job deletes hand-entered rows —
//      April through July are reconciled by hand and there is no undo.
//   3. A FLOAT IN THE MONEY PATH. 8.29 * 100 is 828.9999999999999. Math.round hides it right up
//      until the day it does not, and by then the ledger has been wrong for months.
//
// None of these are visible on screen and none can be caught by opening the page.

import {
  META_MARKET_TO_CITY, cityForMarket, spendStringToCents, impressionsToInt,
  isAtOrAfterFloor, windowFor, assertUsd, reconcileDay, toDailyRows, monthlyExpenseRows,
  ownsExpenseRow, redactMetaError, UNALLOCATED_MARKET, META_FLOOR_YMD,
  type MetaBreakdownRow,
} from "../src/lib/metaAdSpend";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const throws = (n: string, fn: () => unknown) => {
  try { fn(); bad(n, "did NOT throw"); } catch { ok(n); }
};

console.log("META AD SPEND\n");

// ── 1. THE MAPPING COVERS EXACTLY SEVEN MARKETS ────────────────────────────────────────────────
console.log("mapping");
is("exactly seven markets are mapped", Object.keys(META_MARKET_TO_CITY).length, 7);
is("…and they are the seven agreed", Object.keys(META_MARKET_TO_CITY).sort(), [
  "Atlanta, GA", "Austin, TX", "Dallas-Ft. Worth, TX", "Houston, TX",
  "Oklahoma City, OK", "San Antonio, TX", "St. Louis, MO",
]);
is("…mapping to our city codes", Object.values(META_MARKET_TO_CITY).sort(), ["ATL","ATX","DFW","HTX","OKC","SATX","STL"]);
// POSITIVE CONTROL for every negative lookup below: the same function DOES find a real market.
is("CONTROL — a known market resolves", cityForMarket("Houston, TX"), "HTX");
// EXACT STRING ONLY. A rename must surface as unmapped, never attach to the nearest-looking city.
is("a renamed market does not fuzzy-match", cityForMarket("Dallas-Fort Worth, TX"), null);
is("case is not folded", cityForMarket("houston, tx"), null);
is("whitespace is not trimmed into a match", cityForMarket(" Houston, TX "), null);
is("an unknown market is null, not a throw", cityForMarket("Boise, ID"), null);
is("a prototype key cannot masquerade as a market", cityForMarket("constructor"), null);

// ── 2. AN UNMAPPED MARKET BECOMES UNALLOCATED, NEVER VANISHES ──────────────────────────────────
console.log("\nunmapped spend is carried, not dropped");
const mixed: MetaBreakdownRow[] = [
  { date: "2026-08-10", marketRaw: "Houston, TX", spendCents: 24083, impressions: 23770 },
  { date: "2026-08-10", marketRaw: "Boise, ID",  spendCents:  1000, impressions:  900 },
];
const daily = toDailyRows(mixed, "act_1", "USD");
is("the unmapped row survives with a null city", daily.map((r) => r.marketKey), ["HTX", null]);
const monthly = monthlyExpenseRows(daily);
is("it becomes its own unallocated expense row", monthly.filter((m) => m.unallocated).length, 1);
is("carrying its full spend", monthly.find((m) => m.unallocated)?.amountCents, 1000);
is("and NOTHING is lost across the roll-up",
  monthly.reduce((s, m) => s + m.amountCents, 0), 24083 + 1000);

// ── 3. THE OWNERSHIP PREDICATE CANNOT REACH A HAND-ENTERED ROW ─────────────────────────────────
console.log("\nownership predicate");
is("CONTROL — the job DOES own its own row",
  ownsExpenseRow({ vendor: "Meta", manual_entry: false, date: "2026-08-31" }), true);
is("a manual_entry row is never owned",
  ownsExpenseRow({ vendor: "Meta", manual_entry: true, date: "2026-08-31" }), false);
is("a NULL manual_entry is treated as hand-entered",
  ownsExpenseRow({ vendor: "Meta", manual_entry: null, date: "2026-08-31" }), false);
is("July's hand rows are out of reach (before the cutover)",
  ownsExpenseRow({ vendor: "Meta", manual_entry: false, date: "2026-07-31" }), false);
is("another vendor is never owned",
  ownsExpenseRow({ vendor: "Cedar & Cactus", manual_entry: false, date: "2026-08-31" }), false);
is("a null vendor is never owned",
  ownsExpenseRow({ vendor: null, manual_entry: false, date: "2026-08-31" }), false);
// The exact rows that exist in production today, asserted individually.
for (const d of ["2026-07-10", "2026-07-19"]) {
  is(`the real July ${d} Meta rows are unreachable`,
    ownsExpenseRow({ vendor: "Meta", manual_entry: true, date: d }), false);
}

// ── 4. THE FLOOR REFUSES — ASSERTED, NOT COMMENTED ─────────────────────────────────────────────
console.log("\nthe 2026-08-01 floor");
is("the floor constant is the cutover", META_FLOOR_YMD, "2026-08-01");
is("CONTROL — the first allowed day passes", isAtOrAfterFloor("2026-08-01"), true);
is("the day before is refused", isAtOrAfterFloor("2026-07-31"), false);
is("April is refused", isAtOrAfterFloor("2026-04-30"), false);
is("a malformed date is refused", isAtOrAfterFloor("2026-8-1"), false);
is("an empty date is refused", isAtOrAfterFloor(""), false);
/* THE WINDOW CLAMPS TO THE **DAILY** FLOOR, NOT THE LEDGER'S — and this assertion changed when the
 * two floors were split. It previously required a 28-day window in early August to clamp to
 * 2026-08-01, which was right only while one constant served both purposes. The daily store now
 * floors at 2025-12-01, so the same window legitimately reaches back into July.
 *
 * THE BEHAVIOUR CHANGED ON PURPOSE; the test was not edited to go green. What protects the LEDGER
 * is no longer the window — it is monthlyExpenseRows refusing any date before the expense floor,
 * asserted directly below and again in meta-expense-floor-test.ts. */
is("a 28-day window in early August reaches into July for the DAILY store",
  windowFor("2026-08-05").since, "2026-07-09");
is("…and still ends today", windowFor("2026-08-05").until, "2026-08-05");
is("CONTROL — a later window is not clamped at all", windowFor("2026-09-30").since, "2026-09-03");
is("a window early in December clamps to the DAILY floor",
  windowFor("2025-12-05").since, "2025-12-01");
is("November can never be reached, however wide the window",
  windowFor("2025-12-01", 400).since, "2025-12-01");
// …and the reach-back must NOT become ledger rows.
is("the July days that window reaches produce NO expense row",
  monthlyExpenseRows(toDailyRows(
    [{ date: "2026-07-09", marketRaw: "Houston, TX", spendCents: 5000, impressions: 1 }], "act_1", "USD")).length, 0);
// A pre-floor row that somehow reached the roll-up is still refused at the write boundary.
is("a pre-floor daily row never reaches an expense row",
  monthlyExpenseRows(toDailyRows(
    [{ date: "2026-07-15", marketRaw: "Houston, TX", spendCents: 9999, impressions: 1 }], "act_1", "USD")).length, 0);

// ── 5. CURRENCY ────────────────────────────────────────────────────────────────────────────────
console.log("\ncurrency");
try { assertUsd("USD"); ok("CONTROL — USD is accepted"); } catch { bad("CONTROL — USD is accepted"); }
try { assertUsd("usd"); ok("…case-insensitively"); } catch { bad("…case-insensitively"); }
throws("EUR refuses to write", () => assertUsd("EUR"));
throws("CAD refuses to write", () => assertUsd("CAD"));
throws("a missing currency refuses to write", () => assertUsd(null));

// ── 6. VARIANCE — THE PARTS MUST SUM TO THE WHOLE, OR THE REMAINDER IS RECORDED ────────────────
console.log("\ndaily reconciliation");
const parts: MetaBreakdownRow[] = [
  { date: "2026-08-10", marketRaw: "Houston, TX", spendCents: 1000, impressions: 10 },
  { date: "2026-08-10", marketRaw: "Austin, TX",  spendCents:  500, impressions:  5 },
];
const clean = reconcileDay("2026-08-10", parts, 1500);
is("CONTROL — a day that reconciles adds no row", clean.rows.length, 2);
is("…and reports zero variance", clean.varianceCents, 0);
const short = reconcileDay("2026-08-10", parts, 1750);
is("a shortfall produces an unallocated row", short.rows.length, 3);
is("…carrying exactly the difference", short.rows[2].spendCents, 250);
is("…named as unallocated", short.rows[2].marketRaw, UNALLOCATED_MARKET);
is("…and the variance is reported", short.varianceCents, 250);
const over = reconcileDay("2026-08-10", parts, 1400);
is("parts exceeding the total add NO negative row", over.rows.length, 2);
is("…but the variance is still visible", over.varianceCents, -100);

// ── 7. MONEY — NO FLOAT EVER TOUCHES IT ────────────────────────────────────────────────────────
console.log("\nspend parsing");
is("CONTROL — a plain value parses", spendStringToCents("240.83"), 24083);
is("the positive control's own total parses", spendStringToCents("925.42"), 92542);
is("zero", spendStringToCents("0"), 0);
is("no decimal part", spendStringToCents("12"), 1200);
is("one decimal place is padded", spendStringToCents("1.5"), 150);
// The float trap, spelled out: these are the values where Number(x)*100 goes wrong.
for (const [s, want] of [["8.29", 829], ["1.15", 115], ["10.07", 1007], ["0.29", 29], ["117.74", 11774]] as const) {
  is(`${s} parses exactly (float would drift)`, spendStringToCents(s), want);
}
throws("a non-numeric string refuses rather than becoming 0", () => spendStringToCents("n/a"));
throws("an empty string refuses", () => spendStringToCents(""));
throws("undefined refuses", () => spendStringToCents(undefined));
throws("a negative refuses", () => spendStringToCents("-5.00"));
// SUB-CENT PRECISION IS REAL DATA, NOT A MALFORMED VALUE. This assertion previously required
// three decimals to REFUSE. The first live call returned "519.544921" — six — so the old rule
// would have rejected every account-level breakdown row. The BEHAVIOUR was wrong, not the test;
// recorded here rather than quietly edited.
is("six decimals — the real shape Meta returns", spendStringToCents("519.544921"), 51954);
is("rounds half-up on the third digit", spendStringToCents("1.235"), 124);
is("…and down below it", spendStringToCents("1.234"), 123);
is("carrying into the next cent", spendStringToCents("0.999"), 100);
is("carrying into the next dollar", spendStringToCents("9.999"), 1000);
is("impressions absent is null, not zero", impressionsToInt(null), null);
is("CONTROL — impressions parse", impressionsToInt("23770"), 23770);

// ── 8. THE TOKEN NEVER LEAVES THIS MODULE ──────────────────────────────────────────────────────
console.log("\ntoken redaction");
is("a bearer header is stripped from an error",
  redactMetaError("failed: Bearer EAAGm0PX4ZCpsBO7abc123DEF456ghi"), "failed: Bearer [REDACTED]");
is("a query-string token is stripped",
  redactMetaError("GET /insights?access_token=EAAsecret123&level=campaign"),
  "GET /insights?access_token=[REDACTED]&level=campaign");
is("a bare EA-prefixed token is stripped",
  redactMetaError("oops EAAGm0PX4ZCpsBO7abc123DEF456ghi789 here"), "oops [REDACTED] here");
is("CONTROL — ordinary text is untouched",
  redactMetaError("Unsupported get request for breakdowns"), "Unsupported get request for breakdowns");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
