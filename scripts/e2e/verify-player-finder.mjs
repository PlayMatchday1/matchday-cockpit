// PLAYER FINDER — every filter and every figure is the SERVER's answer over the whole set.
//
// WHAT THIS EXISTS TO CATCH. A finder that filters in the browser filters the 50 rows it happens to
// hold and reports a confident wrong number for the other 30,195. So the assertions below are built
// to fail if any figure is computed from the page: the counts asserted are deliberately LARGER THAN
// ONE PAGE, and larger than the 1,000-row PostgREST cap, which is the thing that actually breaks.
//
// NOTHING IS PINNED. Every expected number is derived — from the unfiltered screen, from another
// filter's screen, or from the database at runtime. Three suites this session had to be rewritten
// because a hardcoded production figure moved.

import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";

installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let passed = 0;
const failures = [];
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const browser = await chromium.launch();
const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const ctx = await browser.newContext({ storageState, viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${BASE}/match-ops/player-lookup`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="finder-card"]', { timeout: 180000 });

/* WAIT FOR THE RESPONSE THE ACTION CAUSED, not for the count to look plausible.
 *
 * A settle that only checks "the count has a digit in it" is satisfied instantly by the PREVIOUS
 * answer, so every read races the fetch. That is not hypothetical — this suite's first run reported
 * "Never played narrows the set: got 30245" and then carried the wrong number through six more
 * assertions, because the click had not landed yet. Every interaction below is wrapped in the
 * response it triggers. */
const FINDER = (r) => r.url().includes("/api/players/finder") && !r.url().includes("export=1");
const act = async (fn) => {
  const wait = page.waitForResponse(FINDER, { timeout: 120000 }).catch(() => null);
  await fn();
  await wait;
  // One frame for React to paint what the response carried.
  await page.waitForFunction(() => !/loading/i.test(document.querySelector('[data-testid="finder-count"]')?.textContent ?? ""), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(120);
};
const settle = async () => {
  await page.waitForFunction(() => {
    const c = document.querySelector('[data-testid="finder-count"]')?.textContent ?? "";
    return /\d/.test(c) && !/loading/i.test(c);
  }, null, { timeout: 120000 });
};
await settle();

const num = (t) => {
  const m = String(t ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const read = () => page.evaluate(() => {
  const tiles = [...document.querySelectorAll('[data-testid="finder-tile"]')].map((t) => ({
    k: t.getAttribute("data-k"),
    v: t.querySelector('[class*="pf-v"]')?.textContent ?? "",
    s: t.querySelector('[class*="pf-s"]')?.textContent ?? "",
  }));
  return {
    count: document.querySelector('[data-testid="finder-count"]')?.textContent ?? "",
    tableCount: document.querySelector('[data-testid="finder-tablecount"]')?.textContent ?? "",
    exportLabel: document.querySelector('[data-testid="finder-export"]')?.textContent ?? "",
    rows: document.querySelectorAll('[data-testid="finder-row"]').length,
    tiles,
    tileKeys: tiles.map((t) => t.k),
  };
});

/* ── THE CONTROLS NOW LIVE BEHIND CHIPS ────────────────────────────────────────────────────────
 * The seven stacked rows became one search field and six chips, and a filter's controls are
 * rendered only while its chip is open. EVERY TEST ID BELOW IS UNCHANGED — what changed is that
 * you have to open the chip that owns one before you can touch it, so that step moved into these
 * helpers rather than into ninety call sites.
 *
 * The one id that could not survive is `finder-play-row`: there is no row. The thing that carries
 * `data-disabled` is now the chip, `finder-chip-play`, and the three assertions that read it are
 * unchanged in body — only the selector moved. */
const CHIP_OF = (testid) => {
  if (/^finder-reg-|^finder-reg(from|to)$/.test(testid)) return "reg";
  if (/^finder-hist-/.test(testid)) return "hist";
  if (/^finder-play-(?!why$)|^finder-play(from|to)$/.test(testid)) return "play";
  if (/^finder-(city|nohome)$/.test(testid)) return "city";
  if (/^finder-member-/.test(testid)) return "mem";
  if (/^finder-(match-city|field|kickfrom|kickto|matchfrom|matchto)$/.test(testid)) return "at";
  return null; // finder-q, finder-clear, finder-refresh — in the bar, no chip
};

const popOpen = () => page.evaluate(() =>
  document.querySelector('[data-testid="finder-pop"]')?.getAttribute("data-pop") ?? null);

const closePop = async () => {
  if (await popOpen()) { await page.keyboard.press("Escape"); await page.waitForTimeout(80); }
};

// Open a chip's popover. An OPEN popover overlaps the chips beside it, so a different one is
// closed first rather than left to swallow the click.
const openChip = async (id) => {
  if (!id) { await closePop(); return; }
  const cur = await popOpen();
  if (cur === id) return;
  if (cur) await closePop();
  await page.click(`[data-testid="finder-chip-${id}"]`);
  await page.waitForSelector(`[data-testid="finder-pop"][data-pop="${id}"]`, { timeout: 8000 });
};
const openFor = (testid) => openChip(CHIP_OF(testid));

const apply = async (testid) => {
  await openFor(testid);
  await act(() => page.click(`[data-testid="${testid}"]`));
  return read();
};

const pick = async (testid, value) => {
  await openFor(testid);
  await act(() => page.selectOption(`[data-testid="${testid}"]`, value));
  return read();
};

const type = async (testid, value) => {
  await openFor(testid);
  await act(() => page.fill(`[data-testid="${testid}"]`, value));
  return read();
};

// Read a control's value, opening its chip first — a closed popover renders nothing, so a bare
// querySelector would report `undefined` for every one of them and quietly pass.
const valueOf = async (testid) => {
  await openFor(testid);
  return page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.value ?? null, testid);
};

const clearAll = async () => {
  await closePop();
  const has = await page.locator('[data-testid="finder-clear"]').count();
  if (has) await act(() => page.click('[data-testid="finder-clear"]'));
  return read();
};

// ── 1. THE UNFILTERED BASELINE ────────────────────────────────────────────────────────────────
console.log("\n── the unfiltered list ──");
const base = await read();
const baseTotal = num(base.count);
{
  const { count: dbTotal } = await db.from("player_finder_rows").select("id", { count: "exact", head: true });
  eq("  control — the finder rendered a count", Number.isFinite(baseTotal) && baseTotal > 0, true);
  // THE COUNT IS THE SERVER'S, over every row — not the page's length.
  eq(`the header count equals the whole table (${dbTotal.toLocaleString()})`, baseTotal, dbTotal);
  eq("  …and it is far larger than one page", baseTotal > base.rows * 10, true);
  eq("  …and larger than the 1,000-row PostgREST cap", baseTotal > 1000, true);
  eq("  control — a page of rows is rendered", base.rows > 0, true);
}

// ── 2. EVERY FILTER NARROWS, AND THE COUNT STILL EXCEEDS A PAGE ───────────────────────────────
console.log("\n── each filter narrows the set ──");
{
  const never = await apply("finder-hist-never");
  const neverN = num(never.count);
  const { count: dbNever } = await db.from("player_finder_rows").select("id", { count: "exact", head: true }).eq("plays", 0);
  eq("Never played narrows the set", neverN < baseTotal, true);
  eq(`  …to the server's own figure (${dbNever.toLocaleString()})`, neverN, dbNever);
  // THE ASSERTION THAT MATTERS: this count is far beyond one page AND beyond the 1,000 cap, so it
  // cannot have been counted from rows on screen or from a single unpaged read.
  eq("  …and that figure exceeds one page and the 1,000-row cap", neverN > 1000 && neverN > never.rows, true);

  const once = await apply("finder-hist-once");
  const onceN = num(once.count);
  eq("Played once is a different, smaller set", onceN < neverN && onceN > 0, true);
  eq("  …and still exceeds one page", onceN > 1000, true);

  await clearAll();
  const mem = await apply("finder-member-yes");
  eq("Members narrows the set", num(mem.count) < baseTotal, true);
  eq("  control — it is not zero", num(mem.count) > 0, true);
  await clearAll();

  // SEARCH — free text over name, email, phone and id.
  const search = await type("finder-q", "garcia");
  const { count: dbSearch } = await db.from("player_finder_rows").select("id", { count: "exact", head: true }).like("search_blob", "%garcia%");
  eq("Search narrows the set", num(search.count) < baseTotal, true);
  eq(`  …to the server's own figure (${dbSearch})`, num(search.count), dbSearch);
  await type("finder-q", "");

  // THE POSITIVE CONTROL FOR ALL OF THE ABOVE: clearing restores the baseline, so the counter is
  // demonstrably reading a change rather than being stuck.
  const restored = await clearAll();
  eq("  control — clearing restores the unfiltered count", num(restored.count), baseTotal);
}

// ── 3. THE CITY FILTER, AND WARSAW ────────────────────────────────────────────────────────────
console.log("\n── the city filter ──");
{
  const waw = await pick("finder-city", "WAW");
  const { count: dbWaw } = await db.from("player_finder_rows").select("id", { count: "exact", head: true }).eq("preferable_city_name", "Warsaw");
  eq(`Warsaw returns the server's count (${dbWaw})`, num(waw.count), dbWaw);
  /* DERIVE, DO NOT PIN. This asserted `rows === dbWaw`, which silently assumed Warsaw fitted on
   * one page — it stopped being true at 51 players and the suite went red on a market growing,
   * not on a defect. The page holds `size` rows; what must be true at ANY size is that the screen
   * shows the whole set or a full page of it. */
  const PAGE = 50;
  eq("  …and the page is filled from that set", waw.rows, Math.min(dbWaw, PAGE));
  await pick("finder-city", "");
}

// ── 4. A TILE FORCED BY A FILTER IS DROPPED ───────────────────────────────────────────────────
console.log("\n── a forced tile is dropped ──");
{
  const unfiltered = await clearAll();
  // POSITIVE CONTROL FIRST: the tile is present when nothing forces it. Without this, "absent"
  // would pass on a band that failed to render at all.
  eq("  control — Top city is present unfiltered", unfiltered.tileKeys.includes("Top city"), true);
  const withCity = await pick("finder-city", "ATX");
  eq("with a city filter, the Top city tile is dropped", withCity.tileKeys.includes("Top city"), false);
  eq("  …and so is Cities", withCity.tileKeys.includes("Cities"), false);
  eq("  control — the band still rendered other tiles", withCity.tileKeys.length > 0, true);
  await pick("finder-city", "");

  const withAct = await apply("finder-hist-once");
  eq("with a History filter, Never played is dropped", withAct.tileKeys.includes("Never played"), false);
  eq("  control — it was present before", unfiltered.tileKeys.includes("Never played"), true);
  await clearAll();
}

// ── 5. OCCUPANCY ──────────────────────────────────────────────────────────────────────────────
console.log("\n── the occupancy figures ──");
{
  // The three occupancy tiles only rank into the visible six when the selection is about who
  // plays, so a member filter is set to bring them up — which is also when they are the question.
  await apply("finder-member-yes");
  const occ = await read();
  const spots = num(occ.tiles.find((t) => t.k === "Spots occupied")?.v);
  const matches = num(occ.tiles.find((t) => t.k === "Matches")?.v);
  const fullTile = occ.tiles.find((t) => t.k === "Matches full");
  eq("  control — the occupancy tiles are on screen", [spots != null, matches != null, !!fullTile], [true, true, true]);
  eq("spots >= distinct matches (one player in two spots is one match)", spots >= matches, true);
  const capText = occ.tiles.find((t) => t.k === "Spots occupied")?.s ?? "";
  const cap = num(capText.replace(/^\D*\d+%\D*/, ""));
  eq("  control — the subtitle states the capacity", Number.isFinite(cap) && cap > 0, true);
  eq("spots <= the capacity of those matches", spots <= cap, true);
  // THE PERCENTAGE MUST MATCH ITS OWN SUBTITLE — "13 of 38" and "34%" are the same claim twice.
  const pct = num(fullTile?.v);
  const m = /([\d,]+) of ([\d,]+)/.exec(fullTile?.s ?? "");
  eq("  control — the full tile spells out its own fraction", !!m, true);
  if (m) {
    const [fullN, ofN] = [Number(m[1].replace(/,/g, "")), Number(m[2].replace(/,/g, ""))];
    eq(`the full % equals its own "${m[1]} of ${m[2]}"`, pct, Math.round((fullN / ofN) * 100));
    eq("  …and that denominator is the Matches tile", ofN, matches);
  }

  // ── THE PLAYED WINDOW BITES, AND IT NARROWS THE ROWS TOO ────────────────────────────────────
  // This is the whole point of the rework: the old month select moved the tiles and left the rows
  // alone, so the band could describe a different set of people than the table under it.
  const win30 = await apply("finder-play-30");
  const winSpots = num(win30.tiles.find((t) => t.k === "Spots occupied")?.v);
  eq(`a 30-day window is a strict subset of all time (${winSpots} < ${spots})`, winSpots < spots, true);
  // A TILE THAT IGNORED THE WINDOW WOULD STILL LOOK PLAUSIBLE. The widening comparison is what
  // catches it — an unchanged figure is the failure, not an implausible one.
  eq("  control — the tile moved at all", winSpots !== spots, true);
  eq("the PLAYED window narrows the ROWS as well as the tiles", num(win30.count) < num(occ.count), true);
  /* THE SAME CALENDAR DAY THE ROUTE COMPUTES. The route takes a LOCAL date; toISOString() takes a
   * UTC one, and in America/Chicago those are different days for five hours out of every
   * twenty-four. That skew showed up as 212 vs 210 — small, wrong, and nothing to do with the code
   * under test. */
  const localDay = (n) => { const d = new Date(Date.now() - n * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const { data: dbWin } = await db.rpc("player_finder_stats", {
    p_member: "yes", p_play_mode: "window", p_play_from: localDay(30),
  });
  eq("  …to the server's own figure", num(win30.count), Number(dbWin?.[0]?.players));
  await clearAll();
}

// ── 6. THE 0134 REGRESSION: A FUTURE BOOKING IS NOT A PLAY ────────────────────────────────────
// player_play_stats counts a match once it has kicked off; player_spots holds future bookings too.
// Before 0134 the occupancy function counted those, so "never played" reported 35 spots across 16
// matches — the two halves of the same screen disagreeing about the same person. Nothing else in
// this suite would notice that coming back.
console.log("\n── a future booking is not a play ──");
{
  const nowIso = new Date().toISOString();
  // A player with a FUTURE spot and NO completed match — found at runtime, never pinned.
  /* SEARCH THE WHOLE SET, NOT ITS FIRST 200 IDS. This took the 400 lowest-ordered future spots and
   * probed only the first 200 of them; once every one of those players had played, the control
   * reported "no such player exists" when plenty do. An absence found by sampling is not an
   * absence. It now walks the candidates in batches until it finds one. */
  const { data: futureSpots } = await db.from("player_spots")
    .select("user_id").gte("start_date_utc", nowIso).limit(4000);
  const ids = [...new Set((futureSpots ?? []).map((r) => r.user_id))];
  let neverId = null;
  for (let i = 0; i < ids.length && neverId == null; i += 200) {
    const { data: cands } = await db.from("player_finder_rows")
      .select("id, plays").in("id", ids.slice(i, i + 200)).eq("plays", 0).order("id").limit(1);
    neverId = cands?.[0]?.id ?? null;
  }
  eq("  control — there were future-booking players to search at all", ids.length > 0, true);
  eq("  control — a player exists with a future booking and no completed match", neverId != null, true);

  if (neverId != null) {
    /* SEARCH IS A SUBSTRING MATCH, NOT AN ID LOOKUP. Typing "58996" also matches any phone number
     * containing it — the first run of this asserted a total of 1 and got 3. So the assertion is
     * that this player IS in the never-played set, which is the actual claim. */
    await type("finder-q", String(neverId));
    const found = await apply("finder-hist-never");
    const onScreen = await page.evaluate(() => [...document.querySelectorAll('[data-testid="finder-row"]')].map((r) => Number(r.getAttribute("data-pid"))));
    eq(`player ${neverId} is in the never-played set`, onScreen.includes(neverId), true);
    eq("  control — the set is not empty", num(found.count) >= 1, true);
    const s2 = num(found.tiles.find((t) => t.k === "Spots occupied")?.v);
    const mt = num(found.tiles.find((t) => t.k === "Matches")?.v);
    // The occupancy tiles are DROPPED at act=never — the specified behaviour — so the assertion is
    // that they are absent, never that they read a confident zero.
    eq("  …and the occupancy tiles are dropped, not shown as a confident zero", [s2, mt], [null, null]);

    /* AND THE NUMBERS BEHIND THE HIDDEN TILES ARE REALLY ZERO. A hidden tile cannot prove the
     * figure behind it, so this asks the aggregate directly — and separately proves the player DOES
     * hold a future spot, which is what makes the zero meaningful rather than vacuous. */
    const nowIso2 = new Date().toISOString();
    const { count: past } = await db.from("player_spots").select("user_id", { count: "exact", head: true })
      .eq("user_id", neverId).lt("start_date_utc", nowIso2);
    const { count: future } = await db.from("player_spots").select("user_id", { count: "exact", head: true })
      .eq("user_id", neverId).gte("start_date_utc", nowIso2);
    eq(`  control — player ${neverId} really does hold a future booking`, future >= 1, true);
    eq("  …and holds no completed match", past, 0);
    const { data: occRow } = await db.rpc("player_finder_occupancy", { p_activity: "never" });
    eq("  …so the occupancy function returns four zeros for never-played",
      [Number(occRow?.[0]?.spots), Number(occRow?.[0]?.matches), Number(occRow?.[0]?.matches_full), Number(occRow?.[0]?.capacity)],
      [0, 0, 0, 0]);
    await type("finder-q", "");
    await clearAll();
  }

  /* THE POSITIVE CONTROL: a player whose match HAS started reads one play and one spot. Same
   * machinery, opposite answer — which is what proves the zero above is a real zero rather than a
   * function that returns nothing for everyone. Counted directly, because p_search is a substring
   * match and "24" would match thousands. */
  // WITH AN EMAIL, so the search can isolate them. A bare id is a SUBSTRING match — searching "24"
  // returns thousands and the player is not on page one, which is what the first run asserted and
  // got wrong.
  const { data: onePlay } = await db.from("player_finder_rows")
    .select("id, plays, email").eq("plays", 1).not("email", "is", null).order("id").limit(1);
  const onceId = onePlay?.[0]?.id ?? null;
  const onceEmail = onePlay?.[0]?.email ?? null;
  eq("  control — a player exists with exactly one completed match", onceId != null, true);
  if (onceId != null) {
    const nowIso3 = new Date().toISOString();
    const { count: pastOne } = await db.from("player_spots").select("user_id", { count: "exact", head: true })
      .eq("user_id", onceId).lt("start_date_utc", nowIso3);
    eq(`player ${onceId} holds exactly one occupied spot`, pastOne, 1);
    // AND THE FINDER AGREES ON THE SAME SCREEN: they read as played-once, not never-played.
    await type("finder-q", onceEmail);
    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="finder-row"]')].map((r) => Number(r.getAttribute("data-pid"))));
    eq(`  …and the finder lists player ${onceId}`, rows.includes(onceId), true);
    eq("  control — that search isolates them", rows.length >= 1, true);
    await apply("finder-hist-never");
    const stillThere = await page.evaluate(() => [...document.querySelectorAll('[data-testid="finder-row"]')].map((r) => Number(r.getAttribute("data-pid"))));
    eq("  …and never-played does NOT include them", stillThere.includes(onceId), false);
    await type("finder-q", "");
    await clearAll();
  }
}

// ── 7. COLLAPSE KEEPS THE COUNT ───────────────────────────────────────────────────────────────
console.log("\n── collapse ──");
{
  const before = await read();
  await page.click('[data-testid="finder-head"]');
  await page.waitForTimeout(250);
  const collapsed = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="finder-body"]');
    const chev = document.querySelector('[data-testid="finder-chev"]');
    return {
      height: body?.getBoundingClientRect().height ?? -1,
      count: document.querySelector('[data-testid="finder-count"]')?.textContent ?? "",
      chevUp: (chev?.className ?? "").includes("up"),
    };
  });
  eq("the collapsed body has zero height", collapsed.height, 0);
  eq("  …and the count survives in the header", num(collapsed.count), num(before.count));
  eq("  …and the chevron points down", collapsed.chevUp, false);
  await page.click('[data-testid="finder-head"]');
  await settle();
  const reopened = await page.evaluate(() => (document.querySelector('[data-testid="finder-body"]')?.getBoundingClientRect().height ?? 0) > 0);
  eq("  control — reopening restores the body", reopened, true);
}

// ── 8. EXPORT CARRIES THE FILTERED COUNT, NOT THE PAGE ────────────────────────────────────────
console.log("\n── export ──");
{
  const now = await clearAll();
  eq("the export label carries the full filtered count", num(now.exportLabel), num(now.count));
  eq("  …which is not the page size", num(now.exportLabel) === now.rows, false);
  const narrowed = await apply("finder-member-yes");
  eq("  …and follows the filter", num(narrowed.exportLabel), num(narrowed.count));
  await clearAll();
}


// ── 9. EVERY POPOVER CARRIES ITS OPTION SET, VERBATIM FROM THE CONSTANTS ─────────────────────
console.log("\n── each popover carries its option set ──");
{
  await clearAll();

  /* PARSED FROM THE COMPONENT'S OWN SOURCE, not retyped here. A list typed into the suite is a
   * second place the options live and it goes stale the day one is renamed — which is exactly the
   * drift this assertion exists to catch. PLAY_OPTS is not a plain literal (it spreads the first
   * three of REG_OPTS), so it is reconstructed the same way the component builds it. */
  const src = readFileSync("src/components/PlayerFinder.tsx", "utf8");
  const pairs = (name) => {
    const m = new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\];`).exec(src);
    if (!m) return null;
    return [...m[1].matchAll(/\["([^"]*)",\s*"([^"]*)"\]/g)].map((x) => [x[1], x[2]]);
  };
  const REG = pairs("REG_OPTS"), HIST = pairs("HIST_OPTS"), MEM = pairs("MEM_OPTS");
  const PLAY_TAIL = pairs("PLAY_OPTS");
  eq("  control — the option sets were parsed out of the source", [REG?.length, HIST?.length, MEM?.length, PLAY_TAIL?.length], [4, 4, 3, 2]);
  const PLAY = [...REG.slice(0, 3), ...PLAY_TAIL];

  // What one popover actually renders: the option labels, in order, and whether it has a date pair.
  const popOpts = async (chip) => {
    await openChip(chip);
    return page.evaluate((c) => {
      const pop = document.querySelector(`[data-testid="finder-pop"][data-pop="${c}"]`);
      if (!pop) return null;
      return {
        labels: [...pop.querySelectorAll(".pf-opts button")].map((b) => b.textContent.replace(/✓/g, "").trim()),
        ids: [...pop.querySelectorAll(".pf-opts button")].map((b) => b.getAttribute("data-testid")),
        dates: [...pop.querySelectorAll('input[type="date"]')].map((i) => i.getAttribute("data-testid")),
      };
    }, chip);
  };

  const reg = await popOpts("reg"), play = await popOpts("play"), hist = await popOpts("hist"), mem = await popOpts("mem");
  eq("  control — every popover opened and rendered options",
    [reg?.labels.length, play?.labels.length, hist?.labels.length, mem?.labels.length], [4, 5, 4, 3]);

  eq("Signed up renders REG_OPTS verbatim, in order", reg.labels, REG.map(([, t]) => t));
  eq("Played renders PLAY_OPTS verbatim, in order", play.labels, PLAY.map(([, t]) => t));
  eq("History renders HIST_OPTS verbatim, in order", hist.labels, HIST.map(([, t]) => t));
  eq("Member renders MEM_OPTS verbatim, in order", mem.labels, MEM.map(([, t]) => t));
  eq("  control — the comparison can fail", reg.labels.join() === HIST.map(([, t]) => t).join(), false);

  eq("both window popovers carry a from and a to", [reg.dates, play.dates],
    [["finder-regfrom", "finder-regto"], ["finder-playfrom", "finder-playto"]]);

  // STRUCTURALLY IDENTICAL BAR THE NEGATION: PLAYED is SIGNED UP plus `not60`, nothing else.
  const val = (l) => l.map((t) => t.replace(`finder-`, "")).sort();
  const regSet = val(reg.ids).map((v) => v.replace("reg-", ""));
  const playSet = val(play.ids).map((v) => v.replace("play-", ""));
  const extra = playSet.filter((v) => !regSet.includes(v));
  const missing = regSet.filter((v) => !playSet.includes(v));
  eq("PLAYED adds exactly one option SIGNED UP does not have", extra, ["not60"]);
  eq("  …and drops none of them", missing, []);

  // HISTORY IS A COUNT, NOT A CLOCK. No label may carry a time word or a day count — those moved to
  // the PLAYED row where they are the general case.
  const timey = hist.labels.filter((l) => /\bday|\bweek|\bmonth|\byear|\d+\s*d\b|recent|lapsed|ago/i.test(l ?? ""));
  eq("HISTORY carries no time word and no day count", timey, []);
  eq("  control — the scan DOES catch one when present", /\bday/i.test("Played in 30 days"), true);
  eq("  control — HISTORY does have labels to scan", hist.labels.length, 4);
  await closePop();
}

// ── 10. NOT IN 60+ DAYS ───────────────────────────────────────────────────────────────────────
console.log("\n── not in 60+ days ──");
{
  const lapsed = await apply("finder-play-not60");
  eq("  control — the negation returns a non-empty set", num(lapsed.count) > 0, true);
  const { data: dbLapsed } = await db.rpc("player_finder_stats", { p_play_mode: "lapsed" });
  eq("  …matching the server's own figure", num(lapsed.count), Number(dbLapsed?.[0]?.players));
  // THE THREE OCCUPANCY TILES ARE DROPPED. A negation has no window to total, and a figure
  // labelled with one would be lying about its own scope.
  for (const k of ["Spots occupied", "Matches", "Matches full"]) {
    eq(`  the ${k} tile is absent`, lapsed.tileKeys.includes(k), false);
  }
  eq("  …and the server sent null rather than zero",
    [dbLapsed?.[0]?.spots, dbLapsed?.[0]?.matches, dbLapsed?.[0]?.capacity], [null, null, null]);

  // THE ROWS THEMSELVES: every one has played, and none within 60 days.
  const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid="finder-row"]')].map((r) => Number(r.getAttribute("data-pid"))));
  eq("  control — rows rendered to check", ids.length > 0, true);
  const { data: chk } = await db.from("player_finder_rows").select("id, plays, last_played").in("id", ids);
  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
  eq("every row has played at least once", (chk ?? []).every((r) => r.plays >= 1), true);
  eq("  …and none within 60 days", (chk ?? []).every((r) => r.last_played < cutoff), true);
  await clearAll();
}

// ── 11. NEVER PLAYED DIMS THE PLAYED CHIP, AND SAYS WHY IN THE BAR ───────────────────────────
console.log("\n── never played disables the window ──");
{
  await closePop();
  // SELECTOR CHANGED, ASSERTION UNCHANGED: `finder-play-row` no longer exists — there is no row —
  // and the element carrying data-disabled is the chip.
  const readPlay = () => page.evaluate(() => {
    const chip = document.querySelector('[data-testid="finder-chip-play"]');
    const why = document.querySelector('[data-testid="finder-play-why"]');
    return {
      disabled: chip?.getAttribute("data-disabled") ?? null,
      pe: chip ? getComputedStyle(chip).pointerEvents : null,
      why: why?.textContent?.trim() ?? "",
      whyN: document.querySelectorAll('[data-testid="finder-play-why"]').length,
      // THE REASON MUST BE TEXT, NOT A TOOLTIP. A disabled control is the one thing nobody hovers.
      title: chip?.getAttribute("title") ?? null,
      popOpen: document.querySelector('[data-testid="finder-pop"][data-pop="play"]') !== null,
    };
  });

  const before = await readPlay();
  // POSITIVE CONTROL, BOTH WAYS: live before, inert after, live again after Clear.
  eq("  control — the PLAYED chip is live to begin with", [before.disabled, before.whyN], ["false", 0]);

  await apply("finder-hist-never");
  await closePop();
  const off = await readPlay();
  eq("History = Never played disables the PLAYED chip", off.disabled, "true");
  // POINTER-EVENTS, not opacity. A dimmed chip that still fires is worse than no dimming.
  eq("  …genuinely inert, not merely dimmed", off.pe, "none");
  eq("  …with the reason on screen", off.why, "Played is off — no play dates to filter on when History is Never played.");
  eq("  …as TEXT IN THE BAR, not as a title attribute", off.title, null);
  eq("  control — the reason is a real node, not an empty string", off.why.length > 20, true);

  // AND IT OPENS NOTHING. Clicking a dimmed chip must not reach its controls by another route.
  await page.click('[data-testid="finder-chip-play"]', { force: true }).catch(() => {});
  await page.waitForTimeout(120);
  const afterClick = await readPlay();
  eq("  …and clicking it opens no popover", afterClick.popOpen, false);
  eq("  …so its presets are not in the document at all",
    await page.locator('[data-testid="finder-play-30"]').count(), 0);
  eq("  control — that preset IS reachable when the chip is live",
    await (async () => { await clearAll(); await openChip("play");
      const n = await page.locator('[data-testid="finder-play-30"]').count(); await closePop(); return n; })(), 1);

  const back = await readPlay();
  eq("Clear filters re-enables it", [back.disabled, back.whyN], ["false", 0]);
}

// ── 12. AN EXPLICIT RANGE OVERRIDES THE PRESET, AND CLEAR EMPTIES BOTH PAIRS ──────────────────
console.log("\n── typed ranges ──");
{
  await apply("finder-play-30");
  const from = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
  await openChip("play");
  await act(() => page.fill('[data-testid="finder-playfrom"]', from));
  const ranged = await act(() => page.fill('[data-testid="finder-playto"]', to)).then(read);
  const lit = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="finder-play-"]')]
    .filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("data-testid")));
  eq("a typed play range unlights every preset", lit, []);
  // THE TILE NAMES THE RANGE, so the figure's scope is readable without inferring it from a control.
  const sub = ranged.tiles.find((t) => t.k === "Matches")?.s ?? "";
  eq(`the Matches tile names the range (${from} → ${to})`, sub.includes(from) && sub.includes(to), true);
  eq("  control — the tile is present to name anything", !!sub, true);

  await openChip("reg");
  await act(() => page.fill('[data-testid="finder-regfrom"]', from));
  // Read each through valueOf, which opens the owning chip first — a closed popover renders
  // nothing, so a bare querySelector would report undefined for all four and pass on nothing.
  const bothSet = [];
  for (const t of ["finder-regfrom", "finder-playfrom", "finder-playto"]) bothSet.push(await valueOf(t));
  eq("  control — both date pairs carry values before Clear", bothSet.every((v) => !!v), true);
  await clearAll();
  const emptied = [];
  for (const t of ["finder-regfrom", "finder-regto", "finder-playfrom", "finder-playto"]) emptied.push(await valueOf(t));
  await closePop();
  eq("Clear empties BOTH date pairs", emptied, ["", "", "", ""]);
}

// ── 13. THE CHIP BAR ──────────────────────────────────────────────────────────────────────────
//
// A CHIP IS QUIET UNTIL IT IS DOING SOMETHING. At rest it shows only its name in grey; a filter
// moved off its DEFAULT turns it green, gives it a value and an ×. That is the whole idea of the
// collapse, so it is the thing asserted hardest: a bar where a chip at its default looks active
// says "you have filtered something" when you have not.
console.log("\n── the chip bar ──");
{
  await clearAll();
  await closePop();

  const chipState = () => page.evaluate(() =>
    [...document.querySelectorAll("[data-chip]")].map((c) => ({
      id: c.getAttribute("data-chip"),
      set: c.getAttribute("data-set"),
      name: c.querySelector(".pf-chipn")?.textContent?.trim() ?? "",
      value: c.querySelector(".pf-chipv")?.textContent?.trim() ?? null,
      x: !!c.querySelector(".pf-x"),
    })));

  const rest = nonEmpty(await chipState(), "chip in the bar");
  eq("  control — all six chips rendered", rest.map((c) => c.id), ["reg", "hist", "play", "city", "mem", "at"]);
  eq("at rest NO chip is lit", rest.filter((c) => c.set !== "false").map((c) => c.id), []);
  eq("  …none shows a value", rest.filter((c) => c.value !== null).map((c) => c.id), []);
  eq("  …and none offers an × to clear", rest.filter((c) => c.x).map((c) => c.id), []);
  eq("  …and the bar says so",
    (await page.textContent('[data-testid="finder-filtercount"]')).startsWith("No filters"), true);

  // Two filters on, four still at their defaults.
  await apply("finder-hist-once");
  await apply("finder-member-yes");
  await closePop();
  const some = nonEmpty(await chipState(), "chip in the bar with filters set");
  eq("exactly the chips moved off their defaults are lit",
    some.filter((c) => c.set === "true").map((c) => c.id), ["hist", "mem"]);
  eq("  …and each states its value", some.filter((c) => c.set === "true").map((c) => c.value), ["Played once", "Members"]);
  eq("  …and each grows an × ", some.filter((c) => c.set === "true").every((c) => c.x), true);
  // CONTROL — THE CHECK CAN FAIL. The four untouched chips must still be quiet; if "lit" were
  // returning true for everything, this is the assertion that catches it.
  eq("  control — the four untouched chips are still quiet",
    some.filter((c) => c.set === "false").map((c) => c.id), ["reg", "play", "city", "at"]);
  eq("  control — and carry no value", some.filter((c) => c.set === "false").map((c) => c.value), [null, null, null, null]);
  eq("the bar counts them", await page.textContent('[data-testid="finder-filtercount"]'), "2 filters on");

  // The × clears just that filter and leaves the other alone.
  await act(() => page.click('[data-testid="finder-chipx-mem"]'));
  const afterX = nonEmpty(await chipState(), "chip after clearing one");
  eq("the × clears its own filter only", afterX.filter((c) => c.set === "true").map((c) => c.id), ["hist"]);
  eq("  …and the count follows", await page.textContent('[data-testid="finder-filtercount"]'), "1 filter on");
  await clearAll();
}

// ── 14. THE PLAYED-AT CONFLICT STAYS IN THE BAR ───────────────────────────────────────────────
//
// This one turns the RESULT EMPTY. Hiding it inside a popover nobody opens would be a regression,
// not a tidy-up, so it is asserted to be in the bar and NOT inside any popover.
console.log("\n── the played-at conflict ──");
{
  await clearAll();
  await apply("finder-hist-never");
  await pick("finder-match-city", "ATX");
  await closePop();
  const c = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="finder-playedat-empty"]');
    return {
      present: !!el,
      text: el?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      insidePop: !!el?.closest('[data-testid="finder-pop"]'),
      inBar: !!el?.closest('[data-testid="finder-params"]'),
      visible: el ? el.getBoundingClientRect().height > 0 : false,
    };
  });
  eq("  control — the conflict strip rendered", c.present, true);
  eq("the conflict is in the bar", c.inBar, true);
  eq("  …and NOT inside a popover", c.insidePop, false);
  eq("  …and is actually visible", c.visible, true);
  eq("its wording is unchanged", c.text,
    "History is Never played and a Played-at filter is set — nobody can match both, so this will return nothing. That is the real answer, not a bug.");
  await clearAll();
}

// ── 15. NOTHING IS TRUNCATED, NOTHING SPILLS, NOTHING SCROLLS SIDEWAYS ────────────────────────
console.log("\n── the bar fits ──");
{
  await clearAll();
  // Set every chip so each one carries a value — the widest the bar ever gets.
  await apply("finder-reg-30");
  await apply("finder-hist-multi");
  await apply("finder-member-yes");
  await pick("finder-city", "ATX");
  await pick("finder-match-city", "ATX");
  await closePop();

  /* TRUNCATION IS scrollWidth > clientWidth, not overflow:hidden. An element can be clipped with
   * no overflow property set at all, and an element with overflow:hidden may fit perfectly. */
  const truncProbe = () => page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="finder-params"] .pf-chipn, [data-testid="finder-params"] .pf-chipv, [data-testid="finder-params"] .pf-fcount')];
    return els.map((e) => ({
      cls: e.className, text: e.textContent.trim().slice(0, 28),
      cut: e.scrollWidth > e.clientWidth + 1,
    }));
  });
  const trunc = nonEmpty(await truncProbe(), "chip label or value to measure");
  eq("no chip label or value is truncated", trunc.filter((t) => t.cut).map((t) => t.text), []);
  // CONTROL — THE PROBE CAN SEE A CUT. Squeeze one real element and the same probe must report it.
  await page.evaluate(() => {
    const e = document.querySelector('[data-testid="finder-params"] .pf-chipn');
    e.setAttribute("data-orig", e.style.cssText);
    e.style.width = "8px"; e.style.overflow = "hidden"; e.style.display = "inline-block";
  });
  const squeezed = nonEmpty(await truncProbe(), "chip label under the squeeze");
  eq("  control — squeezed to 8px, the probe reports it cut", squeezed.filter((t) => t.cut).length > 0, true);
  await page.evaluate(() => {
    const e = document.querySelector('[data-testid="finder-params"] .pf-chipn');
    e.style.cssText = e.getAttribute("data-orig") ?? ""; e.removeAttribute("data-orig");
  });
  eq("  …and is clean again once released", (await truncProbe()).filter((t) => t.cut).length, 0);

  /* NO POPOVER SPILLS. At a desktop width it is anchored under its chip and must stay inside the
   * CARD; on a phone it is a bottom sheet spanning the viewport, so there the containment that
   * matters is the viewport. Both are checked, at both widths. */
  const spillAt = async (w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(200);
    const out = [];
    for (const id of ["reg", "hist", "play", "city", "mem", "at"]) {
      await openChip(id);
      out.push(await page.evaluate((i) => {
        const pop = document.querySelector(`[data-testid="finder-pop"][data-pop="${i}"]`);
        const card = document.querySelector('[data-testid="finder-card"]');
        const p = pop.getBoundingClientRect(), c = card.getBoundingClientRect();
        return { id: i, w: Math.round(p.width),
          pastCardRight: Math.round(p.right - c.right), pastCardLeft: Math.round(c.left - p.left),
          pastViewR: Math.round(p.right - window.innerWidth), pastViewL: Math.round(-p.left) };
      }, id));
    }
    await closePop();
    return out;
  };

  const wide = nonEmpty(await spillAt(1280, 1000), "popover measured at 1280");
  eq("  control — all six popovers opened at 1280 and have width", wide.filter((p) => p.w > 100).length, 6);
  eq("at 1280 no popover spills past the card's right edge", wide.filter((p) => p.pastCardRight > 0).map((p) => `${p.id}+${p.pastCardRight}`), []);
  eq("  …nor past its left edge", wide.filter((p) => p.pastCardLeft > 0).map((p) => `${p.id}+${p.pastCardLeft}`), []);

  const phone = nonEmpty(await spillAt(390, 844), "popover measured at 390");
  eq("  control — all six opened at 390 too", phone.filter((p) => p.w > 100).length, 6);
  eq("at 390 no popover spills outside the viewport",
    phone.filter((p) => p.pastViewR > 0 || p.pastViewL > 0).map((p) => p.id), []);

  // NO HORIZONTAL PAGE SCROLL AT EITHER WIDTH.
  const hscroll = async (w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  };
  eq("no horizontal page scroll at 1280", await hscroll(1280, 1000) <= 0, true);
  eq("no horizontal page scroll at 390", await hscroll(390, 844) <= 0, true);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await clearAll();
}

// ── 16. THE FILTER BLOCK'S HEIGHT ─────────────────────────────────────────────────────────────
console.log("\n── the filter block's height ──");
{
  await clearAll();
  await closePop();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForTimeout(250);
  const h = await page.evaluate(() =>
    Math.round(document.querySelector('[data-testid="finder-params"]').getBoundingClientRect().height));
  console.log(`     filter block at 1280px: ${h}px`);
  eq("  control — the block has a height at all", h > 0, true);
  // The mock measured 396 → 95. The real page carries a wrapping chip row, so the bar is asserted
  // to be comfortably under half the seven-row block it replaced rather than pinned to the mock.
  eq(`the filter block is far shorter than the seven rows it replaced (${h}px vs 396px)`, h < 200, true);
  await page.setViewportSize({ width: 1600, height: 1100 });
}

eq("no uncaught page errors", errors, []);

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  ${f}`);
}
await closeContext(ctx);
await closeBrowser(browser);
process.exit(failures.length ? 1 : 0);
