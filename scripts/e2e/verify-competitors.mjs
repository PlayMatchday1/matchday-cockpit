// GROWTH › COMPETITORS — the page, against the REAL September capture.
//
// Ryan: "I want to add a competitor page to the growth tab that shows all the goodrec and plei data
// so we can review it." And on the first cut: "theres no data for each facility the page looks
// bland." And: "the price per player makes no sense $600. I dont know what its trying to capture."
//
// THE NUMBERS HERE ARE THE DATABASE'S, NOT THE MOCK'S. scripts/mocks/competitors.html asserts a
// fixture in which our Houston supply is 864 spots and the share is 16%. Live it is 478 spots and
// 9%, and our fourth Houston row is Hattrick T. rather than PAC Global, which had no matches that
// week. The mock is the spec for the SHAPE; this suite is the check on the arithmetic.
//
// NOTHING IS WRITTEN. Every assertion is a read of what the importer already landed; the one write
// path exercised (accepting a proposed link) is driven through an intercepted route so
// competitor_facility_supply.our_venue_id is never touched.
//
//   node scripts/e2e/verify-competitors.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/growth/competitors`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok    ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX    ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));
const head = (s) => console.log(`\n-- ${s} --`);

const HOU = '[data-testid="city"][data-city="Houston"]';
const DFW = '[data-testid="city"][data-city="Dallas / Fort Worth"]';
const T = async (p, s) => (await p.locator(s).first().textContent())?.replace(/\s+/g, " ").trim() ?? null;
const inCity = (p, c, t) => T(p, `${c} [data-testid="${t}"]`);
const nRows = (p, c) => p.locator(`${c} [data-testid="row"]`).count();

/** Every panel that must never outgrow its own box. */
const overflow = (p) => p.evaluate(() =>
  [...document.querySelectorAll(".city,.frow,.rhead,.stats,.share,.detail")]
    .filter((e) => e.scrollWidth > e.clientWidth + 2)
    .map((e) => ({ cls: e.className, sw: e.scrollWidth, cw: e.clientWidth })));

async function boot(browser, storageState, width = 1200) {
  const ctx = await browser.newContext({
    storageState, viewport: { width, height: 1100 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}),
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 240000 });
  await p.waitForSelector('[data-testid="city"]', { timeout: 150000 });
  await p.waitForTimeout(1200);
  return { ctx, p, errs };
}
const setSrc = async (p, s) => { await p.locator(`.sw button[data-s="${s}"]`).click(); await p.waitForTimeout(400); };

async function main() {
  const browser = await chromium.launch();
  const { storageState } = await storageStateFor(ADMIN, BASE);

  /* ── WHAT ACTUALLY LANDED, read from the database, before any pixel is measured. ─────────── */
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const caps = nonEmpty((await sb.from("competitor_captures").select("*")).data ?? [], "competitor_captures rows");
  const sup = nonEmpty((await sb.from("competitor_facility_supply").select("*")).data ?? [], "competitor_facility_supply rows");
  console.log(`\n${caps.length} captures, ${sup.length} facility rows`);
  for (const c of caps.sort((a, b) => a.id - b.id)) {
    const rs = sup.filter((s) => s.capture_id === c.id);
    const spots = rs.reduce((a, b) => a + b.bookable_spots_per_week, 0);
    console.log(`  ${c.source} ${c.city_label} ${c.window_start}..${c.window_end}: ${rs.length} facilities, ${spots} spots, ${(spots / 18).toFixed(1)} MD`);
  }

  head("the three totals, to the row");
  const tot = (source, city) => {
    const c = caps.find((x) => x.source === source && x.city_label === city);
    const rs = sup.filter((s) => s.capture_id === c.id);
    return { n: rs.length, spots: rs.reduce((a, b) => a + b.bookable_spots_per_week, 0) };
  };
  is("Plei Houston: 26 facilities, 4,710 spots", tot("plei", "Houston"), { n: 26, spots: 4710 });
  is("  which is 261.7 MD Standard", (tot("plei", "Houston").spots / 18).toFixed(1), "261.7");
  is("Plei DFW: 16 facilities, 2,789 spots", tot("plei", "Dallas / Fort Worth"), { n: 16, spots: 2789 });
  is("  which is 154.9 MD Standard", (tot("plei", "Dallas / Fort Worth").spots / 18).toFixed(1), "154.9");
  is("GoodRec DFW: 17 facilities, 1,781 spots", tot("goodrec", "Dallas / Fort Worth"), { n: 17, spots: 1781 });
  is("  which is 98.9 MD Standard", (tot("goodrec", "Dallas / Fort Worth").spots / 18).toFixed(1), "98.9");
  is("CONTROL: re-importing did not duplicate — still 3 captures and 59 rows", [caps.length, sup.length], [3, 59]);
  is("CONTROL: nothing was auto-linked", sup.filter((s) => s.our_venue_id != null).length, 0);
  is("CONTROL: matches_per_week was imported and kept", sup.filter((s) => s.matches_per_week != null).length, 59);

  const { ctx, p, errs } = await boot(browser, storageState);
  is("no page error", errs.length, 0);

  // ══ NOTHING IS OFF SCREEN ═════════════════════════════════════════════════════════════════
  head("nothing overflows its own box");
  is("no row or panel overflows", await overflow(p), []);
  yes("and the page does not scroll sideways",
    (await p.evaluate(() => document.documentElement.scrollWidth)) <= 1202);
  /* CONTROL: THE CHECK CAN FAIL. This is the assertion the first cut did not have — its only width
   * test was scrollWidth >= clientWidth, which is true of every element ever laid out. */
  await p.evaluate(() => {
    const n = document.querySelector(".frow .fname .n");
    n.style.whiteSpace = "nowrap"; n.style.overflow = "visible";
    n.textContent = "x".repeat(400);
  });
  await p.waitForTimeout(150);
  yes("CONTROL: and it DOES catch a cell that is too wide", (await overflow(p)).length > 0);
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="city"]', { timeout: 120000 });
  await p.waitForTimeout(1200);

  // ══ COVERAGE, BEFORE ANY ROW ══════════════════════════════════════════════════════════════
  head("absence is not evidence");
  const cov = await T(p, '[data-testid="coverage"]');
  yes(`coverage is stated first, in one line: "${cov}"`, /2 of 8 cities captured/.test(cov ?? ""));
  for (const c of ["Atlanta", "Austin", "El Paso", "OKC", "San Antonio", "St. Louis"])
    yes(`  names ${c} as uncaptured`, new RegExp(c.replace(".", "\\.")).test(cov ?? ""));
  yes("  CONTROL: and the explanation sentence is gone", !/has not been looked at/.test(cov ?? ""));
  yes(`  CONTROL: it fits one line (${(cov ?? "").length} chars)`, (cov ?? "").length < 120);
  is("CONTROL: an uncaptured city renders no panel at all", await p.locator('[data-testid="city"]').count(), 2);

  // ══ WE ARE IN THE TABLE ═══════════════════════════════════════════════════════════════════
  head("our own fields are rows in the same list");
  const usRows = await p.locator(`${HOU} [data-testid="row"][data-src="us"]`).evaluateAll((es) => es.map((e) => e.dataset.fac));
  is("our four Houston fields are rows", usRows.length, 4);
  is("  and they are the four with matches that week", usRows.sort(),
    ["ATH Katy", "ATH Pearland", "Hattrick T.", "KISC (Katy Intl)"]);
  yes("  our rows are visually distinct", await p.locator(`${HOU} [data-testid="row"][data-fac="ATH Pearland"]`).evaluate((e) => e.className.includes("ours")));
  const houRows = await nRows(p, HOU);
  is("26 of theirs plus 4 of ours is 30 rows", houRows, 30);
  await setSrc(p, "goodrec");
  is("CONTROL: filtering the source never filters US out", await p.locator(`${HOU} [data-testid="row"][data-src="us"]`).count(), 4);
  is("  CONTROL: but it does filter them", await p.locator(`${HOU} [data-testid="row"][data-src="plei"]`).count(), 0);
  /* AND THE CITY DOES NOT DISAPPEAR. GoodRec has no Houston capture; dropping the panel would take
   * our own rows with it AND read as "GoodRec sells nothing here", which nobody has looked at. */
  const nc = await inCity(p, HOU, "notcaptured");
  yes(`  CONTROL: and the page says which it is: "${nc}"`, /not captured in Houston/.test(nc ?? ""));
  yes("  CONTROL: stating the fact and nothing else", (nc ?? "").length < 45);
  is("  CONTROL: with no stats tile claiming a zero", await p.locator(`${HOU} [data-testid="s-fac"]`).count(), 0);
  await setSrc(p, "both");

  // ══ THE FOUR TILES ════════════════════════════════════════════════════════════════════════
  head("four numbers that describe the market");
  is("Houston: 26 competing facilities", await inCity(p, HOU, "s-fac"), "26");
  is("  4,710 of their spots a week", await inCity(p, HOU, "s-spots"), "4,710");
  const med = await inCity(p, HOU, "s-median");
  yes(`  a median price per player (${med})`, /^\$\d+\.\d\d$/.test(med ?? ""));
  yes(`  and how many undercut us (${await inCity(p, HOU, "s-under")})`, Number(await inCity(p, HOU, "s-under")) > 0);

  // ══ SPOTS READS AS A SHAPE ════════════════════════════════════════════════════════════════
  head("spots reads as a shape, not a column of digits");
  const bars = nonEmpty(await p.$$eval(`${HOU} .fill`, (es) => es.map((e) => Math.round(e.getBoundingClientRect().width))), "Houston spots bars");
  is("every row carries a spots bar", bars.length, 30);
  yes(`and the bars differ: ${Math.max(...bars)}px against ${Math.min(...bars)}px`, Math.max(...bars) > Math.min(...bars) * 5);
  yes("  CONTROL: the smallest is still drawn, not collapsed to nothing", Math.min(...bars) >= 2);
  is("the number is there too", await T(p, `${HOU} [data-testid="wrap"][data-fac="Revolution Soccer Complex"] [data-testid="spots"]`), "662");
  is("  and its MD Standard", await T(p, `${HOU} [data-testid="wrap"][data-fac="Revolution Soccer Complex"] [data-testid="mdstd"]`), "36.8");
  is("CONTROL: 10 spots is 0.6, not rounded to zero", await T(p, `${HOU} [data-testid="wrap"][data-fac="Houston Select FC"] [data-testid="mdstd"]`), "0.6");

  // ══ PRICE IS A NUMBER ═════════════════════════════════════════════════════════════════════
  head("price is a number, not a position");
  is("a range reads as the two numbers", await T(p, `${HOU} [data-testid="wrap"][data-fac="GoPro Arena"] [data-testid="price"]`), "$6.50 to $10.50");
  is("CONTROL: a single price is not written twice", await T(p, `${HOU} [data-testid="wrap"][data-fac="Houston Dynamo Sports Park"] [data-testid="price"]`), "$13.50");
  is("and there is no positional bar left anywhere", await p.locator(".prange, .pmark").count(), 0);
  yes("a facility cheaper than our floor says so in words",
    (await p.locator(`${HOU} [data-testid="wrap"][data-fac="GoPro Arena"] [data-testid="under"]`).count()) > 0);
  is("  CONTROL: a dearer one does not",
    await p.locator(`${HOU} [data-testid="wrap"][data-fac="Houston Dynamo Sports Park"] [data-testid="under"]`).count(), 0);
  is("  CONTROL: our own row never undercuts itself",
    await p.locator(`${HOU} [data-testid="wrap"][data-fac="ATH Pearland"] [data-testid="under"]`).count(), 0);
  is("a facility that published no price says so in words",
    await T(p, `${DFW} [data-testid="wrap"][data-fac="FIT - Forney"] [data-testid="noprice"]`), "not shown");
  is("  CONTROL: and it is not a zero",
    await p.locator(`${DFW} [data-testid="wrap"][data-fac="FIT - Forney"] [data-testid="price"]`).count(), 0);

  // ══ EXPAND INTO A FACILITY ════════════════════════════════════════════════════════════════
  head("expand into a facility's week");
  const ROW = (f) => `${HOU} [data-testid="row"][data-fac="${f}"]`;
  const DET = (f) => `${HOU} [data-testid="detail"][data-fac="${f}"]`;
  is("a facility starts closed", await p.locator(ROW("Revolution Soccer Complex")).getAttribute("aria-expanded"), "false");
  is("  CONTROL: and its week is not on screen", await p.locator(DET("Revolution Soccer Complex")).count(), 0);
  await p.locator(ROW("Revolution Soccer Complex")).click(); await p.waitForTimeout(300);
  is("clicking it opens", await p.locator(ROW("Revolution Soccer Complex")).getAttribute("aria-expanded"), "true");
  await p.locator(ROW("Pegaso HTX")).click(); await p.waitForTimeout(300);
  is("a second opens", await p.locator(ROW("Pegaso HTX")).getAttribute("aria-expanded"), "true");
  is("  CONTROL: and the first stays open", await p.locator(ROW("Revolution Soccer Complex")).getAttribute("aria-expanded"), "true");

  /* ── THE WEEK, NOW THAT THE LOG IS IN ────────────────────────────────────────────────────
   * 685 listings across the three captures, and the log summing to the weekly summary is the
   * whole validation: two independent recordings of the same week agreeing to the spot. */
  const days = await p.locator(`${DET("Revolution Soccer Complex")} [data-testid="day"]`).evaluateAll((es) => es.map((e) => e.dataset.day));
  const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  is("the panel groups the week by day, in week order", days, WEEK.filter((d) => days.includes(d)));
  const ms = nonEmpty(await p.locator(`${DET("Revolution Soccer Complex")} [data-testid="match"]`).allInnerTexts(), "Revolution match rows");
  ok(`every listing in the week is there (${ms.length})`);
  const firstM = ms[0].replace(/\s+/g, " ");
  yes(`and each carries time, size, spots and price: "${firstM}"`,
    /\d{1,2}:\d{2} (AM|PM)/.test(firstM) && /\dv\d/.test(firstM) && /\d+ spots/.test(firstM) && /(\$\d|free|not shown)/.test(firstM));
  const dsum = await T(p, `${DET("Revolution Soccer Complex")} [data-testid="daysum"]`);
  yes(`each day totals itself: "${dsum}"`, /\d+ match(es)? · \d+ spots/.test(dsum ?? ""));
  yes("a listing carries its captured note", (await p.locator(`${DET("Revolution Soccer Complex")} [data-testid="mnote"]`).count()) > 0);
  /* THEIR OWN MATCH COUNT LIVES HERE, not on the row, and carries its caveat. */
  const tc = await T(p, `${DET("Revolution Soccer Complex")} [data-testid="theircount"]`);
  yes(`the competitor's own match count is in the panel: "${tc?.slice(0, 44)}…"`, /Plei lists \d+ matches a week/.test(tc ?? ""));
  yes("  named as theirs, not ours", /their own count/.test(tc ?? ""));
  yes("  with the reason it is not the ordering", /does not reconcile with the formats/.test(tc ?? ""));
  is("  CONTROL: and it is nowhere on the row itself",
    await p.locator(`${ROW("Revolution Soccer Complex")} [data-testid="theircount"]`).count(), 0);

  await p.locator(ROW("Revolution Soccer Complex")).click(); await p.waitForTimeout(300);
  is("clicking again minimizes it", await p.locator(ROW("Revolution Soccer Complex")).getAttribute("aria-expanded"), "false");
  is("  CONTROL: without touching the other one", await p.locator(ROW("Pegaso HTX")).getAttribute("aria-expanded"), "true");

  // ══ FORMATS AND FILTERING ═════════════════════════════════════════════════════════════════
  head("format bubbles, in game order");
  const fbtns = await p.locator('[data-testid="fbtn"]').allTextContents();
  is("the bubbles run smallest to largest", fbtns.map((x) => x.trim()), ["5v5", "6v6", "7v7", "8v8", "9v9", "10v10", "11v11"]);
  const chips = await p.locator(`${HOU} [data-testid="wrap"][data-fac="Peek Sports Texas"] .fchip`).allTextContents();
  is("a multi-format facility shows each", chips.map((x) => x.trim()), ["7v7", "8v8", "10v10"]);
  is("CONTROL: and a single-format one shows one", await p.locator(`${HOU} [data-testid="wrap"][data-fac="Pegaso HTX"] .fchip`).count(), 1);

  const spotsBefore = await inCity(p, HOU, "s-spots");
  const shareBefore = await inCity(p, HOU, "sharepct");
  const before = await nRows(p, HOU);
  await p.locator('[data-testid="fbtn"][data-fmt="11v11"]').click(); await p.waitForTimeout(400);
  const after = await nRows(p, HOU);
  yes(`picking 11v11 narrows Houston from ${before} to ${after}`, after < before);
  const facs = await p.locator(`${HOU} [data-testid="row"]`).evaluateAll((es) => es.map((e) => e.dataset.fac));
  yes("  and the 11v11 facilities are the ones left", facs.includes("Athlete Training & Health | Cypress"));
  yes("  CONTROL: a 6v6-only facility is gone", !facs.includes("Pegaso HTX"));
  await p.locator('[data-testid="fbtn"][data-fmt="7v7"]').click(); await p.waitForTimeout(400);
  const both = await p.locator(`${HOU} [data-testid="row"]`).evaluateAll((es) => es.map((e) => e.dataset.fac));
  yes(`adding 7v7 widens it again to ${both.length}`, both.length > after);
  yes("  CONTROL: both formats are represented, so it is OR and not AND",
    both.includes("Athlete Training & Health | Cypress") && both.includes("Turf On Soccer Fields"));

  /* THE FILTER NARROWS THE LIST AND NOTHING ELSE. */
  is("the city totals do NOT move with the format filter", await inCity(p, HOU, "s-spots"), spotsBefore);
  is("  nor does the share", await inCity(p, HOU, "sharepct"), shareBefore);
  const note = await T(p, '[data-testid="fnote"]');
  yes(`and the page says so out loud: "${note?.slice(0, 50)}…"`, /still cover every format/.test(note ?? ""));
  yes("  naming the reason", /spots per facility, not per format/.test(note ?? ""));
  /* OPEN ROWS SURVIVE THE FILTER. */
  is("CONTROL: a row opened before the filter is still open after it",
    await p.locator(ROW("Pegaso HTX")).count() ? await p.locator(ROW("Pegaso HTX")).getAttribute("aria-expanded") : "gone", "gone");
  await p.locator('[data-testid="fclear"]').click(); await p.waitForTimeout(400);
  is("Clear puts every facility back", await nRows(p, HOU), before);
  is("  CONTROL: and the caveat goes with it", await p.locator('[data-testid="fnote"]').count(), 0);
  is("  CONTROL: and the row opened before the filter is still open", await p.locator(ROW("Pegaso HTX")).getAttribute("aria-expanded"), "true");

  // ══ THE SHARE, AND WHERE IT REFUSES ═══════════════════════════════════════════════════════
  head("a percentage only where the windows align");
  const hp = await inCity(p, HOU, "sharepct");
  yes(`Houston aligns, so it gets a number: "${hp}"`, /MatchDay holds 9%/.test(hp ?? ""));
  is("DFW does NOT get a percentage", await p.locator(`${DFW} [data-testid="sharepct"]`).count(), 0);
  const nos = await inCity(p, DFW, "nosharepct");
  yes(`  it says so instead: "${nos}"`, /do not line up/.test(nos ?? ""));
  yes("  CONTROL: and only that, with no explanation attached", (nos ?? "").length < 40);
  /* THE DATES CARRY IT INSTEAD. The two amber reason lines were deleted; the windows themselves
   * say which is which, small and grey on one line. */
  const win = await inCity(p, DFW, "sharewindow");
  yes(`the windows are named instead: "${win}"`, /Plei/.test(win ?? "") && /GoodRec/.test(win ?? "") && /ours/.test(win ?? ""));
  is("  CONTROL: and the explanation lines are gone", await p.locator(`${DFW} [data-testid="sharewhy"]`).count(), 0);
  yes("CONTROL: the absolutes are still drawn", (await p.locator(`${DFW} [data-testid="seg-goodrec"]`).count()) > 0);
  yes("  CONTROL: including our own side", (await p.locator(`${DFW} [data-testid="seg-us"]`).count()) > 0);
  /* DECIDED BY COMPARISON, NOT BY CITY: the two sources in ONE city answer differently. */
  await setSrc(p, "plei");
  is("CONTROL: Plei alone in DFW still refuses, on its window note", await p.locator(`${DFW} [data-testid="sharepct"]`).count(), 0);
  await setSrc(p, "goodrec");
  yes("  CONTROL: but GoodRec alone DOES get one, so it is not hardcoded per city",
    (await p.locator(`${DFW} [data-testid="sharepct"]`).count()) > 0);
  await setSrc(p, "both");

  // ══ THEY BOOK OUR FIELDS ══════════════════════════════════════════════════════════════════
  head("they are booking our fields");
  const flag = (c, f) => p.locator(`${c} [data-testid="wrap"][data-fac="${f}"] [data-testid="maybe-ours"]`).count();
  yes("Plei selling KISC is flagged", (await flag(HOU, "Katy International Sports Complex")) > 0);
  yes("  so is PAC Global", (await flag(HOU, "Pac Global Academy | West Houston")) > 0);
  yes("  and ATH Katy", (await flag(HOU, "Athlete Training and Health | Katy")) > 0);
  is("CONTROL: Cypress is NOT Katy and is not flagged", await flag(HOU, "Athlete Training & Health | Cypress"), 0);
  is("CONTROL: our OWN row does not claim to also be our field", await flag(HOU, "ATH Katy"), 0);
  yes("and it works across sources: GoodRec sells Crossbar Rowlett", (await flag(DFW, "Crossbar, Rowlett")) > 0);
  is("CONTROL: neither HatTrick location is linked, because the name cannot tell them apart",
    (await flag(HOU, "The HatTrick Oakridge")) + (await flag(HOU, "The HatTrick Patio")), 0);
  /* THE FLAG IS A PROPOSAL, NOT A LINK. */
  await p.locator(`${HOU} [data-testid="row"][data-fac="Katy International Sports Complex"]`).click();
  await p.waitForTimeout(300);
  const lb = await T(p, `${HOU} [data-testid="detail"][data-fac="Katy International Sports Complex"] [data-testid="linkbox"]`);
  yes(`the proposal shows its evidence: "${lb?.slice(0, 52)}…"`, /Matched on/.test(lb ?? ""));
  yes("  and says nothing is linked yet", /Nothing is linked until you say so/.test(lb ?? ""));
  await closeContext(ctx);

  // ══ THE THREE EDGE CASES IN THE LOG ═══════════════════════════════════════════════════════
  {
    head("the timeless listing, the free game, and the empty state");
    const b3 = await boot(browser, storageState);
    is("no page error", b3.errs.length, 0);
    const openRow = async (city, fac) => {
      const r = b3.p.locator(`${city} [data-testid="row"][data-fac="${fac}"]`);
      await r.scrollIntoViewIfNeeded(); await r.click(); await b3.p.waitForTimeout(400);
    };

    /* A LISTING WITH NO TIME SORTS LAST IN ITS DAY, never first. Treating null as 00:00 would put
     * an unknown hour at the top of Friday as if it were a midnight kick-off. */
    await openRow(DFW, "Foro Sports Club");
    const fri = nonEmpty(
      await b3.p.locator(`${DFW} [data-testid="detail"][data-fac="Foro Sports Club"] [data-testid="day"][data-day="Fri"] [data-testid="match"]`)
        .evaluateAll((es) => es.map((e) => e.dataset.notime)), "Foro Friday listings");
    is("the timeless listing is last in its day", fri[fri.length - 1], "1");
    is("  CONTROL: and it is the only one", fri.filter((x) => x === "1").length, 1);
    is("  CONTROL: every earlier listing has a time", fri.slice(0, -1).every((x) => x === "0"), true);
    const notime = await T(b3.p, `${DFW} [data-testid="detail"][data-fac="Foro Sports Club"] [data-testid="match"][data-notime="1"] [data-testid="mtime"]`);
    is("  and it says the time was not captured, rather than showing midnight", notime, "time not captured");

    /* NULL PRICE AND ZERO PRICE ARE DIFFERENT FACTS. */
    await openRow(DFW, "Vaqueros Field at Sycamore Park");
    const sun = await b3.p.locator(`${DFW} [data-testid="detail"][data-fac="Vaqueros Field at Sycamore Park"] [data-testid="day"][data-day="Sun"] [data-testid="mprice"]`).allInnerTexts();
    is("a genuine free game reads free", sun.map((x) => x.trim()), ["free"]);
    const foroPrice = await T(b3.p, `${DFW} [data-testid="detail"][data-fac="Foro Sports Club"] [data-testid="match"][data-notime="1"] [data-testid="mprice"]`);
    is("  CONTROL: a listing that published no price reads not shown, not free and not $0.00", foroPrice, "not shown");
    await closeContext(b3.ctx);
  }

  {
    /* THE EMPTY STATE IS NOW UNREACHABLE WITH REAL DATA — every facility has a log — so it is
     * driven from a fixture. It has to keep working: the next capture may arrive without one, and
     * an empty panel reads as "no matches this week", which is a different and false claim. */
    head("the empty state, for a future capture with no match log");
    const ctx4 = await browser.newContext({ storageState, viewport: { width: 1200, height: 1100 } });
    await ctx4.route("**/api/growth/competitors**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const j = await res.json().catch(() => null);
      if (!j) return route.fulfill({ response: res });
      j.matches = [];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    });
    const p4 = await ctx4.newPage();
    await p4.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 240000 });
    await p4.waitForSelector('[data-testid="city"]', { timeout: 150000 });
    await p4.waitForTimeout(1000);
    await p4.locator(`${HOU} [data-testid="row"][data-fac="Revolution Soccer Complex"]`).click();
    await p4.waitForTimeout(400);
    const nod = await T(p4, `${HOU} [data-testid="detail"][data-fac="Revolution Soccer Complex"] [data-testid="nodetail"]`);
    is("a capture with no match log says so, in one line", nod, "No match log in this capture.");
    yes("  CONTROL: naming the LOG, not claiming zero matches", /match log/.test(nod ?? "") && !/no matches/i.test(nod ?? ""));
    await closeContext(ctx4);
  }

  // ══ SIZES ═════════════════════════════════════════════════════════════════════════════════
  for (const width of [390, 1200]) {
    head(`${width}px`);
    const b2 = await boot(browser, storageState, width);
    is("no page error", b2.errs.length, 0);
    for (const s of ["both", "plei", "goodrec"]) {
      await setSrc(b2.p, s);
      yes(`${width}px ${s}: no horizontal scroll`,
        (await b2.p.evaluate(() => document.documentElement.scrollWidth)) <= width + 2);
      is(`  ${width}px ${s}: nothing overflows its own box`, await overflow(b2.p), []);
    }
    await setSrc(b2.p, "both");
    const btns = nonEmpty(await b2.p.$$eval(".sw button, .fbar button", (es) => es.map((e) => Math.round(e.getBoundingClientRect().height))), `${width}px controls`);
    yes(`every control is ${Math.min(...btns)}px`, Math.min(...btns) >= 32);
    const names = nonEmpty(await b2.p.$$eval(`${HOU} .fname .n`, (es) => es.map((e) => Math.round(e.getBoundingClientRect().width))), `${width}px facility names`);
    yes(`(${names.length} names) every one keeps ${Math.min(...names)}px`, Math.min(...names) >= 120);
    await closeContext(b2.ctx);
  }

  await closeBrowser(browser);
  console.log(`\ncompetitors: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(2); });
