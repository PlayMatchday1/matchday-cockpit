// A PUSH PER CHANNEL, PER DATE, WITH ITS OWN TOPIC, IN THE READER'S CLOCK.
//
// Teresa: "we can pick the channels, and only 1 date for the pushes ... Pick the channel. Pick the
// date or dates when we are doing the push in that channel. Mention if this channel will have a
// code or not. And for each date, leave a small field to add the topic of the push as it might
// vary between days."
//
// Ryan: "Teresa who does this work is in Spain but us in the US need to see it locally. The times
// of the matches dont change just the push times."
//
// NOTHING IS WRITTEN TO PRODUCTION. GET /api/match-promotion is answered from a fixture and POST is
// answered from an in-memory push store, so adding, removing, editing, marking sent and re-reading
// all round-trip without match_promotion_push ever seeing a write. That also means this suite runs
// whether or not migration 0176 has been applied.
//
// THE READER'S ZONE IS REAL, NOT SIMULATED. Two browser contexts are opened with `timezoneId`
// America/Chicago and Europe/Madrid, which is the only honest way to test "the same instant reads
// differently to Teresa" — a page that fakes its own clock proves nothing about the trap.
//
//   node scripts/e2e/verify-push-plan.mjs
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

/* ── THE FIXTURE MATCH ────────────────────────────────────────────────────────────────────────
 * ONE MATCH, WITH A KNOWN WALL/UTC PAIR, so the venue offset is arithmetic rather than a guess.
 * Kick-off is Mon 8:00 PM at an Atlanta pitch: the wall clock says 20:00 and the true instant is
 * 00:00Z the next day, so start_date − start_date_utc = −4h, which IS the venue's offset. */
const KICK_UTC = "2026-09-15T00:00:00+00:00";
const KICK_WALL = "2026-09-14T20:00:00+00:00";
const VENUE_OFFSET_H = -4;

const CH = ["wa", "match_chat", "fb", "dm", "klaviyo_email", "klaviyo_sms"];

let seq = 100;
const push = (o) => ({
  id: ++seq, match_api_id: 0, channel: "wa", push_at: null, topic: null,
  promo_code: null, pushed_at: null, pushed_by: null, ...o,
});

function makeStore(rows) { return { rows: rows.map((r) => ({ ...r })), writes: [] }; }

/**
 * The whole week, rewritten on the read. The FIRST match carries the fixture's pushes and the
 * fixture's clock; every other match is emptied so the strip counts are arithmetic this suite can
 * predict rather than whatever the live board happens to hold today.
 */
async function boot(browser, storageState, { width = 1100, timezoneId = "America/Chicago", store }) {
  const ctx = await browser.newContext({
    storageState, viewport: { width, height: 980 }, timezoneId,
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}),
  });

  await ctx.route("**/api/match-promotion**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      const res = await route.fetch();
      const j = await res.json().catch(() => null);
      if (!j || !Array.isArray(j.matches) || j.matches.length === 0) return route.fulfill({ response: res });
      for (const m of j.matches) { m.plan = null; m.state = "none"; }
      const m0 = j.matches[0];
      /* THE PAIR IS STAMPED ONTO THE SUBJECT so the venue offset is known and the kick-off instant
       * exists. Everything downstream — "8h before", "Venue time (city)" — derives from these. */
      m0.startDate = KICK_WALL;
      m0.startDateUtc = KICK_UTC;
      m0.city = "Atlanta";
      /* THE DISPLAYED WALL CLOCK IS STAMPED TOO. Overriding only the pair would leave the page
       * printing the real match's kick-off beside an offset derived from a different one, and the
       * suite would be asserting against a match that does not exist. */
      m0.time = "8:00 PM"; m0.minutes = 20 * 60;
      store.rows.forEach((r) => { r.match_api_id = m0.apiId; });
      store.matchApiId = m0.apiId;
      m0.plan = {
        matchApiId: m0.apiId,
        pushes: store.rows.map((r) => ({
          id: r.id, matchApiId: m0.apiId, channel: r.channel, pushAt: r.push_at,
          topic: r.topic, promoCode: r.promo_code, pushedAt: r.pushed_at, pushedBy: r.pushed_by,
        })),
        comment: null, updatedBy: "social@playmatchday.com", updatedAt: new Date().toISOString(),
      };
      m0.state = store.rows.length === 0 ? "none"
        : store.rows.some((r) => r.push_at) ? "planned" : "needs-decision";
      j.planTableReady = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    }
    if (req.method() !== "POST") return route.fallback();
    const body = JSON.parse(req.postData() || "{}");
    store.writes.push(body);

    /* THE ROUTE'S OWN RULES, MIRRORED, so the fixture cannot be kinder than production. */
    if (typeof body.pushed === "boolean") {
      const row = store.rows.find((r) => r.id === body.pushId);
      if (!row) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ outcome: "NOT APPLIED", error: "no such push" }) });
      if (body.pushed === true && !row.push_at) {
        return route.fulfill({ status: 400, contentType: "application/json",
          body: JSON.stringify({ outcome: "FAILED", error: "This push has no time yet, so there is nothing to mark sent. Set a date first." }) });
      }
      row.pushed_at = body.pushed ? new Date().toISOString() : null;
      row.pushed_by = body.pushed ? "ryan@playmatchday.com" : null;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "LANDED" }) });
    }

    /* A BODY WITH NO `pushes` KEY IS A STALE TAB — the route refuses it rather than reading it as
     * "delete everything", and so does this, because a fixture that is kinder than production
     * tests the fixture. */
    if (!Array.isArray(body.pushes)) {
      return route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ outcome: "FAILED", error: "This page is out of date. Reload it and make the change again. Nothing was written." }) });
    }
    /* A FULL REPLACE, SCOPED TO THE MATCH — the same semantics the route implements, including
     * that ids survive so a sent stamp is not lost when a topic is edited. */
    const keep = new Set();
    for (const p of body.pushes ?? []) {
      if (p.id) {
        const row = store.rows.find((r) => r.id === p.id);
        if (row) { row.channel = p.channel; row.push_at = p.at; row.topic = p.topic || null; row.promo_code = p.promoCode || null; keep.add(row.id); }
      } else {
        const row = push({ channel: p.channel, push_at: p.at, topic: p.topic || null, promo_code: p.promoCode || null });
        store.rows.push(row); keep.add(row.id);
      }
    }
    store.rows = store.rows.filter((r) => keep.has(r.id));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "LANDED", pushes: store.rows }) });
  });

  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await p.waitForSelector('[data-testid="jobs"], [data-testid="m-due"]', { timeout: 120000 });
  await p.waitForTimeout(1500);
  return { ctx, p, errs };
}

/**
 * Open THE FIXTURE MATCH'S editor, by its api id.
 *
 * NOT "the first row on screen". The week groups by day and sorts by time, so the first row is
 * whichever real match happens to be earliest — an editor with every channel off, no push rows and
 * no fields. The size sweep then measured an empty set and passed, which is what the nonEmpty
 * control below now refuses.
 */
async function openEditor(p, width, store) {
  const id = store.matchApiId;
  const sel = width < 640 ? `[data-testid="m-row"][data-api-id="${id}"]` : `[data-testid="match-tile"][data-api-id="${id}"]`;
  if (width < 640) {
    await p.locator('[data-testid="m-tab-week"]').click();
    await p.waitForTimeout(500);
  }
  await p.locator(sel).first().scrollIntoViewIfNeeded();
  await p.locator(sel).first().click();
  await p.waitForSelector('[data-testid="push-editor"]', { timeout: 20000 });
  await p.waitForTimeout(400);
}

const C = (k) => `[data-testid="chan"][data-key="${k}"]`;
const rows = (p, k) => p.locator(`${C(k)} [data-testid="push"]`);
const val = (p, s) => p.locator(s).first().inputValue();
const txt = async (p, s) => (await p.locator(s).first().textContent())?.replace(/\s+/g, " ").trim() ?? null;

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  /* ── 14. WHAT THE REAL PLANS LOOK LIKE. Read only, and it is also the positive control that the
   * production shape this whole migration reshapes is actually there to be reshaped. */
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const plans = nonEmpty((await sb.from("match_promotion_plan").select("*")).data ?? [], "match_promotion_plan rows");
  const expected = plans.reduce((n, r) => n + CH.filter((k) => r[k] === true).length, 0);
  const { data: pushRows, error: pushErr } = await sb.from("match_promotion_push").select("*");
  console.log(`\n${plans.length} plan rows · ${plans.filter((r) => r.push_at).length} with push_at`);
  console.log(`the backfill should produce ${expected} push rows:`);
  for (const k of CH) console.log(`  ${k}: ${plans.filter((r) => r[k] === true).length}`);
  console.log(pushErr ? `match_promotion_push: ABSENT (0176 not applied) — ${pushErr.code}`
    : `match_promotion_push: ${pushRows.length} rows present`);

  const base = () => [
    push({ channel: "wa", push_at: "2026-09-14T17:00:00.000Z", topic: "New field launch", promo_code: "SEP20" }),
    push({ channel: "wa", push_at: "2026-09-16T16:00:00.000Z", topic: "First match at the pitch", promo_code: "SEP20" }),
    push({ channel: "match_chat", push_at: "2026-09-14T17:00:00.000Z", topic: "New field launch" }),
    /* A CHANNEL ON WITH NO DATE. 0128's state, now per channel. */
    push({ channel: "klaviyo_sms", push_at: null }),
  ];

  // ══ 3, 4, 5, 6. THE EDITOR ════════════════════════════════════════════════════════════════
  {
    head("many dates per channel, a topic each, a code per channel");
    const store = makeStore(base());
    const { ctx, p, errs } = await boot(browser, storageState, { store });
    is("no page error", errs.length, 0);
    await openEditor(p, 1100, store);

    is("WhatsApp carries two pushes, not one", await rows(p, "wa").count(), 2);
    is("CONTROL: another channel carries its own count, independently", await rows(p, "match_chat").count(), 1);

    await p.locator(`${C("wa")} [data-testid="add"]`).click();
    await p.waitForTimeout(250);
    is("a third can be added", await rows(p, "wa").count(), 3);
    is("  CONTROL: and it does not touch the other channel", await rows(p, "match_chat").count(), 1);
    /* THE NEW ONE SORTS INTO PLACE BY TIME. 8h before a Mon 8:00 PM kick-off is earlier than the
     * 17:00Z push, so it lands FIRST — at the end would mean the list is insertion-ordered. */
    is("  and the new one sorts into place by time rather than landing at the end",
      await val(p, `${C("wa")} [data-testid="push"] >> nth=0 >> [data-testid="topic"]`), "");

    await p.locator(`${C("wa")} [data-testid="push"] >> nth=0 >> [data-testid="rm"]`).click();
    await p.waitForTimeout(250);
    is("and removed again", await rows(p, "wa").count(), 2);

    const t0 = await val(p, `${C("wa")} [data-testid="push"] >> nth=0 >> [data-testid="topic"]`);
    const t1 = await val(p, `${C("wa")} [data-testid="push"] >> nth=1 >> [data-testid="topic"]`);
    is("each date has its own topic", [t0, t1], ["New field launch", "First match at the pitch"]);
    yes("  CONTROL: which is the point, they differ", t0 !== t1);

    is("WhatsApp carries its own code", await val(p, `${C("wa")} [data-testid="code"]`), "SEP20");
    is("CONTROL: and another channel carries none", await val(p, `${C("match_chat")} [data-testid="code"]`), "");
    const ph = await p.locator(`${C("match_chat")} [data-testid="code"]`).getAttribute("placeholder");
    yes(`  with the empty state saying so: "${ph}"`, /none for this channel/.test(ph ?? ""));
    is("CONTROL: an off channel has no code field at all", await p.locator(`${C("fb")} [data-testid="code"]`).count(), 0);

    // ── a channel on with no date
    is("Klaviyo SMS is on", await p.locator(C("klaviyo_sms")).getAttribute("data-on"), "1");
    is("  with no dated push", await p.locator(C("klaviyo_sms")).getAttribute("data-pushes"), "0");
    yes("  and says needs a date", /needs a date/.test(await txt(p, `${C("klaviyo_sms")} [data-testid="cnote"]`) ?? ""));
    const bgNeed = await p.locator(C("klaviyo_sms")).evaluate((e) => getComputedStyle(e).backgroundColor);
    const bgOn = await p.locator(C("wa")).evaluate((e) => getComputedStyle(e).backgroundColor);
    const bgOff = await p.locator(C("fb")).evaluate((e) => getComputedStyle(e).backgroundColor);
    yes(`and looks like neither a planned nor an off channel (${bgNeed})`, bgNeed !== bgOn && bgNeed !== bgOff);
    yes("the footer counts it", /still needs a date/.test(await txt(p, '[data-testid="sum"]') ?? ""));

    await p.locator(`${C("fb")} [data-testid="tog"]`).click();
    await p.waitForTimeout(250);
    is("turning a channel on", await p.locator(C("fb")).getAttribute("data-on"), "1");
    is("  CONTROL: gives it no date, it does not invent one", await p.locator(C("fb")).getAttribute("data-pushes"), "0");
    is("  and it gains a code field", await p.locator(`${C("fb")} [data-testid="code"]`).count(), 1);

    /* TURNING A CHANNEL OFF KEEPS ITS ROWS IN THE DRAFT. That is the undo that makes a confirm
     * unnecessary: nothing is written until Save. */
    await p.locator(`${C("wa")} [data-testid="tog"]`).click();
    await p.waitForTimeout(250);
    is("turning a channel with pushes off hides them", await rows(p, "wa").count(), 0);
    await p.locator(`${C("wa")} [data-testid="tog"]`).click();
    await p.waitForTimeout(250);
    is("  and turning it back on restores them, which is why there is no confirm", await rows(p, "wa").count(), 2);
    is("  CONTROL: with the code intact too", await val(p, `${C("wa")} [data-testid="code"]`), "SEP20");
    is("  CONTROL: and nothing was written while all that happened", store.writes.length, 0);

    await closeContext(ctx);
  }

  // ══ 7, 8. TWO CLOCKS ══════════════════════════════════════════════════════════════════════
  let chiPush = null, madPush = null, chiKick = null, madKick = null, chiRel = null, madRel = null;
  {
    head("the match time does not move, the push time does");
    for (const [tz, label] of [["America/Chicago", "Austin"], ["Europe/Madrid", "Madrid"]]) {
      const store = makeStore(base());
      const { ctx, p, errs } = await boot(browser, storageState, { store, timezoneId: tz });
      is(`no page error in ${label}`, errs.length, 0);
      await openEditor(p, 1100, store);
      const kick = await txt(p, '[data-testid="kick"]');
      const at = await val(p, `${C("wa")} [data-testid="push"] >> nth=0 >> [data-testid="at"]`);
      const rel = await txt(p, `${C("wa")} [data-testid="push"] >> nth=0 >> [data-testid="rel"]`);
      const zl = await txt(p, '[data-testid="z-label"]');
      if (tz === "America/Chicago") { chiKick = kick; chiPush = at; chiRel = rel; yes(`the zone is named, so nobody guesses: "${zl}"`, /America\/Chicago/.test(zl ?? "")); }
      else { madKick = kick; madPush = at; madRel = rel; yes(`  CONTROL: and it follows the reader: "${zl}"`, /Europe\/Madrid/.test(zl ?? "")); }
      await closeContext(ctx);
    }
    is(`the match time does not move: "${chiKick}" in both`, chiKick, madKick);
    yes("  and says whose clock it is", /at the pitch/.test(chiKick ?? ""));
    yes(`the push time does: ${chiPush} in Austin, ${madPush} in Madrid`, chiPush !== madPush);
    is(`CONTROL: and the offset to kickoff is the same number in both: "${chiRel}"`, chiRel, madRel);
    is("  CONTROL: and it is the fixture's own arithmetic, 17:00Z to a 00:00Z kick-off", chiRel, "7h before");
  }

  // ══ 9. THE ROUND TRIP ═════════════════════════════════════════════════════════════════════
  {
    head("editing in one zone means the same instant in the other");
    const store = makeStore(base());
    const { ctx, p, errs } = await boot(browser, storageState, { store, timezoneId: "Europe/Madrid" });
    is("no page error", errs.length, 0);
    await openEditor(p, 1100, store);

    const at = p.locator(`${C("wa")} [data-testid="push"] >> nth=0 >> [data-testid="at"]`);
    await at.fill("2026-09-14T09:00");
    await at.dispatchEvent("change");
    await p.waitForTimeout(350);
    is("a time typed in Madrid reads back as typed",
      await val(p, `${C("wa")} [data-testid="push"] >> nth=0 >> [data-testid="at"]`), "2026-09-14T09:00");

    /* SWITCHING TO VENUE TIME MUST MOVE THE DIGITS, NOT THE INSTANT. Madrid is +2 in September and
     * the venue is -4, so the same moment reads six hours earlier. IF BOTH SHOWED 09:00 the input
     * would be writing a wall clock into a timestamptz and every push would have quietly moved —
     * that is the failure this assertion exists for. */
    await p.locator('[data-testid="z-venue"]').click();
    await p.waitForTimeout(350);
    const venueVal = await val(p, `${C("wa")} [data-testid="push"] >> nth=0 >> [data-testid="at"]`);
    is("and in venue time the SAME INSTANT reads six hours earlier, not the same digits",
      venueVal, "2026-09-14T03:00");
    const zl = await txt(p, '[data-testid="z-label"]');
    is("venue time is labelled by CITY, not by an IANA name nobody can check", zl, "Venue time (Atlanta)");

    /* AND THE STORED INSTANT IS UNCHANGED BY THE ZONE SWITCH. */
    await p.locator('[data-testid="save"], [data-testid="m-save"]').first().click();
    await p.waitForTimeout(1200);
    const wrote = nonEmpty(store.writes.filter((w) => Array.isArray(w.pushes)), "plan writes");
    const sent = wrote[wrote.length - 1].pushes.find((x) => x.channel === "wa" && x.at);
    is("the saved instant is the one that was typed in Madrid, 9:00 CEST = 07:00Z",
      sent.at.slice(0, 16), "2026-09-14T07:00");

    /* RELOAD, AND THE INSTANT IS STILL THE SAME ONE. */
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="jobs"]', { timeout: 60000 });
    await p.waitForTimeout(1200);
    await openEditor(p, 1100, store);
    is("and after a reload it reads back as typed, in Madrid",
      await val(p, `${C("wa")} [data-testid="push"] >> nth=0 >> [data-testid="at"]`), "2026-09-14T09:00");
    await closeContext(ctx);
  }

  // ══ 10, 11. THE STRIP IS PUSHES, AND SENT IS PER PUSH ═════════════════════════════════════
  {
    head("the strip lists pushes, not matches");
    const pastA = new Date(Date.now() - 4 * 3600e3).toISOString();
    const pastB = new Date(Date.now() - 2 * 3600e3).toISOString();
    const soon = new Date(Date.now() + 6 * 3600e3).toISOString();
    const store = makeStore([
      push({ channel: "wa", push_at: pastA, topic: "New field launch" }),
      push({ channel: "match_chat", push_at: pastB, topic: "Reminder, 12 spots left" }),
      push({ channel: "klaviyo_email", push_at: soon, topic: "Week ahead" }),
    ]);
    const { ctx, p, errs } = await boot(browser, storageState, { store });
    is("no page error", errs.length, 0);

    const jobs = p.locator('[data-testid="job"]');
    is("a three-push match appears three times on the strip", await jobs.count(), 3);
    const topics = await p.locator('[data-testid="job-topic"]').allTextContents();
    is("and each chip carries its own topic, which is what tells them apart",
      topics.map((t) => t.trim()), ["New field launch", "Reminder, 12 spots left", "Week ahead"]);
    const chans = await p.locator('[data-testid="job-chan"]').allTextContents();
    is("  CONTROL: and each names its own channel", chans, ["WA", "MC", "EM"]);

    const counts = await txt(p, '[data-testid="strip-counts"]');
    yes(`CONTROL: two of the three are overdue to begin with: "${counts}"`, /2 overdue/.test(counts ?? ""));

    /* MARK ONE. The other must stay overdue — that is the whole reason the stamp moved onto the
     * child row, and it is the assertion that would have passed on the old per-match column. */
    const first = jobs.nth(0);
    const pid = await first.getAttribute("data-push-id");
    await first.locator('[data-testid="mark-sent"]').click();
    /* WAIT FOR THE RE-READ, DO NOT SLEEP THROUGH IT. Marking sent POSTs and then reloads the week;
     * a flat timeout races that reload and the counts assert against the pre-click render. */
    await p.waitForFunction(
      () => /1 sent/.test(document.querySelector('[data-testid="strip-counts"]')?.textContent ?? ""),
      null, { timeout: 30000 },
    ).catch(() => {});
    is("marking one push sends only that push", store.rows.filter((r) => r.pushed_at).length, 1);
    is("  and it is the one that was clicked", String(store.rows.find((r) => r.pushed_at).id), pid);
    const after = await txt(p, '[data-testid="strip-counts"]');
    yes(`  the overdue count drops by one, leaving its sibling overdue: "${after}"`, /1 overdue/.test(after ?? ""));
    yes("  and a sent count appears", /1 sent/.test(after ?? ""));
    const stamp = await txt(p, '[data-testid="job-stamp"]');
    yes(`  the row records who and when: "${stamp}"`, /^Sent \w{3} \d{1,2}:\d\d (AM|PM) by ryan$/.test(stamp ?? ""));
    is("  CONTROL: the row is still on the strip", await jobs.count(), 3);
    yes("  CONTROL: no em-dash in it", !/—/.test(stamp ?? ""));

    const sent = await p.locator('[data-testid="job"][data-sent="1"]').first().evaluate((e) => getComputedStyle(e).backgroundColor);
    const late = await p.locator('[data-testid="job"][data-late="1"]').first().evaluate((e) => getComputedStyle(e).backgroundColor);
    const up = await p.locator('[data-testid="job"][data-sent="0"][data-late="0"]').first().evaluate((e) => getComputedStyle(e).backgroundColor);
    yes(`sent, overdue and upcoming differ on computed background (${sent} / ${late} / ${up})`,
      sent !== late && late !== up && sent !== up);

    /* A PUSH WITH NO DATE GETS NO CONTROL AT ALL. */
    const undated = makeStore([push({ channel: "wa", push_at: null })]);
    const b2 = await boot(browser, storageState, { store: undated });
    is("a push with no date is not on the strip", await b2.p.locator('[data-testid="job"]').count(), 0);
    is("  CONTROL: and no mark-sent control exists for it", await b2.p.locator('[data-testid="mark-sent"]').count(), 0);
    is("  CONTROL: no write was attempted", undated.writes.length, 0);
    await closeContext(b2.ctx);
    await closeContext(ctx);
  }

  // ══ THE NOISE, AND THE STATE BEFORE THE MIGRATION ════════════════════════════════════════
  /* CARRIED OVER FROM verify-push-done.mjs, which 0176 retired: its subject was the per-MATCH sent
   * stamp, and there is no longer one. These two sections were not about that stamp and are still
   * live, so they moved here rather than going out with the file. */
  {
    head("the noise, and the badge that carries the rule");
    const store = makeStore(base());
    const { ctx, p, errs } = await boot(browser, storageState, { store });
    is("no page error", errs.length, 0);
    const body = await p.evaluate(() => document.body.innerText);
    is("the NEW rule paragraph is gone", /A match is NEW when its own field/.test(body), false);
    is("  and the click blurb with it", /Click a match to plan it/.test(body), false);
    const badges = nonEmpty(await p.$$('[data-testid="new-badge"]'), "NEW badges");
    ok(`CONTROL: the NEW badge itself still renders (${badges.length})`);
    const title = await badges[0].getAttribute("title");
    yes(`and its title carries the rule: "${(title ?? "").slice(0, 52)}…"`, /was not on last week's slate/.test(title ?? ""));
    yes("  the city", /slate for \w/.test(title ?? ""));
    yes("  and the week it compared against", /\(\w{3} \d{1,2} \w{3} . \w{3} \d{1,2} \w{3}\)/.test(title ?? ""));
    yes("  CONTROL: no em-dash in it", !/—/.test(title ?? ""));
    await closeContext(ctx);
  }
  {
    head("before migration 0176");
    /* THE TABLE IS NOT THERE YET. The read degrades to "no plan" on every match and the page says
     * so; the write refuses and NAMES the migration rather than leaving a 42P01 nobody can read. */
    const store = makeStore([]);
    const ctx = await browser.newContext({ storageState, viewport: { width: 1100, height: 980 } });
    await ctx.route("**/api/match-promotion**", async (route) => {
      if (route.request().method() === "GET") {
        const res = await route.fetch();
        const j = await res.json().catch(() => null);
        if (!j) return route.fulfill({ response: res });
        for (const m of j.matches ?? []) { m.plan = null; m.state = "none"; }
        j.planTableReady = false;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
      }
      store.writes.push(JSON.parse(route.request().postData() || "{}"));
      return route.fulfill({ status: 503, contentType: "application/json",
        body: JSON.stringify({ outcome: "FAILED", error: "match_promotion_push does not exist yet — apply migration 0176 before saving a plan." }) });
    });
    const p = await ctx.newPage();
    const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
    await p.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 180000 });
    await p.waitForSelector('[data-testid="jobs"]', { timeout: 120000 });
    await p.waitForTimeout(1200);
    is("no page error", errs.length, 0);
    yes("the page says the table is missing rather than showing an empty week as a clean one",
      (await p.getByText("match_promotion_push is not in the database yet").count()) > 0);
    is("  CONTROL: and nothing is on the strip", await p.locator('[data-testid="job"]').count(), 0);
    await p.locator('[data-testid="match-tile"]').first().click();
    await p.waitForSelector('[data-testid="push-editor"]', { timeout: 20000 });
    await p.locator(`${C("wa")} [data-testid="tog"]`).click();
    await p.waitForTimeout(250);
    await p.locator('[data-testid="save"]').click();
    await p.waitForTimeout(1200);
    const msg = await txt(p, '[data-testid="panel"]');
    yes("saving refuses and names the migration", /0176/.test(msg ?? ""));
    is("  CONTROL: the editor still opened and the toggle still worked", store.writes.length, 1);
    await closeContext(ctx);
  }

  // ══ THE MIGRATION RACE ════════════════════════════════════════════════════════════════════
  {
    head("a stale tab cannot wipe a match's pushes");
    /* MEASURED, NOT HYPOTHETICAL. 0176's backfill ran at 20:29 UTC on 2026-09-14 and nine plans
     * were saved through the old editor between 20:33 and 20:48. A browser left open across the
     * deploy posts { channels, pushAt, promoCode } with no `pushes` key at all; read as an empty
     * replace that deletes every push on the match, and Save is what does it. */
    const store = makeStore(base());
    const { ctx, p, errs } = await boot(browser, storageState, { store });
    is("no page error", errs.length, 0);
    const before = store.rows.length;
    const out = await p.evaluate(async () => {
      const res = await fetch("/api/match-promotion", {
        method: "POST", headers: { "Content-Type": "application/json" },
        /* THE PRE-0176 BODY, EXACTLY. */
        body: JSON.stringify({ matchApiId: 1, channels: { wa: true }, pushAt: null, promoCode: "" }),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    });
    is("the old body shape is refused, not obeyed", out.json?.outcome, "FAILED");
    yes(`  and it says what to do: "${out.json?.error}"`, /out of date/i.test(out.json?.error ?? ""));
    is("  CONTROL: nothing was deleted", store.rows.length, before);
    /* AND AN EMPTY ARRAY IS STILL A REAL REQUEST — every channel off. The two must not collapse. */
    const off = await p.evaluate(async () => {
      const res = await fetch("/api/match-promotion", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchApiId: 1, pushes: [] }),
      });
      return (await res.json().catch(() => null))?.outcome;
    });
    is("CONTROL: an EMPTY array is still honoured, because that is 'every channel off'", off, "LANDED");
    is("  and it did clear the rows", store.rows.length, 0);
    await closeContext(ctx);
  }

  // ══ 13. SIZES ═════════════════════════════════════════════════════════════════════════════
  for (const width of [390, 1100]) {
    head(`${width}px`);
    const store = makeStore(base());
    const { ctx, p, errs } = await boot(browser, storageState, { width, store });
    is("no page error", errs.length, 0);
    await openEditor(p, width, store);
    const hs = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    is("no horizontal scroll", hs, false);
    /* THE POSITIVE CONTROL FOR EVERY MEASUREMENT BELOW. Math.min of an empty set is Infinity and
     * Infinity >= 32, so an editor that failed to render would pass the size sweep silently. This
     * is that zero, named. */
    const fields = nonEmpty(await p.$$('[data-testid="at"], [data-testid="topic"], [data-testid="code"]'), `${width}px editor fields`);
    const pushRowEls = nonEmpty(await p.$$('[data-testid="push"]'), `${width}px push rows`);
    ok(`CONTROL: the editor rendered ${fields.length} fields across ${pushRowEls.length} push rows`);
    const fieldH = await p.$$eval('[data-testid="at"], [data-testid="topic"], [data-testid="code"]',
      (es) => Math.min(...es.map((e) => e.getBoundingClientRect().height)));
    yes(`every field is ${Math.round(fieldH)}px`, fieldH >= 32);
    const rmW = await p.$$eval('[data-testid="rm"]', (es) => Math.min(...es.map((e) => e.getBoundingClientRect().width)));
    yes(`and the remove control ${Math.round(rmW)}px`, rmW >= 32);
    const over = await p.$$eval('[data-testid="push"]', (es) => es.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    is("no push row overflows its own box", over, 0);
    const zones = await p.locator('[data-testid="z-me"], [data-testid="z-venue"]').count();
    is("the zone control is on both sizes", zones, 2);
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\npush-plan: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(2); });
