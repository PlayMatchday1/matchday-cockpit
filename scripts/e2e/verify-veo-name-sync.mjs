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

async function boot(browser, storageState, { failNameWrite = false } = {}) {
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
    state.get(id).rawName = b.changes.name; // the name lands
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
    is("the chip renders the DERIVED unsynced state", chip.unsynced, "true");
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

  // A SYNCED chip must NOT show any of that — otherwise the marker means nothing.
  {
    const { ctx, page } = await boot(browser, storageState);
    const synced = await page.evaluate(() => ({
      mid: document.querySelector('[data-veo="9006"]')?.getAttribute("data-unsynced"),
      anyDot: !!document.querySelector('[data-veo="9006"] [data-testid="veo-unsynced-dot"]'),
      // control: the selector CAN find a dot somewhere it belongs
      controlUnsynced: document.querySelector('[data-veo="9003"]')?.getAttribute("data-unsynced"),
    }));
    is("today's 166 mid-string cameras read as SYNCED", synced.mid, "false");
    is("  …no warning dot on a synced chip", synced.anyDot, false);
    is("  control — an unsynced chip in the SAME render does carry the marker", synced.controlUnsynced, "true");
    await closeContext(ctx);
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
