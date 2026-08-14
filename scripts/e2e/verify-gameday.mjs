// Gameday Ops, driven in a real browser, hermetic.
//
// THE DETAIL CARD VIEW WAS REMOVED — Snapshot is the only layout, and this suite used to force
// `gameday-view: detail` in an init script, so it was the Detail suite by construction. What
// remains here is the coverage verify-snapshot.mjs does NOT have: day navigation, city filters,
// empty states, opening the match panel, cross-timezone ordering, and the header's refresh +
// freshness stamp. Every card-internal assertion was removed as obsolete rather than duplicated
// into verify-snapshot, which already proves the same rules against Snapshot. Itemised in the
// commit message.
//
// Phase 15 PART H origin — The live day
// route /api/matchday/**/gameday and /api/veo are route-fulfilled with a synthetic
// day whose kickoff instants are computed RELATIVE to now, so bands/colours are
// deterministic without freezing the clock. Desktop + a 390×844 touch context.
//   node scripts/e2e/verify-gameday.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();
import { contrast, overflow } from "./checks.mjs";

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/match-ops/gameday`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const near = (n, got, want, tol) => (Math.abs(got - want) <= tol ? ok(n) : bad(n, `got ${got} want ${want}±${tol}`));

// The edit screens grey out their write affordances unless the user holds EDIT MATCHES
// (Phase 17). The test identity doesn't, so patch the app_users read useAuth makes to
// grant it — hermetic, independent of live DB grants. The SERVER still enforces it.
const grantEdit = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch();
  let json = await res.json().catch(() => null);
  const patch = (r) => ({ ...r, can_edit_matches: true, can_access_matchops: true });
  json = Array.isArray(json) ? json.map(patch) : (json && typeof json === "object" ? patch(json) : json);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(json) });
});

// scoped contrast (roster-suite pattern) — the board is what Phase 15 owns
async function contrastIn(pg) {
  return pg.evaluate(() => {
    const root = document.querySelector(".gdo"); if (!root) return { failures: [], min: Infinity };
    const pc = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map(x => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a, b) => { const x = L(a), y = L(b), hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); };
    const bg = (el) => { let n = el; while (n && n.nodeType === 1) { const c = pc(getComputedStyle(n).backgroundColor); if (c && c.a > 0.85) return c; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const txt = (el) => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const vis = (el) => { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false; return el.offsetParent !== null || s.position === "fixed"; };
    const failures = []; let min = Infinity;
    for (const el of root.querySelectorAll("*")) { if (!txt(el) || !vis(el)) continue; const fg = pc(getComputedStyle(el).color); if (!fg) continue; const r = ratio(fg, bg(el)); if (r < min) min = Math.round(r * 100) / 100; if (r < 4.5) failures.push({ ratio: Math.round(r * 100) / 100, t: el.textContent.trim().slice(0, 32), c: (el.getAttribute("class") || "").slice(0, 34) }); }
    return { failures, min };
  });
}

// ── the synthetic day (kickoffs relative to the mock's now) ──────────────────
const MIN = 60000, HR = 3600000;
function fixture(base, todayYMD) {
  const iso = (offMin) => new Date(base + offMin * MIN).toISOString();
  const mk = (o) => ({
    id: 0, name: "M", isCancelled: false, autoCanceled: true, autoCanceledMinutes: 0, minPlayerCount: 11, maxPlayerCount: 20,
    registrationPrice: 1200, additionalSpotPrice: 400, fakeSpotLeft36h: 0, fakeSpotLeft24h: 0,
    fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0, isAutoBump: false, category: "OPEN", type: "REGULAR",
    _count: { players: 6, fakePlayers: 0 }, manager: { firstName: "Sam", lastName: "Webb" },
    teams: [{ teamNumber: 1 }, { teamNumber: 2 }],
    field: { title: "PRUMC", city: { id: 1, name: "Austin", timeZone: { abbr: "CDT" } } },
    startDate: `${todayYMD}T18:00:00.000`, ...o,
  });
  const city = (name, abbr) => ({ id: 1, name, timeZone: { abbr } });
  return [
    // ATLANTA crit + cross-tz order: earlier INSTANT (now+120m) but LATER wall clock (8 PM)
    mk({ id: 501, name: "PRUMC Atlanta", startDateUtc: iso(120), startDate: `${todayYMD}T20:00:00.000`, autoCanceledMinutes: 30, _count: { players: 3, fakePlayers: 0 }, field: { title: "PRUMC", city: city("Atlanta", "EDT") } }),
    // AUSTIN made-it, later INSTANT (now+150m) but earlier wall clock (7 PM)
    mk({ id: 502, name: "NEMP Austin", startDateUtc: iso(150), startDate: `${todayYMD}T19:00:00.000`, _count: { players: 15, fakePlayers: 0 }, field: { title: "NEMP", city: city("Austin", "CDT") } }),
    // DALLAS warn (deadline 3.9h out, still in the four-hour band)
    mk({ id: 503, name: "Kiest Dallas", startDateUtc: iso(234), _count: { players: 6, fakePlayers: 0 }, field: { title: "Kiest", city: city("Dallas", "CDT") } }),
    // HOUSTON later, made-it, next-release maths: fakes 6 -> 3h rung 2 => +4 in 2h
    mk({ id: 504, name: "Memorial Houston", startDateUtc: iso(300), minPlayerCount: 8, _count: { players: 14, fakePlayers: 6 }, fakeSpotLeft6h: 4, fakeSpotLeft3h: 2, field: { title: "Memorial", city: city("Houston", "CDT") } }),
    // CANCELLED (sinks, no countdown/releases, never coloured)
    mk({ id: 505, name: "Round Rock", isCancelled: true, startDateUtc: iso(90), _count: { players: 3, fakePlayers: 0 }, field: { title: "Round Rock", city: city("Austin", "CDT") } }),
    // FINISHED (>90m ago, never coloured)
    mk({ id: 506, name: "Blossom AM", startDateUtc: iso(-120), _count: { players: 3, fakePlayers: 0 }, field: { title: "Blossom", city: city("Austin", "CDT") } }),
    // LIVE (kicked off)
    mk({ id: 507, name: "Will Rogers", startDateUtc: iso(-30), _count: { players: 14, fakePlayers: 0 }, field: { title: "Will Rogers", city: city("Dallas", "CDT") } }),
    // AUTO-CANCEL OFF. Deliberately sited so the DEADLINE is the ONLY thing that could put it in
    // Needs attention: kickoff +190m (past the <180m "spots unsold" flag), a manager present, no
    // fakes, short of the minimum, and a 75m lead => deadline 115m out, inside the 2h "decide soon"
    // window. On the OLD logic that is red with a live countdown; with the switch off there is no
    // deadline at all, so it must be neither.
    mk({ id: 509, name: "No-AC Dallas", autoCanceled: false, autoCanceledMinutes: 75, startDateUtc: iso(190), _count: { players: 3, fakePlayers: 0 }, field: { title: "Kiest", city: city("Dallas", "CDT") } }),
    // SPECIAL EVENT (no cap)
    mk({ id: 508, name: "Chastain Event", startDateUtc: iso(180), maxPlayerCount: null, _count: { players: 5, fakePlayers: 0 }, field: { title: "Chastain", city: city("Houston", "CDT") } }),
  ];
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const todayYMD = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const tomorrowYMD = (() => { const d = new Date(Date.now() + 24 * HR); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const yesterdayYMD = (() => { const d = new Date(Date.now() - 24 * HR); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  // A day where EVERYTHING is finished or cancelled — must render with NO "still to come"
  // header (that is the real production "today" once matches are done).
  const allDone = (base) => [
    { id: 701, name: "Done AM", isCancelled: false, autoCanceledMinutes: 60, minPlayerCount: 11, maxPlayerCount: 20, registrationPrice: 1200, additionalSpotPrice: 400, fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0, isAutoBump: false, category: "OPEN", type: "REGULAR", _count: { players: 14, fakePlayers: 0 }, manager: { firstName: "Sam", lastName: "Webb" }, teams: [{ teamNumber: 1 }], startDate: `${yesterdayYMD}T09:00:00.000`, startDateUtc: new Date(base - 6 * HR).toISOString(), field: { title: "NEMP", city: { id: 1, name: "Austin", timeZone: { abbr: "CDT" } } } },
    { id: 702, name: "Cx PM", isCancelled: true, autoCanceledMinutes: 60, minPlayerCount: 11, maxPlayerCount: 20, registrationPrice: 1200, additionalSpotPrice: 400, fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0, isAutoBump: false, category: "OPEN", type: "REGULAR", _count: { players: 3, fakePlayers: 0 }, manager: null, teams: [{ teamNumber: 1 }], startDate: `${yesterdayYMD}T18:00:00.000`, startDateUtc: new Date(base - 3 * HR).toISOString(), field: { title: "Kiest", city: { id: 1, name: "Dallas", timeZone: { abbr: "CDT" } } } },
  ];

  const routes = async (ctx) => {
    await ctx.route("**/api/matchday/**/gameday**", (route) => {
      const url = new URL(route.request().url()); const date = url.searchParams.get("date");
      const base = Date.now();
      // tomorrow: a short match FAR from its deadline -> must NOT be coloured
      const matches = date === todayYMD ? fixture(base, todayYMD)
        : date === yesterdayYMD ? allDone(base)
        : date === tomorrowYMD ? [{ id: 601, name: "Sunday NEMP", isCancelled: false, autoCanceledMinutes: 75, minPlayerCount: 11, maxPlayerCount: 20, registrationPrice: 1200, additionalSpotPrice: 400, fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0, isAutoBump: false, category: "OPEN", type: "REGULAR", _count: { players: 4, fakePlayers: 0 }, manager: { firstName: "Sam", lastName: "Webb" }, teams: [{ teamNumber: 1 }], startDate: `${tomorrowYMD}T18:00:00.000`, startDateUtc: new Date(base + 26 * HR).toISOString(), field: { title: "NEMP", city: { id: 1, name: "Austin", timeZone: { abbr: "CDT" } } } }]
        : [];
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ date, env: "production", matches }) });
    });
    await ctx.route("**/api/veo**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: [] }) }));
    // the in-place match panel (replaced the drawer) loads these when a tile opens it
    await ctx.route(/\/api\/matchday\/production\/matches\/\d+(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ match: { id: 502, name: "Board Match", type: "REGULAR", managerId: null, secondManagerId: null, fieldId: 1, startDate: "2026-08-12T19:00:00.000Z", endDate: "2026-08-12T20:00:00.000Z", registrationPrice: 1000, additionalSpotPrice: null, guestCount: 0, isFreeMember: false, maxPlayerCount: 20, fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0, autoCanceled: false, autoCanceledMinutes: 60, minPlayerCount: 10, isAutoBump: false, maxTeamSize2Team: 20, maxTeamSize4Team: 40, description: "", managerIntro: "", teams: [{ teamNumber: 1 }, { teamNumber: 2 }], occupancy: 0, realOccupancy: 0, cityName: "Austin", fieldTitle: "NEMP" }, fields: [], players: [], managers: [] }) }));
    await ctx.route(/\/api\/matchday\/production\/roster\/\d+(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matchId: 502, name: "Board Match", teams: [{ id: 1, teamNumber: 1, name: "A", locked: false }, { id: 2, teamNumber: 2, name: "B", locked: false }], players: [], shape: { teamN: 2, perTeam: 10 }, maxPlayerCount: 20, occupancy: 0 }) }));
    await grantEdit(ctx);
  };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, storageState });
  await routes(ctx);
  const page = await ctx.newPage();
  const load = async () => { await page.goto(PAGE, { waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-testid="snapshot"]', { timeout: 30000 }); await page.waitForTimeout(150); };
  const tilesIn = (group) => page.$$eval(`[data-testid="snap-group-${group}"] [data-testid="snap-row"]`, (els) => els.map((e) => Number(e.getAttribute("data-id"))));
  const row = (id) => `[data-testid="snap-row"][data-id="${id}"]`;

  await load();

  // ══ BUG 1 — a match with AUTO-CANCEL OFF must show no deadline and not be "needs attention"
  //    for deadline reasons. Fixture 508 is short of its minimum AND close to kickoff, so it would
  //    be red on the old logic; with the switch off it must be neither.
  { await page.click('[data-testid="filter-all"]'); await page.waitForTimeout(150);
    const cell = await page.$eval(row(509) + ' .c-cxl', (e) => e.textContent.replace(/\s+/g, " ").trim());
    eq("auto-cancel OFF: the row shows no decide-by countdown, it says so", {
      noAc: !!(await page.$(row(509) + ' [data-testid="snap-noac"]')),
      text: /no auto-cancel/.test(cell), noCountdown: !/left|passed/.test(cell),
      rail: await page.$eval(row(509), (e) => e.getAttribute("data-rail")),
    }, { noAc: true, text: true, noCountdown: true, rail: "green" });
    await page.click('[data-testid="filter-att"]'); await page.waitForTimeout(200);
    eq("auto-cancel OFF: the match is NOT in Needs attention on a deadline basis",
      await page.$$eval('[data-testid="snap-row"]', (els) => els.map((e) => Number(e.getAttribute("data-id")))).then((ids) => ids.includes(509)), false);
    await page.click('[data-testid="filter-all"]'); await page.waitForTimeout(150); }

  // ── cross-timezone ordering: the board interleaves by the actual instant ──
  { const order = await tilesIn("todo");
    eq("still-to-come: 501 (ATL) ordered before 502 (AUS) despite later wall clock", order.indexOf(501) >= 0 && order.indexOf(501) < order.indexOf(502), true); }
  // Original body kept: the cell must LEAD with the clock then the zone (startsWith, not includes).
  // Only the selector moved (tile-when → .c-time); the snapshot cell concatenates the two nodes with
  // no space, so the comparison strips whitespace on both sides rather than weakening to includes().
  eq("Atlanta row shows the earlier clock is later wall-time (8:00 PM EDT)",
    (await page.$eval(row(501) + ' .c-time', (e) => e.textContent)).replace(/\s+/g, "").startsWith("8:00PMEDT"), true);

  // ── grouping ──
  eq("group order is todo, in-play, cancelled, finished",
    await page.$$eval('[data-testid="snapshot"] > section', (els) => els.map((e) => e.getAttribute("data-testid"))),
    ["snap-group-todo", "snap-group-inplay", "snap-group-cancelled", "snap-group-finished"]);
  eq("a kicked-off match (507) sits in IN PLAY, not still-to-come",
    await page.$eval(row(507), (e) => e.closest("section").getAttribute("data-testid")), "snap-group-inplay");
  eq("505 is cancelled, 506 finished", {
    cx: await page.$eval(row(505), (e) => e.closest("section").getAttribute("data-testid")),
    fin: await page.$eval(row(506), (e) => e.closest("section").getAttribute("data-testid")),
  }, { cx: "snap-group-cancelled", fin: "snap-group-finished" });

  // ── filters ──
  await page.click('[data-testid="filter-att"]'); await page.waitForTimeout(150);
  eq("Needs attention excludes cancelled and finished", {
    cx: await page.$('[data-testid="snap-group-cancelled"]'), fin: await page.$('[data-testid="snap-group-finished"]'),
  }, { cx: null, fin: null });
  await page.click('[data-testid="filter-all"]'); await page.waitForTimeout(150);

  // ── the city filter drives the STATS, not just the grid (original bodies, re-pointed) ──
  { const before = await page.$eval('[data-testid="filter-all"] .b', (e) => Number(e.textContent));
    await page.click('[data-testid="city-Atlanta"]'); await page.waitForTimeout(120);
    const after = await page.$eval('[data-testid="filter-all"] .b', (e) => Number(e.textContent));
    const tiles = await page.$$eval('[data-testid="snap-row"]', (els) => els.length);
    eq("selecting a city changes the All count (stats derive from scope)", { before, after, tiles }, { before: 9, after: 1, tiles: 1 });
    // Atlanta has only the one still-to-come match -> empty groups render NO header.
    eq("empty groups render no header (Atlanta: only still-to-come)", { todo: !!(await page.$('[data-testid="snap-group-todo"]')), cx: await page.$('[data-testid="snap-group-cancelled"]'), fin: await page.$('[data-testid="snap-group-finished"]') }, { todo: true, cx: null, fin: null });
    await page.click('[data-testid="city-all"]'); await page.waitForTimeout(120); }

  // ── day navigation + the empty state ──
  await page.click('[data-testid="day-prev"]'); await page.waitForSelector('[data-testid="snapshot"]', { timeout: 10000 }); await page.waitForTimeout(200);
  eq("all-done day: renders groups, and NO empty 'still to come' header", {
    empty: !!(await page.$('[data-testid="empty"]')), todo: await page.$('[data-testid="snap-group-todo"]'),
    cx: !!(await page.$('[data-testid="snap-group-cancelled"]')), fin: !!(await page.$('[data-testid="snap-group-finished"]')),
  }, { empty: false, todo: null, cx: true, fin: true });
  await page.click('[data-testid="day-today"]'); await page.waitForSelector('[data-testid="snap-group-todo"]', { timeout: 10000 }); await page.waitForTimeout(150);

  // ── clicking the row opens the IN-PLACE MATCH PANEL (original bodies, re-pointed) ──
  await page.click(row(502));
  await page.waitForSelector('[data-testid="gday-panel"]', { timeout: 8000 });
  eq("clicking the row opens the in-place match panel", await page.$$eval('[data-testid="gday-panel"]', (e) => e.length), 1);
  eq("old side-panel markup gone (count 0) and no 'Open full editor' anywhere", await page.evaluate(() => ({
    drawer: document.querySelectorAll('.mdw,[data-testid="drawer"]').length,
    fulleditor: document.querySelectorAll('[data-testid="dr-fulleditor"]').length,
    text: [...document.querySelectorAll("*")].some((e) => e.children.length === 0 && /Open full editor/i.test(e.textContent || "")) ? 1 : 0,
  })), { drawer: 0, fulleditor: 0, text: 0 });
  await page.click('[data-testid="gday-panel-close"]'); await page.waitForTimeout(200);

  // ── contrast + overflow sweeps (layout-independent; restored, they were never Detail-specific) ──
  { const c = await contrastIn(page);
    c.failures.length === 0 ? ok(`contrast: every board node >= 4.5:1 (min ${c.min})`) : bad(`contrast: ${c.failures.length} node(s) < 4.5`, c.failures.slice(0, 5).map((f) => `${f.ratio} "${f.t}" .${f.c}`).join(" | ")); }
  { const o = await overflow(page); (!o.pageLeak) ? ok("no page-level horizontal overflow at 1600") : bad("overflow", JSON.stringify(o.offenders.slice(0, 3))); }

  // ── the day picker: Today disabled on today (restored) ──
  eq("Today button disabled while on today", await page.$eval('[data-testid="day-today"]', (b) => b.disabled), true);
  await page.click('[data-testid="day-next"]'); await page.waitForSelector('[data-testid="snapshot"]'); await page.waitForTimeout(200);
  eq("Today re-enables on another day", await page.$eval('[data-testid="day-today"]', (b) => b.disabled), false);
  await page.click('[data-testid="day-today"]'); await page.waitForSelector('[data-testid="snap-group-todo"]'); await page.waitForTimeout(150);

  // ══ THE TOGGLE IS GONE ══
  eq("the Snapshot/Detail toggle is absent from the DOM (both the desktop and mobile copies)", {
    snap: await page.$$eval('[data-testid="view-snapshot"], [data-testid="m-view-snapshot"]', (e) => e.length),
    detail: await page.$$eval('[data-testid="view-detail"], [data-testid="m-view-detail"]', (e) => e.length),
    bands: await page.$$eval('[data-testid="bands"]', (e) => e.length),
  }, { snap: 0, detail: 0, bands: 0 });
  // a stale ?view=detail bookmark must simply load the page
  await page.goto(PAGE + "?view=detail", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="snapshot"]', { timeout: 20000 });
  eq("a stale ?view=detail bookmark still loads Snapshot, not a blank page", {
    snapshot: !!(await page.$('[data-testid="snapshot"]')), rows: (await page.$$('[data-testid="snap-row"]')).length > 0,
  }, { snapshot: true, rows: true });

  // ══ REFRESH ══
  eq("the refresh button and the freshness stamp render in the header", {
    btn: !!(await page.$('[data-testid="gday-refresh"]')), stamp: !!(await page.$('[data-testid="updated-at"]')),
  }, { btn: true, stamp: true });
  { const t0 = await page.$eval('[data-testid="updated-at"]', (e) => e.textContent.trim());
    eq("the stamp reads 'Updated <time>', not a ticking clock", /^Updated \d/.test(t0), true); }

  // disabled while in flight — hold the response open so the button is observably disabled
  { let release; const gate = new Promise((r) => { release = r; });
    await ctx.route("**/api/matchday/**/gameday**", async (route) => { await gate; route.fallback(); });
    await page.click('[data-testid="gday-refresh"]');
    await page.waitForTimeout(250);
    const during = await page.$eval('[data-testid="gday-refresh"]', (e) => e.disabled);
    // the glyph is now the SHARED RefreshIcon component, used by every refresh control
    const spinning = await page.$eval('[data-testid="gday-refresh"] [data-testid="refresh-icon"]', (e) => e.getAttribute("data-spinning") === "true");
    release(); await page.waitForTimeout(600);
    const after = await page.$eval('[data-testid="gday-refresh"]', (e) => e.disabled);
    await ctx.unroute("**/api/matchday/**/gameday**");
    eq("refresh is disabled and spinning WHILE in flight, and re-enabled after", { during, spinning, after }, { during: true, spinning: true, after: false }); }

  // filters + city + day survive a refresh
  await page.click('[data-testid="filter-att"]'); await page.click('[data-testid="city-Atlanta"]'); await page.waitForTimeout(200);
  { const state = async () => ({
      att: await page.$eval('[data-testid="filter-att"]', (e) => e.className.includes("on")),
      city: await page.$eval('[data-testid="city-Atlanta"]', (e) => e.className.includes("on")),
      day: await page.$eval('[data-testid="daylab"]', (e) => e.textContent.trim()),
    });
    const before = await state();
    await page.click('[data-testid="gday-refresh"]'); await page.waitForTimeout(800);
    eq("a refresh preserves the filter, the city chip and the day being viewed", await state(), before); }
  await page.click('[data-testid="filter-all"]'); await page.click('[data-testid="city-all"]'); await page.waitForTimeout(200);

  // a FAILED refresh keeps the rows and marks the stamp
  // let the previous refresh settle before taking the baseline — measuring mid-flight captured the
  // still-filtered count and made this assertion a flake
  await page.waitForFunction(() => !document.querySelector('[data-testid="gday-refresh"]').disabled, null, { timeout: 10000 });
  await page.waitForTimeout(400);
  { const rowsBefore = (await page.$$('[data-testid="snap-row"]')).length;
    await ctx.route("**/api/matchday/**/gameday**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
    await page.click('[data-testid="gday-refresh"]'); await page.waitForTimeout(900);
    const stamp = await page.$eval('[data-testid="updated-at"]', (e) => e.textContent.trim());
    await ctx.unroute("**/api/matchday/**/gameday**");
    eq("a failed refresh KEEPS the old rows and says the refresh failed", {
      rows: (await page.$$('[data-testid="snap-row"]')).length, failed: /couldn.t refresh/i.test(stamp), table: !!(await page.$('[data-testid="snapshot"]')),
    }, { rows: rowsBefore, failed: true, table: true }); }

  // ── the header layout bug: the badge and the stamp must not overlap ──
  { const box = async (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
    const pill = await box('[data-testid="gameday-env"]'); const fresh = await box('[data-testid="fresh"]');
    const overlaps = !(fresh.r <= pill.l + 1 || fresh.l >= pill.r - 1 || fresh.b <= pill.t + 1 || fresh.t >= pill.b - 1);
    eq("1600: the PRODUCTION — LIVE EDITS badge and the freshness stamp do not overlap", overlaps, false); }

  // ── 390px touch context (RESTORED). Only ONE of the original four assertions here was
  //    Detail-specific ("tile stats stack to one column"); the other three are layout-independent
  //    and dropping them left this page with ZERO mobile cover. Bodies are the originals.
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState });
  await routes(pctx);
  const ph = await pctx.newPage();
  // REAL SAFE-AREA INSETS. Chromium reports env(safe-area-inset-*) as 0 in a plain 390px window,
  // which is exactly why the status-bar collision shipped: a narrow desktop viewport cannot see it.
  // Force the four insets so the assertions below run against a phone-shaped page.
  // globals.css routes the insets through --sat/--sab exactly so a harness can force a notch;
  // a raw env() could not be overridden and therefore could not be tested.
  const SAT = 59; // iPhone 14 Pro portrait status bar / Dynamic Island
  // The clock is installed BEFORE navigation so Date.now() is controllable — fastForward later
  // proves the freshness stamp actually ages instead of waiting three real minutes.
  await ph.clock.install();
  await ph.goto(PAGE, { waitUntil: "domcontentloaded" }); await ph.waitForSelector('[data-testid="snap-group-todo"]'); await ph.waitForTimeout(200);
  // Forced insets, set AFTER load: addInitScript runs before documentElement exists, so the inline
  // property never landed and --sat read 0 — i.e. the notch was not actually simulated.
  await ph.evaluate((sat) => {
    document.documentElement.style.setProperty("--sat", `${sat}px`);
    document.documentElement.style.setProperty("--sab", "34px");
  }, SAT);
  { const o = await overflow(ph); const past = await ph.evaluate(() => { const w = innerWidth;
      const inScroller = (el) => { let n = el.parentElement; while (n) { const s = getComputedStyle(n); if (s.overflowX === "auto" || s.overflowX === "scroll") return true; n = n.parentElement; } return false; };
      return [...document.querySelectorAll(".gdo *")].filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return s.display !== "none" && r.width > 0 && r.right > w + 1 && !inScroller(e); }).map((e) => (e.getAttribute("class") || e.tagName).toString().slice(0, 30)); });
    (!o.pageLeak && past.length === 0) ? ok("phone: no horizontal scroll (city chips scroll intentionally), nothing past the edge") : bad("phone overflow", `leak=${o.pageLeak} past=${JSON.stringify([...new Set(past)].slice(0, 6))}`); }
  { const small = await ph.evaluate(() => { const out = []; for (const el of document.querySelectorAll('.gdo button, .gdo [role="switch"], .gdo [role="link"]')) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || r.width === 0) continue; if (r.height < 32) out.push({ c: (el.className || "").toString().slice(0, 22), h: Math.round(r.height * 10) / 10 }); } return out; });
    small.length === 0 ? ok("phone: every control >= 32px tall") : bad(`phone: ${small.length} under 32px`, JSON.stringify(small.slice(0, 6))); }
  // ══ BUG 2 — the refresh must be reachable in PORTRAIT, at a real tap size, with the stamp.
  //    It shipped broken because it was only ever asserted at 1600, where the desktop header shows.
  { const r = await ph.$eval('[data-testid="m-gday-refresh"]', (e) => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e);
      return { w: b.width, h: b.height, visible: s.display !== "none" && s.visibility !== "hidden" && b.width > 0, right: b.right, top: b.top }; });
    const stamp = await ph.$eval('[data-testid="m-updated-at"]', (e) => ({ text: e.textContent.trim(), visible: getComputedStyle(e).display !== "none" }));
    const vw = await ph.evaluate(() => innerWidth);
    eq("390x844 PORTRAIT: refresh is visible, >=44px, on screen, and the freshness text is present", {
      visible: r.visible, big: r.w >= 43 && r.h >= 43, onScreen: r.right <= vw + 1 && r.top >= 0,
      stampShown: stamp.visible, stampHasText: stamp.text.length > 0,
    }, { visible: true, big: true, onScreen: true, stampShown: true, stampHasText: true }); }
  // the desktop header (where it used to live) is genuinely hidden here — proving the old placement
  // could not have worked in portrait
  eq("390 portrait: the desktop header block is display:none, which is why the old placement failed",
    await ph.$eval('.gdo .head', (e) => getComputedStyle(e).display), "none");
  // and the empty leftover toggle container is gone (it rendered as a small grey dot)
  eq("390 portrait: the empty leftover toggle container is gone", await ph.$$eval('.gdo .mseg', (e) => e.length), 0);

  // ══ the refresh ICON is a real glyph, not an empty ring ══
  eq("390 portrait: the refresh control renders an actual icon element with drawn paths", await ph.$eval('[data-testid="m-gday-refresh"] [data-testid="refresh-icon"]', (e) => ({
    tag: e.tagName.toLowerCase(), paths: e.querySelectorAll("path").length,
    hasGeometry: [...e.querySelectorAll("path")].every((p) => (p.getAttribute("d") || "").length > 8),
    box: e.getBoundingClientRect().width > 10,
  })), { tag: "svg", paths: 2, hasGeometry: true, box: true });

  // ══ the panel CLOSE button must clear the status bar ══
  await ph.click('[data-testid="snap-row"][data-id="502"]');
  await ph.waitForSelector('[data-testid="gday-panel-close"]', { timeout: 10000 });
  { const r = await ph.$eval('[data-testid="gday-panel-close"]', (e) => { const b = e.getBoundingClientRect(); return { top: b.top, h: b.height, w: b.width }; });
    const sat = await ph.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sat")) || 0);
    eq("390 portrait + 59px notch: Close sits BELOW the safe-area inset and is >=44px",
      { clearsInset: r.top >= sat, bigEnough: r.h >= 43 && r.w >= 43, sat },
      { clearsInset: true, bigEnough: true, sat: 59 }); }
  await ph.click('[data-testid="gday-panel-close"]'); await ph.waitForTimeout(200);

  // ══ the stamp AGES: past 2 minutes it keeps the clock, appends the age, and goes muted ══
  { const before = await ph.$eval('[data-testid="m-updated-at"]', (e) => e.textContent.trim());
    await ph.clock.fastForward("03:10"); // past the 2-minute threshold, without waiting for it
    await ph.waitForTimeout(400);
    const after = await ph.$eval('[data-testid="m-updated-at"]', (e) => ({ text: e.textContent.trim(), muted: e.className.includes("stale") }));
    eq("390 portrait: a stamp older than 2 minutes keeps its clock, appends the age, and is muted",
      { aged: /·\s*\dm ago$/.test(after.text), keptClock: /\d{1,2}:\d{2}/.test(after.text), muted: after.muted, changed: after.text !== before },
      { aged: true, keptClock: true, muted: true, changed: true }); }

  { const c = await contrastIn(ph); c.failures.length === 0 ? ok(`phone contrast: every board node >= 4.5:1 (min ${c.min})`) : bad(`phone contrast: ${c.failures.length} < 4.5`, c.failures.slice(0, 5).map((f) => `${f.ratio} "${f.t}"`).join(" | ")); }

  await browser.close();
  console.log(`\n${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log(fails.map((f) => `  ✗ ${f}`).join("\n")); process.exit(1); }
}

main().catch(fatal);
