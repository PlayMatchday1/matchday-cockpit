// THE FIELD CONTROL ON A PIPELINE CARD — SMALL, NAMED, AND MOVED INTO THE MODAL.
//
// Ryan: "i dont like the craete the field big button. just make it a little tiny button in here and
// also all these have fields so need an easy way to say that on them."
//
// NOTHING IS WRITTEN. Every POST/PATCH to fin_venues, kanban_cards and field_launch_tasks is
// intercepted, recorded and answered from a fixture; reads pass through to production. One card is
// given a venue_id on the way past so the bound-card assertions have a subject, because binding one
// for real would be a write and this suite makes none.
//
// WHAT IT GUARDS. The chip has to say WHICH field it will link to — that is the whole of "an easy
// way to say that on them" — and it has to do it without the matching rule getting looser. Exact,
// case-insensitive, trimmed: "The Hattrick" in Houston and "Hat / The Hattrick" in Austin are two
// different fields, and a fuzzy matcher would bind one of them to the wrong venue permanently.
//
//   node scripts/e2e/verify-link-fields.mjs
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

const READ = () => {
  const q = (s) => document.querySelector(s);
  const T = (s) => q(s)?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const R = (e) => { const b = e.getBoundingClientRect();
    return { t: +b.top.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const vw = document.documentElement.clientWidth;
  const bind = q('[data-testid="bind-dialog"]');
  const save = q('[data-testid="bind-save"]');
  const mfield = q('[data-testid="m-field"]');
  const mbtn = q('[data-testid="m-field-btn"]');
  return {
    vw, hscroll: document.documentElement.scrollWidth > vw + 2,
    cards: [...document.querySelectorAll('[data-testid="card"]')].map((c) => {
      const chip = c.querySelector('[data-testid="card-link"]');
      const title = c.querySelector("[class*='break-words']");
      return {
        id: c.dataset.id, bound: c.dataset.bound, needs: c.dataset.needs,
        stage: c.closest("section")?.dataset.testid ?? null,
        title: title?.textContent.trim() ?? "",
        titleClipped: title ? title.scrollWidth > title.clientWidth + 1 : false,
        borderLeft: getComputedStyle(c).borderLeftWidth,
        box: R(c),
        chip: chip ? { text: chip.textContent.replace(/\s+/g, " ").trim(), kind: chip.dataset.kind,
          box: R(chip), border: getComputedStyle(chip).borderTopColor, bg: getComputedStyle(chip).backgroundColor } : null,
        cd: c.querySelector('[data-testid="card-countdown"]')?.textContent.trim() ?? null,
        text: c.textContent.replace(/\s+/g, " ").trim(),
      };
    }),
    unlinked: q('[data-testid="col-unlinked"]')
      ? { tag: q('[data-testid="col-unlinked"]').tagName, text: T('[data-testid="col-unlinked"]') } : null,
    /* THE MODAL */
    modalOpen: q('[data-testid="card-modal"], [role="dialog"][data-modal="card"]') != null || q(".fixed.z-50") != null,
    mfield: mfield ? { state: mfield.dataset.state, text: mfield.textContent.replace(/\s+/g, " ").trim() } : null,
    mname: T('[data-testid="m-field-name"]'),
    mmeta: T('[data-testid="m-field-meta"]'),
    mbtn: mbtn ? { text: mbtn.textContent.trim(), kind: mbtn.dataset.kind, ...R(mbtn) } : null,
    /* THE BIND DIALOG */
    bindOpen: bind != null,
    bindText: bind ? bind.textContent.replace(/\s+/g, " ").trim() : null,
    bindBox: bind ? R(bind) : null,
    name: q('[data-testid="bind-newname"]') ? { value: q('[data-testid="bind-newname"]').value, ...R(q('[data-testid="bind-newname"]')) } : null,
    launch: q('[data-testid="bind-launch"]') ? { value: q('[data-testid="bind-launch"]').value, ...R(q('[data-testid="bind-launch"]')) } : null,
    match: T('[data-testid="bind-match"]'),
    dupe: T('[data-testid="bind-dupe"]'),
    city: T('[data-testid="bind-city"]'),
    picker: document.querySelectorAll('[data-testid="bind-venue"], [data-testid="bind-existing"]').length,
    save: save ? { text: save.textContent.trim(), disabled: save.disabled, mode: save.dataset.mode } : null,
    dlgBtns: [...document.querySelectorAll('[data-testid="bind-dialog"] .df button')].map((b) => +b.getBoundingClientRect().height.toFixed(1)),
    dlgInputs: [...document.querySelectorAll('[data-testid="bind-dialog"] input')].map((b) => +b.getBoundingClientRect().height.toFixed(1)),
    /* THE MATCH LIST */
    matchOpen: q('[data-testid="match-dialog"]') != null,
    matchText: T('[data-testid="match-dialog"]'),
    matchBox: q('[data-testid="match-dialog"]') ? R(q('[data-testid="match-dialog"]')) : null,
    matchAll: document.querySelectorAll('[data-testid="match-all"]').length,
    rows: [...document.querySelectorAll('[data-testid="match-row"]')].map((r) => ({
      id: r.dataset.id,
      name: r.querySelector('[data-testid="mr-name"]')?.value ?? null,
      date: r.querySelector('[data-testid="mr-date"]')?.value ?? null,
      dateType: r.querySelector('[data-testid="mr-date"]')?.type ?? null,
      res: r.querySelector('[data-testid="mr-res"]')?.textContent.replace(/\s+/g, " ").trim() ?? null,
      go: r.querySelector('[data-testid="mr-go"]')
        ? { text: r.querySelector('[data-testid="mr-go"]').textContent.trim(),
            disabled: r.querySelector('[data-testid="mr-go"]').disabled,
            mode: r.querySelector('[data-testid="mr-go"]').dataset.mode,
            h: +r.querySelector('[data-testid="mr-go"]').getBoundingClientRect().height.toFixed(1) } : null,
      inputH: [...r.querySelectorAll("input")].map((i) => +i.getBoundingClientRect().height.toFixed(1)),
      gridRows: new Set([...r.querySelectorAll(".mgrid > *")].map((e) => Math.round(e.getBoundingClientRect().y))).size,
    })),
  };
};

/** Computed z-index of the scrim that owns a dialog — the stacking claim, measured. */
const zOf = (sel) => (s) => s;
void zOf;

async function boot(browser, storageState, width, opts = {}) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: opts.height ?? 1100 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });
  const writes = [];
  await ctx.route("**/rest/v1/fin_venues*", async (route) => {
    const m = route.request().method();
    if (m === "GET" || m === "HEAD") return route.fallback();
    writes.push({ table: "fin_venues", method: m, body: route.request().postData() });
    return route.fulfill({ status: 201, contentType: "application/json",
      body: JSON.stringify({ id: 999001, venue_name: "fixture", city: "Austin" }) });
  });
  await ctx.route("**/rest/v1/field_launch_tasks*", async (route) => {
    const m = route.request().method();
    if (m === "GET" || m === "HEAD") return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    writes.push({ table: "field_launch_tasks", method: m, body: route.request().postData() });
    return route.fulfill({ status: 201, contentType: "application/json", body: "[]" });
  });
  await ctx.route("**/rest/v1/kanban_cards*", async (route) => {
    const m = route.request().method();
    if (m !== "GET" && m !== "HEAD") {
      writes.push({ table: "kanban_cards", method: m, body: route.request().postData(), url: route.request().url() });
      return route.fulfill({ status: 204, body: "" });
    }
    if (!opts.bindCard) return route.fallback();
    /* ONE CARD GIVEN A venue_id ON THE WAY PAST, so the bound assertions have a subject without a
     * write. The card chosen is the one whose title matches that venue, so the modal's bound row
     * and the "no chip when bound" control are about the same field. */
    const res = await route.fetch();
    const j = await res.json().catch(() => null);
    if (!Array.isArray(j)) return route.fulfill({ response: res });
    const target = j.find((c) => c.stage === "confirmed" && c.venue_id == null
      && String(c.title).trim().toLowerCase() === opts.bindTitle);
    if (target) target.venue_id = opts.bindCard;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(PAGE, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="card"]', { timeout: 180000 });
  await p.waitForTimeout(1400);
  return { ctx, p, writes, errs };
}

/* CLICK THE TITLE, NOT THE CARD. Playwright clicks an element's CENTRE, and on a short card the
 * centre can land on the chip — which calls stopPropagation and opens the bind dialog instead, so
 * the modal never appears and the failure reads as a 15s timeout on an unrelated selector. */
const openModalFor = async (p, cardId) => {
  await p.click(`[data-testid="card"][data-id="${cardId}"] [class*='break-words']`);
  await p.waitForSelector('[data-testid="m-field"]', { timeout: 15000 });
  await p.waitForTimeout(300);
};

/* CLOSE BY THE CONTROL, NOT BY Escape. The key handler is real but the press has to land on the
 * right target, and a modal that quietly stayed open turned the NEXT openModalFor into a 15s
 * timeout that said nothing about the feature. Waiting for the row to detach is the ready signal. */
const closeModal = async (p) => {
  const btn = await p.$('[aria-label="Close"]');
  if (btn) await btn.click();
  else await p.keyboard.press("Escape");
  await p.waitForSelector('[data-testid="m-field"]', { state: "detached", timeout: 15000 });
  await p.waitForTimeout(250);
};

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: venues } = await sb.from("fin_venues").select("id,venue_name,city,launch_date");
  const { data: allCards } = await sb.from("kanban_cards").select("id,title,stage,venue_id").eq("board_type", "field_pipeline");
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const byName = new Map(nonEmpty(venues ?? [], "fin_venues rows").map((v) => [norm(v.venue_name), v]));
  const confirmedUnbound = nonEmpty(
    (allCards ?? []).filter((c) => c.stage === "confirmed" && c.venue_id == null),
    "confirmed cards with no venue",
  );
  /* THE FOUR SUBJECTS, READ OFF PRODUCTION RATHER THAN PINNED.
   *
   * boundCard AND linkCard MUST BE DIFFERENT CARDS. The run injects a venue_id onto boundCard, so
   * using one card for both would make the "link chip" subject a BOUND card — which by design
   * carries no chip at all, and the suite would be asserting against null. */
  const matching = nonEmpty(
    confirmedUnbound.filter((c) => byName.get(norm(c.title))?.launch_date),
    "confirmed cards whose title matches a field that has a launch date",
  );
  if (matching.length < 2) throw new Error(`need two name-matching cards, found ${matching.length}`);
  const boundCard = matching[0];
  const boundVenue = byName.get(norm(boundCard.title));
  const linkCard = matching[1];
  const linkVenue = byName.get(norm(linkCard.title));
  const newCard = nonEmpty(
    confirmedUnbound.filter((c) => !byName.has(norm(c.title))),
    "confirmed cards whose title matches no field",
  )[0];
  /* PREFER A LIVE STAGE OVER archived — a collapsed Archived column renders no cards, and the
   * "not marked outside Confirmed" control would then be asserting against nothing. */
  const outsideAll = nonEmpty(
    (allCards ?? []).filter((c) => c.stage !== "confirmed" && c.venue_id == null),
    "unbound cards outside Confirmed",
  );
  const outside = outsideAll.find((c) => c.stage !== "archived") ?? outsideAll[0];
  console.log(`\nbound subject: "${boundCard.title}" -> #${boundVenue.id} ${boundVenue.venue_name} (${boundVenue.city}) launches ${boundVenue.launch_date}`);
  console.log(`link subject : "${linkCard.title}" -> #${linkVenue.id} ${linkVenue.venue_name} (${linkVenue.city}) launches ${linkVenue.launch_date}`);
  console.log(`new subject  : "${newCard.title}" (matches nothing)`);
  console.log(`outside      : "${outside.title}" in ${outside.stage}`);
  console.log(`unbound confirmed: ${confirmedUnbound.length}`);

  const bindOpts = { bindCard: boundVenue.id, bindTitle: norm(boundCard.title) };

  // ══ 1-5. THE CHIP ═════════════════════════════════════════════════════════════════════════
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1200, bindOpts);
    console.log("\n-- the chip on the card --");
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  nothing written by rendering the board", writes, []);

    const newC = d.cards.find((c) => c.id === newCard.id);
    const linkC = d.cards.find((c) => c.id === linkCard.id);
    yes("  CONTROL: both subjects are on the board", newC != null && linkC != null);

    // 1. SMALL, AND MEASURED AGAINST THE CARD'S OWN WIDTH.
    yes(`  the control is ${newC.chip.box.h}px tall, not 34`, newC.chip.box.h <= 26);
    yes(`  and ${Math.round(newC.chip.box.w)}px wide inside a ${Math.round(newC.box.w)}px card — not full width`,
      newC.chip.box.w < newC.box.w * 0.62);
    yes("  CONTROL: genuinely inset, not a full-bleed button with padding",
      newC.chip.box.w < newC.box.w - 20);
    // 2. THE OLD STATUS LINE IS GONE.
    yes("  the separate \"no field record yet\" line is gone — the chip says it",
      !/no field record yet/i.test(newC.text), newC.text.slice(0, 80));

    // 3. THE CHIP NAMES THE FIELD.
    yes(`  a card whose name matches a field says so: "${linkC.chip.text}"`,
      /Link/.test(linkC.chip.text) && linkC.chip.text.includes(linkVenue.venue_name));
    is("  and is marked as a link, not a create", linkC.chip.kind, "link");
    yes(`  CONTROL: a card matching nothing offers a new field: "${newC.chip.text}"`,
      /New field/i.test(newC.chip.text) && !/Link/.test(newC.chip.text));
    is("  CONTROL: and is marked as a create", newC.chip.kind, "new");
    yes(`  the two read differently at a glance too (${linkC.chip.border} vs ${newC.chip.border})`,
      linkC.chip.border !== newC.chip.border);
    yes(`  CONTROL: and in fill as well (${linkC.chip.bg} vs ${newC.chip.bg})`,
      linkC.chip.bg !== newC.chip.bg);

    // 4. A BOUND CARD.
    const boundC = nonEmpty(d.cards.filter((c) => c.bound === "1"), "bound cards")[0];
    is("  CONTROL: a card that already has a field carries no chip at all", boundC.chip, null);
    yes(`  it carries its countdown instead: "${boundC.cd}"`, /days (to launch|since launch)|Launches today/.test(boundC.cd ?? ""));
    yes(`  a card with no field still reads differently from one with (${newC.borderLeft} vs ${boundC.borderLeft})`,
      newC.borderLeft !== boundC.borderLeft);

    // 5. AN UNBOUND CARD OUTSIDE CONFIRMED IS NOT MARKED.
    const outC = d.cards.find((c) => c.id === outside.id);
    yes(`  CONTROL: the outside card is on the board (${outC?.stage})`, outC != null);
    is("  CONTROL: an unbound card OUTSIDE Confirmed is not marked", outC.needs, "0");
    is("  CONTROL: and carries no amber edge", outC.borderLeft, boundC.borderLeft);
    is("  CONTROL: and no chip", outC.chip, null);
    is("  CONTROL: while the confirmed one does need a field", newC.needs, "1");
    await closeContext(ctx);
  }

  // ══ 6. THE MODAL'S FIELD ROW ══════════════════════════════════════════════════════════════
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1200, bindOpts);
    console.log("\n-- the modal's Field row --");
    await openModalFor(p, newCard.id);
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  the edit card modal carries a Field row", d.mfield != null);
    is("  which knows it has none", d.mfield.state, "none");
    yes(`  and says so: "${d.mname}"`, /No field record/i.test(d.mname ?? ""));
    yes(`  with what will happen: "${(d.mmeta ?? "").slice(0, 60)}…"`,
      /Nothing in Finance carries this name/i.test(d.mmeta ?? ""));
    yes("  CONTROL: and does not claim a field exists when none does",
      !/already exists/i.test(d.mmeta ?? ""), d.mmeta);
    yes(`  with the control to fix it: "${d.mbtn.text}"`, /Create/.test(d.mbtn.text));
    yes(`  the modal's control is ${d.mbtn.h}px — the full-size one, because there is room here`,
      d.mbtn.h >= 34);
    await closeModal(p);

    await openModalFor(p, linkCard.id);
    d = await p.evaluate(READ);
    yes(`  CONTROL: a matching unbound card offers Link instead: "${d.mbtn.text}"`, /Link/.test(d.mbtn.text));
    yes(`  naming the field that exists: "${(d.mmeta ?? "").slice(0, 60)}…"`,
      d.mmeta.includes(linkVenue.venue_name) && /already exists/i.test(d.mmeta));
    await closeModal(p);

    const boundId = nonEmpty((await p.evaluate(READ)).cards.filter((c) => c.bound === "1"), "bound cards")[0].id;
    await openModalFor(p, boundId);
    d = await p.evaluate(READ);
    is("  CONTROL: a bound card's row knows it is bound", d.mfield.state, "bound");
    is("  and names its field", d.mname, boundVenue.venue_name);
    yes(`  with city, launch date and countdown: "${d.mmeta}"`,
      d.mmeta.includes(boundVenue.city) && /launches/.test(d.mmeta) && /days (to launch|since launch)|Launches today/.test(d.mmeta));
    yes(`  and Change rather than Create: "${d.mbtn.text}"`, /Change/.test(d.mbtn.text));
    is("  nothing written by opening modals", writes, []);
    await closeContext(ctx);
  }

  // ══ 8-11. THE DIALOG, PRE-TYPED, AND STACKED OVER THE MODAL ═══════════════════════════════
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1200, bindOpts);
    console.log("\n-- the dialog opens pre-typed --");
    await p.click(`[data-testid="card"][data-id="${linkCard.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(500);
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  opening the dialog from a card pre-types that card's name", d.name.value, linkCard.title);
    yes("  so the offer is on screen without typing a character", d.match != null);
    yes(`  naming the field, its city and its launch date: "${(d.match ?? "").slice(0, 62)}…"`,
      d.match.includes(linkVenue.venue_name) && d.match.includes(linkVenue.city) && /already launches/.test(d.match));
    yes("  with the way out if it is not the same field", /different field, change the name/i.test(d.match));
    is("  and the existing date is brought in", d.launch.value, linkVenue.launch_date);
    is("  the action is a link", d.save.mode, "link");
    is("  and it can be saved at once — two taps for the whole card", d.save.disabled, false);
    is("  CONTROL: still no picker and no pick-or-create switch", d.picker, 0);
    is("  CONTROL: and nothing is written by opening it", writes, []);

    // 9. EDITING THE NAME DROPS THE OFFER.
    await p.fill('[data-testid="bind-newname"]', `${linkCard.title} North`);
    await p.waitForTimeout(400);
    d = await p.evaluate(READ);
    is("  editing the name drops the offer", d.match, null);
    is("  CONTROL: and it becomes a create", d.save.mode, "create");
    yes("  which states the city it takes off the card", d.city != null);
    yes(`  and the billing it gets: "${(d.bindText ?? "").match(/per match[^.]*\./i)?.[0] ?? ""}"`,
      /per match/i.test(d.bindText ?? ""));
    yes("  CONTROL: and never says the field is free until a rate is set",
      !/\$0|\bfree\b|no cost|costs nothing/i.test(d.bindText ?? ""));
    /* THE BROUGHT-IN DATE LEAVES WITH THE OFFER. It arrived as "already launches …"; keeping it
     * would stamp another field's launch date on a brand new venue nobody dated. */
    is("  CONTROL: and the offer's launch date goes with it", d.launch.value, "");
    is("  CONTROL: so a name alone cannot be saved", d.save.disabled, true);
    await closeContext(ctx);
  }

  // ══ 10. THE TAKEN REFUSAL, THROUGH THE PREFILLED PATH ═════════════════════════════════════
  {
    const { ctx, p, errs } = await boot(browser, storageState, 1200, bindOpts);
    console.log("\n-- the taken refusal survives the prefill --");
    await p.click(`[data-testid="card"][data-id="${newCard.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(300);
    /* The injected card holds linkVenue, so typing its name from a DIFFERENT card is the taken
     * case — and it is reached the way a person would reach it, by typing. */
    await p.fill('[data-testid="bind-newname"]', boundVenue.venue_name);
    await p.waitForTimeout(500);
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  a field another card already holds is still refused", d.dupe != null);
    yes(`  naming that card: "${(d.dupe ?? "").slice(0, 56)}…"`, /already linked to the card/i.test(d.dupe ?? ""));
    yes("  and what to do about it", /unlink that card first/i.test(d.dupe ?? ""));
    is("  the mode says taken, not create", d.save.mode, "taken");
    is("  and it cannot be saved", d.save.disabled, true);
    await closeContext(ctx);
  }

  // ══ 11. THE DIALOG STACKS OVER THE MODAL ══════════════════════════════════════════════════
  {
    const { ctx, p, errs } = await boot(browser, storageState, 1200, bindOpts);
    console.log("\n-- stacked over the modal --");
    await openModalFor(p, linkCard.id);
    await p.click('[data-testid="m-field-btn"]');
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(400);
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  reaching for the field from the modal leaves the modal open", d.mfield != null);
    yes("  with the bind dialog over it", d.bindOpen);
    is("  prefilled from that card too", d.name.value, linkCard.title);
    /* THE STACKING CLAIM, MEASURED — not "it looks fine". The modal holds unsaved title and to-do
     * edits in local state, so a dialog BEHIND it would be unreachable and one that REPLACED it
     * would throw those edits away. */
    const z = await p.evaluate(() => {
      const bind = document.querySelector('[data-testid="bind-dialog"]')?.closest(".fixed");
      const modal = document.querySelector('[data-testid="m-field"]')?.closest(".fixed");
      const n = (el) => (el ? Number(getComputedStyle(el).zIndex) : null);
      return { bind: n(bind), modal: n(modal) };
    });
    yes(`  and above it (${z.bind} over ${z.modal}), not behind`,
      Number.isFinite(z.bind) && Number.isFinite(z.modal) && z.bind > z.modal);
    await p.click('[data-testid="bind-cancel"]');
    await p.waitForTimeout(500);
    d = await p.evaluate(READ);
    is("  Cancel closes the bind dialog", d.bindOpen, false);
    yes("  CONTROL: and returns to the card, not to the board", d.mfield != null);
    await closeContext(ctx);
  }

  // ══ 12-15. MATCH FIELDS ═══════════════════════════════════════════════════════════════════
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1200, bindOpts);
    console.log("\n-- match fields --");
    let d = await p.evaluate(READ);
    is("  the column header's count is the way in", d.unlinked.tag, "BUTTON");
    await p.click('[data-testid="col-unlinked"]');
    await p.waitForSelector('[data-testid="match-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(600);
    d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  it opens the whole backfill as one list", d.matchOpen);
    /* ONE ROW PER UNBOUND CONFIRMED CARD — minus the one this run injected a venue_id onto. */
    is("  every unbound confirmed card gets a row", d.rows.length, confirmedUnbound.length - 1);
    yes("  each prefilled with that card's own name",
      d.rows.every((r) => (r.name ?? "").length > 0));
    const rLink = d.rows.find((r) => r.id === linkCard.id);
    const rNew = d.rows.find((r) => r.id === newCard.id);
    yes("  CONTROL: both subjects have a row", rLink != null && rNew != null);
    is("  the matching row is prefilled with the card title", rLink.name, linkCard.title);
    yes(`  and resolved on sight: "${(rLink.res ?? "").slice(0, 52)}…"`,
      /Links to/.test(rLink.res) && rLink.res.includes(linkVenue.venue_name));
    is("  with the existing launch date brought in", rLink.date, linkVenue.launch_date);
    is("  it is a real date input", rLink.dateType, "date");
    is("  so a matched row is ready to link", rLink.go.disabled, false);
    is("  and its button says Link", rLink.go.text, "Link");
    yes(`  CONTROL: an unmatched row says it will create instead: "${(rNew.res ?? "").slice(0, 52)}…"`,
      /No field carries this name/.test(rNew.res) && /Creates/.test(rNew.res));
    is("  CONTROL: and cannot go, because it has no launch date yet", rNew.go.disabled, true);
    is("  CONTROL: and its button says Create", rNew.go.text, "Create");
    /* A COST IS NULL, NEVER ZERO, WHEN IT IS NOT RECORDED (fieldEconomics.ts:19). */
    yes("  CONTROL: and never implies the new field is free",
      !/\$0|\bfree\b|no cost|costs nothing/i.test(rNew.res ?? ""));

    // 13. EDITING A ROW'S NAME RE-RESOLVES IT LIVE — how the 15 get fixed.
    await p.fill(`[data-testid="match-row"][data-id="${newCard.id}"] [data-testid="mr-name"]`, boundVenue.venue_name);
    await p.waitForTimeout(500);
    d = await p.evaluate(READ);
    const rFixed = d.rows.find((r) => r.id === newCard.id);
    /* linkCard's own venue is held by the injected card, so correcting this row's name to it is
     * the TAKEN case — which is the honest outcome and still names the holder. */
    yes(`  correcting a row's name re-resolves it live: "${(rFixed.res ?? "").slice(0, 56)}…"`,
      rFixed.res !== rNew.res && rFixed.res.includes(boundVenue.venue_name));
    is("  and the rule is the dialog's rule, not a looser one", rFixed.go.mode, "taken");
    // Now a name that resolves to a free venue, to prove the date comes across.
    const freeVenue = nonEmpty(
      (venues ?? []).filter((v) => v.launch_date && v.id !== boundVenue.id && v.id !== linkVenue.id
        && !(allCards ?? []).some((c) => c.venue_id === v.id)),
      "venues with a launch date that no card holds",
    )[0];
    await p.fill(`[data-testid="match-row"][data-id="${newCard.id}"] [data-testid="mr-name"]`, freeVenue.venue_name);
    await p.waitForTimeout(500);
    d = await p.evaluate(READ);
    const rFree = d.rows.find((r) => r.id === newCard.id);
    yes(`  a corrected name that is free resolves to a link: "${(rFree.res ?? "").slice(0, 48)}…"`,
      /Links to/.test(rFree.res) && rFree.res.includes(freeVenue.venue_name));
    is("  and brings that field's date in", rFree.date, freeVenue.launch_date);
    is("  CONTROL: which makes it saveable", rFree.go.disabled, false);

    // 14. NO LINK ALL.
    is("  CONTROL: there is no Link all — a person still confirms each row", d.matchAll, 0);
    yes("  and the list says so before any of it is pressed",
      /Nothing is linked until you press Link/i.test(d.matchText ?? ""));
    yes("  along with the fact that nobody is messaged",
      /nothing is sent to anybody/i.test(d.matchText ?? ""));
    is("  nothing written by opening or typing in the list", writes, []);

    // 15. A ROW'S SAVE IS THE DIALOG'S SAVE — asserted on what it writes.
    await p.click(`[data-testid="match-row"][data-id="${newCard.id}"] [data-testid="mr-go"]`);
    await p.waitForTimeout(1500);
    const cardWrite = writes.find((w) => w.table === "kanban_cards");
    yes("  pressing Link on a row writes the card", cardWrite != null);
    if (cardWrite) {
      const patch = JSON.parse(cardWrite.body);
      is("  ...the same one-update patch the dialog makes", Object.keys(patch).sort(), ["stage", "venue_id"]);
      is("  ...moving it to confirmed", patch.stage, "confirmed");
      is("  ...binding the venue it resolved to", patch.venue_id, freeVenue.id);
      is("  ...and never a launch_date on the card", "launch_date" in patch, false);
    }
    /* A LINK REUSES THE RECORD. If a row ever POSTed to fin_venues on a link, it would be a second
     * venue-create with a second copy of the rule — which is the thing §4 forbids. */
    is("  ...and a link creates no second venue record",
      writes.filter((w) => w.table === "fin_venues" && w.method === "POST").length, 0);
    const seed = writes.find((w) => w.table === "field_launch_tasks");
    yes("  ...while the launch plan is seeded by the same shared path", seed != null);
    if (seed) is("  ...with the same 24 tasks", JSON.parse(seed.body).length, 24);
    await closeContext(ctx);
  }

  // ══ 16. THE DROP STILL DOES NOT COMMIT — the one that must not be wrong ═══════════════════
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1200);
    console.log("\n-- the drop still does not commit --");
    const mover = await p.evaluate(() => {
      const el = [...document.querySelectorAll('[data-testid="card"]')]
        .find((c) => c.closest("section")?.dataset.testid !== "col-confirmed");
      return el ? { id: el.dataset.id, col: el.closest("section")?.dataset.testid ?? null } : null;
    });
    yes(`  CONTROL: there is a card to drag (${mover?.id} in ${mover?.col})`, mover != null);
    const dt = await p.evaluateHandle(() => new DataTransfer());
    await p.dispatchEvent(`[data-testid="card"][data-id="${mover.id}"]`, "dragstart", { dataTransfer: dt });
    await p.dispatchEvent('[data-testid="col-confirmed"]', "dragover", { dataTransfer: dt });
    await p.dispatchEvent('[data-testid="col-confirmed"]', "drop", { dataTransfer: dt });
    await p.waitForTimeout(900);
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  dropping on Confirmed opens the dialog", d.bindOpen);
    const movedCard = await p.evaluate((id) =>
      document.querySelector(`[data-testid="card"][data-id="${id}"]`)?.closest("section")?.dataset.testid ?? null, mover.id);
    is("  and the card has NOT moved — the stage is not committed until the binding is", movedCard, mover.col);
    is("  nothing is written", writes, []);
    await p.click('[data-testid="bind-cancel"]');
    await p.waitForTimeout(600);
    d = await p.evaluate(READ);
    is("  Cancel closes it", d.bindOpen, false);
    const afterCard = await p.evaluate((id) =>
      document.querySelector(`[data-testid="card"][data-id="${id}"]`)?.closest("section")?.dataset.testid ?? null, mover.id);
    is("  CONTROL: and leaves the card where it started", afterCard, mover.col);
    is("  CONTROL: still nothing written", writes, []);
    await closeContext(ctx);
  }

  // ══ 7. THE OTHER TWO BOARDS ARE UNTOUCHED ═════════════════════════════════════════════════
  {
    const ctx = await browser.newContext({ storageState, viewport: { width: 1200, height: 1100 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    console.log("\n-- VC Outreach and Tech Roadmap --");
    for (const [route, label] of [["/growth/vc-outreach", "VC Outreach"], ["/tech/tech-roadmap", "Tech Roadmap"]]) {
      await p.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(3500);
      /* THE TWO BOARDS DRAW THEIR CARDS DIFFERENTLY — VC tags it vc-card, Tech Roadmap renders a
       * plain draggable div (and /tech/tech-roadmap redirects to /app). Matching on draggable
       * covers both without pinning either board's markup. */
      const card = await p.$('[data-testid="vc-card"], [draggable="true"]');
      yes(`  ${label} renders`, card != null);
      if (card) {
        await card.click();
        /* WAIT FOR THE MODAL, not for a sleep — an absence assertion on a modal that never opened
         * would pass for the wrong reason. */
        await p.waitForSelector('[aria-label="Close"]', { timeout: 20000 }).catch(() => {});
        await p.waitForTimeout(500);
        yes(`  ${label}: its edit modal opened`, await p.$('[aria-label="Close"]') != null);
        /* THE FIELD SET, COMPARED BY LABEL. fieldRow is optional and these boards pass none, so a
         * Field row appearing here would mean the shared modal had learned about fin_venues. */
        const fields = await p.evaluate(() => ({
          labels: [...document.querySelectorAll("label")].map((l) => l.childNodes[0]?.textContent?.trim() ?? "").filter(Boolean),
          fieldRow: document.querySelectorAll('[data-testid="m-field"]').length,
          chip: document.querySelectorAll('[data-testid="card-link"]').length,
          unlinked: document.querySelectorAll('[data-testid="col-unlinked"]').length,
        }));
        is(`  ${label}: no Field row in its modal`, fields.fieldRow, 0);
        is(`  ${label}: no field chip anywhere`, fields.chip, 0);
        is(`  ${label}: no unlinked count`, fields.unlinked, 0);
        yes(`  ${label}: its own fields are still there (${fields.labels.slice(0, 4).join(", ")})`,
          fields.labels.length > 0);
        await p.keyboard.press("Escape");
        await p.waitForTimeout(600);
      }
    }
    is("  no page error on either board", errs, []);
    await closeContext(ctx);
  }

  // ══ 17. A PHONE ═══════════════════════════════════════════════════════════════════════════
  for (const w of [390, 1200]) {
    const { ctx, p, errs } = await boot(browser, storageState, w, bindOpts);
    console.log(`\n-- ${w}px --`);
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  board: no horizontal scroll", !d.hscroll);
    const chips = nonEmpty(d.cards.filter((c) => c.chip), "cards with a chip");
    yes(`  the chip is one line (${Math.max(...chips.map((c) => c.chip.box.h))}px)`,
      chips.every((c) => c.chip.box.h <= 26));
    yes("  and sits inside its card, not over the edge",
      chips.every((c) => c.chip.box.r <= c.box.r - 1 && c.chip.box.l >= c.box.l - 1));
    is("  no card title is clipped", d.cards.filter((c) => c.titleClipped).map((c) => c.title), []);

    await openModalFor(p, linkCard.id);
    d = await p.evaluate(READ);
    yes("  modal: no horizontal scroll", !d.hscroll);
    await p.click('[data-testid="m-field-btn"]');
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(500);
    d = await p.evaluate(READ);
    yes("  stacked: no horizontal scroll", !d.hscroll);
    yes(`  the dialog fits the screen (${Math.round(d.bindBox.w)} in ${w})`, d.bindBox.w <= w - 20);
    yes(`  its buttons are ${Math.min(...d.dlgBtns)}px`, Math.min(...d.dlgBtns) >= 44);
    yes(`  and its inputs ${Math.min(...d.dlgInputs)}px`, Math.min(...d.dlgInputs) >= 40);
    await p.click('[data-testid="bind-cancel"]');
    await p.waitForTimeout(400);
    await closeModal(p);

    await p.click('[data-testid="col-unlinked"]');
    await p.waitForSelector('[data-testid="match-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(600);
    d = await p.evaluate(READ);
    yes("  match: no horizontal scroll", !d.hscroll);
    yes(`  the list fits too (${Math.round(d.matchBox.w)} in ${w})`, d.matchBox.w <= w - 20);
    const rows = nonEmpty(d.rows, `match rows at ${w}`);
    yes(`  the rows' inputs are ${Math.min(...rows.flatMap((r) => r.inputH))}px`,
      rows.every((r) => r.inputH.every((h) => h >= 44)));
    yes(`  and their buttons ${Math.min(...rows.map((r) => r.go.h))}px`, rows.every((r) => r.go.h >= 36));
    if (w === 390) {
      is("  the match row's name and date stack at 390 rather than squeezing", rows[0].gridRows, 2);
    } else {
      is("  CONTROL: and sit side by side at 1200", rows[0].gridRows, 1);
    }
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\nlink-fields: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  XX ${f}`); process.exit(1); }
}

main().catch(fatal);
