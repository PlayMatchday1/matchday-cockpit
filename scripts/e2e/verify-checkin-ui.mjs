// Phase 26 — Manager Check-In, rendered. Assertions at 390px AND 1600px.
// Tolerances, not pixel-exact bounds: a 1px spread failing an 8px assertion is a flake, not a bug.
//   node scripts/e2e/verify-checkin-ui.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const MATCH = 424242;
const PAGE = `${BASE}/matchops/checkin/${MATCH}`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// 4 teams × 9 = 36 total, matching production match 17522's real shape.
const TEAMS = [1, 2, 3, 4].map((n) => ({ teamNumber: n, name: ["", "White", "Green", "Orange", "Blue"][n], id: n }));
const P = (i, team, num, name, opts = {}) => ({
  userMatchId: 1000 + i, playerId: 2000 + i, fullName: name, team, playerNumber: num,
  avatar: opts.avatar ?? null, userType: opts.userType ?? "PLAYER",
});
const PLAYERS = [
  P(1, 1, 1, "Ravi Chandrasekaran"),            // long name → "Ravi C.", search by full name
  P(2, 1, 2, "Tom Weir", { avatar: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }),
  P(3, 1, 3, "Marcus Oyelaran-Whyte"),
  P(4, 2, 1, "Ana Diaz"),
  P(5, 2, 2, "Bilal Khan", { userType: "GUEST" }),
  P(6, 3, 1, "Sam Ito"),
];
// team 4 is FULLY MARKED in the seed so the collapse assertion has something to bite on
const SEED_MARKS = [{ playerId: 2007, status: "ok" }];
PLAYERS.push(P(7, 4, 1, "Nia Boateng"));

const payload = (marks) => ({
  match: { id: MATCH, name: "HOU Sunday 8v8", fieldTitle: "Bear Creek", startDate: null, cityName: "HOU",
    maxPlayerCount: 36, maxTeamSize2Team: 18, maxTeamSize4Team: 36, isCancelled: false },
  teams: TEAMS, players: PLAYERS,
  marks: marks.map((m) => ({ ...m, strikeValue: m.status === "late" ? 1 : m.status === "no_show" ? 2 : 0, pushed: false, pushError: null })),
  result: null, pushEnabled: false,
});

async function routes(ctx, state) {
  await ctx.route(`**/api/matchops/checkin/${MATCH}**`, async (route) => {
    const req = route.request(); const m = req.method();
    const json = (o, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(o) });
    if (m === "GET") return json(payload(state.marks));
    if (m === "DELETE") { const id = Number(new URL(req.url, BASE).searchParams.get("playerId")); state.marks = state.marks.filter((x) => x.playerId !== id); return json({ ok: true }); }
    const b = JSON.parse(req.postData() || "{}");
    if (b.kind === "mark") {
      if (state.failMarks) return json({ error: "nope" }, 502);
      state.marks = [...state.marks.filter((x) => x.playerId !== b.playerId), { playerId: b.playerId, status: b.status }];
      return json({ ok: true });
    }
    return json({ ok: true });
  });
  await ctx.route("**/rest/v1/app_users*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch(); let b = await res.json().catch(() => null);
    const p = (r) => ({ ...r, can_access_matchops: true });
    b = Array.isArray(b) ? b.map(p) : (b && typeof b === "object" ? p(b) : b);
    return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(b) });
  });
}

const rows = (page) => page.$$eval('[data-testid="player-row"]', (a) => a.map((e) => ({ id: e.getAttribute("data-player-id"), status: e.getAttribute("data-status"), sync: e.getAttribute("data-sync") })));

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });
  try {
    const state = { marks: [...SEED_MARKS], failMarks: false };
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState });
    await routes(ctx, state);
    const page = await ctx.newPage();
    await page.goto(PAGE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="player-row"]', { timeout: 25000 });

    // ── nothing is sent to MatchDay, said permanently ──
    eq("the 'not yet sent to MatchDay' line is present and persistent",
      (await page.$eval('[data-testid="not-sent"]', (e) => e.textContent.trim())), "Recorded in Clubhouse. Not yet sent to MatchDay.");

    // ── to-do is the default, and the list SHRINKS after a mark ──
    eq("to-do is the DEFAULT filter", await page.$eval('[data-testid="filter-chip"][data-filter="todo"]', (e) => e.getAttribute("data-on")), "true");
    const before = (await rows(page)).length;
    await page.click('[data-testid="player-row"][data-player-id="2001"] [data-testid="mark-btn"][data-mark="ok"]');
    await page.waitForTimeout(500);
    const after = (await rows(page)).length;
    eq("marking a player SHRINKS the to-do list by one", { before, after }, { before, after: before - 1 });

    // ── tap-again clears ──
    await page.click('[data-testid="filter-chip"][data-filter="all"]');
    await page.waitForTimeout(250);
    eq("the marked player shows its status under All", await page.$eval('[data-testid="player-row"][data-player-id="2001"]', (e) => e.getAttribute("data-status")), "ok");
    await page.click('[data-testid="player-row"][data-player-id="2001"] [data-testid="mark-btn"][data-mark="ok"]');
    await page.waitForTimeout(500);
    eq("tapping the SAME mark clears it (the undo)", await page.$eval('[data-testid="player-row"][data-player-id="2001"]', (e) => e.getAttribute("data-status")), "");

    // ── the cost is on the BUTTON, and no running total is shown ──
    eq("the strike cost is on the buttons (+1 / +2) and no player total is rendered", {
      late: await page.$eval('[data-testid="player-row"][data-player-id="2001"] [data-mark="late"]', (e) => e.textContent.includes("+1")),
      no: await page.$eval('[data-testid="player-row"][data-player-id="2001"] [data-mark="no_show"]', (e) => e.textContent.includes("+2")),
      okHasNoCost: await page.$eval('[data-testid="player-row"][data-player-id="2001"] [data-mark="ok"]', (e) => /\+\d/.test(e.textContent)),
      noTotals: !(await page.content()).match(/strikes? (?:so far|total|this season)/i),
    }, { late: true, no: true, okHasNoCost: false, noTotals: true });

    // ── a failed sync shows the STATUS AND the failure, never bare "NOT SAVED" ──
    state.failMarks = true;
    await page.click('[data-testid="player-row"][data-player-id="2004"] [data-testid="mark-btn"][data-mark="late"]');
    await page.waitForTimeout(700);
    const meta = await page.$eval('[data-testid="player-row"][data-player-id="2004"] [data-testid="player-meta"]', (e) => e.textContent.trim());
    eq("a failed row shows STATUS AND failure, not just NOT SAVED", {
      hasStatus: meta.startsWith("Late"), hasFailure: meta.includes("NOT SAVED"),
      retryBar: await page.$$eval('[data-testid="retry-bar"]', (e) => e.length),
    }, { hasStatus: true, hasFailure: true, retryBar: 1 });
    state.failMarks = false;

    // ── search finds a shortened-name player by their FULL name ──
    eq("the row shows a shortened name", await page.$eval('[data-testid="player-row"][data-player-id="2001"] [data-testid="player-name"]', (e) => e.textContent.trim()), "Ravi C.");
    await page.fill('[data-testid="checkin-search"]', "Chandrasekaran");
    await page.waitForTimeout(350);
    eq("searching the FULL name finds the shortened row", (await rows(page)).map((r) => r.id), ["2001"]);
    await page.fill('[data-testid="checkin-search"]', "");
    await page.waitForTimeout(250);

    // ── a fully-marked team is collapsed ──
    eq("a team whose players are all marked is collapsed",
      await page.$eval('[data-testid="team-block"][data-team="4"]', (e) => e.getAttribute("data-collapsed")), "true");
    await page.click('[data-testid="team-block"][data-team="4"] [data-testid="team-head"]');
    await page.waitForTimeout(250);
    eq("re-opening it sticks", await page.$eval('[data-testid="team-block"][data-team="4"]', (e) => e.getAttribute("data-collapsed")), "false");

    // ── the two-step move reaches a SPOT GRID sized from the match, not a hardcoded 9 ──
    await page.click('[data-testid="player-row"][data-player-id="2004"] [data-testid="move-open"]');
    await page.waitForSelector('[data-testid="move-sheet"]', { timeout: 8000 });
    eq("step 1 is the team picker, not a flat list of everyone", {
      teams: await page.$$eval('[data-testid="move-team"]', (e) => e.length),
      grid: await page.$$eval('[data-testid="spot-grid"]', (e) => e.length),
    }, { teams: 4, grid: 0 });
    await page.click('[data-testid="move-team"][data-team="3"]');
    await page.waitForSelector('[data-testid="spot-grid"]', { timeout: 5000 });
    eq("step 2 is the spot grid, 9 spots (36 ÷ 4 teams — derived, not hardcoded)", {
      spots: await page.$$eval('[data-testid="spot"]', (e) => e.length),
      occupied: await page.$$eval('[data-testid="spot"][data-occupied="true"]', (e) => e.length),
    }, { spots: 9, occupied: 1 });
    await page.keyboard.press("Escape").catch(() => {});
    await page.click('[data-testid="move-sheet"] [data-testid="move-back"]').catch(() => {});

    // ── 390px layout: tap targets ≥44 (with tolerance) and no horizontal overflow ──
    const at390 = await page.evaluate(() => {
      const de = document.documentElement;
      const clipped = (el) => { let a = el.parentElement; while (a && a !== de) { const o = getComputedStyle(a).overflowX; if (o === "auto" || o === "hidden" || o === "scroll") return true; a = a.parentElement; } return false; };
      const tapish = [...document.querySelectorAll('[data-testid="mark-btn"],[data-testid="filter-chip"],[data-testid="move-open"],[data-testid="winner-open"]')];
      const small = tapish.map((e) => e.getBoundingClientRect()).filter((r) => Math.min(r.width, r.height) < 43).length; // 44 with 1px tolerance
      return { overflow: de.scrollWidth - de.clientWidth, small, taps: tapish.length,
        unclipped: [...document.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > de.clientWidth + 1 && !clipped(e)).length };
    });
    eq("390: no horizontal overflow, and every tap target is ≥44px (1px tolerance)",
      { overflow: at390.overflow, unclipped: at390.unclipped, tooSmall: at390.small, checked: at390.taps > 6 },
      { overflow: 0, unclipped: 0, tooSmall: 0, checked: true });

    // ── 1600px: not broken, and the column does not stretch across the screen ──
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForTimeout(400);
    const at1600 = await page.evaluate(() => {
      const de = document.documentElement;
      const wrap = document.querySelector(".cin-wrap").getBoundingClientRect();
      const row = document.querySelector('[data-testid="player-row"]').getBoundingClientRect();
      return { overflow: de.scrollWidth - de.clientWidth, wrapW: Math.round(wrap.width), rowRight: Math.round(row.right), vw: de.clientWidth };
    });
    eq("1600: no overflow, and the phone column is centred rather than stretched", {
      overflow: at1600.overflow,
      columnIsBounded: at1600.wrapW <= 600,          // tolerance around the 560px max
      rowInside: at1600.rowRight <= at1600.vw + 1,
    }, { overflow: 0, columnIsBounded: true, rowInside: true });

    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log(fails.map((f) => `  ✗ ${f}`).join("\n")); process.exit(1); }
}

main().catch(fatal);
