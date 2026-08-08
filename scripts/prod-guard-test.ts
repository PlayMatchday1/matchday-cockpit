import "server-only"; // no-op under --conditions=react-server
// PHASE 8 STEP 1 - the two-host allowlist guard, asserted entirely OFFLINE.
// Both hosts accepted, the spoof rejected, an unlabelled call refused, a
// production write refused (bolted), a staging write still allowed. No network.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/prod-guard-test.ts

import {
  assertAllowedHost, preflightWrite, apiWrite, assertAllowedEndpoint,
  StageHostGuardError, DeniedFieldError, ProductionWriteBoltedError, DeniedEndpointError,
} from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const STAGE = "https://matchday-stage.herokuapp.com/admin/matches/1";
const PROD = "https://playmatchday.herokuapp.com/admin/matches/1";
const SPOOF = "https://matchday-stage.herokuapp.com.evil.com/admin/matches/1";
const H = { staging: "https://matchday-stage.herokuapp.com", production: "https://playmatchday.herokuapp.com" };

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

  console.log("write preflight — field deny-list applies to BOTH environments:");
  throws("denied field on staging", DeniedFieldError, () => preflightWrite("staging", "PUT", STAGE, { teamHomeScore: 3 }));
  throws("denied field on production", DeniedFieldError, () => preflightWrite("production", "PUT", PROD, { teams: [] }));

  console.log("ENDPOINT deny-list — refused on BOTH environments, before any network:");
  for (const [env, base] of Object.entries(H)) {
    throws(`[${env}] PATCH /admin/matches/{id}/cancel refused`, DeniedEndpointError, () => preflightWrite(env as "staging" | "production", "PATCH", `${base}/admin/matches/17256/cancel`, {}));
    throws(`[${env}] DELETE /admin/matches/{id} refused`, DeniedEndpointError, () => preflightWrite(env as "staging" | "production", "DELETE", `${base}/admin/matches/17256`, undefined));
    throws(`[${env}] PATCH /admin/matches/{id}/players/{pid}/refund-and-cancel refused`, DeniedEndpointError, () => preflightWrite(env as "staging" | "production", "PATCH", `${base}/admin/matches/17256/players/5/refund-and-cancel`, {}));
  }
  console.log("endpoint deny — robust to trailing slash + query string:");
  throws("cancel with trailing slash refused", DeniedEndpointError, () => assertAllowedEndpoint("PATCH", `${H.production}/admin/matches/17256/cancel/`));
  throws("cancel with query string refused", DeniedEndpointError, () => assertAllowedEndpoint("PATCH", `${H.production}/admin/matches/17256/cancel?foo=1`));
  console.log("endpoint deny — NEAR-MISS discrimination (must NOT be caught):");
  noThrow("PATCH /admin/matches/{id}/cancel-something-else allowed", () => assertAllowedEndpoint("PATCH", `${H.production}/admin/matches/17256/cancel-something-else`));
  noThrow("PUT /admin/matches/{id} allowed (the name write)", () => assertAllowedEndpoint("PUT", `${H.production}/admin/matches/17256`));
  noThrow("DELETE /admin/matches/{id}/players/{pid} allowed (remove player)", () => assertAllowedEndpoint("DELETE", `${H.production}/admin/matches/17256/players/5`));
  noThrow("PATCH /admin/matches/{id}/user-matches/{um}/absent allowed", () => assertAllowedEndpoint("PATCH", `${H.production}/admin/matches/17256/user-matches/9/absent`));

  console.log("write preflight — production is UNBOLTED (Phase 10) but still guarded:");
  noThrow("production field write passes preflight (bolt off)", () => preflightWrite("production", "PUT", PROD, { name: "x" }));
  noThrow("staging write still allowed (passes all gates)", () => preflightWrite("staging", "PUT", STAGE, { name: "x" }));
  // ProductionWriteBoltedError type still exists (the bolt can be re-engaged).
  void ProductionWriteBoltedError;

  console.log("apiWrite to a DENIED ENDPOINT on production is refused BEFORE any network:");
  try {
    await apiWrite("production", "DELETE", "/admin/matches/1", undefined);
    bad("apiWrite production DELETE did NOT throw");
  } catch (e) {
    e instanceof DeniedEndpointError ? ok("apiWrite production DELETE /admin/matches/{id} -> DeniedEndpointError (no request sent)")
      : bad("apiWrite production DELETE wrong error", `${(e as Error).name}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
