import "server-only"; // no-op under --conditions=react-server
// PHASE 8 STEP 1 - the two-host allowlist guard, asserted entirely OFFLINE.
// Both hosts accepted, the spoof rejected, an unlabelled call refused, a
// production write refused (bolted), a staging write still allowed. No network.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/prod-guard-test.ts

import {
  assertAllowedHost, preflightWrite, apiWrite,
  StageHostGuardError, DeniedFieldError, ProductionWriteBoltedError,
} from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const STAGE = "https://matchday-stage.herokuapp.com/admin/matches/1";
const PROD = "https://playmatchday.herokuapp.com/admin/matches/1";
const SPOOF = "https://matchday-stage.herokuapp.com.evil.com/admin/matches/1";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const throws = (n: string, Cls: new (...a: never[]) => Error, fn: () => void) => {
  try { fn(); bad(n, "did NOT throw"); }
  catch (e) { e instanceof Cls ? ok(n) : bad(n, `threw ${(e as Error).name}: ${(e as Error).message.slice(0, 70)}`); }
};
const noThrow = (n: string, fn: () => void) => { try { fn(); ok(n); } catch (e) { bad(n, `threw ${(e as Error).name}: ${(e as Error).message.slice(0, 70)}`); } };

async function main() {
  console.log("host allowlist — both hosts accepted for their own environment:");
  noThrow("staging host accepted as staging", () => assertAllowedHost("staging", STAGE));
  noThrow("production host accepted as production", () => assertAllowedHost("production", PROD));

  console.log("host allowlist — everything else rejected (exact parsed host):");
  throws("spoof '...herokuapp.com.evil.com' rejected as staging", StageHostGuardError, () => assertAllowedHost("staging", SPOOF));
  throws("spoof rejected as production too", StageHostGuardError, () => assertAllowedHost("production", SPOOF));
  throws("staging host rejected when env=production", StageHostGuardError, () => assertAllowedHost("production", STAGE));
  throws("production host rejected when env=staging", StageHostGuardError, () => assertAllowedHost("staging", PROD));
  // @ts-expect-error unlabelled / unknown environment must be refused
  throws("unlabelled environment refused", StageHostGuardError, () => assertAllowedHost("prod", PROD));

  console.log("write preflight — deny-list applies to BOTH environments:");
  throws("denied field on staging", DeniedFieldError, () => preflightWrite("staging", STAGE, { teamHomeScore: 3 }));
  throws("denied field on production", DeniedFieldError, () => preflightWrite("production", PROD, { teams: [] }));

  console.log("write preflight — the production bolt:");
  throws("production write refused (bolted)", ProductionWriteBoltedError, () => preflightWrite("production", PROD, { name: "x" }));
  noThrow("staging write still allowed (passes all gates)", () => preflightWrite("staging", STAGE, { name: "x" }));

  console.log("apiWrite('production', ...) is bolted BEFORE any network call:");
  try {
    await apiWrite("production", "PUT", "/admin/matches/1", { name: "x" });
    bad("apiWrite production did NOT throw");
  } catch (e) {
    e instanceof ProductionWriteBoltedError ? ok("apiWrite production -> ProductionWriteBoltedError (no request sent)")
      : bad("apiWrite production wrong error", `${(e as Error).name}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
