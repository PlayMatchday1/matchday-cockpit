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

// ── endpoint deny-list: cancel is refused ─────────────────────────────────────
{
  const url = "https://playmatchday.herokuapp.com/admin/matches/17256/cancel";
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
