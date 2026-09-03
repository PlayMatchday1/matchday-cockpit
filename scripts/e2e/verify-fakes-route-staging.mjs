/* THE FAKES ROUTE, END TO END AGAINST STAGING MATCH 2470.
 * Nothing here is mocked. The route is called over HTTP with a real bearer token, it talks to the
 * real staging API, and every assertion is a READ-BACK taken directly from MatchDay afterwards —
 * never from the route's own response body, which is the thing under test.
 *   node scripts/e2e/_e2e-fakes-route.mjs
 */
import { storageStateFor } from "./_session.mjs";
process.loadEnvFile(".env.local");

const BASE = "http://localhost:3000";
const M = 2470;
const SAPI = process.env.MATCHDAY_STAGE_API_BASE_URL;

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; fails.push(`${n} — ${d}`); console.log(`  XX  ${n} — ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

// ── talk to STAGING DIRECTLY for ground truth, with its own login. Independent of our route. ────
let stageTok = null;
const stageLogin = async () => {
  const r = await fetch(`${SAPI}/auth/signin`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.MATCHDAY_STAGE_API_EMAIL, password: process.env.MATCHDAY_STAGE_API_PASSWORD }) });
  const j = await r.json();
  stageTok = j.accessToken ?? j.token ?? j.data?.accessToken;
  if (!stageTok) throw new Error(`staging login failed: ${JSON.stringify(j).slice(0, 200)}`);
};
const sGet = async (p) => {
  const r = await fetch(`${SAPI}${p}`, { headers: { Authorization: `Bearer ${stageTok}` } });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
};
const sWrite = async (method, p, body) => {
  const r = await fetch(`${SAPI}${p}`, { method,
    headers: { Authorization: `Bearer ${stageTok}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : {};
};

const rosterRaw = async () => {
  const r = await sGet(`/admin/matches/${M}/players`);
  return Array.isArray(r) ? r : (r.data ?? []);
};
// The SAME predicates the route uses, restated here rather than imported — an assertion that
// shares its subject's definition of "a live fake" cannot catch that definition being wrong.
const live = (p) => !(p.isCancelled === true || p.canceledAt != null) && p.refunded !== true && p.paidStatus !== "WAITING";
const isFake = (p) => p.isFakePlayer === true || p.user?.isFakePlayer === true;
const counts = async () => {
  const rs = (await rosterRaw()).filter(live);
  return { fake: rs.filter(isFake).length, real: rs.filter((r) => !isFake(r)).length,
    fakeIds: rs.filter(isFake).map((r) => r.id).sort((a, b) => a - b),
    realIds: rs.filter((r) => !isFake(r)).map((r) => r.id).sort((a, b) => a - b),
    teams: rs.filter(isFake).reduce((a, r) => (a[r.team] = (a[r.team] ?? 0) + 1, a), {}) };
};

async function main() {
  await stageLogin();
  const { token } = await storageStateFor("rmancuso@playmatchday.com", BASE);
  if (!token) throw new Error("no clubhouse bearer token");

  const callRoute = async (targetFakes) => {
    const r = await fetch(`${BASE}/api/matchday/staging/matches/${M}/fakes`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ targetFakes, source: "e2e-fakes-route", matchName: "E2E probe" }),
    });
    return { status: r.status, j: await r.json().catch(() => null) };
  };

  const m = await sGet(`/admin/matches/${M}`);
  console.log(`staging match ${M}: cap=${m.maxPlayerCount} start=${m.startDate}\n`);
  const CAP = Number(m.maxPlayerCount);

  console.log("-- seed: clear, then 8 fakes and 1 REAL player --");
  for (const p of await rosterRaw()) await sWrite("DELETE", `/admin/matches/user-matches/${p.id}`).catch(() => {});
  await sWrite("POST", `/admin/matches/${M}/batch/fake-players`, { totalFakes: 8 });
  const pool = await sGet(`/admin/players?limit=25&page=1&sortColumn=createdAt&sortDirection=desc`);
  const inMatch = new Set((await rosterRaw()).map((r) => r.userId));
  const realUser = (pool.data ?? []).find((u) => !u.isFakePlayer && !inMatch.has(u.id));
  if (!realUser) throw new Error("no real staging user available to seed");
  await sWrite("POST", `/admin/matches/${M}/players/${realUser.id}`, { team: 1, playerNumber: 9 });
  const seed = await counts();
  console.log(`  seeded: ${seed.fake} fake + ${seed.real} real  teams ${JSON.stringify(seed.teams)}`);
  /* DERIVE, DO NOT PIN. Asking for 8 landed 7 the first time this ran, and pinning 8 turned a
   * finding about the API into a red assertion about my own seed. The API's batch add is
   * best-effort: on this match totalFakes 9 and 10 both land EIGHT, at HTTP 201, with no error —
   * measured separately. So the seed asserts it got ENOUGH to exercise both directions, and every
   * later assertion is computed from what actually landed. */
  yes(`  CONTROL: the seed landed enough fakes to reduce from (${seed.fake})`, seed.fake >= 6);
  is("  CONTROL: ...and exactly one REAL player", seed.real, 1);
  const REAL_IDS = seed.realIds;
  const SEEDED = seed.fake;

  // ── REDUCE: 8 -> 5. Three DELETEs against real roster rows. ───────────────────────────────────
  console.log(`\n-- REDUCE ${SEEDED} -> 5 (the DELETE path) --`);
  const r1 = await callRoute(5);
  console.log(`  route -> ${r1.status} ${JSON.stringify(r1.j).slice(0, 190)}`);
  const c1 = await counts();
  is("  the route reports landed", r1.j?.outcome, "landed");
  is("  READ-BACK: the roster now holds 5 fakes", c1.fake, 5);
  is("  READ-BACK: the real player is UNTOUCHED", c1.realIds, REAL_IDS);
  is(`  ...and the route said it removed ${SEEDED - 5}`, r1.j?.removed, SEEDED - 5);
  yes(`  the survivors are balanced (${JSON.stringify(c1.teams)})`,
    Math.abs((c1.teams[1] ?? 0) - (c1.teams[2] ?? 0)) <= 1);

  // ── ADD: 5 -> 7. ─────────────────────────────────────────────────────────────────────────────
  console.log("\n-- ADD 5 -> 7 (the batch path) --");
  const r2 = await callRoute(7);
  console.log(`  route -> ${r2.status} ${JSON.stringify(r2.j).slice(0, 190)}`);
  const c2 = await counts();
  is("  the route reports landed", r2.j?.outcome, "landed");
  is("  READ-BACK: the roster now holds 7 fakes", c2.fake, 7);
  is("  READ-BACK: the real player is STILL untouched", c2.realIds, REAL_IDS);
  is("  ...and the route said it added two", r2.j?.added, 2);

  // ── NO-OP ────────────────────────────────────────────────────────────────────────────────────
  console.log("\n-- NO-OP: asking for what is already true --");
  const r3 = await callRoute(7);
  is("  reports landed", r3.j?.outcome, "landed");
  is("  ...and says it was a no-op", r3.j?.noop, true);
  is("  READ-BACK: nothing moved", (await counts()).fake, 7);

  // ── REFUSAL: past capacity minus real ────────────────────────────────────────────────────────
  console.log(`\n-- REFUSAL: cap ${CAP} less 1 real leaves ${CAP - 1}; ask for ${CAP} --`);
  const before4 = await counts();
  const r4 = await callRoute(CAP);
  console.log(`  route -> ${r4.status} ${String(r4.j?.error).slice(0, 130)}`);
  is("  refused with 400", r4.status, 400);
  is("  outcome is 'refused', not a failed write", r4.j?.outcome, "refused");
  is("  READ-BACK: NOTHING WAS SENT — the roster is unchanged", (await counts()).fake, before4.fake);

  // ── DOWN TO ZERO: every fake goes, the real player does not ──────────────────────────────────
  console.log("\n-- REDUCE 7 -> 0: the real player must survive an empty-the-fakes request --");
  const r5 = await callRoute(0);
  const c5 = await counts();
  is("  reports landed", r5.j?.outcome, "landed");
  is("  READ-BACK: zero fakes", c5.fake, 0);
  is("  READ-BACK: THE REAL PLAYER SURVIVED", c5.realIds, REAL_IDS);
  is("  ...and is still exactly one row", c5.real, 1);

  /* ── THE API UNDER-DELIVERS AND MUST NOT BE BELIEVED ──────────────────────────────────────────
   * Measured on this match: an empty roster asked for totalFakes 9 or 10 lands EIGHT, HTTP 201, no
   * error. That is the "a 2xx does not mean the write landed" rule with a live example, and the
   * route's verdict comes from a re-read precisely so it cannot be fooled by it. Asking for a
   * target the API will not reach must therefore report NOT APPLIED with both numbers — never
   * landed, and never a crash. */
  console.log("\n-- UNDER-DELIVERY: the API returns 201 and lands fewer than asked --");
  for (const p of await rosterRaw()) await sWrite("DELETE", `/admin/matches/user-matches/${p.id}`).catch(() => {});
  const r6 = await callRoute(CAP - 1);          // 9 on a capacity-10 match with no real players
  const c6 = await counts();
  console.log(`  route -> ${r6.status} outcome=${r6.j?.outcome} target=${r6.j?.target} fakesAfter=${r6.j?.fakesAfter}  READ-BACK ${c6.fake}`);
  is("  READ-BACK agrees with what the route reported", c6.fake, r6.j?.fakesAfter);
  if (c6.fake === CAP - 1) {
    ok(`  the API DID deliver all ${CAP - 1} here, so the route correctly says landed`);
    is("  ...and it says landed", r6.j?.outcome, "landed");
  } else {
    ok(`  the API under-delivered (${c6.fake} of ${CAP - 1} asked)`);
    is("  THE ROUTE DOES NOT CLAIM IT LANDED", r6.j?.outcome, "not_applied");
    yes("  ...and a re-read is what caught it", r6.j?.fakesAfter !== r6.j?.target);
  }

  console.log("\n-- cleanup --");
  for (const p of await rosterRaw()) await sWrite("DELETE", `/admin/matches/user-matches/${p.id}`).catch(() => {});
  const done = await counts();
  console.log(`  roster left at ${done.fake} fake + ${done.real} real`);

  console.log(`\ne2e-fakes-route: ${pass} passed, ${fail} failed`);
  if (fail) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}
main().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(2); });
