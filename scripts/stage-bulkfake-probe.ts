import "server-only";
/* DOES POST /admin/matches/{id}/batch/fake-players {totalFakes} SET THE TOTAL, OR ONLY ADD?
 *
 * MatchPanel.tsx:266 says "one call sets the match's fake count". There is NO PROBE BEHIND THAT
 * LINE. The button beside it reads "Add fakes", its toast says "N fake players added", and the
 * roster route's own landed-check for this op is `plOf(a).length > plOf(b).length` — a test that
 * only a GROWING roster can pass. Those three disagree with the comment, so the comment is UNKNOWN.
 *
 * The discriminating step is a call with a total BELOW the current count. SET takes the roster
 * down to it; ADD takes it up by it; anything else is a third behaviour worth naming.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-bulkfake-probe.ts
 */
import { apiGet, apiWrite } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const M = Number(process.env.PROBE_MATCH || 2470);
type Row = { id: number; userId: number; team: number; playerNumber: number; user?: { isFakePlayer?: boolean } };
const roster = async (): Promise<Row[]> => {
  const r = await apiGet<Row[] | { data?: Row[] }>("staging", `/admin/matches/${M}/players`);
  return Array.isArray(r) ? r : (r.data ?? []);
};
const isFake = (r: Row) => r.user?.isFakePlayer === true;
const fakes = (rs: Row[]) => rs.filter(isFake);
const reals = (rs: Row[]) => rs.filter((r) => !isFake(r));
const shape = (rs: Row[]) => `${rs.length} rows = ${fakes(rs).length} fake + ${reals(rs).length} real` +
  `  fake teams ${JSON.stringify(fakes(rs).reduce<Record<number, number>>((a, r) => (a[r.team] = (a[r.team] ?? 0) + 1, a), {}))}`;
/* THE ACTOR IS REQUIRED AND IS NOT A FORMALITY — apiWrite refuses without EDIT MATCHES before it
 * sends anything. STAGING ONLY: this probe never names production, and apiWrite's own bolt would
 * refuse it if it did. */
const ACTOR = { canEditMatches: true, email: "probe@stage-bulkfake", userId: "probe" };
/* THE DELETE IS NOT SWALLOWED. A `.catch(() => {})` here is how "cleared -> 0 rows" gets printed
 * for a match that was never cleared: every delete throws, nothing is logged, and the count is
 * whatever it already was. Failures are counted and reported. */
let rmFail = 0;
const rm = async (umId: number) => {
  try { await apiWrite("staging", "DELETE", `/admin/matches/user-matches/${umId}`, undefined, ACTOR); }
  catch (e) { rmFail++; console.log(`    DELETE um${umId} FAILED: ${e instanceof Error ? e.message : String(e)}`); }
};
const bulk = (n: number) => apiWrite("staging", "POST", `/admin/matches/${M}/batch/fake-players`, { totalFakes: n }, ACTOR);

const tryBulk = async (n: number): Promise<string> => {
  try { await bulk(n); return "2xx"; }
  catch (e) { const m = e instanceof Error ? e.message : String(e);
    return "THREW " + (m.match(/HTTP \d+[^:]*: ?(.*)$/s)?.[1] ?? m).slice(0, 160); }
};

async function main() {
  const m0 = await apiGet<Record<string, unknown>>("staging", `/admin/matches/${M}`);
  const CAP = Number(m0.maxPlayerCount);
  console.log(`match ${M}  cap=${CAP}  start=${m0.startDate}  rungs=` +
    JSON.stringify([36, 24, 12, 6, 3].map((h) => m0[`fakeSpotLeft${h}h`])));

  for (const r of await roster()) await rm(r.id);
  console.log(`cleared -> ${shape(await roster())}   (delete failures: ${rmFail})\n`);

  console.log("STEP 1  bulk 6 onto an empty roster");
  console.log(`  ${await tryBulk(6)}  -> ${shape(await roster())}`);

  console.log("\nSTEP 2  bulk 6 AGAIN. SET holds at 6; ADD wants 12 against a capacity of " + CAP);
  console.log(`  ${await tryBulk(6)}  -> ${shape(await roster())}`);

  console.log("\nSTEP 3  THE DISCRIMINATOR - bulk 2, BELOW the current count, with room to spare");
  const b3 = fakes(await roster()).length;
  const r3 = await tryBulk(2);
  const a3 = fakes(await roster()).length;
  console.log(`  ${r3}   ${b3} fakes -> ${a3}`);
  console.log(`  VERDICT: ${a3 === 2 ? "SET - it CAN REDUCE" : a3 === b3 + 2 ? "ADD - a lower total ADDS, it cannot reduce" : a3 === b3 ? "NO-OP" : `OTHER (${a3})`}`);

  console.log("\nSTEP 4  bulk 0 - is zero a way to clear?");
  const b4 = fakes(await roster()).length;
  const r4 = await tryBulk(0);
  console.log(`  ${r4}   ${b4} fakes -> ${fakes(await roster()).length}`);

  console.log("\nSTEP 5  can ONE fake be DELETEd by userMatchId?");
  const target = fakes(await roster())[0];
  if (!target) console.log("  no fake to remove - SKIPPED");
  else {
    const n0 = fakes(await roster()).length;
    await rm(target.id);
    const n1 = fakes(await roster()).length;
    console.log(`  DELETE user-matches/${target.id} (fake, team ${target.team} #${target.playerNumber}) -> ${n0} to ${n1}  ${n1 === n0 - 1 ? "LANDED" : "DID NOT LAND"}`);
  }

  console.log("\nSTEP 6  what identifies a fake row");
  console.log("  " + JSON.stringify(fakes(await roster())[0], null, 1).slice(0, 800));

  console.log("\nSTEP 7  does the LIST endpoint's _count.fakePlayers agree with the roster right now?");
  const lst = await apiGet<{ data?: Record<string, unknown>[] }>("staging", `/admin/matches`, { fromDate: String(m0.startDate).slice(0, 10), toDate: String(m0.startDate).slice(0, 10), limit: 200, page: 1 });
  const me = (lst.data ?? []).find((x) => Number(x.id) === M) as Record<string, unknown> | undefined;
  const rs = await roster();
  console.log(`  roster: ${fakes(rs).length} fake / ${reals(rs).length} real     _count: ${JSON.stringify(me?._count ?? "MATCH NOT IN LIST")}`);

  console.log("\ncleanup");
  for (const r of await roster()) await rm(r.id);
  console.log(`  -> ${shape(await roster())}   (delete failures: ${rmFail})`);
}
main().catch((e) => { console.error("PROBE FAILED:", e); process.exit(1); });
