// GENERAL PUSHES ON THE PAGE, AND A PUSH BLOCK THAT DOES NOT SQUEEZE THE MESSAGE.
//
// Teresa, twice: general pushes "don't show up anywhere" after saving, and in the push editor "the
// message box is tiny and it's behind the X". Both were true.
//
//   • The generals SAVED. `week.generals` reached the page and was read in exactly three places, all
//     of them questions about a MATCH tile's coverage. Nothing rendered a general push as a push.
//   • And one of them could not be read at all: `push_at` is nullable, the range filter compared
//     `NULL >= x` and `NULL <= y`, and both are NULL — so live row 135, an undated Atlanta city push,
//     was invisible in every week of the year. There was no week you could open to give it a time.
//   • The editor row was a four-column grid [time | 8h before | message | ✕]. The message was the
//     column that gave.
//
// NOTHING IS WRITTEN. GET is rewritten from the live response and POST is answered from an in-memory
// store, so every create, edit, delete and re-read round-trips without match_promotion_push seeing a
// write. Same harness as verify-push-plan.mjs, for the same reason.
//
//   node scripts/e2e/verify-promo-generals.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/match-ops/match-promotion`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok    ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX    ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));
const head = (s) => console.log(`\n-- ${s} --`);
const txt = async (p, s) => (await p.locator(s).first().textContent())?.replace(/\s+/g, " ").trim() ?? null;

/* ── THE FIXTURE ──────────────────────────────────────────────────────────────────────────────
 * FOUR GENERAL PUSHES IN ONE CITY, mirroring the four live non-match rows including the undated one,
 * plus a SECOND CITY WITH NONE, which is the control for "the section is hidden when empty". */
const CITY = "Atlanta";
let seq = 400;
const gen = (o) => ({
  id: ++seq, scope: "city", channel: "wa", pushAt: null, topic: null, promoCode: null,
  pushedAt: null, pushedBy: null, city: CITY, fieldId: null, audience: null, ...o,
});

function makeStore() { return { generals: [], pushes: [], writes: [], matchApiId: null, fieldId: null, day: null }; }

async function boot(browser, storageState, { store, width = 1280 }) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: 1000 }, timezoneId: "America/Chicago" });

  await ctx.route("**/api/match-promotion**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      const res = await route.fetch({ timeout: 180000 });  // dev compile + a real Supabase week
      const j = await res.json().catch(() => null);
      if (!j || !Array.isArray(j.matches) || j.matches.length === 0) return route.fulfill({ response: res });
      /* EVERY MATCH EMPTIED, then one subject given a city, a field and a plan — so the counts on
       * screen are arithmetic this suite predicts rather than whatever the board holds today. */
      for (const m of j.matches) { m.plan = null; m.state = "none"; m.city = "Austin"; }
      const m0 = j.matches[0];
      m0.city = CITY;
      m0.fieldId = m0.fieldId ?? 1717;
      m0.venue = "Keswick Park (Chamblee)";
      store.matchApiId = m0.apiId; store.fieldId = m0.fieldId;
      store.day = j.days[2].iso;             // a Wednesday inside the displayed week
      m0.plan = {
        matchApiId: m0.apiId,
        pushes: store.pushes.map((r) => ({ ...r, matchApiId: m0.apiId })),
        comment: null, updatedBy: null, updatedAt: null,
      };
      m0.state = store.pushes.length === 0 ? "none" : store.pushes.some((r) => r.pushAt) ? "planned" : "needs-decision";
      /* THE READ IS WHAT CHANGED, SO THE FIXTURE MIRRORS THE NEW RULE: rows in this week, plus every
       * undated one. An undated row reaching the page at all IS the fix. */
      j.generals = store.generals.map((g) => ({ ...g }));
      if (process.env.DEBUG_GEN) console.log(`    [GET] serving ${j.generals.length} generals: ${JSON.stringify(j.generals.map((g) => [g.id, g.pushAt]))}`);
      j.planTableReady = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    }
    if (req.method() !== "POST") return route.fallback();
    const body = JSON.parse(req.postData() || "{}");
    store.writes.push(body);

    if (body.general) {
      const g = body.general;
      if (process.env.DEBUG_GEN) console.log(`    [POST general] ${JSON.stringify(g)}`);
      if (g.remove) {
        store.generals = store.generals.filter((x) => x.id !== Number(g.id));
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "LANDED", removed: Number(g.id) }) });
      }
      /* THE ROUTE'S OWN RULES, MIRRORED: a blank time is NULL, a code is upper-cased, a blank topic
       * is NULL. A fixture kinder than production tests the fixture. */
      const at = typeof g.at === "string" && g.at.trim() !== "" ? new Date(g.at).toISOString() : null;
      const row = {
        scope: g.scope === "field" ? "field" : "city", channel: g.channel, pushAt: at,
        topic: (g.topic ?? "").trim() || null, promoCode: ((g.promoCode ?? "").trim() || null)?.toUpperCase() ?? null,
        pushedAt: null, pushedBy: null, city: g.city, fieldId: g.scope === "field" ? Number(g.fieldId) : null,
        audience: (g.audience ?? "").trim() || null,
      };
      const existing = store.generals.find((x) => x.id === Number(g.id));
      if (existing) Object.assign(existing, row);
      else store.generals.push({ id: ++seq, ...row });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "LANDED", id: existing?.id ?? seq }) });
    }

    if (!Array.isArray(body.pushes)) {
      return route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ outcome: "FAILED", error: "This page is out of date. Reload it and make the change again. Nothing was written." }) });
    }
    const keep = new Set();
    for (const p of body.pushes) {
      if (p.id) {
        const row = store.pushes.find((r) => r.id === p.id);
        if (row) { row.channel = p.channel; row.pushAt = p.at; row.topic = p.topic || null; row.promoCode = p.promoCode || null; keep.add(row.id); }
      } else {
        const row = { id: ++seq, channel: p.channel, pushAt: p.at, topic: p.topic || null, promoCode: p.promoCode || null, pushedAt: null, pushedBy: null };
        store.pushes.push(row); keep.add(row.id);
      }
    }
    store.pushes = store.pushes.filter((r) => keep.has(r.id));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "LANDED" }) });
  });

  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await p.waitForSelector('[data-testid="city-block"]', { timeout: 120000 });
  await p.waitForTimeout(1200);
  return { ctx, p, errs };
}

const cityBlock = (city) => `[data-testid="city-block"]:has(h2:text-is("${city}"))`;
const section = (city) => `[data-testid="general-pushes"][data-city="${city}"]`;

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  // ══ FIX 1. THE CITY'S GENERAL PUSHES ARE ON THE PAGE ══════════════════════════════════════
  {
    head("Fix 1 · a section per city, with the undated push in it");
    const store = makeStore();
    const { ctx, p, errs } = await boot(browser, storageState, { store });
    /* THE DATES ARE STAMPED AFTER THE FIRST READ, from the week the page actually chose — the suite
     * must not pin a week. Seed undated + field rows now, and the dated one on the second pass. */
    store.generals = [
      gen({ id: 501, topic: "Weekend slate", pushAt: null, audience: `all registered in ${CITY}` }),
      gen({ id: 502, scope: "field", channel: "klaviyo_sms", topic: "Field slate", promoCode: "SLATE10SMS",
            fieldId: null, audience: "Keswick Park list" }),
      gen({ id: 503, topic: null, channel: "wa", audience: `all registered in ${CITY}` }),
    ];
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="city-block"]', { timeout: 120000 });
    await p.waitForTimeout(1200);
    /* THE FIELD ROW NEEDS THE SUBJECT'S REAL FIELD ID, and the two dated rows need a real day inside
     * the week the page chose. EXACTLY ONE ROW STAYS UNDATED (501), which is what makes the undated
     * count below a claim about one card rather than about "whatever I forgot to date". */
    store.generals[1].fieldId = store.fieldId;
    store.generals[1].pushAt = new Date(`${store.day}T16:00:00Z`).toISOString();
    store.generals[2].pushAt = new Date(`${store.day}T15:00:00Z`).toISOString();
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="city-block"]', { timeout: 120000 });
    await p.waitForTimeout(1200);

    yes("no page errors", errs.length === 0, errs[0] ?? "");
    // PRESENCE FIRST. Every absence and count below is worthless until the grid is proven rendered.
    const blocks = nonEmpty(await p.$$('[data-testid="city-block"]'), "city blocks on the page");
    ok(`PRESENCE CONTROL: ${blocks.length} city blocks rendered`);
    yes(`${CITY} has a general-pushes section`, (await p.locator(section(CITY)).count()) === 1);
    is("its count is the city's general pushes", await txt(p, `${section(CITY)} [data-testid="general-push-count"]`), "3");
    is("  and the count matches the cards rendered",
       await p.locator(`${section(CITY)} [data-testid="general-push-card"]`).count(), 3);

    // THE SECTION IS HIDDEN WHEN EMPTY — with the line above as the positive control that the
    // selector finds a section where one exists, so this zero is an absence and not a bad selector.
    const other = (await p.locator('[data-testid="city-block"] h2').allTextContents()).find((c) => c.trim() !== CITY);
    yes(`CONTROL: another city exists to be empty (${other})`, typeof other === "string" && other.trim().length > 0);
    is(`${other} has no section at all`, await p.locator(section(other.trim())).count(), 0);

    // THE UNDATED ONE. It is on the page at all — that is the read fix — and it says what is wrong.
    const undated = `${section(CITY)} [data-testid="general-push-card"][data-dated="0"]`;
    is("the UNDATED push is on the page", await p.locator(undated).count(), 1);
    is("  and reads 'No send time' where the time would be", await txt(p, `${undated} [data-testid="general-push-when"]`), "No send time");
    is("  marked as a warning, not as a blank", await p.locator(`${undated} [data-testid="general-push-when"]`).getAttribute("data-warn"), "1");
    is("  with a status that does not claim it is scheduled", await txt(p, `${undated} [data-testid="general-push-status"]`), "NO DATE");
    // CONTROL: a DATED card prints a day and a time in the same slot, so the warning is a difference.
    const dated = `${section(CITY)} [data-testid="general-push-card"][data-dated="1"]`;
    const datedWhen = await txt(p, `${dated} [data-testid="general-push-when"]`);
    yes(`CONTROL: a dated card prints a day and a time there instead (${datedWhen})`,
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2} (AM|PM)$/.test(datedWhen ?? ""));

    // THE CARD'S OWN FACTS.
    is("a push with no topic falls back to its audience",
       await txt(p, `${section(CITY)} [data-testid="general-push-card"][data-id="503"] [data-testid="general-push-title"]`),
       `all registered in ${CITY}SCHEDULED`);   // title and status are adjacent elements
    const fieldCard = `${section(CITY)} [data-testid="general-push-card"][data-scope="field"]`;
    is("a FIELD push sits in its city's section", await p.locator(fieldCard).count(), 1);
    is("  carrying the field's name", await txt(p, `${fieldCard} [data-testid="general-push-field"]`), "· Keswick Park (Chamblee)");
    is("  and its promo code", await txt(p, `${fieldCard} [data-testid="general-push-code"]`), "SLATE10SMS");
    is("CONTROL: a push with no code has no code chip",
       await p.locator(`${section(CITY)} [data-testid="general-push-card"][data-id="501"] [data-testid="general-push-code"]`).count(), 0);

    // THE SECTION SITS BETWEEN THE CITY HEADER AND THE WEEK GRID.
    const order = await p.locator(cityBlock(CITY)).evaluate((el) => {
      const kids = [...el.children];
      const i = kids.findIndex((k) => k.querySelector('h2'));
      const s = kids.findIndex((k) => k.matches('[data-testid="general-pushes"]'));
      const g = kids.findIndex((k) => k.querySelector('[data-testid="day-cell"]'));
      return { header: i, section: s, grid: g };
    });
    yes(`between the header and the grid (${JSON.stringify(order)})`,
        order.header >= 0 && order.section > order.header && order.grid > order.section);

    // CLICKING A CARD OPENS IT, PRE-FILLED, AND THE TIME CAN BE SET — no reload anywhere.
    head("Fix 1 · the card is the way in, and the section updates without a reload");
    await p.locator(undated).click();
    await p.waitForSelector('[data-testid="general-sheet"]', { timeout: 15000 });
    is("the sheet says it is editing", await txt(p, '[data-testid="gen-heading"]'), `Edit general push · ${CITY}`);
    is("  pre-filled with its topic", await p.locator('[data-testid="gen-topic"]').inputValue(), "Weekend slate");
    is("  pre-filled with its audience", await p.locator('[data-testid="gen-audience"]').inputValue(), `all registered in ${CITY}`);
    is("  and an empty time, which is the thing to fix", await p.locator('[data-testid="gen-at"]').inputValue(), "");
    yes("  it offers a Delete, because there is now a row to delete", (await p.locator('[data-testid="gen-remove"]').count()) === 1);
    await p.locator('[data-testid="gen-at"]').fill(`${store.day}T11:00`);
    await p.locator('[data-testid="gen-save"]').click();
    await p.waitForSelector('[data-testid="general-sheet"]', { state: "detached", timeout: 20000 });
    is("the store now holds the time", store.generals.find((g) => g.id === 501)?.pushAt !== null, true);
    /* WAIT FOR THE PAGE TO SAY SO, NOT FOR A CLOCK. The re-read is a real Supabase week and takes
     * seconds; a flat sleep passed this locally and failed under load, which is the whole reason
     * the rule against flat sleeps exists. If the section never updates this times out and fails. */
    const gone = await p.waitForFunction((sel) => document.querySelectorAll(sel).length === 0, undated, { timeout: 90000 })
      .then(() => true).catch(() => false);
    yes("and NO card is undated any more, without a reload", gone, `still ${await p.locator(undated).count()}`);
    is("  the card that was undated now prints a time",
       await txt(p, `${section(CITY)} [data-testid="general-push-card"][data-id="501"] [data-testid="general-push-when"]`), "Wed 11:00 AM");
    is("  and the count is unchanged", await txt(p, `${section(CITY)} [data-testid="general-push-count"]`), "3");

    // DELETE, which nothing on the page could reach before.
    await p.locator(`${section(CITY)} [data-testid="general-push-card"][data-id="501"]`).click();
    await p.waitForSelector('[data-testid="general-sheet"]', { timeout: 15000 });
    await p.locator('[data-testid="gen-remove"]').click();
    await p.waitForSelector('[data-testid="general-sheet"]', { state: "detached", timeout: 20000 });
    const dropped = await p.waitForFunction((sel) => document.querySelectorAll(sel).length === 2,
      `${section(CITY)} [data-testid="general-push-card"]`, { timeout: 90000 }).then(() => true).catch(() => false);
    yes("a card can be deleted", dropped, `${await p.locator(`${section(CITY)} [data-testid="general-push-card"]`).count()} cards left`);
    is("  and the count follows it down", await txt(p, `${section(CITY)} [data-testid="general-push-count"]`), "2");

    await closeContext(ctx);
  }

  // ══ FIX 2 + FIX 3. THE PUSH BLOCK ═════════════════════════════════════════════════════════
  {
    head("Fix 2 · a push is a stacked block, and the message has the full width");
    const store = makeStore();
    const { ctx, p, errs } = await boot(browser, storageState, { store });
    store.pushes = [
      { id: 601, channel: "wa", pushAt: "2026-09-24T17:00:00.000Z", topic: "Thursday slate", promoCode: "PARMER10", pushedAt: null, pushedBy: null },
      { id: 602, channel: "wa", pushAt: "2026-09-26T17:00:00.000Z", topic: "", promoCode: "", pushedAt: null, pushedBy: null },
    ];
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="city-block"]', { timeout: 120000 });
    await p.waitForTimeout(1200);
    yes("no page errors", errs.length === 0, errs[0] ?? "");

    await p.locator(`[data-testid="match-tile"][data-api-id="${store.matchApiId}"]`).first().click();
    await p.waitForSelector('[data-testid="push-editor"]', { timeout: 20000 });
    await p.waitForTimeout(600);

    const C = '[data-testid="chan"][data-key="wa"]';
    const pushes = nonEmpty(await p.$$(`${C} [data-testid="push"]`), "WhatsApp push blocks");
    ok(`PRESENCE CONTROL: ${pushes.length} push blocks in the editor`);
    is("both pushes are there", pushes.length, 2);

    // THE MESSAGE IS A TEXTAREA NOW, NOT A ONE-LINE INPUT.
    const tag = await p.locator(`${C} [data-testid="push"] >> nth=0 >> [data-testid="topic"]`).evaluate((e) => e.tagName);
    is("the message is a textarea", tag, "TEXTAREA");

    const box = async (sel) => p.locator(sel).first().boundingBox();
    const blockBox = await box(`${C} [data-testid="push"]`);
    const msgBox = await box(`${C} [data-testid="push"] >> nth=0 >> [data-testid="topic"]`);
    const rmBox = await box(`${C} [data-testid="push"] >> nth=0 >> [data-testid="rm"]`);
    const codeBox = await box(`${C} [data-testid="push"] >> nth=0 >> [data-testid="push-code"]`);
    // CONTROL: the ✕ has a box. "They do not overlap" is vacuous against an element that is not there.
    yes(`CONTROL: the remove button has a box (${rmBox?.width}x${rmBox?.height})`, (rmBox?.width ?? 0) > 0 && (rmBox?.height ?? 0) > 0);
    yes(`the message fills the block's width (${Math.round(msgBox.width)} of ${Math.round(blockBox.width)})`,
        msgBox.width / blockBox.width > 0.88, `${Math.round(msgBox.width)} / ${Math.round(blockBox.width)}`);
    yes(`the message is at least 80px tall (${Math.round(msgBox.height)}px)`, msgBox.height >= 80, `${msgBox.height}px`);
    // THE SQUEEZE, MEASURED. The old grid put the message and the ✕ on one line; nothing shares a
    // line with the message now, so the two boxes cannot intersect on either axis.
    const overlaps = msgBox.x < rmBox.x + rmBox.width && rmBox.x < msgBox.x + msgBox.width
                  && msgBox.y < rmBox.y + rmBox.height && rmBox.y < msgBox.y + msgBox.height;
    yes("the message does not overlap the ✕", overlaps === false,
        `msg ${JSON.stringify(msgBox)} rm ${JSON.stringify(rmBox)}`);
    yes(`the message sits BELOW the ✕, on its own line (${Math.round(msgBox.y)} > ${Math.round(rmBox.y + rmBox.height)})`,
        msgBox.y >= rmBox.y + rmBox.height);
    yes(`the code field fills the width too (${Math.round(codeBox.width)} of ${Math.round(blockBox.width)})`,
        codeBox.width / blockBox.width > 0.88, `${Math.round(codeBox.width)} / ${Math.round(blockBox.width)}`);

    // THE PANEL DID NOT GET WIDER. Asserted against the fixed width in MatchEditorPanel's own class,
    // read out of the source, so a change to either has to be a change to both.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/MatchPromotionView.tsx", "utf8");
    /* DERIVED, NOT PINNED. The number comes out of the panel's own class on the panel's own line, so
     * a suite that says "the panel did not get wider" cannot be satisfied by editing the suite. */
    const panelLine = src.split("\n").find((l) => l.includes("fixed right-0 top-0 bottom-0")) ?? "";
    const declared = Number(/md:w-\[(\d+)px\]/.exec(panelLine)?.[1] ?? 0);
    const panelBox = await box('[data-testid="panel"]');
    yes(`the panel is the width the source declares (${Math.round(panelBox.width)}px vs ${declared}px)`,
        declared > 0 && Math.abs(panelBox.width - declared) <= 2, `measured ${panelBox.width}, declared ${declared}`);

    // A LONG MESSAGE IS READABLE, not clipped to a line.
    const LONG = "Games every night this week at NEMP and Parmer. Grab a spot!";
    await p.locator(`${C} [data-testid="push"] >> nth=0 >> [data-testid="topic"]`).fill(LONG);
    await p.waitForTimeout(250);
    is(`the character count reads back (${LONG.length})`,
       await txt(p, `${C} [data-testid="push"] >> nth=0 >> [data-testid="msg-count"]`), `${LONG.length} characters`);
    const clipped = await p.locator(`${C} [data-testid="push"] >> nth=0 >> [data-testid="topic"]`)
      .evaluate((e) => e.scrollHeight > e.clientHeight + 2);
    yes(`${LONG.length} characters are visible without scrolling`, clipped === false);
    // CONTROL: the count is live, not a constant.
    await p.locator(`${C} [data-testid="push"] >> nth=0 >> [data-testid="topic"]`).fill("ab");
    await p.waitForTimeout(200);
    is("CONTROL: the count is live", await txt(p, `${C} [data-testid="push"] >> nth=0 >> [data-testid="msg-count"]`), "2 characters");
    await p.locator(`${C} [data-testid="push"] >> nth=0 >> [data-testid="topic"]`).fill("Thursday slate");

    head("Fix 3 · the code belongs to the push, through the real page");
    const codes = await p.locator(`${C} [data-testid="push-code"]`).evaluateAll((es) => es.map((e) => e.value));
    is("each push shows its OWN code, not the channel's first", codes, ["PARMER10", ""]);
    yes("CONTROL: which is the point — they differ", codes[0] !== codes[1]);
    is("the channel header no longer carries a Code field", await p.locator(`${C} > div [data-testid="code"]`).count(), 0);
    const ph = await p.locator(`${C} [data-testid="push-code"]`).first().getAttribute("placeholder");
    is("the placeholder is an example, not an instruction about channels", ph, "e.g. PARMER10");
    yes("the hint says blank is a real answer",
        (await p.locator(`${C} [data-testid="push"]`).first().textContent())?.includes("Optional. Leave blank for no code on this push.") === true);

    // A CODE TYPED ON THE SECOND PUSH LANDS ON THE SECOND PUSH ONLY — through the page and the save.
    await p.locator(`${C} [data-testid="push-code"]`).nth(1).fill("westlake5");
    await p.locator('[data-testid="save"]').click();
    await p.waitForTimeout(2500);
    is("the store holds one code per push, each its own",
       store.pushes.map((r) => [r.id, r.promoCode]), [[601, "PARMER10"], [602, "WESTLAKE5"]]);
    yes("CONTROL: and the first push's code was not overwritten", store.pushes[0].promoCode === "PARMER10");
    is("it was typed lower-case and normalised on the way in", store.pushes[1].promoCode, "WESTLAKE5");

    await closeContext(ctx);
  }

  // ══ ONE CODE ACROSS TWO CHANNELS: SAVES, SURVIVES A RELOAD, AND SAYS SO ═══════════════════
  {
    head("a shared code saves, reloads intact, and carries the note on both channels");
    const store = makeStore();
    const { ctx, p, errs } = await boot(browser, storageState, { store });
    store.pushes = [
      { id: 701, channel: "wa", pushAt: "2026-09-24T17:00:00.000Z", topic: "WhatsApp send", promoCode: "", pushedAt: null, pushedBy: null },
      { id: 702, channel: "klaviyo_sms", pushAt: "2026-09-24T18:00:00.000Z", topic: "SMS send", promoCode: "", pushedAt: null, pushedBy: null },
      { id: 703, channel: "dm", pushAt: "2026-09-24T19:00:00.000Z", topic: "DM send", promoCode: "OTHER5", pushedAt: null, pushedBy: null },
    ];
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="city-block"]', { timeout: 120000 });
    await p.waitForTimeout(1200);
    yes("no page errors", errs.length === 0, errs[0] ?? "");

    const openEditor = async () => {
      await p.locator(`[data-testid="match-tile"][data-api-id="${store.matchApiId}"]`).first().click();
      await p.waitForSelector('[data-testid="push-editor"]', { timeout: 20000 });
      await p.waitForTimeout(500);
    };
    await openEditor();
    const C = (k) => `[data-testid="chan"][data-key="${k}"]`;
    nonEmpty(await p.$$(`${C("wa")} [data-testid="push"]`), "WhatsApp push blocks");
    ok("PRESENCE CONTROL: the editor opened with push blocks on both channels");

    // PRESENCE CONTROL FIRST: with no shared code anywhere, no note is on the page at all.
    is("CONTROL: before anything is shared, there is no note", await p.locator('[data-testid="code-shared"]').count(), 0);
    is("CONTROL: and the DM push with its own unique code has none either",
       await p.locator(`${C("dm")} [data-testid="code-shared"]`).count(), 0);

    // TYPE THE SAME CODE ON TWO CHANNELS. This is exactly what the route used to answer with a 400.
    await p.locator(`${C("wa")} [data-testid="push-code"]`).first().fill("PARMER10");
    await p.locator(`${C("klaviyo_sms")} [data-testid="push-code"]`).first().fill("PARMER10");
    await p.waitForTimeout(300);
    is("the note appears on WhatsApp", await txt(p, `${C("wa")} [data-testid="code-shared"]`),
       "Also used on Klaviyo SMS. Bookings with this code can't be split by channel.");
    is("  and on Klaviyo SMS, naming the other one", await txt(p, `${C("klaviyo_sms")} [data-testid="code-shared"]`),
       "Also used on WhatsApp. Bookings with this code can't be split by channel.");
    is("  it names the actual channels", await p.locator(`${C("wa")} [data-testid="code-shared"]`).getAttribute("data-channels"), "Klaviyo SMS");
    is("CONTROL: the DM push, with a code of its own, still has no note",
       await p.locator(`${C("dm")} [data-testid="code-shared"]`).count(), 0);

    // SAVE. No refusal, no toast.
    await p.locator('[data-testid="save"]').click();
    await p.waitForTimeout(2500);
    is("the save landed — both rows carry the shared code",
       store.pushes.map((r) => [r.id, r.channel, r.promoCode]).sort((a, b) => a[0] - b[0]),
       [[701, "wa", "PARMER10"], [702, "klaviyo_sms", "PARMER10"], [703, "dm", "OTHER5"]]);
    is("  and nothing was refused", await p.locator("text=/cannot be attributed to either/").count(), 0);

    // RELOAD, AND BOTH STILL HAVE IT.
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="city-block"]', { timeout: 120000 });
    await p.waitForTimeout(1200);
    await openEditor();
    is("after a reload both channels still show the code",
       [await p.locator(`${C("wa")} [data-testid="push-code"]`).first().inputValue(),
        await p.locator(`${C("klaviyo_sms")} [data-testid="push-code"]`).first().inputValue()],
       ["PARMER10", "PARMER10"]);
    is("  and the note is on both, from the saved plan", await p.locator('[data-testid="code-shared"]').count(), 2);
    is("  CONTROL: the DM push is still noteless", await p.locator(`${C("dm")} [data-testid="code-shared"]`).count(), 0);

    // AND CLEARING ONE TAKES BOTH NOTES AWAY — the note is about the pairing, not about the field.
    await p.locator(`${C("klaviyo_sms")} [data-testid="push-code"]`).first().fill("");
    await p.waitForTimeout(300);
    is("clearing one side removes the note from both", await p.locator('[data-testid="code-shared"]').count(), 0);
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\n${PASS} passed, ${FAIL} failed`);
  for (const f of fails) console.log(`  XX ${f}`);
  if (PASS === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
