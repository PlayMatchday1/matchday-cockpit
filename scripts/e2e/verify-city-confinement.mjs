// THE CITY-MANAGER CONFINEMENT, driven as a REAL city-manager session (Phase 29b).
// KNOWN FAILURE, PRE-EXISTING: 5 assertions fail on the DFW city-manager account — the reviews
// city filter returns zero rows. It is NOT waiting on a Warsaw account and NOT waiting on a
// migration; both Warsaw accounts have existed since 14 and 21 August. Do not re-derive this.
//
// This suite exists because the leak it covers was invisible to every other suite. A DFW city
// manager could open the whole Match Ops estate — Master Schedule, Slate Review, Field Ops,
// Inventory, Change Log and Player Lookup (player PII for EVERY city) — because the tier was
// ADDITIVE: the account also held can_access_matchops, and the Match Ops gate requires exactly
// that flag and knew nothing about the tier.
//
// DRIVEN THROUGH THE REAL app_users ROW, NOT A STUB. verify-city-manager.mjs patches app_users
// with a browser route handler, which only reaches the CLIENT — the server gate reads the
// database directly, so a stub can prove nothing about it. This mints a session for an ACTUAL
// city-manager account (rmancuso1@gmail.com, scoped ATX) so every status below is the real gate's
// answer. ATX is used rather than DFW because ATX has match data: "exactly one city" is a
// meaningful assertion over rows that exist, and vacuous over an empty set.
//
// ASSERTED ON THE PAYLOAD, NOT THE RENDER. CSS hiding a row is not scoping.
//
//   node scripts/e2e/verify-city-confinement.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, closeContext, sessionFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
// ITEMISED (identity, not rule): was rmancuso1@gmail.com, which was DELETED through the User
// access screen on 2026-08-18 at 20:16. Its auth record outlived its app_users row, so sessionFor
// still minted a token and every assertion came back 401 "Invalid session" instead of the 403 it
// was testing for. garrettsuits@gmail.com is a real ATX tier holder — same scope, same assertions.
const CITY_MANAGER = "garrettsuits@gmail.com";   // real tier holder, city_identifier = ATX
const SCOPE = "ATX";
// The API's own name for that scope. The board and the payload both speak city NAMES
// (field.city.name), not identifiers — CITY_SCOPES pins the pair and city-scope-test.ts guards it.
const SCOPE_NAME = "Austin";
const OTHER_CITY = "DFW";
// A SECOND CITY MANAGER, DELIBERATELY DFW. Everything else here runs as ATX — and Austin is the
// ONE city where cityScope's platform label and cityMap's cockpit name are the same string
// ("Austin"). That made the whole fixture the degenerate case: a filter comparing a raw name to a
// normalised one matched in Austin and dropped every row everywhere else, and this suite could
// not see it. DFW is "Dallas / Fort Worth" → "Dallas", so it is the case that exercises the join.
const CITY_MANAGER_DFW = "rgmstrategicventures@gmail.com";
const SCOPE_DFW = "DFW";
const ADMIN = "rmancuso@playmatchday.com";
// ONE day for every board assertion, so the city board and the admin board are compared over the
// same matches. Not "today": a date with no matches would make every row/rail comparison pass by
// having nothing to compare.
const BOARD_DATE = "2026-08-16";

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// EVERY page the tier must not reach. Asserted on the ROUTE returning 403 — a hidden nav item
// over a live route is exactly the bug this closes.
const FORBIDDEN = [
  ["Player Lookup (player PII, every city)", "/api/lookup/production?q=test"],
  ["Gameday (the operator board)", "/api/matchday/production/gameday?date=2026-08-15"],
  ["Match detail", "/api/matchday/production/matches/17516"],
  ["Roster (player names + phones)", "/api/matchday/production/roster/17516"],
  ["Cancel preview (credits + texts)", "/api/matchday/production/matches/17516/cancel"],
  ["Promo Codes", "/api/promos/list?bucket=live"],
  ["Promo detail", "/api/promos/detail/101"],
  ["Slate Review notes", "/api/slate-notes?week=2026-08-10"],
  ["Change Log", "/api/changelog?limit=1"],
  ["Check-in", "/api/matchops/checkin/17516"],
];

async function main() {
  process.loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const ref = new URL(url).host.split(".")[0];

  // Confirm the tier holder is really what we think BEFORE asserting anything about it — a
  // confinement suite that silently ran against a non-city-manager would pass for the wrong reason.
  const { data: row } = await svc.from("app_users").select("email,is_admin,is_city_manager,city_identifier,can_access_matchops").eq("email", CITY_MANAGER).maybeSingle();
  eq("the account under test really is a city manager, scoped, and not an admin",
    { cm: row?.is_city_manager, city: row?.city_identifier, admin: row?.is_admin }, { cm: true, city: SCOPE, admin: false });

  // TWO IDENTITIES, EACH NAMED. sessionFor caches per email, so this costs at most two magic links
  // per hour across the WHOLE gate rather than two more on top of thirty-one others. The identity
  // is the cache key, so a city-manager call can never be served an admin session.
  const cmSession = await sessionFor(CITY_MANAGER);
  const adminSession = await sessionFor(ADMIN);

  // WHOSE TOKEN IS WHOSE, asserted before anything is refused. A refusal probe proves nothing
  // unless the credentials it holds are the ones under test: an admin token refused by a
  // city-manager guard would be a passing test of the wrong thing, and pointing this at the wrong
  // variable is how a pay-arrival probe once became a real production write.
  const whoIs = async (tok) => {
    const { data } = await svc.auth.getUser(tok);
    return data?.user?.email ?? null;
  };
  eq("the city-manager session really belongs to the city manager", await whoIs(cmSession.access_token), CITY_MANAGER);
  eq("…and the admin session really belongs to the admin", await whoIs(adminSession.access_token), ADMIN);
  eq("…and they are different tokens", cmSession.access_token !== adminSession.access_token, true);

  const browser = await chromium.launch({ headless: true });
  const ctxFor = (session, viewport = { width: 1600, height: 1000 }) => browser.newContext({
    viewport,
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] },
  });

  // Whose token the `call` helper uses. Reassigned once, when the admin half begins.
  let session0 = cmSession.access_token;
  // Call a route AS the session, straight from the page — the real gate, the real row.
  const call = (page, path) => page.evaluate(async ([p, tok]) => {
    const r = await fetch(p, { headers: { Authorization: `Bearer ${tok}` }, cache: "no-store" });
    let body = null; try { body = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, body };
  }, [path, session0]);

  const cmCtx = await ctxFor(cmSession);
  const cm = await cmCtx.newPage();
  await cm.goto(`${BASE}/city/manager-pay`, { waitUntil: "domcontentloaded" });
  await cm.waitForTimeout(600);

  console.log(`city-manager confinement — real session, ${CITY_MANAGER} (${SCOPE})\n`);

  // ── 1. THE THREE PAGES load and return SINGLE-CITY data ──────────────────
  console.log("the three pages — payload, not render:");
  {
    const g = await call(cm, `/api/city/gameday?date=${BOARD_DATE}`);
    eq("Gameday Ops: the route answers for a city manager", g.status, 200);
    if (g.status === 200) {
      eq("…scoped to their city", g.body.scope, SCOPE);
      // THE CITY IS READ OFF THE ROW, not assumed. The route now serves the live API shape, where
      // the city lives at field.city.name — the same field the admin board draws its chips from.
      // Defaulting a missing city to SCOPE (as this once did) would make the check unfalsifiable.
      const cities = new Set((g.body.matches ?? []).map((m) => m.field?.city?.name ?? "(missing)"));
      eq("…and the PAYLOAD carries rows from exactly one city", [...cities].length <= 1, true);
      if (cities.size === 1) eq("…and it is THEIR city, by name", [...cities][0], SCOPE_NAME);
      // SAME SHAPE AS THE ADMIN BOARD. This is what makes the page the real board rather than a
      // rebuild: the fake-spot ladder, the auto-cancel switch and the observed counts are exactly
      // the fields the rails, the countdown and the decide-by deadline render from. The old
      // mirror-backed payload carried none of them, which is WHY the page had to be a rebuild.
      const m0 = (g.body.matches ?? [])[0];
      if (m0) {
        const need = ["fakeSpotLeft36h", "fakeSpotLeft24h", "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h",
          "autoCanceled", "autoCanceledMinutes", "minPlayerCount", "maxPlayerCount", "startDateUtc", "_count"];
        const missing = need.filter((k) => !Object.prototype.hasOwnProperty.call(m0, k));
        eq("…and every field the REAL board renders from is present (same shape as the admin route)", missing, []);
      }
      eq("…and no roster is returned at all (no player PII on this page)",
        (g.body.matches ?? []).every((m) => m.players === undefined && m.roster === undefined), true);
    }
  }
  {
    const r = await call(cm, `/api/reviews`);
    eq("Reviews: the route answers for a city manager", r.status, 200);
    if (r.status === 200) {
      const cities = new Set((r.body.rows ?? []).map((x) => x.city_name ?? x.city_identifier).filter(Boolean));
      eq("…and the PAYLOAD carries at most one city", cities.size <= 1, true);
    }
  }
  {
    const w = await call(cm, `/api/manager-pay/city-week?week=2026-08-10`);
    eq("Manager Pay: the route answers for a city manager", w.status, 200);
    if (w.status === 200) {
      const secs = w.body.sections ?? w.body.cities ?? [];
      const ids = new Set(secs.map((s) => s.cityIdentifier).filter(Boolean));
      eq("…and the PAYLOAD carries exactly one city section", ids.size <= 1, true);
      if (ids.size === 1) eq("…and it is THEIR city", [...ids][0], SCOPE);
    }
  }

  // ── 2. EVERY OTHER ROUTE REFUSES — not merely hidden ─────────────────────
  console.log("\nevery other route refuses (403 on the ROUTE, not an absent nav item):");
  for (const [label, path] of FORBIDDEN) {
    const r = await call(cm, path);
    r.status === 403
      ? ok(`${label} → 403`)
      : bad(`${label}`, `expected 403, got ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
  }

  // ── 3. ?city= NAMING ANOTHER CITY IS REFUSED on all three ────────────────
  console.log("\nnaming another city is refused, never silently served:");
  for (const [label, path] of [
    ["Gameday Ops", `/api/city/gameday?date=2026-08-15&city=${OTHER_CITY}`],
    ["Reviews", `/api/reviews?city=${OTHER_CITY}`],
    ["Manager Pay", `/api/manager-pay/city-week?week=2026-08-10&city=${OTHER_CITY}`],
  ]) {
    const r = await call(cm, path);
    r.status === 403
      ? ok(`${label}: ?city=${OTHER_CITY} → 403`)
      : bad(`${label} cross-city`, `expected 403, got ${r.status} — a fallback or another city's data is the leak`);
    if (r.status === 403 && new RegExp(SCOPE).test(JSON.stringify(r.body ?? {}))) ok(`…and the refusal NAMES their scope (${SCOPE})`);
  }

  // ── 4. THE CITY CONTROL IS LOCKED, and there is NO SECTION SWITCH ────────
  console.log("\nthe nav and the city control:");
  await cm.goto(`${BASE}/city/gameday`, { waitUntil: "domcontentloaded" });
  await cm.waitForSelector('[data-testid="city-gameday"]', { timeout: 20000 });
  await cm.waitForTimeout(500);
  {
    const m = await cm.evaluate(() => ({
      // THE APP'S OWN RAIL, not a bespoke pill row. `app-rail` is the shared ChatsRail; asserting
      // on it is what proves the tier renders the same chrome rather than a lookalike.
      navItems: [...document.querySelectorAll('[data-testid="app-rail"] [data-testid="rail-item"]')].map((a) => a.textContent.trim()),
      sectionSwitch: !!document.querySelector('[data-testid="section-switch"]')
        || /Daily Ops|Back Office/.test(document.body.innerText),
      cityAll: !!document.querySelector('[data-testid="city-all"]'),
      locked: document.querySelector('[data-testid="city-locked"]'),
    }));
    eq("the rail is the app's own rail, with exactly three items in order", m.navItems, ["Manager Pay", "Reviews", "Gameday Ops"]);
    eq("NO Daily Ops / Back Office switch renders for this tier", m.sectionSwitch, false);
    eq("the city control is present and LOCKED, and the 'All cities' chip is gone",
      { locked: !!m.locked, allCities: m.cityAll }, { locked: true, allCities: false });
    eq("…and the locked control is genuinely disabled, not just styled",
      await cm.$eval('[data-testid="city-locked"]', (e) => e.disabled === true), true);
    eq("…and it names their city", await cm.$eval('[data-testid="city-locked"]', (e) => e.textContent.trim().startsWith("Austin")), true);
  }
  await cm.setViewportSize({ width: 390, height: 844 });
  await cm.waitForTimeout(400);
  eq("…and no section switch at 390 portrait either",
    await cm.evaluate(() => /Daily Ops|Back Office/.test(document.body.innerText)), false);
  eq("…with no horizontal overflow at 390",
    await cm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  {
    // At 390 the rail is hidden and the shared app bar carries navigation. The three items must
    // still be reachable — a tier whose nav simply vanishes on a phone has no nav on a phone.
    await cm.click('[data-testid="mo-screen-picker"]');
    await cm.waitForSelector('[data-testid="screen-sheet"]', { timeout: 8000 });
    const sheet = await cm.evaluate(() => ({
      items: [...document.querySelectorAll('[data-testid="screen-sheet"] [data-testid^="screen-dest-"]')]
        .map((b) => b.querySelector("span span")?.textContent?.trim()),
      sw: !!document.querySelector('[data-testid="screen-sheet"] [data-testid="section-switch"]'),
    }));
    eq("@390: the screen sheet offers the same three, with no section switch",
      { items: sheet.items, sw: sheet.sw }, { items: ["Manager Pay", "Reviews", "Gameday Ops"], sw: false });
    await cm.keyboard.press("Escape");
    await cm.waitForTimeout(250);
  }
  await cm.setViewportSize({ width: 1600, height: 1000 });

  // ── 5. MANAGER PAY exposes ONE lever ─────────────────────────────────────
  await cm.goto(`${BASE}/city/manager-pay`, { waitUntil: "domcontentloaded" });
  // WAIT FOR A READY SIGNAL, not a guess. A flat 1200ms sleep here asserted against the page's
  // "Loading your week…" state: the readonly-note was legitimately absent, AND the no-Gusto /
  // no-CSV / no-share checks below passed VACUOUSLY because a loading screen contains none of
  // those words either. Measured: note absent at 1200ms, present at 3000ms. Waiting on the table
  // makes all four assertions mean something instead of racing the fetch.
  await cm.waitForSelector('[data-testid="paytable"]', { timeout: 25000 });
  await cm.waitForTimeout(200);
  {
    const m = await cm.evaluate(() => {
      const root = document.body;
      const txt = root.innerText;
      return {
        gusto: /gusto/i.test(txt), csv: /csv|export/i.test(txt), share: /share link/i.test(txt),
        rate: /rate\b/i.test(txt) && /edit/i.test(txt),
        readonlyNote: !!document.querySelector('[data-testid="readonly-note"]'),
        // the only editable control anywhere on the page
        inputs: [...document.querySelectorAll("input, select, textarea")].filter((e) => !e.disabled).length,
      };
    });
    eq("Manager Pay offers no Gusto CSV, no export and no share link", { gusto: m.gusto, csv: m.csv, share: m.share }, { gusto: false, csv: false, share: false });
    m.readonlyNote ? ok("…and says on the page that it is read-only apart from the manager") : bad("readonly note", "no readonly-note rendered");
  }

  // ── 6. AN ADMIN IS UNCHANGED ─────────────────────────────────────────────
  console.log("\nan admin still sees everything:");
  const adCtx = await ctxFor(adminSession);
  const ad = await adCtx.newPage();
  await ad.goto(`${BASE}/match-ops/gameday`, { waitUntil: "domcontentloaded" });
  await ad.waitForTimeout(600);
  session0 = adminSession.access_token;
  // THE REASSIGNMENT, STATED. Everything below this line runs as the ADMIN; everything above ran
  // as the city manager. Asserting it here is what keeps the two halves from silently swapping.
  eq("from here the shared token is the ADMIN's", await whoIs(session0), ADMIN);
  {
    let opened = 0;
    for (const [, path] of FORBIDDEN.slice(0, 4)) {
      const r = await call(ad, path);
      if (r.status !== 403) opened++;
    }
    eq("the confinement is NOT a blanket lockout — an admin still reaches the operator routes", opened >= 3, true);
    const g = await call(ad, `/api/matchday/production/gameday?date=2026-08-15`);
    eq("…including the Match Ops gameday board the city manager is refused", g.status, 200);
  }

  // ── 6b. THE PAGES ARE THE REAL PAGES, NOT REBUILDS ───────────────────────
  // The tier's Reviews and Gameday Ops used to be bespoke stripped-down rebuilds. What follows
  // asserts they are now the SAME COMPONENTS an admin gets, by comparing the two renders directly
  // rather than by checking that some city-page selectors exist — a lookalike selector is exactly
  // what a rebuild has.
  console.log("\nthe pages are the REAL pages, not rebuilds:");
  {
    // `data-rv` marks exist ONLY inside ReviewsClient. Comparing the SET of them across the two
    // routes is what proves one component tree: a rebuild cannot accidentally have the same marks,
    // and dropping the leaderboard or the trailing strip from one caller would change the set.
    const rvMarks = (page) => page.evaluate(() =>
      [...new Set([...document.querySelectorAll("[data-rv]")].map((e) => e.getAttribute("data-rv")))].sort());

    await ad.goto(`${BASE}/match-ops/reviews`, { waitUntil: "domcontentloaded" });
    await ad.waitForSelector('[data-rv="avg"]', { timeout: 30000 });
    await ad.waitForTimeout(400);
    // FILTER THE ADMIN PAGE TO THE SAME CITY before comparing. Some marks are conditional on the
    // DATA, not on the component: `unranked-row` only renders for managers below the ranking
    // threshold, and comparing all-cities against one city made this assertion fail for a reason
    // that had nothing to do with the component tree. Same component + same rows = same marks; any
    // difference that survives this is a real structural one.
    // selectOption, not a synthetic event — it drives the control the way a person does, so React
    // state actually changes rather than only the DOM value.
    let picked = false;
    for (const sel of await ad.$$("select")) {
      const has = await sel.evaluate((s, city) => [...s.options].some((o) => o.value === city), SCOPE_NAME);
      if (!has) continue;
      await sel.selectOption(SCOPE_NAME);
      picked = true;
      break;
    }
    eq("the admin Reviews page can be filtered to the same city (so the comparison is like-for-like)", picked, true);
    await ad.waitForTimeout(900);
    const adminMarks = await rvMarks(ad);

    await cm.goto(`${BASE}/city/reviews`, { waitUntil: "domcontentloaded" });
    await cm.waitForSelector('[data-rv="avg"]', { timeout: 30000 });
    await cm.waitForTimeout(400);
    const cityMarks = await rvMarks(cm);

    eq("Reviews renders the SAME component tree as the admin page", cityMarks, adminMarks);
    // Name the pieces the brief named, so a future deletion fails with a useful message rather
    // than an opaque set difference.
    for (const [mark, what] of [["avg", "the AVG RATING tile"], ["volume", "the REVIEW VOLUME tile"],
      ["attn", "the NEEDS ATTENTION tile"], ["stand", "the STANDOUTS tile"],
      ["trailing", "the trailing-8-weeks strip"], ["ranked-row", "the managers leaderboard"]]) {
      cityMarks.includes(mark) ? ok(`…including ${what}`) : bad(`Reviews is missing ${what}`, `no [data-rv="${mark}"]`);
    }
    const filters = await cm.evaluate(() => [...document.querySelectorAll("select")].length);
    eq("…and the month / city / venue / manager filters are all there", filters, 4);
    eq("…with the city one LOCKED and the other three live",
      await cm.evaluate(() => [...document.querySelectorAll("select")].filter((s) => s.disabled).length), 1);
    eq("…and the old bespoke explanatory line is gone",
      await cm.evaluate(() => /never receives another city|Scoped on the server/i.test(document.body.innerText)), false);
  }
  {
    // THE BOARD: same rows, same rails. Compare the city board against the ADMIN board filtered to
    // the same city on the same day — id for id, rail for rail. This is the assertion that would
    // fail if the city page went back to being its own table.
    const boardRows = (page) => page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="snap-row"]')].map((e) => ({
        id: Number(e.getAttribute("data-id")),
        group: e.getAttribute("data-group"),
        // the colour rail is a class on the row — the thing the brief calls "the real colour rails"
        rail: [...e.classList].filter((c) => c !== "r" && c !== "sel").sort().join(" "),
      })).sort((a, b) => a.id - b.id));

    await cm.goto(`${BASE}/city/gameday`, { waitUntil: "domcontentloaded" });
    await cm.waitForSelector('[data-testid="snap-row"]', { timeout: 30000 });
    await cm.waitForTimeout(500);
    const cityRows = await boardRows(cm);

    // The admin board defaults to today, so drive it to the same day the city board is showing.
    const day = await cm.evaluate(() => document.querySelector('[data-testid="daylab"]')?.textContent?.trim() ?? null);
    await ad.goto(`${BASE}/match-ops/gameday`, { waitUntil: "domcontentloaded" });
    await ad.waitForSelector('[data-testid="snap-row"]', { timeout: 30000 });
    await ad.waitForTimeout(500);
    const adminDay = await ad.evaluate(() => document.querySelector('[data-testid="daylab"]')?.textContent?.trim() ?? null);
    if (day && adminDay && day === adminDay) {
      await ad.click(`[data-testid="city-${SCOPE_NAME}"]`);
      await ad.waitForTimeout(600);
      const adminRows = await boardRows(ad);
      eq("Gameday renders the SAME rows and rails as the admin board, scoped", cityRows, adminRows);
    } else {
      bad("board comparison", `the two boards are on different days (city ${day}, admin ${adminDay}) — not compared`);
    }
    eq("…and the board really did render rows (the comparison is not two empty lists)", cityRows.length > 0, true);
  }
  {
    // CLICKING A MATCH GOES TO MANAGER PAY. Not "the panel is hidden" — the panel is never mounted,
    // and the click navigates. Asserted as a navigation plus the panel's absence AFTER it.
    await cm.goto(`${BASE}/city/gameday`, { waitUntil: "domcontentloaded" });
    await cm.waitForSelector('[data-testid="snap-row"]', { timeout: 30000 });
    await cm.waitForTimeout(400);
    const id = await cm.$eval('[data-testid="snap-row"]', (e) => Number(e.getAttribute("data-id")));
    await cm.click('[data-testid="snap-row"]');
    try {
      await cm.waitForFunction(() => location.pathname === "/city/manager-pay", null, { timeout: 12000 });
      ok(`clicking a match navigates to Manager Pay (#match-${id}), it does not open a panel`);
    } catch {
      bad("match click", `stayed on ${new URL(cm.url()).pathname}`);
    }
    eq("…and the hash addresses THAT match's row", new URL(cm.url()).hash, `#match-${id}`);
    eq("…and NO match panel was ever mounted", await cm.$('[data-testid="gday-panel"]') === null, true);
    // The row it points at has to exist, or the link is decoration.
    await cm.waitForSelector('[data-testid="paytable"]', { timeout: 25000 });
    eq("…and that row exists on the Manager Pay page", await cm.$(`#match-${id}`) !== null, true);
  }


  // ── THE PERIOD BAR — the app's own component, city-scoped ────────────────
  // The tier had NO period controls and could only ever see one week, because the bar was inline
  // in ManagerPayView and there was nothing to mount. It is shared now, not rebuilt.
  console.log("\nthe manager-pay period bar:");
  {
    await cm.goto(`${BASE}/city/manager-pay`, { waitUntil: "domcontentloaded" });
    await cm.waitForSelector('[data-testid="pay-period-bar"]', { timeout: 30000 });
    await cm.waitForSelector('[data-testid="paytable"]', { timeout: 30000 });
    const before = await cm.$eval('[data-testid="pay-week-label"]', (e) => e.textContent.trim());
    ok(`the bar renders, showing ${before}`);
    for (const [what, sel] of [["the period chip", "pay-week-chip"], ["Pay run", "pay-run"],
      ["Est. arrival", "pay-arrival"], ["the Week + pay / Pay only toggle", "pay-view-toggle"]]) {
      eq(`…with ${what}`, await cm.$(`[data-testid="${sel}"]`) !== null, true);
    }

    // THE WEEK ACTUALLY MOVES — a nav that renders but does not navigate is the same class of
    // defect as the missing bar.
    await cm.click('[data-testid="pay-week-prev"]');
    await cm.waitForFunction((b) => document.querySelector('[data-testid="pay-week-label"]')?.textContent.trim() !== b, before, { timeout: 20000 }).catch(() => {});
    const after = await cm.$eval('[data-testid="pay-week-label"]', (e) => e.textContent.trim());
    after !== before ? ok(`…and ‹ moves the period (${before} → ${after})`) : bad("week nav", `stayed on ${before}`);

    // THE ARRIVAL WRITE IS NOT THEIRS. PUT /api/manager-pay/pay-arrival moves the date every
    // manager is told to expect their money. Disabled AND visible, with the reason stated.
    eq("the arrival 'Change' write is NOT offered to a city manager", await cm.$('[data-testid="pay-arrival-change"]'), null);
    eq("…it is DISABLED and visible, not hidden", await cm.$('[data-testid="pay-arrival-change-disabled"]') !== null, true);
    eq("…and genuinely disabled, not just styled",
      await cm.$eval('[data-testid="pay-arrival-change-disabled"]', (e) => e.disabled === true), true);
    eq("…with the reason stated beside it",
      await cm.$eval('[data-testid="pay-arrival-reason"]', (e) => e.textContent.trim()), "only MatchDay can move this date");
    // The server is the real guard either way.
    {
      // THE REAL METHOD. A GET returns 405 on this route whatever the caller is, which would prove
      // nothing about the gate. PUT is the write — and authenticateAdmin runs BEFORE the body is
      // parsed, so a refused caller cannot move anyone's arrival date by being asserted against.
      const r = await cm.evaluate(async (tok) => {
        const res = await fetch("/api/manager-pay/pay-arrival", {
          method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
          body: JSON.stringify({ weekStart: "2026-08-03", arrivalDate: "2026-08-20", reason: "e2e refusal probe" }),
        });
        return res.status;
        // cmSession.access_token, NOT session0 — that variable is reassigned to the ADMIN in
        // section 6, and using it here made this probe a real admin write against production. It
        // set a live pay-arrival override, which had to be reverted by hand. Bind the identity you
        // are asserting about; never a mutable that something else owns.
      }, cmSession.access_token);
      [401, 403].includes(r) ? ok(`…and a PUT to pay-arrival is refused for this tier (${r})`)
        : bad("pay-arrival write reachable by a city manager", `status ${r}`);
    }

    // DELETING AN ACCOUNT IS AN ADMIN ACT. Asserted with POST — the real method; a GET returns 405
    // on this route whatever the caller is, which would prove nothing. authenticateAdmin runs
    // before the body is read, and the id below is a nonexistent UUID besides, so a refused caller
    // cannot remove anyone by being asserted against.
    {
      const r = await cm.evaluate(async (tok) => {
        const res = await fetch("/api/admin/users/delete", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
          body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000000" }),
        });
        return res.status;
      }, cmSession.access_token);
      [401, 403].includes(r) ? ok(`…and the account-delete route refuses this tier (${r})`)
        : bad("account delete reachable by a city manager", `status ${r}`);
    }

    // The toggle must DO something.
    await cm.click('[data-testid="pay-view-pay"]');
    await cm.waitForTimeout(400);
    eq("Pay only hides the week grid", await cm.$('[data-testid="week"]'), null);
    eq("…and keeps the pay table", await cm.$('[data-testid="paytable"]') !== null, true);
    await cm.click('[data-testid="pay-view-both"]');
    await cm.waitForTimeout(400);
    eq("Week + pay brings it back", await cm.$('[data-testid="week"]') !== null, true);
  }


  // ── 6c. A SECOND CITY, WHERE THE TWO NAME MAPS DISAGREE ──────────────────
  // Reviews rendered ALL ZEROS for DFW while the trailing-8-week strip on the same page showed 232
  // reviews — the strip is the one panel that ignores the page filters. The city filter was
  // comparing "Dallas / Fort Worth" against "Dallas" and dropping all 922 rows.
  console.log("\na DFW city manager sees their own reviews (the non-degenerate city):");
  {
    // A THIRD NAMED IDENTITY, cached like the other two. `mint` was this suite's own helper and
    // went with the switch to sessionFor.
    const dfwSession = await sessionFor(CITY_MANAGER_DFW);
    const dctx = await ctxFor(dfwSession);
    const dfw = await dctx.newPage();
    await dfw.goto(`${BASE}/city/reviews`, { waitUntil: "domcontentloaded" });
    await dfw.waitForSelector('[data-rv="avg"]', { timeout: 45000 });
    await dfw.waitForTimeout(600);

    const shown = await dfw.evaluate(() => ({
      month: [...document.querySelectorAll("select")][0]?.value ?? null,
      city: [...document.querySelectorAll("select")][1]?.value ?? null,
      volume: Number(document.querySelector('[data-rv="volume"]')?.textContent.trim().replace(/,/g, "")),
      avg: document.querySelector('[data-rv="avg"]')?.textContent.trim(),
    }));
    eq("the city control is locked to their city", shown.city, "Dallas / Fort Worth");
    // THE ASSERTION THAT WOULD HAVE CAUGHT IT: non-zero.
    shown.volume > 0
      ? ok(`REVIEW VOLUME is non-zero for DFW (${shown.volume})`)
      : bad("DFW reviews render zero", "the city filter is dropping every row again");
    eq("…and AVG RATING is a number, not a dash", /^\d/.test(shown.avg ?? ""), true);

    // AND IT MATCHES THE FUNNEL: rows in the selected month, from the payload the page fetched.
    const expected = await dfw.evaluate(async ([tok, month]) => {
      const r = await fetch("/api/reviews", { headers: { Authorization: `Bearer ${tok}` }, cache: "no-store" });
      const j = await r.json();
      const parseLocal = (s) => { const q = (s || "").slice(0, 16).split(/[- T:]/); if (q.length < 5) return null;
        const [y, mo, d, h, mi] = q.map(Number); return new Date(y, mo - 1, d, h, mi); };
      const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      let n = 0, cities = new Set();
      for (const x of (j.rows ?? [])) {
        const sd = parseLocal(x.start_date);
        if (!sd || x.star_rating === null) continue;
        cities.add(x.city_name);
        if (key(sd) === month) n++;
      }
      return { n, cities: [...cities], total: (j.rows ?? []).length };
    }, [dfwSession.access_token, shown.month]);
    eq("…and the tile equals the month-filtered payload count", shown.volume, expected.n);
    eq("…over a payload that is DFW and nothing else", expected.cities, ["Dallas / Fort Worth"]);
    // POSITIVE CONTROL: the payload was not empty, so the equality above is not 0 === 0.
    eq("…and the payload really had rows (this is not 0 === 0)", expected.total > 0 && expected.n > 0, true);
    await closeContext(dctx);
  }

  // ── 7. WHERE THE BARE DOMAIN LANDS EACH TIER ─────────────────────────────
  // /home redirecting correctly is worth almost nothing on its own, because nobody TYPES /home.
  // `/` is the URL an operator actually has bookmarked, so it is the one that has to be right —
  // and it is the one that had no assertion. It works today by CHAINING: `/` renders the internal
  // shell, which routes to /home, whose PagePermissionGuard then routes to firstAllowedPath().
  // Nothing on the root consults the tier directly, and it does not need to; what this pins is
  // that the chain ENDS in the right place for both tiers, so a future short-circuit of the middle
  // hop cannot silently strand a city manager on a page they are refused.
  //
  // WAIT FOR THE CHAIN TO STOP, NOT FOR THE PATH TO APPEAR. Two different wrong measurements were
  // made here before this landed, and both LOOKED right:
  //   • a flat 3s sample caught the chain mid-hop still on `/` and was read as a broken redirect;
  //   • `waitForFunction(pathname === want)` then passed for the WRONG want, because `/` routes
  //     THROUGH /home — so "did it ever equal /home" is true for a city manager, and the mutation
  //     below sailed straight through it.
  // A transient hop satisfies any point-in-time path check. So settle by QUIESCENCE — poll until
  // the path has not changed for 4s (measured: whole chain 4.5s, largest gap between hops 1.45s,
  // so 4s is ~2.7× the real gap) — and only then compare.
  console.log("\nwhere / and /home land each tier:");
  {
    // WAIT FOR THE EXPECTED PATH, THEN REQUIRE IT TO HOLD. Two earlier versions were wrong in
    // opposite directions:
    //   • `waitForFunction(pathname === want)` alone passed for the WRONG want, because `/` routes
    //     THROUGH /home and any point-in-time check is satisfied by a transient hop;
    //   • pure QUIESCENCE (path unchanged for 4s) passed standalone and FAILED under gate load —
    //     a chain that stalls mid-hop longer than the quiet window looks settled on `/`. It is a
    //     time-based assertion, so it was load-sensitive by construction. Green alone, red in a
    //     full gate, which is the worst kind of assertion to own.
    // Waiting for `want` and THEN requiring it to persist is tolerant of a slow chain (it simply
    // waits longer) and still kills a transient hop: mutate the expected path to /home for a city
    // manager and it matches at the hop, then moves on within the hold window and fails.
    const HOLD_MS = 2500;
    const settles = async (page, from, want, who, readySel) => {
      await page.goto(`${BASE}${from}`, { waitUntil: "domcontentloaded" });
      try {
        await page.waitForFunction((w) => location.pathname === w, want, { timeout: 45000 });
      } catch {
        bad(`${who}: ${from} should settle on ${want}`, `never reached it — stopped at ${new URL(page.url()).pathname}`);
        return;
      }
      await page.waitForTimeout(HOLD_MS);
      const held = new URL(page.url()).pathname;
      if (held !== want) { bad(`${who}: ${from} should settle on ${want}`, `reached it but moved on to ${held}`); return; }
      // The URL being right is not the same as having ARRIVED. Where the destination has a ready
      // marker, require it — a stalled shell showing the right path is not a landing.
      if (readySel && !(await page.$(readySel))) { bad(`${who}: ${from} → ${want}`, `path right but ${readySel} never rendered`); return; }
      ok(`${who}: ${from} settles on ${want}`);
    };
    await settles(cm, "/", "/city/manager-pay", "city manager", '[data-testid="paytable"]');
    await settles(cm, "/home", "/city/manager-pay", "city manager", '[data-testid="paytable"]');
    // The same two entry points must be UNCHANGED for an admin — a landing fix that quietly
    // re-routes everyone is a different bug wearing this one's clothes.
    await settles(ad, "/", "/home", "admin");
    await settles(ad, "/home", "/home", "admin");
  }

  // ── 8. MUTATION — prove the payload assertion can FAIL ───────────────────
  // The scoping lives on the server and cannot be mutated from here, so the ASSERTION is run
  // against a deliberately poisoned payload: one foreign-city row added. If the check still
  // passes, it was never testing anything.
  console.log("\nMUTATION — poison the payload with one foreign-city row:");
  {
    const poisoned = { scope: SCOPE, matches: [{ cityIdentifier: SCOPE }, { cityIdentifier: OTHER_CITY }] };
    const cities = new Set(poisoned.matches.map((m) => m.cityIdentifier));
    [...cities].length <= 1
      ? bad("NEG payload", "the single-city check passed on a two-city payload; it proves nothing")
      : ok("NEG: one foreign-city row makes the single-city assertion FAIL (the check has teeth)");
    const okPayload = { matches: [{ cityIdentifier: SCOPE }, { cityIdentifier: SCOPE }] };
    new Set(okPayload.matches.map((m) => m.cityIdentifier)).size <= 1
      ? ok("…and a genuinely single-city payload still passes (not merely always-red)")
      : bad("NEG control", "the check fails even on a clean payload");
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
