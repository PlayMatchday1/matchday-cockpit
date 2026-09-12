// ONE FIELD'S LAUNCH PLAN — /growth/launch/[venueId].
//
// NOTHING REACHES THE DATABASE. field_launch_tasks is served from an IN-MEMORY STORE inside the
// route handler, so ticking, N/A, adding and removing all round-trip for real against a fixture
// instead of being mocked away — which is the only way to assert that N/A leaves the denominator
// and then comes back. fin_venues and kanban_cards are fixtures too; everything else falls through,
// because stubbing rest/v1 wholesale bounces the page to /login?error=not_authorized.
//
// THE SEEDING IS EXERCISED, NOT ASSUMED. The store starts EMPTY, so the page's own seed runs and
// the suite asserts the 24 rows it inserted — which is what makes the bind dialog's "24 tasks will
// be created" promise true.
//
// EVERY DATE IS AN OFFSET FROM TODAY. A suite that pins a week number goes red on the day the
// calendar catches up with it.
//
//   node scripts/e2e/verify-launch-plan.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
import { isoOffset, readTemplate, weekOfOffset } from "./_launchFixtures.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const VENUE = 900201;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

/* THE OTHER FIELDS, for the switcher. Offsets, never dates. */
const OTHERS = [
  { id: 900202, name: "Soccer Central Field 5", days: 2 },
  { id: 900203, name: "Stony Point", days: 13 },
  { id: 900204, name: "NEMP Field 13", days: -36 },
  { id: 900205, name: "PRUMC", days: -150 },   // past week 20 — must NOT be offered
];

const READ = () => {
  const q = (s) => document.querySelector(s);
  const T = (s) => q(s)?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const vw = document.documentElement.clientWidth;
  const R = (e) => { const b = e.getBoundingClientRect();
    return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const vis = (e) => e.offsetParent !== null;
  const weeks = [...document.querySelectorAll(".lp-wk")];
  const shown = [...document.querySelectorAll('[data-testid="lp-task"]')].filter(vis);
  return {
    vw,
    hscroll: document.documentElement.scrollWidth > vw + 2,
    spill: [...document.querySelectorAll(".lp-wrap *")]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1; }).length,
    field: T('[data-testid="lp-field"]'),
    count: T('[data-testid="lp-count"]'),
    countBox: q('[data-testid="lp-count"]') ? R(q('[data-testid="lp-count"]')) : null,
    label: T('[data-testid="lp-countlabel"]'),
    date: T('[data-testid="lp-date"]'),
    phase: T('[data-testid="lp-phase"]'),
    done: T('[data-testid="lp-done"]'),
    pline: T(".lp-pline"),
    overdue: T('[data-testid="lp-overdue"]'),
    barFills: [...document.querySelectorAll(".lp-bar i")].map((e) => ({ cls: e.className, w: +e.getBoundingClientRect().width.toFixed(1) })),
    barGap: q(".lp-bar") ? getComputedStyle(q(".lp-bar")).gap : null,
    barLabel: q(".lp-bar")?.getAttribute("aria-label") ?? null,
    /* TIMELINE */
    weeks: weeks.map((e) => ({ w: e.dataset.w, ph: e.dataset.ph, today: e.dataset.today ?? null,
      h: Math.round(e.querySelector("i")?.getBoundingClientRect().height ?? 0) })),
    weeksBox: q('[data-testid="lp-weeks"]') ? R(q('[data-testid="lp-weeks"]')) : null,
    weeksGap: q(".lp-weeks") ? getComputedStyle(q(".lp-weeks")).gap : null,
    bands: [...document.querySelectorAll('[data-testid="lp-band"]')].map((e) => ({
      text: e.innerText.replace(/\s+/g, " ").trim(), clipped: e.scrollWidth > e.clientWidth + 1 })),
    /* GROUPS */
    groups: [...document.querySelectorAll('[data-testid="lp-group"]')].map((g) => ({
      phase: g.dataset.phase, open: g.dataset.open,
      count: g.querySelector('[data-testid="lp-groupcount"]')?.textContent.trim() ?? null,
      headH: +g.querySelector(".lp-gh").getBoundingClientRect().height.toFixed(1),
      order: [...g.querySelectorAll('[data-testid="lp-task"]')].map((t) => t.dataset.state),
      titles: [...g.querySelectorAll('[data-testid="lp-task"]')].map((t) => t.querySelector(".lp-tt").textContent.trim()),
    })),
    tasksInDom: document.querySelectorAll('[data-testid="lp-task"]').length,
    tasksShown: shown.length,
    /* STATE AND IDENTITY */
    states: shown.map((t) => t.querySelector('[data-testid="lp-state"]')?.textContent.trim() ?? null),
    stateInks: [...new Set(shown.map((t) => getComputedStyle(t.querySelector('[data-testid="lp-state"]')).color))].length,
    scopes: [...new Set(shown.map((t) => t.querySelector(".lp-scope")?.textContent.trim()))],
    scopeInks: [...new Set([...document.querySelectorAll(".lp-scope")].map((e) => getComputedStyle(e).color))].length,
    dots: document.querySelectorAll(".lp-t .dot, .lp-scope i, .lp-scope .dot").length,
    /* OWNERS */
    owners: shown.map((t) => {
      const o = t.querySelector('[data-testid="lp-owner"]');
      return o ? { un: o.dataset.unassigned, text: o.textContent.trim(),
        border: getComputedStyle(o).borderStyle, h: +o.getBoundingClientRect().height.toFixed(1) } : null;
    }),
    /* N/A AND ADD */
    naButtons: document.querySelectorAll('[data-testid="lp-na"]').length,
    removeButtons: document.querySelectorAll('[data-testid="lp-remove"]').length,
    custom: document.querySelectorAll('[data-testid="lp-custom"]').length,
    naRows: [...document.querySelectorAll('[data-testid="lp-task"][data-state="na"]')].map((t) => ({
      deco: getComputedStyle(t.querySelector(".lp-tt")).textDecorationLine })),
    rmConfirm: T('[data-testid="lp-rmconfirm"]'),
    dlg: T('[data-testid="lp-adddlg"] .lp-dh'),
    dlgOpen: q('[data-testid="lp-adddlg"]') != null,
    addSaveDisabled: q('[data-testid="lp-add-save"]')?.disabled ?? null,
    badWeek: T('[data-testid="lp-add-badweek"]'),
    lands: T('[data-testid="lp-add-lands"]'),
    /* NAV */
    back: T('[data-testid="lp-back"]'),
    backH: q('[data-testid="lp-back"]') ? R(q('[data-testid="lp-back"]')).h : null,
    switcher: [...document.querySelectorAll('[data-testid="lp-fieldswitch"] option')].map((o) => o.textContent.trim()),
    switcherSel: q('[data-testid="lp-fieldswitch"]')?.selectedOptions[0]?.textContent.trim() ?? null,
    switcherH: q('[data-testid="lp-fieldswitch"]') ? R(q('[data-testid="lp-fieldswitch"]')).h : null,
    tickH: Math.min(...[...document.querySelectorAll(".lp-tick")].filter(vis)
      .map((e) => e.getBoundingClientRect().height), Infinity),
    /* ORDER DOWN THE PAGE */
    order: (() => {
      const c = q('[data-testid="lp-count"]')?.getBoundingClientRect();
      const t = q('[data-testid="lp-weeks"]')?.getBoundingClientRect();
      const g = q('[data-testid="lp-group"]')?.getBoundingClientRect();
      return c && t && g ? c.bottom <= t.top + 1 && t.bottom <= g.top + 1 : null;
    })(),
  };
};

/** The in-memory field_launch_tasks store the page drives. Starts empty so seeding runs for real. */
function makeStore() {
  const rows = [];
  let nextId = 7_000_000;
  return {
    rows,
    inserted: [],
    add(r) { const row = { id: nextId++, done: false, na: false, owner_user_id: null, department: null, ...r }; rows.push(row); return row; },
    patch(id, p) { const r = rows.find((x) => x.id === id); if (r) Object.assign(r, p); return r; },
    del(id) { const i = rows.findIndex((x) => x.id === id); if (i >= 0) rows.splice(i, 1); },
  };
}

async function boot(browser, storageState, width, days, opts = {}) {
  const ctx = await browser.newContext({
    storageState, viewport: { width, height: opts.height ?? 1400 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}),
  });
  const store = makeStore();
  const venue = { id: VENUE, venue_name: "Crossbar Rowlett", city: "Dallas", launch_date: isoOffset(days),
    billing_type: "per_match", is_active: true };
  const venues = [venue, ...OTHERS.map((o) => ({ id: o.id, venue_name: o.name, city: "Austin",
    launch_date: isoOffset(o.days), billing_type: "per_match", is_active: true }))];
  const cards = venues.map((v, i) => ({
    id: `00000000-0000-4000-8000-${String(910000 + i).padStart(12, "0")}`,
    board_type: "field_pipeline", title: v.venue_name, stage: "confirmed",
    owner_user_id: opts.owner ?? null, sort_order: i + 1, data: { city: v.city }, venue_id: v.id,
  }));

  await ctx.route("**/rest/v1/fin_venues*", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify(/id=eq\./.test(r.request().url()) ? venue : venues) })
      : r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/rest/v1/kanban_cards*", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(r.request().method() === "GET" ? cards : []) }));

  /* THE STORE. Only the query shapes this page actually sends are handled; anything else returns
   * 400 so an unhandled query fails loudly instead of quietly reading as "no tasks". */
  await ctx.route("**/rest/v1/field_launch_tasks*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const m = req.method();
    const single = (req.headers()["accept"] ?? "").includes("pgrst.object");
    const jsonOut = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (m === "GET") {
      const ids = idsFrom(url.searchParams.get("venue_id"));
      let out = store.rows.filter((r) => ids.includes(r.venue_id));
      if (url.searchParams.get("template_key") === "not.is.null") out = out.filter((r) => r.template_key != null);
      return jsonOut(out);
    }
    if (m === "POST") {
      const body = JSON.parse(req.postData() || "[]");
      const rows = Array.isArray(body) ? body : [body];
      /* ── THE PARTIAL UNIQUE INDEX, SIMULATED ─────────────────────────────────────────────
       * field_launch_tasks_venue_key is unique on (venue_id, template_key) where template_key is
       * not null. Without it here the store would accept a second copy of the plan and the suite
       * would pass on 48 tasks — which is exactly the bug it caught the first time it ran. An
       * insert that violates it fails WHOLE, as PostgREST does, and the app treats that as the
       * other tab having won. */
      const clash = rows.find((r) => r.template_key != null
        && store.rows.some((x) => x.venue_id === r.venue_id && x.template_key === r.template_key));
      if (clash) {
        return route.fulfill({ status: 409, contentType: "application/json",
          body: JSON.stringify({ code: "23505", message: 'duplicate key value violates unique constraint "field_launch_tasks_venue_key"' }) });
      }
      const made = rows.map((r) => store.add(r));
      store.inserted.push(...made);
      return route.fulfill({ status: 201, contentType: "application/json",
        body: JSON.stringify(single ? made[0] : made) });
    }
    if (m === "PATCH") {
      const id = Number((url.searchParams.get("id") ?? "").replace("eq.", ""));
      store.patch(id, JSON.parse(req.postData() || "{}"));
      return route.fulfill({ status: 204, body: "" });
    }
    if (m === "DELETE") {
      const id = Number((url.searchParams.get("id") ?? "").replace("eq.", ""));
      /* THE DELETE CARRIES template_key=is.null — only a task somebody ADDED is removable, and the
       * query says so rather than trusting the button. Refusing it here is what proves that. */
      const row = store.rows.find((r) => r.id === id);
      if (url.searchParams.get("template_key") !== "is.null" || row?.template_key != null) {
        return route.fulfill({ status: 204, body: "" });
      }
      store.del(id);
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ status: 400, body: "unhandled" });
  });

  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(`${BASE}/growth/launch/${VENUE}`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="lp-group"]', { timeout: 120000 });
  await p.waitForTimeout(900);
  return { ctx, p, store, errs, venue };
}

const idsFrom = (raw) => {
  if (!raw) return [];
  if (raw.startsWith("in.")) return raw.slice(3).replace(/[()]/g, "").split(",").map(Number);
  if (raw.startsWith("eq.")) return [Number(raw.slice(3))];
  return [];
};

const openAll = async (p) => {
  for (const k of ["pre", "launch", "post"]) {
    const open = await p.$eval(`[data-phase="${k}"]`, (e) => e.dataset.open === "1").catch(() => true);
    if (!open) { await p.click(`[data-phase="${k}"] .lp-gh`); await p.waitForTimeout(180); }
  }
  await p.waitForTimeout(120);
};

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();
  const template = nonEmpty(readTemplate(), "playbook template tasks");

  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: admins } = await sb.from("app_users").select("id, full_name, email").eq("is_admin", true).limit(1);
  const owner = nonEmpty(admins ?? [], "admin app_users")[0].id;

  const PRE = 27, WIN = -9, POST = -53;
  console.log(`\nweeks: pre=${weekOfOffset(PRE)} window=${weekOfOffset(WIN)} post=${weekOfOffset(POST)}`);

  // ══ 1. SEEDING, AND THE HERO BEFORE LAUNCH ════════════════════════════════════════════════
  {
    const { ctx, p, store, errs } = await boot(browser, storageState, 980, PRE, { owner });
    console.log("\n-- before launch (week 1) --");
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  no horizontal scroll", !d.hscroll);

    is("  opening a plan with no rows seeds 24 tasks", store.inserted.length, 24);
    is("  every one carries a template key", store.inserted.filter((r) => r.template_key).length, 24);
    is("  none carries a launch date — the date lives on fin_venues alone",
      store.inserted.filter((r) => "launch_date" in r || "launch" in r).length, 0);
    is("  they all belong to this field", [...new Set(store.inserted.map((r) => r.venue_id))], [VENUE]);
    const seededCoord = store.inserted.filter((r) => r.owner_user_id === owner).length;
    const wantCoord = template.filter((t) => t.coordinator).length;
    is(`  the ${wantCoord} Launch Coordinator tasks are seeded to the card's owner`, seededCoord, wantCoord);
    is("  and the rest start visibly unassigned",
      store.inserted.filter((r) => r.owner_user_id == null).length, 24 - wantCoord);

    is(`  the countdown is the hero number`, d.count, String(PRE));
    yes(`  labelled as days to launch: "${d.label}"`, /DAYS TO LAUNCH/.test(d.label ?? ""));
    yes(`  with the date under it: "${d.date}"`, /\d{4}/.test(d.date ?? ""));
    yes(`  and the phase named: "${d.phase}"`, /BUILD-UP/.test(d.phase ?? ""));
    is("  progress starts at 0 of 24", d.done, "0 of 24 done");
    /* IN WEEK 1 NOTHING CAN BE LATE, and the page must not invent an alarm. */
    is("  in week 1 nothing is overdue, and nothing pretends to be", d.overdue, null);
    is("  CONTROL: so the meter carries one fill, not two", d.barFills.length, 1);
    yes("  the meter is labelled for a screen reader", !!d.barLabel);

    // ══ THE TIMELINE ══
    is("  twenty weeks, one cell each", d.weeks.length, 20);
    const today = d.weeks.filter((w) => w.today === "1");
    is(`  today is marked exactly once, on week ${today[0]?.w}`, today.length, 1);
    is("  and it is week 1", today[0]?.w, String(weekOfOffset(PRE)));
    yes("  weeks 1-4 band as build-up", d.weeks.slice(0, 4).every((w) => w.ph === "pre"));
    yes("  5-8 as the launch window", d.weeks.slice(4, 8).every((w) => w.ph === "launch"));
    yes("  9-20 as sustain", d.weeks.slice(8).every((w) => w.ph === "post"));
    const hs = d.weeks.map((w) => w.h);
    yes(`  the bars vary (${new Set(hs).size} distinct heights)`, new Set(hs).size >= 4);
    const peak = hs.indexOf(Math.max(...hs)) + 1;
    yes(`  and peak inside the launch window (week ${peak})`, peak >= 5 && peak <= 8);
    yes("  CONTROL: the last week is not the peak — the shape is real, not flat", hs[19] < Math.max(...hs));
    is("  the three phases are named under the strip", d.bands.length, 3);
    yes(`  with a ${d.weeksGap} gap between marks`, parseFloat(d.weeksGap ?? "0") >= 2);
    yes("  countdown, then the timeline, then the tasks — in that order", d.order === true);

    // ══ THE GROUPING FIX ══
    const totals = d.groups.map((g) => Number((g.count ?? "").split("/")[1]?.split(" ")[0]));
    is(`  the three phases hold all 24 tasks (${totals.join(" + ")})`, totals.reduce((a, x) => a + x, 0), 24);
    yes(`  and no phase is empty (${totals.join(" / ")})`, totals.every((n) => n > 0));
    yes(`  nor does one phase swallow the plan (biggest is ${Math.max(...totals)})`, Math.max(...totals) <= 12);
    /* A TASK BELONGS TO THE PHASE ITS DEADLINE FALLS IN. On the start week this was 18/5/0. */
    const byDeadline = { pre: 0, launch: 0, post: 0 };
    for (const t of template) byDeadline[t.w2 <= 4 ? "pre" : t.w2 <= 8 ? "launch" : "post"] += 1;
    is("  grouped by DEADLINE, not by start week", totals, [byDeadline.pre, byDeadline.launch, byDeadline.post]);

    // ══ ONLY THE CURRENT PHASE IS OPEN ══
    const open = d.groups.filter((g) => g.open === "1").map((g) => g.phase);
    is("  only the phase you are in is open", open, ["pre"]);
    is("  every phase shows its own count even when collapsed", d.groups.filter((g) => g.count).length, 3);
    yes(`  only that phase's tasks are on screen (${d.tasksShown} of ${d.tasksInDom})`,
      d.tasksShown > 0 && d.tasksShown < 24);
    is("  and the collapsed ones are rendered, so opening needs no refetch", d.tasksInDom, 24);

    // ══ STATUS, SCOPE, OWNERS — measured across all 24 ══
    await openAll(p);
    const a = await p.evaluate(READ);
    is("  with every phase open, all 24 tasks are on screen", a.tasksShown, 24);
    yes(`  every task carries a written state (${a.states.length})`,
      a.states.every((s) => /OVERDUE|DUE NOW|NOT YET|DONE|N\/A/.test(s ?? "")));
    yes(`  and the states differ in colour too (${a.stateInks})`, a.stateInks >= 2);
    is("  scope carries no colour dot — seven hues cannot be told apart", a.dots, 0);
    is(`  all seven scopes are named in words`, a.scopes.length, 7);
    yes("  including the new Ops scope", a.scopes.includes("Ops"));
    is("  CONTROL: every scope chip wears the same ink — no text in a series colour", a.scopeInks, 1);
    yes(`  every task has an owner control (${a.owners.length})`, a.owners.every((o) => o != null));
    const un = a.owners.filter((o) => o.un === "1");
    const asg = a.owners.filter((o) => o.un === "0");
    yes(`  an unassigned task is possible (${un.length})`, un.length > 0);
    yes(`  and says Assign rather than sitting blank: "${un[0].text}"`, /Assign/.test(un[0].text));
    yes(`  CONTROL: assigned and unassigned look different (${un[0].border} vs ${asg[0]?.border})`,
      asg.length > 0 && un[0].border !== asg[0].border);
    yes(`  and the control is ${Math.min(...a.owners.map((o) => o.h))}px — pressable`,
      a.owners.every((o) => o.h >= 26));
    is("  every playbook task offers N/A", a.naButtons, 24);
    is("  CONTROL: and none of them offers Remove", a.removeButtons, 0);

    // ══ SORTING WITHIN A GROUP ══
    const RANK = { over: 0, now: 1, soon: 2, done: 3, na: 4 };
    for (const g of a.groups) {
      yes(`  ${g.phase}: late and live sort above the rest (${g.order.join(" → ")})`,
        g.order.every((s, i) => i === 0 || RANK[g.order[i - 1]] <= RANK[s]));
    }

    // ══ WHICH PHASES ARE OPEN IS STATE, AND SURVIVES AN EDIT ══
    await p.click('[data-phase="pre"] .lp-gh'); await p.waitForTimeout(200);
    const shut = await p.evaluate(READ);
    is("  a phase can be closed", shut.groups.filter((g) => g.open === "1").map((g) => g.phase).sort(), ["launch", "post"]);
    const before = shut.groups.filter((g) => g.open === "1").map((g) => g.phase).sort();
    await p.click('[data-phase="post"] [data-testid="lp-na"]'); await p.waitForTimeout(400);
    const after = (await p.evaluate(READ)).groups.filter((g) => g.open === "1").map((g) => g.phase).sort();
    is(`  an edit leaves the groups as the operator left them (${after.join(", ")})`, after, before);
    /* UNDO THE ONE THAT IS ACTUALLY N/A, not "the first N/A button" — marking a task N/A re-sorts
     * it to the bottom of its group, so a second blind click lands on a DIFFERENT task and quietly
     * leaves two of them skipped. That is what made every later denominator read 22. */
    await p.click('[data-phase="post"] [data-testid="lp-task"][data-state="na"] [data-testid="lp-na"]');
    await p.waitForTimeout(400);
    is("  CONTROL: and the N/A is undone before anything else is measured",
      (await p.evaluate(READ)).naRows.length, 0);

    // ══ N/A ══
    await openAll(p);
    const pre = await p.evaluate(READ);
    is("  the denominator starts at 24", pre.done, "0 of 24 done");
    const actBefore = pre.weeks.map((w) => w.h);
    await p.click('[data-testid="lp-na"]'); await p.waitForTimeout(450);
    const na1 = await p.evaluate(READ);
    is("  marking one N/A drops the denominator", na1.done, "0 of 23 done");
    yes(`  and says how many are N/A: "${na1.pline}"`, /1 N\/A/.test(na1.pline ?? ""));
    is("  the task is still on the page — N/A is not deletion", na1.tasksInDom, 24);
    is("  and it reads as N/A", na1.naRows.length, 1);
    yes(`  struck through, not just faint (${na1.naRows[0].deco})`, /line-through/.test(na1.naRows[0].deco));
    yes("  the timeline stops counting it too",
      JSON.stringify(actBefore) !== JSON.stringify(na1.weeks.map((w) => w.h)));
    is("  CONTROL: and the template in code is untouched", readTemplate().length, 24);
    await p.click('[data-testid="lp-task"][data-state="na"] [data-testid="lp-na"]'); await p.waitForTimeout(450);
    const back = await p.evaluate(READ);
    is("  putting it back restores the denominator", back.done, "0 of 24 done");
    is("  and it is a normal task again", back.naRows.length, 0);

    // ══ TICKING ══
    await p.click('[data-testid="lp-task"] .lp-tick'); await p.waitForTimeout(400);
    is("  ticking a task counts it", (await p.evaluate(READ)).done, "1 of 24 done");
    await p.click('[data-testid="lp-task"][data-done="1"] .lp-tick'); await p.waitForTimeout(400);
    is("  CONTROL: and unticking takes it back", (await p.evaluate(READ)).done, "0 of 24 done");

    // ══ ADDING A TASK FOR THIS CITY ══
    await p.click('[data-testid="lp-add"]'); await p.waitForTimeout(300);
    const dlg = await p.evaluate(READ);
    yes("  a task can be added for this field", dlg.dlgOpen);
    yes(`  and it says the plan, not the playbook, is what changes: "${(dlg.dlg ?? "").slice(0, 60)}…"`,
      /this field/i.test(dlg.dlg ?? "") && /playbook/i.test(dlg.dlg ?? ""));
    is("  with no title and no weeks it cannot be saved", dlg.addSaveDisabled, true);
    await p.fill('[data-testid="lp-add-title"]', "Get the HOA notice posted at the gate");
    await p.fill('[data-testid="lp-add-w1"]', "9");
    await p.fill('[data-testid="lp-add-w2"]', "3"); await p.waitForTimeout(300);
    const bw = await p.evaluate(READ);
    yes(`  an end week before the start is refused with the reason: "${bw.badWeek}"`, bw.badWeek != null);
    is("  and cannot be saved", bw.addSaveDisabled, true);
    await p.fill('[data-testid="lp-add-w2"]', "11"); await p.waitForTimeout(300);
    const gw = await p.evaluate(READ);
    yes(`  a valid range names the phase it lands in: "${gw.lands}"`, /Sustain/.test(gw.lands ?? ""));
    is("  and can be saved", gw.addSaveDisabled, false);
    await p.click('[data-testid="lp-add-save"]'); await p.waitForTimeout(500);
    await openAll(p);
    const added = await p.evaluate(READ);
    is("  the added task counts", added.done, "0 of 25 done");
    is("  it is marked as added here, so nobody mistakes it for playbook", added.custom, 1);
    const inPost = added.groups.find((g) => g.phase === "post");
    yes("  and it sits in Sustain, where its deadline put it",
      inPost.titles.includes("Get the HOA notice posted at the gate"));
    is("  CONTROL: the template STILL holds 24 — the next field does not inherit it", readTemplate().length, 24);
    is("  and the insert carried no template key", store.inserted.filter((r) => r.template_key === null).length, 1);

    // ══ REMOVE, WHICH ASKS FIRST ══
    is("  exactly one task offers Remove", added.removeButtons, 1);
    is("  CONTROL: and the playbook ones still offer N/A", added.naButtons, 24);
    await p.click('[data-testid="lp-remove"]'); await p.waitForTimeout(300);
    yes("  removing asks first rather than acting on one tap",
      (await p.evaluate(READ)).rmConfirm != null);
    await p.click('[data-testid="lp-rm-no"]'); await p.waitForTimeout(300);
    is("  CONTROL: Keep it leaves the task alone", (await p.evaluate(READ)).done, "0 of 25 done");
    await p.click('[data-testid="lp-remove"]'); await p.waitForTimeout(250);
    await p.click('[data-testid="lp-rm-yes"]'); await p.waitForTimeout(500);
    const gone = await p.evaluate(READ);
    is("  and Remove takes it out", gone.done, "0 of 24 done");
    is("  with nothing left behind", gone.custom, 0);
    /* THE POSITIVE CONTROL COMES FIRST. "no custom rows remain" is zero, and an empty store prints
     * the same zero — so prove the 24 playbook rows are still there before believing it. */
    const left = nonEmpty(store.rows, "task rows after the removal");
    is("  no playbook row was deleted with it", left.length, 24);
    is("  and the store agrees the added one is gone", left.filter((r) => r.template_key === null).length, 0);

    // ══ BACK, AND SIDEWAYS ══
    yes(`  there is a way back to all launches: "${gone.back}"`, /All launches/.test(gone.back ?? ""));
    yes(`  and the back control is ${gone.backH}px`, (gone.backH ?? 0) >= 36);
    yes(`  a switcher lists the other plans (${gone.switcher.length})`, gone.switcher.length >= 4);
    yes("  each carrying its own countdown, so you can pick by urgency",
      gone.switcher.every((o) => /\d+d (to launch|since)/.test(o)));
    yes(`  the plan you are on is the one selected: "${gone.switcherSel}"`,
      /Crossbar Rowlett/.test(gone.switcherSel ?? ""));
    const swd = gone.switcher.map((o) => { const m = /(\d+)d (to launch|since)/.exec(o); return m[2] === "since" ? -Number(m[1]) : Number(m[1]); });
    const up = swd.filter((x) => x >= 0);
    yes(`  ordered nearest-launch-first: ${swd.join(", ")}`, up.every((x, i) => i === 0 || up[i - 1] <= x));
    yes(`  the switcher is ${gone.switcherH}px`, (gone.switcherH ?? 0) >= 36);
    yes("  CONTROL: a plan past week 20 is not offered", !gone.switcher.some((o) => /PRUMC/.test(o)));
    await closeContext(ctx);
  }

  // ══ 2. THE SAME HERO, INSIDE THE WINDOW AND AFTER IT ══════════════════════════════════════
  let overWindow = 0;
  {
    const { ctx, p, errs } = await boot(browser, storageState, 980, WIN, { owner });
    console.log("\n-- inside the launch window --");
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    const w = weekOfOffset(WIN);
    is(`  it reads the launch week, never a negative countdown`, d.count, String(w - 4));
    yes(`  labelled launch week of 4: "${d.label}"`, /LAUNCH WEEK OF 4/.test(d.label ?? ""));
    yes(`  and the phase follows: "${d.phase}"`, /LAUNCH WINDOW/.test(d.phase ?? ""));
    yes("  the number is 1-4, and launch day itself is week 1 not zero", Number(d.count) >= 1 && Number(d.count) <= 4);
    yes("  once windows have closed, overdue is called out separately", d.overdue != null);
    overWindow = Number((d.overdue ?? "").replace(/\D+/g, ""));
    const wantOver = readTemplate().filter((t) => t.w2 < w).length;
    is(`  and it is the count of closed windows (${wantOver})`, overWindow, wantOver);
    is("  the meter carries both done and overdue as separate fills", d.barFills.length, 2);
    yes(`  and a ${d.barGap} surface gap between them`, parseFloat(d.barGap ?? "0") >= 2);
    is(`  today is marked on week ${w}`, d.weeks.filter((x) => x.today === "1")[0]?.w, String(w));
    is("  CONTROL: only the phase you are in is open", d.groups.filter((g) => g.open === "1").map((g) => g.phase), ["launch"]);
    const g = d.groups.find((x) => x.phase === "pre");
    yes(`  a collapsed phase still names its overdue count: "${g.count}"`, /overdue/.test(g.count ?? ""));
    await closeContext(ctx);
  }
  {
    const { ctx, p, errs } = await boot(browser, storageState, 980, POST, { owner });
    console.log("\n-- after the window --");
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  it counts up from the date", d.count, String(Math.abs(POST)));
    yes(`  labelled days since launch: "${d.label}"`, /DAYS SINCE LAUNCH/.test(d.label ?? ""));
    yes(`  and the phase follows again: "${d.phase}"`, /SUSTAIN/.test(d.phase ?? ""));
    const now = Number((d.overdue ?? "").replace(/\D+/g, ""));
    yes(`  CONTROL: overdue grows as more windows close (${overWindow} → ${now})`, now > overWindow);
    is("  CONTROL: and the open phase follows the date", d.groups.filter((g) => g.open === "1").map((g) => g.phase), ["post"]);
    await closeContext(ctx);
  }

  // ══ 3. EDITING ONE FIELD'S PLAN DOES NOT TOUCH ANOTHER'S ══════════════════════════════════
  {
    const { ctx, p, store } = await boot(browser, storageState, 980, PRE, { owner });
    console.log("\n-- one field's plan is its own --");
    /* A SECOND FIELD'S PLAN, seeded into the same store, so "it did not touch the other one" is a
     * claim about rows rather than about two pages that never met. */
    const other = 900202;
    for (const t of template) {
      store.add({ venue_id: other, template_key: t.key, title: t.title, scope: t.scope,
        week_start: t.w1, week_end: t.w2, sort_order: 1 });
    }
    const snapshot = JSON.stringify(store.rows.filter((r) => r.venue_id === other));
    await openAll(p);
    await p.click('[data-testid="lp-na"]'); await p.waitForTimeout(400);
    await p.click('[data-testid="lp-task"] .lp-tick'); await p.waitForTimeout(400);
    const mine = store.rows.filter((r) => r.venue_id === VENUE);
    yes("  the edit landed on this field", mine.some((r) => r.na) || mine.some((r) => r.done));
    is("  and the other field's 24 rows are byte-identical",
      JSON.stringify(store.rows.filter((r) => r.venue_id === other)), snapshot);
    await closeContext(ctx);
  }

  // ══ 4. MOVING THE LAUNCH DATE MOVES EVERY DATE ════════════════════════════════════════════
  // The date lives on fin_venues alone, so this is one write and the whole page follows.
  {
    const a = await boot(browser, storageState, 980, PRE, { owner });
    const before = await a.p.evaluate(READ);
    await closeContext(a.ctx);
    /* PULLED 14 DAYS FORWARD, not pushed back: the plan has to stay inside its 20 weeks for the
     * today mark to have anywhere to move TO, and "the mark vanished" would satisfy a laxer
     * assertion while proving nothing. */
    const b = await boot(browser, storageState, 980, PRE - 14, { owner });
    const after = await b.p.evaluate(READ);
    console.log("\n-- moving the launch date --");
    is(`  before: ${before.count} days, week ${before.weeks.find((w) => w.today === "1")?.w}`, before.count, String(PRE));
    is(`  after pulling it 14 days forward: ${after.count} days`, after.count, String(PRE - 14));
    yes(`  the hero date moved too ("${before.date}" → "${after.date}")`, before.date !== after.date);
    const tB = before.weeks.find((w) => w.today === "1")?.w ?? null;
    const tA = after.weeks.find((w) => w.today === "1")?.w ?? null;
    yes(`  and the today mark moved with it (week ${tB} → week ${tA})`,
      tB != null && tA != null && tB !== tA, `one of the marks is missing: ${tB} / ${tA}`);
    is("  to the week the new date puts it in", tA, String(weekOfOffset(PRE - 14)));
    is("  CONTROL: no task row carries a date of its own", a.store.inserted.filter((r) => "launch_date" in r).length, 0);
    await closeContext(b.ctx);
  }

  // ══ 5. A PHONE ════════════════════════════════════════════════════════════════════════════
  for (const w of [390, 980]) {
    const { ctx, p, errs } = await boot(browser, storageState, w, WIN, { owner });
    console.log(`\n-- ${w}px --`);
    await openAll(p);
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  no horizontal scroll", !d.hscroll);
    is("  nothing spills right", d.spill, 0);
    yes(`  the countdown is still the biggest thing on screen (${d.countBox.h}px)`, d.countBox.h >= 40);
    yes(`  the phase headers are ${Math.min(...d.groups.map((g) => g.headH))}px`,
      d.groups.every((g) => g.headH >= 44));
    yes(`  the tickboxes are ${d.tickH}px`, d.tickH >= 22);
    is("  no phase band is cut off", d.bands.filter((b) => b.clipped).map((b) => b.text), []);
    yes(`  and each still carries its week range: ${d.bands.map((b) => b.text).join(" / ")}`,
      d.bands.every((b) => /W\d+–\d+/.test(b.text)));
    if (w === 390) {
      yes(`  the 20-week strip fits the phone (${d.weeksBox.w}px) rather than scrolling`, d.weeksBox.w <= w - 16);
      is("  the bands drop the phase word at 390", d.bands.filter((b) => /BUILD-UP/.test(b.text)).length, 0);
      yes("  countdown, then timeline, then tasks", d.order === true);
    } else {
      yes(`  CONTROL: the full label comes back when there is room: "${d.bands[0].text}"`,
        /BUILD-UP/.test(d.bands[0].text));
    }
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\n${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  XX ${f}`); process.exit(1); }
}

main().catch(fatal);
