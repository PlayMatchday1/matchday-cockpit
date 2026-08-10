import "server-only"; // no-op under --conditions=react-server
// PHASE 8 STEP 1 - the two-host allowlist guard, asserted entirely OFFLINE.
// Both hosts accepted, the spoof rejected, an unlabelled call refused, a
// production write refused (bolted), a staging write still allowed. No network.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/prod-guard-test.ts

import {
  assertAllowedHost, preflightWrite, apiWrite, assertAllowedEndpoint, assertCanEditMatches, assertCanManagePlayers, assertCanManagePromos,
  StageHostGuardError, DeniedFieldError, ProductionWriteBoltedError, DeniedEndpointError, NotAuthorizedError,
  CLI_WRITE_ACTOR, __setEditGuardForTest, __setManageGuardForTest, __setPromoGuardForTest, type WriteActor,
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

  console.log("apiWrite to a DENIED ENDPOINT on production is refused BEFORE any network (EDIT-MATCHES holder):");
  try {
    await apiWrite("production", "DELETE", "/admin/matches/1", undefined, CLI_WRITE_ACTOR);
    bad("apiWrite production DELETE did NOT throw");
  } catch (e) {
    e instanceof DeniedEndpointError ? ok("apiWrite production DELETE /admin/matches/{id} -> DeniedEndpointError (no request sent)")
      : bad("apiWrite production DELETE wrong error", `${(e as Error).name}`);
  }

  // ── PHASE 17: the EDIT MATCHES check — step 2, BEFORE the host guard, zero network ──
  console.log("EDIT MATCHES check (Phase 17) — before the host guard, produces ZERO network calls:");
  throws("assertCanEditMatches refuses undefined actor", NotAuthorizedError, () => assertCanEditMatches(undefined));
  throws("assertCanEditMatches refuses a read-only actor", NotAuthorizedError, () => assertCanEditMatches({ canEditMatches: false } as WriteActor));
  noThrow("assertCanEditMatches allows an EDIT MATCHES holder", () => assertCanEditMatches({ canEditMatches: true }));

  // Spy the global fetch that matchdayStageApi uses, and prove a read-only actor makes
  // NO outbound call — asserted by the spy, not the response status.
  const realFetch = globalThis.fetch;
  const noFetchTest = async (actor: WriteActor | undefined): Promise<{ threwNA: boolean; fetches: number }> => {
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; throw new Error("network must not be reached"); }) as typeof fetch;
    let threwNA = false;
    try { await apiWrite("staging", "PUT", "/admin/teams/1", { name: "x" }, actor); }
    catch (e) { threwNA = e instanceof NotAuthorizedError; }
    finally { globalThis.fetch = realFetch; }
    return { threwNA, fetches };
  };
  { const r = await noFetchTest({ canEditMatches: false });
    (r.threwNA && r.fetches === 0) ? ok("read-only actor -> NotAuthorizedError and ZERO fetches (spied)") : bad("no-fetch test", JSON.stringify(r)); }
  // The check is BEFORE the host guard: a SPOOF host + read-only actor still yields the
  // permission error, not a host-guard error.
  { let name = ""; try { await apiWrite("staging", "PUT", "/admin/teams/1", { name: "x" }, undefined); } catch (e) { name = (e as Error).name; }
    name === "NotAuthorizedError" ? ok("EDIT MATCHES check runs BEFORE the host/bolt guards") : bad("order", `first error was ${name}`); }
  // Independent of the bolt: on STAGING (bolt N/A) a read-only actor is still refused —
  // the two gates are separate mechanisms (per-user grant vs global constant).
  { let na = false; try { await apiWrite("staging", "POST", "/admin/user-matches", { userMatchId: 1 }, { canEditMatches: false }); } catch (e) { na = e instanceof NotAuthorizedError; }
    na ? ok("EDIT MATCHES is independent of PRODUCTION_WRITES_ENABLED (enforced on staging too)") : bad("independence"); }

  // ── THE MUTATION: remove the guard -> the no-fetch test goes RED ──
  console.log("MUTATION — monkeypatch the EDIT MATCHES guard to a no-op:");
  const restore = __setEditGuardForTest(() => { /* guard removed */ });
  const mutated = await noFetchTest({ canEditMatches: false });
  restore();
  (!(mutated.threwNA && mutated.fetches === 0))
    ? ok(`guard removed => the no-fetch test goes RED (threwNotAuthorized=${mutated.threwNA}, fetches=${mutated.fetches})`)
    : bad("MUTATION toothless — removing the guard left the no-fetch test green");
  // and confirm the guard is back
  { const r = await noFetchTest({ canEditMatches: false }); (r.threwNA && r.fetches === 0) ? ok("guard restored after the mutation") : bad("guard not restored", JSON.stringify(r)); }

  // ── PHASE 18: MANAGE PLAYERS — a SEPARATE authority (ban writes), same machinery ──
  console.log("MANAGE PLAYERS check (Phase 18) — the ban authority, INDEPENDENT of EDIT MATCHES:");
  throws("assertCanManagePlayers refuses undefined actor", NotAuthorizedError, () => assertCanManagePlayers(undefined));
  throws("assertCanManagePlayers refuses a non-manager", NotAuthorizedError, () => assertCanManagePlayers({ canEditMatches: true, canManagePlayers: false } as WriteActor));
  noThrow("assertCanManagePlayers allows a MANAGE PLAYERS holder", () => assertCanManagePlayers({ canEditMatches: false, canManagePlayers: true }));

  // no-fetch test on the MANAGE path: apiWrite(..., "manage") checks manageGuard.
  const noFetchManage = async (actor: WriteActor | undefined): Promise<{ threwNA: boolean; fetches: number }> => {
    let fetches = 0; const rf = globalThis.fetch;
    globalThis.fetch = (async () => { fetches++; throw new Error("network must not be reached"); }) as typeof fetch;
    let threwNA = false;
    try { await apiWrite("staging", "POST", "/admin/players/1/ban", { permanent: true, reason: "x" }, actor, "manage"); }
    catch (e) { threwNA = e instanceof NotAuthorizedError; }
    finally { globalThis.fetch = rf; }
    return { threwNA, fetches };
  };
  { const r = await noFetchManage({ canEditMatches: true, canManagePlayers: false });
    (r.threwNA && r.fetches === 0) ? ok("non-manager -> NotAuthorized and ZERO fetches on the ban path (spied)") : bad("manage no-fetch", JSON.stringify(r)); }

  // INDEPENDENCE — holding one authority never satisfies the other:
  { let na = false; try { await apiWrite("staging", "POST", "/admin/players/1/ban", {}, { canEditMatches: true, canManagePlayers: false }, "manage"); } catch (e) { na = e instanceof NotAuthorizedError; }
    na ? ok("EDIT MATCHES does NOT grant MANAGE PLAYERS (independent)") : bad("independence: edit leaked into manage"); }
  { let na = false; try { await apiWrite("staging", "PUT", "/admin/teams/1", { name: "x" }, { canEditMatches: false, canManagePlayers: true }, "edit"); } catch (e) { na = e instanceof NotAuthorizedError; }
    na ? ok("MANAGE PLAYERS does NOT grant EDIT MATCHES (independent)") : bad("independence: manage leaked into edit"); }

  // THE MUTATION: remove the manage guard -> the ban no-fetch test goes RED.
  console.log("MUTATION — monkeypatch the MANAGE PLAYERS guard to a no-op:");
  const restoreM = __setManageGuardForTest(() => { /* guard removed */ });
  const mutatedM = await noFetchManage({ canEditMatches: false, canManagePlayers: false });
  restoreM();
  (!(mutatedM.threwNA && mutatedM.fetches === 0))
    ? ok(`manage guard removed => ban no-fetch test goes RED (threwNotAuthorized=${mutatedM.threwNA}, fetches=${mutatedM.fetches})`)
    : bad("MANAGE mutation toothless — removing the guard left the no-fetch test green");
  { const r = await noFetchManage({ canManagePlayers: false }); (r.threwNA && r.fetches === 0) ? ok("manage guard restored after the mutation") : bad("manage guard not restored", JSON.stringify(r)); }

  // ── PHASE 18b: MANAGE PROMOS — a THIRD authority (promo writes), same machinery ──
  console.log("MANAGE PROMOS check (Phase 18b) — the promo authority, INDEPENDENT of the other two:");
  throws("assertCanManagePromos refuses undefined actor", NotAuthorizedError, () => assertCanManagePromos(undefined));
  throws("assertCanManagePromos refuses a non-holder", NotAuthorizedError, () => assertCanManagePromos({ canEditMatches: true, canManagePlayers: true, canManagePromos: false } as WriteActor));
  noThrow("assertCanManagePromos allows a MANAGE PROMOS holder", () => assertCanManagePromos({ canEditMatches: false, canManagePromos: true }));

  // no-fetch test on the PROMOS path: apiWrite(..., "promos") checks promoGuard.
  const noFetchPromo = async (actor: WriteActor | undefined): Promise<{ threwNA: boolean; fetches: number }> => {
    let fetches = 0; const rf = globalThis.fetch;
    globalThis.fetch = (async () => { fetches++; throw new Error("network must not be reached"); }) as typeof fetch;
    let threwNA = false;
    try { await apiWrite("staging", "POST", "/admin/promocodes", { code: "x" }, actor, "promos"); }
    catch (e) { threwNA = e instanceof NotAuthorizedError; }
    finally { globalThis.fetch = rf; }
    return { threwNA, fetches };
  };
  { const r = await noFetchPromo({ canEditMatches: true, canManagePlayers: true, canManagePromos: false });
    (r.threwNA && r.fetches === 0) ? ok("non-holder -> NotAuthorized and ZERO fetches on the promo path (spied)") : bad("promo no-fetch", JSON.stringify(r)); }

  // INDEPENDENCE — the other two authorities never satisfy MANAGE PROMOS, and vice versa:
  { let na = false; try { await apiWrite("staging", "POST", "/admin/promocodes", {}, { canEditMatches: true, canManagePlayers: true }, "promos"); } catch (e) { na = e instanceof NotAuthorizedError; }
    na ? ok("EDIT MATCHES + MANAGE PLAYERS do NOT grant MANAGE PROMOS (independent)") : bad("independence: other grants leaked into promos"); }
  { let na = false; try { await apiWrite("staging", "POST", "/admin/players/1/ban", {}, { canEditMatches: false, canManagePromos: true }, "manage"); } catch (e) { na = e instanceof NotAuthorizedError; }
    na ? ok("MANAGE PROMOS does NOT grant MANAGE PLAYERS (independent)") : bad("independence: promos leaked into manage"); }

  // THE MUTATION: remove the promo guard -> the promo no-fetch test goes RED.
  console.log("MUTATION — monkeypatch the MANAGE PROMOS guard to a no-op:");
  const restoreP = __setPromoGuardForTest(() => { /* guard removed */ });
  const mutatedP = await noFetchPromo({ canEditMatches: false, canManagePromos: false });
  restoreP();
  (!(mutatedP.threwNA && mutatedP.fetches === 0))
    ? ok(`promo guard removed => promo no-fetch test goes RED (threwNotAuthorized=${mutatedP.threwNA}, fetches=${mutatedP.fetches})`)
    : bad("PROMO mutation toothless — removing the guard left the no-fetch test green");
  { const r = await noFetchPromo({ canManagePromos: false }); (r.threwNA && r.fetches === 0) ? ok("promo guard restored after the mutation") : bad("promo guard not restored", JSON.stringify(r)); }

  // Phase 12: the same machinery must cover a NON-match endpoint (PUT /admin/teams/{id}),
  // not have been shaped around /admin/matches/{id}.
  console.log("guards GENERALIZE to /admin/teams/{id} (a non-match endpoint):");
  const TEAM_S = "https://matchday-stage.herokuapp.com/admin/teams/3122";
  const TEAM_P = "https://playmatchday.herokuapp.com/admin/teams/3122";
  noThrow("host allowlist: staging teams URL accepted as staging", () => assertAllowedHost("staging", TEAM_S));
  throws("host allowlist: staging teams URL rejected as production", StageHostGuardError, () => assertAllowedHost("production", TEAM_S));
  throws("host allowlist: spoof teams host rejected", StageHostGuardError, () => assertAllowedHost("staging", "https://matchday-stage.herokuapp.com.evil.com/admin/teams/1"));
  noThrow("field deny-list RUNS on a team body (allowed field passes)", () => preflightWrite("staging", "PUT", TEAM_S, { name: "x", locked: true, price: 100 }));
  throws("field deny-list RUNS on a team body (denied field rejected)", DeniedFieldError, () => preflightWrite("staging", "PUT", TEAM_S, { teamHomeScore: 3 }));
  noThrow("endpoint deny-list does NOT block PUT /admin/teams/{id}", () => assertAllowedEndpoint("PUT", TEAM_P));
  noThrow("endpoint deny-list does not spuriously match /admin/teams/{id}/cancel", () => assertAllowedEndpoint("PATCH", TEAM_P + "/cancel"));
  // Phase 13: the remove path is DELETE /admin/matches/user-matches/{umId} — one
  // segment longer than the deny-listed DELETE /admin/matches/{id}. Prove the
  // matcher discriminates rather than happening to.
  noThrow("remove path DELETE /admin/matches/user-matches/{umId} is ALLOWED", () => assertAllowedEndpoint("DELETE", H.production + "/admin/matches/user-matches/291788"));
  throws("match-delete DELETE /admin/matches/{id} is REFUSED", DeniedEndpointError, () => assertAllowedEndpoint("DELETE", H.production + "/admin/matches/17371"));
  noThrow("teams write passes full preflight on staging (env named per call)", () => preflightWrite("staging", "PUT", TEAM_S, { name: "x" }));
  // env named per call: an unlabelled env is refused for a teams URL too
  // @ts-expect-error unlabelled environment
  throws("unlabelled env refused for teams URL", StageHostGuardError, () => assertAllowedHost("prod", TEAM_P));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
