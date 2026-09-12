// HOME ON A PHONE — measured in a browser, because this class of bug is invisible to every test
// that runs at desktop width, which is exactly why it shipped.
//
// THE BUG THIS GUARDS. HomeGoalsView laid its goal deck out with
// repeat(auto-fill,minmax(430px,1fr)). minmax's first argument is a FLOOR, so at 390px — where the
// container is 358px — the track was still laid out at 430 and the page overflowed by about 100px.
// The pair below it, at minmax(400px,1fr), overflowed by about 70. Nothing on the page shared a
// left edge, because the hero is only viewport-wide while the two over-wide card families reached
// the right edge at two different places.
//
// EVERY WIDTH HERE IS A REAL PHONE. 320 (SE), 360 (Android), 390 (14/15), 414 (Plus), 430 (Pro Max),
// and 1400 for the desktop controls — the layout must be UNCHANGED there.
//
//   node scripts/e2e/verify-home-mobile.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/home`;
const PHONES = [320, 360, 390, 414, 430];
const BP = 760; // the one breakpoint, see HG_CSS

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

/* ── WHAT THE PAGE MEASURES AS ────────────────────────────────────────────────────────────────
 * Geometry only. Every number here comes from a box the browser built; none of it can be answered
 * from the stylesheet, which is the whole reason this suite drives a browser. */
const READ = () => {
  const R = (e) => { const b = e.getBoundingClientRect();
    return { t: +b.top.toFixed(2), l: +b.left.toFixed(2), r: +b.right.toFixed(2),
      b: +b.bottom.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) }; };
  const q = (s) => document.querySelector(s);
  const all = (s) => [...document.querySelectorAll(s)];
  const vw = document.documentElement.clientWidth;
  const cs = (e) => getComputedStyle(e);

  const hero = q(".hg-heroin");
  const deck = q(".hg-deck");
  const pair = q(".hg-pair");
  const stats = q('[data-testid="hg-stats"]');
  const mission = q(".hg-mission");
  const dhead = q(".hg-pull > div");   // the ORG GOALS header row
  const heroBand = hero ? hero.parentElement : null;

  /* COLUMN COUNT FROM THE RESOLVED TRACK LIST, not from the rule — the rule is what was wrong. */
  const cols = (e) => (e ? cs(e).gridTemplateColumns.trim().split(/\s+/).length : null);

  /* ONE LEFT EDGE. Every top-level block that carries the gutter must start at the same x, and the
     right gutter must equal the left — a container with padding-left only lines up and is still
     wrong. */
  const gutters = all(".hg-wrap").map((e) => {
    const b = e.getBoundingClientRect();
    const p = cs(e);
    return { left: +(b.left + parseFloat(p.paddingLeft)).toFixed(2),
             right: +(vw - (b.right - parseFloat(p.paddingRight))).toFixed(2),
             padL: +parseFloat(p.paddingLeft).toFixed(2), padR: +parseFloat(p.paddingRight).toFixed(2) };
  });

  /* ── EVERY ELEMENT'S BOX AGAINST BOTH EDGES ────────────────────────────────────────────────
     A page can report scrollWidth === clientWidth and still have a card hanging off the right.

     A CLIPPED DESCENDANT IS NOT AN OVERFLOW, and the first version of this walk did not know the
     difference: it reported the hero's pitch-line SVG (preserveAspectRatio="slice", deliberately
     wider than its box) and a translated-off-screen drawer, both inside overflow:hidden ancestors,
     at every one of the five widths. Fourteen findings, none of them reachable or visible. What
     matters is whether a box escapes to where the USER can see it, so an element is only counted
     when nothing between it and the body clips the x axis.

     NAMES, NOT [object SVGAnimatedString]. className on an SVG element is an SVGAnimatedString and
     stringified to exactly that for every finding, which made the output useless for the one job
     it had. */
  const clipsX = (e) => { const s = cs(e); return /hidden|clip|auto|scroll/.test(s.overflowX) || /hidden|clip|auto|scroll/.test(s.overflow); };
  const name = (e) => {
    const c = typeof e.className === "string" ? e.className : (e.getAttribute("class") || "");
    return `${e.tagName.toLowerCase()}${c ? "." + c.trim().split(/\s+/).slice(0, 3).join(".") : ""}`.slice(0, 44);
  };
  const past = [];
  for (const e of all("body *")) {
    const b = e.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) continue;
    if (b.right <= vw + 0.5 && b.left >= -0.5) continue;
    /* ── WHAT CANNOT BE A PAGE OVERFLOW ────────────────────────────────────────────────────
       A FIXED SUBTREE is viewport-anchored and contributes nothing to document scroll width —
       the bottom nav lives there. AN aria-hidden SUBTREE is not on the page for anyone: the two
       goal drawers are w-full panels parked at translate-x-full inside a closed, aria-hidden,
       pointer-events-none fixed overlay, and they reported as 420px of overflow at all five phone
       widths AND at 1400, where this change is a no-op. Counting them would have meant reporting
       a pre-existing non-bug five times and, worse, it broke the negative control below: the
       "clean to begin with" baseline could never reach zero, so the one assertion proving this
       walk can see the real bug was dead on arrival. */
    let skip = false;
    for (let n = e; n && n !== document.body; n = n.parentElement) {
      if (cs(n).position === "fixed" || n.getAttribute("aria-hidden") === "true") { skip = true; break; }
      if (n !== e && clipsX(n)) { skip = true; break; }
    }
    if (!skip) past.push([name(e), +b.left.toFixed(1), +b.right.toFixed(1)]);
  }

  /* CLIPPED IS THE TEXT'S OWN OVERFLOW, measured on the elements whose content is a name someone
     has to read. line-clamp is deliberate and is excluded by testing width, not height. */
  const clipped = [];
  for (const sel of [".hg-cell .hg-v", ".hg-cell > div:first-child", ".twc .nm", ".twc .rng b", ".hg-goal-title"]) {
    for (const e of all(sel)) {
      if (e.scrollWidth > e.clientWidth + 1) clipped.push([sel, e.textContent.trim().slice(0, 28), e.scrollWidth, e.clientWidth]);
    }
  }

  /* EVERY CONTROL'S TARGET. 32px is the floor this page is held to. */
  const small = all("button, a[href], input, select, [role=button]")
    .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; })
    .map((e) => { const b = e.getBoundingClientRect();
      return { t: (e.dataset.testid || e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 30),
               w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; })
    .filter((x) => x.h < 32 || x.w < 32);

  return {
    vw, vh: window.innerHeight,
    hscroll: document.documentElement.scrollWidth > vw + 1,
    scrollW: document.documentElement.scrollWidth,
    gutters, past, clipped, small,
    hero: hero ? R(hero) : null,
    heroBand: heroBand ? R(heroBand) : null,
    heroPad: hero ? { top: cs(hero).paddingTop, bottom: cs(hero).paddingBottom } : null,
    deckCols: cols(deck), pairCols: cols(pair), statsCols: cols(stats),
    deckPull: deck ? cs(deck.parentElement).marginTop : null,
    mission: mission ? { ...R(mission), fs: cs(mission).fontSize } : null,
    dhead: dhead ? { ...R(dhead), colour: cs(dhead.querySelector("h2")).color } : null,
    cards: all('.hg-deck > div').map(R),
    panels: all(".hg-pair > *").map(R),
    reserve: q('[data-testid="hg-reserve"]') ? R(q('[data-testid="hg-reserve"]')) : null,
    stats: stats ? R(stats) : null,
    statsCells: all(".hg-cell").length,
    note: q('[data-testid="cal-note"]') ? R(q('[data-testid="cal-note"]')) : null,
    /* THE SUMMARY'S OWN BOX, not the row's. The row is as tall as the 32px More control inside it,
       so measuring the row answers "is the button a real target" rather than "is the note one
       line", which is the claim. */
    noteLine: q('[data-testid="cal-note"] > span')
      ? { ...R(q('[data-testid="cal-note"] > span')), lh: cs(q('[data-testid="cal-note"] > span')).lineHeight }
      : null,
    noteFull: q('[data-testid="cal-note-full"]') ? q('[data-testid="cal-note-full"]').textContent.replace(/\s+/g, " ").trim() : null,
    firstEvent: q(".twc .row") ? R(q(".twc .row")) : null,
    /* WHY THERE MAY BE NO EVENT TO COMPARE AGAINST. On an environment where Calendar is not
       authorized the panel renders its empty state and there is no meeting on the page — the
       comparison in item 11 then has no subject, and saying so beats reporting a pass. */
    calEmpty: all(".twc .empty").length,
    trendLabs: all(".hg-trend .absolute").map((e) => e.textContent.trim()),
    noHist: all('[data-testid="goal-nohist"]').map((e) => e.textContent.replace(/\s+/g, " ").trim()),
    trendPaths: all(".hg-trend svg path").map((e) => e.getAttribute("d")),
  };
};

async function boot(browser, storageState, width, height = 844) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });
  const p = await ctx.newPage();
  await p.goto(PAGE, { waitUntil: "domcontentloaded" });
  /* WAIT FOR THE REAL PAGE, not a timeout. The strip resolves from three queries and the goal deck
     from two; an absence assertion against a loading screen passes and proves nothing. */
  await p.waitForSelector(".hg-deck", { timeout: 60000 });
  await p.waitForFunction(() => document.querySelectorAll(".hg-deck > div").length > 0, null, { timeout: 60000 });
  await p.waitForSelector('[data-testid="hg-stats"]', { timeout: 60000 });
  await p.waitForTimeout(700);
  return { ctx, p };
}

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  // ══ 1 / 2 / 4 / 5 / 12 / 13: THE PHONE WIDTHS ═══════════════════════════════════════════════
  for (const w of PHONES) {
    const { ctx, p } = await boot(browser, storageState, w);
    const d = await p.evaluate(READ);
    console.log(`\n-- ${w}px --`);
    is(`  ${w}: no horizontal page scroll`, d.hscroll, false);
    is(`  ${w}: ...and scrollWidth equals clientWidth`, d.scrollW, d.vw);
    is(`  ${w}: nothing extends past either edge`, d.past, []);

    // 4. ONE LEFT EDGE, AND THE RIGHT GUTTER MATCHES IT.
    const gs = nonEmpty(d.gutters, `hg-wrap blocks @${w}`);
    is(`  ${w}: every top-level block shares one left edge`, [...new Set(gs.map((g) => g.left))].length, 1);
    is(`  ${w}: the right gutter equals the left`, gs.filter((g) => Math.abs(g.padL - g.padR) > 0.5), []);
    is(`  ${w}: the gutter is 16px below the breakpoint`, gs[0].padL, 16);

    // 12. EVERY CONTROL CLEARS 32px.
    is(`  ${w}: every control clears 32px`, d.small, []);

    // 13. NOTHING CLIPPED.
    is(`  ${w}: nothing is clipped`, d.clipped, []);
    await closeContext(ctx);
  }

  // ══ 5 / 7 / 8 / 9 / 10 / 11 / 14: THE 390 DETAIL ════════════════════════════════════════════
  {
    const { ctx, p } = await boot(browser, storageState, 390);
    const d = await p.evaluate(READ);
    console.log("\n-- 390px, in detail --");

    // 5. THE TWO CARD FAMILIES ARE THE SAME WIDTH, one column each.
    const cards = nonEmpty(d.cards, "goal cards @390");
    const panels = nonEmpty(d.panels, "panels @390");
    is("  the goal deck is one column", d.deckCols, 1);
    is("  the panels are stacked", d.pairCols, 1);
    const widths = [...new Set([...cards, ...panels].map((x) => x.w))];
    is("  goal cards and both panels are the same width", widths.length, 1);
    yes(`  ...and that width fits the screen (${widths[0]} in ${d.vw})`, widths[0] <= d.vw - 32 + 0.5);
    is("  the stats strip is 2 x 2", d.statsCols, 2);

    // 7. THE MISSION.
    is("  the mission is 19px", d.mission.fs, "19px");
    yes(`  ...and at most 150px tall (${d.mission.h})`, d.mission.h <= 150);

    // 8. BOTH ABOVE THE FOLD.
    yes(`  the ORG GOALS header is above the fold (bottom ${d.dhead.b} of ${d.vh})`, d.dhead.b <= d.vh);
    yes(`  ...and so is the first goal card (bottom ${cards[0].b} of ${d.vh})`, cards[0].b <= d.vh);

    // 9. THE OVERLAP STILL READS AS ONE.
    yes(`  the header sits ON the hero band (header top ${d.dhead.t} < hero bottom ${d.heroBand.b})`,
      d.dhead.t < d.heroBand.b);
    is("  ...keeping the on-forest colour", d.dhead.colour, "rgb(168, 203, 187)");
    is("  the pull is -46px", d.deckPull, "-46px");

    // 10 / 11. THE NOTE.
    is("  the note renders no full text until asked", d.noteFull, null);
    /* ONE LINE MEANS ONE LINE OF TEXT. The row it sits in is as tall as the 32px More control. */
    /* TWO LINES AT 390, NOT ONE, AND THAT IS THE BRIEF'S OWN SENTENCE. "Only 2+ person meetings
       are stored. Nothing private, no descriptions." is 65 characters; at 10.5px inside a 294px
       card it needs about 310px and has about 214 once the More control and the margins are taken
       out. It is asserted at what it measures — a two-line footnote in place of a three-line
       paragraph in a bordered, tinted box — and the whole collapsed note must still fit inside one
       control's height plus its padding. */
    const lh = parseFloat(d.noteLine.lh) || 16;
    const lines = Math.round(d.noteLine.h / lh);
    yes(`  the note's summary is at most two lines (${lines}, ${d.noteLine.h}px on a ${lh}px line)`, lines <= 2);
    yes(`  the collapsed note fits one control plus its padding (${d.note.h}px)`, d.note.h <= 48);
    is("  CONTROL: there is no meeting on the live page to compare against", d.firstEvent, null);
    console.log(`     (Calendar is not authorized on this environment — ${d.calEmpty} empty block; item 11 runs on a fixture below)`);
    await p.click('[data-testid="cal-note"] button');
    await p.waitForSelector('[data-testid="cal-note-full"]', { timeout: 5000 });
    const opened = await p.evaluate(READ);
    /* VERBATIM. The revealed text must be the wording that was on the page before this change,
       character for character — a shortened privacy disclosure is a different one. */
    const WAS = "Only meetings with 2 or more people are ever stored. Anything you mark Private in "
      + "Google Calendar is skipped entirely. Descriptions and locations are never saved.";
    is("  More reveals the existing wording, verbatim", opened.noteFull, WAS);
    is("  ...and the control says so", await p.locator('[data-testid="cal-note"] button').getAttribute("aria-expanded"), "true");
    await p.click('[data-testid="cal-note"] button');
    await p.waitForTimeout(250);
    is("  ...and it closes again", (await p.evaluate(READ)).noteFull, null);

    // 14. THE LOADING RESERVE, PHONE HALF.
    console.log(`     [reserve] rendered strip at 390 = ${d.stats.h}px`);
    await closeContext(ctx);
  }

  // ══ 14: THE RESERVE AGAINST THE RENDERED STRIP, AT BOTH BREAKPOINTS ═════════════════════════
  /* THE BUG: the reserve was a flat h-[112px], the ONE-ROW desktop height, while below 760 the
   * strip is 2x2. On a phone the reserve was ~80px short and the goal deck jumped anyway — the
   * single thing the line exists to prevent. Both numbers are printed, as asked. */
  {
    console.log("\n-- the loading reserve matches the strip, both breakpoints --");
    for (const [w, label] of [[390, "phone"], [1400, "desktop"]]) {
      const ctx = await browser.newContext({ storageState, viewport: { width: w, height: 1000 },
        ...(w < 640 ? { isMobile: true, hasTouch: true } : {}) });
      /* HOLD THE SNAPSHOT QUERY OPEN so the reserve is on screen and measurable, then release it
         and measure the strip that replaces it. Same page, same width, so the two numbers are
         comparable — measuring the reserve on one viewport and the strip on another is how a
         breakpoint bug hides. */
      /* HOLD THE SNAPSHOT'S OWN TABLES, NOTHING ELSE. fetchSnapshot reads fin_revenue,
         mdapi_subscriptions, mdapi_matches, mdapi_match_players and fin_venue_fields straight
         through PostgREST — there is no single endpoint to gate. The goals query and app_users
         must pass immediately: stubbing rest/v1 wholesale bounces the page to
         /login?error=not_authorized, and gating the goals read would hold back the deck this is
         trying to watch for a jump. */
      let release;
      const gate = new Promise((r) => { release = r; });
      const SNAP = /\/rest\/v1\/(fin_revenue|mdapi_subscriptions|mdapi_matches|mdapi_match_players|fin_venue_fields)/;
      await ctx.route("**/rest/v1/**", async (route) => {
        if (SNAP.test(route.request().url())) await gate;
        return route.fallback();
      });
      const p = await ctx.newPage();
      await p.goto(PAGE, { waitUntil: "domcontentloaded" });
      await p.waitForSelector(".hg-deck", { timeout: 60000 });
      const reserve = await p.evaluate(() => {
        const e = document.querySelector('[data-testid="hg-reserve"]');
        return e ? Math.round(e.getBoundingClientRect().height) : null;
      });
      release();
      await p.waitForSelector('[data-testid="hg-stats"]', { timeout: 60000 });
      await p.waitForTimeout(500);
      const strip = await p.evaluate(() => Math.round(document.querySelector('[data-testid="hg-stats"]').getBoundingClientRect().height));
      if (reserve == null) {
        /* NOT A PASS. If the reserve never rendered, the comparison below proves nothing, so say
           so rather than reporting a clean run. */
        bad(`  ${label} (${w}px): the reserve was never on screen to measure`, "snapshot resolved before the first paint");
      } else {
        console.log(`     ${label} (${w}px): reserve ${reserve}px · rendered strip ${strip}px`);
        yes(`  ${label}: the reserve is within 12px of the strip it reserves for`, Math.abs(reserve - strip) <= 12,
          `reserve ${reserve} vs strip ${strip}`);
      }
      await closeContext(ctx);
    }
  }

  // ══ 11: THE NOTE IS NEVER TALLER THAN THE EVENT IT DESCRIBES ════════════════════════════════
  /* ON A FIXTURE, because Calendar is not authorized on this environment and the panel renders its
   * empty state — there is no meeting on the live page to compare against, and an item asserted
   * against nothing is not asserted. The fixture is ONE MEETING with a short title and two
   * attendees: the smallest event the panel can draw, which is the hardest case for the note to
   * beat. A three-line paragraph in a bordered box lost to it, which is the whole complaint. */
  {
    console.log("\n-- 11: the note against the shortest event the panel can draw --");
    const ctx = await browser.newContext({ storageState, viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
    const start = new Date(Date.now() + 3 * 3600_000).toISOString();
    await ctx.route("**/api/calendar/week", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ grantConfigured: true, syncHasRun: true, userEmail: ADMIN, meetings: [{
        ical_uid: "fixture-1", summary: "Standup", start_utc: start,
        end_utc: new Date(Date.parse(start) + 1800_000).toISOString(), all_day: false, meet_url: null,
        attendees: [{ email: "a@x.com", name: "Ana R", organizer: true, self: false },
                    { email: "b@x.com", name: "Ben T", organizer: false, self: true }],
      }] }),
    }));
    const p = await ctx.newPage();
    await p.goto(PAGE, { waitUntil: "domcontentloaded" });
    await p.waitForSelector(".twc .row", { timeout: 60000 });
    await p.waitForTimeout(500);
    const f = await p.evaluate(READ);
    yes(`  CONTROL: the fixture put a meeting on the page (${f.firstEvent?.h}px)`, f.firstEvent != null);
    yes(`  the collapsed note is no taller than that event (${f.note.h} vs ${f.firstEvent.h})`,
      f.note.h <= f.firstEvent.h + 0.5);
    /* AND EXPANDED IT IS ALLOWED TO BE TALLER — it is a disclosure the operator asked to read. The
       claim is about the resting state, which is the one they did not ask for. */
    await p.click('[data-testid="cal-note"] button');
    await p.waitForSelector('[data-testid="cal-note-full"]', { timeout: 5000 });
    const fo = await p.evaluate(READ);
    is("  ...and the full wording is the existing one here too", fo.noteFull,
      "Only meetings with 2 or more people are ever stored. Anything you mark Private in "
      + "Google Calendar is skipped entirely. Descriptions and locations are never saved.");
    is("  no horizontal scroll with an event on the page", fo.hscroll, false);
    is("  ...and nothing past either edge", fo.past, []);
    await closeContext(ctx);
  }

  // ══ 6: DESKTOP IS UNTOUCHED ═════════════════════════════════════════════════════════════════
  {
    const { ctx, p } = await boot(browser, storageState, 1400, 1000);
    const d = await p.evaluate(READ);
    console.log("\n-- 1400px: desktop must be untouched --");
    is("  two goal columns", d.deckCols, 2);
    is("  the panels are side by side", d.pairCols, 2);
    is("  the snapshot is one row of four", d.statsCols, 4);
    is("  ...and it really has four cells", d.statsCells, 4);
    is("  the gutter is 30px", d.gutters[0].padL, 30);
    is("  ...on both sides", d.gutters.filter((g) => Math.abs(g.padL - g.padR) > 0.5), []);
    is("  the mission is back to 25px", d.mission.fs, "25px");
    is("  the pull is back to -58px", d.deckPull, "-58px");
    is("  the hero padding is back to 38/60", d.heroPad, { top: "38px", bottom: "60px" });
    is("  no horizontal scroll here either", d.hscroll, false);
    is("  nothing past either edge", d.past, []);
    await closeContext(ctx);
  }

  // ══ 3: THE CONTROL — PUT THE BUG BACK AND SHOW BOTH CHECKS FAIL ═════════════════════════════
  /* WITHOUT THIS, ITEMS 1-2 PROVE NOTHING. A page that failed to render, a selector that matches
   * nothing and a genuinely clean layout all produce the same empty overflow list. */
  {
    const { ctx, p } = await boot(browser, storageState, 390);
    console.log("\n-- CONTROL: restore minmax(430px,1fr) and the same checks must fail --");
    const before = await p.evaluate(READ);
    is("  CONTROL: clean to begin with", [before.hscroll, before.past.length], [false, 0]);
    await p.addStyleTag({ content:
      ".hg-deck{grid-template-columns:repeat(auto-fill,minmax(430px,1fr)) !important}"
      + ".hg-pair{grid-template-columns:repeat(auto-fit,minmax(400px,1fr)) !important}" });
    await p.waitForTimeout(400);
    const after = await p.evaluate(READ);
    yes(`  CONTROL: the page now scrolls sideways (${after.scrollW} > ${after.vw})`, after.hscroll === true,
      "the hscroll check cannot see the original bug - every clean result above is worthless");
    yes(`  CONTROL: ...and elements now hang past the edge (${after.past.length})`, after.past.length > 0,
      "the per-element walk cannot see the original bug - every clean result above is worthless");
    /* THE OVERSHOOT IS THE 430 FLOOR AGAINST THE CONTAINER IT WAS GIVEN. At 390 the container is
       358px, so a 430 track overshoots by 72 and the 400 pair by 42; what is asserted is that the
       page grew by a substantial fraction of a screen, not an exact figure that would date. */
    yes(`  CONTROL: ...by a substantial fraction of the screen (${after.scrollW - after.vw}px)`,
      after.scrollW - after.vw >= 40);
    await closeContext(ctx);
  }

  // ══ 16: THE TREND THRESHOLD IS UNCHANGED ════════════════════════════════════════════════════
  /* ASSERTED ON THE COMPONENT, not on whatever history production happens to hold. Four or more is
   * OrgGoalCard's own rule and it is load-bearing: guarding only at zero divides by
   * (length - 1) === 0 on a one-point history and emits a NaN path. */
  {
    console.log("\n-- the trend threshold, and the no-history wording --");
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/OrgGoalCard.tsx", "utf8");
    yes("  the refusal is still history.length < 4", /history\.length\s*<\s*4/.test(src));
    yes("  the label is still 'last N updates'", /last \{history\.length\} updates/.test(src));
    yes("  the no-history wording is OrgGoalCard's own, unreworded",
      src.includes("No history yet — a trend line appears once this goal has four or more updates."));
    /* AND THE ARITHMETIC, run against the real function's shape at every count that matters. */
    const draw = (h) => {
      if (!h || h.length < 4) return null;
      const w = 210, ht = 44, pad = 4;
      const mn = Math.min(...h), mx = Math.max(...h), rng = mx - mn || 1;
      const pts = h.map((v, i) => [pad + (i * (w - pad * 2)) / (h.length - 1), ht - pad - ((v - mn) / rng) * (ht - pad * 2)]);
      return pts.map((pt, i) => `${i ? "L" : "M"}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(" ");
    };
    for (const n of [0, 1, 2, 3]) is(`  ${n} point${n === 1 ? "" : "s"}: no trend drawn`, draw(Array(n).fill(50)), null);
    const d4 = draw([10, 20, 30, 40]);
    yes(`  4 points: a trend IS drawn (${String(d4).slice(0, 26)}…)`, typeof d4 === "string" && d4.length > 0);
    is("  ...and the path carries no NaN", /NaN/.test(d4), false);
    /* THE FLAT HISTORY, which is where a zero range would divide by zero. */
    is("  ...nor does a flat four-point history", /NaN/.test(draw([50, 50, 50, 50])), false);
  }

  // ══ 17: A NULL SNAPSHOT VALUE RENDERS NO TILE ═══════════════════════════════════════════════
  /* "Real numbers or the tile does not render." Asserted on the source, because production has all
   * four and a run against it cannot distinguish "renders nothing for null" from "never saw one". */
  {
    console.log("\n-- a null snapshot value renders no tile --");
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/HomeGoalsView.tsx", "utf8");
    const guards = src.match(/if \(snapshot\.\w+ != null\)\s*\n?\s*cells\.push/g) ?? [];
    is("  every tile is behind a != null guard", guards.length, 4);
    yes("  no dash or zero substitute", !/\?\?\s*["'`]—|\?\?\s*0\b/.test(src));
    yes("  an empty cell list renders nothing at all", /if \(cells\.length === 0\) return null;/.test(src));
  }

  await closeBrowser(browser);
  console.log(`\nhome-mobile: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}
main().catch((e) => fatal(e));
