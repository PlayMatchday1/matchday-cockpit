/* DOES THE NEW DEFAULT LADDER PRODUCE THE FAKES THE FORMULA SAYS, AT EVERY MARK?
 *
 * The new default (src/lib/fakeLadder.ts newDefaultLadder) on capacity 18 is 16/16/15/16/18, which
 * by fake = capacity − rung − real on an empty match means 2 / 2 / 3 / 2 / 0 fakes at the 36h /
 * 24h / 12h / 6h / 3h marks. This puts that ladder on ONE staging match and moves its kickoff into
 * each band in turn, sampling the live roster until the reconciler settles, so each number is a
 * read-back and not the formula restated.
 *
 * ORDER 30h, 9h, 20h, 5h, 2h — chosen so four of the five steps MOVE the count (0→2→3→2→2→0), and
 * so it ends on zero fakes before the match is put back.
 *
 * STAGING ONLY, host-checked on the PARSED host against production's before any write. Match 2620
 * is a "ZZ RUNG PROBE" fixture: capacity 18, no players, auto-cancel off. Its original dates and
 * rungs are restored at the end; a restore does not survive the process being killed, so check
 * the match if you interrupt it.
 *   node scripts/stage-new-ladder-probe.mjs
 */
process.loadEnvFile("/Users/ryanmancuso/Code/matchday-cockpit/.env.local");
const S = process.env.MATCHDAY_STAGE_API_BASE_URL, M = 2620;
/* EXACT EQUALITY ON THE PARSED HOST, against the same staging host the write client allowlists
 * (src/lib/matchdayStageApi.ts HOSTS.staging). A suffix or substring check would pass
 * `matchday-stage.herokuapp.com.evil.com`. */
const STAGING_HOST = "matchday-stage.herokuapp.com";
let host = null; try { host = new URL(S).hostname; } catch { /* unparseable is refused below */ }
if (host !== STAGING_HOST) { console.log(`REFUSED: base URL host is ${JSON.stringify(host)}, not ${STAGING_HOST}`); process.exit(2); }

const r0 = await fetch(`${S}/auth/signin`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: process.env.MATCHDAY_STAGE_API_EMAIL, password: process.env.MATCHDAY_STAGE_API_PASSWORD }) });
const T = (await r0.json()).accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const G = async (p) => { await sleep(1000); return (await fetch(`${S}${p}`, { headers: { Authorization: `Bearer ${T}` } })).json(); };
const W = async (b) => { await sleep(1000); const r = await fetch(`${S}/admin/matches/${M}`, { method: "PUT", headers: { Authorization: `Bearer ${T}`, "content-type": "application/json" }, body: JSON.stringify(b) }); return r.status; };
const live = (p) => !(p.isCancelled === true || p.canceledAt != null) && p.refunded !== true && p.paidStatus !== "WAITING";
const isFake = (p) => p.isFakePlayer === true || p.user?.isFakePlayer === true;
const KEYS = [36, 24, 12, 6, 3].map((h) => `fakeSpotLeft${h}h`);
const sample = async () => {
  const raw = await G(`/admin/matches/${M}/players`);
  const rows = (Array.isArray(raw) ? raw : (raw.data ?? [])).filter(live);
  return { fake: rows.filter(isFake).length, real: rows.filter((r) => !isFake(r)).length };
};

const orig = await G(`/admin/matches/${M}`);
const CAP = Number(orig.maxPlayerCount);
const NEW = { 36: CAP - 2, 24: CAP - 2, 12: CAP - 3, 6: CAP - 2, 3: CAP };
/* The wall-clock offset this match's city uses NOW, read off the match rather than assumed:
 * startDate is local wall clock wearing a Z, startDateUtc is the instant. */
const offsetMs = Date.parse(orig.startDateUtc) - Date.parse(orig.startDate);
console.log(`match ${M} "${orig.name}" cap ${CAP}  original rungs [${KEYS.map((k) => orig[k])}]  wall→UTC offset ${offsetMs / 3.6e6}h`);
if (orig.autoCanceled === true) { console.log("REFUSED: auto-cancel is on for this match"); process.exit(2); }

console.log(`\nwriting the new ladder [${Object.values(NEW).reverse()}]… HTTP ${await W(Object.fromEntries(KEYS.map((k, i) => [k, NEW[[36, 24, 12, 6, 3][i]]])))}`);
const fmt = (ms) => new Date(ms).toISOString();
const results = [];
for (const [h, mark] of [[30, 36], [9, 12], [20, 24], [5, 6], [2, 3]]) {
  const startUtc = Date.now() + h * 3.6e6;
  const st = await W({ startDate: fmt(startUtc - offsetMs), endDate: fmt(startUtc - offsetMs + 3.6e6) });
  const back = await G(`/admin/matches/${M}`);
  const hrs = (Date.parse(back.startDateUtc) - Date.now()) / 3.6e6;
  const s0 = await sample();
  const expect = Math.max(0, CAP - NEW[mark] - s0.real);
  console.log(`\nkickoff → ${h}h out (HTTP ${st}; reads ${hrs.toFixed(2)}h)  in-force mark ${mark}h  rung ${back[`fakeSpotLeft${mark}h`]}  real ${s0.real}  EXPECT ${expect} fake`);
  const t0 = Date.now(); let got = s0.fake, settledAt = null, stable = 0;
  while (Date.now() - t0 < 9 * 60_000) {
    const s = await sample(); got = s.fake;
    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`  T+${String(secs).padStart(3)}s  ${s.fake} fake / ${s.real} real`);
    if (s.fake === expect) { stable++; if (stable === 1) settledAt = secs; if (stable >= 2) break; } else stable = 0;
    await sleep(18_000);
  }
  results.push({ h, mark, expect, got, settledAt, ok: got === expect });
}

console.log("\nrestoring dates and rungs");
console.log(`  HTTP ${await W({ startDate: orig.startDate, endDate: orig.endDate, ...Object.fromEntries(KEYS.map((k) => [k, orig[k]])) })}`);
const fin = await G(`/admin/matches/${M}`);
console.log(`  now ${fin.startDate}  rungs [${KEYS.map((k) => fin[k])}]  roster ${JSON.stringify(await sample())}`);

console.log("\nmark  kickoff  expect  got  settled");
for (const r of results) console.log(`${String(r.mark).padStart(3)}h  ${String(r.h).padStart(5)}h  ${String(r.expect).padStart(6)}  ${String(r.got).padStart(3)}  ${r.settledAt == null ? "never" : `${r.settledAt}s`}  ${r.ok ? "OK" : "MISMATCH"}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
