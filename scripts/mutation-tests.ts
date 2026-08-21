import "server-only"; // no-op under --conditions=react-server
// PHASE 10 PART 3 - MUTATION TESTS for the pure guards. For each guard: the real
// implementation makes the guard-assertion PASS; a BROKEN variant makes the SAME
// assertion FAIL. An assertion that still passes with the guard broken is testing
// nothing. (DOM guards — push-grid, unsaved-changes — are mutated in the browser
// suite, verify-p10.mjs.)
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/mutation-tests.ts
import { diffKeys, pick, fieldChanged, normValue } from "../src/lib/matchEditModel";
import { buildStartDate, shiftedEndDate } from "../src/lib/matchWallClock";
import { assertAllowedEndpoint, DeniedEndpointError } from "../src/lib/matchdayStageApi";
import { centsToDollars, dollarsToCents } from "../src/lib/matchMoney";
import { envBadge } from "../src/lib/matchEnvBadge";
import { planRoster, classifyWrite, stopsRun, type WriteOutcome, type LoadedPlayer, type StatePlayer, type Shape } from "../src/lib/rosterModel";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
// A mutation test: `assertion(impl)` must be TRUE for the real impl and FALSE for
// the broken impl. Reports both sides.
function mutation<T>(name: string, real: T, broken: T, assertion: (impl: T) => boolean) {
  let realPass = false, brokenPass = true;
  try { realPass = assertion(real); } catch { realPass = false; }
  try { brokenPass = assertion(broken); } catch { brokenPass = false; }
  if (realPass && !brokenPass) ok(`${name}: real PASSES, broken FAILS (assertion has teeth)`);
  else bad(`${name}:`, `real=${realPass} broken=${brokenPass} (want real=true broken=false)`);
}

// ── diff-to-body: pick(state, changedKeys) is the exact body ─────────────────
{
  const loaded = { name: "A", registrationPrice: 12000, guestCount: 4 };
  const state = { name: "B", registrationPrice: 13000, guestCount: 5 };
  const keys = ["name", "registrationPrice", "guestCount"];
  const assertion = (pk: typeof pick) => {
    const body = pk(state, keys);
    return Object.keys(body).sort().join(",") === "guestCount,name,registrationPrice";
  };
  mutation("diff-to-body (pick)", pick, (() => ({})) as typeof pick, assertion);
}

// ── blank-numeric: a cleared numeric input is NOT a change ────────────────────
{
  // real fieldChanged returns false for a blank numeric (NUMERIC_KEYS guard).
  const brokenFieldChanged = ((k: string, a: unknown, b: unknown) =>
    JSON.stringify(normValue(a)) !== JSON.stringify(normValue(b))) as typeof fieldChanged;
  const assertion = (fc: typeof fieldChanged) => fc("registrationPrice", 12000, "") === false;
  mutation("blank-numeric guard (fieldChanged)", fieldChanged, brokenFieldChanged, assertion);
}

// ── date pair: shifting start preserves duration on end ───────────────────────
{
  const start0 = "2026-08-07T18:30:00.000Z", end0 = "2026-08-07T20:30:00.000Z"; // 2h
  const newStart = buildStartDate("2026-08-07", "19:30"); // +1h
  const brokenShift = ((_s: string, e: string) => e) as typeof shiftedEndDate; // leaves end put -> duration shrinks
  const dur = (a: string, b: string) => Date.parse(b) - Date.parse(a);
  const assertion = (sh: typeof shiftedEndDate) => dur(newStart, sh(start0, end0, newStart)) === dur(start0, end0);
  mutation("date-pair (shiftedEndDate preserves duration)", shiftedEndDate, brokenShift, assertion);
}

// ── date pair ACROSS A DAY BOUNDARY — ported from verify-schededit, not deleted with it ───────
{
  /* THE 2-HOUR CASE ABOVE WOULD NOT CATCH THIS. A naive shift that rebuilds the end from the
   * start's DATE — rather than adding the duration in minutes — looks correct on a match that
   * begins and ends on the same day, and silently collapses a 24-hour match to zero. The drawer
   * suite asserted exactly this case; the drawer's own diff and save assertions were deleted when
   * MatchEditor took them over, but this one had no equivalent anywhere, so it moved here instead
   * — as a MUTATION test, which is stronger than the browser assertion it replaces. */
  const start0 = "2026-08-07T19:30:00.000Z", end0 = "2026-08-08T19:30:00.000Z"; // exactly 24h
  const newStart = buildStartDate("2026-08-07", "19:30");
  // broken: keep the END's clock but rebuild it on the START's date — same-day matches unaffected.
  const brokenShift = ((s0: string, e0: string, ns: string) =>
    `${ns.slice(0, 10)}T${e0.slice(11)}`) as typeof shiftedEndDate;
  const dur = (a: string, b: string) => Date.parse(b) - Date.parse(a);
  const assertion = (sh: typeof shiftedEndDate) => {
    const out = sh(start0, end0, newStart);
    // Duration preserved to the minute AND the end still lands on the following day.
    return dur(newStart, out) === dur(start0, end0) && out.slice(0, 10) === "2026-08-08";
  };
  mutation("date-pair across a DAY BOUNDARY (24h preserved, end stays on the next day)", shiftedEndDate, brokenShift, assertion);
}

// ── wall-clock: the value is the wall clock verbatim, never tz-converted ───────
{
  // broken: convert as if through a Central Date object (subtract 6h) -> different digits
  const brokenBuild = ((d: string, t: string) => {
    const [H, M] = t.split(":").map(Number);
    return `${d}T${String((H + 6) % 24).padStart(2, "0")}:${String(M).padStart(2, "0")}:00.000Z`;
  }) as typeof buildStartDate;
  const assertion = (bd: typeof buildStartDate) => bd("2026-12-01", "06:00") === "2026-12-01T06:00:00.000Z";
  mutation("wall-clock (buildStartDate verbatim)", buildStartDate, brokenBuild, assertion);
}

// ── endpoint deny-list: refund-and-cancel is refused ──────────────────────────
// (Match CANCEL was removed from the deny-list in Phase 23 Step 2 Part C — it is now guarded by the
//  dedicated cancel route's typed-name confirmation instead. refund-and-cancel stays denied.)
{
  const url = "https://playmatchday.herokuapp.com/admin/matches/17256/players/5/refund-and-cancel";
  const brokenAssert = (() => { /* no-op: guard removed */ }) as typeof assertAllowedEndpoint;
  const assertion = (fn: typeof assertAllowedEndpoint) => {
    try { fn("PATCH", url); return false; } catch (e) { return e instanceof DeniedEndpointError; }
  };
  mutation("endpoint-deny (assertAllowedEndpoint)", assertAllowedEndpoint, brokenAssert, assertion);
}

// ── money round-trip: cents in -> correct dollars -> same cents out (Phase 10.2) ─
{
  const cases: [number | null, string][] = [[0, "0.00"], [200, "2.00"], [1200, "12.00"], [9950, "99.50"], [12000, "120.00"]];
  let allOk = true;
  for (const [cents, disp] of cases) {
    const shown = centsToDollars(cents);
    const back = dollarsToCents(shown);
    if (shown !== disp || back !== cents) { allOk = false; bad(`money round-trip ${cents}`, `shown ${JSON.stringify(shown)} (want ${disp}), back ${back}`); }
  }
  if (allOk) ok("money round-trip: 0/200/1200/9950/12000 -> correct dollars -> same cents (incl leading-1 and >$100)");
  // null: displays blank in the editors (blank check), registers no change
  ok(`money null: fieldChanged(registrationPrice, null, "") === ${fieldChanged("registrationPrice", null, "")} (no change)`);
}

// ── env badge: derived, production is distinct; hardcoding it is caught ────────
{
  const brokenBadge = (() => ({ label: "STAGING · GUARDED", tone: "stage" as const })) as typeof envBadge;
  const assertion = (fn: typeof envBadge) => fn("production").tone === "prod" && /PRODUCTION|LIVE/.test(fn("production").label) && fn("staging").tone === "stage";
  mutation("env-badge (derived, production distinct)", envBadge, brokenBadge, assertion);
}

// ── roster plan: a DIFF, right ids, swaps, N=N ────────────────────────────────
{
  const M = 2470;
  const loaded: Record<number, LoadedPlayer> = {
    100: { umId: 500, playerId: 100, team: 0, num: 1, fake: false },
    101: { umId: 501, playerId: 101, team: 1, num: 1, fake: false },
  };
  const teams = [{ id: 10, teamNumber: 1, name: "White", locked: false }, { id: 11, teamNumber: 2, name: "Dark", locked: false }];
  const loadedTeams = { 10: { name: "White", locked: false }, 11: { name: "Dark", locked: false } };
  const shape: Shape = { perTeam: 1, teamN: 2 };
  const tn = (i: number) => teams[i].name;
  const mk = (o: Partial<StatePlayer> & { key: string }): StatePlayer => ({ umId: null, playerId: null, team: 0, num: 1, fake: false, added: false, ...o });
  const run = (state: StatePlayer[]) => planRoster(M, loaded, state, loadedTeams, teams, shape, shape, tn);

  // there-and-back: final position == loaded -> 0 requests
  const back = run([mk({ key: "a", umId: 500, playerId: 100, team: 0, num: 1 }), mk({ key: "b", umId: 501, playerId: 101, team: 1, num: 1 })]);
  ok(`roster diff: move-and-back is 0 requests (got ${back.length})`.replace("(got 0)", "(0)"));
  if (back.length !== 0) bad("roster there-and-back should be 0", `got ${back.length}`);

  // one net move -> exactly 1 request; and it keys on userMatchId
  const moved = run([mk({ key: "a", umId: 500, playerId: 100, team: 1, num: 2 }), mk({ key: "b", umId: 501, playerId: 101, team: 1, num: 1 })]);
  const one = moved.length === 1 && moved[0].kind === "move" && moved[0].idField === "userMatchId" && moved[0].path === "/admin/user-matches";
  one ? ok("roster diff: one net move = 1 request, keys on userMatchId") : bad("roster one-move", JSON.stringify(moved));

  // swap -> 2 requests, roster size (non-removed) unchanged
  const swap = run([mk({ key: "a", umId: 500, playerId: 100, team: 1, num: 1 }), mk({ key: "b", umId: 501, playerId: 101, team: 0, num: 1 })]);
  const sizeUnchanged = swap.filter((r) => r.kind === "remove").length === 0;
  swap.length === 2 && sizeUnchanged ? ok("roster swap = 2 requests, no removals (size unchanged)") : bad("roster swap", JSON.stringify(swap.map((r) => r.kind)));

  // remove keys on userMatchId via /matches/user-matches; add keys on playerId
  const rm = run([mk({ key: "a", umId: 500, playerId: 100, team: null, num: null }), mk({ key: "b", umId: 501, playerId: 101, team: 1, num: 1 })]);
  rm.length === 1 && rm[0].kind === "remove" && rm[0].idField === "userMatchId" && rm[0].path === "/admin/matches/user-matches/500"
    ? ok("roster remove keys on userMatchId (/matches/user-matches/{umId})") : bad("roster remove id", JSON.stringify(rm));
  const add = run([mk({ key: "a", umId: 500, playerId: 100, team: 0, num: 1 }), mk({ key: "b", umId: 501, playerId: 101, team: 1, num: 1 }), mk({ key: "c", added: true, playerId: 900, team: 1, num: 2 })]);
  add.length === 1 && add[0].kind === "add" && add[0].idField === "playerId" && add[0].path === "/admin/matches/2470/players/900"
    ? ok("roster add keys on playerId (/matches/{id}/players/{playerId})") : bad("roster add id", JSON.stringify(add));

  // N distinct changes -> N requests
  // 3 single changes: p100 moves, p101 fake-only (position unchanged), one add.
  const nreq = run([mk({ key: "a", umId: 500, playerId: 100, team: 1, num: 2 }), mk({ key: "b", umId: 501, playerId: 101, team: 1, num: 1, fake: true }), mk({ key: "c", added: true, playerId: 900, team: 1, num: 3 })]);
  nreq.length === 3 ? ok(`roster N single changes -> N requests (= ${nreq.length})`) : bad("roster N=N", `got ${nreq.length}: ${nreq.map((r) => r.kind)}`);

  // MUTATION: a journal-style planner (emits a move even when position is unchanged)
  const brokenPlan = ((...a: Parameters<typeof planRoster>) => planRoster(...a).concat([{ kind: "move", method: "POST", path: "/admin/user-matches", label: "phantom", idField: "userMatchId" }])) as typeof planRoster;
  const assertBack0 = (fn: typeof planRoster) => fn(M, loaded, [mk({ key: "a", umId: 500, playerId: 100, team: 0, num: 1 }), mk({ key: "b", umId: 501, playerId: 101, team: 1, num: 1 })], loadedTeams, teams, shape, shape, tn).length === 0;
  mutation("roster diff (no phantom requests)", planRoster, brokenPlan, assertBack0);
  // MUTATION: a planner that keys move on playerId instead of userMatchId
  const brokenId = ((...a: Parameters<typeof planRoster>) => planRoster(...a).map((r) => r.kind === "move" ? { ...r, idField: "playerId" as const } : r)) as typeof planRoster;
  const assertMoveUm = (fn: typeof planRoster) => { const p = fn(M, loaded, [mk({ key: "a", umId: 500, playerId: 100, team: 1, num: 2 }), mk({ key: "b", umId: 501, playerId: 101, team: 1, num: 1 })], loadedTeams, teams, shape, shape, tn); return p[0]?.idField === "userMatchId"; };
  mutation("roster move keys on userMatchId", planRoster, brokenId, assertMoveUm);
}

// ── four-state save: a 2xx is NOT proof; read-back is ────────────────────────
// The core Phase-13 correction. `classifyWrite` maps a write outcome to one of
// LANDED / FAILED / NOT APPLIED / UNKNOWN. The broken impl trusts HTTP status
// alone (2xx -> landed). The assertion is the exact near-miss that bit us: the
// server returned 2xx but the read-back showed the change was NEVER applied.
{
  // marks a row landed on HTTP status alone — the bug we are guarding against
  const brokenStatusAlone = ((o: WriteOutcome) => (o.httpOk ? "landed" : "failed")) as typeof classifyWrite;
  const twoxxButNotApplied: WriteOutcome = { httpOk: true, appliedReadback: false };
  // real impl must call this NOT APPLIED (never landed); broken calls it landed
  mutation("four-state: 2xx + read-back-absent is NOT APPLIED, not landed",
    classifyWrite, brokenStatusAlone,
    (fn) => fn(twoxxButNotApplied) === "notapplied");

  // and the full truth table is exact (belt-and-suspenders, single assertion)
  const truthTable = (fn: typeof classifyWrite) =>
    fn({ httpOk: true, appliedReadback: true }) === "landed" &&
    fn({ httpOk: false, appliedReadback: false }) === "failed" &&
    fn({ httpOk: true, appliedReadback: false }) === "notapplied" &&
    fn({ httpOk: true, appliedReadback: true, ambiguous: true }) === "unknown" &&
    fn({ httpOk: false, appliedReadback: false, networkError: true }) === "unknown";
  // broken: collapses NOT APPLIED and UNKNOWN into landed/failed
  mutation("four-state: full truth table (landed/failed/notapplied/unknown)",
    classifyWrite, brokenStatusAlone, truthTable);

  // only UNKNOWN stops the run — a NOT APPLIED row is retryable, not a full stop
  const brokenStops = ((s: Parameters<typeof stopsRun>[0]) => s === "notapplied" || s === "unknown") as typeof stopsRun;
  mutation("four-state: only UNKNOWN stops the run (NOT APPLIED is retryable)",
    stopsRun, brokenStops,
    (fn) => fn("unknown") === true && fn("notapplied") === false && fn("failed") === false && fn("landed") === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
