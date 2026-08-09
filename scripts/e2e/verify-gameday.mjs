// Phase 15 PART H — Gameday Ops, driven in a real browser, hermetic. The live day
// route /api/matchday/**/gameday and /api/veo are route-fulfilled with a synthetic
// day whose kickoff instants are computed RELATIVE to now, so bands/colours are
// deterministic without freezing the clock. Desktop + a 390×844 touch context.
//   node scripts/e2e/verify-gameday.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
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
    id: 0, name: "M", isCancelled: false, autoCanceledMinutes: 0, minPlayerCount: 11, maxPlayerCount: 20,
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
    // SPECIAL EVENT (no cap)
    mk({ id: 508, name: "Chastain Event", startDateUtc: iso(180), maxPlayerCount: null, _count: { players: 5, fakePlayers: 0 }, field: { title: "Chastain", city: city("Houston", "CDT") } }),
  ];
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const todayYMD = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const tomorrowYMD = (() => { const d = new Date(Date.now() + 24 * HR); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

  const routes = async (ctx) => {
    await ctx.route("**/api/matchday/**/gameday**", (route) => {
      const url = new URL(route.request().url()); const date = url.searchParams.get("date");
      const base = Date.now();
      // tomorrow: a short match FAR from its deadline -> must NOT be coloured
      const matches = date === todayYMD ? fixture(base, todayYMD)
        : date === tomorrowYMD ? [{ id: 601, name: "Sunday NEMP", isCancelled: false, autoCanceledMinutes: 75, minPlayerCount: 11, maxPlayerCount: 20, registrationPrice: 1200, additionalSpotPrice: 400, fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0, isAutoBump: false, category: "OPEN", type: "REGULAR", _count: { players: 4, fakePlayers: 0 }, manager: { firstName: "Sam", lastName: "Webb" }, teams: [{ teamNumber: 1 }], startDate: `${tomorrowYMD}T18:00:00.000`, startDateUtc: new Date(base + 26 * HR).toISOString(), field: { title: "NEMP", city: { id: 1, name: "Austin", timeZone: { abbr: "CDT" } } } }]
        : [];
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ date, env: "production", matches }) });
    });
    await ctx.route("**/api/veo**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: [] }) }));
    await grantEdit(ctx);
  };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, storageState });
  await routes(ctx);
  const page = await ctx.newPage();
  const load = async () => { await page.goto(PAGE, { waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-testid="bands"]', { timeout: 30000 }); await page.waitForTimeout(150); };
  const tilesIn = (band) => page.$$eval(`[data-testid="band-${band}"] [data-testid="tile"]`, (els) => els.map((e) => Number(e.getAttribute("data-id"))));
  const tile = (id) => `[data-testid="tile"][data-id="${id}"]`;

  await load();

  // ── real kickoff order within a band; Atlanta (later clock) ahead of Austin ──
  eq("soon band: real kickoff order (ATL 501 before AUS 502, despite later clock)", (await tilesIn("soon")).slice(0, 2), [501, 502]);
  eq("Atlanta tile shows the earlier clock is later wall-time (8:00 PM EDT)", (await page.$eval(tile(501) + ' [data-testid="tile-when"]', (e) => e.textContent)).replace(/\s+/g, " ").trim().startsWith("8:00 PM EDT"), true);

  // ── real + fake + open == capacity exactly; fakes within room ──
  // 504: _count {players:14, fakePlayers:6} — REAL is 8 (14-6), not the occupied 14.
  { const nums = (await page.$eval(tile(504) + ' [data-testid="fill-nums"]', (e) => e.textContent)).replace(/\s+/g, " ");
    eq("real is occupied MINUS fakes (8 real · 6 fake · 6 open of 20), NOT 14 real", /8 real · 6 fake · 6 open of 20/.test(nums), true);
    ok(!/14 real/.test(nums) ? "the fake double-count bug is gone (never shows 14 real)" : bad("still shows 14 real")); }

  // ── next release matches ladder maths, tile says the same ──
  eq("next release: Houston +4 in 2h at the 3h mark", (await page.$eval(tile(504) + ' [data-testid="next-release"]', (e) => e.textContent)).replace(/\s+/g, " ").trim(), "+4 in 2h 0m, at the 3h mark");
  eq("the 3h rung is marked as next-to-fire", await page.$eval(tile(504) + ' [data-testid="rung-3"]', (e) => e.className.includes("next")), true);

  // ── tile colour by DEADLINE distance, both thresholds; never on made/finished/cancelled ──
  eq("crit tile (Atlanta, deadline <3h + short)", await page.$eval(tile(501), (e) => e.getAttribute("data-ac")), "crit");
  eq("warn tile (Dallas, deadline 3-6h + short)", await page.$eval(tile(503), (e) => e.getAttribute("data-ac")), "warn");
  eq("made-it match never coloured (Austin 502)", await page.$eval(tile(502), (e) => e.getAttribute("data-ac")), "");
  eq("finished match never coloured (506)", await page.$eval(tile(506), (e) => e.getAttribute("data-ac")), "");
  eq("cancelled match never coloured (505)", await page.$eval(tile(505), (e) => e.getAttribute("data-ac")), "");

  // ── the marker's measured position and the band's measured width ──
  { const bar = await page.$eval(tile(501) + ' [data-testid="fill-bar"]', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, w: r.width }; });
    const mk = await page.$eval(tile(501) + ' [data-testid="fill-marker"]', (e) => e.getBoundingClientRect().left);
    const gap = await page.$eval(tile(501) + ' [data-testid="fill-gap"]', (e) => e.getBoundingClientRect().width);
    near("marker measured at minPlayers/capacity (11/20 = 55%)", (mk - bar.left) / bar.w * 100, 55, 2);
    near("hatched band measured width IS the shortfall ((11-3)/20 = 40%)", gap / bar.w * 100, 40, 2); }
  { const outside = await page.$eval(tile(501) + ' [data-testid="fill-marker"]', (e) => { const bar = e.parentElement.querySelector('[data-testid="fill-bar"]'); return getComputedStyle(bar).overflow === "hidden" && e.parentElement.contains(e) && !bar.contains(e); });
    ok(outside ? "marker sits outside the bar's clip (label not cut off)" : bad("marker clipped")); }

  // ── both minimum states, mutually exclusive ──
  { const s = await page.$eval(tile(501) + ' [data-testid="minlab"]', (e) => e.textContent);
    const m = await page.$eval(tile(502) + ' [data-testid="minlab"]', (e) => e.textContent);
    eq("short shows TO GO not MADE IT", { togo: /TO GO/.test(s), made: /MADE IT/.test(s) }, { togo: true, made: false });
    eq("cleared shows MADE IT not TO GO", { togo: /TO GO/.test(m), made: /MADE IT/.test(m) }, { togo: false, made: true }); }
  eq("short tile has a shortfall band; made tile has none", { short: !!(await page.$(tile(501) + ' [data-testid="fill-gap"]')), made: !!(await page.$(tile(502) + ' [data-testid="fill-gap"]')) }, { short: true, made: false });

  // ── cancelled sinks below everything, no countdown, no releases ──
  eq("cancelled is in the last band (cx)", (await page.$$eval('[data-testid="bands"] .band', (els) => els.map((e) => [...e.classList], ))) && (await page.$$eval('[data-testid="bands"] > section', (els) => els[els.length - 1].getAttribute("data-testid"))), "band-cx");
  eq("cancelled tile: no countdown, no next release", { cd: (await page.$eval(tile(505) + ' [data-testid="tile-when"]', (e) => e.textContent)).replace(/\s+/g, " ").trim(), rel: await page.$eval(tile(505) + ' [data-testid="next-release"]', (e) => e.textContent).catch(() => "") }, { cd: "6:00 PM CDT", rel: "" });

  // ── special-event (no cap): no bar/marker, says so ──
  eq("special event (no cap) shows no bar and says so", { nums: /no cap/.test(await page.$eval(tile(508) + ' [data-testid="fill-nums"]', (e) => e.textContent)), bar: !!(await page.$(tile(508) + ' [data-testid="fill-bar"]')) }, { nums: true, bar: false });

  // ── the city filter drives the STATS, not just the grid ──
  { const before = await page.$eval('[data-testid="filter-all"] .b', (e) => Number(e.textContent));
    await page.click('[data-testid="city-Atlanta"]'); await page.waitForTimeout(120);
    const after = await page.$eval('[data-testid="filter-all"] .b', (e) => Number(e.textContent));
    const tiles = await page.$$eval('[data-testid="tile"]', (els) => els.length);
    eq("selecting a city changes the All count (stats derive from scope)", { before, after, tiles }, { before: 8, after: 1, tiles: 1 });
    await page.click('[data-testid="city-all"]'); await page.waitForTimeout(120); }

  // ── the tile is structurally whole: one button, roster+veo are SPANS ──
  { const whole = await page.$eval(tile(501), (t) => ({
      when: !!t.querySelector('[data-testid="tile-when"]'), meta: !!t.querySelector('[data-testid="tile-meta"]'), stats: !!t.querySelector('[data-testid="tile-stats"]'),
      nestedButtons: t.querySelectorAll("button").length, rosterTag: t.querySelector('[data-testid="roster-link"]')?.tagName, veoTag: t.querySelector('[data-testid="veo-badge"]')?.tagName,
    }));
    eq("tile contains all three blocks, no nested <button>, roster+veo are SPANs", whole, { when: true, meta: true, stats: true, nestedButtons: 0, rosterTag: "SPAN", veoTag: "SPAN" }); }

  // ── clicking the tile body opens the drawer; the roster link does NOT ──
  await page.click(tile(502) + ' [data-testid="tile-when"]');
  await page.waitForTimeout(300);
  eq("clicking the tile opens the edit drawer", !!(await page.$('[data-testid="gameday"] aside, .mdw, [role="dialog"]')) || (await page.$$('input')).length > 0, true);
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);

  // ── contrast sweep: normal + amber + red tiles on screen ──
  { const c = await contrastIn(page);
    c.failures.length === 0 ? ok(`contrast: every board node >= 4.5:1 (min ${c.min}, incl. amber + red tiles)`) : bad(`contrast: ${c.failures.length} node(s) < 4.5`, c.failures.slice(0, 5).map((f) => `${f.ratio} "${f.t}" .${f.c}`).join(" | ")); }
  { await page.setViewportSize({ width: 1600, height: 1200 }); const o = await overflow(page); (!o.pageLeak) ? ok("no page-level horizontal overflow at 1600") : bad("overflow", JSON.stringify(o.offenders.slice(0, 3))); await page.setViewportSize({ width: 1440, height: 1200 }); }

  // ── the day picker: Today disabled on today; nothing tomorrow is coloured ──
  eq("Today button disabled while on today", await page.$eval('[data-testid="day-today"]', (b) => b.disabled), true);
  await page.click('[data-testid="day-next"]'); await page.waitForSelector('[data-testid="bands"]'); await page.waitForTimeout(200);
  eq("Today re-enables on another day", await page.$eval('[data-testid="day-today"]', (b) => b.disabled), false);
  { const coloured = await page.$$eval('[data-testid="tile"]', (els) => els.filter((e) => e.getAttribute("data-ac")).map((e) => e.getAttribute("data-id")));
    eq("nothing tomorrow is coloured (no day-early auto-cancel)", coloured, []); }
  await page.click('[data-testid="day-today"]'); await page.waitForSelector('[data-testid="band-soon"]'); await page.waitForTimeout(150);

  // ── the roster link navigates to the roster, not the drawer (do this last: it navigates away) ──
  const drawerBefore = (await page.$$('input')).length;
  await page.click(tile(501) + ' [data-testid="roster-link"]');
  await page.waitForURL("**/matches/501/roster", { timeout: 15000 }).catch(() => {});
  eq("roster link goes to /match-ops/matches/501/roster (not the drawer)", { url: page.url().includes("/matches/501/roster"), openedDrawer: (await page.$$('input')).length > drawerBefore }, { url: true, openedDrawer: false });

  // ══════════════ PHONE (390×844, touch) ══════════════
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState });
  await routes(pctx);
  const ph = await pctx.newPage();
  await ph.goto(PAGE, { waitUntil: "domcontentloaded" }); await ph.waitForSelector('[data-testid="band-soon"]'); await ph.waitForTimeout(200);
  { const o = await overflow(ph); const past = await ph.evaluate(() => { const w = innerWidth;
      const inScroller = (el) => { let n = el.parentElement; while (n) { const s = getComputedStyle(n); if (s.overflowX === "auto" || s.overflowX === "scroll") return true; n = n.parentElement; } return false; };
      return [...document.querySelectorAll(".gdo *")].filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return s.display !== "none" && r.width > 0 && r.right > w + 1 && !inScroller(e); }).map((e) => (e.getAttribute("class") || e.tagName).toString().slice(0, 30)); });
    (!o.pageLeak && past.length === 0) ? ok("phone: no horizontal scroll (city chips scroll intentionally), nothing past the edge") : bad("phone overflow", `leak=${o.pageLeak} past=${JSON.stringify([...new Set(past)].slice(0, 6))}`); }
  eq("phone: tile stats stack to one column", await ph.$eval(tile(501) + ' [data-testid="tile-stats"]', (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length), 1);
  { const small = await ph.evaluate(() => { const out = []; for (const el of document.querySelectorAll('.gdo button, .gdo [role="switch"], .gdo [role="link"]')) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || r.width === 0) continue; if (r.height < 32) out.push({ c: (el.className || "").toString().slice(0, 22), h: Math.round(r.height * 10) / 10 }); } return out; });
    small.length === 0 ? ok("phone: every control >= 32px tall") : bad(`phone: ${small.length} under 32px`, JSON.stringify(small.slice(0, 6))); }
  { const c = await contrastIn(ph); c.failures.length === 0 ? ok(`phone contrast: every board node >= 4.5:1 (min ${c.min})`) : bad(`phone contrast: ${c.failures.length} < 4.5`, c.failures.slice(0, 5).map((f) => `${f.ratio} "${f.t}"`).join(" | ")); }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
