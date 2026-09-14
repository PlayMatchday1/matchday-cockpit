// MARK A PUSH SENT, AND DELETE TWO PARAGRAPHS OF RULES.
//
// Ryan: "we need a way to mark these things complete it should be really simple so you can show
// them done and not overdue but they still show so everyone has visibility" and "also remove all
// this its jus tnoise".
//
// Overdue was `push_at < now`, full stop — there was no column recording the send, so six rows on
// the strip were overdue forever. Migration 0175 adds pushed_at/pushed_by and overdue becomes
// `push_at < now AND pushed_at IS NULL`.
//
// NOTHING IS WRITTEN TO PRODUCTION. The plan rows and the save route are both intercepted: the
// route's POST is answered from a fixture and the row is mutated in an in-memory store, so marking
// sent, un-marking and re-reading all round-trip without touching match_promotion_plan.
//
//   node scripts/e2e/verify-push-done.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/match-ops/match-promotion`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

const READ = () => {
  const q = (s) => document.querySelector(s);
  const T = (s) => q(s)?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const vw = document.documentElement.clientWidth;
  const jobs = [...document.querySelectorAll('[data-testid="job"], [data-testid="m-due-card"]')];
  return {
    vw,
    hscroll: document.documentElement.scrollWidth > vw + 2,
    counts: T('[data-testid="strip-counts"]') ?? T('[data-testid="m-due-counts"]'),
    sentCount: T('[data-testid="strip-sent"]') ?? T('[data-testid="m-due-sent"]'),
    jobs: jobs.map((j) => {
      const btn = j.querySelector('[data-testid="mark-sent"]');
      const r = j.getBoundingClientRect();
      return {
        sent: j.dataset.sent, late: j.dataset.late,
        bg: getComputedStyle(j).backgroundColor,
        text: j.textContent.replace(/\s+/g, " ").trim(),
        stamp: j.querySelector('[data-testid="job-stamp"], [data-testid="m-due-stamp"]')?.textContent.trim() ?? null,
        btn: btn ? { label: btn.textContent.trim(), h: Math.round(btn.getBoundingClientRect().height),
          pressed: btn.getAttribute("aria-pressed"), disabled: btn.disabled } : null,
        /* VISIBLE, not merely in the DOM. */
        visible: r.width > 0 && r.height > 0 && getComputedStyle(j).visibility !== "hidden",
        overflows: j.scrollWidth > j.clientWidth + 1,
      };
    }),
    /* THE TWO PARAGRAPHS. */
    ruleP: q('[data-testid="new-rule"]') != null,
    clickBlurb: /Click a match to plan it/.test(document.body.innerText),
    badges: [...document.querySelectorAll('[data-testid="new-badge"]')].map((b) => ({
      flag: b.dataset.flag, title: b.getAttribute("title"),
    })),
    cityNew: [...document.querySelectorAll("[data-testid='city-new'], .citynew")].map((e) => e.textContent.trim()),
  };
};

/* ── THE IN-MEMORY PLAN STORE ─────────────────────────────────────────────────────────────────
 * The page reads plans straight from PostgREST and writes through /api/match-promotion. Both are
 * intercepted, so the whole mark/un-mark cycle runs against a fixture and production is untouched.
 * The store also decides whether pushed_at EXISTS, which is how the pre-0175 behaviour is tested. */
function makeStore(rows, { hasSentColumns = true } = {}) {
  return { rows: rows.map((r) => ({ ...r })), hasSentColumns, writes: [] };
}

async function boot(browser, storageState, width, store) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: 950 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });

  /* THE WEEK COMES FROM GET /api/match-promotion, not from PostgREST, so THAT is what is rewritten.
   * The store holds the sent stamps and the GET reads them back, which is what makes the mark and
   * the un-mark round-trip without production ever seeing a write. */
  await ctx.route("**/api/match-promotion**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      const res = await route.fetch();
      const j = await res.json().catch(() => null);
      if (!j || !Array.isArray(j.matches)) return route.fulfill({ response: res });
      /* EXACTLY THE PLANS THIS SUITE WANTS: two overdue and one upcoming, and nothing else on the
       * strip, so the counts are arithmetic the suite can predict. */
      for (const m of j.matches) { m.plan = null; m.state = "none"; }
      store.rows.forEach((r, i) => {
        const m = j.matches[i];
        if (!m) return;
        r.match_api_id = m.apiId;
        m.plan = {
          matchApiId: m.apiId,
          channels: r.channels,
          pushAt: r.push_at,
          promoCode: null, comment: null,
          updatedBy: "social@playmatchday.com", updatedAt: new Date().toISOString(),
          /* BEFORE 0175 THE COLUMNS ARE SIMPLY ABSENT, and the mapper reads them as null. */
          ...(store.hasSentColumns ? { pushedAt: r.pushed_at, pushedBy: r.pushed_by } : {}),
        };
        m.state = r.push_at ? "planned" : "needs-decision";
      });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    }
    if (req.method() !== "POST") return route.fallback();
    const body = JSON.parse(req.postData() || "{}");
    store.writes.push(body);
    const row = store.rows.find((r) => r.match_api_id === body.matchApiId);
    if (!row) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "FAILED", error: "no such plan" }) });
    /* THE ROUTE'S OWN RULES, MIRRORED so the fixture cannot be kinder than production. */
    if (body.pushed === true && !body.pushAt) {
      return route.fulfill({ status: 400, contentType: "application/json",
        body: JSON.stringify({ outcome: "FAILED", error: "This plan has no push time yet, so there is nothing to mark sent. Set a time first." }) });
    }
    if (typeof body.pushed === "boolean") {
      if (!store.hasSentColumns) {
        return route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ outcome: "FAILED", error: "Marking a push sent needs migration 0175. Nothing was written." }) });
      }
      row.pushed_at = body.pushed ? new Date().toISOString() : null;
      row.pushed_by = body.pushed ? "ryan@playmatchday.com" : null;
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "LANDED" }) });
  });

  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await p.waitForSelector('[data-testid="jobs"], [data-testid="m-due"]', { timeout: 120000 });
  await p.waitForTimeout(1800);
  return { ctx, p, errs };
}

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const real = nonEmpty((await sb.from("match_promotion_plan").select("*")).data ?? [], "match_promotion_plan rows");
  const withPush = nonEmpty(real.filter((r) => r.push_at), "plan rows with a push time");
  const noPush = real.filter((r) => !r.push_at);
  console.log(`\nplan rows: ${real.length} · with push_at: ${withPush.length} · without: ${noPush.length}`);
  console.log(`already in the past: ${withPush.filter((r) => Date.parse(r.push_at) < Date.now()).length}`);

  /* THE FIXTURE: the real rows, with their push times pulled into the past so they are on the
   * NEXT 48 HOURS strip and overdue, which is the state this whole change is about. */
  const past = new Date(Date.now() - 3 * 3600e3).toISOString();
  const soon = new Date(Date.now() + 6 * 3600e3).toISOString();
  const CH = { wa: true, match_chat: true, fb: false, dm: false, klaviyo_email: false, klaviyo_sms: false };
  const seed = () => [
    { match_api_id: 0, push_at: past, channels: { ...CH }, pushed_at: null, pushed_by: null },
    { match_api_id: 0, push_at: past, channels: { ...CH }, pushed_at: null, pushed_by: null },
    { match_api_id: 0, push_at: soon, channels: { ...CH }, pushed_at: null, pushed_by: null },
  ];

  // ══ 2, 3, 4, 5, 6. THE CONTROL ════════════════════════════════════════════════════════════
  {
    const store = makeStore(seed());
    const { ctx, p, errs } = await boot(browser, storageState, 1200, store);
    console.log("\n-- marking a push sent --");
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    const jobs = nonEmpty(d.jobs, "jobs on the strip");
    console.log(`     counts: "${d.counts}"`);
    // 3 CONTROL: no sent count before anything is sent.
    is("  CONTROL: no sent count while nothing is sent", d.sentCount, null);
    const before = Number(/(\d+) overdue/.exec(d.counts ?? "")?.[1] ?? -1);
    yes(`  CONTROL: there are ${before} overdue to begin with`, before > 0);
    // 2. ONE TAP.
    yes(`  every push carries a Mark sent control (${jobs.filter((j) => j.btn).length}/${jobs.length})`,
      jobs.every((j) => j.btn != null));
    yes(`  and it is ${Math.min(...jobs.map((j) => j.btn.h))}px`, jobs.every((j) => j.btn.h >= 32));
    is("  reading Mark sent", jobs[0].btn.label, "Mark sent");
    await p.click('[data-testid="job"][data-late="1"] [data-testid="mark-sent"]');
    await p.waitForTimeout(1600);
    d = await p.evaluate(READ);
    const sentJob = nonEmpty(d.jobs.filter((j) => j.sent === "1"), "sent jobs")[0];
    is("  one tap marks it sent", sentJob.btn.label, "Sent");
    is("  and the control says so to a screen reader", sentJob.btn.pressed, "true");
    // 2 CONTROL: THE ROW IS STILL THERE, AND VISIBLE.
    is("  the row is still on the strip", d.jobs.length, jobs.length);
    is("  CONTROL: and visible, not merely in the DOM", sentJob.visible, true);
    // 3. THE COUNTS.
    const after = Number(/(\d+) overdue/.exec(d.counts ?? "")?.[1] ?? -1);
    is(`  the overdue count drops by one (${before} to ${after})`, after, before - 1);
    yes(`  and a sent count appears: "${d.sentCount}"`, /1 sent/.test(d.sentCount ?? ""));
    // 5. WHO AND WHEN.
    yes(`  the row records who and when: "${sentJob.stamp}"`, /^Sent \w{3} \d/.test(sentJob.stamp ?? ""));
    yes("  naming the person, not the address", /by ryan/i.test(sentJob.stamp ?? "") && !/@/.test(sentJob.stamp ?? ""));
    is("  CONTROL: no em-dash in it", /—/.test(sentJob.stamp ?? ""), false);
    // 6. THREE DIFFERENT LOOKS.
    const stillLate = d.jobs.find((j) => j.late === "1");
    const upcoming = d.jobs.find((j) => j.sent === "0" && j.late === "0");
    yes("  CONTROL: a sent, an overdue and an upcoming row are all on screen",
      sentJob != null && stillLate != null && upcoming != null);
    is(`  the three differ in background (${[sentJob.bg, stillLate.bg, upcoming.bg].join(" / ")})`,
      new Set([sentJob.bg, stillLate.bg, upcoming.bg]).size, 3);
    yes("  and read differently too, so colour is never the only signal",
      /Sent/.test(sentJob.text) && /Overdue/.test(stillLate.text) && !/Overdue|Sent \w{3}/.test(upcoming.text));
    // 4. TAPPING AGAIN UN-MARKS IT.
    await p.click('[data-testid="job"][data-sent="1"] [data-testid="mark-sent"]');
    await p.waitForTimeout(1600);
    d = await p.evaluate(READ);
    is("  tapping again un-marks it", d.jobs.filter((j) => j.sent === "1").length, 0);
    is("  the overdue count comes back", Number(/(\d+) overdue/.exec(d.counts ?? "")?.[1] ?? -1), before);
    is("  CONTROL: and the sent count goes away again", d.sentCount, null);
    is("  CONTROL: with the stamp cleared", d.jobs.filter((j) => j.stamp).length, 0);
    // 8. THE WRITE WENT THROUGH THE PLAN'S OWN ROUTE, carrying the whole plan.
    const w = nonEmpty(store.writes, "writes")[0];
    is("  the write goes through the plan's own route", typeof w.matchApiId, "number");
    is("  carrying pushed", w.pushed, true);
    yes("  and the whole plan, so the upsert cannot clear the channels",
      w.channels != null && "pushAt" in w);
    is("  CONTROL: and the second write un-sets it", store.writes[1].pushed, false);
    await closeContext(ctx);
  }

  // ══ 7. A PLAN WITH NO PUSH TIME ═══════════════════════════════════════════════════════════
  {
    /* THE CONTROL IS ABSENT, NOT DISABLED. A NULL push_at means "needs a decision" (0128), so the
     * row is not late, it is unplanned — and a greyed "Mark sent" reads as something you could do
     * once you worked out how. There is nothing to have sent. */
    const store = makeStore(seed().map((r, i) => (i === 0 ? { ...r, push_at: null } : r)));
    const { ctx, p, errs } = await boot(browser, storageState, 1200, store);
    console.log("\n-- a plan with no push time --");
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    /* A row with no push_at is not on the strip at all — the strip is built from plans that HAVE a
     * push time — so the assertion is that it never appears with a control. */
    is("  a plan with no push time is not on the push strip", d.jobs.length, seed().length - 1);
    yes("  CONTROL: and every row that IS there can be marked", d.jobs.every((j) => j.btn != null));
    is("  CONTROL: no write was attempted", store.writes.length, 0);
    await closeContext(ctx);
  }

  // ══ 0175 NOT APPLIED YET ══════════════════════════════════════════════════════════════════
  {
    const store = makeStore(seed(), { hasSentColumns: false });
    const { ctx, p, errs } = await boot(browser, storageState, 1200, store);
    console.log("\n-- before migration 0175 --");
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  the page renders exactly as before", nonEmpty(d.jobs, "jobs").length > 0);
    is("  CONTROL: nothing reads as sent", d.jobs.filter((j) => j.sent === "1").length, 0);
    is("  CONTROL: and no sent count appears", d.sentCount, null);
    await p.click('[data-testid="job"] [data-testid="mark-sent"]');
    await p.waitForTimeout(1500);
    const after = await p.evaluate(READ);
    is("  marking sent changes nothing", after.jobs.filter((j) => j.sent === "1").length, 0);
    const toast = await p.evaluate(() => document.body.innerText.match(/migration 0175[^\n]*/)?.[0] ?? null);
    yes(`  and it says which migration is missing: "${toast}"`, /0175/.test(toast ?? ""));
    await closeContext(ctx);
  }

  // ══ 10. THE TWO PARAGRAPHS ════════════════════════════════════════════════════════════════
  {
    const store = makeStore(seed());
    const { ctx, p, errs } = await boot(browser, storageState, 1200, store);
    console.log("\n-- the noise --");
    /* The grid is on the WEEK tab, which is where the badges live. */
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  the NEW rule paragraph is gone", d.ruleP, false);
    is("  and the click blurb with it", d.clickBlurb, false);
    const badges = d.badges;
    if (badges.length === 0) {
      bad("  CONTROL: a NEW badge still renders", "no NEW slot in this week's data");
    } else {
      yes(`  CONTROL: the NEW badge itself still renders (${badges.length})`, badges.length > 0);
      const t = badges[0].title ?? "";
      yes(`  and its title carries the rule: "${t.slice(0, 54)}…"`, /was not on last week's slate/.test(t));
      yes("  the city", /for [A-Z]/.test(t));
      /* THE COMPARED WEEK, which is the one thing the paragraph had that the badge did not. */
      /* THE COMPARED WEEK — the one thing the deleted paragraph had that the badge did not. The
       * separator is weekRangeLabel's own EN dash, which is a date range, not an em dash. */
      yes(`  and the week it compared against`, /\([A-Z][a-z]{2} \d{1,2} \w+ . \w+ \d{1,2} \w+\)/.test(t), t);
      is("  CONTROL: no em-dash in it", /—/.test(t), false);
    }
    await closeContext(ctx);
  }

  // ══ 9, 11. THE PHONE ══════════════════════════════════════════════════════════════════════
  for (const w of [390, 1200]) {
    const store = makeStore(seed());
    const { ctx, p, errs } = await boot(browser, storageState, w, store);
    console.log(`\n-- ${w}px --`);
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  no horizontal scroll", d.hscroll, false);
    const jobs = nonEmpty(d.jobs, `jobs at ${w}`);
    yes(`  the control is ${Math.min(...jobs.map((j) => j.btn.h))}px`, jobs.every((j) => j.btn.h >= 32));
    is("  no row overflows its own box", jobs.filter((j) => j.overflows).length, 0);
    if (w === 390) {
      // 9. THE MOBILE DUE LIST HAS THE SAME CONTROL, from the same component.
      yes("  the phone's Due list carries the same control", jobs.every((j) => j.btn != null));
      await p.click('[data-testid="m-due-card"] [data-testid="mark-sent"]');
      await p.waitForTimeout(1600);
      d = await p.evaluate(READ);
      is("  and marking works there too", d.jobs.filter((j) => j.sent === "1").length, 1);
      yes(`  with the same stamp: "${d.jobs.find((j) => j.sent === "1")?.stamp}"`,
        /^Sent \w{3} \d/.test(d.jobs.find((j) => j.sent === "1")?.stamp ?? ""));
      is("  CONTROL: still no horizontal scroll", d.hscroll, false);
    }
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\npush-done: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  XX ${f}`); process.exit(1); }
}

main().catch(fatal);
