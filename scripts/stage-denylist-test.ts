import "server-only"; // no-op under --conditions=react-server
import { assertNoDeniedFields, stageWrite, apiWrite, DeniedFieldError, CLI_WRITE_ACTOR } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}
// PHASE 7: startDate/endDate came OFF (the drawer owns the date pair).
// PHASE 13: `password` added — write-only on teams, undetectable/unrestorable.
const DENIED = ["teams", "teamHomeId", "teamAwayId", "teamHomeScore", "teamAwayScore", "password"];
const ALLOWED = ["maxPlayerCount", "hasOrganizer", "startDate", "endDate", "name", "locked", "price"];
async function main() {
  let pass = 0, fail = 0;
  console.log("DENIED keys must throw before any network:");
  for (const k of DENIED) {
    try { assertNoDeniedFields({ [k]: "x" }); console.log(`  XX ${k} did NOT throw`); fail++; }
    catch (e) { const m = (e as Error).message; if (e instanceof DeniedFieldError && m.includes(`"${k}"`)) { console.log(`  ok ${k} -> DeniedFieldError`); pass++; } else { console.log(`  XX ${k} wrong: ${m.slice(0, 60)}`); fail++; } }
  }
  console.log("ALLOWED (not on deny-list) must pass:");
  for (const k of ALLOWED) {
    try { assertNoDeniedFields({ [k]: 1 }); console.log(`  ok ${k} allowed`); pass++; }
    catch (e) { console.log(`  XX ${k} should not throw: ${(e as Error).message.slice(0, 60)}`); fail++; }
  }
  console.log("a password write is refused BEFORE the network call, on BOTH environments:");
  for (const env of ["staging", "production"] as const) {
    try { await apiWrite(env, "PUT", "/admin/teams/1", { password: "x" }, CLI_WRITE_ACTOR); console.log(`  XX ${env} password write did not throw`); fail++; }
    catch (e) { if (e instanceof DeniedFieldError) { console.log(`  ok ${env}: password -> DeniedFieldError (no request sent)`); pass++; } else { console.log(`  XX ${env} wrong: ${(e as Error).name}`); fail++; } }
  }
  console.log("stageWrite blocks a denied body BEFORE the network call:");
  try { await stageWrite("PUT", "/admin/matches/2470", { teamHomeScore: 3 }, CLI_WRITE_ACTOR); console.log("  XX stageWrite did not throw"); fail++; }
  catch (e) { if (e instanceof DeniedFieldError) { console.log("  ok stageWrite threw DeniedFieldError (no request sent)"); pass++; } else { console.log(`  XX wrong: ${(e as Error).name}: ${(e as Error).message.slice(0, 60)}`); fail++; } }
  console.log(`\n${pass} passed, ${fail} failed (6 denied + 7 allowed + 2 password-both-envs + 1 wired)`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
