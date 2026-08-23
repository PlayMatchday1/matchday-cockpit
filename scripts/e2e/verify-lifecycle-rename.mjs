// THE LIFECYCLE RENAME — a characterisation net over a change that is supposed to do NOTHING.
//
// WHAT THIS PUSH DID. /growth → /lifecycle, can_access_growth → can_access_lifecycle, and every
// component and file that said growth. No copy changed; the section has read "Player Lifecycle" on
// screen since the Membership move. The point of the rename is to FREE THE NAME for a new
// top-level Growth tab, because two different things called growth — one of them wearing a
// different name in the UI — is how someone gates a Growth page on can_access_growth and silently
// grants the Lifecycle reports instead.
//
// A RENAME HAS NO OBSERVABLE BEHAVIOUR OF ITS OWN, so a suite written after it can only assert
// whatever the new code happens to do. This one was written and RUN GREEN AGAINST /growth FIRST,
// and the fixture it compares against was captured from the OLD routes. Every expectation below is
// therefore a record of how the section behaved before anything moved, not a description of how it
// behaves now.
//
// ITEMISED SELECTOR-PATH EDITS (the only things that changed between the baseline run and this
// one; no assertion BODY changed):
//   * SECTION_ROOT   "/growth"      → "/lifecycle"
//   * API_ROOT       "/api/growth"  → "/api/lifecycle"
//   * topTabs read from data-tab rather than textContent — the fixture value is unchanged; the old
//     extraction folded the Match Ops unread badge into the label, so the suite went red whenever a
//     player thread happened to be awaiting a reply. Extraction fix, not an expectation change.
// Everything below LEGACY (the redirect block), the permission block and the backfill block are
// NEW assertions — they test the rename itself and could not exist before it.
//
// WHY THE LEGACY REDIRECTS ARE ENUMERATED AND NOT A WILDCARD. `/growth/:path*` would have been one
// line, and it would have made the NEW Growth tab unreachable the moment it shipped: every request
// to /growth/field-pipeline or /growth/city-launches would 308 to a page that does not exist. The
// six report paths and the eight city slugs are listed instead, and this suite asserts BOTH halves
// — that the six redirect, and that an unlisted path under /growth does not.

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, sessionFor, netRetry } from "./_session.mjs";

installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";

// ── the two path constants, and the only lines the rename commit touched ────────────────────────
const SECTION_ROOT = "/lifecycle";
const API_ROOT = "/api/lifecycle";
const LEGACY_ROOT = "/growth";

// ADMIN holds the right; NO_RIGHT does not. NO_RIGHT is the account verify-city-confinement
// already drives every gate run, so this costs no extra magic link and revokes nobody's session
// that was not already being revoked.
const ADMIN = "rmancuso@playmatchday.com";
const NO_RIGHT = "garrettsuits@gmail.com";

const SECTIONS = ["funnel", "behavior", "revenue-per-player", "retention", "churn", "data-room"];
const CITY_SLUGS = ["austin", "dallas", "houston", "san-antonio", "atlanta", "st-louis", "okc", "el-paso"];

// The FIXTURE — captured from /growth/* before a single file moved. See the header.
const BASELINE = JSON.parse(readFileSync("scripts/e2e/fixtures/lifecycle-baseline.json", "utf8"));

// A page that rendered has controls on it. These are LOWER BOUNDS measured on the baseline run: a
// rename can only ever take them away (a page that failed to render), never add to them.
const MIN_BUTTONS = {
  funnel: 5, behavior: 9, "revenue-per-player": 9, retention: 2, churn: 5, "data-room": 17,
};

let passed = 0;
const failures = [];
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const atLeast = (n, got, min) => (got >= min ? ok(`${n} (${got} ≥ ${min})`) : bad(n, `got ${got}, want ≥ ${min}`));

async function main() {
  const browser = await chromium.launch();
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const ctx = await browser.newContext({ storageState, viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // WAIT ON WHAT THE PAGE EMITS. growth-title is rendered by SectionFrame's loading state too, so
  // the ready signal is the SECTION wrapper, which only exists once the aggregates have arrived.
  const settle = () =>
    page.waitForFunction(
      () => !!document.querySelector('[data-testid="growth-section"]')
        && (document.querySelector('[data-testid="growth-title"]')?.textContent ?? "").length > 0,
      null, { timeout: 240000 },
    );

  const fingerprint = () =>
    page.evaluate(() => {
      const sec = document.querySelector('[data-testid="growth-section"]');
      const q = (sel) => [...sec.querySelectorAll(sel)].map((e) => e.textContent.trim()).filter(Boolean);
      return {
        title: document.querySelector('[data-testid="growth-title"]').textContent,
        subtitle: document.querySelector('[data-testid="growth-subtitle"]').textContent,
        dataSection: sec.getAttribute("data-section"),
        periodBar: !!document.querySelector('[data-testid="growth-period"]'),
        docTitle: document.title,
        cardTitles: q('[class*="cardTitle"]'),
        railItems: [...document.querySelectorAll('[data-testid="rail-item"]')].map((e) => e.innerText.trim().split("\n")[0]),
        railGroups: [...document.querySelectorAll('[data-testid="rail-group"]')].map((e) => e.textContent.trim()),
        // data-tab, NOT textContent: the Match Ops tab renders an unread-chat badge INSIDE the
        // link, so textContent reads "Match Ops1" whenever a player thread is awaiting a reply and
        // "Match Ops" when none is. The attribute carries the label alone.
        topTabs: [...document.querySelectorAll('[data-testid="topnav-tab"]')].map((e) => e.getAttribute("data-tab")),
      };
    });

  // ═══ 1. THE SIX SECTIONS, against the pre-rename fixture ══════════════════════════════════════
  console.log(`\n── the six sections at ${SECTION_ROOT}/* vs the /growth fixture`);
  for (const s of SECTIONS) {
    await page.goto(`${BASE}${SECTION_ROOT}/${s}`, { waitUntil: "domcontentloaded" });
    await settle();
    eq(`${s} — identical to the pre-rename fixture`, await fingerprint(), BASELINE[s]);

    const live = await page.evaluate(() => {
      const sec = document.querySelector('[data-testid="growth-section"]');
      return {
        digits: (sec.innerText.match(/\d/g) ?? []).length,
        buttons: sec.querySelectorAll("button").length,
      };
    });
    // NOT an absence assertion — expects ≥ 1 and a page that failed to render yields 0 and fails.
    atLeast(`${s} — rendered figures, not a shell`, live.digits, 1);
    atLeast(`${s} — controls present`, live.buttons, MIN_BUTTONS[s]);

    // NOTHING A USER READS CHANGED. "Lifecycle" may appear on screen ONLY inside "Player
    // Lifecycle" — the tab and rail label, which is what it already said. A rename leaking into
    // copy shows up here as a bare "Lifecycle".
    const leak = await page.evaluate(() => {
      const t = document.body.innerText;
      const all = (t.match(/Lifecycle/g) ?? []).length;
      const owned = (t.match(/Player Lifecycle/g) ?? []).length;
      return { all, owned, bare: all - owned, hasPath: /\/lifecycle/i.test(t) };
    });
    // POSITIVE CONTROL for the two zero-valued assertions that follow: the needle is proven to
    // match at least once on this very page before anything is asserted to be absent.
    atLeast(`${s} — "Player Lifecycle" present (control for the two below)`, leak.owned, 1);
    eq(`${s} — no bare "Lifecycle" in copy`, leak.bare, 0);
    eq(`${s} — no route path leaked into copy`, leak.hasPath, false);
  }

  // ═══ 2. MEMBERSHIP — the other route that mounts this rail ════════════════════════════════════
  console.log(`\n── /membership still mounts the same rail`);
  await page.goto(`${BASE}/membership`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="rail-item"]').length > 0, null, { timeout: 120000 });
  const memb = await page.evaluate(() => ({
    railItems: [...document.querySelectorAll('[data-testid="rail-item"]')].map((e) => e.innerText.trim().split("\n")[0]),
    railGroups: [...document.querySelectorAll('[data-testid="rail-group"]')].map((e) => e.textContent.trim()),
    topTabs: [...document.querySelectorAll('[data-testid="topnav-tab"]')].map((e) => e.getAttribute("data-tab")),
    path: location.pathname,
  }));
  eq("membership — same seven rail items as the reports", memb.railItems, BASELINE.funnel.railItems);
  eq("membership — same rail groups", memb.railGroups, BASELINE.funnel.railGroups);
  eq("membership — same top tabs", memb.topTabs, BASELINE.funnel.topTabs);
  eq("membership — kept its own URL", memb.path, "/membership");

  // ═══ 3. THE SECTION ROOT ══════════════════════════════════════════════════════════════════════
  console.log(`\n── ${SECTION_ROOT} lands on the funnel`);
  await page.goto(`${BASE}${SECTION_ROOT}`, { waitUntil: "domcontentloaded" });
  await settle();
  eq(`${SECTION_ROOT} → ${SECTION_ROOT}/funnel`, new URL(page.url()).pathname, `${SECTION_ROOT}/funnel`);

  // ═══ 4. THE LEGACY REDIRECTS — EVERY ONE, not a sample ════════════════════════════════════════
  // A redirect that covers five of six is invisible for a month. All fifteen are asserted: the six
  // reports, the bare root, and all eight city slugs.
  console.log(`\n── ${LEGACY_ROOT}/* redirects (all ${SECTIONS.length + 1 + CITY_SLUGS.length})`);
  const landing = async (path) => {
    const res = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    return { path: new URL(page.url()).pathname, status: res?.status() ?? 0 };
  };
  for (const s of SECTIONS) {
    const got = await landing(`${LEGACY_ROOT}/${s}`);
    eq(`${LEGACY_ROOT}/${s} → ${SECTION_ROOT}/${s}`, got.path, `${SECTION_ROOT}/${s}`);
  }
  eq(`${LEGACY_ROOT} → ${SECTION_ROOT}/funnel`, (await landing(LEGACY_ROOT)).path, `${SECTION_ROOT}/funnel`);
  for (const c of CITY_SLUGS) {
    const got = await landing(`${LEGACY_ROOT}/${c}`);
    eq(`${LEGACY_ROOT}/${c} → ${SECTION_ROOT}/${c}`, got.path, `${SECTION_ROOT}/${c}`);
  }

  // THE REDIRECT IS NOT A WILDCARD. This is the assertion that keeps the new Growth tab reachable:
  // an unlisted path under /growth must be left alone. Its positive control is the fifteen above —
  // the same navigation, proven to redirect, in this same run.
  const unlisted = await landing(`${LEGACY_ROOT}/field-pipeline`);
  eq(`${LEGACY_ROOT}/field-pipeline is NOT swallowed by the redirect`, unlisted.path, `${LEGACY_ROOT}/field-pipeline`);

  // ═══ 5. THE SERVER GATE — with the right and without ══════════════════════════════════════════
  console.log(`\n── ${API_ROOT} refuses from the SERVER, not the nav`);
  const call = async (email) => {
    const s = await sessionFor(email);
    const r = await netRetry(
      () => fetch(`${BASE}${API_ROOT}`, { headers: { Authorization: `Bearer ${s.access_token}` } }),
      `GET ${API_ROOT}`,
    );
    let body = null;
    try { body = await r.json(); } catch { /* non-JSON body is itself the answer */ }
    return { status: r.status, error: body?.error ?? null };
  };
  const withRight = await call(ADMIN);
  eq("holder of the right → 200", withRight.status, 200);
  const without = await call(NO_RIGHT);
  eq("no right → 403", without.status, 403);
  // PIN THE CAUSE. A 403 for some other reason would pass the status check and prove nothing about
  // the permission this push renamed.
  eq("no right → refused BY NAME", /lifecycle/i.test(without.error ?? ""), true);

  // ═══ 6. THE BACKFILL — counts, and the same accounts ══════════════════════════════════════════
  console.log(`\n── the backfill: nobody lost the right, nobody gained it`);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: rows, error } = await netRetry(
    () => sb.from("app_users").select("id, can_access_growth, can_access_lifecycle"),
    "app_users read",
  );
  if (error) { bad("backfill — could not read app_users", error.message); }
  else {
    const had = rows.filter((r) => r.can_access_growth === true).map((r) => r.id).sort();
    const has = rows.filter((r) => r.can_access_lifecycle === true).map((r) => r.id).sort();
    // Expects ≥ 1, so it is self-controlling: a read that returned nothing fails here.
    atLeast("backfill — the old right was actually held by someone", had.length, 1);
    eq("backfill — same count", has.length, had.length);
    eq("backfill — the SAME accounts, id for id", has, had);
  }

  eq("no page errors", pageErrors, []);
  await closeContext(ctx);
  await closeBrowser(browser);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
  if (passed === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
}

main().catch(fatal);
