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
  return { posted: n("posted"), flagged: n("flagged"), held: n("held"), needs_look: n("needs_look"), no_film: n("no_film"), total: n("total") };
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
  const shown = await p.$eval('[data-testid="veo-date"]', (e) => e.textContent.trim());
  const expected = (() => { const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); })();
  is("the page opens on yesterday", shown, expected);
  // The nav moves one day at a time.
  await p.click('[data-testid="veo-prev"]');
  await p.waitForFunction((was) => document.querySelector('[data-testid="veo-date"]').textContent.trim() !== was, shown, { timeout: 30000 });
  const back = await p.$eval('[data-testid="veo-date"]', (e) => e.textContent.trim());
  const twoBack = (() => { const d = new Date(); d.setDate(d.getDate() - 2);
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); })();
  is("‹ moves back exactly one day", back, twoBack);

  /* ---- a real, busy day, addressed directly ----
   * The first version of this walked back with the ‹ button N times. Each click starts a fetch,
   * the clicks outran the loads, and the suite measured a page still settling on a different day —
   * it read a tally for one date against rows for another. A day view you cannot link to is also a
   * day view you cannot test deterministically. */
  await p.goto(`${BASE}/match-ops/veo?date=${DAY}`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-tally"]', { timeout: 120000 });
  await p.waitForFunction(() => !document.body.innerText.includes("Loading…"), { timeout: 180000 });
  await p.waitForTimeout(400);
  is("?date= opens that day", await p.$eval('[data-testid="veo-date"]', (e) => e.textContent.trim()),
    new Date(`${DAY}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }));

  const t = await readTally(p);
  const rows = await readRows(p);
  console.log(`     tally ${JSON.stringify(t)} · ${rows.length} rows rendered`);
  is("the five states add exactly to the total", t.posted + t.flagged + t.held + t.needs_look + t.no_film, t.total);
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
  const clickable = ["posted", "flagged", "held", "needs_look", "no_film"].find((k) => t[k] > 0);
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
    is("…and the five still add to it", ct.posted + ct.flagged + ct.held + ct.needs_look + ct.no_film, ct.total);
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
    parsedMatchDate: "2026-09-03", parsedTimeLabel: "8:00 PM", ...over,
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
  const rLook = R({ n: 4, candidateApiIds: [104], queueReason: "multiple_matches", score: 90, scoreParts: parts(40, "exact", 30, "month", 20, "ampm", 0) });
  const rUnplaced = R({ n: 6, queueReason: "unknown_code", score: 50, scoreParts: parts(0, "none", 30, "month", 20, "ampm", 0) });
  const FIX = {
    date: "2026-09-03",
    rows: [
      { ...M(101), state: "posted", recordings: [rPosted], primary: rPosted },
      { ...M(102), state: "flagged", recordings: [rFlagged], primary: rFlagged },
      { ...M(103, { codeConfirmed: false, code: "LFI" }), state: "held", recordings: [], primary: null },
      { ...M(104), state: "needs_look", recordings: [rLook], primary: rLook },
      { ...M(105), state: "no_film", recordings: [], primary: null },
    ],
    tally: { posted: 1, flagged: 1, held: 1, needs_look: 1, no_film: 1, total: 5 },
    unplaced: [rUnplaced],
    strays: {},
    codedFields: [27],
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
  yes("the constructed day has at least one of each of the five states",
    ["posted", "flagged", "held", "needs_look", "no_film"].every((k) => ft[k] >= 1), JSON.stringify(ft));
  is("…and the five add exactly to the total", ft.posted + ft.flagged + ft.held + ft.needs_look + ft.no_film, ft.total);
  is("…and the total is the rows on screen", ft.total, frows.length);
  // THE DOUBLE-COUNT. A flagged post must appear under flagged and NOT ALSO under posted.
  is("a flagged post is counted once, under Posted flagged", ft.flagged, 1);
  is("…and the Posted count holds only the unflagged one", ft.posted, 1);
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

  /* AN UNPLACED RECORDING SAYS WHY. Measured on the real 2026-07-31: two Pearland recordings were
   * hand-assigned to matches on field 22, ATHP's field_ids is [32], and the page listed neither
   * match. "Could not place" is the symptom; the code table is the cause, and the page now says so. */
  await p.unroute("**/api/veo/day**");
  await p.goto(`${BASE}/match-ops/veo?date=2026-07-31`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-row"]', { timeout: 120000 });
  await p.waitForFunction(() => !document.body.innerText.includes("Loading…"), { timeout: 120000 });
  const stray = await p.$$eval('[data-testid="veo-stray"]', (els) => els.map((e) => e.textContent.trim()));
  console.log(`     stray notes: ${JSON.stringify(stray)}`);
  yes("an unplaced POSTED recording names its match and the uncoded field",
    stray.length > 0 && stray.every((s) => /posted to match \d+/.test(s)), JSON.stringify(stray));
  yes("…and where the field is in no code, it says that is why",
    stray.some((s) => /no veo_codes row names that field/.test(s)), JSON.stringify(stray));
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

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("  XX  suite crashed:", e?.message ?? e); process.exit(2); });
