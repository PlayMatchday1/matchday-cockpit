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

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";

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

const apply = async (testid) => {
  await act(() => page.click(`[data-testid="${testid}"]`));
  return read();
};

const pick = async (testid, value) => {
  await act(() => page.selectOption(`[data-testid="${testid}"]`, value));
  return read();
};

const type = async (testid, value) => {
  await act(() => page.fill(`[data-testid="${testid}"]`, value));
  return read();
};

const clearAll = async () => {
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
  eq("  …and every row on screen is rendered", waw.rows, dbWaw);
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
  const { data: futureSpots } = await db.from("player_spots")
    .select("user_id").gte("start_date_utc", nowIso).order("user_id").limit(400);
  const ids = [...new Set((futureSpots ?? []).map((r) => r.user_id))];
  const { data: cands } = await db.from("player_finder_rows")
    .select("id, plays").in("id", ids.slice(0, 200)).eq("plays", 0).order("id").limit(1);
  const neverId = cands?.[0]?.id ?? null;
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


// ── 9. THE TWO WINDOW ROWS ARE THE SAME CONTROL TWICE ─────────────────────────────────────────
console.log("\n── SIGNED UP and PLAYED are twins ──");
{
  await clearAll();
  const shape = await page.evaluate(() => {
    const row = (n) => document.querySelector(`[data-testid="finder-${n}-row"]`);
    const presets = (n) => [...(row(n)?.querySelectorAll('[data-testid^="finder-' + n + '-"]') ?? [])]
      .map((b) => b.getAttribute("data-testid")?.replace(`finder-${n}-`, ""))
      .filter((v) => v && v !== "row" && v !== "why");
    const dates = (n) => [`finder-${n}from`, `finder-${n}to`]
      .map((t) => !!document.querySelector(`[data-testid="${t}"]`));
    return { regPresets: presets("reg"), playPresets: presets("play"), regDates: dates("reg"), playDates: dates("play"),
      histLabels: [...document.querySelectorAll('[data-testid^="finder-hist-"]')].map((b) => b.textContent?.trim()) };
  });
  // ASSERTED ON THE ACTUAL CONTROL SETS, not on a screenshot.
  eq("  control — both rows rendered presets", shape.regPresets.length > 0 && shape.playPresets.length > 0, true);
  eq("both rows carry a from and a to", [shape.regDates, shape.playDates], [[true, true], [true, true]]);
  // STRUCTURALLY IDENTICAL BAR THE NEGATION: PLAYED is SIGNED UP plus `not60`, nothing else.
  const regSet = [...shape.regPresets].sort();
  const playSet = [...shape.playPresets].sort();
  const extra = playSet.filter((v) => !regSet.includes(v));
  const missing = regSet.filter((v) => !playSet.includes(v));
  eq("PLAYED adds exactly one option SIGNED UP does not have", extra, ["not60"]);
  eq("  …and drops none of them", missing, []);

  // HISTORY IS A COUNT, NOT A CLOCK. No label may carry a time word or a day count — those moved to
  // the PLAYED row where they are the general case.
  /* A COUNT IS FINE — "Played 2+" is a count of matches, which is exactly what HISTORY now is. What
   * it may not carry is a TIME word or a day count; those moved to the PLAYED row where they are
   * the general case rather than two hardcoded specials. */
  const timey = shape.histLabels.filter((l) => /\bday|\bweek|\bmonth|\byear|\d+\s*d\b|recent|lapsed|ago/i.test(l ?? ""));
  eq("HISTORY carries no time word and no day count", timey, []);
  eq("  control — the scan DOES catch one when present", /\bday/i.test("Played in 30 days"), true);
  eq("  control — HISTORY does have labels to scan", shape.histLabels.length, 4);
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

// ── 11. NEVER PLAYED DISABLES THE PLAYED ROW ──────────────────────────────────────────────────
console.log("\n── never played disables the window ──");
{
  const before = await page.evaluate(() => ({
    disabled: document.querySelector('[data-testid="finder-play-row"]')?.getAttribute("data-disabled"),
    pe: getComputedStyle(document.querySelector('[data-testid="finder-play-row"]')).pointerEvents,
    why: document.querySelectorAll('[data-testid="finder-play-why"]').length,
  }));
  // POSITIVE CONTROL, BOTH WAYS: live before, inert after, live again after Clear.
  eq("  control — the PLAYED row is live to begin with", [before.disabled, before.why], ["false", 0]);

  await apply("finder-hist-never");
  const off = await page.evaluate(() => ({
    disabled: document.querySelector('[data-testid="finder-play-row"]')?.getAttribute("data-disabled"),
    pe: getComputedStyle(document.querySelector('[data-testid="finder-play-row"]')).pointerEvents,
    why: document.querySelector('[data-testid="finder-play-why"]')?.textContent ?? "",
    btn: document.querySelector('[data-testid="finder-play-30"]')?.disabled,
  }));
  eq("History = Never played disables the PLAYED row", off.disabled, "true");
  // POINTER-EVENTS, not opacity. A dimmed row that still fires is worse than no dimming.
  eq("  …genuinely inert, not merely dimmed", off.pe, "none");
  eq("  …its buttons disabled too", off.btn, true);
  eq("  …with the reason on screen", off.why.trim(), "No play dates to filter on — History is set to Never played");

  await clearAll();
  const back = await page.evaluate(() => ({
    disabled: document.querySelector('[data-testid="finder-play-row"]')?.getAttribute("data-disabled"),
    why: document.querySelectorAll('[data-testid="finder-play-why"]').length,
  }));
  eq("Clear filters re-enables it", [back.disabled, back.why], ["false", 0]);
}

// ── 12. AN EXPLICIT RANGE OVERRIDES THE PRESET, AND CLEAR EMPTIES BOTH PAIRS ──────────────────
console.log("\n── typed ranges ──");
{
  await apply("finder-play-30");
  const from = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
  await act(() => page.fill('[data-testid="finder-playfrom"]', from));
  const ranged = await act(() => page.fill('[data-testid="finder-playto"]', to)).then(read);
  const lit = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="finder-play-"]')]
    .filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("data-testid")));
  eq("a typed play range unlights every preset", lit, []);
  // THE TILE NAMES THE RANGE, so the figure's scope is readable without inferring it from a control.
  const sub = ranged.tiles.find((t) => t.k === "Matches")?.s ?? "";
  eq(`the Matches tile names the range (${from} → ${to})`, sub.includes(from) && sub.includes(to), true);
  eq("  control — the tile is present to name anything", !!sub, true);

  await act(() => page.fill('[data-testid="finder-regfrom"]', from));
  const bothSet = await page.evaluate(() => ["finder-regfrom", "finder-playfrom", "finder-playto"]
    .map((t) => document.querySelector(`[data-testid="${t}"]`)?.value));
  eq("  control — both date pairs carry values before Clear", bothSet.every((v) => !!v), true);
  await clearAll();
  const emptied = await page.evaluate(() => ["finder-regfrom", "finder-regto", "finder-playfrom", "finder-playto"]
    .map((t) => document.querySelector(`[data-testid="${t}"]`)?.value));
  eq("Clear empties BOTH date pairs", emptied, ["", "", "", ""]);
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
