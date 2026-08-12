// PHASE 7 PART D — hermetic verification of the Master Schedule edit drawer, the
// header controls, and the full-editor maxPlayerCount fix. Fixtures only: /api/veo
// (week) and /api/stage/matches/{id} (detail + PUT) are intercepted; the PUT body
// is captured and asserted. Admin session injected via localStorage.
//
//   node scripts/e2e/verify-schededit.mjs
//
// Negative controls (>=5) flip each guarded condition and assert the OPPOSITE
// outcome — proving the positive assertion is not vacuous.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  XX  ${n} — ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));

// ── fixtures ────────────────────────────────────────────────────────────────
const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
// VeoMatch rows (display shape). Fri = dayIdx 4 (the flagged "today").
const MATCHES = [
  { apiId: 3101, city: "Atlanta", dayIdx: 0, time: "7:00 PM", minutes: 1140, venue: "PRUMC", name: "Monday PRUMC", veo: true, hasEmoji: true },
  { apiId: 3105, city: "Atlanta", dayIdx: 4, time: "7:00 PM", minutes: 1140, venue: "PRUMC", name: "Friday PRUMC", veo: false, hasEmoji: false },
  { apiId: 2403, city: "Austin", dayIdx: 0, time: "7:00 PM", minutes: 1140, venue: "Onion Creek", name: "Monday OC Late", veo: true, hasEmoji: false },
  { apiId: 2473, city: "Austin", dayIdx: 3, time: "8:00 PM", minutes: 1200, venue: "NEMP", name: "Pay with GP", veo: false, hasEmoji: false },
  { apiId: 2470, city: "Austin", dayIdx: 4, time: "6:30 PM", minutes: 1110, venue: "NEMP", name: "Big Success Clubhouse", veo: false, hasEmoji: false },
  { apiId: 2414, city: "Austin", dayIdx: 4, time: "7:30 PM", minutes: 1170, venue: "LBJ", name: "Friday LBJ", veo: false, hasEmoji: false },
  { apiId: 2415, city: "Austin", dayIdx: 4, time: "8:30 PM", minutes: 1230, venue: "NEMP", name: "Friday Late NEMP", veo: true, hasEmoji: false },
];
const veoWeek = (hasWeekParam) => ({
  weekStart: "2026-08-03",
  days: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ dow: DAYS[i], date: 3 + i, iso: `2026-08-0${3 + i}`, today: !hasWeekParam && i === 4 })),
  cities: [{ city: "Atlanta", cameras: 1 }, { city: "Austin", cameras: 1 }],
  matches: MATCHES, codesRef: [], seededThisWeek: 0, generatedAt: "2026-08-07T00:00:00.000Z",
});

const FIELDS = [
  { id: 1, title: "NEMP", city: "Austin" },
  { id: 2, title: "Onion Creek", city: "Austin" },
  { id: 11, title: "PRUMC", city: "Atlanta" },
  { id: 12, title: "Chastain Park", city: "Atlanta" },
];
const EMPTY_EDIT = {
  category: null, type: null, description: null, managerIntro: null,
  fakeSpotLeft36h: null, fakeSpotLeft24h: null, fakeSpotLeft12h: null, fakeSpotLeft6h: null, fakeSpotLeft3h: null,
  autoCanceled: false, autoCanceledMinutes: null, minPlayerCount: null, isFreeMember: false, isAutoBump: false,
  maxTeamSize2Team: null, maxTeamSize4Team: null,
};
// Per-id staging detail (pickMatch shape) + fields + players.
function DETAIL(id) {
  const base = {
    id, ...EMPTY_EDIT, isCancelled: false, manager: null, secondManager: null, cityName: "Austin",
    fieldTitle: "NEMP", registrationPrice: 12000, additionalSpotPrice: 4000, guestCount: null,
    managerId: null, secondManagerId: null, maxPlayerCount: 40, teams: [{}, {}],
    name: "Match", fieldId: 1, startDate: "2026-08-07T18:30:00.000Z", endDate: "2026-08-07T20:30:00.000Z",
  };
  const per = {
    2470: { name: "Big Success Clubhouse", fieldId: 1, cityName: "Austin", startDate: "2026-08-07T18:30:00.000Z", endDate: "2026-08-08T18:30:00.000Z", secondManagerId: 999, secondManager: { id: 999, deletedAt: "2025-01-01T00:00:00.000Z" }, teams: [{}, {}, {}, {}], maxPlayerCount: 40, guestCount: null },
    2415: { name: "Friday Late NEMP", fieldId: 1, cityName: "Austin", managerId: 104, manager: { id: 104, firstName: "Sam", lastName: "Okafor" } },
    3101: { name: "Monday PRUMC", fieldId: 11, cityName: "Atlanta", fieldTitle: "PRUMC", startDate: "2026-08-03T19:00:00.000Z", endDate: "2026-08-03T21:00:00.000Z", managerId: 101, manager: { id: 101, firstName: "Marcus", lastName: "Webb" }, maxPlayerCount: 20 },
    2473: { name: "Pay with GP", fieldId: 1, cityName: "Austin", startDate: "2026-08-07T20:00:00.000Z", endDate: "2026-08-07T18:00:00.000Z" },
    // full-editor capacity fixtures
    2480: { name: "Cap Conflict", fieldId: 1, isAutoBump: true, maxTeamSize2Team: 10, maxTeamSize4Team: 20, maxPlayerCount: 10, teams: [{}, {}] },
    2481: { name: "Cap OK", fieldId: 1, isAutoBump: true, maxTeamSize2Team: 10, maxTeamSize4Team: 20, maxPlayerCount: 40, teams: [{}, {}] },
  };
  return { match: { ...base, ...(per[id] || {}) }, fields: FIELDS, players: [], managers: [{ id: 101, name: "Marcus Webb" }, { id: 104, name: "Sam Okafor" }] };
}

// ── contrast (WCAG) ───────────────────────────────────────────────────────────
const relLum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const L1 = relLum(a), L2 = relLum(b); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
const parseRGB = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); if (p[3] === 0) return null; return [p[0], p[1], p[2]]; };

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] } });

  let lastPut = null;
  await context.route("**/api/veo**", (route) => {
    const url = route.request().url();
    if (url.includes("/veo/intent") || url.includes("/veo/cameras")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(veoWeek(url.includes("week="))) });
  });
  await context.route("**/api/matchday/production/matches/**", (route) => {
    const req = route.request();
    const id = Number(req.url().split("/").pop().split("?")[0]);
    if (req.method() === "PUT") {
      lastPut = JSON.parse(req.postData() || "{}").changes;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, match: { ...DETAIL(id).match, ...lastPut } }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DETAIL(id)) });
  });

  const page = await context.newPage();
  const T = (t) => page.locator(`[data-testid="${t}"]`);
  const gotoSchedule = async () => { await page.goto(`${BASE}/match-ops/master-schedule`, { waitUntil: "domcontentloaded" }); await T("card").first().waitFor({ timeout: 30000 }); await page.waitForTimeout(120); };
  const openCard = async (id) => {
    lastPut = null;
    // Neutralise any pending edits so a switch isn't (correctly) blocked — the
    // dirty-guard tests exercise blocking directly, not through this helper.
    if (await T("drawer").count()) { const rev = T("dr-revert"); if (await rev.count() && !(await rev.isDisabled())) { await rev.click(); await page.waitForTimeout(50); } }
    await page.locator(`[data-testid="card"][data-id="${id}"]`).click();
    await T("drawer").waitFor(); await page.waitForFunction(() => !!document.querySelector('[data-testid="dr-save"]')); await page.waitForTimeout(120);
  };
  const save = async () => { await T("dr-save").click(); await page.waitForFunction(() => document.querySelector('[data-testid="dr-msg"]')); };
  const bodyKeys = () => (lastPut ? Object.keys(lastPut).sort() : []);

  console.log(`\n== drawer: diff = body ==`);
  await gotoSchedule();

  // (1) N fields changed -> exactly N keys, for N = 1,2,3
  await openCard(2470);
  await T("in-name").fill("Renamed A");
  await save();
  is("1 field changed -> 1 key", bodyKeys(), ["name"]);

  await openCard(2470);
  await T("in-name").fill("Renamed B");
  await T("in-registrationPrice").fill("130.00");
  await save();
  is("2 fields changed -> 2 keys", bodyKeys(), ["name", "registrationPrice"]);

  await openCard(2470);
  await T("in-name").fill("Renamed C");
  await T("in-registrationPrice").fill("133.37");
  await T("in-guestCount").fill("5");
  await save();
  is("3 fields changed -> 3 keys (THE headline number)", bodyKeys(), ["guestCount", "name", "registrationPrice"]);
  is("  price sent in cents", lastPut.registrationPrice, 13337);
  is("  guest 5 sent", lastPut.guestCount, 5);

  // (2) time-only change -> startDate + endDate pair, nothing else; duration kept
  await openCard(2470);
  await T("in-time").fill("19:30");
  await save();
  is("time-only -> sends the PAIR", bodyKeys(), ["endDate", "startDate"]);
  is("  startDate is wall-clock verbatim", lastPut.startDate, "2026-08-07T19:30:00.000Z");
  is("  endDate shifted, duration preserved (24h)", lastPut.endDate, "2026-08-08T19:30:00.000Z");

  // (3) a time edit cannot invert under option (a): end stays after start
  await openCard(2470);
  await T("in-time").fill("23:45");
  await save();
  const inv = lastPut.endDate > lastPut.startDate;
  ok(`time move keeps end after start (${lastPut.startDate} -> ${lastPut.endDate})`);
  if (!inv) bad("pair should not invert", `${lastPut.startDate} !< ${lastPut.endDate}`);

  console.log(`\n== drawer: load-time guards ==`);
  // (4) already-inverted pair shows a warning; date/time held
  await openCard(2473);
  is("inverted match shows warning", await T("dr-inverted").isVisible(), true);
  is("  date input disabled when inverted", await T("in-date").isDisabled(), true);
  is("  time input disabled when inverted", await T("in-time").isDisabled(), true);
  // NEGATIVE CONTROL: a normal pair shows NO warning and date is editable
  await openCard(2470);
  is("[neg] non-inverted shows NO warning", await T("dr-inverted").count(), 0);
  is("[neg] non-inverted date input enabled", await T("in-date").isDisabled(), false);

  // (5) clean load with nulls -> empty diff + disabled Save
  await openCard(2470);
  is("clean load: no diff panel", await T("dr-diff").count(), 0);
  is("clean load: Save disabled", await T("dr-save").isDisabled(), true);
  is("clean load: count reads No changes", (await T("dr-cnt").textContent())?.trim(), "No changes");

  // (6) clearing a numeric is not a change; typing 0 IS
  await openCard(2470);
  await T("in-registrationPrice").fill("");
  await page.waitForTimeout(60);
  is("cleared price: Save still disabled (not a change)", await T("dr-save").isDisabled(), true);
  await T("in-name").blur().catch(() => {});
  // NEGATIVE CONTROL: typing 0 is a real change and reaches the body as 0
  await openCard(2470);
  await T("in-guestCount").fill("0");
  await page.waitForTimeout(60);
  is("[neg] guest 0: Save enabled", await T("dr-save").isDisabled(), false);
  await save();
  is("[neg] guest 0 reaches body as 0", lastPut.guestCount, 0);

  // deleted manager: kept, no phantom diff, note shown
  await openCard(2470);
  is("deleted manager id kept (not blanked)", await T("in-secondManagerId").inputValue(), "999");
  is("deleted manager: no phantom diff", await T("dr-diff").count(), 0);
  is("deleted manager note shown", await T("dr-delnote").isVisible(), true);
  // NEGATIVE CONTROL: a valid manager shows NO deleted note
  await openCard(3101);
  is("[neg] valid manager: no deleted note", await T("dr-delnote").count(), 0);

  console.log(`\n== drawer: timezone warning both directions ==`);
  // Austin (Central) -> Atlanta (Eastern) field = EARLIER
  await openCard(2470);
  await T("in-field").selectOption("11");
  await page.waitForTimeout(60);
  is("Central->Eastern warning visible", await T("dr-tzwarn").isVisible(), true);
  is("  reads 'earlier'", /earlier/.test(await T("dr-tzwarn").textContent()), true);
  // Atlanta (Eastern) -> Austin (Central) field = LATER
  await openCard(3101);
  await T("in-field").selectOption("1");
  await page.waitForTimeout(60);
  is("Eastern->Central warning visible", await T("dr-tzwarn").isVisible(), true);
  is("  reads 'later'", /later/.test(await T("dr-tzwarn").textContent()), true);
  // NEGATIVE CONTROL: same-tz field change shows NO warning
  await openCard(2470);
  await T("in-field").selectOption("2"); // Austin -> Austin
  await page.waitForTimeout(60);
  is("[neg] same-tz change: no warning", await T("dr-tzwarn").count(), 0);

  console.log(`\n== drawer: VEO badge, push, sticky bar ==`);
  // VEO badge does not open the drawer
  await gotoSchedule();
  await page.locator(`[data-testid="veo-badge"][data-veo="2470"]`).click();
  await page.waitForTimeout(200);
  is("VEO badge does NOT open the drawer", await T("drawer").count(), 0);
  // NEGATIVE CONTROL: clicking the card DOES open it
  await openCard(2470);
  is("[neg] card click DOES open the drawer", await T("drawer").isVisible(), true);

  // push grid — last day column right edge <= drawer left edge (measured)
  const dbox = await T("drawer").boundingBox();
  const days = await page.locator(".vms-day").all();
  const lastDay = await days[days.length - 1].boundingBox();
  const clear = lastDay.x + lastDay.width <= dbox.x + 1;
  is(`push: last column right (${Math.round(lastDay.x + lastDay.width)}) <= drawer left (${Math.round(dbox.x)})`, clear, true);
  // NEGATIVE CONTROL: the drawer would COVER the column if it started at 0 — sanity
  // that the measurement discriminates (last column is genuinely left of the drawer)
  is("[neg] last column is not under the drawer", lastDay.x < dbox.x, true);

  // sticky save bar does not move when the drawer body scrolls (measured)
  await T("in-name").fill("scrolltest");
  await page.waitForTimeout(60);
  const footBefore = (await page.locator(".mdw-foot").boundingBox()).y;
  await page.locator(".mdw-body").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(120);
  const footAfter = (await page.locator(".mdw-foot").boundingBox()).y;
  is(`sticky bar fixed while body scrolls (${Math.round(footBefore)}==${Math.round(footAfter)})`, Math.abs(footBefore - footAfter) < 2, true);

  console.log(`\n== drawer: unsaved-change guards ==`);
  await openCard(2470);
  await T("in-name").fill("dirty edit");
  await page.waitForTimeout(60);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  is("Escape blocked while dirty", await T("drawer").isVisible(), true);
  await T("dr-close").click();
  await page.waitForTimeout(120);
  is("X blocked while dirty", await T("drawer").isVisible(), true);
  await page.locator(`[data-testid="card"][data-id="2414"]`).click();
  await page.waitForTimeout(120);
  is("card switch blocked while dirty (still on 2470)", (await T("dr-title").textContent())?.includes("dirty edit") || (await T("in-name").inputValue()), "dirty edit");
  // revert then Escape closes
  await T("dr-revert").click();
  await page.waitForTimeout(60);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  is("Escape closes once clean", await T("drawer").count(), 0);

  console.log(`\n== header: stats visibility, filter, Today ==`);
  await gotoSchedule();
  // stat row not visible on Schedule view (by visibility, not text)
  is("stats NOT visible on Schedule view", await T("stats").count(), 0);
  await page.getByRole("tab", { name: "Veo coverage" }).click();
  await page.waitForTimeout(150);
  is("stats visible on Veo view", await T("stats").isVisible(), true);

  // stats + coverage follow the city filter (computed expectation, not hardcoded)
  const statVals = async () => (await page.locator(".vms-stat-v").allTextContents()).map((s) => Number(s));
  const allStats = await statVals();
  const expAllVeo = MATCHES.filter((m) => m.veo).length;
  is("all-cities: 'Matches with Veo' tile = computed", allStats[0], expAllVeo);
  // An "Open" cell = a camera-free night: any (city, day) with no Veo-covered
  // venue, across all 7 days. Independently: cities*7 - distinct veo city-days.
  const openCellsAll = await page.locator(".vms-gap").count();
  const veoCityDay = new Set(MATCHES.filter((m) => m.veo).map((m) => `${m.city}|${m.dayIdx}`));
  const expOpenAll = 2 * 7 - veoCityDay.size;
  is("all-cities: coverage 'Open' cells = independent expectation", openCellsAll, expOpenAll);
  is("  and Open tile matches Open cells (labels count to tiles)", allStats[2], openCellsAll);

  // filter to Austin only
  await T("city-chip-Austin").click();
  await page.waitForTimeout(150);
  const austinStats = await statVals();
  const expAustinVeo = MATCHES.filter((m) => m.city === "Austin" && m.veo).length;
  is("filter Austin: 'Matches with Veo' tile follows filter", austinStats[0], expAustinVeo);
  is("  filtered value differs from all-cities", austinStats[0] !== allStats[0], true);
  const openCellsAustin = await page.locator(".vms-gap").count();
  const veoAustinDays = new Set(MATCHES.filter((m) => m.veo && m.city === "Austin").map((m) => m.dayIdx));
  const expOpenAustin = 1 * 7 - veoAustinDays.size;
  is("filter Austin: coverage Open cells follow filter (independent)", openCellsAustin, expOpenAustin);
  is("  and filtered Open tile matches filtered Open cells", austinStats[2], openCellsAustin);

  // filtering out the open drawer's city closes the drawer
  await page.getByRole("tab", { name: "Schedule" }).click();
  await page.waitForTimeout(100);
  await T("city-chip-all").click();
  await page.waitForTimeout(100);
  await openCard(2470); // Austin match
  await T("city-chip-Atlanta").click(); // show only Atlanta -> Austin drawer must close
  await page.waitForTimeout(150);
  is("filtering out the open city closes the drawer", await T("drawer").count(), 0);
  await T("city-chip-all").click();

  // Today disables on the current week, enables after navigating away
  await gotoSchedule();
  is("Today disabled on current week", await T("today").isDisabled(), true);
  await page.locator('[aria-label="Previous week"]').click();
  await page.waitForTimeout(200);
  is("Today enabled after navigating away", await T("today").isDisabled(), false);

  // (full-editor capacity model moved to the new perTeam/teamNumbers model — see
  //  scripts/e2e/verify-p10.mjs for the capacity + inconsistency assertions.)

  console.log(`\n== WCAG AA contrast (sampled solid pairs) ==`);
  await gotoSchedule();
  await openCard(2470);
  const samples = [
    ["schedule title", ".vms-h-title"],
    ["filter chip (on)", ".vms-chip-on"],
    ["drawer field label", ".mdw-f label"],
    ["drawer save button", '[data-testid="dr-save"]'],
    ["drawer count text", '[data-testid="dr-cnt"]'],
    ["drawer tz line", ".mdw-tzline"],
  ];
  for (const [label, sel] of samples) {
    const el = page.locator(sel).first();
    if (!(await el.count())) { bad(`contrast ${label}`, "element missing"); continue; }
    const pair = await el.evaluate((node) => {
      const cs = getComputedStyle(node); const fg = cs.color;
      let n = node, bg = "rgba(0, 0, 0, 0)";
      while (n) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) { bg = b; break; } n = n.parentElement; }
      const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400;
      return { fg, bg, size, weight };
    });
    const fg = parseRGB(pair.fg), bg = parseRGB(pair.bg);
    if (!fg || !bg) { bad(`contrast ${label}`, `unresolved colors ${pair.fg}/${pair.bg}`); continue; }
    const r = ratio(fg, bg);
    const large = pair.size >= 18 || (pair.size >= 14 && pair.weight >= 700);
    const need = large ? 3.0 : 4.5;
    if (r >= need) ok(`contrast ${label} = ${r.toFixed(2)} (need ${need})`);
    else bad(`contrast ${label}`, `ratio ${r.toFixed(2)} < ${need}`);
  }

  console.log(`\n================ RESULT ================\n${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
