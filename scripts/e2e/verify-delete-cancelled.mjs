// DELETE A CANCELLED MATCH — the one write on Master Schedule with no undo.
//
// Ryan: "we dont want it counting as a cancelled match because it confuses the data. When I am on
// master schedule in back office and put on show cancelled in grid I should be able to click on the
// cancelled match and delete it."
//
// NOTHING IS DELETED BY THIS SUITE. The match GET is answered from a fixture so the panel can be
// put into all three states, and the DELETE is intercepted and counted rather than sent. The route's
// own refusals were proven against STAGING, not here: a live match, a cancelled match with three
// players and one with five were each refused by the real route, and two cancelled empty staging
// matches were really destroyed and really 404 afterwards.
//
//   node scripts/e2e/verify-delete-cancelled.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/match-ops/master-schedule`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok    ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX    ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));
const head = (s) => console.log(`\n-- ${s} --`);
const T = async (p, s) => (await p.locator(s).first().textContent())?.replace(/\s+/g, " ").trim() ?? null;

/** The fixture match. A real shape, forced into whichever of the three states is under test. */
const FIXTURE = (cancelled, players) => ({
  id: 999001, name: "Fixture match", fieldTitle: "ATH Pearland", cityName: "Houston", cityId: 1,
  startDate: "2026-09-16T21:15:00.000Z", endDate: "2026-09-16T22:15:00.000Z",
  isCancelled: cancelled, teams: [], occupancy: players,
  maxPlayerCount: 18, minPlayerCount: 10, registrationPrice: 1200,
});

async function boot(browser, storageState, { cancelled, players, width = 1200 }) {
  const ctx = await browser.newContext({
    storageState, viewport: { width, height: 1000 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}),
  });
  const state = { deletes: 0, lastDelete: null };

  await ctx.route("**/api/matchday/**/matches/**", async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "DELETE") {
      /* COUNTED, NEVER SENT. This suite must not destroy anything, and "Keep it writes nothing" is
       * only assertable if a write would have been visible. */
      state.deletes += 1; state.lastDelete = url;
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, outcome: "landed", logRecorded: true, tombstoned: true, deleted: 999001 }) });
    }
    if (req.method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ match: FIXTURE(cancelled, players) }) });
  });

  /* THE ROSTER IS ITS OWN ROUTE. The panel counts attached players from /roster/{id}, not from the
   * match payload, so the player fixture has to live here or the real roster answers instead and
   * the empty case is never reachable. */
  await ctx.route("**/api/matchday/**/roster/**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    /* THE PANEL'S OWN RosterState SHAPE, read off the type rather than guessed. A near-miss shape
     * crashed the render on "Cannot read properties of null (reading 'team')" and the panel never
     * mounted, which read in the suite as "the delete control is missing" and was nothing of the
     * kind. */
    const rows = Array.from({ length: players }, (_, i) => ({
      umId: i + 1, playerId: i + 1, team: (i % 2) + 1, playerNumber: i + 1,
      name: `Player ${i + 1}`, phone: null, fake: false,
      email: `p${i + 1}@example.com`, paidStatus: "PAID", paid: 1200, charged: 1200, credit: 0,
    }));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      name: "Fixture match",
      teams: [{ id: 1, teamNumber: 1, name: "A", locked: false }, { id: 2, teamNumber: 2, name: "B", locked: false }],
      players: rows, shape: { teamN: 2, perTeam: 9 }, maxPlayerCount: 18, occupancy: players,
      hidden: { total: 0, cancelled: 0, unpaid: 0, refunded: 0 },
    }) });
  });

  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 240000 });
  await p.waitForTimeout(1500);
  return { ctx, p, errs, state };
}

/** Open the panel the way an operator does: switch to the week grid and click a match card.
 *
 *  THE PAGE OPENS ON MONTH, whose cards are a different component with no card testid, so the view
 *  is switched first. WHICH card is clicked does not matter: the match GET is intercepted, so every
 *  one of them opens the fixture. */
async function openPanel(p) {
  /* TWO ATTEMPTS, because the week grid is a real fetch on a heavy page and one slow load is not a
   * failure of the thing under test. A third would be papering over something. */
  for (let attempt = 0; attempt < 2; attempt++) {
    await p.locator("button", { hasText: /^Week$/ }).first().click().catch(() => {});
    await p.waitForSelector('[data-testid="card"]', { timeout: 90000 }).catch(() => {});
    const card = p.locator('[data-testid="card"]').first();
    if (!(await card.count())) { await p.waitForTimeout(2000); continue; }
    const id = await card.getAttribute("data-id");
    await card.click().catch(() => {});
    await p.waitForSelector('[data-testid="mp-danger"]', { timeout: 45000 }).catch(() => {});
    await p.waitForTimeout(900);
    if ((await p.locator('[data-testid="mp-danger"]').count()) > 0) return id ?? true;
  }
  return false;
}

async function main() {
  const browser = await chromium.launch();
  const { storageState } = await storageStateFor(ADMIN, BASE);

  /* ── THE SOURCE, WHICH IS WHERE THE RULES ACTUALLY LIVE ─────────────────────────────────── */
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync("src/components/MatchPanel.tsx", "utf8");
  const route = readFileSync("src/app/api/matchday/[env]/matches/[id]/route.ts", "utf8");
  const client = readFileSync("src/lib/matchdayStageApi.ts", "utf8");

  head("the deny list is still a deny list");
  yes("DELETE /admin/matches/{id} is still on it",
    /segs: \["admin", "matches", null\]/.test(client));
  yes("  with a NAMED unlock rather than the line removed", /unlock: "delete-match"/.test(client));
  const unlocked = (route.match(/"delete-match"/g) ?? []).length;
  is("  and the delete route is the one call site that passes it", unlocked, 1);

  head("the route refuses before it calls anything");
  yes("it gates on editMatches, the same capability the PUT uses",
    /authenticateCapability\(req, "editMatches"\)/.test(route.split("export async function DELETE")[1] ?? ""));
  yes("  and on assertMatchInScope, so a confined city cannot reach another city's match",
    /assertMatchInScope/.test(route.split("export async function DELETE")[1] ?? ""));
  yes("  it refuses a match that is not cancelled", /isCancelled !== true/.test(route));
  yes("  and one that still has players, with the count in the message",
    /still attached to this match/.test(route) && /players: attached/.test(route));
  yes("  the verdict is a 404 read-back, not a 2xx", /a\.present === false/.test(route));
  yes("  and it goes through recordWrite", /recordWrite\(/.test(route.split("export async function DELETE")[1] ?? ""));

  // ══ THE PANEL, IN ITS THREE STATES ════════════════════════════════════════════════════════
  head("a live match has no delete control at all");
  {
    const b = await boot(browser, storageState, { cancelled: false, players: 0 });
    is("no page error", b.errs.length, 0);
    yes("the panel opened", !!(await openPanel(b.p)));
    is("there is NO delete section on a live match", await b.p.locator('[data-testid="mp-del-zone"]').count(), 0);
    is("  CONTROL: not a disabled button, no button", await b.p.locator('[data-testid="mp-del-open"]').count(), 0);
    is("  CONTROL: and nothing was sent", b.state.deletes, 0);
    await closeContext(b.ctx);
  }

  head("cancelled, but players still attached");
  {
    const b = await boot(browser, storageState, { cancelled: true, players: 3 });
    const opened = await openPanel(b.p);
    is("no page error", b.errs.slice(0, 1), []);
    yes("the panel opened", !!opened);
    is("the delete control is present", await b.p.locator('[data-testid="mp-del-open"]').count(), 1);
    yes("  and disabled", await b.p.locator('[data-testid="mp-del-open"]').isDisabled());
    const why = await T(b.p, '[data-testid="mp-del-blocked"]');
    yes(`with the reason and the count: "${why?.slice(0, 44)}…"`, /3 players are still attached/.test(why ?? ""));
    yes("  and what deleting would destroy", /refunded/.test(why ?? ""));
    await b.p.locator('[data-testid="mp-del-open"]').click({ force: true }).catch(() => {});
    await b.p.waitForTimeout(300);
    is("CONTROL: clicking it opens no confirm", await b.p.locator('[data-testid="mp-del-confirm"]').count(), 0);
    is("  CONTROL: and sent nothing", b.state.deletes, 0);
    await closeContext(b.ctx);
  }

  head("cancelled and empty, the one case that deletes");
  {
    const b = await boot(browser, storageState, { cancelled: true, players: 0 });
    is("no page error", b.errs.length, 0);
    const openedId = await openPanel(b.p);
    yes("the panel opened", !!openedId);
    is("  CONTROL: and there is no refusal to read", await b.p.locator('[data-testid="mp-del-blocked"]').count(), 0);
    yes("the delete control is live", !(await b.p.locator('[data-testid="mp-del-open"]').isDisabled()));

    /* THE DESTRUCTIVE CONTROL IS NOT BESIDE THE ROUTINE ONES. */
    const geo = await b.p.evaluate(() => {
      const dz = document.querySelector('[data-testid="mp-del-zone"]');
      const cz = document.querySelector('[data-testid="mp-danger"]');
      const btn = document.querySelector('[data-testid="mp-del-open"]');
      const cs = getComputedStyle(dz);
      return { below: dz.getBoundingClientRect().top >= cz.getBoundingClientRect().top,
        rule: cs.borderTopWidth, h: btn.getBoundingClientRect().height,
        bg: getComputedStyle(btn).backgroundColor };
    });
    yes("delete sits below the match facts and below cancel", geo.below);
    yes(`  separated by a rule (${geo.rule})`, parseFloat(geo.rule) > 0);
    yes(`  and is ${Math.round(geo.h)}px`, geo.h >= 32);
    is("CONTROL: the button in the panel is outlined, not a solid red invitation", geo.bg, "rgb(255, 255, 255)");

    await b.p.locator('[data-testid="mp-del-open"]').click();
    await b.p.waitForTimeout(400);
    yes("it opens a confirm rather than deleting", (await b.p.locator('[data-testid="mp-del-confirm"]').count()) > 0);
    is("  CONTROL: and still sent nothing", b.state.deletes, 0);
    const what = await T(b.p, '[data-testid="mp-del-what"]');
    yes(`the confirm names the field: "${what}"`, /ATH Pearland/.test(what ?? ""));
    yes("  the date", /Wed 16 Sep 2026/.test(what ?? ""));
    yes("  the time", /9:15 PM/.test(what ?? ""));
    /* THE ID IS THE ONE THE PANEL WAS OPENED FOR, not the fixture's. The payload is intercepted but
     * the panel deletes the match it was opened on, which is the behaviour that matters: the confirm
     * and the request must name the SAME match. */
    yes(`  and the match id it was opened for (${openedId})`, new RegExp(String(openedId)).test(what ?? ""));
    const warn = await T(b.p, '[data-testid="mp-del-warn"]');
    yes("and says it cannot be undone", /cannot be restored/.test(warn ?? ""));
    yes("  naming the reports it changes, which is the point of doing it", /cancellation figures/.test(warn ?? ""));
    yes("  CONTROL: no em-dash in the confirm copy", !/—/.test(`${what} ${warn}`));
    const goBg = await b.p.locator('[data-testid="mp-del-go"]').evaluate((e) => getComputedStyle(e).backgroundColor);
    yes(`  and only the CONFIRM button is solid (${goBg})`, goBg !== "rgb(255, 255, 255)");

    /* KEEP IT DOES NOTHING WHATSOEVER. */
    await b.p.locator('[data-testid="mp-del-keep"]').click();
    await b.p.waitForTimeout(300);
    is("Keep it closes the confirm", await b.p.locator('[data-testid="mp-del-confirm"]').count(), 0);
    is("  CONTROL: and wrote nothing", b.state.deletes, 0);
    yes("  CONTROL: the control is still there to use", (await b.p.locator('[data-testid="mp-del-open"]').count()) > 0);

    /* AND THE CONFIRM'S OWN BUTTON IS THE ONLY THING THAT SENDS. */
    await b.p.locator('[data-testid="mp-del-open"]').click();
    await b.p.waitForTimeout(300);
    await b.p.locator('[data-testid="mp-del-go"]').click();
    await b.p.waitForTimeout(900);
    is("confirming sends exactly one delete", b.state.deletes, 1);
    yes(`  to the SAME match the confirm named: ${b.state.lastDelete}`,
      new RegExp(`/matches/${openedId}$`).test(b.state.lastDelete ?? ""));
    await closeContext(b.ctx);
  }

  // ══ SIZES ═════════════════════════════════════════════════════════════════════════════════
  for (const width of [390, 1200]) {
    head(`${width}px`);
    const b = await boot(browser, storageState, { cancelled: true, players: 0, width });
    is("no page error", b.errs.length, 0);
    yes("the panel opened", !!(await openPanel(b.p)));
    await b.p.locator('[data-testid="mp-del-open"]').click();
    await b.p.waitForTimeout(400);
    const hs = await b.p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    is("no horizontal scroll", hs, false);
    const over = await b.p.evaluate(() =>
      [...document.querySelectorAll('[data-testid="mp-del-zone"], [data-testid="mp-del-confirm"], .mp-danger')]
        .filter((e) => e.scrollWidth > e.clientWidth + 2).length);
    is("nothing overflows its own box", over, 0);
    const btns = nonEmpty(await b.p.$$eval('[data-testid="mp-del-keep"], [data-testid="mp-del-go"]',
      (es) => es.map((e) => Math.round(e.getBoundingClientRect().height))), `${width}px confirm buttons`);
    is(`the confirm has its two buttons (${btns.join("/")}px)`, btns.length, 2);
    yes(`  and both are at least 32px`, Math.min(...btns) >= 32);
    const w = await b.p.locator('[data-testid="mp-del-confirm"]').evaluate((e) => Math.round(e.getBoundingClientRect().width));
    yes(`  the confirm fits the screen (${w}px inside ${width}px)`, w <= width);
    is("  CONTROL: and nothing was sent while measuring", b.state.deletes, 0);
    await closeContext(b.ctx);
  }

  await closeBrowser(browser);
  console.log(`\ndelete-cancelled: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(2); });
