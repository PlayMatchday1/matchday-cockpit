// BINDING A PIPELINE CARD TO A REAL FIELD WHEN IT REACHES CONFIRMED.
//
// NOTHING IS WRITTEN. Every POST/PATCH to fin_venues and kanban_cards is intercepted, recorded and
// answered from a fixture; reads pass through to production. The kanban_cards read is patched on
// the way past to give one card a venue_id, because binding one for real would be a write and the
// suite makes none.
//
// WHAT IT GUARDS. A card cannot sit in Confirmed with no field — that is the state that makes the
// launch plan unbuildable, and it is the state 27 cards are in today. So the drop does not commit:
// it opens a dialog, and only saving writes the stage and the binding together. Cancel must leave
// the card exactly where it was, which is the one that must not be wrong.
//
//   node scripts/e2e/verify-bind-confirmed.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/growth/field-pipeline`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

/* A REAL VENUE WITH A LAUNCH DATE, for the link path, and a real unbound Confirmed card to bind a
 * synthetic venue to, for the taken path. Both are read off production at run time rather than
 * pinned, so neither goes stale when somebody adds a field. */
const READ = () => {
  const q = (s) => document.querySelector(s);
  const T = (s) => q(s)?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const R = (e) => { const b = e.getBoundingClientRect();
    return { t: +b.top.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const dlg = q('[data-testid="bind-dialog"]');
  const save = q('[data-testid="bind-save"]');
  const vw = document.documentElement.clientWidth;
  return {
    vw, hscroll: document.documentElement.scrollWidth > vw + 2,
    open: dlg != null,
    dlgText: dlg ? dlg.textContent.replace(/\s+/g, " ").trim() : null,
    dlgBox: dlg ? R(dlg) : null,
    head: T('[data-testid="bind-dialog"] .dh'),
    /* THE TWO THINGS THAT MUST NOT EXIST: a picker, or a pick-or-create switch. */
    picker: document.querySelectorAll('[data-testid="bind-venue"], [data-testid="bind-existing"]').length,
    name: q('[data-testid="bind-newname"]') ? { value: q('[data-testid="bind-newname"]').value, ...R(q('[data-testid="bind-newname"]')) } : null,
    launch: q('[data-testid="bind-launch"]') ? { value: q('[data-testid="bind-launch"]').value, type: q('[data-testid="bind-launch"]').type, ...R(q('[data-testid="bind-launch"]')) } : null,
    cd: T('[data-testid="bind-cd"]'),
    city: T('[data-testid="bind-city"]'),
    match: T('[data-testid="bind-match"]'),
    dupe: T('[data-testid="bind-dupe"]'),
    preview: T('[data-testid="bind-preview"]'),
    save: save ? { text: save.textContent.trim(), disabled: save.disabled, mode: save.dataset.mode, ...R(save) } : null,
    cancel: q('[data-testid="bind-cancel"]') ? R(q('[data-testid="bind-cancel"]')) : null,
    /* THE BOARD. */
    unlinked: T('[data-testid="col-unlinked"]'),
    cards: [...document.querySelectorAll('[data-testid="card"]')].map((c) => ({
      id: c.dataset.id, bound: c.dataset.bound,
      title: c.querySelector(".ct, [class*='break-words']")?.textContent.trim() ?? "",
      link: c.querySelector('[data-testid="card-link"]') != null,
      cd: c.querySelector('[data-testid="card-countdown"]')?.textContent.trim() ?? null,
      borderLeft: getComputedStyle(c).borderLeftWidth,
      titleClipped: (() => { const t = c.querySelector("[class*='break-words']"); return t ? t.scrollWidth > t.clientWidth + 1 : false; })(),
    })),
    colXs: [...new Set([...document.querySelectorAll('[data-testid^="col-"]')]
      .filter((e) => e.dataset.testid !== "col-unlinked")
      .map((e) => Math.round(e.getBoundingClientRect().x)))],
  };
};

/** The column a card is currently rendered in, by its stage section. */
const stageOf = (cardId) => `[data-testid="card"][data-id="${cardId}"]`;

async function boot(browser, storageState, width, opts = {}) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: opts.height ?? 1100 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });
  const writes = [];
  /* NO WRITE REACHES THE DATABASE. Reads fall through; anything that changes a row is recorded and
   * answered. A suite about a control that creates records must not create any. */
  await ctx.route("**/rest/v1/fin_venues*", async (route) => {
    const m = route.request().method();
    if (m === "GET" || m === "HEAD") return route.fallback();
    writes.push({ table: "fin_venues", method: m, body: route.request().postData() });
    return route.fulfill({ status: 201, contentType: "application/json",
      body: JSON.stringify({ id: 999001, venue_name: "fixture", city: "Austin" }) });
  });
  /* SAVING NOW SEEDS THE LAUNCH PLAN (24 rows, migration 0173). This suite clicks Save, so without
   * this route it would write a real plan for the fixture venue the moment 0173 is applied — a
   * suite must not write production. The seed is recorded and answered, and the plan is asserted
   * from `writes` rather than from the table. */
  await ctx.route("**/rest/v1/field_launch_tasks*", async (route) => {
    const m = route.request().method();
    if (m === "GET" || m === "HEAD") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    writes.push({ table: "field_launch_tasks", method: m, body: route.request().postData() });
    return route.fulfill({ status: 201, contentType: "application/json", body: "[]" });
  });
  await ctx.route("**/rest/v1/kanban_cards*", async (route) => {
    const m = route.request().method();
    if (m !== "GET" && m !== "HEAD") {
      writes.push({ table: "kanban_cards", method: m, body: route.request().postData() });
      return route.fulfill({ status: 204, body: "" });
    }
    if (!opts.bindCard) return route.fallback();
    /* ONE CARD GIVEN A venue_id ON THE WAY PAST, so the bound-card assertions (countdown, no
     * Create control, the border difference, and the taken path) have a subject without a write. */
    const res = await route.fetch();
    const j = await res.json().catch(() => null);
    if (!Array.isArray(j)) return route.fulfill({ response: res });
    const target = j.find((c) => c.stage === "confirmed" && c.venue_id == null);
    if (target) target.venue_id = opts.bindCard;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(PAGE, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="card"]', { timeout: 180000 });
  await p.waitForTimeout(1200);
  return { ctx, p, writes, errs };
}

/** HTML5 drag, dispatched. The board keys off a ref set in onDragStart, so the events are enough. */
async function dragTo(p, cardId, stageId) {
  await p.dispatchEvent(stageOf(cardId), "dragstart", { dataTransfer: await p.evaluateHandle(() => new DataTransfer()) });
  const col = `[data-testid="col-${stageId}"]`;
  await p.dispatchEvent(col, "dragover", { dataTransfer: await p.evaluateHandle(() => new DataTransfer()) });
  await p.dispatchEvent(col, "drop", { dataTransfer: await p.evaluateHandle(() => new DataTransfer()) });
  await p.waitForTimeout(500);
}

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  /* THE LIVE FACTS THIS SUITE LEANS ON, read once and printed, so a failure says whether the app
   * or the data moved. */
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: venues } = await sb.from("fin_venues").select("id,venue_name,city,launch_date").not("launch_date", "is", null).order("id");
  const linkVenue = nonEmpty(venues ?? [], "fin_venues rows with a launch date")[0];
  console.log(`\nlink fixture: #${linkVenue.id} "${linkVenue.venue_name}" (${linkVenue.city}) launches ${linkVenue.launch_date}`);

  // ══ 1 / 2 / 12: THE DROP, AND CANCEL ════════════════════════════════════════════════════════
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1200);
    console.log("\n-- the drop on Confirmed --");
    const before = await p.evaluate(READ);
    const unbound = nonEmpty(before.cards.filter((c) => c.bound === "0"), "unbound cards");
    /* A CARD THAT IS NOT ALREADY IN CONFIRMED, so the move is a real move. */
    const mover = await p.evaluate(() => {
      const el = [...document.querySelectorAll('[data-testid="card"]')]
        .find((c) => c.closest("section")?.dataset.testid !== "col-confirmed");
      return el ? { id: el.dataset.id, col: el.closest("section")?.dataset.testid ?? null } : null;
    });
    yes(`  CONTROL: there is a card to drag (${mover?.id})`, mover != null);
    await dragTo(p, mover.id, "confirmed");
    const d = await p.evaluate(READ);
    yes("  dropping on Confirmed opens the dialog", d.open);
    is("  ...and NOTHING was written", writes, []);
    /* THE CARD HAS NOT MOVED. The stage change is not committed until the binding is. */
    const stillThere = await p.evaluate((sel) => document.querySelector(sel)?.closest("section")?.dataset.testid ?? null, stageOf(mover.id));
    is("  ...and the card has NOT moved yet", stillThere, mover.col);
    // 2. CANCEL — the one that must not be wrong.
    await p.click('[data-testid="bind-cancel"]');
    await p.waitForTimeout(400);
    const after = await p.evaluate(READ);
    is("  Cancel closes it", after.open, false);
    is("  CONTROL: ...and leaves the card where it started",
      await p.evaluate((sel) => document.querySelector(sel)?.closest("section")?.dataset.testid ?? null, stageOf(mover.id)), mover.col);
    is("  ...having written nothing", writes, []);

    // 12. EVERY OTHER STAGE DRAGS WITH NO DIALOG.
    console.log("\n-- every other stage is untouched --");
    for (const st of ["backlog", "contacted", "negotiation", "archived"]) {
      await dragTo(p, mover.id, st);
      const e = await p.evaluate(READ);
      is(`  ${st}: no dialog`, e.open, false);
      if (e.open) await p.click('[data-testid="bind-cancel"]');
    }
    yes(`  ...and those drags did write (${writes.length} card update(s), intercepted)`, writes.length > 0);
    is("  ...to kanban_cards only, never fin_venues", [...new Set(writes.map((w) => w.table))], ["kanban_cards"]);
    is("  no page error", errs, []);
    await closeContext(ctx);
  }

  // ══ 3 / 4 / 5 / 6 / 7 / 7a: THE DIALOG'S CREATE PATH ════════════════════════════════════════
  {
    const { ctx, p, writes } = await boot(browser, storageState, 1200);
    console.log("\n-- the dialog: create --");
    await p.click('[data-testid="card-link"]');
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    let d = await p.evaluate(READ);
    // 7. NO PICKER, NO SWITCH.
    is("  no picker and no pick-or-create switch", d.picker, 0);
    yes("  just a name for the field being created", d.name != null);
    // 3. BOTH ARE REQUIRED.
    is("  with neither, it cannot be saved", d.save.disabled, true);
    await p.fill('[data-testid="bind-newname"]', "Crossbar Rowlett North");
    await p.waitForTimeout(300);
    d = await p.evaluate(READ);
    is("  a name alone is not enough", d.save.disabled, true);
    is("  ...and the mode is create", d.save.mode, "create");
    await p.fill('[data-testid="bind-launch"]', "2026-11-06");
    await p.waitForTimeout(400);
    d = await p.evaluate(READ);
    is("  with both, it can", d.save.disabled, false);
    // 5. THE DATE ECHOES BACK AS A COUNTDOWN.
    yes(`  the date reads back as a countdown ("${d.cd}")`, /days to launch|Launches today|days since launch/.test(d.cd ?? ""));
    is("  ...and it is a real date input", d.launch.type, "date");
    // 4 / 6. THE PREVIEW.
    yes(`  the preview says what saving will create ("${String(d.preview).slice(0, 54)}…")`, d.preview != null);
    yes("  ...24 tasks, including the Ops prerequisite", /24 tasks/.test(d.preview ?? ""));
    yes("  ...and that nobody is messaged", /Nothing is sent/.test(d.preview ?? ""));
    // 7a. THE CITY AND THE BILLING TYPE.
    yes(`  the city is shown ("${d.city}")`, d.city != null);
    yes("  ...sourced from the card", /from the card/.test(d.city ?? ""));
    yes("  the billing type it will get is stated", /per match/i.test(d.dlgText ?? ""));
    yes("  ...with what that means in Finance until a rate is entered", /needing one|needs one|work item/i.test(d.dlgText ?? ""));
    /* A COST IS NULL, NEVER ZERO, WHEN IT IS NOT RECORDED (fieldEconomics.ts:19). */
    is("  and it never implies the field costs nothing", /\$0|free|no cost|costs nothing/i.test(d.dlgText ?? ""), false);
    is("  nothing written while filling it in", writes, []);

    // 7. THE ROW IT WOULD WRITE — captured from the intercepted insert.
    await p.click('[data-testid="bind-save"]');
    await p.waitForTimeout(1500);
    const venueWrite = writes.find((w) => w.table === "fin_venues");
    yes("  saving posts one fin_venues row", venueWrite != null);
    if (venueWrite) {
      const row = JSON.parse(venueWrite.body);
      console.log(`     fin_venues row: ${JSON.stringify(row)}`);
      is("  ...with all three NOT NULL columns populated",
        ["venue_name", "city", "billing_type"].filter((k) => !row[k]), []);
      is("  ...the name typed", row.venue_name, "Crossbar Rowlett North");
      is("  ...the billing type stated in the dialog", row.billing_type, "per_match");
      is("  ...and the launch date on fin_venues, not the card", row.launch_date, "2026-11-06");
    }
    const cardWrite = writes.find((w) => w.table === "kanban_cards");
    yes("  ...and one kanban_cards update", cardWrite != null);
    if (cardWrite) {
      const patch = JSON.parse(cardWrite.body);
      console.log(`     card patch: ${JSON.stringify(patch)}`);
      is("  ...carrying the stage AND the binding together", Object.keys(patch).sort(), ["stage", "venue_id"]);
      is("  ...moving it to confirmed", patch.stage, "confirmed");
      is("  ...and never a launch_date on the card", "launch_date" in patch, false);
    }
    /* ── THE PREVIEW'S PROMISE IS NOW KEPT ────────────────────────────────────────────────────
     * "24 tasks will be created" was true of nothing when this dialog shipped: piece 1 bound the
     * card and the venue and created no plan. Piece 2 seeds it here, so the preview and the write
     * are asserted in the same breath — a preview that names a number the app does not deliver is
     * the quiet lie this codebase is careful about. */
    const seedWrite = writes.find((w) => w.table === "field_launch_tasks");
    yes("  saving also seeds the launch plan the preview promised", seedWrite != null);
    if (seedWrite) {
      const rows = JSON.parse(seedWrite.body);
      is("  ...24 tasks, the number the preview named", rows.length, 24);
      is("  ...every one carrying a playbook key", rows.filter((r) => !r.template_key).length, 0);
      is("  ...and none carrying a date of its own", rows.filter((r) => "launch_date" in r).length, 0);
    }
    await closeContext(ctx);
  }

  // ══ 7b: AN EXACT MATCH OFFERS A LINK ════════════════════════════════════════════════════════
  {
    const { ctx, p } = await boot(browser, storageState, 1200);
    console.log("\n-- the dialog: an exact match offers a link --");
    await p.click('[data-testid="card-link"]');
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.fill('[data-testid="bind-newname"]', linkVenue.venue_name);
    await p.waitForTimeout(500);
    const d = await p.evaluate(READ);
    yes("  typing the name of a field that exists offers to link to it", d.match != null);
    yes(`  ...naming the field and its city ("${String(d.match).slice(0, 48)}…")`,
      new RegExp(linkVenue.venue_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(d.match ?? "")
      && new RegExp(String(linkVenue.city)).test(d.match ?? ""));
    yes("  ...and the launch date it already carries", /already launches/.test(d.match ?? ""));
    yes("  ...with the way out if it is not the same field", /different field, change the name/i.test(d.match ?? ""));
    is("  the action becomes a link, not a create", d.save.mode, "link");
    yes(`  ...and says so ("${d.save.text}")`, /Link/.test(d.save.text));
    is("  the existing launch date is brought in rather than retyped", d.launch.value, linkVenue.launch_date);
    is("  ...so it can be saved at once", d.save.disabled, false);
    // CONTROL: linking asks for no city — the venue already has one.
    is("  CONTROL: linking asks for no city", d.city, null);
    await closeContext(ctx);
  }

  // ══ 7c: A VENUE ANOTHER CARD HOLDS IS REFUSED ═══════════════════════════════════════════════
  {
    const { ctx, p } = await boot(browser, storageState, 1200, { bindCard: linkVenue.id });
    console.log("\n-- the dialog: a field another card already holds --");
    const board = await p.evaluate(READ);
    const holder = board.cards.find((c) => c.bound === "1");
    yes(`  CONTROL: a card holds that venue ("${holder?.title}")`, holder != null);
    await p.click('[data-testid="card-link"]');
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.fill('[data-testid="bind-newname"]', linkVenue.venue_name);
    await p.waitForTimeout(500);
    const d = await p.evaluate(READ);
    yes("  it is refused", d.dupe != null);
    is("  ...and cannot be saved", d.save.disabled, true);
    is("  ...with the mode taken, not create", d.save.mode, "taken");
    yes(`  ...naming the card that has it ("${String(d.dupe).slice(0, 52)}…")`, /already linked to the card/.test(d.dupe ?? ""));
    yes("  ...and what to do about it", /unlink that card first/i.test(d.dupe ?? ""));
    is("  ...and offers no link while it is taken", d.match, null);
    // CONTROL: an unused name is a plain create.
    await p.fill('[data-testid="bind-newname"]', "A Field Nobody Has Named 12345");
    await p.waitForTimeout(400);
    const c = await p.evaluate(READ);
    is("  CONTROL: an unused name shows no collision", c.dupe, null);
    is("  CONTROL: ...offers no link", c.match, null);
    is("  CONTROL: ...and is a create", c.save.mode, "create");
    await closeContext(ctx);
  }

  // ══ 9 / 10 / 11 / 13: THE BOARD ═════════════════════════════════════════════════════════════
  {
    const { ctx, p } = await boot(browser, storageState, 1200, { bindCard: linkVenue.id });
    console.log("\n-- the board --");
    const d = await p.evaluate(READ);
    const bound = d.cards.filter((c) => c.bound === "1");
    const unbound = nonEmpty(d.cards.filter((c) => c.bound === "0"), "unbound cards");
    yes(`  the Confirmed column says how many have no field ("${d.unlinked}")`, d.unlinked != null);
    yes("  ...with a count", /\d+ without a field/.test(d.unlinked ?? ""));
    is("  every unbound Confirmed card carries the Create control",
      unbound.filter((c) => c.cd === null && !c.link && c.borderLeft === "3px").map((c) => c.title), []);
    is("  CONTROL: a card that has a field does not", bound.filter((c) => c.link).map((c) => c.title), []);
    // 9. THE VISUAL DIFFERENCE, FROM COMPUTED STYLE.
    const ub = unbound.find((c) => c.link);
    console.log(`     unbound border-left ${ub?.borderLeft} · bound ${bound[0]?.borderLeft}`);
    yes(`  a card with no field is distinguishable at a glance`, ub && bound[0] && ub.borderLeft !== bound[0].borderLeft);
    // 11. THE COUNTDOWN.
    yes(`  a card with a field carries its countdown ("${bound[0]?.cd}")`,
      /days to launch|Launches today|days since launch/.test(bound[0]?.cd ?? ""));
    is("  CONTROL: one without a field has none", unbound.filter((c) => c.cd != null).map((c) => c.title), []);
    // 10. THE SAME DIALOG, NAMED FOR THAT CARD.
    const first = unbound.find((c) => c.link);
    await p.click(`[data-testid="card"][data-id="${first.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    const o = await p.evaluate(READ);
    yes("  the Create control opens the same dialog", o.open);
    yes(`  ...named for that card ("${String(o.head).slice(0, 50)}…")`, (o.head ?? "").includes(first.title));
    await closeContext(ctx);
  }

  // ══ 13: THE VC BOARD IS UNAFFECTED ══════════════════════════════════════════════════════════
  {
    const ctx = await browser.newContext({ storageState, viewport: { width: 1200, height: 1100 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    await p.goto(`${BASE}/growth/vc-outreach`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(6000);
    const d = await p.evaluate(() => ({
      cards: document.querySelectorAll('[data-testid="vc-card"], [data-testid="card"]').length,
      bindBits: document.querySelectorAll('[data-testid="bind-dialog"], [data-testid="card-link"], [data-testid="col-unlinked"]').length,
      body: document.body.innerText.length,
    }));
    console.log("\n-- the VC board --");
    yes(`  it renders (${d.cards} cards, ${d.body} chars)`, d.body > 400);
    is("  no page error", errs, []);
    is("  ...and none of the binding controls leak onto it", d.bindBits, 0);
    await closeContext(ctx);
  }

  // ══ 14: 390px ═══════════════════════════════════════════════════════════════════════════════
  {
    const { ctx, p } = await boot(browser, storageState, 390, { height: 1400 });
    console.log("\n-- 390px --");
    let d = await p.evaluate(READ);
    is("  board: no horizontal scroll", d.hscroll, false);
    is("  no card title is truncated", d.cards.filter((c) => c.titleClipped).map((c) => c.title), []);
    is("  the columns stack to one", d.colXs.length, 1);
    await p.click('[data-testid="card-link"]');
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(300);
    d = await p.evaluate(READ);
    is("  dialog: no horizontal scroll", d.hscroll, false);
    yes(`  the dialog fits the screen (${d.dlgBox.w} in ${d.vw})`, d.dlgBox.w <= d.vw - 20);
    yes(`  its buttons are >= 44px (save ${d.save.h}, cancel ${d.cancel.h})`, d.save.h >= 43.5 && d.cancel.h >= 43.5);
    yes(`  and its inputs >= 40px (name ${d.name.h}, date ${d.launch.h})`, d.name.h >= 39.5 && d.launch.h >= 39.5);
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\nbind-confirmed: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}
main().catch((e) => fatal(e));
