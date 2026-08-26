import "server-only"; // no-op under --conditions=react-server
// FINANCE › THE fin_expenses FLOOR IS NOT A TUNABLE.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/meta-expense-floor-test.ts
//
// THIS SUITE EXISTS TO FAIL LOUDLY WHEN SOMEONE LOWERS META_EXPENSE_FLOOR_YMD.
//
// The obvious reading of that constant is "the date before which we already have hand-entered rows,
// so don't double-count". That reading is INCOMPLETE and acting on it produces a wrong P&L:
//
//   fin_expenses HAS NO ROWS OF ANY KIND BEFORE 2026-04-30. Not ad spend — nothing. No venue cost,
//   no match manager pay, no salaries, no agency fees. Verified against production while loading
//   the Dec–Mar daily history: every Marketing row is dated 2026-04-30 or later.
//
// So loading ad spend into Dec–Mar would render five months of profit and loss showing marketing
// cost against NO OTHER COST. That statement reads as complete. It is not. A month with no data
// looks empty and invites the question; a month with only its marketing cost filled in looks
// finished and answers the question wrongly.
//
// THE DAILY TABLE HAS NO SUCH PROBLEM — fin_meta_ad_spend_daily only ever claims to be ad spend, so
// its floor is 2025-12-01 and the history lives there. The two floors are separate on purpose and
// re-merging them is the specific regression this file catches.
//
// TO LOWER THE LEDGER FLOOR LEGITIMATELY: first give those months their other costs, then change
// EARLIEST_SAFE below in the same commit, with the evidence.

import {
  META_EXPENSE_FLOOR_YMD, META_DAILY_FLOOR_YMD, META_FLOOR_YMD,
  ownsExpenseRow, isAtOrAfterFloor, isAtOrAfterDailyFloor, monthlyExpenseRows, toDailyRows,
} from "../src/lib/metaAdSpend";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("THE fin_expenses FLOOR\n");

/* The earliest date the LEDGER floor may take without the empty-months problem being solved.
 * Deliberately not derived from the constant it guards — a guard computed from its subject
 * always passes. */
const EARLIEST_SAFE = "2026-08-01";
const WHY =
  "\n\n      fin_expenses has NO rows of any kind before 2026-04-30 — no venue cost, no manager pay,\n" +
  "      no salaries. Ad spend in Dec-Mar renders five months of P&L showing marketing cost and\n" +
  "      nothing else: a statement that READS AS COMPLETE AND IS NOT. The daily series belongs in\n" +
  "      fin_meta_ad_spend_daily (floor 2025-12-01), which only ever claims to be ad spend.\n" +
  "      If those months now carry their other costs, say so here and move EARLIEST_SAFE with it.\n";

if (META_EXPENSE_FLOOR_YMD >= EARLIEST_SAFE) {
  ok(`the ledger floor is ${META_EXPENSE_FLOOR_YMD}, not earlier than ${EARLIEST_SAFE}`);
} else {
  bad(`THE fin_expenses FLOOR HAS BEEN LOWERED to ${META_EXPENSE_FLOOR_YMD} (safe: ${EARLIEST_SAFE})`, WHY);
}

// THE TWO FLOORS MUST NOT BE RE-MERGED. They were one constant once; that is the regression.
is("the two floors are different values", META_EXPENSE_FLOOR_YMD !== META_DAILY_FLOOR_YMD, true);
is("the daily floor is the earlier of the two", META_DAILY_FLOOR_YMD < META_EXPENSE_FLOOR_YMD, true);
is("the daily floor is December 2025", META_DAILY_FLOOR_YMD, "2025-12-01");
is("the deprecated alias still points at the STRICTER floor", META_FLOOR_YMD, META_EXPENSE_FLOOR_YMD);

// A DECEMBER ROW IS VALID FOR THE DAILY STORE AND INVALID FOR THE LEDGER. Both asserted, because
// the whole design is that these two answers differ.
console.log("\na December date, asked of both floors");
is("CONTROL — the daily floor accepts December", isAtOrAfterDailyFloor("2025-12-01"), true);
is("the ledger floor refuses December", isAtOrAfterFloor("2025-12-01"), false);
is("the daily floor still refuses November", isAtOrAfterDailyFloor("2025-11-30"), false);
is("CONTROL — the ledger floor accepts August", isAtOrAfterFloor("2026-08-01"), true);

// THE ROLL-UP MUST DROP HISTORICAL ROWS. This is the path a daily-only load would take if someone
// later called it without dailyOnly — the ledger writer itself refuses them.
console.log("\nthe roll-up refuses historical days even when handed them");
const dec = toDailyRows(
  [{ date: "2025-12-15", marketRaw: "Houston, TX", spendCents: 5000, impressions: 100 }], "act_1", "USD");
is("a December daily row produces NO expense row", monthlyExpenseRows(dec).length, 0);
const aug = toDailyRows(
  [{ date: "2026-08-15", marketRaw: "Houston, TX", spendCents: 5000, impressions: 100 }], "act_1", "USD");
is("CONTROL — an August row DOES produce one", monthlyExpenseRows(aug).length, 1);
const both = toDailyRows([
  { date: "2025-12-15", marketRaw: "Houston, TX", spendCents: 5000, impressions: 100 },
  { date: "2026-08-15", marketRaw: "Houston, TX", spendCents: 7000, impressions: 100 },
], "act_1", "USD");
is("mixed input keeps only the August money", monthlyExpenseRows(both).reduce((s, m) => s + m.amountCents, 0), 7000);

// And the ownership predicate never reaches back either.
console.log("\nthe ownership predicate cannot reach the historical months");
for (const d of ["2025-12-01", "2026-01-15", "2026-02-28", "2026-03-31", "2026-04-30", "2026-07-31"]) {
  is(`${d} is not owned`, ownsExpenseRow({ vendor: "Meta", manual_entry: false, date: d }), false);
}
is("CONTROL — 2026-08-01 IS owned", ownsExpenseRow({ vendor: "Meta", manual_entry: false, date: "2026-08-01" }), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
