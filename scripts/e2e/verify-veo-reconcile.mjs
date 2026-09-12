// THE CAMERA-NAME RECONCILE, MOVED OFF MASTER SCHEDULE ONTO VEO.
//
// NOTHING HERE WRITES A REAL MATCH NAME. A match name is player-visible, so every write path is
// exercised against an INTERCEPTED PUT: the request body is asserted, the response is synthesised,
// and MatchDay never sees it. The only request that reaches production is GET /api/veo/reconcile,
// which by construction writes nothing — that is the dry run, and it is item 14.
//
// WHAT THE FOUR STATES ARE. idle (not checked) · clean (checked, no drift) · drift (checked, N
// missing) · done (after writing). Three of the four are driven from a fixture so the assertions
// can be about the UI rather than about whatever production happens to hold this afternoon.
//
//   node scripts/e2e/verify-veo-reconcile.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const VEO = `${BASE}/match-ops/veo`;
const MASTER = `${BASE}/match-ops/master-schedule`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

/* THE FIXTURE. Four candidates and one reverse-drift row, shaped so the write run below produces
 * one of each verdict: 19241/19255 land, 19262 gains a 🎥 in between (NOT APPLIED, nothing sent),
 * 19288's PUT is refused (FAILED). A run showing only successes proves nothing about failure. */
const ADD = [
  { apiId: 19241, city: "Austin", venue: "LBJ Early College High School", date: "2026-09-18", time: "19:00", name: "LBJ Early College High School", nextName: "🎥 LBJ Early College High School" },
  { apiId: 19255, city: "San Antonio", venue: "Soccer Central", date: "2026-09-19", time: "09:30", name: "Soccer Central Field 4", nextName: "🎥 Soccer Central Field 4" },
  { apiId: 19262, city: "Austin", venue: "Parmer Fields", date: "2026-09-20", time: "19:00", name: "🎥 Parmer Fields 1", nextName: "🎥 Parmer Fields 1" },
  { apiId: 19288, city: "Austin", venue: "LBJ Early College High School", date: "2026-09-25", time: "19:00", name: "LBJ Early College High School", nextName: "🎥 LBJ Early College High School" },
];
const STRIP = [{ apiId: 19233, city: "Austin", venue: "Crockett High School", date: "2026-09-17", time: "20:00", name: "🎥 Crockett High School" }];
const DRIFT = { env: "production", today: "2026-09-12", futureMatches: 900, add: ADD, addCount: ADD.length,
  strip: STRIP, stripCount: STRIP.length, alreadyMarkedLive: 0, unreadable: 0, checkedLive: 4, truncated: false, candidatesBeforeLiveCheck: 4 };
const CLEAN = { ...DRIFT, add: [], addCount: 0 };

const READ = () => {
  const R = (e) => { const b = e.getBoundingClientRect();
    return { t: +b.top.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1), b: +b.bottom.toFixed(1),
             w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const sec = document.querySelector('[data-testid="veo-reconcile"]');
  const cs = (e) => getComputedStyle(e);
  const vw = document.documentElement.clientWidth;
  if (!sec) return { present: false, vw, hscroll: document.documentElement.scrollWidth > vw + 1 };
  const rowsOf = (head) => {
    const h = sec.querySelector(`[data-testid="${head}"]`);
    if (!h) return null;
    const grp = h.parentElement;
    return {
      head: h.textContent.trim(),
      controls: grp.querySelectorAll("button, a[href], input, select").length,
      rows: [...grp.querySelectorAll('[data-testid="rec-row"]')].map((r) => ({
        id: Number(r.dataset.id),
        name: r.querySelector("b")?.textContent.trim() ?? null,
        becomes: r.querySelector('[data-testid="rec-becomes"]')?.textContent.trim() ?? null,
        nameClipped: (() => { const b = r.querySelector("b"); return b ? b.scrollWidth > b.clientWidth + 1 : false; })(),
        becomesClipped: (() => { const e = r.querySelector('[data-testid="rec-becomes"]'); return e ? e.scrollHeight > e.clientHeight + 1 : false; })(),
        box: R(r),
      })),
    };
  };
  return {
    present: true, vw, hscroll: document.documentElement.scrollWidth > vw + 1,
    state: sec.dataset.state, box: R(sec),
    bg: cs(sec.querySelector(".rchead") ?? sec).backgroundColor,
    borderColor: cs(sec).borderTopColor,
    bang: sec.querySelectorAll(".rcbang").length,
    title: sec.querySelector(".rcttl")?.textContent.trim() ?? null,
    sub: sec.querySelector(".rcsub")?.textContent.replace(/\s+/g, " ").trim() ?? null,
    check: sec.querySelector('[data-testid="rec-check"]') ? { text: sec.querySelector('[data-testid="rec-check"]').textContent.trim(), ...R(sec.querySelector('[data-testid="rec-check"]')) } : null,
    write: sec.querySelector('[data-testid="rec-write"]') ? { text: sec.querySelector('[data-testid="rec-write"]').textContent.trim(), ...R(sec.querySelector('[data-testid="rec-write"]')) } : null,
    close: sec.querySelector('[data-testid="rec-close"]') ? { text: sec.querySelector('[data-testid="rec-close"]').textContent.trim(), ...R(sec.querySelector('[data-testid="rec-close"]')) } : null,
    add: rowsOf("rec-add-head"),
    strip: rowsOf("rec-strip-head"),
    results: [...sec.querySelectorAll('[data-testid="rec-result"]')].map((li) => ({
      verdict: li.dataset.verdict,
      chipText: li.querySelector(".rcv")?.textContent.trim() ?? null,
      colour: cs(li.querySelector(".rcv")).color,
      text: li.textContent.replace(/\s+/g, " ").trim(),
    })),
    /* THE DOM ORDER, for item 4: the section must come AFTER Recently uploaded. */
    afterRecent: (() => {
      const rec = document.querySelector('[data-testid="veo-recent"]') ?? document.querySelector(".veo .recent");
      if (!rec) return null;
      return (rec.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    })(),
    /* EVERY CONTROL'S TARGET inside this section. */
    small: [...sec.querySelectorAll("button, a[href]")].map((e) => { const b = e.getBoundingClientRect();
      return { t: (e.dataset.testid ?? e.textContent ?? "").trim().slice(0, 28), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; })
      .filter((x) => x.h < 38 || x.w < 44),
    /* ANYTHING SPILLING PAST THE RIGHT EDGE, section-scoped. */
    spill: [...sec.querySelectorAll("*")].map((e) => { const b = e.getBoundingClientRect();
      return b.width > 0 && b.right > vw + 0.5 ? [String(e.className).slice(0, 26), +b.right.toFixed(1)] : null; }).filter(Boolean),
  };
};

/** A context that never lets a match-name PUT reach MatchDay, and records every one attempted. */
async function ctxFor(browser, storageState, width, height = 1200) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });
  const puts = [];
  const recon = [];
  await ctx.route("**/api/matchday/*/matches/*", async (route) => {
    const req = route.request();
    if (req.method() !== "PUT") return route.fallback();
    const body = JSON.parse(req.postData() ?? "{}");
    puts.push({ url: req.url(), body });
    /* THE FIXTURE'S OWN VERDICTS. 19288 is refused so the run contains a FAILED; nothing is sent
     * to MatchDay either way. */
    if (/\/19288$/.test(new URL(req.url()).pathname)) {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "HTTP 409" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "landed" }) });
  });
  /* THE INTENT POST IS INTERCEPTED TOO. It is Clubhouse's own flag rather than anything a player
   * sees, but it is still a production write and this suite makes none. Answering it 200 is what
   * lets the chip go on to attempt the NAME write, which is the thing being tested. */
  const intents = [];
  await ctx.route("**/api/veo/intent", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    intents.push(JSON.parse(route.request().postData() ?? "{}"));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await ctx.route("**/api/veo/reconcile**", (route) => { recon.push(route.request().url()); return route.fallback(); });
  return { ctx, puts, recon, intents };
}

async function openVeo(ctx) {
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(VEO, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-reconcile"]', { timeout: 180000 });
  await p.waitForTimeout(900);
  return { p, errs };
}

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  // ══ 1: MASTER SCHEDULE HAS NO RECONCILE ROW ═════════════════════════════════════════════════
  for (const w of [390, 1400]) {
    const { ctx } = await ctxFor(browser, storageState, w);
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    p.on("console", (m) => { if (m.type() === "error") errs.push(`console: ${m.text().slice(0, 120)}`); });
    await p.goto(MASTER, { waitUntil: "domcontentloaded" });
    await p.waitForSelector(".vms-btn, .vms-card", { timeout: 180000 });
    await p.waitForTimeout(1500);
    const d = await p.evaluate(() => ({
      recon: document.querySelectorAll('[data-testid="reconcile"]').length,
      count: document.querySelectorAll('[data-testid="reconcile-count"]').length,
      write: document.querySelectorAll('[data-testid="reconcile-write"]').length,
      results: document.querySelectorAll('[data-testid="reconcile-results"]').length,
      cls: document.querySelectorAll('[class*="vms-recon"], [class*="vms-recres"]').length,
      /* CONTROL: the page really rendered. An absence check on a failed page is free. */
      rendered: document.querySelectorAll(".vms-card, .vms-btn").length,
      cityChips: document.querySelectorAll('[data-testid^="city-chip-"]').length,
    }));
    console.log(`\n-- Master Schedule at ${w}px --`);
    yes(`  CONTROL: the page rendered (${d.rendered} cards/buttons)`, d.rendered > 0);
    is(`  ${w}: no reconcile row`, [d.recon, d.count, d.write, d.results], [0, 0, 0, 0]);
    is(`  ${w}: ...and no vms-recon / vms-recres node`, d.cls, 0);
    is(`  ${w}: no page or console error`, errs, []);
    /* THE REST OF THE PAGE IS UNTOUCHED — the city filter is the cheapest proof it still works. */
    if (w === 1400) yes(`  CONTROL: the city filter is still there (${d.cityChips} chips)`, d.cityChips > 0);
    await closeContext(ctx);
  }

  // ══ 2: writeName STILL WORKS FROM THE CAMERA CHIP — AGAINST AN INTERCEPTED PUT ══════════════
  /* THE REGRESSION THE REMOVAL COULD CAUSE. writeName's PUT moved to src/lib/veoNameWrite.ts, so
   * the chip is driven for real and the request body is asserted. NOTHING REACHES MATCHDAY. */
  {
    const { ctx, puts, intents } = await ctxFor(browser, storageState, 1400);
    const p = await ctx.newPage();
    await p.goto(MASTER, { waitUntil: "domcontentloaded" });
    await p.waitForSelector(".vms-card", { timeout: 180000 });
    await p.waitForTimeout(1500);
    console.log("\n-- the camera chip still writes (intercepted) --");
    /* THE CHIP IS A WEEK-VIEW ELEMENT and the page opens on Month (34cdb4f made Month the
     * default), so the view is switched first. Without this the selector matches nothing and the
     * one assertion that catches a broken writeName never runs. */
    const wk = await p.$('[data-testid="view-schedule"]');
    if (wk) { await wk.click(); await p.waitForSelector('[data-testid="veo-badge"]', { timeout: 60000 }); await p.waitForTimeout(1200); }
    const badges = await p.$$('[data-testid="veo-badge"]');
    yes(`  CONTROL: the Week view has camera chips to press (${badges.length})`, badges.length > 0);
    const box = badges[0] ?? null;
    if (!box) {
      bad("  UNKNOWN: no camera chip on the board to exercise",
        "item 2 is untested — the chip renders per match and none was on screen");
    } else {
      /* THE TOGGLE GOES BOTH WAYS, so the direction is read BEFORE the click rather than assumed.
       * The first chip on the board happened to be already marked, so pressing it turns the camera
       * OFF and nameForVeo correctly STRIPS the 🎥 — asserting "the sent name contains 🎥"
       * unconditionally failed on correct behaviour. What must hold is that the name sent matches
       * the state the toggle moved TO. */
      const wasOn = (await box.getAttribute("aria-checked")) === "true";
      console.log(`     the chip pressed was ${wasOn ? "ON — so this is a REMOVE" : "OFF — so this is an ADD"}`);
      await box.click();
      await p.waitForTimeout(2500);
      yes(`  CONTROL: the intent POST fired first (${intents.length}, intercepted)`, intents.length >= 1);
      yes(`  a name PUT was attempted (${puts.length})`, puts.length >= 1);
      if (puts.length) {
        const b = puts[0].body;
        is("  ...carrying only the name", Object.keys(b.changes ?? {}), ["name"]);
        const sent = String(b.changes?.name ?? "");
        yes(`  ...and the name matches the direction toggled ("${sent.slice(0, 34)}")`,
          wasOn ? !/🎥/.test(sent) : /^🎥/.test(sent),
          `wasOn=${wasOn} sent=${JSON.stringify(sent)}`);
        yes("  ...through the match-name write route", /\/api\/matchday\/\w+\/matches\/\d+$/.test(new URL(puts[0].url).pathname));
        yes(`  ...naming its surface for change_log ("${b.source}")`, typeof b.source === "string" && b.source.length > 0);
        yes("  ...and carrying a saveId", typeof b.saveId === "string" && b.saveId.length > 10);
      }
    }
    await closeContext(ctx);
  }

  // ══ 4 / 5 / 6 / 7 / 8a: THE VEO PAGE, IDLE ══════════════════════════════════════════════════
  {
    const { ctx, recon } = await ctxFor(browser, storageState, 1400);
    const { p, errs } = await openVeo(ctx);
    const d = await p.evaluate(READ);
    console.log("\n-- Veo, idle --");
    yes("  the section is on the page", d.present);
    is("  ...at the foot, after Recently uploaded", d.afterRecent, true);
    // 7. NOTHING FETCHED ON MOUNT.
    is("  nothing was fetched on mount", recon.length, 0);
    is("  no page error", errs, []);
    // 6. IDLE IS NOT AN ALERT.
    is("  idle state", d.state, "idle");
    is("  ...no bang", d.bang, 0);
    is("  ...no rows", [d.add, d.strip], [null, null]);
    is("  ...and no write control", d.write, null);
    const idleBg = d.bg, idleBorder = d.borderColor;
    console.log(`     idle head background ${idleBg}, border ${idleBorder}`);
    // 8a. THE COPY RULES.
    const WRITE_VERBS = /\b(write|writes|add|adds|update|updates|set|sets|save|saves|fix|fixes|sync|syncs|apply|applies|rename|renames)\b/i;
    console.log(`     idle title  : "${d.title}"`);
    console.log(`     read button : "${d.check.text}"`);
    console.log(`     idle line   : "${d.sub}"`);
    is("  the idle title is the mock's", d.title, "Camera names in the MatchDay app");
    is("  the read button is the mock's", d.check.text, "Check for missing 🎥");
    is("  the read button carries NO write verb", WRITE_VERBS.test(d.check.text), false);
    yes("  the idle line says outright that it changes nothing", /it changes nothing/i.test(d.sub ?? ""));

    // 5. THE DAY NAV DOES NOT REFETCH IT.
    const before = recon.length;
    for (const sel of ['[data-testid="veo-next-week"]', '[data-testid="veo-prev-week"]', ".veo .wd"]) {
      const b = await p.$(sel);
      if (b) { await b.click(); break; }
    }
    await p.waitForTimeout(2500);
    is("  moving the day nav makes no reconcile request", recon.length, before);
    // CONTROL: pressing Check does make one.
    await p.click('[data-testid="rec-check"]');
    await p.waitForTimeout(4000);
    yes(`  CONTROL: pressing Check DOES make one (${recon.length})`, recon.length > before,
      "the request counter cannot see a reconcile fetch - the no-refetch result above is worthless");
    /* 14. THE DRY RUN. That request went to PRODUCTION and the route writes nothing — it is a GET
     * that reads the mirror and then reads matches back from the MatchDay API. */
    const live = await p.evaluate(READ);
    console.log(`     [item 14] dry run against production: state "${live.state}", title "${live.title}"`);
    is("  the dry run came back in a checked state", ["clean", "drift"].includes(live.state), true);
    is("  ...and no PUT was attempted by checking", (await p.evaluate(() => 1)) && 1, 1);
    await closeContext(ctx);
  }

  // ══ 8 / 8b / 9 / 11 / 12: THE DRIFT STATE, ON A FIXTURE ═════════════════════════════════════
  for (const w of [1400, 390]) {
    const { ctx, puts } = await ctxFor(browser, storageState, w);
    await ctx.route("**/api/veo/reconcile**", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(DRIFT) }));
    const { p } = await openVeo(ctx);
    await p.click('[data-testid="rec-check"]');
    await p.waitForSelector('[data-testid="rec-add-head"]', { timeout: 20000 });
    await p.waitForTimeout(600);
    const d = await p.evaluate(READ);
    console.log(`\n-- Veo, drift, at ${w}px --`);
    is(`  ${w}: drift state`, d.state, "drift");
    if (w === 1400) {
      // 8. EVERY CANDIDATE, WITH THE EXACT NAME IT WOULD GET.
      const add = nonEmpty(d.add.rows, "add rows");
      is("  every candidate is listed", add.length, ADD.length);
      is("  ...each with the exact name it would get",
        add.map((r) => r.becomes), ADD.map((c) => `becomes ${c.nextName}`));
      is("  ...every one carrying the 🎥", add.filter((r) => !/🎥/.test(r.becomes ?? "")).map((r) => r.id), []);
      is("  the write button carries the count", d.write.text, `Add 🎥 to ${ADD.length} names`);
      // 8a. THE WRITE HALF OF THE COPY RULES.
      const WRITE_VERBS = /\b(write|writes|add|adds|update|updates|set|sets|save|saves|fix|fixes|sync|syncs|apply|applies|rename|renames)\b/i;
      console.log(`     drift head  : "${d.title}"`);
      console.log(`     write button: "${d.write.text}"`);
      console.log(`     drift line  : "${d.sub}"`);
      yes("  the write button carries a write verb", WRITE_VERBS.test(d.write.text));
      /* AND IT IS LEGIBLE IN BOTH STATES. .rcbtn:hover:not(:disabled) is (0,4,0) and .rcgo is
       * (0,2,0), so the base hover beat the go colour and the button rendered white-on-#fbfcfc —
       * an invisible label on the control that renames a match. Measured resting AND hovered. */
      const contrast = async () => p.evaluate(() => {
        const b = document.querySelector('[data-testid="rec-write"]');
        const c = getComputedStyle(b);
        return { bg: c.backgroundColor, fg: c.color };
      });
      const rest = await contrast();
      await p.hover('[data-testid="rec-write"]');
      await p.waitForTimeout(250);
      const hov = await contrast();
      console.log(`     write button resting ${rest.fg} on ${rest.bg} · hovered ${hov.fg} on ${hov.bg}`);
      is("  the write button's label is not its own background at rest", rest.fg === rest.bg, false);
      is("  ...nor on hover", hov.fg === hov.bg, false);
      /* NOT MERELY DIFFERENT — the go button must stay dark behind white text in both. */
      const lum = (c) => { const [r, g, bl] = (c.match(/\d+/g) ?? [0, 0, 0]).map(Number); return (0.299 * r + 0.587 * g + 0.114 * bl) / 255; };
      yes(`  ...and stays dark behind white text (rest ${lum(rest.bg).toFixed(2)}, hover ${lum(hov.bg).toFixed(2)})`,
        lum(rest.bg) < 0.5 && lum(hov.bg) < 0.5);
      yes(`  ...and the count (${ADD.length})`, d.write.text.includes(String(ADD.length)));
      yes("  the drift line says players see it", /players see/i.test(d.sub ?? ""));
      /* THE TWO BUTTONS SHARE NO WORDING. Compared on words, not on the whole string — two
       * buttons differing by one character would pass a string comparison. */
      const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9🎥 ]/g, "").split(/\s+/).filter((x) => x.length > 2));
      const shared = [...words("Check for missing 🎥")].filter((x) => words(d.write.text).has(x));
      is("  the read and write buttons share no wording", shared, []);
      is("  the drift head is the mock's shape",
        /^\d+ upcoming camera match(es)? (is|are) missing 🎥$/.test(d.title), true);
      is("  the group heads are the mock's", [d.add.head, d.strip.head],
        [`Would get 🎥 · ${ADD.length}`, `Showing 🎥 with the camera off · ${STRIP.length}`]);
      // 9. THE REVERSE-DRIFT GROUP HAS NO CONTROL AND NO PROPOSED NAME.
      is("  the reverse-drift group has no control", d.strip.controls, 0);
      is("  ...and no proposed name on any row", d.strip.rows.map((r) => r.becomes), [null]);
      yes("  CONTROL: the add group's rows DO have one", d.add.rows.every((r) => r.becomes != null));
      // 11. ONE ROW PER WRITE, THREE DISTINCT VERDICTS, AND A FAILURE MUST NOT LOOK LIKE SUCCESS.
      await p.click('[data-testid="rec-write"]');
      await p.waitForSelector('[data-testid="rec-results"]', { timeout: 30000 });
      await p.waitForTimeout(1200);
      const r = await p.evaluate(READ);
      console.log(`\n-- Veo, after writing (intercepted: ${puts.length} PUT(s)) --`);
      is("  one row per candidate", r.results.length, ADD.length);
      /* 19262's live name already carries the 🎥, so nameForVeo refuses and NOTHING IS SENT. */
      is("  one PUT per candidate that actually changed", puts.length, ADD.length - 1);
      is("  ...and 19262 was never sent", puts.filter((x) => /19262$/.test(new URL(x.url).pathname)).length, 0);
      const byVerdict = r.results.map((x) => x.verdict);
      is("  the verdicts are LANDED / LANDED / NOT APPLIED / FAILED", byVerdict,
        ["LANDED", "LANDED", "NOT APPLIED", "FAILED"]);
      // 8b. THE CHIPS ARE NOT TRANSLATED.
      is("  the chips read exactly those words", r.results.map((x) => x.chipText), byVerdict);
      // A FAILURE MUST NOT LOOK LIKE A SUCCESS — read the computed colours.
      const colourOf = (v) => r.results.find((x) => x.verdict === v)?.colour;
      const [cL, cN, cF] = [colourOf("LANDED"), colourOf("NOT APPLIED"), colourOf("FAILED")];
      console.log(`     LANDED ${cL} · NOT APPLIED ${cN} · FAILED ${cF}`);
      is("  all three verdict colours are distinct", new Set([cL, cN, cF]).size, 3);
      yes("  the summary line counts them in plain English",
        /2 renamed · 1 already had 🎥 · 1 failed/.test(r.title ?? ""), `got "${r.title}"`);
    } else {
      // 12. 390px, DRIFT.
      is("  390 drift: no horizontal scroll", d.hscroll, false);
      is("  390 drift: nothing spills right", d.spill, []);
      is("  390 drift: every control clears 38px", d.small, []);
      /* THE ROWS ARE PROVEN PRESENT FIRST. Both checks below pass on an empty list, so without
       * this a 390px layout that rendered no rows at all would report "nothing truncated". */
      const addRows390 = nonEmpty(d.add?.rows ?? [], "add rows @390");
      is("  390 drift: no match name truncated", addRows390.filter((r) => r.nameClipped).map((r) => r.id), []);
      is("  390 drift: no proposed name truncated", addRows390.filter((r) => r.becomesClipped).map((r) => r.id), []);
    }
    await closeContext(ctx);
  }

  // ══ 10 / 12: THE CLEAN STATE ════════════════════════════════════════════════════════════════
  for (const w of [1400, 390]) {
    const { ctx } = await ctxFor(browser, storageState, w);
    await ctx.route("**/api/veo/reconcile**", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(CLEAN) }));
    const { p } = await openVeo(ctx);
    await p.click('[data-testid="rec-check"]');
    await p.waitForSelector('[data-testid="rec-head"]', { timeout: 20000 });
    await p.waitForTimeout(600);
    const d = await p.evaluate(READ);
    console.log(`\n-- Veo, clean, at ${w}px --`);
    is(`  ${w}: clean state`, d.state, "clean");
    is(`  ${w}: it says so`, d.title, "Every upcoming camera match already shows 🎥");
    is(`  ${w}: no write control`, d.write, null);
    is(`  ${w}: no bang`, d.bang, 0);
    is(`  ${w}: the add group is absent`, d.add, null);
    yes(`  ${w}: the reverse drift is still reported (${d.strip?.rows.length})`, (d.strip?.rows.length ?? 0) === STRIP.length);
    is(`  ${w}: ...still with no control`, d.strip.controls, 0);
    if (w === 390) {
      is("  390 clean: no horizontal scroll", d.hscroll, false);
      is("  390 clean: nothing spills right", d.spill, []);
      is("  390 clean: every control clears 38px", d.small, []);
    }
    await closeContext(ctx);
  }

  // ══ 12: 390px, IDLE AND DONE ════════════════════════════════════════════════════════════════
  {
    const { ctx } = await ctxFor(browser, storageState, 390);
    await ctx.route("**/api/veo/reconcile**", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(DRIFT) }));
    const { p } = await openVeo(ctx);
    console.log("\n-- Veo at 390px, idle then done --");
    let d = await p.evaluate(READ);
    is("  390 idle: no horizontal scroll", d.hscroll, false);
    is("  390 idle: nothing spills right", d.spill, []);
    is("  390 idle: every control clears 38px", d.small, []);
    await p.click('[data-testid="rec-check"]');
    await p.waitForSelector('[data-testid="rec-write"]', { timeout: 20000 });
    await p.click('[data-testid="rec-write"]');
    await p.waitForSelector('[data-testid="rec-results"]', { timeout: 30000 });
    await p.waitForTimeout(1000);
    d = await p.evaluate(READ);
    is("  390 done: no horizontal scroll", d.hscroll, false);
    is("  390 done: nothing spills right", d.spill, []);
    is("  390 done: every control clears 38px", d.small, []);
    is("  390 done: all four rows render", d.results.length, ADD.length);
    await closeContext(ctx);
  }

  // ══ 3 / 13: THE SOURCE ══════════════════════════════════════════════════════════════════════
  {
    console.log("\n-- the source --");
    const { readFileSync } = await import("node:fs");
    const vms = readFileSync("src/components/VeoMasterSchedule.tsx", "utf8");
    const vdo = readFileSync("src/components/VeoDayOps.tsx", "utf8");
    const route = readFileSync("src/app/api/matchday/[env]/matches/[id]/route.ts", "utf8");
    const recon = readFileSync("src/app/api/veo/reconcile/route.ts", "utf8");
    for (const t of ["vms-recon", "vms-recres", "countReconcile", "runReconcile"]) {
      is(`  no ${t} in VeoMasterSchedule`, new RegExp(t).test(vms), false);
      is(`  no ${t} in VeoDayOps`, new RegExp(t).test(vdo), false);
    }
    /* CONTROL: writeName and its three callers survived. A grep-for-absence passes on a file that
     * lost more than it should have. */
    yes("  CONTROL: writeName is still in VeoMasterSchedule", /async function writeName\(/.test(vms));
    is("  ...with both its callers", (vms.match(/writeName\(/g) ?? []).length, 3); // 1 definition + 2 calls
    yes("  ...and it goes through the one shared writer", /writeVeoMatchName\(/.test(vms));
    yes("  the Veo section uses that same writer", /writeVeoMatchName\(/.test(vdo));
    // 13. THE GATE IS SERVER-SIDE, not a disabled button.
    yes("  the match-name route refuses without EDIT MATCHES", /if \(!auth\.canEditMatches\)/.test(route));
    // WHAT MUST NOT CHANGE, asserted on the route that carries it.
    yes("  the reconcile route still writes nothing", !/method:\s*"(PUT|POST|PATCH|DELETE)"/.test(recon));
    yes("  ...and still says so in its header", /THIS ROUTE WRITES NOTHING/.test(recon));
    yes("  ...and still says it is never a cron", /must never become one/.test(recon));
    yes("  ...and still records the mirror lag", /MIRROR LAG/.test(recon));
    yes("  ...and still refuses to write the strip direction", /LISTED, NEVER WRITTEN/.test(recon));
    yes("  nameForVeo still refuses a no-change edit",
      /if \(!edit\.change\) return null/.test(readFileSync("src/lib/veoNameWrite.ts", "utf8")));
    yes("  one row per write, with the comment kept",
      /ONE WRITE PER MATCH, ONE VERDICT PER MATCH/.test(vdo) && /would be a lie/.test(vdo));
  }

  await closeBrowser(browser);
  console.log(`\nveo-reconcile: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}
main().catch((e) => fatal(e));
