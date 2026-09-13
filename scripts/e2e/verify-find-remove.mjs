// FINDING A FIELD YOU CANNOT SPELL, AND REMOVING A PLAN THAT SHOULD NOT EXIST.
//
// Ryan: "some fields we might not want to have a launch plan for and should be able to remove it
// also the hattrick and some fields no way to says its hattrick leander."
//
// NOTHING REACHES THE DATABASE. The plan half runs against an IN-MEMORY STORE inside the route
// handler — fin_venues (including launch_plan_disabled_at), kanban_cards and field_launch_tasks —
// so removing, restarting and RELOADING all round-trip for real. That is the only way to prove the
// one thing that must not be wrong: that a removed plan stays removed across a page load, because
// LaunchPlanView seeds on open as a repair and would otherwise write it straight back.
//
// THE CANDIDATE HALF READS PRODUCTION and writes nothing.
//
//   node scripts/e2e/verify-find-remove.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
import { readTemplate } from "./_launchFixtures.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const VENUE = 900301;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

const norm = (s) => String(s ?? "").trim().toLowerCase();
const isoOffsetDays = (n) => {
  const t = new Date();
  const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + n);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ══════════════════════════════════════════════════════════════════════════════════════════════
// PART A — THE CANDIDATE LIST, on the real board
// ══════════════════════════════════════════════════════════════════════════════════════════════

const READ_BOARD = () => {
  const q = (s) => document.querySelector(s);
  const T = (s) => q(s)?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const vw = document.documentElement.clientWidth;
  const save = q('[data-testid="bind-save"]');
  return {
    vw, hscroll: document.documentElement.scrollWidth > vw + 2,
    name: q('[data-testid="bind-newname"]')?.value ?? null,
    launch: q('[data-testid="bind-launch"]')?.value ?? null,
    match: T('[data-testid="bind-match"]'),
    dupe: T('[data-testid="bind-dupe"]'),
    save: save ? { mode: save.dataset.mode, disabled: save.disabled, text: save.textContent.trim() } : null,
    candsOpen: q('[data-testid="bind-cands"]') != null,
    candsHd: T('[data-testid="bind-cands-hd"]'),
    cands: [...document.querySelectorAll('[data-testid="cand"]')].map((c) => ({
      id: c.dataset.id, held: c.dataset.held, disabled: c.disabled,
      name: c.querySelector(".cn")?.textContent.trim() ?? "",
      meta: c.querySelector(".cm")?.textContent.trim() ?? "",
      h: +c.getBoundingClientRect().height.toFixed(1),
      bg: getComputedStyle(c).backgroundColor,
      clipped: (() => { const n = c.querySelector(".cn"); return n ? n.scrollWidth > n.clientWidth + 1 : false; })(),
    })),
  };
};

async function bootBoard(browser, storageState, width) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: 1100 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });
  const writes = [];
  for (const t of ["fin_venues", "kanban_cards", "field_launch_tasks"]) {
    await ctx.route(`**/rest/v1/${t}*`, async (route) => {
      const m = route.request().method();
      if (m === "GET" || m === "HEAD") {
        return t === "field_launch_tasks"
          ? route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
          : route.fallback();
      }
      writes.push({ table: t, method: m });
      return route.fulfill({ status: 204, body: "" });
    });
  }
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(`${BASE}/growth/field-pipeline`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="card"]', { timeout: 180000 });
  await p.waitForTimeout(1400);
  return { ctx, p, writes, errs };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// PART B — THE PLAN PAGE, against a store that remembers
// ══════════════════════════════════════════════════════════════════════════════════════════════

const READ_PLAN = () => {
  const q = (s) => document.querySelector(s);
  const T = (s) => q(s)?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const vw = document.documentElement.clientWidth;
  const rm = q('[data-testid="plan-remove"]');
  return {
    vw, hscroll: document.documentElement.scrollWidth > vw + 2,
    tasks: document.querySelectorAll('[data-testid="lp-task"]').length,
    counter: q('[data-testid="lp-count"]') != null,
    done: T('[data-testid="lp-done"]'),
    remove: rm ? { h: +rm.getBoundingClientRect().height.toFixed(1), text: rm.textContent.trim() } : null,
    dlgOpen: q('[data-testid="rm-dialog"]') != null,
    sub: T('[data-testid="rm-sub"]'),
    loss: T('[data-testid="rm-loss"]'),
    sticky: T('[data-testid="rm-sticky"]'),
    dlgBtns: [...document.querySelectorAll('[data-testid="rm-dialog"] .lp-df button')]
      .map((b) => { const r = b.getBoundingClientRect();
        return { t: Math.round(r.top), l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom), h: +r.height.toFixed(1) }; }),
    dlgW: q('[data-testid="rm-dialog"]') ? +q('[data-testid="rm-dialog"]').getBoundingClientRect().width.toFixed(1) : null,
    gone: q('[data-testid="plan-gone"]') != null,
    why: T('[data-testid="plan-gone-why"]'),
    restart: q('[data-testid="plan-restart"]') != null,
  };
};

function makeStore(template, launchIso) {
  const venue = { id: VENUE, venue_name: "Keswick ATL Field 2", city: "Atlanta",
    launch_date: launchIso, billing_type: "per_match", is_active: true, launch_plan_disabled_at: null };
  const tasks = [];
  let nextId = 8_000_000;
  template.forEach((t, i) => tasks.push({ id: nextId++, venue_id: VENUE, template_key: t.key,
    title: t.title, scope: t.scope, department: t.department, week_start: t.w1, week_end: t.w2,
    sort_order: i + 1, done: false, na: false, owner_user_id: null }));
  return { venue, tasks, nextId: () => nextId++, seeds: 0, deletes: 0 };
}

async function bootPlan(browser, storageState, width, store) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: 1400 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });
  const j = (b) => ({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

  await ctx.route("**/rest/v1/fin_venues*", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill(j(/id=eq\./.test(req.url()) ? store.venue : [store.venue]));
    }
    if (req.method() === "PATCH") {
      /* THE TOMBSTONE IS REAL IN THIS STORE. That is what makes the reload assertion mean
       * something: the flag survives the page, so the repair pass has to see it. */
      Object.assign(store.venue, JSON.parse(req.postData() || "{}"));
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ status: 204, body: "" });
  });
  await ctx.route("**/rest/v1/kanban_cards*", (r) => r.fulfill(j(r.request().method() === "GET"
    ? [{ id: "00000000-0000-4000-8000-000000930001", board_type: "field_pipeline",
         title: "Keswick ATL Field 2", stage: "confirmed", owner_user_id: null, sort_order: 1,
         data: { city: "Atlanta" }, venue_id: VENUE }]
    : [])));
  await ctx.route("**/rest/v1/field_launch_tasks*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const m = req.method();
    if (m === "GET") {
      let out = store.tasks.filter((t) => String(t.venue_id) === String(VENUE));
      if (url.searchParams.get("template_key") === "not.is.null") out = out.filter((t) => t.template_key != null);
      return route.fulfill(j(out));
    }
    if (m === "POST") {
      const rows = JSON.parse(req.postData() || "[]");
      store.seeds += 1;
      for (const r of rows) store.tasks.push({ id: store.nextId(), done: false, na: false, owner_user_id: null, ...r });
      return route.fulfill({ status: 201, contentType: "application/json", body: "[]" });
    }
    if (m === "PATCH") {
      const id = Number((url.searchParams.get("id") ?? "").replace("eq.", ""));
      const row = store.tasks.find((t) => t.id === id);
      if (row) Object.assign(row, JSON.parse(req.postData() || "{}"));
      return route.fulfill({ status: 204, body: "" });
    }
    if (m === "DELETE") {
      const vid = Number((url.searchParams.get("venue_id") ?? "").replace("eq.", ""));
      if (vid) { store.deletes += 1; store.tasks = store.tasks.filter((t) => t.venue_id !== vid); }
      else {
        const id = Number((url.searchParams.get("id") ?? "").replace("eq.", ""));
        store.tasks = store.tasks.filter((t) => t.id !== id);
      }
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ status: 400, body: "unhandled" });
  });

  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(`${BASE}/growth/launch/${VENUE}`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="plan-remove"], [data-testid="plan-gone"]', { timeout: 120000 });
  await p.waitForTimeout(900);
  return { ctx, p, errs };
}

const openAll = async (p) => {
  for (const k of ["pre", "launch", "post"]) {
    const open = await p.$eval(`[data-phase="${k}"]`, (e) => e.dataset.open === "1").catch(() => true);
    if (!open) { await p.click(`[data-phase="${k}"] .lp-gh`); await p.waitForTimeout(160); }
  }
};

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();
  const template = nonEmpty(readTemplate(), "playbook template tasks");

  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: venues } = await sb.from("fin_venues").select("id,venue_name,city,launch_date");
  const { data: allCards } = await sb.from("kanban_cards").select("id,title,stage,venue_id").eq("board_type", "field_pipeline");
  const held = new Map();
  for (const c of allCards ?? []) if (c.venue_id != null) held.set(c.venue_id, c);

  /* ── A QUERY THAT PROVES BOTH HALVES AT ONCE, DERIVED NOT PINNED ────────────────────────────
   * The list has to show a field another card holds AND one it does not, in the same list, so the
   * "greyed but visible" rule and its control are about the same query. Which string does that
   * depends on the data on the day, so it is searched for rather than typed in. */
  const candFor = (t) => (venues ?? [])
    .filter((v) => norm(v.venue_name).includes(norm(t)) && norm(v.venue_name) !== norm(t))
    .slice(0, 6);
  let probe = null;
  for (const v of venues ?? []) {
    for (const w of norm(v.venue_name).split(/[^a-z0-9]+/).filter((x) => x.length >= 2)) {
      const cs = candFor(w);
      if (cs.length >= 2 && cs.some((c) => held.has(c.id)) && cs.some((c) => !held.has(c.id))) { probe = w; break; }
    }
    if (probe) break;
  }
  if (!probe) throw new Error("no search string yields both a held and a free candidate");
  const probeCands = candFor(probe);
  const heldCand = probeCands.find((c) => held.has(c.id));
  const freeCand = probeCands.find((c) => !held.has(c.id));
  const unboundCard = nonEmpty(
    (allCards ?? []).filter((c) => c.stage === "confirmed" && c.venue_id == null),
    "confirmed cards with no venue",
  )[0];
  console.log(`\nprobe "${probe}" -> ${probeCands.length} candidates`);
  console.log(`  held: #${heldCand.id} ${heldCand.venue_name} (by "${held.get(heldCand.id).title}")`);
  console.log(`  free: #${freeCand.id} ${freeCand.venue_name}`);
  console.log(`card used: "${unboundCard.title}"`);

  // ══ 11-15. THE CANDIDATE LIST ═════════════════════════════════════════════════════════════
  {
    const { ctx, p, writes, errs } = await bootBoard(browser, storageState, 1200);
    console.log("\n-- finding a field you cannot spell --");
    await p.click(`[data-testid="card"][data-id="${unboundCard.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(400);

    // 11. TWO CHARACTERS IS A SEARCH; ONE IS NOT.
    await p.fill('[data-testid="bind-newname"]', probe[0]);
    await p.waitForTimeout(350);
    let d = await p.evaluate(READ_BOARD);
    is("  CONTROL: one character is not a search", d.candsOpen, false);
    await p.fill('[data-testid="bind-newname"]', "zzzqx");
    await p.waitForTimeout(350);
    d = await p.evaluate(READ_BOARD);
    is("  CONTROL: and a string matching nothing lists nothing", d.candsOpen, false);

    await p.fill('[data-testid="bind-newname"]', probe);
    await p.waitForTimeout(450);
    d = await p.evaluate(READ_BOARD);
    is("  no page error", errs, []);
    yes(`  typing part of a name lists the fields that contain it (${d.cands.length})`, d.candsOpen);
    is("  and shows every one of them, capped", d.cands.length, probeCands.length);
    yes(`  the list says what it is showing: "${d.candsHd}"`,
      new RegExp(`match .${probe}.`).test(d.candsHd ?? ""));
    yes("  each candidate carries its city and launch date",
      d.cands.filter((c) => c.held === "0").every((c) => /launches|no launch date/.test(c.meta) && c.meta.length > 6));

    // 12. NOTHING IS SELECTED UNTIL A CLICK. This is the whole difference from auto-matching.
    is("  CONTROL: the box is untouched until a candidate is clicked", d.name, probe);
    is("  CONTROL: and nothing is offered as a link yet", d.match, null);
    is("  CONTROL: the action is still a create, because nothing has been picked", d.save.mode, "create");

    // 14. A HELD FIELD IS SHOWN, NOT HIDDEN.
    const hc = d.cands.find((c) => c.id === String(heldCand.id));
    const fc = d.cands.find((c) => c.id === String(freeCand.id));
    yes("  CONTROL: both a held and a free candidate are in the list", hc != null && fc != null);
    is("  a field another card holds is listed but cannot be picked", hc.disabled, true);
    is("  and is marked as held", hc.held, "1");
    yes(`  saying who has it: "${hc.meta}"`, /already linked to/.test(hc.meta));
    yes(`  naming the actual card`, hc.meta.includes(held.get(heldCand.id).title));
    is("  CONTROL: an unclaimed one in the same list is pickable", fc.disabled, false);
    yes(`  CONTROL: and the two look different (${hc.bg} vs ${fc.bg}), on top of the words`, hc.bg !== fc.bg);

    // 13. CLICKING ONE FILLS THE BOX AND RESOLVES.
    await p.click(`[data-testid="cand"][data-id="${freeCand.id}"]`);
    await p.waitForTimeout(500);
    d = await p.evaluate(READ_BOARD);
    is("  clicking a candidate fills the name", d.name, freeCand.venue_name);
    yes("  and it resolves to the offer it always did", d.match != null);
    is("  as a link, not a create", d.save.mode, "link");
    if (freeCand.launch_date) is("  with that field's launch date brought in", d.launch, freeCand.launch_date);
    is("  and the list steps out of the way once the name is exact", d.candsOpen, false);

    // CONTROL: clicking a held one does nothing.
    await p.fill('[data-testid="bind-newname"]', probe);
    await p.waitForTimeout(400);
    await p.click(`[data-testid="cand"][data-id="${heldCand.id}"]`, { force: true }).catch(() => {});
    await p.waitForTimeout(400);
    d = await p.evaluate(READ_BOARD);
    is("  CONTROL: clicking a held candidate changes nothing", d.name, probe);

    // 15. THE EXACT-NAME REFUSAL IS UNCHANGED.
    await p.fill('[data-testid="bind-newname"]', heldCand.venue_name);
    await p.waitForTimeout(500);
    d = await p.evaluate(READ_BOARD);
    yes("  typing a held field's exact name is still refused", d.dupe != null);
    yes("  naming that card", /already linked to the card/.test(d.dupe ?? ""));
    is("  and cannot be saved", d.save.disabled, true);
    is("  CONTROL: and no em-dash in it", /—/.test(d.dupe ?? ""), false);
    is("  nothing was written by any of this", writes, []);
    await closeContext(ctx);
  }

  // ══ 16. THE SAME LIST IS IN THE MATCH FIELDS ROWS ═════════════════════════════════════════
  {
    const { ctx, p, writes, errs } = await bootBoard(browser, storageState, 1200);
    console.log("\n-- and in the match fields rows --");
    await p.click('[data-testid="col-unlinked"]');
    await p.waitForSelector('[data-testid="match-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(600);
    await p.fill(`[data-testid="match-row"][data-id="${unboundCard.id}"] [data-testid="mr-name"]`, probe);
    await p.waitForTimeout(500);
    const cands = await p.$$eval(`[data-testid="match-row"][data-id="${unboundCard.id}"] [data-testid="cand"]`,
      (es) => es.map((e) => ({ id: e.dataset.id, held: e.dataset.held, disabled: e.disabled,
        name: e.querySelector(".cn")?.textContent.trim() ?? "" })));
    is("  no page error", errs, []);
    is("  a match row lists the same candidates", cands.length, probeCands.length);
    yes("  with the held one marked there too", cands.some((c) => c.held === "1" && c.disabled));
    await p.click(`[data-testid="match-row"][data-id="${unboundCard.id}"] [data-testid="cand"][data-id="${freeCand.id}"]`);
    await p.waitForTimeout(500);
    const row = await p.$eval(`[data-testid="match-row"][data-id="${unboundCard.id}"]`, (e) => ({
      name: e.querySelector('[data-testid="mr-name"]').value,
      res: e.querySelector('[data-testid="mr-res"]').textContent.replace(/\s+/g, " ").trim(),
    }));
    is("  clicking one fills that row", row.name, freeCand.venue_name);
    yes(`  and the row re-resolves to a link: "${row.res.slice(0, 44)}…"`, /Links to/.test(row.res));
    is("  nothing was written", writes, []);
    await closeContext(ctx);
  }

  // ══ 1-9. REMOVING A PLAN ══════════════════════════════════════════════════════════════════
  {
    const store = makeStore(template, isoOffsetDays(-11)); // inside the window, as Keswick is
    const { ctx, p, errs } = await bootPlan(browser, storageState, 1200, store);
    console.log("\n-- removing a plan --");
    await openAll(p);
    let d = await p.evaluate(READ_PLAN);
    is("  no page error", errs, []);
    is("  CONTROL: the plan is there to begin with", d.tasks, 24);
    is("  CONTROL: and the repair pass did not re-seed it", store.seeds, 0);

    // 1. THE CONTROL.
    yes("  the plan page carries a way to remove the plan", d.remove != null);
    yes(`  as a quiet control, not a hazard (${d.remove.h}px)`, d.remove.h <= 36);
    is("  CONTROL: and it does not delete anything on its own", d.dlgOpen, false);
    is("  CONTROL: nothing deleted yet", store.deletes, 0);

    // 2. THE CONFIRM COUNTS WHAT IS BEING THROWN AWAY.
    await p.click('[data-testid="plan-remove"]');
    await p.waitForTimeout(400);
    d = await p.evaluate(READ_PLAN);
    yes("  it asks first", d.dlgOpen);
    yes(`  naming the field: "${d.sub}"`, /Keswick ATL Field 2/.test(d.sub ?? ""));
    const loss0 = d.loss;
    yes(`  and the count: "${(loss0 ?? "").slice(0, 48)}…"`, /24 tasks/.test(loss0 ?? ""));
    yes("  and that nothing anybody did is lost, because nothing was ticked",
      /nothing anybody did is lost/.test(loss0 ?? ""));

    // 3. WHAT SURVIVES IT.
    yes(`  and what it does NOT touch: "${(d.sticky ?? "").slice(0, 52)}…"`,
      /field, its launch date and this card all stay/.test(d.sticky ?? ""));
    yes("  including that the repair pass will not re-seed it", /not come back on its own/.test(d.sticky ?? ""));
    is("  CONTROL: no em-dash", /—/.test(d.sticky ?? ""), false);

    // 4. CANCEL CHANGES NOTHING.
    await p.click('[data-testid="rm-cancel"]');
    await p.waitForTimeout(400);
    await openAll(p);
    d = await p.evaluate(READ_PLAN);
    is("  Cancel closes it", d.dlgOpen, false);
    is("  CONTROL: and the plan is still there", d.tasks, 24);
    is("  CONTROL: with nothing deleted", store.deletes, 0);

    // 2 CONTROL: A PLAN SOMEBODY HAS WORKED SAYS SOMETHING DIFFERENT.
    await p.click('[data-testid="lp-task"] .lp-tick');
    await p.waitForTimeout(400);
    await p.click('[data-testid="lp-na"]');
    await p.waitForTimeout(400);
    await p.click('[data-testid="plan-remove"]');
    await p.waitForTimeout(400);
    d = await p.evaluate(READ_PLAN);
    const loss1 = d.loss;
    yes(`  CONTROL: a plan somebody HAS worked says how much: "${(loss1 ?? "").slice(0, 60)}…"`,
      /including/.test(loss1 ?? "") && /2/.test(loss1 ?? ""));
    yes("  CONTROL: and that it is not recoverable", /not recoverable/.test(loss1 ?? ""));
    yes("  CONTROL: the two are not the same sentence", loss0 !== loss1);

    // 5. AFTER IT IS GONE.
    await p.click('[data-testid="rm-yes"]');
    await p.waitForTimeout(1200);
    d = await p.evaluate(READ_PLAN);
    yes("  a removed plan says so", d.gone);
    is("  CONTROL: with no tasks left on the page", d.tasks, 0);
    is("  CONTROL: and no launch-week counter, because there is nothing to count", d.counter, false);
    yes(`  and when: "${(d.why ?? "").slice(0, 44)}…"`, /Somebody removed it on/.test(d.why ?? ""));
    yes("  and that the field itself is unharmed", /still a field with a launch date/.test(d.why ?? ""));
    yes("  saying what starting one would do", /dated from that same launch date/.test(d.why ?? ""));
    yes("  and a plan can be started again from here", d.restart);
    is("  the rows really went", store.tasks.length, 0);
    yes("  the tombstone was written", store.venue.launch_plan_disabled_at != null);

    // 6. IT HAS TO BE STICKY. THIS IS THE ONE THAT MUST NOT BE WRONG.
    await closeContext(ctx);
    const again = await bootPlan(browser, storageState, 1200, store);
    console.log("\n-- and it stays removed across a page load --");
    const d2 = await again.p.evaluate(READ_PLAN);
    is("  no page error", again.errs, []);
    yes("  reloading the plan page still shows it removed", d2.gone);
    is("  the rows are still gone", d2.tasks, 0);
    is("  CONTROL: and the repair pass wrote nothing back", store.seeds, 0);
    is("  CONTROL: the store agrees", store.tasks.length, 0);

    // 8. START A PLAN CLEARS THE FLAG AND SEEDS.
    await again.p.click('[data-testid="plan-restart"]');
    await again.p.waitForTimeout(1600);
    await openAll(again.p);
    const d3 = await again.p.evaluate(READ_PLAN);
    yes("  Start a plan brings the tasks back", d3.tasks === 24, `got ${d3.tasks}`);
    is("  CONTROL: and clears the removed notice", d3.gone, false);
    is("  the flag was cleared", store.venue.launch_plan_disabled_at, null);
    is("  and exactly one seed ran", store.seeds, 1);
    /* THE PARTIAL UNIQUE INDEX MUST STILL HOLD after a remove-then-restart: 24 keys, no doubles. */
    is("  with no duplicate template keys", new Set(store.tasks.map((t) => t.template_key)).size, 24);
    is("  CONTROL: and 24 rows, not 48", store.tasks.length, 24);
    await closeContext(again.ctx);
  }

  // ══ 7. seedLaunchPlan REFUSES ON THE FLAG BY ITSELF ═══════════════════════════════════════
  {
    const store = makeStore(template, isoOffsetDays(-11));
    store.tasks = [];
    store.venue.launch_plan_disabled_at = new Date().toISOString();
    const { ctx, p, errs } = await bootPlan(browser, storageState, 1200, store);
    console.log("\n-- the flag alone is enough to refuse --");
    const d = await p.evaluate(READ_PLAN);
    is("  no page error", errs, []);
    is("  opening a flagged plan with NO rows seeds nothing", store.seeds, 0);
    is("  CONTROL: and writes no rows", store.tasks.length, 0);
    yes("  the page says it was removed rather than drawing an empty plan", d.gone);
    await closeContext(ctx);
  }
  {
    /* CONTROL: the SAME store with the flag clear seeds all 24, so the refusal is the flag and not
     * something else about this fixture. */
    const store = makeStore(template, isoOffsetDays(-11));
    store.tasks = [];
    const { ctx, p } = await bootPlan(browser, storageState, 1200, store);
    await p.waitForTimeout(900);
    is("  CONTROL: with the flag clear, the same plan seeds", store.seeds, 1);
    is("  CONTROL: all 24 of it", store.tasks.length, 24);
    await closeContext(ctx);
  }

  // ══ 9. THE INDEX DOES NOT COUNT A REMOVED PLAN ════════════════════════════════════════════
  {
    const store = makeStore(template, isoOffsetDays(-11));
    store.venue.launch_plan_disabled_at = new Date().toISOString();
    const ctx = await browser.newContext({ storageState, viewport: { width: 1200, height: 1100 } });
    const j = (b) => ({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    await ctx.route("**/rest/v1/fin_venues*", (r) => r.fulfill(j([store.venue])));
    await ctx.route("**/rest/v1/kanban_cards*", (r) => r.fulfill(j(r.request().method() === "GET"
      ? [{ id: "00000000-0000-4000-8000-000000930001", board_type: "field_pipeline", title: "Keswick ATL Field 2",
           stage: "confirmed", owner_user_id: null, sort_order: 1, data: {}, venue_id: VENUE }] : [])));
    await ctx.route("**/rest/v1/field_launch_tasks*", (r) => r.fulfill(j([])));
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    await p.goto(`${BASE}/growth/launch`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="li-field"], [data-testid="li-empty"]', { timeout: 120000 });
    await p.waitForTimeout(700);
    console.log("\n-- the index --");
    const seen = await p.evaluate(() => ({
      cards: document.querySelectorAll('[data-testid="li-field"]').length,
      sub: document.querySelector('[data-testid="li-sub"]')?.textContent.trim() ?? null,
      empty: document.querySelector('[data-testid="li-empty"]') != null,
    }));
    is("  no page error", errs, []);
    is("  a removed plan is not listed", seen.cards, 0);
    is("  nor counted as in flight", seen.sub, "0 fields in flight");
    yes("  CONTROL: and not counted as finished either, because it never ran",
      !/finished/.test(seen.sub ?? ""), seen.sub);
    yes("  so the page shows its empty state", seen.empty);
    await closeContext(ctx);
  }

  // ══ 17. A PHONE ═══════════════════════════════════════════════════════════════════════════
  for (const w of [390, 1200]) {
    const { ctx, p, errs } = await bootBoard(browser, storageState, w);
    console.log(`\n-- ${w}px: the candidate list --`);
    await p.click(`[data-testid="card"][data-id="${unboundCard.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.fill('[data-testid="bind-newname"]', probe);
    await p.waitForTimeout(500);
    const d = await p.evaluate(READ_BOARD);
    is("  no page error", errs, []);
    yes("  no horizontal scroll", !d.hscroll);
    const rows = nonEmpty(d.cands, `candidates at ${w}`);
    yes(`  candidate rows are ${Math.min(...rows.map((c) => c.h))}px`, rows.every((c) => c.h >= 44));
    /* GUARDED AT THE USE SITE: "no name is clipped" is zero, and an empty list prints the same
     * zero. nonEmpty proves there were candidates to clip in the first place. */
    is("  and no candidate name is clipped",
      nonEmpty(rows, `candidate rows at ${w}`).filter((c) => c.clipped).map((c) => c.name), []);
    await closeContext(ctx);

    const store = makeStore(template, isoOffsetDays(-11));
    const plan = await bootPlan(browser, storageState, w, store);
    console.log(`-- ${w}px: the confirm --`);
    await plan.p.click('[data-testid="plan-remove"]');
    await plan.p.waitForTimeout(500);
    const pd = await plan.p.evaluate(READ_PLAN);
    is("  no page error", plan.errs, []);
    yes("  no horizontal scroll", !pd.hscroll);
    yes(`  the confirm fits the screen (${pd.dlgW} in ${w})`, pd.dlgW <= w - 20);
    const btns = nonEmpty(pd.dlgBtns, `confirm buttons at ${w}`);
    yes(`  its buttons are ${Math.min(...btns.map((b) => b.h))}px`, btns.every((b) => b.h >= 44));
    /* THEY MUST NOT SIT ON TOP OF EACH OTHER. A wrapped row that overlaps is worse than a scroll. */
    let overlap = false;
    for (let i = 0; i < btns.length; i++) {
      for (let k = i + 1; k < btns.length; k++) {
        const a = btns[i], b = btns[k];
        if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) overlap = true;
      }
    }
    is("  CONTROL: and none of them overlaps another", overlap, false);
    await closeContext(plan.ctx);
  }

  await closeBrowser(browser);
  console.log(`\nfind-remove: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  XX ${f}`); process.exit(1); }
}

main().catch(fatal);
