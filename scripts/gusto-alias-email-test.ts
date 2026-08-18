// THE GUSTO EMAIL ALIAS — and proof that adding it moved no money.
//
// This builder writes a file that pays people. The email override is a one-column change, so the
// assertion that matters most is not that the new column works: it is that EVERY amount and EVERY
// memo is byte-identical before and after, across the whole file. A payroll CSV that pays the
// right people the wrong amounts still looks fine.
//
// gustoCsv.test.ts (node:test) is NOT in the gate — run-suites.mjs lists suites explicitly and
// never included it. This one is registered, so these assertions actually run.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/gusto-alias-email-test.ts

import { buildGustoRows, gustoCsvFromRows, type GustoPayload, type GustoAliasMap } from "../src/lib/gustoCsv";

let PASS = 0, FAIL = 0;
const ok = (n: string) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { FAIL++; console.log(`  XX  ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// Adam is the real case: a business payroll address that is not the address he signs in with.
const payload: GustoPayload = {
  weekStart: "2026-07-20",
  cities: [
    { cityIdentifier: "ATL", managers: [
      { managerEmail: "troy@yahoo.com", managerName: "Troy", matchCount: 5, total: 150 },
      { managerEmail: "ZERO@x.com", managerName: "Zero Pay", matchCount: 0, total: 0 },
    ] },
    { cityIdentifier: "ATX", managers: [
      { managerEmail: "adam@clubhouse.test", managerName: "Adam Smallwood", matchCount: 4, total: 40 },
      { managerEmail: null, managerName: "No Email", matchCount: 2, total: 20 },
    ] },
  ],
};

const NAME_ONLY: GustoAliasMap = { "adam@clubhouse.test": { firstName: "Liberty Prime Robotics", lastName: "LLC" } };
const WITH_EMAIL: GustoAliasMap = { "adam@clubhouse.test": { firstName: "Liberty Prime Robotics", lastName: "LLC", email: "adamrsmallwood@gmail.com" } };
const EMAIL_ONLY: GustoAliasMap = { "adam@clubhouse.test": { firstName: "Adam", lastName: "Smallwood", email: "adamrsmallwood@gmail.com" } };

const EMAIL_COL = 2, AMOUNT_COL = 3, MEMO_COL = 4;
const cells = (map: GustoAliasMap) =>
  gustoCsvFromRows(buildGustoRows(payload, "ALL", map)).trimEnd().split("\r\n").map((l) => l.split(","));
const adamRow = (map: GustoAliasMap) => cells(map).find((c) => /Liberty|Smallwood/.test(c[0] + c[1]))!;

console.log("the Email column follows the alias:");
is("alias email SET → it is what the Email column carries", adamRow(WITH_EMAIL)[EMAIL_COL], "adamrsmallwood@gmail.com");
// POSITIVE CONTROL, same run: with the override absent the column falls back to the schedule email,
// so the assertion above is reading a real substitution and not a constant.
is("CONTROL — alias email BLANK → the MatchDay email", adamRow(NAME_ONLY)[EMAIL_COL], "adam@clubhouse.test");
is("CONTROL — no alias at all → the MatchDay email", adamRow({})[EMAIL_COL], "adam@clubhouse.test");
is("Adam's full row is the one Ryan expects", adamRow(WITH_EMAIL).slice(0, 4),
   ["Liberty Prime Robotics", "LLC", "adamrsmallwood@gmail.com", "40.00"]);

console.log("\nthe two overrides are independent:");
is("name alias alone still renames, email untouched", adamRow(NAME_ONLY).slice(0, 3),
   ["Liberty Prime Robotics", "LLC", "adam@clubhouse.test"]);
is("email alias alone still overrides, name untouched", adamRow(EMAIL_ONLY).slice(0, 3),
   ["Adam", "Smallwood", "adamrsmallwood@gmail.com"]);
is("a manager with NO alias is untouched by either", cells(WITH_EMAIL).find((c) => c[0] === "Troy")!.slice(0, 3),
   ["Troy", "", "troy@yahoo.com"]);

console.log("\nCLEARING is a real action — blank must fall back, never write an empty column:");
for (const [label, cleared] of [
  ["null", null], ["empty string", ""], ["whitespace", "   "],
] as [string, string | null][]) {
  const m: GustoAliasMap = { "adam@clubhouse.test": { firstName: "Liberty Prime Robotics", lastName: "LLC", email: cleared } };
  is(`  cleared to ${label} → the MatchDay email, not ""`, adamRow(m)[EMAIL_COL], "adam@clubhouse.test");
}
{
  // No row anywhere may carry an empty Email cell as a RESULT of the override. (A manager with no
  // MatchDay email at all still legitimately has one — that predates this field.)
  const withOverride = cells(WITH_EMAIL).slice(1);
  const baseline = cells({}).slice(1);
  const newlyEmpty = withOverride.filter((c, i) => c[EMAIL_COL] === "" && baseline[i][EMAIL_COL] !== "");
  is("no row's Email went blank that was not blank before", newlyEmpty.length, 0);
  // POSITIVE CONTROL for that zero: the scan can see an empty Email where one genuinely exists.
  is("  control — the scan DOES see the pre-existing empty Email (the null-email manager)",
     baseline.some((c) => c[EMAIL_COL] === ""), true);
}

// ── THE ONE THAT MATTERS ──────────────────────────────────────────────────────────────────────
console.log("\nNO MONEY MOVED. Every amount and memo, byte-identical, across the whole file:");
for (const [label, map] of [["name alias", NAME_ONLY], ["email alias", EMAIL_ONLY], ["both", WITH_EMAIL]] as [string, GustoAliasMap][]) {
  const base = cells({});
  const after = cells(map);
  is(`  ${label}: same number of rows`, after.length, base.length);
  const amounts = { before: base.map((c) => c[AMOUNT_COL]), after: after.map((c) => c[AMOUNT_COL]) };
  const memos = { before: base.map((c) => c[MEMO_COL]), after: after.map((c) => c[MEMO_COL]) };
  is(`  ${label}: every AMOUNT byte-identical`, amounts.after, amounts.before);
  is(`  ${label}: every MEMO byte-identical`, memos.after, memos.before);
}
{
  // And the header itself — a shifted column would repoint every value in the file.
  is("the header is unchanged, in order", cells(WITH_EMAIL)[0],
     ["First Name", "Last Name", "Email", "Fixed amount", "Memo"]);
  // POSITIVE CONTROL for the byte-identical claims: the file DOES differ where it should, so those
  // comparisons are not passing because both sides are the same string.
  const a = gustoCsvFromRows(buildGustoRows(payload, "ALL", {}));
  const b = gustoCsvFromRows(buildGustoRows(payload, "ALL", WITH_EMAIL));
  is("  control — the file genuinely CHANGED (name + email columns)", a !== b, true);
  is("  control — …and with an empty alias map it is byte-identical to the old builder", a, gustoCsvFromRows(buildGustoRows(payload, "ALL")));
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
