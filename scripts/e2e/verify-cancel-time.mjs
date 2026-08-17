// CANCEL TIME — built to docs/mockups/cancel-time-v1.html.
//
// THE BUG THIS PINS. Kickoff and the auto-cancel deadline were typeset identically — BOTH 16px
// tabular clocks, measured — so a row read as two kickoffs. On mobile the deadline sat in a run-on
// meta line with the manager and the price:
//     6:45 PM CST · 1h 56m left · Rooby Amilcar · $9.00
// Four unrelated facts at one weight with the same dots.
//
// THE RULE, and the thing worth asserting: kickoff is a FIXED POINT, the deadline is a COUNTDOWN,
// so each view now contains EXACTLY ONE time-shaped thing and it is kickoff. That is why the
// central assertion here is a REGEX COUNT of clock times over the row's own text rather than a
// check that some element exists — "the countdown renders" would still pass with the clock left
// beside it, which is precisely the state being fixed.
//
// TIER: numbers on screen. A few assertions, no mutation tests.
//
// Hermetic: the day is route-fulfilled with kickoffs computed RELATIVE to now, so the short row is
// short and the over-min row is over regardless of when the gate runs.
//   node scripts/e2e/verify-cancel-time.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, closeContext, closeBrowser, sessionFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/match-ops/gameday`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// A CLOCK TIME, as rendered. Deliberately NOT anchored with a trailing \b: the timezone is
// appended with no space ("9:00 PMCST"), so \b after PM never matches and the count silently came
// back 0 — a counting assertion that always reads zero passes every time and proves nothing.
const CLOCK = /\d{1,2}:\d{2}\s?(?:AM|PM)/gi;
const countClocks = (s) => (s.match(CLOCK) || []).length;

const MIN = 60000;

function fixture(todayYMD) {
  const iso = (offMin) => new Date(Date.now() + offMin * MIN).toISOString();
  const mk = (o) => ({
    id: 0, name: "M", isCancelled: false, autoCanceled: true, autoCanceledMinutes: 75,
    minPlayerCount: 11, maxPlayerCount: 20, registrationPrice: 900, additionalSpotPrice: 400,
    fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0,
    isAutoBump: false, category: "OPEN", type: "REGULAR",
    _count: { players: 6, fakePlayers: 0 }, manager: { firstName: "Rooby", lastName: "Amilcar" },
    teams: [{ teamNumber: 1 }, { teamNumber: 2 }],
    field: { title: "Crossbar Rowlett", city: { id: 1, name: "Dallas / Fort Worth", timeZone: { abbr: "CST" } } },
    startDate: `${todayYMD}T20:00:00.000`, ...o,
  });
  return [
    // SHORT, with a live deadline 116m out (kickoff +191m, 75m lead).
    mk({ id: 801, name: "Crossbar Rowlett - Saturday", startDateUtc: iso(191), _count: { players: 7, fakePlayers: 7 } }),
    // OVER the minimum — no live deadline exists.
    mk({ id: 802, name: "Soccer Central Field 4", startDateUtc: iso(191), minPlayerCount: 9, maxPlayerCount: 36,
      _count: { players: 36, fakePlayers: 0 }, manager: { firstName: "Ricki", lastName: "" },
      field: { title: "Soccer Central", city: { id: 2, name: "San Antonio", timeZone: { abbr: "CST" } } } }),
    // AUTO-CANCEL OFF and short — keeps its own state, which is not the same fact as "over".
    mk({ id: 803, name: "No-AC Dallas", autoCanceled: false, startDateUtc: iso(191), _count: { players: 3, fakePlayers: 0 } }),
  ];
}

async function main() {
  process.loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  // ONE SESSION PER IDENTITY, cached across the whole gate run — see sessionFor in _session.mjs.
  const session = await sessionFor("rmancuso@playmatchday.com");
  const ref = new URL(url).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] };

  const d = new Date();
  const todayYMD = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const browser = await chromium.launch({ headless: true });
  const open = async (viewport) => {
    const ctx = await browser.newContext({ viewport, storageState });
    await ctx.route("**/api/matchday/**/gameday**", (route) => {
      const date = new URL(route.request().url()).searchParams.get("date");
      route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ date, env: "production", matches: date === todayYMD ? fixture(todayYMD) : [] }) });
    });
    await ctx.route("**/api/veo**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: [] }) }));
    const page = await ctx.newPage();
    await page.goto(PAGE, { waitUntil: "domcontentloaded" });
    // PRESENCE WAIT on the rows themselves — every assertion below is about what a row contains,
    // and a board still loading contains none of it.
    await page.waitForSelector('[data-testid="snap-row"][data-id="801"]', { timeout: 30000 });
    await page.waitForTimeout(250);
    return { ctx, page };
  };

  // What each row/card reports about itself, at whatever width it is being read.
  const read = (page, id) => page.evaluate((rid) => {
    const row = document.querySelector(`[data-testid="snap-row"][data-id="${rid}"]`);
    if (!row) return null;
    const vis = (e) => !!e && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
    const fs = (e) => (vis(e) ? parseFloat(getComputedStyle(e).fontSize) : 0);
    const q = (s) => row.querySelector(s);
    return {
      text: row.innerText.replace(/\s+/g, " ").trim(),
      // The LARGEST visible type in each, which is what "typeset identically" was about.
      kickoffFs: Math.max(fs(q(".t1")), fs(q(".t2"))),
      deadlineFs: Math.max(fs(q(".cxbig")), fs(q(".cxcap")), fs(q(".mcnt"))),
      durVisible: vis(q('[data-testid="snap-cxl-dur"]')),
      mcntVisible: vis(q('[data-testid="snap-cxl-mcnt"]')),
      noacVisible: vis(q('[data-testid="snap-cxl-mnoac"]')),
      cellDash: !!q('[data-testid="snap-cxl-none"]'),
      title: q(".c-cxl")?.getAttribute("title") ?? null,
      meta: q('[data-testid="snap-cxlmob"]')?.textContent?.trim() ?? null,
    };
  }, id);

  console.log("cancel time — the deadline stops being a second kickoff\n");

  // ── DESKTOP 1600 ─────────────────────────────────────────────────────────
  {
    const { ctx, page } = await open({ width: 1600, height: 1100 });
    console.log("desktop 1600:");

    const head = await page.$$eval(".colhead span", (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
    eq("the column header reads CANCEL TIME", head.includes("CANCEL TIME"), true);
    eq("…and nothing on the page still says DECIDE BY",
      await page.evaluate(() => /DECIDE BY/i.test(document.body.innerText)), false);

    const short = await read(page, 801);
    eq("the short row shows a DURATION, not a clock", short.durVisible, true);
    // THE ASSERTION THAT ENCODES THE FIX.
    eq("…and the whole row contains EXACTLY ONE clock time — kickoff", countClocks(short.text), 1);
    (short.deadlineFs > 0 && short.deadlineFs < short.kickoffFs)
      ? ok(`…typeset smaller than kickoff (${short.deadlineFs}px vs ${short.kickoffFs}px), so they read as different kinds of fact`)
      : bad("deadline type size", `deadline ${short.deadlineFs}px vs kickoff ${short.kickoffFs}px — must be strictly smaller`);
    eq("…the clock moved to the title attribute", /Auto-cancels at \d{1,2}:\d{2}\s?(AM|PM)/i.test(short.title ?? ""), true);
    eq("…and the caption names what it counts down to", /until\s+auto-cancel/i.test(short.text), true);

    const over = await read(page, 802);
    eq("a row OVER the minimum has no deadline at all — the cell is a dash", { dash: over.cellDash, dur: over.durVisible }, { dash: true, dur: false });
    eq("…and no countdown text anywhere in it", /until auto-cancel|cancels in/i.test(over.text), false);

    const noac = await read(page, 803);
    eq("auto-cancel switched OFF keeps its existing state, unchanged",
      /no auto-cancel/i.test(noac.text) && !noac.durVisible, true);

    eq("no horizontal overflow at 1600",
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await closeContext(ctx);
  }

  // ── MOBILE 390 portrait ──────────────────────────────────────────────────
  {
    const { ctx, page } = await open({ width: 390, height: 844 });
    console.log("\nmobile 390 portrait:");

    const short = await read(page, 801);
    eq("the countdown is in the status stack, with the shortfall", short.mcntVisible, true);
    eq("…and the desktop cell's duration is NOT also on the card", short.durVisible, false);
    eq("…so the card contains EXACTLY ONE clock time — kickoff", countClocks(short.text), 1);
    (short.deadlineFs > 0 && short.deadlineFs < short.kickoffFs)
      ? ok(`…typeset smaller than kickoff (${short.deadlineFs}px vs ${short.kickoffFs}px)`)
      : bad("deadline type size @390", `deadline ${short.deadlineFs}px vs kickoff ${short.kickoffFs}px`);
    // THE META LINE: who and how much, nothing else.
    eq("the meta line is who and how much, nothing else", short.meta, "Rooby Amilcar · $9.00");
    eq("…with no clock in it", countClocks(short.meta ?? ""), 0);
    eq("…and no countdown in it", /cancels in|until auto-cancel|left\b/i.test(short.meta ?? ""), false);

    const over = await read(page, 802);
    eq("an over-the-minimum card shows only its chip — no countdown", over.mcntVisible, false);
    eq("…and its meta line is who and how much too", /^Ricki · \$/.test(over.meta ?? ""), true);

    const noac = await read(page, 803);
    eq("auto-cancel OFF is still distinguishable from over-the-minimum on a phone",
      { noac: noac.noacVisible, cnt: noac.mcntVisible }, { noac: true, cnt: false });

    eq("no horizontal overflow at 390",
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await closeContext(ctx);
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
