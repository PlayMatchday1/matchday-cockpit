// THE VEO DAY VIEW — what the page actually renders, measured.
//   node scripts/e2e/verify-veo-day.mjs      (needs `npm run dev` up)
//
// The arithmetic (five states partition the day, trace sums to the score) is proven exhaustively
// in scripts/veo-day-test.ts over 7,776 combinations. THIS suite asserts the things only a browser
// can answer: that the strip on screen adds up on a REAL day, that every row is a camera match,
// that a null score renders as nothing rather than a zero, that the filter narrows list and tally
// together, and that no iframe is attempted.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));

const readTally = (p) => p.evaluate(() => {
  const n = (k) => { const el = document.querySelector(`[data-testid="veo-tal-${k}"]`); return el ? Number(el.dataset.count) : null; };
  return { posted: n("posted"), flagged: n("flagged"), assigned: n("assigned"), held: n("held"), needs_look: n("needs_look"), no_film: n("no_film"), total: n("total") };
});
const readRows = (p) => p.$$eval('[data-testid="veo-row"]', (els) => els.map((e) => ({
  apiId: Number(e.dataset.apiId),
  state: e.dataset.state,
  score: e.querySelector('[data-testid="veo-row-score"]').textContent.trim(),
})));

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

  // The set of fields a camera is on, straight from the table the page claims to select on.
  const { data: codeRows } = await svc.from("veo_codes").select("code, field_ids, confirmed");
  const cameraFields = new Set(codeRows.flatMap((r) => (r.field_ids ?? []).map(Number)));
  console.log(`     ${codeRows.length} codes covering ${cameraFields.size} fields`);

  // The day with the most film activity, so the states on screen are real ones.
  const { data: recs } = await svc.from("veo_recordings").select("parsed_match_date, status").not("parsed_match_date", "is", null);
  const byDay = {};
  for (const r of recs) byDay[r.parsed_match_date] = (byDay[r.parsed_match_date] ?? 0) + 1;
  const DAY = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0][0];
  console.log(`     busiest day: ${DAY}`);

  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 },
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] } });
  const p = await ctx.newPage();
  let iframeSeen = 0;
  p.on("frameattached", () => { iframeSeen += 1; });

  // ---- the default day is yesterday ----
  await p.goto(`${BASE}/match-ops/veo`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-tally"]', { timeout: 240000 });
  await p.waitForFunction(() => !document.body.innerText.includes("Loading…"), { timeout: 120000 });
  /* SELECTOR EDITS, itemised (2026-09-11). 31281af replaced the ‹ / date label / › header with a
   * week strip, so `veo-date` and `veo-prev` no longer exist and this suite crashed on its first
   * read. The selected day is now the chip marked data-selected="1", whose testid carries the ISO
   * date; it is formatted to the same long form the label printed, so the comparisons below are
   * the same comparisons. The one-day arrow has no successor — its replacement is Prev week, so
   * that assertion now moves seven days instead of one. */
  const selectedIso = () => p.$eval('[data-testid="veo-week"] [data-selected="1"]', (e) => e.dataset.testid.replace("veo-day-", ""));
  const longForm = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const shown = longForm(await selectedIso());
  const expected = (() => { const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); })();
  is("the page opens on yesterday", shown, expected);
  // Prev week moves back seven days.
  const wasIso = await selectedIso();
  await p.click('[data-testid="veo-prev-week"]');
  await p.waitForFunction((was) => document.querySelector('[data-testid="veo-week"] [data-selected="1"]')?.dataset.testid !== `veo-day-${was}`, wasIso, { timeout: 30000 });
  const back = longForm(await selectedIso());
  const weekBack = (() => { const d = new Date(); d.setDate(d.getDate() - 8);
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); })();
  is("‹ Prev week moves back exactly seven days", back, weekBack);

  /* ---- a real, busy day, addressed directly ----
   * The first version of this walked back with the ‹ button N times. Each click starts a fetch,
   * the clicks outran the loads, and the suite measured a page still settling on a different day —
   * it read a tally for one date against rows for another. A day view you cannot link to is also a
   * day view you cannot test deterministically. */
  await p.goto(`${BASE}/match-ops/veo?date=${DAY}`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-tally"]', { timeout: 120000 });
  await p.waitForFunction(() => !document.body.innerText.includes("Loading…"), { timeout: 180000 });
  await p.waitForTimeout(400);
  is("?date= opens that day", longForm(await selectedIso()),
    new Date(`${DAY}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }));

  const t = await readTally(p);
  const rows = await readRows(p);
  console.log(`     tally ${JSON.stringify(t)} · ${rows.length} rows rendered`);
  is("the six states add exactly to the total", t.posted + t.flagged + t.assigned + t.held + t.needs_look + t.no_film, t.total);
  is("…and the total is the number of rows on screen", t.total, rows.length);

  // A flagged post is counted ONCE. Assert on the DOM: no row is both.
  const doubled = rows.filter((r) => r.state === "flagged").length;
  is("flagged rows carry the flagged state and no other", doubled, t.flagged);

  // ---- every row is a camera match, and nothing else is ----
  const { data: dayMatches } = await svc.from("mdapi_matches")
    .select("api_id, field_id").is("deleted_at", null)
    .gte("start_date", `${DAY}T00:00:00`).lte("start_date", `${DAY}T23:59:59`);
  const cameraIds = new Set(dayMatches.filter((m) => cameraFields.has(m.field_id)).map((m) => m.api_id));
  const shownIds = new Set(rows.map((r) => r.apiId));
  const notCamera = [...shownIds].filter((id) => !cameraIds.has(id));
  const missing = [...cameraIds].filter((id) => !shownIds.has(id));
  console.log(`     the day holds ${dayMatches.length} matches, ${cameraIds.size} on a camera field`);
  is("every row on the page is a match on a field some veo_codes row names", notCamera, []);
  is("…and no camera match is left off", missing, []);
  // POSITIVE CONTROL: the day really does contain non-camera matches, so the emptiness above is
  // the selector working and not a day where every match happens to be on a camera field.
  yes("control — the day contains matches the page correctly excludes", dayMatches.length > cameraIds.size,
    `${dayMatches.length} total vs ${cameraIds.size} on camera`);

  // ---- a null score renders as nothing, not a zero ----
  const zeros = rows.filter((r) => r.score === "0");
  is("no row prints a 0 score", zeros, []);
  const scored = rows.filter((r) => r.score !== "");
  console.log(`     ${scored.length} of ${rows.length} rows print a score: ${JSON.stringify(scored.map((r) => r.score))}`);
  yes("every printed score is below 100", scored.every((r) => Number(r.score) < 100), JSON.stringify(scored));

  // ---- the tally is the filter, and it moves the list with it ----
  const clickable = ["posted", "flagged", "assigned", "held", "needs_look", "no_film"].find((k) => t[k] > 0);
  if (clickable) {
    await p.click(`[data-testid="veo-tal-${clickable}"]`);
    await p.waitForTimeout(300);
    const filtered = await readRows(p);
    is(`clicking "${clickable}" narrows the list to those rows`, filtered.length, t[clickable]);
    yes("…and every remaining row is in that state", filtered.every((r) => r.state === clickable), JSON.stringify(filtered.map((r) => r.state)));
    await p.click(`[data-testid="veo-tal-${clickable}"]`);
    await p.waitForTimeout(300);
    is("clicking it again clears the filter", (await readRows(p)).length, rows.length);
  } else bad("no state on the busiest day has a row to filter by");

  // ---- the city filter narrows the list and the tally together ----
  const hasCity = await p.$('[data-testid="veo-city"]');
  if (hasCity) {
    const opts = await p.$eval('[data-testid="veo-city"]', (el) => [...el.options].map((o) => o.value).filter((v) => v !== "all"));
    await p.selectOption('[data-testid="veo-city"]', opts[0]);
    await p.waitForTimeout(300);
    const ct = await readTally(p);
    const cr = await readRows(p);
    is(`city "${opts[0]}": the tally total equals the rows shown`, ct.total, cr.length);
    is("…and the six still add to it", ct.posted + ct.flagged + ct.assigned + ct.held + ct.needs_look + ct.no_film, ct.total);
    yes("…and it is a narrowing, not the whole day", ct.total <= t.total, `${ct.total} vs ${t.total}`);
    await p.selectOption('[data-testid="veo-city"]', "all");
    await p.waitForTimeout(300);
  } else console.log("     (one city on this day — no city select rendered)");

  // ---- the viewer ----
  const withFilm = rows.find((r) => r.state === "posted" || r.state === "flagged") ?? rows[0];
  await p.click(`[data-testid="veo-row-${withFilm.apiId}"]`);
  await p.waitForSelector('[data-testid="veo-viewer"]', { timeout: 30000 });
  await p.waitForTimeout(2500); // the thumbnail is fetched when the row opens
  const v = await p.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const trace = [...document.querySelectorAll('[data-testid^="veo-trace-"]')]
      .filter((e) => e.dataset.points !== undefined)
      .map((e) => ({ label: e.querySelector("span").textContent.trim(), points: Number(e.dataset.points) }));
    return {
      iframes: document.querySelectorAll("iframe").length,
      openInVeo: q('[data-testid="veo-open-in-veo"]')?.getAttribute("href") ?? null,
      thumb: q('[data-testid="veo-thumb"]')?.getAttribute("src") ?? null,
      thumbNote: q('[data-testid="veo-thumb-none"]')?.textContent?.trim() ?? null,
      traceTotal: q('[data-testid="veo-trace"]')?.dataset.total ?? null,
      trace,
      actions: [...document.querySelectorAll('[data-testid="veo-actions"] button')].map((e) => e.textContent.trim()),
      noScore: q('[data-testid="veo-no-score"]')?.textContent?.trim() ?? null,
    };
  });
  console.log(`     viewer: ${JSON.stringify({ ...v, thumb: v.thumb ? v.thumb.slice(0, 60) + "…" : null })}`);
  is("the viewer renders no iframe", v.iframes, 0);
  is("…and none was ever attached", iframeSeen, 0);
  if (v.openInVeo) {
    yes("Open in Veo points at the recording", /^https:\/\/app\.veo\.co\//.test(v.openInVeo), v.openInVeo);
    yes("the film area shows a real still frame, not a black box",
      Boolean(v.thumb && /veocdn\.com/.test(v.thumb)), `thumb=${v.thumb} note=${v.thumbNote}`);
  }
  if (v.traceTotal) {
    is("the trace's components add to the score on the row", v.trace.reduce((a, l) => a + l.points, 0), Number(v.traceTotal));
    is("…and it is the four the matcher scores", v.trace.map((l) => l.label), ["Code", "Date", "Time", "Field"]);
  } else {
    yes("a row with no score says so instead of showing a trace", Boolean(v.noScore), JSON.stringify(v));
  }
  if (withFilm.state === "posted" || withFilm.state === "flagged") {
    yes("a posted recording is NOT offered a send button", !v.actions.some((a) => /send to the chat/i.test(a)), JSON.stringify(v.actions));
    yes("…it is offered the two that follow from having posted", v.actions.some((a) => /clear the flag/i.test(a)), JSON.stringify(v.actions));
  }

  /* ---- A DAY WITH ALL FIVE STATES, AND SCORED ROWS ----
   * No real day has one of each, and every row in veo_recordings predates 0159 so none of them
   * carries a score. The rule is that a suite must not write production to get a different world,
   * so this one is BUILT FROM A FIXTURE and served to the page by intercepting its own route. It
   * proves the rendering, which is the half only a browser can answer; the arithmetic under it is
   * proven exhaustively in scripts/veo-day-test.ts. */
  const parts = (code, codeTier, date, dateForm, time, timeForm, field) => ({
    total: code + date + time + field, band: code + date + time + field >= 100 ? "clean" : "flagged",
    code, codeTier, date, dateForm, time, timeForm, field, fieldAgrees: field > 0,
  });
  const R = (over) => ({
    id: `f${over.n}`, recordingId: `vfix${over.n}`, subject: "FIX | Sep 3 | 8pm",
    videoUrl: "https://app.veo.co/matches/fixture/", receivedAt: "2026-09-04T05:00:00Z",
    status: "queued", queueReason: null, matchedApiId: null, candidateApiIds: [],
    score: null, scoreParts: null, flagged: false, parsedCode: "FIX",
    parsedMatchDate: "2026-09-03", parsedTimeLabel: "8:00 PM",
    // The gap on every candidate line is measured from THIS, so a fixture without it prints no
    // gaps at all — which is how the first run of the assertion below came back with four "".
    parsedTimeMinutes: 1200, postedByUserId: null, ...over,
  });
  const M = (apiId, over) => ({
    apiId, name: `Fixture ${apiId}`, city: "Austin", cityCode: "ATX", venue: "Onion Creek",
    fieldId: 27, code: "OC", codeConfirmed: true, date: "2026-09-03", time: "8:00 PM",
    minutes: 1200, players: 14, capacity: 20, cancelled: false, ...over,
  });
  /* EVERY STATE AND EVERY COUNT IS WRITTEN OUT, not derived. The first version of this fixture
   * computed each row's state and then summed them — with the same rules the page uses. An
   * assertion whose expected value is produced by the logic under test passes when both are wrong
   * together, and the repo's own vacuous-assertion guard is what caught it. These are the numbers
   * a person decided the page should show. */
  const rPosted = R({ n: 1, status: "posted", matchedApiId: 101, score: 100, scoreParts: parts(40, "exact", 30, "month", 20, "ampm", 10) });
  const rFlagged = R({ n: 2, status: "posted", matchedApiId: 102, flagged: true, score: 78, scoreParts: parts(18, "label", 30, "month", 20, "ampm", 10) });
  const rAssigned = R({ n: 3, status: "posted", matchedApiId: 106, postedByUserId: "u-real-person", score: 100, scoreParts: parts(40, "exact", 30, "month", 20, "ampm", 10) });
  const rLook = R({ n: 4, candidateApiIds: [104], queueReason: "multiple_matches", score: 90, scoreParts: parts(40, "exact", 30, "month", 20, "ampm", 0) });
  const rUnplaced = R({ n: 6, queueReason: "unknown_code", candidateApiIds: [104], score: 50, scoreParts: parts(0, "none", 30, "month", 20, "ampm", 0) });
  const FIX = {
    date: "2026-09-03",
    rows: [
      { ...M(101), state: "posted", recordings: [rPosted], primary: rPosted },
      { ...M(102), state: "flagged", recordings: [rFlagged], primary: rFlagged },
      { ...M(103, { codeConfirmed: false, code: "LFI" }), state: "held", recordings: [], primary: null },
      { ...M(104), state: "needs_look", recordings: [rLook], primary: rLook },
      { ...M(105), state: "no_film", recordings: [], primary: null },
      { ...M(106), state: "assigned", recordings: [rAssigned], primary: rAssigned },
    ],
    tally: { posted: 1, flagged: 1, assigned: 1, held: 1, needs_look: 1, no_film: 1, total: 6 },
    unplaced: [rUnplaced],
    strays: {},
    codedFields: [27],
    candidates: {
      101: { apiId: 101, name: "Fixture 101", venue: "Onion Creek", city: "Austin", time: "8:00 PM", minutes: 1200, players: 14, capacity: 20, fieldId: 27, coded: true },
      104: { apiId: 104, name: "Fixture 104", venue: "Onion Creek", city: "Austin", time: "8:00 PM", minutes: 1200, players: 14, capacity: 20, fieldId: 27, coded: true },
      105: { apiId: 105, name: "Fixture 105", venue: "Onion Creek", city: "Austin", time: "9:00 PM", minutes: 1260, players: 9, capacity: 20, fieldId: 27, coded: true },
      // A candidate on a field NO code names: offered, marked, and still assignable.
      999: { apiId: 999, name: "Uncoded Pitch", venue: "Elsewhere", city: "Houston", time: "8:45 PM", minutes: 1245, players: 12, capacity: 22, fieldId: 4242, coded: false },
    },
    cities: ["Austin"],
    emojiWithoutCode: 0,
    confinedCity: null,
  };

  await p.route("**/api/veo/day**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIX) }));
  await p.goto(`${BASE}/match-ops/veo?date=2026-09-03`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-row"]', { timeout: 60000 });
  await p.waitForTimeout(300);

  const ft = await readTally(p);
  const frows = await readRows(p);
  console.log(`     fixture tally ${JSON.stringify(ft)}`);
  yes("the constructed day has at least one of each of the six states",
    ["posted", "flagged", "assigned", "held", "needs_look", "no_film"].every((k) => ft[k] >= 1), JSON.stringify(ft));
  is("…and the six add exactly to the total", ft.posted + ft.flagged + ft.assigned + ft.held + ft.needs_look + ft.no_film, ft.total);
  is("…and the total is the rows on screen", ft.total, frows.length);
  // THE DOUBLE-COUNT. A flagged post must appear under flagged and NOT ALSO under posted.
  is("a flagged post is counted once, under Posted flagged", ft.flagged, 1);
  is("…and the Posted count holds only the unflagged, AUTOMATIC one", ft.posted, 1);
  // THE SPLIT THAT MADE "posted went 16 to 15" UNREADABLE — a hand-assignment is not a post.
  is("a hand-assigned recording is counted under Assigned by hand, not Posted", ft.assigned, 1);
  const handPill = await p.$eval('[data-state="assigned"] [data-testid="veo-row-state"]', (e) => e.textContent.trim());
  is("…and its row says a person put it there", handPill, "Assigned by hand");
  const flaggedRows = frows.filter((r) => r.state === "flagged");
  is("…and exactly one ROW carries that state", flaggedRows.length, 1);
  const pill = await p.$eval('[data-state="flagged"] [data-testid="veo-row-state"]', (e) => e.textContent.trim());
  is("…labelled as a flagged post, not as a queue item", pill, "Posted, flagged");

  // A score prints only below 100; the clean one prints nothing.
  const scores = Object.fromEntries(frows.map((r) => [r.state, r.score]));
  console.log(`     fixture scores by state: ${JSON.stringify(scores)}`);
  is("the clean 100 prints no score", scores.posted, "");
  is("the flagged 78 prints its score", scores.flagged, "78");

  // The trace on screen equals score_parts from the row.
  await p.click('[data-state="flagged"] button');
  await p.waitForSelector('[data-testid="veo-trace"]', { timeout: 30000 });
  const tr = await p.evaluate(() => ({
    total: Number(document.querySelector('[data-testid="veo-trace"]').dataset.total),
    lines: [...document.querySelectorAll('[data-testid="veo-trace"] [data-points]')]
      .map((e) => ({ label: e.querySelector("span").textContent.trim(), points: Number(e.dataset.points) })),
  }));
  console.log(`     trace ${JSON.stringify(tr)}`);
  is("the trace equals score_parts on the row", tr.lines.map((l) => l.points), [18, 30, 20, 10]);
  is("…and its components add to the score", tr.lines.reduce((a, l) => a + l.points, 0), tr.total);
  is("…and the score is the one on the row", tr.total, 78);

  /* CAUSE 1, ON THE REAL DAY. ATHP named mdapi field 32; 319 of the 335 Pearland matches in 2026
   * are on field 22 ("Tourney ATH Pearland"). With only 32 named, no Pearland match had a row and
   * both Pearland recordings for 2026-07-31 sat in the orphan strip saying "no veo_codes row names
   * that field". With 22 added they are rows. */
  await p.unroute("**/api/veo/day**");
  await p.goto(`${BASE}/match-ops/veo?date=2026-07-31`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-row"]', { timeout: 120000 });
  await p.waitForFunction(() => !document.body.innerText.includes("Loading…"), { timeout: 120000 });
  const jul31 = await p.evaluate(() => ({
    strays: [...document.querySelectorAll('[data-testid="veo-stray"]')].map((e) => e.textContent.trim()),
    codes: [...document.querySelectorAll('[data-testid="veo-row"] .code')].map((e) => e.textContent.trim()),
  }));
  console.log(`     2026-07-31 row codes: ${JSON.stringify(jul31.codes)}`);
  console.log(`     remaining stray notes: ${JSON.stringify(jul31.strays)}`);
  yes("the Pearland matches now have rows of their own", jul31.codes.filter((c) => c === "ATHP").length >= 2, JSON.stringify(jul31.codes));
  is("…and no recording is left saying its field is in no code", jul31.strays.filter((s) => /no veo_codes row names that field/.test(s)), []);
  // CONTROL: the page still renders the note when it applies — proven on the fixture below, where
  // a candidate on field 4242 is marked uncoded. Without that, this emptiness proves nothing.
  await p.route("**/api/veo/day**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIX) }));
  await p.goto(`${BASE}/match-ops/veo?date=2026-09-03`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-row"]', { timeout: 60000 });

  // A row with no film reads "Find the film" — an item to do, not a disabled control.
  await p.click('[data-state="no_film"] button');
  await p.waitForSelector('[data-testid="veo-find-film"]', { timeout: 30000 });
  const find = await p.$eval('[data-testid="veo-find-film"]', (e) => ({
    text: e.textContent.trim(), color: getComputedStyle(e).color, opacity: getComputedStyle(e).opacity,
  }));
  const disabledColor = await p.evaluate(() => {
    const b = document.createElement("button"); b.className = "btn"; b.disabled = true; b.textContent = "x";
    document.querySelector(".veo").appendChild(b);
    const c = { color: getComputedStyle(b).color, opacity: getComputedStyle(b).opacity }; b.remove(); return c;
  });
  console.log(`     find-the-film ${JSON.stringify(find)} vs a disabled control ${JSON.stringify(disabledColor)}`);
  is("an unresolved review reads Find the film", find.text, "Find the film");
  yes("…and is not styled like a disabled control", find.opacity !== disabledColor.opacity || find.color !== disabledColor.color,
    `${JSON.stringify(find)} vs ${JSON.stringify(disabledColor)}`);

  /* ---- ASSIGNING BY HAND, on the fixture so nothing is written ----
   * The write itself is exercised once against production, on the real Pearland pair, and reported
   * separately. What a browser can prove here is the SHAPE: the two groups stay separate, the gap
   * is printed rather than left as arithmetic, an uncoded candidate is offered and marked, and
   * nothing is sent without a confirm that names both sides. */
  await p.goto(`${BASE}/match-ops/veo?date=2026-09-03`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-row"]', { timeout: 60000 });
  await p.click('[data-state="needs_look"] button');
  await p.waitForSelector('[data-testid="veo-actions"]', { timeout: 30000 });
  const acts = await p.$$eval('[data-testid="veo-actions"] button', (els) => els.map((e) => ({ t: e.textContent.trim(), disabled: e.disabled })));
  console.log(`     queued row actions: ${JSON.stringify(acts)}`);
  yes("a queued row offers Send to the chat, and it is LIVE", acts.some((a) => a.t === "Send to the chat" && !a.disabled), JSON.stringify(acts));
  yes("…and Different match beside it", acts.some((a) => a.t === "Different match" && !a.disabled), JSON.stringify(acts));
  yes("…and Not our film", acts.some((a) => a.t === "Not our film" && !a.disabled), JSON.stringify(acts));

  await p.click('[data-testid="veo-different-match"]');
  await p.waitForSelector('[data-testid="veo-assign-panel"]', { timeout: 30000 });
  const panel = await p.evaluate(() => {
    // [data-gap] and not just the testid prefix — "veo-cand-uncoded" is an <em> INSIDE a
    // candidate row and matched the prefix too, so the map ran over an element with no button.
    const grab = (sel) => [...document.querySelectorAll(`${sel} [data-testid^="veo-cand-"][data-gap]`)].map((e) => ({
      apiId: Number(e.dataset.testid.replace("veo-cand-", "")),
      gap: e.dataset.gap,
      uncoded: Boolean(e.querySelector('[data-testid="veo-cand-uncoded"]')),
      assignDisabled: e.querySelector("button").disabled,
    }));
    return { shortlist: grab('[data-testid="veo-shortlist"]'), rest: grab('[data-testid="veo-rest"]'),
      head: document.querySelector('[data-testid="veo-shortlist-head"]')?.textContent?.trim() ?? null };
  });
  console.log(`     assign panel: ${JSON.stringify(panel)}`);
  is("the matcher's shortlist appears FIRST and holds exactly its stored candidates", panel.shortlist.map((c) => c.apiId), [104]);
  yes("…under a heading saying it is what the matcher weighed", /could not choose/.test(panel.head ?? ""), panel.head);
  yes("…and the rest of the day is a separate group below it",
    panel.rest.length > 0 && !panel.rest.some((c) => c.apiId === 104), JSON.stringify(panel.rest));
  // THE GAP IS PRINTED, NOT LEFT AS ARITHMETIC.
  const gaps = [...panel.shortlist, ...panel.rest].map((c) => c.gap);
  console.log(`     gaps: ${JSON.stringify(gaps)}`);
  yes("every candidate prints its gap in words", gaps.every((g) => g === "exact" || /^\d+ min (earlier|later)$/.test(g)), JSON.stringify(gaps));
  yes("…and the exact one says exact", gaps.includes("exact"), JSON.stringify(gaps));
  // AN UNCODED CANDIDATE IS MARKED AND STILL ASSIGNABLE.
  const unc = [...panel.shortlist, ...panel.rest].find((c) => c.apiId === 999);
  yes("a candidate on a field no code names is offered and marked", Boolean(unc?.uncoded), JSON.stringify(unc));
  yes("…and is still assignable — the override is informed, not blocked", unc && !unc.assignDisabled, JSON.stringify(unc));

  // NOTHING IS SENT WITHOUT A CONFIRM NAMING BOTH SIDES.
  let posts = 0;
  await p.route("**/api/veo/**", (route) => {
    if (route.request().method() === "POST") { posts += 1; return route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); }
    return route.fallback();
  });
  await p.click('[data-testid="veo-cand-104"] button');
  await p.waitForSelector('[data-testid="veo-confirm"]', { timeout: 30000 });
  const confirmText = await p.$eval('[data-testid="veo-confirm"]', (e) => e.textContent.replace(/\s+/g, " ").trim());
  console.log(`     confirm: ${JSON.stringify(confirmText.slice(0, 130))}`);
  is("clicking Assign posts NOTHING until the confirm is answered", posts, 0);
  yes("the confirm names the recording", /FIX \| Sep 3 \| 8pm/.test(confirmText), confirmText);
  yes("…and the match, its time and its fill", /Fixture 104, 8:00 PM, 14 players/.test(confirmText), confirmText);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("  XX  suite crashed:", e?.message ?? e); process.exit(2); });
