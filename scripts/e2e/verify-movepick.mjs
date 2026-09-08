/* THE MOVE PICKER'S GEOMETRY, measured rather than described.
 *
 * WHY THIS SUITE EXISTS. .mp-player was flex; a later change made it a six-track GRID, which turned
 * .mp-movepick into a grid ITEM with no grid-column — so it auto-placed into column 1, the 20px
 * checkbox track. Measured at 1440px: the picker rendered 20px wide, the team buttons stacked three
 * deep, and the row went 46px -> 259px at step 1 and 669px at step 2. It shipped and stayed shipped
 * because grid-column:1 / -1 existed only inside @media (max-width:560px), so the phone was right
 * and nobody was measuring the desktop. A geometry regression that only a measurement can see is
 * exactly what a browser suite is for.
 *
 * Runs the SAME assertions before and after the fix, so the "before" numbers are a real control
 * and not a remembered claim. A grid-column of `auto` before and `1 / -1` after is the whole bug;
 * an assertion that only ever saw the fixed state would prove nothing.
 *
 *   node scripts/e2e/verify-movepick.mjs            # both widths, both matches
 *
 * Mocked roster (no production write, no production read) — the same fixtures verify-matchpanel
 * uses: 17494 is 3 teams x 9 spots, 14444 is 4 teams x 5 spots.
 */
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { installHarnessGuard, sessionFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
// SHOT=<tag> writes a picture of both steps at desktop width, for eyeballing a before/after.
const SHOT_DIR = process.env.SHOT_DIR || "/tmp";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));

const REGULAR = {
  id: 17494, name: "PRUMC - Tuesday", type: "REGULAR", category: "OPEN",
  managerId: 65903, secondManagerId: null, fieldId: 199,
  startDate: "2026-08-11T19:00:00.000Z", endDate: "2026-08-11T20:30:00.000Z",
  registrationPrice: 1000, additionalSpotPrice: null, guestCount: 10, isFreeMember: true,
  maxPlayerCount: 18, fakeSpotLeft36h: 12, fakeSpotLeft24h: 10, fakeSpotLeft12h: 6,
  fakeSpotLeft6h: 4, fakeSpotLeft3h: 3, autoCanceled: true, autoCanceledMinutes: 75,
  minPlayerCount: 6, isAutoBump: true, maxTeamSize2Team: 16, maxTeamSize4Team: 28,
  description: "", managerIntro: "", isCancelled: false,
  teams: [{ teamNumber: 1 }, { teamNumber: 2 }, { teamNumber: 3 }],
  occupancy: 12, realOccupancy: 1, cityName: "Atlanta", fieldTitle: "PRUMC", cityId: 5,
  manager: { firstName: "Troy", lastName: "" }, secondManager: null,
};
const MANAGERS = [{ id: 65903, name: "Troy" }];
const FIELDS = [{ id: 199, title: "Atlanta — PRUMC", city: "Atlanta" }];

/* 3 TEAMS x 9 SPOTS. Team 2 is deliberately crowded so step 2 shows taken spots beside open ones,
   and the mover (Alex Kim, team 1 spot 1) has somewhere to go inside their own team. */
const nineSpot = () => ({
  name: "PRUMC - Tuesday",
  teams: [{ id: 501, teamNumber: 1, name: "White Tee", locked: false },
          { id: 502, teamNumber: 2, name: "Dark Tee", locked: false },
          { id: 503, teamNumber: 3, name: "Team 3", locked: false }],
  players: [
    { umId: 9001, playerId: 1, team: 1, playerNumber: 1, name: "Alexandra Kimberly", phone: "+15125550101", fake: false },
    { umId: 9002, playerId: 2, team: 1, playerNumber: 3, name: "Sam Reyes", phone: "+15125550102", fake: false },
    { umId: 9003, playerId: 3, team: 2, playerNumber: 2, name: "Jae Park", phone: "+15125550103", fake: false },
    { umId: 9004, playerId: 4, team: 2, playerNumber: 4, name: "Nkem Obi", phone: "+15125550104", fake: false },
    { umId: 9005, playerId: 5, team: 2, playerNumber: 6, name: "Meg Lu", phone: "+15125550105", fake: false },
  ], shape: { teamN: 3, perTeam: 9 }, maxPlayerCount: 27, occupancy: 5, _um: -1,
});
/* 4 TEAMS x 5 SPOTS — the four team buttons the brief measures at step 1. */
const fourTeam = () => ({
  name: "Bracket Night",
  teams: [{ id: 601, teamNumber: 1, name: "White Tee", locked: false },
          { id: 602, teamNumber: 2, name: "Dark Tee", locked: false },
          { id: 603, teamNumber: 3, name: "Team 3", locked: false },
          { id: 604, teamNumber: 4, name: "Team 4", locked: false }],
  players: [
    { umId: 8004, playerId: 4, team: 4, playerNumber: 1, name: "Bomi Ol", phone: "+15125558004", fake: false },
    { umId: 8005, playerId: 5, team: 4, playerNumber: 2, name: "Sam Reyes", phone: "+15125558005", fake: false },
    { umId: 8001, playerId: 1, team: 1, playerNumber: 1, name: "Alexandra Kimberly", phone: "+15125558001", fake: false },
  ], shape: { teamN: 4, perTeam: 5 }, maxPlayerCount: 20, occupancy: 3, _um: -1,
});
const rosterStates = {};
const rosterFor = (id) => (rosterStates[id] ??= String(id).endsWith("4444") ? fourTeam() : nineSpot());
const matchFor = (id) => (String(id).endsWith("4444")
  ? { ...REGULAR, id: Number(id), maxPlayerCount: 20, teams: [1, 2, 3, 4].map((teamNumber) => ({ teamNumber })) }
  : { ...REGULAR, id: Number(id) });

let rosterPosts = [];
async function routes(ctx) {
  await ctx.route(/\/api\/matchday\/production\/matches\/\d+(\?.*)?$/, async (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop();
    return r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ match: matchFor(id), fields: FIELDS, players: [], managers: MANAGERS }) });
  });
  await ctx.route(/\/api\/matchday\/production\/roster\/\d+(\?.*)?$/, async (r) => {
    const url = new URL(r.request().url()); const id = url.pathname.split("/").pop();
    const st = rosterFor(id);
    const json = (o) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (r.request().method() === "GET") {
      if (url.searchParams.get("q") !== null) return json({ results: [] });
      return json({ matchId: Number(id), name: st.name, teams: st.teams, players: st.players, shape: st.shape, maxPlayerCount: st.maxPlayerCount, occupancy: st.occupancy });
    }
    const op = JSON.parse(r.request().postData() || "{}");
    rosterPosts.push(op);
    if (op.kind === "move") { const p = st.players.find((x) => x.umId === op.userMatchId); if (p) { p.team = op.team; p.playerNumber = op.playerNumber; } }
    return json({ ok: true, outcome: "landed", result: {} });
  });
  await ctx.route("**/rest/v1/app_users*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    // A ROUTE HANDLER CAN OUTLIVE ITS CONTEXT. route.fetch() after ctx.close() throws "Request
    // context disposed", which killed the run AFTER the assertions had already passed and made a
    // finished suite look like a crash. Swallow it: there is nothing left to answer.
    let res, j;
    try { res = await route.fetch(); j = await res.json().catch(() => null); }
    catch { return route.abort().catch(() => {}); }
    const p = (r) => ({ ...r, is_admin: true, can_access_matchops: true, can_edit_matches: true, can_access_chats: true });
    j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
    return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
  });
}

const openTeams = async (page) => {
  const hd = await page.$('[data-testid="mp-teamshd"]');
  if (hd && (await hd.getAttribute("aria-expanded")) === "false") await hd.click();
  await page.waitForSelector('[data-testid="mp-player"]', { timeout: 15000 });
};
/* THE MEASUREMENT ITSELF. Container-relative, never document.scrollWidth: a page-level number
   answers a different question and has reported a pass on an overflowing card before. */
const geo = (page, um) => page.evaluate((umId) => {
  const li = document.querySelector(`[data-testid="mp-player"][data-um="${umId}"]`);
  const pick = li?.querySelector('[data-testid="mp-movepick"]');
  if (!li) return null;
  const cs = pick ? getComputedStyle(pick) : null;
  const widest = pick ? Math.max(0, ...[...pick.querySelectorAll("*")].map((e) => e.getBoundingClientRect().width)) : 0;
  const rows = (sel) => {
    const els = [...(pick?.querySelectorAll(sel) ?? [])];
    return new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size;
  };
  return {
    liH: Math.round(li.getBoundingClientRect().height),
    pickW: pick ? Math.round(pick.getBoundingClientRect().width) : 0,
    gridColumn: cs ? cs.gridColumnStart + " / " + cs.gridColumnEnd : null,
    step: pick?.getAttribute("data-step") ?? null,
    btnLines: rows('[data-testid^="mp-movepick-team-"], [data-testid^="mp-movepick-spot-"]'),
    lbLines: pick ? Math.round(pick.querySelector(".mp-picklb")?.getBoundingClientRect().height ?? 0) : 0,
    overflowX: pick ? Math.round(widest) - Math.round(pick.clientWidth) : 0,
    liOverflowX: Math.round(li.scrollWidth) - Math.round(li.clientWidth),
  };
}, um);

async function main() {
  process.loadEnvFile(".env.local");
  const session = await sessionFor("rmancuso@playmatchday.com");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] };
  const browser = await chromium.launch({ headless: true });

  for (const [label, w, h] of [["desktop 1440", 1440, 1000], ["drawer 760", 760, 1000], ["phone 390", 390, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState });
    await routes(ctx);
    const page = await ctx.newPage();

    console.log(`\n── ${label} · 3 teams x 9 spots (17494) ──`);
    await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
    await openTeams(page);
    const closed = (await geo(page, 9001)).liH;
    await page.click('[data-testid="mp-move-9001"]');
    await page.waitForSelector('[data-testid="mp-movepick"]');
    const g1 = await geo(page, 9001);
    console.log(`   row closed ${closed}px · picker open ${g1.liH}px · picker width ${g1.pickW}px`);
    console.log(`   grid-column ${g1.gridColumn} · step ${g1.step} · button lines ${g1.btnLines} · label height ${g1.lbLines}px`);
    yes(`${label}: picker is not a 20px column`, g1.pickW > 100, `${g1.pickW}px`);
    eq(`${label}: team buttons on one line`, g1.btnLines, 1);
    yes(`${label}: nothing overflows the picker`, g1.overflowX <= 0, `widest child exceeds by ${g1.overflowX}px`);
    yes(`${label}: the row does not pan sideways`, g1.liOverflowX <= 0, `${g1.liOverflowX}px`);

    // step 2 — nine spots
    // A PICTURE OF THE THING, for the report. SHOT=<tag> writes both steps at desktop width.
    if (process.env.SHOT && label.startsWith("desktop")) {
      const li = await page.$('[data-testid="mp-player"][data-um="9001"]');
      await li.screenshot({ path: `${SHOT_DIR}/movepick-${process.env.SHOT}-step1.png` });
    }
    await page.click('[data-testid="mp-movepick-team-2"]');
    await page.waitForSelector('[data-testid="mp-movepick"][data-step="spot"]');
    if (process.env.SHOT && label.startsWith("desktop")) {
      const li = await page.$('[data-testid="mp-player"][data-um="9001"]');
      await li.screenshot({ path: `${SHOT_DIR}/movepick-${process.env.SHOT}-step2.png` });
    }
    const g2 = await geo(page, 9001);
    const spots = await page.$$eval('[data-testid^="mp-movepick-spot-"]', (e) => e.length);
    const disabled = await page.$$eval('[data-testid^="mp-movepick-spot-"]', (e) => e.filter((x) => x.disabled).map((x) => x.getAttribute("data-testid")));
    console.log(`   step 2: ${spots} spots · ${g2.btnLines} line(s) · row ${g2.liH}px · disabled ${JSON.stringify(disabled)}`);
    eq(`${label}: nine spot buttons`, spots, 9);
    yes(`${label}: nine spots fit without the card panning`, g2.liOverflowX <= 0 && g2.overflowX <= 0, `li ${g2.liOverflowX} pick ${g2.overflowX}`);
    console.log(`   MEASURED heights — closed ${closed}px, step 1 ${g1.liH}px, step 2 ${g2.liH}px`);

    // the mover's OWN spot, on their OWN team
    await page.click('[data-testid="mp-movepick-back"]');
    await page.click('[data-testid="mp-movepick-team-1"]');
    await page.waitForSelector('[data-testid="mp-movepick"][data-step="spot"]');
    const own = await page.$$eval('[data-testid^="mp-movepick-spot-"]', (e) => e.map((x) => ({ t: x.getAttribute("data-testid"), dis: x.disabled })));
    console.log(`   own team spots: ${JSON.stringify(own.filter((x) => x.dis))} disabled of ${own.length}`);

    console.log(`\n── ${label} · 4 teams x 5 spots (14444) ──`);
    await page.goto(`${BASE}/match-ops/match-panel/14444`, { waitUntil: "domcontentloaded" });
    await openTeams(page);
    await page.click('[data-testid="mp-move-8004"]');
    await page.waitForSelector('[data-testid="mp-movepick"]');
    const g3 = await geo(page, 8004);
    console.log(`   picker ${g3.pickW}px · grid-column ${g3.gridColumn} · four team buttons on ${g3.btnLines} line(s) · row ${g3.liH}px`);
    eq(`${label}: four team buttons on one line`, g3.btnLines, 1);
    await ctx.close();
  }
  // ── BEHAVIOUR. The layout is presentation; these four are the things that must not have moved.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState });
    await routes(ctx);
    const page = await ctx.newPage();
    const pending = () => page.$$eval('[data-testid="mp-pending-move"]', (e) => e.length);

    /* REAR_ONLY skips straight to the Rearrange check. It exists so the overlay can be measured on
       the UNFIXED build too: before the fix, clicking the mover's own spot CLOSES the picker (the
       dead click), so the step-5 back/cancel clicks time out and the run never reaches the overlay.
       A before/after comparison of Rearrange needs both halves to actually run. */
    await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
    await openTeams(page);
    if (!process.env.REAR_ONLY) {
    // 1 — A MOVE TO AN EMPTY SPOT ON ANOTHER TEAM still stages.
    rosterPosts = [];
    await page.click('[data-testid="mp-move-9001"]');
    await page.click('[data-testid="mp-movepick-team-2"]');
    await page.click('[data-testid="mp-movepick-spot-1"]');            // spot 1 on team 2 is empty
    eq("a move to an empty spot stages one pending move", await pending(), 1);
    eq("...and nothing was written yet", rosterPosts.length, 0);

    // 2 — A SWAP ONTO AN OCCUPIED SPOT is still TWO pending moves in one Save. The control.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openTeams(page);
    rosterPosts = [];
    await page.click('[data-testid="mp-move-9001"]');
    await page.click('[data-testid="mp-movepick-team-2"]');
    await page.click('[data-testid="mp-movepick-spot-2"]');            // Jae Park is on team 2 spot 2
    eq("a swap onto an occupied spot stages TWO pending moves", await pending(), 2);
    // ...and lands on Save, as two writes.
    await page.click('[data-testid="mp-save"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="mp-pending-move"]').length === 0, null, { timeout: 15000 });
    eq("...and Save writes exactly two moves", rosterPosts.filter((o) => o.kind === "move").length, 2);

    // 3 — MOVING WITHIN THE SAME TEAM still works. This is what "mark, do not disable" protects.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openTeams(page);
    rosterPosts = [];
    await page.click('[data-testid="mp-move-9002"]');                  // Sam Reyes, team 1 spot 3
    const nowMarked = await page.$$eval('[data-testid^="mp-movepick-team-"]', (e) =>
      e.filter((x) => x.getAttribute("data-now") === "true").map((x) => ({ t: x.getAttribute("data-testid"), dis: x.disabled })));
    eq("the current team is marked", nowMarked, [{ t: "mp-movepick-team-1", dis: false }]);
    yes("...and still clickable", nowMarked[0]?.dis === false);
    await page.click('[data-testid="mp-movepick-team-1"]');            // their OWN team
    const own = await page.$$eval('[data-testid^="mp-movepick-spot-"]', (e) =>
      e.map((x) => ({ n: x.getAttribute("data-testid"), dis: x.disabled, self: x.getAttribute("data-self") })));
    eq("exactly one spot is disabled, and it is the mover's own",
      own.filter((x) => x.dis).map((x) => x.n), ["mp-movepick-spot-3"]);
    eq("...and it is the only one marked self", own.filter((x) => x.self === "true").map((x) => x.n), ["mp-movepick-spot-3"]);
    await page.click('[data-testid="mp-movepick-spot-5"]');            // a different spot, same team
    eq("a move WITHIN the same team stages", await pending(), 1);

    // 4 — THE DEAD CLICK IS GONE. Clicking the mover's own spot cannot stage or close the picker.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openTeams(page);
    await page.click('[data-testid="mp-move-9002"]');
    await page.click('[data-testid="mp-movepick-team-1"]');
    await page.click('[data-testid="mp-movepick-spot-3"]', { force: true }).catch(() => {});
    eq("clicking the mover's own spot stages nothing", await pending(), 0);
    yes("...and the picker stays open rather than closing as if it did something",
      (await page.$('[data-testid="mp-movepick"]')) !== null);

    // 5 — cancel closes the picker; back returns to step 1.
    yes("back returns to step 1", await page.click('[data-testid="mp-movepick-back"]')
      .then(() => page.$eval('[data-testid="mp-movepick"]', (e) => e.getAttribute("data-step")))
      .then((v) => v === "team"));
    await page.click('[data-testid="mp-movepick-cancel"]');
    yes("cancel closes the picker", (await page.$('[data-testid="mp-movepick"]')) === null);

    }
    // 6 — THE REARRANGE OVERLAY IS UNTOUCHED. It shares .mp-spotbtn, which is why every new rule
    //     is scoped to .mp-movepick. A bare number, no name, no now/self mark, no left border.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openTeams(page);
    await page.click('[data-testid="mp-rearrange-open"]');
    await page.waitForSelector('[data-testid="mp-rearrange"]');
    await page.click('[data-testid="mp-rear-move-9001"]');
    await page.waitForSelector('[data-testid="mp-rear-pick"]');
    // STEP 2 IS WHERE .mp-spotbtn LIVES in this overlay — the team buttons are .mp-mini and were
    // never in scope. Sampling the wrong one passed on the wrong subject the first time.
    const rearTeams = await page.$$eval('[data-testid^="mp-rear-pick-team-"]', (e) =>
      e.map((x) => ({ t: x.getAttribute("data-testid"), dis: x.disabled, txt: x.textContent })));
    console.log(`   REARRANGE team buttons: ${JSON.stringify(rearTeams)}`);
    const pickTeam = rearTeams.find((x) => !x.dis);
    await page.click(`[data-testid="${pickTeam.t}"]`);
    await page.waitForSelector('[data-testid^="mp-rear-pick-spot-"]');
    const rear = await page.evaluate(() => {
      const pick = document.querySelector('[data-testid="mp-rear-pick"]');
      const b = pick.querySelector('[data-testid^="mp-rear-pick-spot-"]');
      const cs = getComputedStyle(b), r = b.getBoundingClientRect();
      const pcs = getComputedStyle(pick);
      return { text: b.textContent, w: Math.round(r.width), h: Math.round(r.height),
        borderLeft: pcs.borderLeftWidth, bg: pcs.backgroundColor, pos: cs.position,
        hasNow: pick.querySelector(".now") !== null, hasSelf: pick.querySelector(".self") !== null };
    });
    const rearAll = await page.$$eval('[data-testid^="mp-rear-pick-spot-"]', (e) =>
      e.map((x) => `${x.textContent}|${Math.round(x.getBoundingClientRect().width)}x${Math.round(x.getBoundingClientRect().height)}`));
    console.log(`   REARRANGE spot buttons: ${JSON.stringify(rearAll)}`);
    console.log(`   REARRANGE overlay: border-left ${rear.borderLeft} bg ${rear.bg} · spotbtn position ${rear.pos}`);
    yes("Rearrange spot buttons are still a bare number", /^\d+/.test(rear.text.trim()) && rear.text.trim().length <= 3, rear.text);
    eq("...and the overlay is still the white card, not the tinted attached box", [rear.borderLeft, rear.bg], ["1px", "rgb(255, 255, 255)"]);
    yes("...with no now or self mark reaching it", !rear.hasNow && !rear.hasSelf);
    eq("...and static positioning, so the now badge cannot anchor to it", rear.pos, "static");
    await ctx.close();
  }

  await browser.close();
  console.log(`\nverify-movepick: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}
main();
