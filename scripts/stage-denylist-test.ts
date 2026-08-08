import "server-only"; // no-op under --conditions=react-server
import { assertNoDeniedFields, stageWrite, DeniedFieldError } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}
const DENIED = ["teams", "teamHomeId", "teamAwayId", "teamHomeScore", "teamAwayScore", "startDate", "endDate"];
const ALLOWED = ["maxPlayerCount", "hasOrganizer"];
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
  console.log("stageWrite blocks a denied body BEFORE the network call:");
  try { await stageWrite("PUT", "/admin/matches/2470", { startDate: "2026-01-01T00:00:00Z" }); console.log("  XX stageWrite did not throw"); fail++; }
  catch (e) { if (e instanceof DeniedFieldError) { console.log("  ok stageWrite threw DeniedFieldError (no request sent)"); pass++; } else { console.log(`  XX wrong: ${(e as Error).name}: ${(e as Error).message.slice(0, 60)}`); fail++; } }
  console.log(`\n${pass} passed, ${fail} failed (7 denied + 2 allowed + 1 wired)`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
