// SUITE RUNNER. Runs each suite in its own process and FAILS if a suite times out, exits non-zero,
// reports any failure, OR runs ZERO assertions — a suite whose mock no longer matches can load
// nothing, assert nothing, and exit 0, and that is the hole this guard exists for.
//
//   node scripts/run-suites.mjs         # the node guards — this is what `npm run verify` runs
//   node scripts/run-suites.mjs --e2e   # the browser suites, ON DEMAND (needs `npm run dev` up)
//
// THERE IS NO QUARANTINE ANY MORE, and no drift guard for one. Quarantine existed because the
// browser suites were MANDATORY on every push, so a red one had to be excluded loudly rather than
// waved through. They are not mandatory now — the pre-push hook runs the node guards and nothing
// else — so a browser suite that is red is simply a suite you do not run, and bookkeeping about
// which ones those are is bookkeeping about nothing. See "The bar" in CLAUDE.md.
//
// The node suites below are NOT a general test suite. They are the guards on what reaches a player:
// the stage deny-list, the production host guard, the wall-clock trap, the change-log hook, and the
// credits / roster / promo write models. That is the whole reason they still run on every push.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";

const E2E = process.argv.includes("--e2e");


// The Node suites, in the order `verify` ran them.
// THE UNIT SUITES THAT SURVIVE THE TESTING RULE — writes to the MatchDay API, and the guards
// that pin traps which have already cost a real production write. Nine model/scope suites for
// internal dashboards and read gates were deleted with the policy change; a wrong number on an
// internal screen is visible to Ryan and says so faster than a suite does.
//
// matchops-auth-test is KEPT despite testing reads: a route shipped with NO gate is invisible
// on screen, which is exactly the case a suite has to cover.
const NODE_SUITES = [
  // The city boundary's decision table — including the one rule that disagrees with the
  // city-manager tier on purpose (confinement beats is_admin).
  "scripts/city-confinement-test.ts",
  // The credits city scope. Its own suite because it guards MONEY on a route whose guard cannot be
  // exercised without a confined login — the decision is pure, so it runs on every commit instead.
  "scripts/credits-city-scope-test.ts",
  // The Growth right. can_access_growth meant Player Lifecycle until 2026-08-23 and now means the
  // Growth tab; a stale grant read as a new one is the failure the whole rename exists to prevent,
  // and no browser suite can see it — 0140 reset the column on every row, so the interesting rows
  // do not exist to log in as.
  // THE PWA's LAUNCH ROUTE. verify-city-confinement drives /city/* directly and passes; an
  // installed app opens manifest.json's start_url instead, which was a Match Ops page no city
  // manager can open. The suite tested the rooms and nothing tested the door.
  "scripts/pwa-launch-door-test.ts",
  "scripts/warsaw-city-test.ts",
  // WARSAW — the first city that is not in types.CITIES. Nothing had ever tested one, which is how
  // a half-registered city shipped: WAW was in CITY_SCOPES and nowhere else. Also holds the line
  // the other way — a partner market must never appear in CITIES or CITY_DISPLAY_ORDER.
  // META AD SPEND. In the fast set because it is a background job that DELETES rows in the finance
  // ledger and rewrites them. Its three failure modes are all silent: a dropped market understates
  // spend, a widened ownership predicate eats hand-entered rows with no undo, and a float in the
  // money path is wrong for months before anyone notices. None are visible on the page.
  // EVERY PARTNER'S COST MUST EQUAL THEIR PAYOUT. buildPartnerPayoutsByVenueMonth had a fixed
  // argument list that could only express flat_percentage, so PARMER's RENTAL_PLUS_PROFIT_SHARE
  // deal was computed on stale seed columns — $1,815 on every internal surface against $2,006 on
  // the partner's own page. Structural, not numeric: it also fails if a NEW PayoutModel is added
  // without a parity case, so the next non-standard deal cannot quietly misstate a city.
  // RECURRING EXPENSES — ONE WINDOW, THREE READOUTS, ONE NUMBER. The page had two period controls
  // that never spoke: the chips summed the quarter while the header said August, and the TOTAL
  // column summed a window that excluded columns sitting right beside it, so rows with real May
  // and June money totalled $0.00. Structural — it asserts the chip, the row totals and the
  // booked total are the same figure at every grain.
  // APPLICATIONS — the element_id collision. Elementor stores the field ID and never the label,
  // and field_dff8b68 is Company on the partnerships form and Last Name on the team application.
  // A global id->label map files partner companies into applicants' surnames. Also guards the
  // rule that spam must never key on location: Georgia is a US state and Atlanta is in it.
  "scripts/web-submissions-test.ts",
  // MEMBERSHIP CHARTS. Two of these guard bugs that were invisible by eye in the mockup: an axis
  // whose top tick stops below the series max (the tallest bar then leaves the chart silently under
  // overflow:visible) and a tooltip that escapes its card at either end of a series. The third
  // comes from a shipped bug elsewhere — the Expenses page had a chip, a column total and a footer
  // summing three different windows and nothing caught it.
  "scripts/membership-chart-test.ts",
  "scripts/recurring-window-test.ts",
  "scripts/partner-payout-parity-test.ts",
  "scripts/meta-ad-spend-test.ts",
  // THE LEDGER FLOOR IS NOT A TUNABLE. Its own suite because the reason it exists is not the
  // obvious one: fin_expenses has NO rows of any kind before 2026-04-30, so ad spend in Dec-Mar
  // renders five months of P&L that read as complete and are not. Lowering the constant looks
  // harmless and is not; this fails with the reason in the message.
  "scripts/meta-expense-floor-test.ts",
  "scripts/mutation-tests.ts",
  "scripts/prod-guard-test.ts",
  "scripts/stage-denylist-test.ts",
  "scripts/change-log-test.ts",
  "scripts/write-routes-logged-test.ts",
  "scripts/walltime-guard-test.ts",
  // THE DRAWER'S DATE/TIME MODEL. A match-record write: a silent hour shift here moves
  // kickoff for everyone holding a spot, and it looks correct on screen while it does so.
  // Also the ONLY guard on an inverted pair — the API stores end-before-start without complaint
  // (staging 2557: 2xx, read back inverted), so nothing downstream will catch it.
  "scripts/matchwhen-test.ts",
  // ACTIVE MEMBERS, ONE PREDICATE. Three surfaces showed 391 / 387 / 455 under one label on
  // 2026-08-28. Nothing was broken — three code paths had each decided separately what a
  // "member" is. Runs Home's fold and the snapshot's fold over one fixture and requires the
  // same answer, with a control proving the fixture can tell the two apart.
  "scripts/membership-parity-test.ts",
  // FIELDS. A field record decides what a match says it was played on, and the two traps here
  // are silent: recommendedPlayerCount is a TOTAL (a 9v9 pitch stores 18, and the mockup sent
  // 9), and the create DTO is a whitelist where one extra key 400s the whole create.
  "scripts/fields-model-test.ts",
  // REVENUE IS PRE-TAX. mdapi_match_players carries two money columns that differ by the city's
  // sales tax rate (5-9%), and reading the wrong one produces a number that looks fine. It did,
  // for as long as the Data Room existed — and total_amount is only populated from 2025-12,
  // which is why 32 months rendered $0.00.
  "scripts/revenue-pretax-test.ts",
  // THE CONFINED MANAGER DROPDOWN. It decides who a city manager can put on a match, which
  // decides who gets paid, and it was wrong in both directions: NYC and El Paso offered NOBODY,
  // while SATX and DFW offered eight people on no roster at all.
  "scripts/city-manager-roster-test.ts",
  // THE TEAM-COUNT CONTROL. Changing TEAMS used to send {teamNumbers} alone, leaving the mode it
  // switched INTO holding a capacity nobody had set — production match 18125 landed on 4 teams
  // reading a stale maxTeamSize4Team and showed players a FRACTIONAL team size. The rung fields
  // are TOTALS, not per side, which is why the first assertion has a control on 9 vs 36.
  "scripts/team-shape-test.ts",
  // A VENUE'S TOTALS ARE ITS FIELDS', ADDED UP. Venues & Fields computes five per-venue numbers
  // the server never sent, so they are the ones that will drift — a filter applied to the rows
  // and not the total, a sort that drops one. The checker returns BREAKS, and an empty array is
  // both "reconciles" and "nothing was checked", so every assertion here carries a control.
  "scripts/venue-rollup-test.ts",
  // LAPSED-MEMBER SPOTS. The page is near-empty by design — 4 of 90 today — so an empty render and
  // a broken query look identical unless the denominator prints. The grouping is proven on a
  // fixture that HAS lapsed holders, and membership state is ANY row ACTIVE: 153 people hold an
  // ACTIVE and a CANCELED row at once, and newest-row logic would call every one of them lapsed.
  "scripts/lapsed-spots-test.ts",
  // A COPY CARRIES ITS PRICE. CREATE_FIELDS was nine keys doing double duty as required AND
  // allowed, so registrationPrice was actively REFUSED on create and the API defaults an absent
  // price to 0. Production 18408 sold 44 spots at $0 against $15 siblings. There is no paused
  // state to fall back on — the create endpoint refuses isCancelled — so the body being right at
  // creation is the whole of the safety.
  "scripts/copy-match-body-test.ts",
  // A MONEY FIELD YOU CAN TYPE IN. Both panels bound `value` to a formatted string on every
  // render, so the field reformatted on every keystroke and the caret landed in the cents.
  // Asserts focus -> type "12" -> blur reads 12.00 with 1200 on the wire, with a control that
  // fails if the field reformats mid-type.
  "scripts/money-input-test.ts",
  // CONVERT TO 4 TEAMS. It must not drift into auto-bump: the server's own bump stacks players on
  // team 1, never uses team 4, and sets a capacity of 28 that nothing derives. Ours is even, in
  // signup order, and the shape comes from teamCountWrites. Also pins the shape-first ordering,
  // the before-map, and that a partial failure names who is stranded.
  "scripts/convert-four-test.ts",
  // TWO REVENUE BASES, AND NO FIGURE MAY MIX THEM. Slate Review showed a pre-tax $12.00 DPP
  // beside a tax-inclusive membership share and called the sum revenue. This pins which call
  // site reads which helper, and the tax rates as GET /cities SERVES them — I measured OKC at
  // 8.65 and it is 8.625, and Warsaw is a real 0 that must never be divided.
  "scripts/revenue-basis-test.ts",
  "scripts/promo-model-test.ts",
  "scripts/cost-basis-confinement-test.ts",
  "scripts/cost-ratio-band-test.ts",
  "scripts/pace-projection-test.ts",
  "scripts/crm-characterize-test.ts",
  "scripts/crm-host-guard-test.ts",
  "scripts/seam-stripped-test.ts",
  "scripts/matchops-auth-test.ts",
  "scripts/crm-push-test.ts",
  "scripts/verify-checkin-model.ts",
  /* GAMEDAY OPS' STAT STRIP AND METER. Here because the fill percentage is the number an operator
   * judges a day by and the wrong definition of it is plausible (an average of per-match
   * percentages), and because `atRisk` decides which matches the page shouts about — a match that
   * is about to auto-cancel with too few real players is a match record about to say it did not
   * happen. */
  "scripts/gameday-strip-test.ts",
  /* THE FAKE-SPOT LADDER. Here because a fake count is DERIVED (fake = capacity - rung - real), so
   * a control that writes one writes to nothing, and a control that writes only the rung in force
   * silently reverses an hour later when the match crosses the next mark. Both are invisible at the
   * moment of the write and visible to a player as a match that looks full when it should have
   * cancelled. */
  "scripts/fake-ladder-test.ts",
  "scripts/roster-edit-model-test.ts",
  "scripts/credits-model-test.ts",
  "scripts/promo-edit-model-test.ts",
  // The 🎥 name transform — a MatchDay match-name write that reaches players in the live app.
  "scripts/veo-name-sync-test.ts",
  // The mirror write-through: only on LANDED, only the read-back value, production only.
  "scripts/mirror-writethrough-test.ts",
  // The Gusto payroll CSV — proves the email alias moved no amount or memo.
  "scripts/gusto-alias-email-test.ts",
  // /admin/fields — the field-ID → venue mapping. Not a write yet, but the number it will be
  // committed against: matches gained, revenue attributed, and cost added at the venue's rate,
  // including the event-marker exclusion that let ATH Pearland bill $0 for 26 months. A wrong
  // preview is a wrong decision taken deliberately, and no screen check can see the arithmetic.
  "scripts/field-id-admin-test.ts",
  // Finance › Cost, realized on both sides. Guards the wall-clock-as-instant trap (shipped three
  // times) with fixtures whose two readings disagree on purpose, and pins that NO path on that
  // page reads a cost override — the fixtures key one 100× the derived figure.
  "scripts/cost-realized-test.ts",
  // Match Promotion's NEW badge. Both decisions that carry the rule are invisible in the DOM — the
  // prior slate INCLUDING cancelled matches (excluding them mis-flagged 21 of 31), and the tests
  // nesting per field rather than per city (a city-wide reading lost 19 cases). A badge is a badge
  // on screen whichever way it was derived.
  "scripts/match-promotion-new-test.ts",
  // MATCH MANAGERS. Not here for the arithmetic — here for the NAME and the DEAD CONTROL. "City
  // manager" means three unrelated things in this codebase (a Clubhouse login with confinement, a
  // 6-row directory table, and this 87-person roster), and a label using the API's word would read
  // as correct forever while being wrong now. The other half pins CAN_ADD/CAN_REMOVE to false: the
  // MatchDay API exposes neither endpoint, so enabling either button compiles fine and ships a
  // control that does nothing. Both failures are invisible on screen.
  "scripts/match-managers-test.ts",
  // ASSIGNING A MANAGER TO A MATCH — the one write the API offers on this, and it decides WHO GETS
  // PAID. In the fast set under the bar's exception: it changes what a match record says happened
  // and what Manager Pay pays. Pins the detach value proven on staging (null detaches; "" is a 400;
  // an omitted field changes nothing), that the diff is the body, that a null managerId cannot
  // paint the first manager into the select, and that the confirmation names a person rather than
  // an id. The $20/$30 figure is asserted AGAINST payAmount rather than restated — two paths
  // answering one money question is the shape that cost four months on PARMER.
  "scripts/manager-assign-test.ts",
  // PLAYER LOOKUP'S SEARCH. In the fast set for the reason the bug survived so long: its own
  // comment claimed ?email= was a universal fuzzy over email, NAME and phone "confirmed live", and
  // it never matched a name at all — Anderson King was unfindable by his first name for the life of
  // the feature because his email happens to hold his last. The suite's first block is the
  // assertion that would have caught it and never existed: a player whose NAME contains the term
  // and whose EMAIL does not. It also pins that a two-word query is two predicates, and that the
  // header prints the TOTAL rather than the page size.
  "scripts/player-lookup-search-test.ts",
  // PLAYER DATA ROOM. In the fast set for the total, not the layout: a Total column that covered a
  // different window than the columns beside it is the THIRD total in this app to disagree with
  // what is on screen, after the Expenses chip/column/footer and the Membership KPI. It also pins
  // the one thing the brief asked for that is NOT true — a row total equals the sum of its visible
  // cells only for the ADDITIVE measures; for Players it is a distinct count and is deliberately
  // smaller — and the heat ramp's contrast ceiling as a number rather than an opinion.
  "scripts/data-room-test.ts",
  // CHURN. In the fast set for the tile that did nothing: it was a <button> inside a <button>, the
  // parser unnested it silently, and "click to show only these" was dead copy on a dead control —
  // no error, no warning, and nothing on screen to say so. Also pins that the window really
  // defaults to this year (all time was 9,427 people, a third of everyone who ever registered) and
  // that the middle tier's LABEL is derived from the threshold, so the tile and the filter cannot
  // disagree. The number 10 is not pinned anywhere; the relationship is.
  "scripts/churn-test.ts",
  // THE NAV BADGES AND THE MOUNT GATE. Not arithmetic — waste. Four hooks each fetched for
  // themselves from four different trees, so a cold page load fired 4× awaiting-count, 2×
  // manager-pay/week and 2× partner-dashboards/actionable at ~7s each. None of it blocks anything
  // on screen, which is exactly why it survived: the cost is entirely server-side and invisible.
  // Also pins that SectionFrame's opt-out DEFAULTS to the old behaviour, so freeing one section
  // cannot silently free the five that genuinely read g.data.
  "scripts/shared-badge-fetch-test.ts",
  // SOCCER CENTRAL'S TWO PITCHES. In the fast set because it guards a MONEY separation: the
  // doubling lives in the RATE ($180 on fin_venues 53), the charged unit count stays 1, and the
  // match count is 2 for denominators only. Double the rate and the units and a tournament bills
  // $360. The suite asserts no cost path can see matchUnits, and that the capacity constant is
  // behaviourally identical to the `> 22` it replaced across the whole integer range.
  "scripts/socc-two-pitch-test.ts",
  "scripts/members-by-city-test.ts",
  "scripts/lapsed-removal-test.ts",
  "scripts/manager-pay-added-test.ts",
  "scripts/month-and-copy-test.ts",
  "scripts/week-buckets-test.ts",
];
const ALL_E2E = readdirSync("scripts/e2e").filter((f) => /^verify-.*\.mjs$/.test(f)).sort().map((f) => `scripts/e2e/${f}`);
// --e2e runs EVERY browser suite. Nothing is excluded, because nothing is mandatory.
const suites = !E2E ? NODE_SUITES : ALL_E2E;
// e2e: 240s per suite — verify-year runs a full-year reconciliation and legitimately needs
// ~2-3 min; a shorter cap timed it out even though it passes.
/* THE CAP SCALES WITH THE POOL, because it measures WALL CLOCK and a pooled suite spends part of
 * that queueing behind its neighbours rather than working. 240s was set for a suite running alone;
 * applying it unchanged under contention is what turned three healthy suites red at concurrency 4.
 * The cap still does its job — catching a suite that has HUNG — it just stops calling contention a
 * hang. */
const BASE_TIMEOUT_MS = E2E ? 240_000 : 180_000;
let TIMEOUT_MS = () => BASE_TIMEOUT_MS;

function run(suite) {
  return new Promise((resolve) => {
    const isTs = suite.endsWith(".ts");
    const cmd = isTs ? "npx" : "node";
    const args = isTs ? ["tsx", suite] : [suite];
    const env = { ...process.env, ...(isTs ? { NODE_OPTIONS: "--conditions=react-server" } : {}) };
    const child = spawn(cmd, args, { env });
    let out = "";
    const grab = (b) => { out += b.toString(); };
    child.stdout.on("data", grab); child.stderr.on("data", grab);
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ suite, ok: false, why: `TIMED OUT after ${TIMEOUT_MS() / 1000}s`, out }); }, TIMEOUT_MS());
    child.on("close", (code) => {
      clearTimeout(timer);
      // last "(N) passed, (M) failed" anywhere in the output (also matches "Assertions: N passed, M failed")
      const matches = [...out.matchAll(/(\d+)\s+passed,\s+(\d+)\s+failed/g)];
      const last = matches[matches.length - 1];
      // exit 3 is the harness guard's NETWORK signal (retried 3×, gave up / died mid-run) — name it
      // so the summary line itself separates a network death from an assertion failure ("N failed").
      if (code === 3) return resolve({ suite, ok: false, why: "NETWORK — retried 3×, gave up (not an assertion failure; see output)", out });
      if (code !== 0) return resolve({ suite, ok: false, why: `exited ${code}`, out });
      if (!last) return resolve({ suite, ok: false, why: "ZERO ASSERTIONS — no 'N passed, M failed' summary (rotted mock / early return?)", out });
      const passed = Number(last[1]), failed = Number(last[2]);
      if (passed === 0) return resolve({ suite, ok: false, why: "ZERO ASSERTIONS — 0 passed (suite ran no checks)", out });
      if (failed > 0) return resolve({ suite, ok: false, why: `${failed} failed`, out });
      resolve({ suite, ok: true, passed, out });
    });
  });
}

// ── e2e: make sure a dev server is up (start one if not, tear it down after) ──
const ping = () => new Promise((res) => { const req = http.get("http://localhost:3000", () => { req.destroy(); res(true); }); req.on("error", () => res(false)); req.setTimeout(1500, () => { req.destroy(); res(false); }); });
let devProc = null;
if (E2E && !(await ping())) {
  console.log("↻ no dev server on :3000 — starting `npm run dev` …");
  devProc = spawn("npm", ["run", "dev"], { detached: true, stdio: "ignore" });
  const start = Date.now();
  while (Date.now() - start < 90_000) { if (await ping()) break; await new Promise((r) => setTimeout(r, 2000)); }
  if (!(await ping())) { console.log("✗ dev server did not come up in 90s"); if (devProc) try { process.kill(-devProc.pid, "SIGKILL"); } catch {} process.exit(1); }
  console.log("✓ dev up");
}

// ── WARM THE DEV SERVER BEFORE ANY SUITE (Phase 22, landed 29e) ──────────────
// `next dev` COMPILES ROUTES ON DEMAND, and the first suite to touch an uncompiled route pays
// for it inside its own waitForSelector/waitForFunction budget (10-30s). That is why timeout
// failures land on DIFFERENT suites from run to run and all pass when run alone — contention
// with the compiler, not a defect in what they assert.
//
// Paying the compile ONCE, sequentially, before any suite starts removes that. Measured on
// phase22-gate: 429s → 259s sequential.
//
// This is the dev-server half of the problem. The bigger lever (`next build && next start`) is
// deliberately NOT here: it is unmeasured and it strips the CRM realtime test seam that
// verify-crm-characterize depends on.
//
// Cherry-picked from phase22-gate 5eb553e — THIS BLOCK ONLY. The one-auth-event-per-run change
// and the concurrency switch in that commit did NOT come with it and remain unsoaked there.
if (E2E) {
  const WARM = [
    "/home", "/match-ops", "/match-ops/gameday", "/match-ops/change-log", "/match-ops/field-ops",
    "/match-ops/master-schedule", "/match-ops/partner-dashboards", "/match-ops/reviews",
    "/match-ops/slate-review", "/match-ops/promos", "/match-ops/player-lookup",
    "/match-ops/player-chats", "/match-ops/manager-pay/history",
    "/city/manager-pay", "/city/reviews", "/city/gameday",
    "/match-ops/match-panel/17494", "/match-ops/matches/2470", "/match-ops/matches/501/roster",
    "/matchops/checkin/2470",
  ];
  const t0 = Date.now();
  process.stdout.write(`↻ warming ${WARM.length} routes (next dev compiles on demand) `);
  for (const r of WARM) {
    try {
      const res = await fetch(`http://localhost:3000${r}`, { redirect: "manual" });
      await res.arrayBuffer().catch(() => {});
      process.stdout.write(".");
    } catch { process.stdout.write("x"); }
  }
  console.log(` done in ${Math.round((Date.now() - t0) / 1000)}s`);
}

// Wall-clock for the run, so every gate reports its own duration and a regression in the gate
// itself is visible rather than felt.
const RUN_T0 = Date.now();

/* EVERY SUITE REPORTS ITS OWN WALL CLOCK. The run total was the only number printed, so "the e2e
 * lane takes 19 minutes" could be answered but "which suites" could not — and the answer to that
 * is what decides whether the fix is parallelism, a timeout, or deleting something. The slowest
 * are listed again at the bottom so the tail is visible without re-reading 39 lines.
 *
 * ── THE E2E LANE RUNS IN A WORKER POOL ───────────────────────────────────────────────────────
 *
 * It was a serial for-await loop: 39 suites, 1,201s, each one launching its own Chromium and
 * logging in again. WHY IT HAD TO BE SERIAL WAS CROSS-SUITE INTERFERENCE — two suites writing the
 * same production rows race, and the loser reports a failure that has nothing to do with its own
 * subject. That reason is gone: the suites that write are quarantined and carry in-file refusals,
 * so what is left is a set of READERS against one shared dev server, and readers do not collide.
 *
 * TWO, NOT FOUR — AND FOUR WAS MEASURED, NOT GUESSED. The ceiling is not this machine, it is the
 * single `next dev` process every suite shares: dev compiles routes ON DEMAND, so four browsers
 * asking for different routes at once queue behind one compiler. At 4 the run did not just get
 * slower, it went RED — verify-matchpanel (138s serial), verify-pace-grain (129s) and
 * verify-period-anchor (144s) all blew the 240s cap, and two more suites failed outright. Five
 * failures the serial lane does not have.
 *
 * At 2 the contention is bounded and the slow suites stay inside their cap. If this needs to go
 * higher, the fix is NOT a bigger number — it is running the suites against `next build && next
 * start` instead of `next dev`, which removes on-demand compilation altogether. That is the real
 * ceiling and it is worth doing; it is not this change. Override with E2E_CONCURRENCY.
 *
 * THE NODE SET STAYS SERIAL. It is 28 suites and, with the production build now moved off this
 * path, ~29s in total — there is nothing to win, and several of those suites read and restore
 * shared files (tsconfig.json among them), which is exactly the interference this pool assumes
 * has been removed.
 */
const E2E_CONCURRENCY = Math.max(1, Number(process.env.E2E_CONCURRENCY ?? 2));
const POOL = E2E ? E2E_CONCURRENCY : 1;
TIMEOUT_MS = () => BASE_TIMEOUT_MS * POOL;

const results = [];
if (POOL === 1) {
  for (const s of suites) {
    process.stdout.write(`▶ ${s} … `);
    const t0 = Date.now();
    const r = await run(s);
    r.ms = Date.now() - t0;
    results.push(r);
    console.log((r.ok ? `ok (${r.passed} assertions)` : `FAIL — ${r.why}`) + ` · ${(r.ms / 1000).toFixed(1)}s`);
  }
} else {
  console.log(`▶ ${suites.length} suites, ${POOL} at a time\n`);
  /* ONE LINE PER SUITE, PRINTED ON COMPLETION — never a "▶ starting" line. Four workers
   * interleaving their starts and finishes on one stdout produces output that cannot be read,
   * and a half-written line is how a passing suite comes to look like a failing one. */
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= suites.length) return;
      const s = suites[i];
      const t0 = Date.now();
      const r = await run(s);
      r.ms = Date.now() - t0;
      results.push(r);
      console.log(
        `${r.ok ? "✓" : "✗"} ${s} … ` +
        (r.ok ? `ok (${r.passed} assertions)` : `FAIL — ${r.why}`) +
        ` · ${(r.ms / 1000).toFixed(1)}s`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, suites.length) }, () => worker()));
  // Completion order is ragged; the report reads better in the order the suites are listed.
  results.sort((a, b) => suites.indexOf(a.suite) - suites.indexOf(b.suite));
}
if (devProc) { try { process.kill(-devProc.pid, "SIGKILL"); } catch {} }

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}\n${results.length} suites · ${results.length - failed.length} ok · ${failed.length} FAILED · ${Math.round((Date.now() - RUN_T0) / 1000)}s`);
{
  const slow = [...results].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 8);
  const total = results.reduce((a, r) => a + (r.ms ?? 0), 0) || 1;
  const top = slow.reduce((a, r) => a + (r.ms ?? 0), 0);
  const wall = Date.now() - RUN_T0;
  console.log(
    `\nslowest ${slow.length} — ${Math.round((top / total) * 100)}% of ${Math.round(total / 1000)}s of suite time` +
    (POOL > 1 ? `, run in ${Math.round(wall / 1000)}s wall clock across ${POOL} workers` : "") + ":");
  for (const r of slow) console.log(`    ${((r.ms ?? 0) / 1000).toFixed(1).padStart(6)}s  ${r.suite}`);
}
for (const f of failed) {
  console.log(`\n✗ ${f.suite} — ${f.why}`);
  console.log(f.out.split("\n").slice(-12).map((l) => "    " + l).join("\n"));
}

process.exit(failed.length ? 1 : 0);
