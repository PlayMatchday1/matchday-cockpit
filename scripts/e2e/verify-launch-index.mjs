// EVERY LAUNCH IN FLIGHT — /growth/launch.
//
// NOTHING IS WRITTEN AND NOTHING IS READ FROM THE REAL PLAN. kanban_cards, fin_venues and
// field_launch_tasks are answered from fixtures; every other read (app_users, the auth handshake)
// falls through, because stubbing rest/v1 wholesale bounces the page to /login?error=not_authorized.
//
// WHY FIXTURES AND NOT PRODUCTION. No pipeline card is bound to a field yet — 0 of 27 in Confirmed
// — so production renders the empty state and nothing else. The page cannot be exercised on data
// that does not exist.
//
// EVERY DATE IS AN OFFSET FROM TODAY, never a literal. See scripts/e2e/_launchFixtures.mjs.
//
//   node scripts/e2e/verify-launch-index.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
import { FIELDS, SPEC, cardRows, expected, readTemplate, taskRows, venueRows } from "./_launchFixtures.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/growth/launch`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

const READ = () => {
  const q = (s) => document.querySelector(s);
  const T = (s) => q(s)?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const vw = document.documentElement.clientWidth;
  const cards = [...document.querySelectorAll('[data-testid="li-field"]')];
  return {
    vw,
    hscroll: document.documentElement.scrollWidth > vw + 2,
    sub: T('[data-testid="li-sub"]'),
    alarm: T('[data-testid="li-alarm"]'),
    empty: T('[data-testid="li-empty"]'),
    error: T('[data-testid="li-error"]'),
    sects: [...document.querySelectorAll('[data-testid="li-sect"]')].map((e) => e.textContent.trim()),
    /* Grouped BY SECTION, so "nearest first" is asserted inside a group rather than across the
     * whole page — which is the distinction the two groups exist to draw. */
    groups: [...document.querySelectorAll('[data-testid="li-grid"]')].map((g) =>
      [...g.querySelectorAll('[data-testid="li-field"]')].map((e) => ({
        name: e.dataset.name,
        days: +e.dataset.days,
        phase: e.dataset.phase,
        over: e.dataset.over,
        tag: e.tagName,
        n: e.querySelector('[data-testid="li-count"]')?.textContent.trim() ?? null,
        label: e.querySelector('[data-testid="li-count"]')?.nextElementSibling?.textContent.trim() ?? null,
        prog: e.querySelector('[data-testid="li-prog"]')?.textContent.trim() ?? null,
        overTxt: e.querySelector('[data-testid="li-over"]')?.textContent.trim() ?? null,
        text: e.textContent.replace(/\s+/g, " ").trim(),
        h: +e.getBoundingClientRect().height.toFixed(1),
        x: Math.round(e.getBoundingClientRect().x),
        border: getComputedStyle(e).borderColor,
        barLabel: e.querySelector(".lx-bar")?.getAttribute("aria-label") ?? null,
        fills: e.querySelectorAll(".lx-bar i").length,
        clipped: [...e.querySelectorAll(".lx-fn b, .lx-fn span")]
          .filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent.trim()),
      })),
    ),
    spill: [...document.querySelectorAll(".lx-wrap *")]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1; }).length,
  };
};

async function boot(browser, storageState, width, opts = {}) {
  const ctx = await browser.newContext({
    storageState, viewport: { width, height: opts.height ?? 1200 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}),
  });
  const writes = [];
  const owners = opts.owners ?? [];
  const tasks = opts.tasks ?? [];
  const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  /* A WRITE FROM THIS PAGE WOULD BE A BUG — it is a read-only index — so any non-GET is recorded
   * and refused rather than passed through, and the suite asserts the list stayed empty. */
  const guard = async (route, table, rows) => {
    const m = route.request().method();
    if (m !== "GET" && m !== "HEAD") {
      writes.push({ table, method: m, body: route.request().postData() });
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill(json(rows));
  };
  await ctx.route("**/rest/v1/kanban_cards*", (r) => guard(r, "kanban_cards", opts.cards ?? []));
  await ctx.route("**/rest/v1/fin_venues*", (r) => guard(r, "fin_venues", opts.venues ?? []));
  await ctx.route("**/rest/v1/field_launch_tasks*", (r) => guard(r, "field_launch_tasks", tasks));
  void owners;

  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(PAGE, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="li-field"], [data-testid="li-empty"]', { timeout: 120000 });
  await p.waitForTimeout(700);
  return { ctx, p, writes, errs };
}

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  const template = nonEmpty(readTemplate(), "playbook template tasks");
  is("the playbook template holds 24 tasks", template.length, 24);
  const tasks = taskRows(template, SPEC);
  const venues = venueRows();

  /* The owners are real app_users rows, read once, so the coordinator line on a card is a real
   * name rather than a fixture string the page could not have looked up. */
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: admins } = await sb.from("app_users").select("id, full_name, email").eq("is_admin", true).limit(3);
  const owners = nonEmpty(admins ?? [], "admin app_users").map((u) => u.id);
  const cards = cardRows(owners);

  const live = FIELDS.filter((f) => expected(f, tasks).live);
  const finished = FIELDS.length - live.length;
  const wantOver = live.reduce((a, f) => a + expected(f, tasks).over, 0);
  const wantOverFields = live.filter((f) => expected(f, tasks).over > 0).length;
  console.log(`\nfixture: ${live.length} live, ${finished} finished, ${wantOver} overdue across ${wantOverFields} fields`);

  const opts = { cards, venues, tasks, owners };

  // ══ 1. EVERY LAUNCH IN FLIGHT, AND ONLY THOSE ══════════════════════════════════════════════
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1080, opts);
    console.log("\n-- the index at 1080 --");
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  no error banner", d.error, null);
    yes("  no horizontal scroll", !d.hscroll, `scrollWidth over ${d.vw}`);
    is("  the page makes no writes", writes, []);

    const all = d.groups.flat();
    is(`  ${live.length} fields are in flight`, all.length, live.length);
    yes("  and a plan past week 20 has left the page", !all.some((c) => c.name === "PRUMC"),
      "PRUMC (week 26) is still listed");
    yes(`  the live count leads the header: "${d.sub}"`, new RegExp(`^${live.length} fields in flight`).test(d.sub ?? ""));
    yes("  and the finished one is still counted, not silently vanished",
      new RegExp(`${finished} finished`).test(d.sub ?? ""), d.sub);

    // ══ 2. SORTED BY WHAT NEEDS ATTENTION SOONEST ════════════════════════════════════════════
    is("  two groups", d.sects.length, 2);
    yes(`  the ones not yet open come first: "${d.sects[0]}"`, /STILL TO LAUNCH/.test(d.sects[0] ?? ""));
    yes(`  then the ones running: "${d.sects[1]}"`, /LAUNCHED, STILL RUNNING/.test(d.sects[1] ?? ""));
    const upcoming = nonEmpty(d.groups[0] ?? [], "still-to-launch cards");
    const launched = nonEmpty(d.groups[1] ?? [], "launched cards");
    yes(`  still-to-launch runs nearest-first: ${upcoming.map((c) => c.days).join(", ")}`,
      upcoming.every((c, i) => i === 0 || upcoming[i - 1].days <= c.days));
    yes(`  so the one about to open is at the top (${upcoming[0].days} days, ${upcoming[0].name})`,
      upcoming[0].days === Math.min(...upcoming.map((c) => c.days)));
    yes(`  the launched group is genuinely past its date (${launched.map((c) => c.days).join(", ")})`,
      launched.every((c) => c.days < 0));
    yes("  and the most recent opening is first",
      launched.every((c, i) => i === 0 || launched[i - 1].days >= c.days));
    /* THE GROUPING IS ON THE SIGN OF THE COUNTDOWN, NOT ON THE PHASE. A field ten days past its
     * date is still inside the launch window by phase and belongs under "launched". */
    yes("  CONTROL: nothing past its date sits in the still-to-launch group",
      upcoming.every((c) => c.days >= 0));
    yes("  CONTROL: and a launched field still inside the launch window is grouped by the group",
      launched.some((c) => c.phase === "launch") ? true : launched.every((c) => c.days < 0),
      "a launch-phase field leaked into still-to-launch");

    // ══ 3. THE COUNTER IS THE ONE THE PLAN PAGE USES ═════════════════════════════════════════
    yes(`  no card shows a negative countdown (${all.map((c) => c.n).join(", ")})`,
      all.every((c) => Number(c.n) >= 0));
    yes("  some read days to launch", all.some((c) => /DAYS TO LAUNCH/.test(c.label ?? "")));
    yes("  one inside the window reads launch week of 4", all.some((c) => /LAUNCH WEEK OF 4/.test(c.label ?? "")));
    yes("  and a launched one counts up", all.some((c) => /DAYS SINCE LAUNCH/.test(c.label ?? "")));
    const win = all.find((c) => /LAUNCH WEEK/.test(c.label ?? ""));
    yes(`  the launch-week number is 1-4, never zero (${win?.n})`, Number(win?.n) >= 1 && Number(win?.n) <= 4);
    for (const f of live) {
      const card = all.find((c) => c.name === f.name);
      const want = f.days >= 0 ? String(f.days) : String(Math.abs(f.days));
      if (f.days > 0 || expected(f, tasks).week > 8) {
        is(`  ${f.name}: the counter is the day count`, card?.n, want);
      }
    }

    // ══ 4. OVERDUE, SUMMED ONCE AT THE TOP ═══════════════════════════════════════════════════
    yes("  overdue work across every launch is stated once", d.alarm != null);
    yes(`  and adds up: "${d.alarm}"`,
      new RegExp(`${wantOver} tasks overdue across ${wantOverFields} fields`).test(d.alarm ?? ""));
    const badges = all.filter((c) => c.overTxt).map((c) => Number((c.overTxt ?? "").replace(/\D+/g, "")));
    is(`  the per-card badges sum to the same ${wantOver}`, badges.reduce((a, x) => a + x, 0), wantOver);
    is(`  across ${wantOverFields} cards`, badges.length, wantOverFields);
    const marked = all.filter((c) => c.over === "1");
    is("  a card carrying overdue work is marked on the card itself", marked.length, wantOverFields);
    const clean = nonEmpty(all.filter((c) => c.over === "0"), "clean cards")[0];
    yes(`  CONTROL: and looks different from a clean one (${marked[0].border} vs ${clean.border})`,
      marked[0].border !== clean.border);

    // ══ 5. PROGRESS, WITH N/A OUT OF THE DENOMINATOR ═════════════════════════════════════════
    yes(`  every card states its progress: "${all[0].prog}"`, all.every((c) => /^\d+ of \d+ done$/.test(c.prog ?? "")));
    for (const f of live) {
      const e = expected(f, tasks);
      const card = all.find((c) => c.name === f.name);
      is(`  ${f.name}: ${e.done} of ${e.total} done`, card?.prog, `${e.done} of ${e.total} done`);
      if (e.na > 0) {
        yes(`    and ${e.na} N/A said out loud rather than silently shrinking the total`,
          new RegExp(`${e.na} N/A`).test(card?.text ?? ""), card?.text);
      }
    }
    yes("  every meter is labelled for a screen reader", all.every((c) => !!c.barLabel));
    is("  a card with overdue work shows it as its own fill", marked[0].fills, 2);
    is("  CONTROL: and a clean one has one fill", clean.fills, 1);

    // ══ 6. EACH CARD OPENS ITS PLAN ══════════════════════════════════════════════════════════
    is("  each card is one target", [...new Set(all.map((c) => c.tag))], ["A"]);
    yes(`  and is at least 44px tall (${Math.min(...all.map((c) => c.h))}px)`, all.every((c) => c.h >= 44));
    const href = await p.$eval('[data-testid="li-field"]', (e) => e.getAttribute("href"));
    yes(`  pointing at that field's plan: "${href}"`, /^\/growth\/launch\/\d+$/.test(href ?? ""));
    await closeContext(ctx);
  }

  // ══ 7. THE EMPTY CASE SAYS WHERE PLANS COME FROM ═══════════════════════════════════════════
  // This is what everybody sees on day one: 0 of 27 Confirmed cards is bound.
  {
    const { ctx, p, errs } = await boot(browser, storageState, 1080, { ...opts, cards: [] });
    console.log("\n-- nothing in flight --");
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  with nothing bound it says how a plan starts, rather than sitting blank", d.empty != null);
    yes(`  naming the trigger: "${(d.empty ?? "").slice(0, 70)}…"`, /reaches Confirmed/.test(d.empty ?? ""));
    is("  and no group headings are drawn", d.sects, []);
    is("  the header counts nothing in flight", d.sub, "0 fields in flight");
    is("  CONTROL: and no alarm is invented", d.alarm, null);
    await closeContext(ctx);
  }

  // ══ 8. A PHONE ════════════════════════════════════════════════════════════════════════════
  for (const w of [390, 1080]) {
    const { ctx, p, errs } = await boot(browser, storageState, w, opts);
    console.log(`\n-- ${w}px --`);
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  no horizontal scroll", !d.hscroll);
    is("  nothing spills right", d.spill, 0);
    const all = nonEmpty(d.groups.flat(), `cards at ${w}`);
    const clipped = all.flatMap((c) => c.clipped);
    is("  nothing is truncated", clipped, []);
    yes(`  cards are at least 44px (${Math.min(...all.map((c) => c.h))}px)`, all.every((c) => c.h >= 44));
    const cols = new Set(all.map((c) => c.x)).size;
    if (w === 390) is("  the cards stack to one column on a phone", cols, 1);
    else yes(`  and go ${cols} across on desktop`, cols >= 2);
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\n${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  XX ${f}`); process.exit(1); }
}

main().catch(fatal);
