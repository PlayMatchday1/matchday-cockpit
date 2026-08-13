// Phase 25 — the CITY MANAGER gate.
//
// A real city-manager account does not exist yet (Ryan's instruction), and server auth reads the
// REAL app_users row rather than any browser mock — so the SERVER-SIDE assertions, which are the
// ones that matter, are proven here as pure functions and structurally against the route source.
// The rendered-UI assertions live in scripts/e2e/verify-city-manager.mjs.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/city-manager-test.ts

import { readFileSync } from "node:fs";
import { cityManagerGate, assertCityScope } from "../src/lib/cityManagerAuth";
import { reassignImpact, cityTotalFromRows } from "../src/lib/cityManagerPayModel";
import { payAmount } from "../src/lib/managerPayCompute";
import { assertCityManagerScope } from "../src/lib/matchdayStageApi";

let PASS = 0, FAIL = 0;
const ok = (n: string) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { FAIL++; console.log(`  XX  ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const ROUTE = readFileSync("src/app/api/manager-pay/city-week/route.ts", "utf8");
const PAGE = readFileSync("src/app/(internal)/city/manager-pay/CityManagerPayClient.tsx", "utf8");

// ── GATE 1 — the tier reaches Manager Pay and NOTHING else ──
console.log("gate1 — a city manager reaches ONE route and is refused everywhere else:");
{
  // Every other gated route uses authenticateAdmin / authenticateMatchOpsRead / authenticateCrm.
  // A city-manager row satisfies NONE of them, so the refusal is structural: the tier flag is not
  // consulted anywhere except its own gate.
  for (const [name, f] of [
    ["gameday", "src/app/api/matchday/[env]/gameday/route.ts"],
    ["player lookup", "src/app/api/lookup/[env]/route.ts"],
    ["promos list", "src/app/api/promos/list/route.ts"],
    ["change log", "src/app/api/changelog/route.ts"],
    ["crm threads", "src/app/api/crm/threads/route.ts"],
  ] as const) {
    const s = readFileSync(f, "utf8");
    is(`  ${name} does NOT consult the city-manager tier (so it 403s a city manager)`,
      /is_city_manager|authenticateCityManager/.test(s), false);
  }
  // and the city gate itself refuses every non-city shape
  is("  a Match Ops operator row is refused by the city gate",
    cityManagerGate({ id: "x", can_access_matchops: true }, "op@x.com").ok, false);
  is("  an admin row is refused by the city gate (no scope to return)",
    cityManagerGate({ id: "a", is_admin: true }, "a@x.com").ok, false);
}

// ── the ADMIN BOUNCE — the page is narrowed, the GATE is not widened ──
console.log("\nadmins are bounced from the page, and the gate keeps ONE meaning:");
{
  // Strip comments first: the gate DISCUSSES is_admin (explaining why it deliberately does not
  // honour it), and an assertion that cannot tell prose from a branch would either fail on a
  // comment or have to be weakened until it proves nothing.
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const GATE = stripComments(readFileSync("src/lib/cityManagerAuth.ts", "utf8"));
  const PG = readFileSync("src/app/(internal)/city/manager-pay/page.tsx", "utf8");
  // the gate must NOT carry an is_admin exception — every future assertion would have to carry it too
  is("  the city gate has NO 'or admin' BRANCH (comments stripped)", /is_admin/.test(GATE), false);
  is("  an admin row is still refused by the gate", cityManagerGate({ id: "a", is_admin: true, can_access_matchops: true }, "a@x.com").ok, false);
  // the PAGE is what narrowed: allowed is the tier alone
  is("  the page admits the tier ALONE (no || is_admin)", /const allowed = isCityManager\(appUser\);/.test(PG), true);
  is("  an admin is sent to the admin Manager Pay screen, not a generic landing", /ADMIN_MANAGER_PAY = "\/match-ops\/manager-pay"/.test(PG), true);
  is("  and is told why, in one line", /that page covers every city/.test(PG), true);
  // the route is unchanged: it never admitted an admin either
  is("  the ROUTE was not widened to admit admins", /is_admin/.test(stripComments(ROUTE)), false);
}

// ── GATE 9 — SERVER-SIDE SCOPE. The assertion Ryan cares most about. ──
console.log("\ngate9 — a request for a match in ANOTHER city is REFUSED (not merely absent):");
is("  another city is a 403 with a reason", assertCityScope("DFW", "ATX"), { ok: false, status: 403, error: "That match is not in your city." });
is("  a spoofed ?city= is refused", assertCityScope("DFW", "atx").ok, false);
is("  own city passes", assertCityScope("DFW", "DFW").ok, true);
is("  case/whitespace do not open a hole", assertCityScope("DFW", " dfw ").ok, true);
// the route must actually CALL it, on both verbs, and must read the match's city from the DB
// rather than trusting anything the client sent
is("  the route calls assertCityScope on the GET (?city= spoof)", /assertCityScope\(auth\.cityIdentifier, url\.searchParams\.get\("city"\)\)/.test(ROUTE), true);
is("  the route re-reads the MATCH's own city before the write", /\.eq\("api_id", matchId\)/.test(ROUTE) && /assertCityScope\(auth\.cityIdentifier, \(mrow\.city_identifier/.test(ROUTE), true);
is("  a match id that is not in this city is refused, not 404'd into silence", /That match is not in your city\./.test(ROUTE), true);
// and the READ scope is pushed into the QUERY, not applied afterwards
{ const compute = readFileSync("src/lib/managerPayCompute.ts", "utf8");
  is("  the city scope is pushed INTO the mdapi_matches query", /opts\.city \? q\.eq\("city_identifier", opts\.city\)/.test(compute), true);
  is("  the route passes its OWN scope, never a param", /city: auth\.cityIdentifier/.test(ROUTE), true); }

// ── GATE 11 — the write refuses an account without the flag ──
console.log("\ngate11 — the WRITE refuses an account with no city scope:");
{
  let threw = "";
  try { assertCityManagerScope({ canEditMatches: false, email: "nobody@x.com" }); } catch (e) { threw = (e as Error).name; }
  is("  no cityScope on the actor → NotAuthorizedError, zero network calls", threw, "NotAuthorizedError");
  let threw2 = "";
  try { assertCityManagerScope({ canEditMatches: false, cityScope: "   ", email: "b@x.com" }); } catch (e) { threw2 = (e as Error).name; }
  is("  a blank scope is not a scope", threw2, "NotAuthorizedError");
  let okCase = "no-throw";
  try { assertCityManagerScope({ canEditMatches: false, cityScope: "DFW", email: "cm@x.com" }); } catch { okCase = "threw"; }
  is("  a real scope passes", okCase, "no-throw");
  // the city manager must NOT be given EDIT MATCHES to make the write work
  is("  the route's actor holds canEditMatches:false (no inherited edit grant)", /canEditMatches: false,\s+\/\/ a city manager holds NO edit-matches grant/.test(ROUTE), true);
  is("  the write names the 'city' authority", /apiWrite\(ENV, "PUT", `\/admin\/matches\/\$\{matchId\}`, \{ managerId \}, actor, "city"\)/.test(ROUTE), true);
}

// ── GATE 5 — manager rows sum to the city total ──
console.log("\ngate5 — the printed total is the sum of the rows above it:");
{
  const rows = [{ total: 60 }, { total: 40 }, { total: 20.5 }];
  is("  rows sum to the city total", cityTotalFromRows(rows), 120.5);
  is("  an empty city totals zero", cityTotalFromRows([]), 0);
}

// ── GATES 6 + 7 — the money consequence ──
console.log("\ngate6/7 — assigning raises the city total by exactly one fee; reassigning leaves it unchanged:");
{
  // fee comes from the REAL model, never a flat 20
  is("  a normal match pays $20", payAmount(18, false), 20);
  is("  a tournament (>=25) pays $30", payAmount(30, false), 30);
  is("  a co-managed match pays $20 to the primary (no tournament premium)", payAmount(30, true), 20);

  const fill = reassignImpact({ fee: 20, fromName: null, toName: "Chris Padilla", fromTotal: 0, toTotal: 30, cityTotal: 90 });
  is("  gate6a: FILLING an unassigned match raises the city total by exactly one fee",
    { kind: fill.kind, cityAfter: fill.cityTotalAfter, toAfter: fill.toTotalAfter }, { kind: "fill", cityAfter: 110, toAfter: 50 });
  is("  gate7a: the fill line names the person and both new totals",
    fill.text, "Chris Padilla is paid $20 for this match. Their total becomes $50 and the city total becomes $110.");

  const move = reassignImpact({ fee: 20, fromName: "Rooby Amilcar", toName: "Lemmy", fromTotal: 40, toTotal: 20, cityTotal: 110 });
  is("  gate6b: REASSIGNING between two people leaves the city total UNCHANGED",
    { kind: move.kind, cityAfter: move.cityTotalAfter }, { kind: "move", cityAfter: 110 });
  is("  gate7b: the move line names BOTH people and BOTH new totals",
    move.text, "$20 moves from Rooby Amilcar to Lemmy. Rooby Amilcar's total becomes $20, Lemmy's becomes $40.");

  const tourney = reassignImpact({ fee: payAmount(30, false), fromName: "A", toName: "B", fromTotal: 30, toTotal: 0, cityTotal: 100 });
  is("  a TOURNAMENT reassignment moves $30, not $20 (the flat-rate bug)", tourney.text.startsWith("$30 moves from A to B"), true);

  const remove = reassignImpact({ fee: 20, fromName: "Rooby", toName: null, fromTotal: 40, toTotal: 0, cityTotal: 110 });
  is("  gate7c: removing says the match pays nobody and drops the city total",
    { kind: remove.kind, cityAfter: remove.cityTotalAfter, text: remove.text },
    { kind: "remove", cityAfter: 90, text: "Rooby loses $20 and this match pays nobody. The city total becomes $90." });
}

// ── GATE 8 — a cancelled match cannot be assigned, for a PAY reason ──
console.log("\ngate8 — cancelled and co-managed are refused, on pay grounds not permission grounds:");
is("  the server refuses a cancelled match with a PAY reason", /This match was cancelled, so it pays nobody\./.test(ROUTE), true);
is("  the reason does not talk about permission", /cancelled[\s\S]{0,80}not allowed|no permission/i.test(ROUTE), false);
is("  the page locks the control on a cancelled match", /const locked = m\.isCancelled \|\| coManaged;/.test(PAGE), true);
is("  the server refuses a CO-MANAGED match rather than silently editing one of two", /This match has two managers\./.test(ROUTE), true);

// ── GATES 2/3/4 — structural: no city filter, no adjustment controls ──
console.log("\ngate2/3/4 — no city filter, no adjustment controls, one control in the sheet:");
is("  gate2: the page renders no city <select> and no 'All cities' string", /All cities/.test(PAGE), false);
is("  gate2b: the only <select> in the page is the sheet's manager dropdown", (PAGE.match(/<select/g) ?? []).length, 1);
is("  gate3: the sheet's one control is the manager dropdown", /data-testid="sheet-manager"/.test(PAGE), true);
is("  gate4: no add-adjustment or edit-adjustment control exists", /Add adjustment|add-adjustment|editAdjustment/i.test(PAGE), false);
is("  gate4b: the page states pay is read-only and why", /Pay figures are read-only/.test(PAGE) && /Adjustments are entered by MatchDay/.test(PAGE), true);

// ── the write is logged and never trusts a 2xx ──
console.log("\nthe write: recordWrite'd, re-read, LANDED / NOT APPLIED:");
is("  the assign goes through recordWrite", /recordWrite\(/.test(ROUTE), true);
is("  a 2xx is not proof — it re-reads and classifies", /const landed = \(\(after\?\.managerId/.test(ROUTE) && /"NOT APPLIED"/.test(ROUTE), true);
is("  the UI refuses to report success on landed:false", /j\?\.landed === false/.test(PAGE), true);

// ── the unassigned story, kept but told correctly ──
console.log("\nthe unassigned state: built, and honest at zero:");
is("  the tile says so in words at zero", /every match that will run has a manager/.test(PAGE), true);
is("  the callout only renders when something IS unassigned", /unassigned\.length > 0 && \(/.test(PAGE), true);
is("  the header leads with REASSIGNING, not filling blanks", /change who is on it when a manager cannot make it/.test(PAGE), true);
is("  the email-only join failure is stated, not silent", /We could not match your login to any manager record/.test(PAGE), true);

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
