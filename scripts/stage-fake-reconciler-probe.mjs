/* DOES ANYTHING RECONCILE THE ROSTER TO THE LADDER, AND HOW FAST?
 *
 * THE CLAIM THIS WAS WRITTEN TO TEST: "the worker brings the roster to it in ~150s". It sat in
 * fakeLadder.ts on a single observation and had reached operator-facing copy, which is the exact
 * fault the old bulk-fake comment was caught for.
 *
 * THE EXPERIMENT. Take a staging match whose roster and ladder AGREE (roster fakes equal to
 * capacity - in-force rung - real). Move the LADDER ONLY. If something reconciles, the roster
 * follows on its own with no roster write.
 *
 * MEASURED 2026-09-02, both directions, 10-15s sampling:
 *     2620  ADD     0 -> 10    93s        2619  REMOVE 16 -> 4   294s
 *     2620  ADD     0 -> 12   103s        2620  REMOVE 12 -> 2   298s
 * A reconciler EXISTS. Adds ~100s, REMOVALS ~295s. See docs/matchday-api-facts.md.
 *
 * A NULL RESULT WOULD HAVE BEEN A RESULT: if it had never moved, the "it will catch up" copy would
 * have been a lie and had to say the roster needs a manual fix instead.
 *
 * STAGING ONLY. It writes rungs on a staging match and restores them at the end; the restore does
 * not survive the process being killed, so check the match if you interrupt it.
 *   node scripts/stage-fake-reconciler-probe.mjs
 */
process.loadEnvFile("/Users/ryanmancuso/Code/matchday-cockpit/.env.local");
const S = process.env.MATCHDAY_STAGE_API_BASE_URL, M = 2620;
const r0 = await fetch(`${S}/auth/signin`, { method:"POST", headers:{"content-type":"application/json"},
  body: JSON.stringify({ email: process.env.MATCHDAY_STAGE_API_EMAIL, password: process.env.MATCHDAY_STAGE_API_PASSWORD })});
const T = (await r0.json()).accessToken;
const G = async (p) => (await fetch(`${S}${p}`, { headers:{Authorization:`Bearer ${T}`} })).json();
const W = async (m,p,b) => { const r = await fetch(`${S}${p}`, { method:m, headers:{Authorization:`Bearer ${T}`,"content-type":"application/json"}, body:JSON.stringify(b)}); return { s:r.status, t:(await r.text()).slice(0,200) }; };
const live = (p) => !(p.isCancelled===true||p.canceledAt!=null) && p.refunded!==true && p.paidStatus!=="WAITING";
const isFake = (p) => p.isFakePlayer===true||p.user?.isFakePlayer===true;
const sample = async () => {
  const raw = await G(`/admin/matches/${M}/players`);
  const rows = (Array.isArray(raw)?raw:(raw.data??[])).filter(live);
  const m = await G(`/admin/matches/${M}`);
  return { rosterFakes: rows.filter(isFake).length, rosterReal: rows.filter(r=>!isFake(r)).length,
    rungs: [36,24,12,6,3].map(h=>m[`fakeSpotLeft${h}h`]), hrs: ((Date.parse(m.startDateUtc)-Date.now())/3600000).toFixed(2) };
};

const before = await sample();
console.log(`T+0s   BEFORE  roster ${before.rosterFakes} fake / ${before.rosterReal} real   rungs [${before.rungs}]   ${before.hrs}h to kickoff`);
console.log(`  in-force rung at ${before.hrs}h is the 6h mark = ${before.rungs[3]} -> implies ${Math.max(0,18-before.rungs[3]-before.rosterReal)} fakes`);

const put = await W("PUT", `/admin/matches/${M}`, { fakeSpotLeft6h: 8, fakeSpotLeft3h: 8 });
console.log(`\nLADDER WRITE -> HTTP ${put.s}`);
const afterWrite = await sample();
console.log(`T+2s   rungs now [${afterWrite.rungs}] -> ladder implies ${Math.max(0,18-afterWrite.rungs[3]-afterWrite.rosterReal)} fakes; roster holds ${afterWrite.rosterFakes}`);
if (afterWrite.rungs[3] !== 8) { console.log("LADDER WRITE DID NOT LAND — probe is void"); process.exit(2); }

console.log(`\nsampling every 15s for 12 minutes. TARGET = 10 fakes if anything reconciles.`);
const t0 = Date.now();
let moved = null;
for (let i = 1; i <= 48; i++) {
  await new Promise(r => setTimeout(r, 15000));
  const s = await sample();
  const secs = Math.round((Date.now()-t0)/1000);
  console.log(`T+${String(secs).padStart(4)}s  roster ${s.rosterFakes} fake / ${s.rosterReal} real   rungs [${s.rungs}]   ${s.hrs}h`);
  if (s.rosterFakes !== before.rosterFakes && moved === null) {
    moved = secs;
    console.log(`  *** THE ROSTER MOVED at T+${secs}s: ${before.rosterFakes} -> ${s.rosterFakes} ***`);
  }
  if (moved !== null && s.rosterFakes === 10) { console.log(`  *** RECONCILED to the ladder's 10 at T+${secs}s ***`); break; }
}
console.log(`\nVERDICT: ${moved === null
  ? "NOTHING RECONCILED the roster to the ladder in 12 minutes. No such worker fired."
  : `the roster moved on its own at T+${moved}s — something reconciles.`}`);

console.log("\nrestoring the ladder");
const back = await W("PUT", `/admin/matches/${M}`, { fakeSpotLeft6h: 18, fakeSpotLeft3h: 18 });
const fin = await sample();
console.log(`  HTTP ${back.s}  rungs [${fin.rungs}]  roster ${fin.rosterFakes} fake`);
