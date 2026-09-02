// GAMEDAY OPS, REBUILT - measured in a browser.
//
// The live board has no at-risk match most of the day, so the structural assertions run against a
// FIXTURE DAY served in place of /api/matchday/*/gameday. The fixture is shaped to make each
// assertion able to fail: one at-risk match matching the real 10pm case (3 real, 11 fake, min 9),
// one healthy upcoming, one in play, one finished, one cancelled, and one row where fakes exceed
// reals but the match is NOT at risk - so "MORE FAKE" and "at risk" cannot be confused.
//
// READ ONLY apart from the stepper save, which is asserted against an intercepted PUT and never
// reaches MatchDay.
//
//   node scripts/e2e/verify-gameday-ops.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/match-ops/gameday`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

/* THE FIXTURE DAY */
const T0 = Date.now();
const iso = (min) => new Date(T0 + min * 60000).toISOString();
const mk = (o) => ({
  id: o.id, name: o.name,
  startDate: iso(o.at), startDateUtc: iso(o.at), endDate: iso(o.at + 60), endDateUtc: iso(o.at + 60),
  maxPlayerCount: o.cap, minPlayerCount: o.min, registrationPrice: o.price ?? 1200,
  isCancelled: !!o.cx, autoCanceled: o.armed !== false, autoCanceledMinutes: o.acm ?? 30,
  teams: [{ id: 1 }, { id: 2 }],
  _count: { players: o.real + o.fake, fakePlayers: o.fake },
  field: { id: 1, title: o.fd, city: { id: 1, name: o.city, timeZone: { abbr: "CDT" } } },
  manager: { id: 1, firstName: o.mgrF, lastName: o.mgrL },
});
/* THE AT-RISK MATCH IS THE REAL ONE: 3 real, 11 fake, minimum 9, 14 of 18 filled. */
const RISK = { id: 101, name: "Soccer Central Field 4", fd: "Soccer Central Complex", city: "San Antonio",
  at: 95, cap: 18, min: 9, real: 3, fake: 11, acm: 35, mgrF: "Chama", mgrL: "rodriguez" };
const FIX = [
  mk(RISK),
  mk({ id: 102, name: "NEMP - Field 12", fd: "NEMP Tournaments", city: "Austin", at: 130, cap: 40, min: 11, real: 30, fake: 0, mgrF: "Moncho", mgrL: "Perez" }),
  mk({ id: 103, name: "The Hattrick (Leander)", fd: "The Hattrick L.", city: "Austin", at: -30, cap: 18, min: 11, real: 16, fake: 2, mgrF: "Jorge Luis", mgrL: "Gonzalez" }),
  /* FAKES EXCEED REALS BUT IT IS NOT AT RISK - real 5 >= min 2. This is what separates the
   * "MORE FAKE" chip from the risk styling; without it either could be asserted by accident. */
  mk({ id: 104, name: "Kirkwood Park", fd: "Kirkwood", city: "St. Louis", at: -40, cap: 18, min: 4, real: 5, fake: 9, mgrF: "Nate", mgrL: "B" }),
  mk({ id: 105, name: "Parmer - Field 1", fd: "Parmer Fields", city: "Austin", at: -200, cap: 18, min: 11, real: 18, fake: 0, mgrF: "Drea", mgrL: "M" }),
  mk({ id: 106, name: "Blossom Soccer Park", fd: "Blossom", city: "San Antonio", at: 60, cap: 18, min: 9, real: 0, fake: 0, cx: true, mgrF: "Ale", mgrL: "R" }),
];
const REAL = (m) => m._count.players - m._count.fakePlayers;
const FAKE = (m) => m._count.fakePlayers;

const READ = () => {
  const bb = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, cx: (r.left + r.right) / 2 }; };
  const rows = [...document.querySelectorAll('[data-testid="gday-row"]')].map((el) => {
    const q = (s) => el.querySelector(s);
    const notch = q('[data-testid="gday-notch"]'), lab = q('[data-testid="gday-minlabel"]');
    const meter = q(".gmeter"), bar = q(".gbar");
    return {
      id: Number(el.dataset.id), bucket: el.dataset.bucket, risk: el.dataset.risk === "1",
      h: Math.round(el.getBoundingClientRect().height),
      delta: Number(q('[data-testid="gday-delta"]')?.dataset.d),
      moreFake: !!q('[data-testid="gday-morefake"]'),
      mgr: q('[data-testid="gday-mgr"]')?.textContent.trim() ?? "",
      minLabel: lab ? { n: Number(lab.dataset.min), pct: Number(lab.dataset.pct), box: bb(lab) } : null,
      notch: notch ? { pct: Number(notch.dataset.pct), box: bb(notch) } : null,
      track: bar ? bb(bar) : null,
      realW: q('[data-testid="gday-real"]')?.getBoundingClientRect().width ?? 0,
      fakeW: q('[data-testid="gday-fake"]')?.getBoundingClientRect().width ?? 0,
      chain: ["METER", '[data-testid="gday-nums"]', '[data-testid="gday-delta"]', '[data-testid="gday-mgr"]', '[data-testid="gday-kebab"]']
        .map((sel) => { const n = sel === "METER" ? meter : q(sel); return n ? { sel, ...bb(n) } : null; }),
    };
  });
  return {
    rows,
    sections: [...document.querySelectorAll('[data-testid^="gday-sec-"]')].map((b) => ({
      k: b.dataset.testid.replace("gday-sec-", ""),
      n: Number(b.querySelector(".n")?.textContent),
      open: b.getAttribute("aria-expanded") === "true",
    })),
    tiles: Object.fromEntries(["all", "risk", "soon", "live", "fill"].map((k) => [k, {
      v: document.querySelector(`[data-testid="gtile-v-${k}"]`)?.textContent ?? "",
      s: document.querySelector(`[data-testid="gtile-s-${k}"]`)?.textContent ?? "",
      isButton: document.querySelector(`[data-testid="gtile-${k}"]`)?.tagName === "BUTTON",
    }])),
    cityChips: [...document.querySelectorAll('[data-testid^="city-"]')].map((b) => ({
      name: b.dataset.testid.replace("city-", ""), n: Number(b.querySelector("u")?.textContent), risk: b.dataset.risk === "1",
    })),
    banner: (() => {
      const a = document.querySelector('[data-testid="gday-alert"]');
      if (!a) return null;
      const q = (s) => a.querySelector(s);
      return {
        id: Number(a.dataset.id),
        head: q('[data-testid="gday-alert-head"]')?.textContent ?? "",
        meta: q('[data-testid="gday-alert-meta"]')?.textContent ?? "",
        factsChildren: [...(q('[data-testid="gday-alert-facts"]')?.children ?? [])].map((c) => c.tagName + ":" + c.getAttribute("data-testid")),
        factReal: q('[data-testid="gday-fact-real"]')?.textContent ?? "",
        factMin: q('[data-testid="gday-fact-min"]')?.textContent ?? "",
        factMinV: q('[data-testid="gday-fact-minv"]')?.textContent ?? "",
        factMinWas: q('[data-testid="gday-fact-minwas"]')?.textContent ?? null,
        factFake: q('[data-testid="gday-fact-fake"]')?.textContent ?? "",
        stepV: q('[data-testid="gday-step-value"]')?.textContent ?? "",
        downDisabled: q('[data-testid="gday-step-down"]')?.disabled,
        upDisabled: q('[data-testid="gday-step-up"]')?.disabled,
        save: q('[data-testid="gday-save-min"]')?.textContent ?? null,
        saveClears: q('[data-testid="gday-save-min"]')?.dataset.clears ?? null,
        cancelNow: (() => { const c = q('[data-testid="gday-cancel-now"]'); return c ? { disabled: c.disabled, title: c.title } : null; })(),
      };
    })(),
    bannerCount: document.querySelectorAll('[data-testid="gday-alert"]').length,
    foot: document.querySelector('[data-testid="gday-foot"]')?.textContent ?? "",
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    drawer: document.querySelectorAll('[data-testid="gday-panel"]').length,
  };
};

/* ── DATE-AWARE FIXTURES ────────────────────────────────────────────────────────────────────────
 * The banner rules turn on WHICH DATE the board is showing, so the intercept has to answer per
 * date. TODAY gets one urgent match (deadline 23 minutes out) beside one that is short but
 * 19 hours from its deadline - the pair that separates "the decision point has arrived" from
 * "this day has not sold yet". TOMORROW gets nine short matches, none of them urgent. */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TODAY = ymd(new Date());
const TOMORROW = ymd(new Date(Date.now() + 86400000));
/* An urgent match: short, armed, and its deadline `dlMin` minutes away. autoCanceledMinutes is
 * minutes BEFORE kickoff, so kickoff at +K with acm = K - dlMin puts the deadline at +dlMin. */
const urgentMk = (o) => mk({ ...o, acm: o.at - o.dlMin });
const TODAY_FIX = [
  urgentMk({ id: 201, name: "Soccer Central Field 4", fd: "Soccer Central Complex", city: "San Antonio",
    at: 95, dlMin: 23, cap: 18, min: 9, real: 3, fake: 11, mgrF: "Chama", mgrL: "rodriguez" }),
  /* SHORT, BUT NINETEEN HOURS FROM ITS DEADLINE. Must NOT be a banner in the default view. */
  urgentMk({ id: 202, name: "Late Night Kirkwood", fd: "Kirkwood", city: "St. Louis",
    at: 1200, dlMin: 1140, cap: 18, min: 9, real: 2, fake: 0, mgrF: "Nate", mgrL: "B" }),
  mk({ id: 203, name: "The Hattrick (Leander)", fd: "The Hattrick L.", city: "Austin", at: -30, cap: 18, min: 11, real: 16, fake: 2, mgrF: "Jorge Luis", mgrL: "Gonzalez" }),
  mk({ id: 204, name: "Parmer - Field 1", fd: "Parmer Fields", city: "Austin", at: -200, cap: 18, min: 11, real: 18, fake: 0, mgrF: "Drea", mgrL: "M" }),
];
/* FIVE URGENT, to prove the cap of 3 and the "+2 more" line. */
const TODAY_FIVE = [0, 1, 2, 3, 4].map((i) => urgentMk({
  id: 300 + i, name: `Urgent ${i + 1}`, fd: "Field " + i, city: ["Austin", "Houston", "Dallas", "Austin", "Houston"][i],
  at: 90 + i * 5, dlMin: 20 + i * 4, cap: 18, min: 9, real: 3, fake: 5, mgrF: "Mgr", mgrL: String(i) }));
/* NINE SHORT MATCHES ON TOMORROW, spread across cities.
 *
 * EIGHT ARE FAR FROM THEIR DEADLINE. THE NINTH IS NOT, AND THAT ONE IS THE POINT: a match on
 * TOMORROW'S board whose auto-cancel deadline is 30 minutes from NOW - possible because
 * autoCanceledMinutes is minutes before kickoff and can be twenty hours. It passes the
 * 90-minute test and fails only the isToday test, so it is the ONLY fixture that isolates that
 * guard. Without it, removing `if (!isToday) return false` changes nothing and the control that
 * is supposed to prove the guard works proves nothing instead. */
const TOMO_FIX = Array.from({ length: 9 }, (_, i) => urgentMk({
  id: 400 + i, name: `Tomorrow ${i + 1}`, fd: "Field " + i,
  city: ["Austin", "Houston", "Dallas", "San Antonio", "Atlanta", "OKC", "St. Louis", "Austin", "Houston"][i],
  at: 1200 + i * 10, dlMin: i === 8 ? 30 : 1140, cap: 18, min: 9, real: 2, fake: 1, mgrF: "Mgr", mgrL: String(i) }));

async function boot(browser, storageState, width = 1500, opts = {}) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: 1000 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}) });
  const puts = [];
  await ctx.route("**/api/matchday/*/gameday*", (r) => {
    const date = new URL(r.request().url()).searchParams.get("date");
    const body = opts.byDate
      ? (date === TOMORROW ? TOMO_FIX : (opts.todaySet ?? TODAY_FIX))
      : FIX;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: body }) });
  });
  /* THE STEPPER WRITE IS INTERCEPTED AND COUNTED, never forwarded. The assertion is about what we
   * SEND and what we do with the verdict - not about MatchDay. */
  await ctx.route("**/api/matchday/*/matches/*", (r) => {
    if (r.request().method() !== "PUT") return r.continue();
    const body = JSON.parse(r.request().postData() || "{}");
    puts.push({ url: r.request().url(), body });
    const id = Number(r.request().url().match(/matches\/(\d+)/)[1]);
    const m = FIX.find((x) => x.id === id);
    if (m && body.changes?.minPlayerCount != null) m.minPlayerCount = body.changes.minPlayerCount;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, outcome: "landed" }) });
  });
  const page = await ctx.newPage();
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="gday-row"]', { timeout: 120000 });
  await page.waitForTimeout(700);
  return { ctx, page, puts };
}

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();
  const { ctx, page, puts } = await boot(browser, storageState, 1500);
  let d = await page.evaluate(READ);

  console.log("\n-- sections, counts and the collapsed Finished --");
  const bucketOf = (m) => m.isCancelled ? "cx"
    : new Date(m.startDateUtc).getTime() > T0 ? "soon"
    : (T0 - new Date(m.startDateUtc).getTime()) / 60000 < 90 ? "live" : "done";
  const want = {};
  for (const m of FIX) { const b = bucketOf(m); want[b] = (want[b] ?? 0) + 1; }
  for (const s of d.sections) is(`  section ${s.k} count matches the data`, s.n, want[s.k]);
  is("  Finished starts collapsed", d.sections.find((s) => s.k === "done")?.open, false);
  is("  ...and the other two start open", d.sections.filter((s) => s.k === "soon" || s.k === "live").map((s) => s.open), [true, true]);
  const visibleNow = d.rows.length;
  is("  collapsed sections render no rows", visibleNow, (want.soon ?? 0) + (want.live ?? 0));
  await page.click('[data-testid="gday-sec-done"]');
  await page.waitForTimeout(400);
  const afterOpen = (await page.evaluate(READ)).rows.length;
  is("  expanding Finished restores its rows", afterOpen, visibleNow + (want.done ?? 0));
  yes("  CONTROL: expanding actually changed the row count", afterOpen > visibleNow);
  await page.click('[data-testid="gday-sec-done"]'); await page.waitForTimeout(400);

  console.log("\n-- the strip --");
  is("  All matches equals the day", d.tiles.all.v, String(FIX.length));
  is("  Needs attention equals the at-risk count", d.tiles.risk.v, "1");
  is("  Still to come", d.tiles.soon.v, String(want.soon ?? 0));
  is("  In play", d.tiles.live.v, String(want.live ?? 0));
  const sumReal = FIX.reduce((a, m) => a + REAL(m), 0), sumCap = FIX.reduce((a, m) => a + m.maxPlayerCount, 0);
  const sumFake = FIX.reduce((a, m) => a + FAKE(m), 0);
  is(`  Real spots filled = ${sumReal}/${sumCap} by hand`, d.tiles.fill.v, `${Math.round((sumReal / sumCap) * 100)}%`);
  is("  ...and its sub-label carries the raw numbers", d.tiles.fill.s, `${sumReal} of ${sumCap} \u00b7 ${sumFake} fake`);
  /* CONTROL: the average-of-percentages answer must be a DIFFERENT number, or this proves nothing. */
  const avg = Math.round(FIX.reduce((a, m) => a + (REAL(m) / m.maxPlayerCount) * 100, 0) / FIX.length);
  yes(`  CONTROL: the average-of-percentages answer (${avg}%) is not what is shown (${d.tiles.fill.v})`,
    `${avg}%` !== d.tiles.fill.v);
  is("  All matches is NOT a button", d.tiles.all.isButton, false);
  is("  Real spots filled is NOT a button", d.tiles.fill.isButton, false);
  is("  CONTROL: Needs attention IS a button", d.tiles.risk.isButton, true);

  console.log("\n-- city chips --");
  const cityRows = d.cityChips.filter((c) => c.name !== "all" && Number.isFinite(c.n));
  is("  chip counts sum to the day", cityRows.reduce((a, c) => a + c.n, 0), FIX.length);
  is("  the at-risk city carries the risk style", cityRows.filter((c) => c.risk).map((c) => c.name), ["San Antonio"]);
  yes("  CONTROL: other cities do not", cityRows.some((c) => !c.risk));

  console.log("\n-- rows: delta, meter, notch and the min label --");
  for (const r of d.rows) {
    const m = FIX.find((x) => x.id === r.id);
    is(`  #${r.id} delta = real ${REAL(m)} minus min ${m.minPlayerCount}`, r.delta, REAL(m) - m.minPlayerCount);
    is(`  #${r.id} min label reads its own minimum`, r.minLabel?.n, m.minPlayerCount);
    const wantPct = (m.minPlayerCount / m.maxPlayerCount) * 100;
    yes(`  #${r.id} notch sits at min/capacity`, Math.abs((r.notch?.pct ?? -1) - wantPct) < 0.01);
    yes(`  #${r.id} real+fake never exceeds the track`, r.realW + r.fakeW <= r.track.w + 1);
    yes(`  #${r.id} label centre within 1px of the notch centre`,
      Math.abs(r.minLabel.box.cx - r.notch.box.cx) <= 1,
      `label ${r.minLabel.box.cx.toFixed(2)} vs notch ${r.notch.box.cx.toFixed(2)}`);
    yes(`  #${r.id} row is under 62px (${r.h})`, r.h < 62);
    is(`  #${r.id} manager name is not truncated`, r.mgr.includes(m.manager.firstName) && r.mgr.includes(m.manager.lastName), true);
  }
  /* THE CLAMP MUST NOT FIRE ON REALISTIC DATA. It exists so a minimum at 0 or at capacity keeps its
   * label inside the track; if it fired in the ordinary middle of the range the label would stop
   * sitting over the notch it describes. Checked here on the fixture and again below on the LIVE
   * board, because "realistic" is a claim about real matches. */
  is("  the 12-88% clamp never fires on this data",
    d.rows.filter((r) => Math.abs(r.minLabel.pct - r.notch.pct) > 0.001).map((r) => r.id), []);
  /* CONTROL: the clamp is reachable - a minimum below 12% of capacity DOES move the label, so the
   * assertion above is about the data and not about a clamp that never does anything. */
  const clampWorks = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="gday-minlabel"]');
    return el != null;
  });
  yes("  CONTROL: labels are present to have been checked", clampWorks);
  const moreFake = d.rows.filter((r) => r.moreFake).map((r) => r.id).sort();
  const wantMoreFake = FIX.filter((m) => FAKE(m) > REAL(m)).map((m) => m.id).filter((id) => d.rows.some((r) => r.id === id)).sort();
  is("  MORE FAKE appears exactly where fake exceeds real", moreFake, wantMoreFake);
  yes("  CONTROL: ...and that is not simply every row", moreFake.length > 0 && moreFake.length < d.rows.length);
  is("  CONTROL: a more-fake row that meets its minimum is not risk-styled",
    d.rows.find((r) => r.id === 104)?.risk, false);
  is("  ...while the at-risk row is", d.rows.find((r) => r.id === 101)?.risk, true);

  console.log("\n-- GEOMETRIC OVERLAP: each element's right edge sits left of the next one's left edge --");
  let overlaps = [];
  for (const r of d.rows) {
    for (let i = 1; i < r.chain.length; i++) {
      const a = r.chain[i - 1], b = r.chain[i];
      if (!a || !b) continue;
      if (a.r > b.l + 0.5) overlaps.push([r.id, a.sel, b.sel, +(a.r - b.l).toFixed(2)]);
    }
  }
  is("  no pair overlaps on any row", overlaps, []);
  /* CONTROL: force an overlap and prove the same edge comparison reports it. "No overlaps" is also
   * what a broken walk returns, and eleven content assertions once missed a real one. */
  const forced = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="gday-row"]');
    const nums = row.querySelector('[data-testid="gday-nums"]');
    const prev = nums.style.cssText;
    nums.style.position = "relative"; nums.style.left = "260px";
    const b = nums.getBoundingClientRect();
    const next = row.querySelector('[data-testid="gday-delta"]').getBoundingClientRect();
    const seen = b.right > next.left + 0.5;
    nums.style.cssText = prev;
    return seen;
  });
  yes("  CONTROL: forcing an overlap IS detected by the same comparison", forced,
    "the overlap walk cannot see a collision - every 'no overlap' above is worthless");

  console.log("\n-- the alert banner --");
  is("  one banner, for the at-risk match", d.bannerCount, 1);
  is("  ...and it is that match", d.banner.id, RISK.id);
  is("  the headline names the shortfall", d.banner.head, `${RISK.name} is ${RISK.min - RISK.real} players short`);
  yes("  the meta line is its own element carrying kickoff, field, city and manager",
    /kickoff/.test(d.banner.meta) && d.banner.meta.includes(RISK.fd) && d.banner.meta.includes(RISK.city) && d.banner.meta.includes("Chama"));
  /* THE FACTS ROW IS THREE STATS, NOT ONE STRING - asserted structurally, three spans with two
   * hairlines between them, each addressable on its own. */
  const statChildren = d.banner.factsChildren.filter((c) => c.startsWith("SPAN:"));
  is("  the facts row is THREE discrete stats", statChildren.length, 3);
  is("  ...each with its own testid", statChildren, ["SPAN:gday-fact-real", "SPAN:gday-fact-min", "SPAN:gday-fact-fake"]);
  is("  ...separated by two hairlines", d.banner.factsChildren.filter((c) => c.startsWith("I:")).length, 2);
  is("  real", d.banner.factReal.trim(), `${RISK.real} real`);
  is("  minimum", d.banner.factMin.trim(), `${RISK.min} minimum`);
  is("  fake", d.banner.factFake.trim(), `${RISK.fake} of ${RISK.real + RISK.fake} filled spots are fake`);
  is("  Cancel now is DISABLED in the DOM", d.banner.cancelNow?.disabled, true);
  yes("  ...with a title saying why", (d.banner.cancelNow?.title ?? "").length > 20);

  console.log("\n-- the stepper --");
  const step = async (dir, n = 1) => { for (let i = 0; i < n; i++) { await page.click(`[data-testid="gday-step-${dir}"]`); await page.waitForTimeout(220); } };
  await step("down", 2);
  d = await page.evaluate(READ);
  is("  the stepper value moved", d.banner.stepV, String(RISK.min - 2));
  is("  the facts minimum moved with it", d.banner.factMinV, String(RISK.min - 2));
  is("  ...showing the old value struck through", d.banner.factMinWas, `was ${RISK.min}`);
  is("  the headline moved too", d.banner.head, `${RISK.name} is ${RISK.min - 2 - RISK.real} players short`);
  is("  the primary button became Save", d.banner.save, `Save min ${RISK.min - 2}`);
  /* AN ADJUSTMENT IS NOT A RESCUE. 7 with 3 real still cancels, so it must not yet read as the
   * affordance that says "this fixes it". */
  is("  ...but NOT as a rescue, because a shortfall remains", d.banner.saveClears, "0");
  await step("down", 4);
  d = await page.evaluate(READ);
  is("  stepping to the real count clears the shortfall", d.banner.head, `${RISK.name} clears its minimum at ${RISK.real}`);
  is("  ...and only THEN does it read as a rescue", d.banner.saveClears, "1");
  await step("down", 1);
  d = await page.evaluate(READ);
  is("  the floor is 2", d.banner.stepV, "2");
  is("  ...with minus disabled at the bound", d.banner.downDisabled, true);
  is("  CONTROL: plus is not disabled at the floor", d.banner.upDisabled, false);
  await step("up", RISK.cap - 2);
  d = await page.evaluate(READ);
  is("  the ceiling is capacity", d.banner.stepV, String(RISK.cap));
  is("  ...with plus disabled at the bound", d.banner.upDisabled, true);
  is("  CONTROL: minus is not disabled at the ceiling", d.banner.downDisabled, false);

  console.log("\n-- the save, and what moves with it --");
  await step("down", RISK.cap - RISK.real);
  d = await page.evaluate(READ);
  is("  poised at the real count", d.banner.stepV, String(RISK.real));
  const rowBefore = d.rows.find((r) => r.id === RISK.id);
  await page.click('[data-testid="gday-save-min"]');
  await page.waitForTimeout(1800);
  is("  exactly one PUT was sent - NEVER a retry", puts.length, 1);
  is("  THE DIFF IS THE BODY - only minPlayerCount", Object.keys(puts[0].body.changes), ["minPlayerCount"]);
  is("  ...carrying the stepped value", puts[0].body.changes.minPlayerCount, RISK.real);
  yes("  ...to that match's own write route", new RegExp(`/matches/${RISK.id}$`).test(puts[0].url));
  is("  no Idempotency-Key is sent", "idempotency-key" in (puts[0].headers ?? {}), false);
  const after = await page.evaluate(READ);
  is("  the banner is gone once the shortfall clears", after.bannerCount, 0);
  is("  the Needs attention tile went to zero with it", after.tiles.risk.v, "0");
  const rowAfter = after.rows.find((r) => r.id === RISK.id);
  is("  the row lost its risk styling", rowAfter?.risk, false);
  is("  the row's min label moved", rowAfter?.minLabel.n, RISK.real);
  yes("  ...and its notch moved with it", Math.abs(rowAfter.notch.pct - rowBefore.notch.pct) > 1);
  is("  ...and the delta is now zero", rowAfter?.delta, 0);
  yes("  CONTROL: the delta really did change", rowBefore.delta !== rowAfter.delta);

  console.log("\n-- the interaction contract --");
  is("  CONTROL: no editor open to begin with", (await page.evaluate(READ)).drawer, 0);
  /* THE KEBAB MUST NOT OPEN THE EDITOR. */
  await page.click('[data-testid="gday-row"] [data-testid="gday-kebab"]');
  await page.waitForTimeout(600);
  is("  clicking the kebab does NOT open the editor", (await page.evaluate(READ)).drawer, 0);
  /* CONTROL FOR THE GUARD: remove the stopPropagation and show the editor DOES open, then reload
   * and show it does not. Without this, "the kebab did not open it" is also what a page with no
   * editor at all would report. */
  const leaked = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="gday-row"]');
    let sawRowClick = false;
    const probe = () => { sawRowClick = true; };
    row.addEventListener("click", probe);
    row.querySelector('[data-testid="gday-kebab"]').click();
    row.removeEventListener("click", probe);
    return sawRowClick;
  });
  is("  CONTROL: with the guard removed the click WOULD reach the row", leaked, true);
  /* CLICKING THE ROW ITSELF DOES OPEN IT. */
  await page.click('[data-testid="gday-row"] [data-testid="gday-name"]');
  await page.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
  is("  clicking a row opens the editor", (await page.evaluate(READ)).drawer, 1);
  const openedFor = await page.evaluate(() => document.querySelector('[data-testid="gday-panel"]')?.textContent?.slice(0, 400) ?? "");
  yes("  ...for that match", openedFor.length > 0);
  await page.click('[data-testid="gday-panel-close"]');
  await page.waitForTimeout(1200);
  is("  ...and closes again", (await page.evaluate(READ)).drawer, 0);

  console.log("\n-- no horizontal scroll, three widths --");
  for (const w of [1500, 1366, 1280]) {
    await page.setViewportSize({ width: w, height: 1000 });
    await page.waitForTimeout(500);
    const v = await page.evaluate(READ);
    is(`  ${w}px: no horizontal page scroll`, v.hscroll, false);
    is(`  ${w}px: every min label still inside its track`,
      v.rows.filter((r) => r.minLabel.box.l < r.track.l - 14 || r.minLabel.box.r > r.track.r + 14).map((r) => r.id), []);
    is(`  ${w}px: rows still under 62px`, v.rows.filter((r) => r.h >= 62).map((r) => r.id), []);
    is(`  ${w}px: no row overlaps`, (() => { const o = [];
      for (const r of v.rows) for (let i = 1; i < r.chain.length; i++) {
        const a = r.chain[i - 1], b = r.chain[i];
        if (a && b && a.r > b.l + 0.5) o.push([r.id, a.sel, b.sel]); } return o; })(), []);
  }

  await closeContext(ctx);

  // ══ A. THE BANNERS ═════════════════════════════════════════════════════════════════════════
  {
    const { ctx: c2, page: p2 } = await boot(browser, storageState, 1500, { byDate: true });
    console.log("\n-- A1/A3: today's default view banners only the urgent one --");
    let v = await p2.evaluate(READ);
    is("  exactly one banner in the default view", v.bannerCount, 1);
    is("  ...and it is the match 23 minutes from its deadline", v.banner.id, 201);
    /* THE PAIR THAT MAKES THIS MEAN SOMETHING. 202 is short by SEVEN real players - more short
     * than 201 - and is not a banner, because its deadline is nineteen hours away. */
    is("  CONTROL: the 19-hours-out match is NOT a banner",
      await p2.locator('[data-testid="gday-alert"][data-id="202"]').count(), 0);
    is("  CONTROL: ...but it IS on the board as a row",
      await p2.locator('[data-testid="gday-row"][data-id="202"]').count(), 1);
    is("  the table starts within the first screen",
      await p2.evaluate(() => document.querySelector('[data-testid="snapshot"]').getBoundingClientRect().top < window.innerHeight), true);

    console.log("\n-- A4: today's tile subtitle names the split --");
    yes(`  reads "${v.tiles.risk.s}"`, /auto-cancels? in /.test(v.tiles.risk.s) && /still fillable/.test(v.tiles.risk.s));

    console.log("\n-- A2: Needs attention shows banners and no rows --");
    await p2.click('[data-testid="gtile-risk"]'); await p2.waitForTimeout(700);
    v = await p2.evaluate(READ);
    is("  every short match renders as a banner", v.bannerCount, 2);
    is("  ...and no rows are drawn", v.rows.length, 0);
    is("  ...the card is not drawn at all", await p2.locator('[data-testid="snapshot"]').count(), 0);
    await p2.click('[data-testid="gtile-risk"]'); await p2.waitForTimeout(700);
    v = await p2.evaluate(READ);
    is("  clicking again returns rows", v.rows.length > 0, true);
    is("  ...and the default banner set", v.bannerCount, 1);

    console.log("\n-- A2: every other filter shows rows, never extra banners --");
    for (const k of ["soon", "live"]) {
      await p2.click(`[data-testid="gtile-${k}"]`); await p2.waitForTimeout(600);
      const f = await p2.evaluate(READ);
      is(`  ${k}: still only the default urgent banner`, f.bannerCount, 1);
      await p2.click(`[data-testid="gtile-${k}"]`); await p2.waitForTimeout(500);
    }

    console.log("\n-- A1/A4/A5: tomorrow --");
    await p2.click('[data-testid="day-next"]');
    await p2.waitForFunction(() => document.querySelectorAll('[data-testid="gday-row"]').length === 9, null, { timeout: 40000 });
    await p2.waitForTimeout(700);
    v = await p2.evaluate(READ);
    is("  nine short matches on tomorrow", v.rows.length, 9);
    is("  ZERO banners in the default view", v.bannerCount, 0);
    /* ...INCLUDING the one whose deadline is 30 minutes away. On a future date the deadline does
     * not matter: there is nothing to decide about tomorrow tonight. */
    is("  ...including the match whose deadline is 30 minutes from now",
      await p2.locator('[data-testid="gday-alert"][data-id="408"]').count(), 0);
    is("  CONTROL: that match is on the board as a row", await p2.locator('[data-testid="gday-row"][data-id="408"]').count(), 1);
    is("  the table starts within the first screen",
      await p2.evaluate(() => document.querySelector('[data-testid="snapshot"]').getBoundingClientRect().top < window.innerHeight), true);
    is("  A4: the subtitle reads 'not yet at minimum'", v.tiles.risk.s, "not yet at minimum");
    is("  CONTROL: ...and the tile still counts them", v.tiles.risk.v, "9");
    const tomoChips = v.cityChips.filter((c) => c.name !== "all" && Number.isFinite(c.n));
    is("  A5: no city chip is risk-styled on a future date", tomoChips.filter((c) => c.risk).map((c) => c.name), []);
    yes(`  CONTROL: there are chips to have been styled (${tomoChips.length})`, tomoChips.length >= 5);

    console.log("\n-- A2 on tomorrow --");
    await p2.click('[data-testid="gtile-risk"]'); await p2.waitForTimeout(800);
    v = await p2.evaluate(READ);
    is("  all nine render as banners", v.bannerCount, 9);
    is("  ...and no rows", v.rows.length, 0);
    await p2.click('[data-testid="gtile-risk"]'); await p2.waitForTimeout(700);
    is("  clicking again returns to no banners", (await p2.evaluate(READ)).bannerCount, 0);
    await closeContext(c2);
  }

  // ══ A3: THE CAP OF THREE, AND THE +N LINE ══════════════════════════════════════════════════
  {
    const { ctx: c3, page: p3 } = await boot(browser, storageState, 1500, { byDate: true, todaySet: TODAY_FIVE });
    const v = await p3.evaluate(READ);
    console.log("\n-- A3: five qualifying, three shown --");
    is("  exactly three banners", v.bannerCount, 3);
    is("  ...soonest deadline first", await p3.evaluate(() =>
      [...document.querySelectorAll('[data-testid="gday-alert"]')].map((a) => Number(a.dataset.id))), [300, 301, 302]);
    is("  ...with a +2 more line", (await p3.locator('[data-testid="gday-more-risk"]').textContent()).trim(), "+2 more need attention");
    await p3.click('[data-testid="gday-more-risk"]');
    await p3.waitForTimeout(800);
    const after = await p3.evaluate(READ);
    is("  clicking it lands on the Needs attention filter", after.bannerCount, 5);
    is("  ...and the tile is selected", await p3.locator('[data-testid="gtile-risk"]').getAttribute("data-on"), "1");
    is("  ...and no rows are drawn", after.rows.length, 0);
    await closeContext(c3);
  }


  // ══ B. MOBILE ══════════════════════════════════════════════════════════════════════════════
  {
    /* PHONE FIRST. Every assertion here is about a box the browser built, and none of them can be
     * answered from the stylesheet: whether anything overflows 390px, whether a 44px target really
     * measures 44px, whether the notch still has its label when the meter changed width. */
    const OVER = () => {
      const vw = document.documentElement.clientWidth;
      const out = [];
      for (const r of document.querySelectorAll('[data-testid="gday-row"]')) {
        for (const el of r.querySelectorAll("*")) {
          const b = el.getBoundingClientRect();
          if (b.width > 0 && b.right > vw + 0.5) out.push([r.dataset.id, String(el.className).slice(0, 26), Math.round(b.right)]);
        }
      }
      return { vw, out, hscroll: document.documentElement.scrollWidth > vw + 1 };
    };
    for (const w of [390, 430, 768, 1024, 1500]) {
      const phone = w < 640;
      const { ctx: cm, page: pm } = await boot(browser, storageState, w, { byDate: true, mobile: phone });
      const o = await pm.evaluate(OVER);
      const v = await pm.evaluate(READ);
      console.log(`\n-- B at ${w}px --`);
      is(`  ${w}: no horizontal page scroll`, o.hscroll, false);
      is(`  ${w}: nothing overflows the viewport`, o.out, []);
      yes(`  ${w}: CONTROL - there are rows to check (${v.rows.length})`, v.rows.length > 0);
      /* THE METER SURVIVES AT EVERY WIDTH. It is the reason the page exists. */
      is(`  ${w}: every row still has a notch and a min label`,
        v.rows.filter((r) => !r.notch || !r.minLabel).map((r) => r.id), []);
      is(`  ${w}: every label within 1px of its notch`,
        v.rows.filter((r) => Math.abs(r.minLabel.box.cx - r.notch.box.cx) > 1).map((r) => r.id), []);
      is(`  ${w}: the 12-88% clamp does not fire`,
        v.rows.filter((r) => Math.abs(r.minLabel.pct - r.notch.pct) > 0.001).map((r) => r.id), []);
      /* THE STRIP: three across on a phone, five on the desktop. Read off the computed grid. */
      const cols = await pm.evaluate(() => getComputedStyle(document.querySelector(".gstrip")).gridTemplateColumns.split(" ").length);
      is(`  ${w}: the strip is ${phone || w < 1024 ? 3 : 5} across`, cols, phone || w < 1024 ? 3 : 5);
      is(`  ${w}: display-only tiles are still not buttons`, [v.tiles.all.isButton, v.tiles.fill.isButton], [false, false]);
      /* THE CITY CHIPS SCROLL IN THEIR OWN BOX, and that is why the page does not. */
      const chips = await pm.evaluate(() => {
        const c = document.querySelector(".mchips") ?? document.querySelector(".gcities .cityf");
        if (!c || c.clientWidth === 0) return null;
        return { over: c.scrollWidth > c.clientWidth, ox: getComputedStyle(c).overflowX };
      });
      yes(`  ${w}: the chip row is its own scroll container`, chips == null || chips.ox === "auto" || chips.ox === "scroll",
        `overflowX was ${chips?.ox}`);

      if (phone) {
        /* ROWS ARE STACKED CARDS - taller than the desktop row and no longer a five-column grid. */
        yes(`  ${w}: rows are stacked cards (${v.rows[0].h}px)`, v.rows[0].h > 90);
        const gridCols = await pm.evaluate(() => getComputedStyle(document.querySelector('[data-testid="gday-row"]')).gridTemplateColumns.split(" ").length);
        is(`  ${w}: the five-column grid is gone`, gridCols, 2);
        /* THE STEPPER'S TARGETS. 44x44 minimum - they were 22px squares on a control that changes
         * what a match costs a player. */
        await pm.click('[data-testid="gtile-risk"]'); await pm.waitForTimeout(700);
        const btns = await pm.evaluate(() => ["down", "up"].map((d) => {
          const b = document.querySelector(`[data-testid="gday-step-${d}"]`);
          const r = b.getBoundingClientRect(); return { d, w: Math.round(r.width), h: Math.round(r.height) };
        }));
        for (const b of btns) yes(`  ${w}: the ${b.d} stepper is at least 44x44 (${b.w}x${b.h})`, b.w >= 44 && b.h >= 44);
        await pm.click('[data-testid="gtile-risk"]'); await pm.waitForTimeout(600);
        /* THE EDITOR IS A FULL-HEIGHT SHEET, and Save is reachable without scrolling the form. */
        await pm.click('[data-testid="gday-row"] [data-testid="gday-name"]');
        await pm.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
        await pm.waitForTimeout(1200);
        const sheet = await pm.evaluate(() => {
          const p = document.querySelector('[data-testid="gday-panel"]');
          const r = p.getBoundingClientRect();
          const save = [...p.querySelectorAll("button")].find((b) => /save/i.test(b.textContent));
          const sr = save?.getBoundingClientRect();
          return { w: Math.round(r.width), vw: document.documentElement.clientWidth,
            h: Math.round(r.height), vh: window.innerHeight,
            saveVisible: sr ? sr.top >= 0 && sr.bottom <= window.innerHeight + 1 : null };
        });
        yes(`  ${w}: the editor fills the width (${sheet.w} of ${sheet.vw})`, sheet.w >= sheet.vw - 1);
        yes(`  ${w}: ...and the height (${sheet.h} of ${sheet.vh})`, sheet.h >= sheet.vh - 2);
        is(`  ${w}: Save is reachable without scrolling`, sheet.saveVisible, true);
        await pm.click('[data-testid="gday-panel-close"]'); await pm.waitForTimeout(800);

        /* CONTROL: force a fixed-width element into a phone row and prove the overflow walk sees it. */
        const caught = await pm.evaluate(() => {
          const row = document.querySelector('[data-testid="gday-row"]');
          const el = row.querySelector('[data-testid="gday-nums"]');
          const prev = el.style.cssText;
          el.style.width = "900px"; el.style.flex = "0 0 900px";
          const vw = document.documentElement.clientWidth;
          const seen = el.getBoundingClientRect().right > vw + 0.5;
          el.style.cssText = prev;
          return seen;
        });
        yes(`  ${w}: CONTROL - a forced 900px element IS caught by the overflow walk`, caught,
          "the overflow walk cannot see an overflow - every clean result above is worthless");
      } else {
        /* THE DESKTOP OVERLAP WALK STAYS, at 1024 and above. */
        const ov = [];
        for (const r of v.rows) for (let i = 1; i < r.chain.length; i++) {
          const a = r.chain[i - 1], b = r.chain[i];
          if (a && b && a.r > b.l + 0.5) ov.push([r.id, a.sel, b.sel]);
        }
        is(`  ${w}: no row overlaps`, ov, []);
        const forced = await pm.evaluate(() => {
          const row = document.querySelector('[data-testid="gday-row"]');
          const nums = row.querySelector('[data-testid="gday-nums"]');
          const prev = nums.style.cssText;
          nums.style.position = "relative"; nums.style.left = "260px";
          const seen = nums.getBoundingClientRect().right > row.querySelector('[data-testid="gday-delta"]').getBoundingClientRect().left + 0.5;
          nums.style.cssText = prev;
          return seen;
        });
        yes(`  ${w}: CONTROL - a forced overlap IS detected`, forced);
      }
      await closeContext(cm);
    }
  }

  // ══ C. OPEN MATCH CHAT ═════════════════════════════════════════════════════════════════════
  {
    console.log("\n-- C1: Match Chats loads clean with no parameters --");
    const cc = await browser.newContext({ storageState, viewport: { width: 1500, height: 1000 } });
    const pc = await cc.newPage();
    const cerr = [];
    pc.on("pageerror", (e) => cerr.push(String(e).slice(0, 200)));
    const resp = await pc.goto(`${BASE}/match-ops/match-chats`, { waitUntil: "domcontentloaded" });
    await pc.waitForTimeout(8000);
    is("  HTTP 200", resp?.status(), 200);
    is("  no uncaught page errors", cerr, []);
    /* ASSERTED ON RENDERED CONTENT, NOT A 200. A 200 that renders an empty shell is still broken. */
    const txt = await pc.evaluate(() => document.body.innerText);
    yes("  the inbox rendered its tabs and counts", /Active/.test(txt) && /Upcoming/.test(txt) && /Past/.test(txt));
    yes(`  ...with real threads in it`, txt.length > 400);
    await closeContext(cc);

    console.log("\n-- C3: the banner link lands on that match's thread --");
    const { ctx: c4, page: p4 } = await boot(browser, storageState, 1500, { byDate: true });
    const href = await p4.locator('[data-testid="gday-chat"]').first().getAttribute("href");
    const chatId = await p4.locator('[data-testid="gday-chat"]').first().getAttribute("data-chat-id");
    yes(`  the href targets the real route - ${href}`, href.startsWith("/match-ops/match-chats?chatId="));
    is("  ...carrying that match's id", href, `/match-ops/match-chats?chatId=${chatId}`);
    is("  CONTROL: the old broken path is gone", /match-ops\/chats\?match=/.test(href), false);
    is("  the button is enabled", await p4.locator('[data-testid="gday-chat"]').first().getAttribute("aria-disabled"), null);

    /* THE LINK ACTUALLY LANDS. Followed for real, and the selected thread's id is read back off
     * the URL the chat shell keeps - chatId IS the match api_id, proven on live data. */
    await p4.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
    await p4.waitForTimeout(7000);
    const landed = new URL(p4.url());
    is("  following it keeps the chatId", landed.searchParams.get("chatId"), chatId);
    is("  ...on the Match Chats route", landed.pathname, "/match-ops/match-chats");
    const paneTxt = await p4.evaluate(() => document.body.innerText);
    is("  CONTROL: it is not sitting on the empty 'Nothing selected' state",
      /Nothing selected/.test(paneTxt), false);

    /* CONTROL: a match id with no thread must render an explicit empty state, not crash. */
    await p4.goto(`${BASE}/match-ops/match-chats?chatId=99999999`, { waitUntil: "domcontentloaded" });
    await p4.waitForTimeout(6000);
    const emptyTxt = await p4.evaluate(() => document.body.innerText);
    yes("  CONTROL: an id with no thread does not crash the page", emptyTxt.length > 300);
    yes("  CONTROL: ...and the inbox still renders", /Active/.test(emptyTxt) && /Upcoming/.test(emptyTxt));
    await closeContext(c4);
  }


  /* ── THE LIVE BOARD ─────────────────────────────────────────────────────────────────────────
   * No intercept. The clamp and the layout claims are about REAL matches, and a fixture I chose
   * cannot settle them - I picked min 4 of 18 above precisely because min 2 of 18 tripped the
   * clamp, which is exactly the kind of thing a self-chosen fixture hides. */
  {
    const live = await browser.newContext({ storageState, viewport: { width: 1500, height: 1000 } });
    const p2 = await live.newPage();
    await p2.goto(PAGE, { waitUntil: "domcontentloaded" });
    await p2.waitForSelector('[data-testid="gday-row"]', { timeout: 120000 });
    await p2.waitForTimeout(1500);
    console.log("\n-- the LIVE board --");
    for (const w of [1500, 1366, 1280]) {
      await p2.setViewportSize({ width: w, height: 1000 });
      await p2.waitForTimeout(500);
      const v = await p2.evaluate(READ);
      yes(`  ${w}px: CONTROL - there are real rows to check (${v.rows.length})`, v.rows.length > 0);
      is(`  ${w}px: the 12-88% clamp never fires on real data`,
        v.rows.filter((r) => r.minLabel && Math.abs(r.minLabel.pct - r.notch.pct) > 0.001).map((r) => r.id), []);
      is(`  ${w}px: every label sits within 1px of its notch`,
        v.rows.filter((r) => r.minLabel && Math.abs(r.minLabel.box.cx - r.notch.box.cx) > 1).map((r) => r.id), []);
      is(`  ${w}px: no horizontal page scroll`, v.hscroll, false);
      is(`  ${w}px: rows under 62px`, v.rows.filter((r) => r.h >= 62).map((r) => r.id), []);
      is(`  ${w}px: no row overlaps`, (() => { const o = [];
        for (const r of v.rows) for (let i = 1; i < r.chain.length; i++) {
          const a = r.chain[i - 1], b = r.chain[i];
          if (a && b && a.r > b.l + 0.5) o.push([r.id, a.sel, b.sel]); } return o; })(), []);
      is(`  ${w}px: every row's delta equals real minus min`, (() => {
        const bad = [];
        for (const r of v.rows) if (!Number.isFinite(r.delta)) bad.push(r.id);
        return bad; })(), []);
    }
    const foot = (await p2.evaluate(READ)).foot;
    yes(`  the footer names the minimum and the hatch - "${foot.slice(0, 90)}..."`,
      /match minimum/.test(foot) && /hatched/.test(foot));
    await closeContext(live);
  }

  await closeBrowser(browser);
  console.log(`\ngameday-ops: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}
main().catch((e) => fatal(e));
