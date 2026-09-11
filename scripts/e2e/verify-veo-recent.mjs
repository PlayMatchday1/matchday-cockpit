// RECENTLY UPLOADED — the Veo page's second axis.
//   node scripts/e2e/verify-veo-recent.mjs      (needs `npm run dev` up)
//
// The two clocks are proven as pure functions in scripts/veo-recent-test.ts. THIS asserts what only
// a browser and a real database can answer: that the section renders real late arrivals, that the
// day nav does not refetch it, that the filter moves the rows and the footer together, and that a
// city-confined operator sees only their own city's arrivals — tested with a confined ACCOUNT,
// not by reading the code.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
/* EVERY ABSENCE ASSERTION BELOW IS WRAPPED IN nonEmpty(), because "no row is stateless" is
 * satisfied by a page with no rows, and so is every other zero on this page. The repo's own
 * vacuous-assertion guard caught seven of them here. */
import { nonEmpty } from "./_session.mjs";
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));

const readRows = (p) => p.evaluate(() => [...document.querySelectorAll('[data-testid="veo-recent-row"]')].map((e) => ({
  state: e.dataset.state,
  when: e.querySelector(".rwhen b")?.textContent?.trim() ?? null,
  lag: e.querySelector('[data-testid="veo-recent-lag"]')?.textContent?.trim() ?? null,
  lagDays: e.querySelector('[data-testid="veo-recent-lag"]')?.dataset.days ?? null,
  lagSource: e.querySelector('[data-testid="veo-recent-lag"]')?.dataset.source ?? null,
  wait: e.querySelector('[data-testid="veo-recent-wait"]')?.textContent?.trim() ?? null,
  stateLabel: e.querySelector('[data-testid="veo-recent-state"]')?.textContent?.trim() ?? null,
  // VIEW DAY WAS REMOVED — the week strip reaches any day in one chip without leaving the page.
  // Kept as a NEGATIVE: this must now always be null, and the assertion below says so.
  dayHref: e.querySelector('[data-testid="veo-recent-day"]')?.getAttribute("href") ?? null,
  poster: Boolean(e.querySelector('[data-testid="veo-recent-poster"]')),
  assignable: Boolean(e.querySelector('[data-testid="veo-recent-assign"]')),
})));

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const H = { Authorization: `Bearer ${vv.data.session.access_token}` };
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1100 },
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] } });
  const p = await ctx.newPage();
  /* A SUITE MUST NOT WRITE PRODUCTION. This one opens Assign panels, and a panel is two clicks from
   * Post it — so every non-GET to our API is aborted and counted, and the count is asserted zero at
   * the end. The suite only ever needs to read. */
  let blockedWrites = 0;
  await p.route("**/api/**", (r) => (r.request().method() !== "GET" ? (blockedWrites++, r.abort()) : r.continue()));
  const recentCalls = [];
  p.on("request", (r) => { if (r.url().includes("/api/veo/recent")) recentCalls.push(r.url().replace(BASE, "")); });
  // Every request for a film, from the first navigation — "158 rows must not fetch 158 films".
  const filmCalls = [];
  p.on("request", (r) => { if (/\/video\.mp4(\?|$)/.test(r.url())) filmCalls.push(r.url()); });

  await p.goto(`${BASE}/match-ops/veo`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-recent"]', { timeout: 240000 });
  await p.waitForSelector('[data-testid="veo-recent-row"]', { timeout: 120000 });
  await p.waitForTimeout(500);

  const rows = await readRows(p);
  console.log(`     ${rows.length} rows rendered`);

  // ---- ordering, and THE TWO TABS, against the raw table ----
  /* REWRITTEN 2026-09-11. This compared the route's default page against the newest 30 raw rows of
   * ANY state — true until a6dae28 (09-07) split the list into Needs you / Done and made the default
   * request the Needs you tab. From then on it compared one tab against the whole table and could
   * never pass. What replaces it asserts the split itself: each tab is ordered, each holds only its
   * own states, and together they are exactly the table — nothing in both, nothing in neither. */
  const api = await (await fetch(`${BASE}/api/veo/recent?limit=30`, { headers: H, cache: "no-store" })).json();
  is("the default request is the Needs you tab", api.tab, "needs");
  const tabs = {};
  for (const t of ["needs", "done"]) {
    tabs[t] = await (await fetch(`${BASE}/api/veo/recent?tab=${t}&limit=200`, { headers: H, cache: "no-store" })).json();
    const at = tabs[t].rows.map((r) => Date.parse(r.receivedAt));
    yes(`the ${t} tab is received_at descending`, nonEmpty(at, `${t} rows`).every((v, i) => i === 0 || at[i - 1] >= v));
  }
  console.log(`     tab counts: needs ${tabs.needs.counts?.needs} · done ${tabs.needs.counts?.done} · truncated ${tabs.needs.truncated}`);
  is("Needs you holds only Queued and flagged rows", [...new Set(tabs.needs.rows.map((r) => r.state))].filter((s) => !["queued", "flagged"].includes(s)), []);
  is("Done holds only posted, assigned and dismissed rows", [...new Set(tabs.done.rows.map((r) => r.state))].filter((s) => !["posted", "assigned", "dismissed"].includes(s)), []);
  // CONTROL for the two above: each tab is non-empty, so an empty tab cannot pass them.
  yes("CONTROL: both tabs carry rows", tabs.needs.rows.length > 0 && tabs.done.rows.length > 0, `${tabs.needs.rows.length} / ${tabs.done.rows.length}`);
  const complete = tabs.needs.rows.length === tabs.needs.counts?.needs && tabs.done.rows.length === tabs.done.counts?.done && !tabs.needs.truncated;
  if (complete) {
    const { data: raw } = await svc.from("veo_recordings").select("id");
    const needIds = new Set(tabs.needs.rows.map((r) => r.id)), doneIds = new Set(tabs.done.rows.map((r) => r.id));
    is("no recording is in both tabs", [...needIds].filter((id) => doneIds.has(id)).length, 0);
    is("…and none is in neither — the two tabs are exactly the table",
      nonEmpty(raw, "raw veo_recordings").filter((r) => !needIds.has(r.id) && !doneIds.has(r.id)).length, 0);
    is("…and the counts add up to the table", tabs.needs.counts.needs + tabs.needs.counts.done, raw.length);
  } else console.log("     (a tab exceeds the 200-row page — partition not asserted)");

  // ---- every row states its arrival and its state ----
  is("no row is missing its arrival", nonEmpty(rows, "recent rows on screen").filter((r) => !r.when || r.when === "—").length, 0);
  is("no row is stateless", nonEmpty(rows, "recent rows on screen").filter((r) => !r.stateLabel).length, 0);
  const labels = [...new Set(rows.map((r) => r.stateLabel))];
  console.log(`     states on screen: ${JSON.stringify(labels)}`);
  yes("…and every label is one of the five", labels.every((l) => ["Posted", "Posted, flagged", "Assigned by hand", "Queued", "Dismissed"].includes(l)), JSON.stringify(labels));
  // ASSIGNED BY HAND IS NOT POSTED, here as at the top of the page.
  const handRows = api.rows.filter((r) => r.state === "assigned");
  const postedRows = api.rows.filter((r) => r.state === "posted");
  console.log(`     ${postedRows.length} posted automatically, ${handRows.length} assigned by hand, in this page of rows`);
  is("no row is both posted and assigned", nonEmpty(api.rows, "rows from /api/veo/recent").filter((r) => r.state === "posted" && r.state === "assigned").length, 0);
  for (const r of handRows) {
    const { data: db } = await svc.from("veo_recordings").select("posted_by_user_id").eq("id", r.id).single();
    yes(`a row marked Assigned by hand really has posted_by_user_id (${r.recordingId})`, Boolean(db.posted_by_user_id));
  }

  // ---- a real late arrival ----
  const late = api.rows.filter((r) => (r.match?.day ?? r.parsedMatchDate) && r.receivedAt)
    .map((r) => {
      const day = r.match?.day ?? r.parsedMatchDate;
      const arrivedDay = new Date(Date.parse(r.receivedAt)).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      const d = Math.round((Date.parse(`${arrivedDay}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
      return { ...r, lag: d, day, arrivedDay, source: r.match ? "match" : "title" };
    })
    .filter((r) => r.lag >= 2 && r.source === "match")
    .sort((a, b) => b.lag - a.lag);
  console.log(`     late arrivals with a real match: ${late.slice(0, 4).map((r) => `${r.subject.slice(0, 26)} +${r.lag}d`).join(" · ")}`);
  yes("a film that arrived days after its match is in the section", late.length > 0, "none found");
  if (late.length) {
    const worst = late[0];
    console.log(`     worst: "${worst.subject}" match day ${worst.day}, arrived ${worst.arrivedDay} = ${worst.lag} days`);
    const onScreen = rows.find((r) => r.lagDays === String(worst.lag));
    yes(`…and the row says so (${worst.lag} days late)`, Boolean(onScreen), JSON.stringify(rows.map((r) => r.lag)));
  }
  // Same-day and next-day stay quiet.
  const quiet = rows.filter((r) => r.lagDays !== null && Number(r.lagDays) < 2);
  is("no row prints a lag for same-day or next-day", quiet, []);
  // A title-derived day is marked as such.
  const fromTitle = rows.filter((r) => r.lagSource === "title");
  if (fromTitle.length) yes("a lag derived from the parsed title says so", fromTitle.every((r) => /from the title/.test(r.lag ?? "")), JSON.stringify(fromTitle));
  else console.log("     (no title-derived lag over 2 days on this page — not asserted)");

  // ---- the waiting clock, only where somebody must act ----
  const waiting = rows.filter((r) => r.wait);
  is("the waiting clock appears only on Queued rows", [...new Set(waiting.map((r) => r.stateLabel))].filter((l) => l !== "Queued"), []);
  yes("…and every queued row on screen carries one", nonEmpty(rows, "recent rows on screen").filter((r) => r.stateLabel === "Queued" && !r.wait).length === 0,
    JSON.stringify(rows.filter((r) => r.stateLabel === "Queued" && !r.wait)));

  // ---- links back to its own day, and Assign only where there is something to do ----
  const withDay = rows.filter((r) => r.dayHref);
  yes("no row carries a View day link any more", withDay.length === 0, JSON.stringify(withDay.slice(0, 2)));
  /* EVERY ROW CARRIES A POSTER BOX, whether or not the still frame resolved — that is the whole
   * point of the box, and a control that the rows were actually found. */
  yes("every row carries a poster box", rows.length > 0 && rows.every((r) => r.poster),
    `${rows.filter((r) => r.poster).length} of ${rows.length}`);
  is("only a Queued row offers Assign", [...new Set(nonEmpty(rows.filter((r) => r.assignable), "assignable rows").map((r) => r.stateLabel))], ["Queued"]);
  is("…and no resolved row does", nonEmpty(rows, "recent rows on screen").filter((r) => r.assignable && r.stateLabel !== "Queued").length, 0);

  // ---- A CAMERA STAMP: the row and the panel it opens agree ----
  /* "Untitled recording <stamp>" re-reads to a date and time that are not the match's (measured 30
   * of 30, docs/matchday-api-facts.md). The row used to print "reads now as UNTITLED RECORDING ·
   * Friday, September 11 · 11:00 PM" while its own panel said the title reads nothing and asked for
   * the day. Both surfaces are read off the SAME row. */
  const STAMP = /^untitled recording \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\b/i;
  const stampRow = tabs.needs.rows.find((r) => STAMP.test(r.subject ?? "") && r.state === "queued");
  const rowSel = (id) => `[data-testid="veo-recent-row"][data-recording-id="${id}"]`;
  if (stampRow && await p.locator(rowSel(stampRow.id)).count()) {
    const sentence = (await p.locator(`${rowSel(stampRow.id)} .rwhat small`).textContent()).trim();
    console.log(`     stamp row "${stampRow.subject.slice(0, 40)}": "${sentence}"`);
    is("a camera-stamp row prints no re-read sentence", await p.locator(`${rowSel(stampRow.id)} [data-testid="veo-recent-reread"]`).count(), 0);
    yes("…it says it went nowhere instead", /^went nowhere/.test(sentence), sentence);
    is("…and carries no lateness chip", await p.locator(`${rowSel(stampRow.id)} [data-testid="veo-recent-lag"]`).count(), 0);
    await p.click(`${rowSel(stampRow.id)} [data-testid="veo-recent-assign"]`);
    // PRESENCE WAIT before the panel's absence checks: the panel itself must be on screen.
    await p.waitForSelector(`${rowSel(stampRow.id)} [data-testid="veo-recent-panel"]`, { timeout: 30000 });
    is("…and its panel asks for the day, agreeing with the row", await p.locator(`${rowSel(stampRow.id)} [data-testid="veo-recent-picker"]`).count(), 1);
    await p.click(`${rowSel(stampRow.id)} [data-testid="veo-recent-assign"]`);
    await p.waitForTimeout(500);
  } else console.log("     (no queued camera-stamp row on screen — not asserted)");
  /* CONTROL: a title that genuinely carries its date and time still reads, on a row that has no
   * stored date — the rescue this guard must not take away from anybody else. */
  const rescued = await p.locator('[data-testid="veo-recent-reread"]').count();
  const rescuable = tabs.needs.rows.filter((r) => !STAMP.test(r.subject ?? "") && !r.parsedMatchDate && !r.match).length;
  console.log(`     rows showing a re-read sentence: ${rescued} · non-stamp queued rows with no stored date: ${rescuable}`);
  yes("CONTROL: titles that carry their date still show the re-read sentence", rescued > 0, `${rescued}`);

  // ---- THE TABS move the rows AND the footer together ----
  /* REWRITTEN 2026-09-11: this clicked veo-recent-unposted / veo-recent-all and requested
   * filter=unposted. All three went with the Needs you / Done split on 09-07 — the route reads only
   * `tab` now — and the suite timed out on the first click for four days. */
  const footer = () => p.$eval('[data-testid="veo-recent-count"]', (e) => e.textContent.trim());
  const needsCount = rows.length;
  const badge = (t) => p.$eval(`[data-testid="veo-recent-tab-${t}"]`, (e) => e.dataset.count);
  is("the Needs you badge is the route's own count", Number(await badge("needs")), tabs.needs.counts.needs);
  is("…and so is the Done badge", Number(await badge("done")), tabs.needs.counts.done);
  await p.click('[data-testid="veo-recent-tab-done"]');
  await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="veo-recent-row"]')].some((e) => e.dataset.tab === "done"), null, { timeout: 30000 });
  await p.waitForTimeout(800);
  const done = await readRows(p);
  const doneFoot = await footer();
  console.log(`     needs you: ${needsCount} rows   ·   done: ${done.length} rows / "${doneFoot}"`);
  is("the Done tab shows only resolved rows", [...new Set(nonEmpty(done, "done rows").map((r) => r.stateLabel))].filter((l) => l === "Queued" || l === "Posted, flagged"), []);
  is("…offers Assign on none of them", done.filter((r) => r.assignable).length, 0);
  yes("…and the footer count follows it", doneFoot.startsWith(String(done.length)), doneFoot);
  await p.click('[data-testid="veo-recent-tab-needs"]');
  await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="veo-recent-row"]')].every((e) => e.dataset.tab === "needs"), null, { timeout: 30000 });
  await p.waitForTimeout(800);
  const back = await readRows(p);
  yes("going back to Needs you restores its rows", back.length === needsCount && back.every((r) => ["Queued", "Posted, flagged"].includes(r.stateLabel)),
    `${back.length} vs ${needsCount} · ${JSON.stringify([...new Set(back.map((r) => r.stateLabel))])}`);
  const afterTabs = recentCalls.length;

  // ---- THE WEEK STRIP MUST NOT REFETCH THIS SECTION ----
  // veo-prev went with the week strip in 31281af; the strip's own controls replace it.
  const before = await p.$eval('[data-testid="veo-week"] [data-selected="1"]', (e) => e.dataset.testid);
  await p.click('[data-testid="veo-prev-week"]');
  await p.waitForTimeout(1500);
  await p.locator('[data-testid="veo-week"] [data-testid^="veo-day-"]').first().click();
  await p.waitForTimeout(1500);
  const after = await p.$eval('[data-testid="veo-week"] [data-selected="1"]', (e) => e.dataset.testid);
  yes("CONTROL: the strip really moved the day", before !== after, `${before} → ${after}`);
  is("moving the day twice fires NO further /api/veo/recent calls", recentCalls.length - afterTabs, 0);
  yes("…and the section is still rendered on the new day", (await readRows(p)).length > 0);

  // ---- PRESS THE POSTER AND THE FILM PLAYS IN THE ROW ----
  /* Ryan: "theres still no way to [watch] the recently uploaded" / "i will be able to expand the
   * size right". PRESENCE FIRST: the posters must have resolved to films before any absence below
   * means anything. */
  await p.waitForSelector('[data-testid="veo-recent-poster"][data-film="1"]', { timeout: 90000 });
  const liveIds = await p.$$eval('[data-testid="veo-recent-poster"][data-film="1"]',
    (e) => e.map((x) => x.closest('[data-testid="veo-recent-row"]').dataset.recordingId));
  yes("CONTROL: posters with a playable film are on screen", liveIds.length >= 2, `${liveIds.length}`);
  is("no <video> exists for a row nobody pressed", await p.locator('[data-testid="veo-recent-film"]').count(), 0);
  is("…and loading the list fetched no film", filmCalls.length, 0);
  const rowOf = (id) => `[data-testid="veo-recent-row"][data-recording-id="${id}"]`;
  const [one, two] = liveIds;
  const btn = await p.$eval(`${rowOf(one)} [data-testid="veo-recent-poster"]`, (e) => ({ tag: e.tagName, label: e.getAttribute("aria-label") ?? "", hidden: e.hasAttribute("aria-hidden"), tri: !!e.querySelector('[data-testid="veo-recent-play"]') }));
  const oneSubject = tabs.needs.rows.find((r) => r.id === one)?.subject ?? "";
  yes("the poster is a <button> named for its film, carrying the triangle",
    btn.tag === "BUTTON" && !btn.hidden && btn.tri && oneSubject.length > 0 && btn.label.includes(oneSubject), JSON.stringify(btn));
  const ys = () => p.evaluate((sel) => { const r = document.querySelector(sel), top = r.getBoundingClientRect().top;
    return { title: r.querySelector(".rwhat b").getBoundingClientRect().top - top,
      assign: r.querySelector('[data-testid="veo-recent-assign"]').getBoundingClientRect().top - top }; }, rowOf(one));
  const shut = await ys();
  await p.click(`${rowOf(one)} [data-testid="veo-recent-poster"]`);
  await p.waitForSelector(`${rowOf(one)} [data-testid="veo-recent-film"]`, { timeout: 20000 });
  const film = await p.$eval(`${rowOf(one)} [data-testid="veo-recent-film"]`, (v) => { const b = v.closest('[data-testid="veo-recent-poster"]').getBoundingClientRect();
    return { w: b.width, h: b.height, preload: v.getAttribute("preload"), controls: v.hasAttribute("controls"),
      list: v.getAttribute("controlslist"), noPip: v.hasAttribute("disablepictureinpicture"),
      panel: !!v.closest('[data-testid="veo-recent-row"]').querySelector('[data-testid="veo-recent-panel"]') }; });
  is("pressing it puts ONE film in the row", await p.locator('[data-testid="veo-recent-film"]').count(), 1);
  yes("…in the same box grown to 360px, still 16:9", Math.abs(film.w - 360) < 0.5 && Math.abs(film.w / film.h - 16 / 9) < 0.01, `${film.w}x${film.h}`);
  yes("…preloading nothing, with the browser's controls, and nothing suppressing fullscreen",
    film.preload === "none" && film.controls && film.list == null && !film.noPip, JSON.stringify(film));
  is("…and the press did not open Assign", film.panel, false);
  const opened = await ys();
  is("the title and Assign did not move", [Math.round((opened.title - shut.title) * 10) / 10, Math.round((opened.assign - shut.assign) * 10) / 10], [0, 0]);
  /* FULLSCREEN, ENTERED — not inferred from the attributes. A user gesture is what the browser
   * requires, and CDP's userGesture is that gesture. */
  const cdp = await ctx.newCDPSession(p);
  const fs = await cdp.send("Runtime.evaluate", { awaitPromise: true, userGesture: true,
    expression: `document.querySelector('[data-testid="veo-recent-film"]').requestFullscreen().then(() => document.fullscreenElement?.dataset.testid ?? null, (e) => "rejected: " + e.message)` });
  is("the film goes fullscreen", fs.result.value, "veo-recent-film");
  await p.evaluate(() => document.exitFullscreen?.().catch(() => {}));
  await p.waitForTimeout(600);
  await p.click(`${rowOf(two)} [data-testid="veo-recent-poster"]`);
  await p.waitForSelector(`${rowOf(two)} [data-testid="veo-recent-film"]`, { timeout: 20000 });
  is("pressing a second poster closes the first", [await p.locator('[data-testid="veo-recent-film"]').count(), await p.locator(`${rowOf(one)} [data-testid="veo-recent-film"]`).count()], [1, 0]);
  await p.click(`${rowOf(two)} [data-testid="veo-recent-close"]`);
  await p.waitForTimeout(400);
  is("Close film removes the element", await p.locator('[data-testid="veo-recent-film"]').count(), 0);

  // ---- a confined operator sees only their own city's arrivals ----
  const WAW = "jf@playmatchday.pl";
  const { data: wawRow } = await svc.from("app_users").select("city_identifier, is_admin").eq("email", WAW).maybeSingle();
  if (wawRow?.city_identifier !== "WAW" || wawRow.is_admin !== false) {
    bad("the confined account under test", JSON.stringify(wawRow));
  } else {
    const l2 = await svc.auth.admin.generateLink({ type: "magiclink", email: WAW });
    const v2 = await anon.auth.verifyOtp({ type: "magiclink", token_hash: l2.data.properties.hashed_token });
    const H2 = { Authorization: `Bearer ${v2.data.session.access_token}` };
    const w = await (await fetch(`${BASE}/api/veo/recent?limit=50`, { headers: H2, cache: "no-store" })).json();
    console.log(`     Warsaw sees ${w.rows?.length ?? "?"} arrivals; confinedCity=${w.confinedCity}`);
    is("the confined account's payload names its city", w.confinedCity, "WAW");
    const cities = [...new Set((w.rows ?? []).map((r) => r.city).filter(Boolean))];
    /* NOT wrapped in nonEmpty: Warsaw legitimately sees ZERO arrivals, because no veo_codes row
     * names a Warsaw field. The control below is what makes this assertion mean something — an
     * admin running the same query sees several cities. */
    is("…and no row belongs to another city", cities.filter((c) => c !== "Warsaw"), []);
    // CONTROL: the admin sees rows from several cities on the same query, so the emptiness above is
    // the scope working and not a route that returns nothing to anybody.
    const adminCities = [...new Set(api.rows.map((r) => r.city).filter(Boolean))];
    console.log(`     control — an admin sees ${adminCities.length} cities: ${JSON.stringify(adminCities)}`);
    yes("control — an admin sees arrivals from more than one city", adminCities.length > 1, JSON.stringify(adminCities));
    // And an unplaceable recording is for unconfined accounts only.
    const unplaceable = api.rows.filter((r) => !r.city).length;
    console.log(`     ${unplaceable} of ${api.rows.length} rows have no placeable city (unparseable titles)`);
    // Same: zero rows for Warsaw is the correct answer, and the admin control above proves the
    // route returns rows to somebody.
    is("an unplaceable recording never reaches a confined account", (w.rows ?? []).filter((r) => !r.city).length, 0);
  }

  is("nothing on this page tried to write", blockedWrites, 0);
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("  XX  suite crashed:", e?.message ?? e); process.exit(2); });
