import "server-only"; // no-op under --conditions=react-server
// PHASE 13 PART 1 - prove EVERY roster operation round-trips on STAGING (match
// 2470) before production. Endpoints CORRECTED against the live API (the mockup /
// Phase-6 inventory were wrong in two places — see CONFLICTS below). Cleans up.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-p13-roster-proof.ts
//
// CONFLICTS (API wins):
//  - remove is DELETE /admin/matches/user-matches/{userMatchId}. The phase's
//    DELETE /admin/matches/{id}/players/{playerId} returns 403 USER_NOT_JOINED.
//    So REMOVE keys on userMatchId, not playerId.
//  - mark-absent's documented path PATCH /admin/matches/{id}/user-matches/{umId}/
//    absent (and 3 variants) all 404 "Cannot PATCH" on staging — the route is not
//    registered. Absent is UNAVAILABLE; recorded, not built.
import { apiGet, apiWrite } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const M = 2470;
const line = (s = "") => console.log(s);
type Row = { id: number; userId: number; team: number; playerNumber: number; isAbsent: boolean; user?: { isFakePlayer?: boolean } };
const roster = async (): Promise<Row[]> => {
  const r = await apiGet<Row[] | { data?: Row[] }>("staging", `/admin/matches/${M}/players`);
  return Array.isArray(r) ? r : (r.data ?? []);
};
const byUser = (rs: Row[], userId: number) => rs.find((x) => x.userId === userId);
const remove = (umId: number) => apiWrite("staging", "DELETE", `/admin/matches/user-matches/${umId}`).catch(() => {});
let pass = 0, fail = 0;
const ok = (n: string) => { pass++; line(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; line(`  XX  ${n} ${d}`); };

async function main() {
  for (const r of await roster()) await remove(r.id);
  line(`match ${M} cleared to ${(await roster()).length} rows\n`);

  // add-fake
  const f = await apiWrite<Row>("staging", "POST", `/admin/matches/${M}/fake-players`, { team: 1, playerNumber: 1 });
  const fr = (await roster()).find((r) => r.id === f.id);
  fr ? ok(`add-fake  POST /matches/${M}/fake-players {team,playerNumber} -> um${fr.id}/player${fr.userId} team${fr.team}#${fr.playerNumber}`) : bad("add-fake");

  // add-real
  const s = await apiGet<{ data: { id: number; isFakePlayer: boolean }[] }>("staging", `/admin/players`, { limit: 15, page: 1, sortColumn: "createdAt", sortDirection: "desc" });
  const inM = new Set((await roster()).map((r) => r.userId));
  const cand = (s.data ?? []).find((u) => !u.isFakePlayer && !inM.has(u.id));
  let real: Row | undefined;
  if (!cand) bad("add-real: no user"); else {
    await apiWrite("staging", "POST", `/admin/matches/${M}/players/${cand.id}`, { team: 1, playerNumber: 2 });
    real = byUser(await roster(), cand.id);
    real ? ok(`add-player POST /matches/${M}/players/{userId} {team,playerNumber} -> um${real.id} team${real.team}#${real.playerNumber}`) : bad("add-player");
  }

  // move (userMatchId)
  if (real) {
    await apiWrite("staging", "POST", `/admin/user-matches`, { userMatchId: real.id, team: 2, playerNumber: 1 });
    const mv = byUser(await roster(), real.userId);
    mv && mv.team === 2 ? ok(`move      POST /admin/user-matches {userMatchId ${real.id}} -> team 1->${mv.team} (userMatchId)`) : bad("move", `team=${mv?.team}`);
  }

  // set/unset fake (playerId = userId)
  if (real) {
    const was = !!byUser(await roster(), real.userId)!.user?.isFakePlayer;
    await apiWrite("staging", "PATCH", `/admin/players/${real.userId}/fake-player`);
    const now = !!byUser(await roster(), real.userId)!.user?.isFakePlayer;
    now !== was ? ok(`fake      PATCH /admin/players/${real.userId}/fake-player -> ${was}->${now} (playerId=userId)`) : bad("fake", `${was}->${now}`);
    await apiWrite("staging", "PATCH", `/admin/players/${real.userId}/fake-player`).catch(() => {});
  }

  // bulk-fake
  const n0 = (await roster()).length;
  await apiWrite("staging", "POST", `/admin/matches/${M}/batch/fake-players`, { totalFakes: 2 });
  const n1 = (await roster()).length;
  n1 > n0 ? ok(`bulk-fake POST /matches/${M}/batch/fake-players {totalFakes:2} -> +${n1 - n0}`) : bad("bulk-fake", `${n0}->${n1}`);

  // remove (userMatchId, via /matches/user-matches/{umId})
  const tgt = (await roster())[0];
  if (tgt) {
    await apiWrite("staging", "DELETE", `/admin/matches/user-matches/${tgt.id}`);
    !byUser(await roster(), tgt.userId) ? ok(`remove    DELETE /admin/matches/user-matches/${tgt.id} (userMatchId) -> gone`) : bad("remove");
  }

  // absent — CONFLICT: documented path 404s. Record it, do not fail the suite.
  const um = (await roster())[0]?.id;
  if (um) {
    try { await apiWrite("staging", "PATCH", `/admin/matches/${M}/user-matches/${um}/absent`); line(`  ??  absent    UNEXPECTEDLY succeeded — re-check`); }
    catch { line(`  --  absent    PATCH /matches/${M}/user-matches/{umId}/absent -> 404 (route not registered on staging). CONFLICT: omitted from the build.`); }
  }

  for (const r of await roster()) await remove(r.id);
  line(`\nroster back to ${(await roster()).length}. ${pass} passed, ${fail} failed. (absent = known conflict, not counted)`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message.replace(/Body:.*/s, "Body:[omitted]") : e); process.exit(1); });
