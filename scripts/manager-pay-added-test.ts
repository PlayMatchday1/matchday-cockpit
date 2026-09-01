/* PAYING SOMEONE WHO IS NOT ON THE SCHEDULE — the guards on a payroll row with no match behind it.
 *
 * WHY THIS IS A GUARD AND NOT A UNIT TEST. Every row here reaches Gusto and pays a real person.
 * The two failure modes are both silent: a row that does not pay looks exactly like one that does
 * (same shape, same amount, no error — the money simply never arrives), and a second row for one
 * person in one week pays them twice with nothing on screen to say so. Neither is visible on the
 * sheet, so the refusals are the only thing standing in the way.
 *
 * EVERY ASSERTION CARRIES A CONTROL. The passing value of most of these is "unchanged" or
 * "refused", and a fixture that produced nothing gives the same answer as a guard that works.
 *
 * WRITES: none. This file calls no route and touches no table.
 */

import { readFileSync } from "node:fs";
import { buildGustoRows, gustoCsvFromRows, type GustoPayload } from "../src/lib/gustoCsv";
import { computeTiles } from "../src/lib/managerPayView";
import { payRunHasGone, weekSundayFromMonday } from "../src/app/api/manager-pay/added/route";
import { payRunDate } from "../src/lib/bankingDays";
import type { ManagerRow, ManagerPayWeekPayload } from "../src/lib/managerPayCompute";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const WEEK = "2026-09-28"; // a MONDAY, deliberately in the future — see the testing note in the report
const CITY = "ATX";

/* ── THE FIXTURE. Two managers who worked, plus one added person. ─────────────────────────────── */
const worked = (email: string, name: string, n: number, base: number): ManagerRow => ({
  managerEmail: email, managerName: name, managerId: null, cityIdentifier: CITY,
  matches: Array.from({ length: n }, (_, i) => ({
    matchId: 1000 + i, cityIdentifier: CITY, fieldTitle: "NEMP", startDate: `${WEEK}T19:00:00Z`,
    centralDate: WEEK, centralWeekday: "Mon", centralTime: "19:00", name: `M${i}`,
    maxPlayerCount: 20, payAmount: base / n, role: "primary" as const, coManaged: false,
  })),
  matchCount: n, baseTotal: base, adjustment: 0, adjustmentNotes: null, adjustmentAt: null,
  total: base, addedManually: false, adjustmentId: null,
});
const ADDED: ManagerRow = {
  managerEmail: "cover@example.com", managerName: "Cover Person", managerId: null, cityIdentifier: CITY,
  matches: [], matchCount: 0, baseTotal: 0,
  adjustment: 120, adjustmentNotes: "Covered Tuesday at NEMP", adjustmentAt: `${WEEK}T12:00:00Z`,
  total: 120, addedManually: true, adjustmentId: 4242,
};
const WORKED = [worked("a@example.com", "A Manager", 3, 60), worked("b@example.com", "B Manager", 2, 40)];

/* The two reducers the page actually uses, replicated verbatim from ManagerPayView so the
 * assertions below test the ARITHMETIC THE SCREEN DOES, not a restatement of it. */
const sumMatchCount = (rows: ManagerRow[]) => rows.reduce((s, r) => s + r.matchCount, 0);
const sumDistinctMatches = (rows: ManagerRow[]) => new Set(rows.flatMap((r) => r.matches.map((m) => m.matchId))).size;
const sumBase = (rows: ManagerRow[]) => rows.reduce((s, r) => s + r.baseTotal, 0);
const sumAdj = (rows: ManagerRow[]) => rows.reduce((s, r) => s + r.adjustment, 0);

const payload = (rows: ManagerRow[]): ManagerPayWeekPayload => ({
  weekStart: WEEK, weekEnd: "2026-10-04", payDate: "2026-10-06", computedAt: `${WEEK}T12:00:00Z`,
  isAdmin: true,
  cities: [{
    cityIdentifier: CITY, managers: rows, matches: [],
    matchCount: sumMatchCount(rows), baseTotal: sumBase(rows), adjustment: sumAdj(rows),
    total: sumBase(rows) + sumAdj(rows),
  }],
  network: { matchCount: sumMatchCount(rows), managerCount: rows.length, baseTotal: sumBase(rows), adjustment: sumAdj(rows), total: sumBase(rows) + sumAdj(rows) },
  attention: { unassigned: 0, noEmail: 0, bareAdjustment: 0, count: 0 },
} as ManagerPayWeekPayload);

const WITHOUT = payload(WORKED);
const WITH = payload([...WORKED, ADDED]);

console.log("\ncontrol: the fixture has real rows on both sides");
{
  if (sumMatchCount(WORKED) === 5 && sumBase(WORKED) === 100) ok("control: 2 managers, 5 matches worked, $100 match pay");
  else bad("control: the baseline fixture is populated", "EVERY 'UNCHANGED' ASSERTION WOULD BE VACUOUS");
  if (ADDED.adjustment !== 0) ok(`control: the added row carries ${ADDED.adjustment}`);
  else bad("control: the added row carries money", "NOTHING WOULD ROLL ANYWHERE");
}

console.log("\n1. AN ADDED ROW ROLLS INTO THE CITY TOTAL, THE PAYOUT CARD AND THE EXPORT");
{
  is("  city adjustment total", sumAdj([...WORKED, ADDED]), 120);
  is("  city grand total moves by exactly the amount",
    (sumBase([...WORKED, ADDED]) + sumAdj([...WORKED, ADDED])) - (sumBase(WORKED) + sumAdj(WORKED)), 120);
  const t0 = computeTiles(WITHOUT, null, true), t1 = computeTiles(WITH, null, true);
  is("  payout card adjTotal moves by the amount", t1.adjTotal - t0.adjTotal, 120);
  is("  payout card totalPayout moves by the amount", t1.totalPayout - t0.totalPayout, 120);
  const rows0 = buildGustoRows(WITHOUT, "ALL", {}), rows1 = buildGustoRows(WITH, "ALL", {});
  is("  the export gains exactly one row", rows1.length - rows0.length, 1);
  is("  …for the right person, at the right amount",
    rows1.filter((r) => r.scheduleEmail === "cover@example.com").map((r) => r.amount), ["120.00"]);
  // CONTROL: a zero-total row is skipped by the exporter, so "it appears" is not automatic.
  const zero = buildGustoRows(payload([...WORKED, { ...ADDED, adjustment: 0, total: 0 }]), "ALL", {});
  if (zero.length === rows0.length) ok("control: a $0 added row is NOT exported — appearing is not automatic");
  else bad("control: a $0 row is skipped", "THE EXPORT ASSERTION PROVED NOTHING");
}

console.log("\n2. IT DOES NOT MOVE MATCHES WORKED OR MATCHES PAID, ANYWHERE");
{
  is("  matches worked is unchanged", sumMatchCount([...WORKED, ADDED]), sumMatchCount(WORKED));
  is("  distinct matches is unchanged", sumDistinctMatches([...WORKED, ADDED]), sumDistinctMatches(WORKED));
  is("  match pay is unchanged", sumBase([...WORKED, ADDED]), sumBase(WORKED));
  const t0 = computeTiles(WITHOUT, null, true), t1 = computeTiles(WITH, null, true);
  is("  the payout card's matchPay is unchanged", t1.matchPay, t0.matchPay);
  is("  matchesPaid is unchanged", t1.matchesPaid, t0.matchesPaid);
  is("  the added row's own matchCount is 0", ADDED.matchCount, 0);
  is("  …and its baseTotal is 0", ADDED.baseTotal, 0);
  /* THE CONTROL THAT MAKES THIS MEAN SOMETHING: the same row with a non-zero matchCount DOES move
   * the figure. Without this, "unchanged" would also pass on a reducer that ignores added rows —
   * or on one that ignores every row. */
  const cheat = [...WORKED, { ...ADDED, matchCount: 3 }];
  if (sumMatchCount(cheat) === sumMatchCount(WORKED) + 3) ok("control: a matchCount of 3 on the same row DOES move it — the sum is live");
  else bad("control: the matches-worked sum is live", "'UNCHANGED' WOULD PASS ON A DEAD REDUCER");
  /* And the memo proves the export knows it is a zero-match row rather than silently printing 0. */
  const memo = buildGustoRows(WITH, "ALL", {}).find((r) => r.scheduleEmail === "cover@example.com")!.memo;
  if (!/^0 matches/.test(memo)) ok(`control: the memo does not read "0 matches …" — it reads "${memo.slice(0, 40)}…"`);
  else bad("the memo is not a bare 0-match line", "A '0 matches' MEMO IS INDISTINGUISHABLE FROM A BUG");
}

console.log("\n3. A PERSON WITH NO GUSTO MAPPING CANNOT BE SAVED");
{
  const ROUTE = readFileSync("src/app/api/manager-pay/added/route.ts", "utf8");
  if (/manager_gusto_aliases/.test(ROUTE) && /has no Gusto mapping/.test(ROUTE)) ok("  the route checks the mapping server-side and names the person");
  else bad("the route refuses a person with no Gusto mapping", "THE DIALOG IS A COURTESY; A ROW WITHOUT ONE DOES NOT PAY");
  if (/status: 409/.test(ROUTE.slice(ROUTE.indexOf("has no Gusto mapping") - 400, ROUTE.indexOf("has no Gusto mapping") + 400)))
    ok("  …as a refusal, not a 500");
  else bad("the no-mapping refusal is a clean 409");
  const VIEW = readFileSync("src/app/(internal)/match-ops/manager-pay/ManagerPayView.tsx", "utf8");
  if (/const noGusto = !!picked && !picked\.gusto/.test(VIEW) && /noGusto \|\|/.test(VIEW)) ok("  and the dialog blocks the save before it is sent");
  else bad("the dialog blocks a no-mapping save", "THE OPERATOR WOULD ONLY LEARN AT THE SERVER");
  if (/NO GUSTO MAPPING/.test(VIEW)) ok("  …with the reason on the option itself");
  else bad("the picker marks a person with no mapping");
  // CONTROL: the picker SHOWS the Gusto name when there is one, the same way the rows do.
  if (/Gusto: \{p\.gusto\.firstName\} \{p\.gusto\.lastName\}/.test(VIEW)) ok('control: a mapped person shows "Gusto: First Last", as existing rows do');
  else bad("the picker shows the Gusto mapping", "THE OPERATOR CANNOT SEE WHAT WILL REACH PAYROLL");
  // ...and the directory returns gusto:null rather than hiding the person.
  const DIR = readFileSync("src/app/api/manager-pay/directory/route.ts", "utf8");
  if (/gusto: gusto\.firstName \|\| gusto\.lastName \? gusto : null/.test(DIR)) ok("  the directory returns gusto:null rather than omitting the person");
  else bad("the directory returns unmapped people", "OMITTING THEM READS AS 'DOES NOT EXIST'");
}

console.log("\n4. A PERSON WHO ALREADY HAS A ROW THAT WEEK IS REFUSED");
{
  const ROUTE = readFileSync("src/app/api/manager-pay/added/route.ts", "utf8");
  if (/already has a pay row for the week of/.test(ROUTE) && /Add adjustment/.test(ROUTE))
    ok("  the route refuses and points at the existing row");
  else bad("the duplicate refusal names the alternative", "TWO ROWS IN ONE WEEK DOUBLE-PAYS IN GUSTO");
  if (/double-pays/.test(ROUTE)) ok("  …and says what would happen");
  else bad("the duplicate refusal states the consequence");
  const VIEW = readFileSync("src/app/(internal)/match-ops/manager-pay/ManagerPayView.tsx", "utf8");
  if (/const dupe = !!picked && existingEmails\.has/.test(VIEW) && /dupe \|\|/.test(VIEW))
    ok("  the dialog blocks it too, from the rows already on the page");
  else bad("the dialog blocks a duplicate");
  /* THE DATABASE IS THE LAST WORD. UNIQUE (manager_email, week_start) has been there since 0025
   * and is stronger than per-city: one row per person per week, whichever city. Asserted from the
   * migration so a future edit that drops it fails here. */
  const M0025 = readFileSync("supabase/migrations/0025_manager_pay_adjustments.sql", "utf8");
  if (/UNIQUE \(manager_email, week_start\)/.test(M0025)) ok("  and the table's UNIQUE (manager_email, week_start) is the backstop");
  else bad("the UNIQUE constraint still exists", "THE ROUTE CHECK WOULD BE THE ONLY THING STOPPING A DOUBLE-PAY");
  // CONTROL: the constraint is per WEEK, not per city — a second city does not make a second row legal.
  if (!/UNIQUE \([^)]*city/.test(M0025 + readFileSync("supabase/migrations/0156_manager_pay_adjustments_city.sql", "utf8")))
    ok("control: no per-city uniqueness was introduced — one row per person per week, full stop");
  else bad("uniqueness stayed per-week", "A PER-CITY UNIQUE WOULD ALLOW TWO ROWS FOR ONE PERSON");
}

console.log("\n5. SAVING WITHOUT A REASON IS REFUSED");
{
  const ROUTE = readFileSync("src/app/api/manager-pay/added/route.ts", "utf8");
  if (/if \(!reason\) return Response\.json\(\{ error: "A reason is required/.test(ROUTE))
    ok("  the route refuses an empty reason");
  else bad("the route requires a reason", "MONEY WITH NO MATCH BEHIND IT AND NO EXPLANATION IS UNAUDITABLE");
  if (/\.trim\(\)/.test(ROUTE.slice(ROUTE.indexOf("const reason"), ROUTE.indexOf("const reason") + 120)))
    ok("  …and whitespace is not a reason");
  else bad("the reason is trimmed", "' ' WOULD PASS");
  const VIEW = readFileSync("src/app/(internal)/match-ops/manager-pay/ManagerPayView.tsx", "utf8");
  if (/reason\.trim\(\) === ""/.test(VIEW)) ok("  the dialog disables Save until a reason is typed");
  else bad("the dialog requires a reason");
  if (/REASON \(REQUIRED\)/.test(VIEW)) ok("  …and the label says so");
  else bad("the reason field is labelled required");
  /* THE COLUMN STAYS NULLABLE IN THE DATABASE, deliberately: existing inline Additional Pay rows
   * legitimately carry no note and a NOT NULL would reject them. The requirement is the route's. */
  const M = readFileSync("supabase/migrations/0156_manager_pay_adjustments_city.sql", "utf8");
  if (/notes stays NULLABLE/i.test(M)) ok("  control: the migration records WHY notes is not NOT NULL");
  else bad("the migration explains the nullable notes column", "THE NEXT READER WILL ADD THE CONSTRAINT AND BREAK INLINE ROWS");
}

console.log("\n6. THE REASON REACHES THE EXPORT, NOT ONLY THE DATABASE");
{
  const row = buildGustoRows(WITH, "ALL", {}).find((r) => r.scheduleEmail === "cover@example.com")!;
  if (row.memo.includes("Covered Tuesday at NEMP")) ok(`  the Gusto memo carries the reason: "${row.memo}"`);
  else bad("the reason is in the Gusto memo", `got "${row.memo}" — THE PERSON APPROVING THE FILE NEVER SEES THE CLUBHOUSE PAGE`);
  const csv = gustoCsvFromRows([row]);
  if (csv.includes("Covered Tuesday at NEMP")) ok("  …and survives into the serialized CSV");
  else bad("the reason survives serialization", "IT WOULD EXIST ONLY IN MEMORY");
  // CONTROL: a normal worked row's memo is UNCHANGED — this must not rewrite every memo.
  const normal = buildGustoRows(WITH, "ALL", {}).find((r) => r.scheduleEmail === "a@example.com")!;
  is("control: a normal row's memo is untouched", normal.memo, `3 matches · ${CITY} · week of ${WEEK}`);
  // ...and the export byte-identical property holds for a payload with no added rows at all.
  is("control: a payload with no added rows exports exactly as before",
    buildGustoRows(WITHOUT, "ALL", {}).map((r) => r.memo),
    [`3 matches · ${CITY} · week of ${WEEK}`, `2 matches · ${CITY} · week of ${WEEK}`]);
  // The reason is also on the SHEET, beside the amount — the existing adjustment cell renders it.
  const VIEW = readFileSync("src/app/(internal)/match-ops/manager-pay/ManagerPayView.tsx", "utf8");
  if (/\{r\.adjustmentNotes \?\? "No reason written down"\}/.test(VIEW)) ok("  and it renders on the sheet beside the amount");
  else bad("the reason renders on the sheet");
}

console.log("\n7. A SUBMITTED PAY RUN REFUSES BOTH ADD AND DELETE");
{
  /* THERE IS NO completed/locked FLAG IN THIS CODEBASE — no table, no column, no status. The lock
   * is the DERIVED pay-run date from bankingDays.payRunDate(): the Tuesday after the week's
   * Sunday, moved forward if that Tuesday is a Fed holiday. Once today is past it, the file has
   * gone to Gusto. This asserts both sides of that boundary. */
  const week = "2026-09-28";                        // Monday
  const sunday = weekSundayFromMonday(week);
  is("  the week's Sunday is Monday + 6", sunday, "2026-10-04");
  const run = payRunDate(sunday);
  is("  the pay run is the Tuesday after", run, "2026-10-06");
  is("  the day before the run: OPEN", payRunHasGone(week, "2026-10-05"), false);
  is("  the day of the run: still OPEN", payRunHasGone(week, run), false);
  is("  the day after the run: LOCKED", payRunHasGone(week, "2026-10-07"), true);
  is("  a month later: LOCKED", payRunHasGone(week, "2026-11-07"), true);
  const ROUTE = readFileSync("src/app/api/manager-pay/added/route.ts", "utf8");
  const guards = ROUTE.match(/payRunHasGone\(/g) ?? [];
  // Three: the exported definition plus one call in POST and one in DELETE.
  if (guards.length >= 3) ok(`  both POST and DELETE call it (${guards.length} references)`);
  else bad("POST and DELETE both check the lock", `only ${guards.length} references — ONE PATH IS UNGUARDED`);
  if (/Rows for a submitted run are read-only/.test(ROUTE)) ok("  …and the refusal names the run date");
  else bad("the lock refusal names the date");
  if (/THERE IS NO "completed" OR "locked" STATE IN THIS CODEBASE/.test(ROUTE))
    ok("  and the file records that no real completed flag exists — this is a derived date");
  else bad("the absence of a completed flag is recorded", "THE NEXT READER WILL ASSUME ONE EXISTS");
}

console.log("\n8. THE ADJUSTMENTS COUNT INCREMENTS BY EXACTLY ONE");
{
  const t0 = computeTiles(WITHOUT, null, true), t1 = computeTiles(WITH, null, true);
  is("  adjCount +1", t1.adjCount - t0.adjCount, 1);
  is("  control: it was not already counting it", t0.adjCount, 0);
  is("  managersPaid +1 — a person being paid IS a manager row", t1.managersPaid - t0.managersPaid, 1);
  is("  control: needs-a-look does NOT rise — the row has a reason", t1.needsLook, t0.needsLook);
  /* CONTROL: strip the reason and it DOES rise, under bareReason. That proves needsLook is live
   * and that a reasonless added row would be flagged rather than sailing through. */
  const bare = computeTiles(payload([...WORKED, { ...ADDED, adjustmentNotes: null }]), null, true);
  if (bare.needsLook === t0.needsLook + 1) ok("control: an added row with NO reason raises needs-a-look by one");
  else bad("control: a reasonless row is flagged", `${bare.needsLook} vs ${t0.needsLook} — needsLook IS NOT LIVE`);
}

console.log("\n9. THE AUDIT TRAIL, AND WHAT IT MAY NOT CARRY");
{
  const ROUTE = readFileSync("src/app/api/manager-pay/added/route.ts", "utf8");
  is("  both handlers go through recordWrite", (ROUTE.match(/await recordWrite\(/g) ?? []).length, 2);
  if (/body: \{ weekStart, cityIdentifier, managerEmail, amount, reason \}/.test(ROUTE))
    ok("  the logged body is week, city, person, amount, reason — the five facts");
  else bad("the logged body is the five facts", "change_log HAS DIFFERENT ACCESS RULES AND A LONGER LIFE");
  /* COMMENTS STRIPPED FIRST. The route's own comment says "No phone." and an unstripped scan
   * matches it — flagging the sentence that promises the thing it is checking for. */
  const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  if (!/phone/i.test(CODE)) ok("  no phone number is anywhere in the route's code");
  else bad("the route is phone-free", "A PHONE IN change_log IS A SECOND COPY OF PLAYER PII");
  // CONTROL: the scan can see the word when it is really in code, not just in prose.
  is("  control: the phone scan fires on real code", /phone/i.test('const p = row.phoneNumber;'), true);
  is("  control: …and the comment stripper actually removed prose", /No phone/.test(CODE), false);
  if (/applied: \(_b, a\) => \(a\.row as Record<string, unknown> \| null\) != null/.test(ROUTE))
    ok("  the add's verdict is a read-back of the row, not the absence of an error");
  else bad("the add reads back", "A 2xx IS NOT A LANDED WRITE");
  if (/applied: \(_b, a\) => \(a\.row as Record<string, unknown> \| null\) == null/.test(ROUTE))
    ok("  the delete's verdict is a read-back that the row is gone");
  else bad("the delete reads back");
  const VIEW = readFileSync("src/app/(internal)/match-ops/manager-pay/ManagerPayView.tsx", "utf8");
  if (/json\?\.outcome !== "landed"/.test(VIEW)) ok("  and the client refuses to report success on any other outcome");
  else bad("the client checks the outcome", "IT WOULD REPORT INTENT AS FACT");
  // The confirm names the person AND the amount.
  if (/Remove \$\{who\} from the \$\{r\.cityIdentifier\} pay sheet for the week of \$\{weekStart\}, and their \$\{money\(r\.adjustment\)\}/.test(VIEW))
    ok("  the delete confirm names the person, the city, the week and the amount");
  else bad("the delete confirm is specific", '"ARE YOU SURE?" IS NOT A CONFIRMATION');
}

console.log("\n11. THE ADDED ROW SHOWS A NAME, NOT AN EMAIL");
{
  /* FOUND BY THE 2026-08-31 STAGING-EQUIVALENT ROUND-TRIP, not by reading the code: the row
   * rendered "adam60670@yahoo.com" in the MANAGER column, because the adjustment row carries an
   * email and nothing else. The export was saved by the alias map the page always passes, so this
   * was visible ONLY on screen — the kind of defect a code read does not surface. */
  const COMPUTE = readFileSync("src/lib/managerPayCompute.ts", "utf8");
  if (/managerName: nameByEmail\.get\(key\) \?\? key/.test(COMPUTE)) ok("  the name is resolved before falling back to the email");
  else bad("the added row resolves a display name", "THE MANAGER COLUMN WOULD SHOW AN EMAIL ADDRESS");
  if (/manager_gusto_aliases"\)\.select\("\*"\)\.in\("manager_email", addedKeys\)/.test(COMPUTE))
    ok("  …from the Gusto alias, which the add route guarantees exists");
  else bad("the name comes from the alias table", "ANY OTHER SOURCE CAN DISAGREE WITH THE CSV");
  if (/if \(addedKeys\.length > 0\) \{/.test(COMPUTE)) ok("  …and the extra read only happens when there is something to name");
  else bad("the alias read is conditional", "EVERY PAY WEEK WOULD PAY FOR A LOOKUP IT DOES NOT NEED");
  // CONTROL: the export splits managerName on a space when no alias is supplied, which is exactly
  // how an email became First="adam60670@yahoo.com" Last="". Prove that path still behaves so.
  const bare = buildGustoRows(payload([{ ...ADDED, managerName: "someone@example.com" }]), "ALL", {})[0];
  is("control: with no alias, an email-as-name splits into First=email Last=''",
    [bare.firstName, bare.lastName], ["someone@example.com", ""]);
  const named = buildGustoRows(payload([{ ...ADDED, managerName: "Cover Person" }]), "ALL", {})[0];
  is("  …and a real name splits correctly", [named.firstName, named.lastName], ["Cover", "Person"]);
}

console.log("\n10. THE CONTROL IS SCOPED BY THE BLOCK, NOT BY TYPING");
{
  const VIEW = readFileSync("src/app/(internal)/match-ops/manager-pay/ManagerPayView.tsx", "utf8");
  if (/setAddFor\(\{ city: c\.cityIdentifier, unassigned: un \}\)/.test(VIEW))
    ok("  the city comes from the band it was pressed in");
  else bad("the city comes from the block", "A TYPED CITY CAN BE TYPED WRONG");
  if (/cityIdentifier: b\.city, amount: b\.amount/.test(VIEW) && /weekStart,/.test(VIEW))
    ok("  …and the week from the page");
  else bad("the week comes from the page");
  // THE BETTER PATH IS SHOWN FIRST, and it is not forced.
  if (/These matches have no manager\. Assigning one pays them automatically\./.test(VIEW))
    ok("  unassigned matches are offered first, with that sentence");
  else bad("the better path is offered", "A MANUAL ROW LEAVES THE MATCH STILL UNASSIGNED");
  const order = VIEW.indexOf("These matches have no manager");
  const form = VIEW.indexOf("Search the manager directory");
  if (order > 0 && form > order) ok("  …above the manual form, not below it");
  else bad("the better path renders above the form", `indices ${order} / ${form}`);
  if (/unassigned\.length > 0 &&/.test(VIEW)) ok("  and it is omitted when there are none — not an empty box");
  else bad("the unassigned block is conditional");
}

console.log(`\nmanager-pay-added: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
