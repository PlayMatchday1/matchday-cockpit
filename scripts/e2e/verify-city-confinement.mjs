// THE CITY-MANAGER CONFINEMENT, driven as a REAL city-manager session (Phase 29b).
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
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const CITY_MANAGER = "rmancuso1@gmail.com";   // real tier holder, city_identifier = ATX
const SCOPE = "ATX";
const OTHER_CITY = "DFW";
const ADMIN = "rmancuso@playmatchday.com";

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

  const mint = async (email) => {
    const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email }), `generateLink ${email}`);
    const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), `verifyOtp ${email}`);
    if (!vv.data?.session) throw new Error(`no session for ${email}`);
    return vv.data.session;
  };
  const cmSession = await mint(CITY_MANAGER);
  const adminSession = await mint(ADMIN);

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
    const g = await call(cm, `/api/city/gameday?date=2026-08-15`);
    eq("Gameday Ops: the route answers for a city manager", g.status, 200);
    if (g.status === 200) {
      eq("…scoped to their city", g.body.scope, SCOPE);
      const cities = new Set((g.body.matches ?? []).map((m) => m.cityIdentifier ?? SCOPE));
      eq("…and the PAYLOAD carries rows from exactly one city", [...cities].length <= 1, true);
      eq("…with the derived summary computed AFTER scoping (counts match the returned rows)",
        g.body.summary.total, (g.body.matches ?? []).length);
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
      navItems: [...document.querySelectorAll('[data-testid="city-nav"] a')].map((a) => a.textContent.trim()),
      sectionSwitch: !!document.querySelector('[data-testid="section-switch"]')
        || /Daily Ops|Back Office/.test(document.body.innerText),
      citySelect: !!document.querySelector('[data-testid="city-gameday"] select'),
      cityLocked: !!document.querySelector('[data-testid="cg-city-locked"]'),
    }));
    eq("the nav is exactly three flat items, in order", m.navItems, ["Manager Pay", "Reviews", "Gameday Ops"]);
    eq("NO Daily Ops / Back Office switch renders for this tier", m.sectionSwitch, false);
    eq("the city is a LOCKED label, not a selector they can change", { select: m.citySelect, locked: m.cityLocked }, { select: false, locked: true });
  }
  await cm.setViewportSize({ width: 390, height: 844 });
  await cm.waitForTimeout(400);
  eq("…and no section switch at 390 portrait either",
    await cm.evaluate(() => /Daily Ops|Back Office/.test(document.body.innerText)), false);
  eq("…with no horizontal overflow at 390",
    await cm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
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
    const settledPath = async (page, quietMs = 4000, timeout = 40000) => {
      const t0 = Date.now();
      let last = new URL(page.url()).pathname, since = Date.now();
      while (Date.now() - t0 < timeout) {
        await page.waitForTimeout(250);
        const now = new URL(page.url()).pathname;
        if (now !== last) { last = now; since = Date.now(); }
        else if (Date.now() - since >= quietMs) break;
      }
      return last;
    };
    const settles = async (page, from, want, who, readySel) => {
      await page.goto(`${BASE}${from}`, { waitUntil: "domcontentloaded" });
      const got = await settledPath(page);
      if (got !== want) { bad(`${who}: ${from} should settle on ${want}`, `settled on ${got}`); return; }
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
