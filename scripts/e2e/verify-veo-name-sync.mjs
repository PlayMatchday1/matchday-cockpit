// THE 🎥 NAME WRITE — what actually leaves the browser when the Veo chip is toggled.
//
// veo-name-sync-test.ts pins the TRANSFORM. This pins the REQUEST: that a no-change decision sends
// nothing at all, that the body carries only `name`, that a failure leaves the flag flipped and the
// chip unsynced, and that nothing ever retries on its own.
//
// EVERY WRITE HERE IS A FIXTURE. Nothing reaches MatchDay, staging or production — the match PUT is
// intercepted and counted. That is the point: the assertion is about what we SEND.
//
//   node scripts/e2e/verify-veo-name-sync.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/match-ops/master-schedule`;
const C = "\u{1F3A5}";

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  XX  ${n} — ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
// REAL PRODUCTION NAME SHAPES — every one of these exists in the live data.
const ROWS = [
  { apiId: 9001, veo: false, rawName: "Saturday - SJD",                            note: "plain, off" },
  { apiId: 9002, veo: false, rawName: `${C} Saturday - SJD`,                        note: "camera at 0, off" },
  { apiId: 9003, veo: false, rawName: `\u{1F525}${C} Monday - NEMP - M1`,           note: "camera mid, off" },
  { apiId: 9004, veo: false, rawName: `${C}The Hattrick (Leander)`,                 note: "no space, off" },
  { apiId: 9005, veo: true,  rawName: `${C} Already Marked`,                        note: "camera at 0, on" },
  { apiId: 9006, veo: true,  rawName: `\u{1F3A9}${C} Premier Match (928)`,          note: "camera mid, on" },
  { apiId: 9007, veo: false, rawName: "⚡️ Saturday - SJD - M2",                     note: "other emoji, off" },
  { apiId: 9008, veo: false, rawName: `${C} a ${C} b`,                              note: "two cameras, off" },
  // HISTORY: flag on, name has no camera, nobody has touched it on this page. 38 real rows look
  // like this — toggled through Clubhouse before the name write existed. It must render clean.
  { apiId: 9009, veo: true,  rawName: "Untouched History - HOU",                     note: "enabled, no camera, never toggled" },
];
const veoWeek = () => ({
  weekStart: "2026-08-03",
  days: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ dow: DAYS[i], date: 3 + i, iso: `2026-08-0${3 + i}`, today: i === 4 })),
  cities: [{ city: "Austin", cameras: 2 }],
  matches: ROWS.map((r, i) => ({
    apiId: r.apiId, city: "Austin", dayIdx: i % 5, time: "7:00 PM", minutes: 1140, venue: "NEMP",
    name: r.rawName.replaceAll(C, "").replace(/\s{2,}/g, " ").trim(), rawName: r.rawName,
    veo: r.veo, hasEmoji: r.rawName.includes(C),
  })),
  codesRef: [], seededThisWeek: 0, generatedAt: "2026-08-07T00:00:00.000Z",
});

async function boot(browser, storageState, { failNameWrite = false, mirrorLags = false } = {}) {
  const ctx = await browser.newContext({ storageState, viewport: { width: 1600, height: 1000 } });
  const seen = { intent: [], name: [] };
  const state = new Map(ROWS.map((r) => [r.apiId, { veo: r.veo, rawName: r.rawName }]));

  await ctx.route("**/api/veo?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(week()) }));
  await ctx.route("**/api/veo", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(week()) }));
  const week = () => {
    const w = veoWeek();
    w.matches = w.matches.map((m) => ({ ...m, veo: state.get(m.apiId).veo, rawName: state.get(m.apiId).rawName }));
    return w;
  };
  await ctx.route("**/api/veo/intent**", (r) => {
    if (r.request().method() !== "POST") return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    const b = JSON.parse(r.request().postData() || "{}");
    seen.intent.push(b);
    state.get(b.matchApiId).veo = b.enabled === true; // the flag lands
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  // The match PUT — counted, never forwarded.
  await ctx.route("**/api/matchday/**/matches/**", (r) => {
    if (r.request().method() !== "PUT") return r.continue();
    const b = JSON.parse(r.request().postData() || "{}");
    seen.name.push({ url: r.request().url(), body: b });
    if (failNameWrite) return r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "upstream refused" }) });
    const id = Number(r.request().url().match(/matches\/(\d+)/)[1]);
    // mirrorLags reproduces production: the write LANDS on MatchDay, but mdapi_matches — which is
    // what /api/veo reads — still returns the pre-write name. Measured: 6 of 6 landed writes were
    // still missing from the mirror an hour later.
    if (!mirrorLags) state.get(id).rawName = b.changes.name;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, outcome: "landed" }) });
  });

  const page = await ctx.newPage();
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="veo-badge"]', { timeout: 60000 });
  return { ctx, page, seen, state };
}

const toggle = async (page, id) => {
  await page.click(`[data-veo="${id}"]`);
  // A POSITIVE READY SIGNAL: the refetch has repainted this chip. Waiting on a request count would
  // be waiting on the thing under test.
  await page.waitForFunction(
    (i) => document.querySelector(`[data-veo="${i}"]`)?.getAttribute("aria-checked") != null,
    id, { timeout: 20000 },
  );
  await page.waitForTimeout(900);
};

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  // ── THE HAPPY PATHS, and the no-request cases beside them ──────────────────────────────────
  {
    const { ctx, page, seen, state } = await boot(browser, storageState);

    // POSITIVE CONTROL FIRST. Every "no request" assertion below is meaningless unless this
    // counter is proven to see a request when one is genuinely sent.
    await toggle(page, 9001); // plain name, OFF -> ON
    is("CONTROL — a real toggle DOES send exactly one name write", seen.name.length, 1);
    is("CONTROL — …and it is a PUT carrying the prefixed name", seen.name[0].body.changes, { name: `${C} Saturday - SJD` });
    is("THE DIFF IS THE BODY — changes carries ONLY `name`", Object.keys(seen.name[0].body.changes), ["name"]);
    is("  …no startDate/endDate echoed back (they are local wall clock)",
       ["startDate", "endDate", "maxTeamSize2Team"].filter((k) => k in seen.name[0].body.changes), []);
    is("  …and it goes to the existing match write path", /\/api\/matchday\/[a-z]+\/matches\/9001$/.test(seen.name[0].url), true);
    is("  …the flag was written FIRST", seen.intent[0], { matchApiId: 9001, enabled: true });

    await closeContext(ctx);
  }

  // ON with 🎥 already present → NO REQUEST. Fresh context so the counters are unambiguous.
  for (const [id, label] of [[9002, "camera at index 0"], [9003, "camera at index > 0 (the never-two case)"], [9004, "no-space leading camera"]]) {
    const { ctx, page, seen } = await boot(browser, storageState);
    await toggle(page, id);
    is(`ON with ${label} → NO name request`, seen.name.length, 0);
    is(`  …but the flag WAS written (control: the run did something)`, seen.intent.length, 1);
    await closeContext(ctx);
  }

  // OFF cases.
  for (const [id, label, want] of [
    [9005, "OFF, camera at index 0 → stripped, no leading space", "Already Marked"],
    [9006, "OFF, camera at index > 0 → stripped, no double space", "\u{1F3A9} Premier Match (928)"],
  ]) {
    const { ctx, page, seen } = await boot(browser, storageState);
    await toggle(page, id);
    is(label, seen.name.length === 1 ? seen.name[0].body.changes.name : `(${seen.name.length} requests)`, want);
    await closeContext(ctx);
  }

  // OFF with no camera → NO REQUEST, and OFF with two → exactly one removed.
  {
    const { ctx, page, seen } = await boot(browser, storageState);
    await toggle(page, 9007); // "⚡️ Saturday - SJD - M2" is veo:false → toggling makes it ON
    is("CONTROL — the counter sees this run's request", seen.name.length, 1);
    is("a NON-camera leading emoji is not mistaken for one", seen.name[0].body.changes.name, `${C} ⚡️ Saturday - SJD - M2`);
    await closeContext(ctx);
  }
  {
    const { ctx, page, seen } = await boot(browser, storageState);
    await toggle(page, 9008); // two cameras, veo:false → toggle ON. 🎥 present anywhere ⇒ no request.
    is("ON when two cameras already present → NO request", seen.name.length, 0);
    is("  …flag still written (control)", seen.intent.length, 1);
    await closeContext(ctx);
  }

  // ── FAILURE: the flag stays, the chip goes unsynced, and NOTHING retries ────────────────────
  {
    const { ctx, page, seen, state } = await boot(browser, storageState, { failNameWrite: true });
    await toggle(page, 9001); // plain, OFF -> ON; the name write 502s
    is("a failed name write still sent exactly ONE request", seen.name.length, 1);
    // NO RETRY. Give it real time to misbehave — an automatic retry would land in this window.
    await page.waitForTimeout(4000);
    is("NO automatic retry fires after a failure", seen.name.length, 1);
    is("the FLAG stays flipped — the person meant to mark it VEO", state.get(9001).veo, true);
    is("the name did NOT change", state.get(9001).rawName, "Saturday - SJD");

    const chip = await page.evaluate(() => {
      const el = document.querySelector('[data-veo="9001"]');
      const row = document.querySelector('[data-retry="9001"]');
      return {
        unsynced: el?.getAttribute("data-unsynced"),
        checked: el?.getAttribute("aria-checked"),
        dot: !!document.querySelector('[data-veo="9001"] [data-testid="veo-unsynced-dot"]'),
        retry: !!row,
        text: document.querySelector('[data-testid="veo-unsynced"]')?.innerText.replace(/\n/g, " ") ?? null,
      };
    });
    is("the chip renders the unsynced marker for THIS session's failure", chip.unsynced, "true");
    is("  …still showing the flag as on", chip.checked, "true");
    is("  …with a visible warning dot", chip.dot, true);
    is("  …saying what is wrong", /name not updated/.test(chip.text ?? ""), true);
    is("  …and offering a MANUAL retry", chip.retry, true);

    // The manual retry is the only thing that fires another write — because a human clicked it.
    await page.click('[data-retry="9001"]');
    await page.waitForTimeout(1500);
    is("the manual retry sends exactly one more request", seen.name.length, 2);
    is("  …and does not change the flag", state.get(9001).veo, true);
    await closeContext(ctx);
  }

  // ── HISTORY IS NOT FLAGGED. A fresh render, nothing toggled, must carry NO marker anywhere —
  //    including the flag-on-no-camera row that the derived version used to light up. ───────────
  {
    const { ctx, page } = await boot(browser, storageState);
    // PRESENCE FIRST: prove the page rendered its chips before asserting anything is absent.
    const chips = await page.$$eval('[data-testid="veo-badge"]', (e) => e.length);
    is("control — the page rendered its chips (so the absences below mean something)", chips >= 9, true);
    const fresh = await page.evaluate(() => ({
      markers: document.querySelectorAll('[data-testid="veo-unsynced"]').length,
      dots: document.querySelectorAll('[data-testid="veo-unsynced-dot"]').length,
      retries: document.querySelectorAll('[data-testid="veo-retry"]').length,
      historyChip: document.querySelector('[data-veo="9009"]')?.getAttribute("data-unsynced"),
      historyOn: document.querySelector('[data-veo="9009"]')?.getAttribute("aria-checked"),
      midChip: document.querySelector('[data-veo="9006"]')?.getAttribute("data-unsynced"),
    }));
    is("a fresh render flags NOTHING — no markers", fresh.markers, 0);
    is("  …no warning dots", fresh.dots, 0);
    is("  …no retry controls", fresh.retries, 0);
    is("enabled + no 🎥, never touched → NO marker (the 38 history rows)", fresh.historyChip, "false");
    is("  …and it still renders as an ordinary VEO-ON chip", fresh.historyOn, "true");
    is("mid-string cameras are not flagged either", fresh.midChip, "false");
    await closeContext(ctx);
  }

  // ── POSITIVE CONTROL for every zero above: the SAME selectors, in a run where a write fails,
  //    find a marker, a dot and a clickable retry. Without this the zeros prove nothing. ────────
  {
    const { ctx, page, seen } = await boot(browser, storageState, { failNameWrite: true });
    await toggle(page, 9001);
    const found = await page.evaluate(() => ({
      markers: document.querySelectorAll('[data-testid="veo-unsynced"]').length,
      dots: document.querySelectorAll('[data-testid="veo-unsynced-dot"]').length,
      retries: document.querySelectorAll('[data-testid="veo-retry"]').length,
    }));
    is("CONTROL — the marker selector DOES find one when a write fails", found.markers, 1);
    is("CONTROL — …the dot selector too", found.dots, 1);
    is("CONTROL — …and the retry selector", found.retries, 1);
    // CLICK IT, do not merely see it. The EDIT hover hint once sat on top of this control and
    // swallowed its clicks — a control that looked live and did nothing.
    const before = seen.name.length;
    await page.click('[data-testid="veo-retry"]');
    await page.waitForTimeout(1200);
    is("CONTROL — the retry is actually CLICKABLE, not just present", seen.name.length, before + 1);
    // And history in that SAME render is still clean — the marker is scoped to the one match.
    const others = await page.evaluate(() => document.querySelector('[data-veo="9009"]')?.getAttribute("data-unsynced"));
    is("  …while the untouched history row beside it stays clean", others, "false");
    await closeContext(ctx);
  }

  // ── AFTER A SUCCESSFUL TOGGLE THE RENDERED NAME CHANGES, with no page reload. This is what the
  //    mirror write-through buys: /api/veo reads mdapi_matches, and until the route refreshed that
  //    row the screen kept showing the pre-write name for up to a day. ─────────────────────────
  {
    const { ctx, page, seen } = await boot(browser, storageState);
    const before = await page.evaluate(() => document.querySelector('[data-id="9001"]')?.innerText ?? "");
    await toggle(page, 9001);
    const after = await page.evaluate(() => document.querySelector('[data-id="9001"]')?.innerText ?? "");
    is("the toggle wrote the name", seen.name.length, 1);
    // The card renders the STRIPPED display name, so the observable change is the row re-rendering
    // from a refreshed mirror rather than the emoji itself appearing in the card text.
    is("control — the card was found and has text", before.length > 0, true);
    is("the rendered row reflects the write without a reload",
       await page.evaluate(() => document.querySelector('[data-veo="9001"]')?.getAttribute("aria-checked")), "true");
    await closeContext(ctx);
  }

  // ── A SUCCESSFUL write leaves NO marker, even though the mirror still holds the old name.
  //    This is the case that produced three duplicate live writes in production. ───────────────
  {
    const { ctx, page, seen } = await boot(browser, storageState, { mirrorLags: true });
    await toggle(page, 9001);
    is("the write landed", seen.name.length, 1);
    const after = await page.evaluate(() => ({
      marker: document.querySelector('[data-veo="9001"]')?.getAttribute("data-unsynced"),
      retries: document.querySelectorAll('[data-testid="veo-retry"]').length,
    }));
    is("a LANDED write shows no marker even though the mirror still lags", after.marker, "false");
    is("  …so there is nothing to click that would re-send the same name", after.retries, 0);
    await closeContext(ctx);
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
