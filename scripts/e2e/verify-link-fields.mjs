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

/* ── THE APP'S OWN WINDOW RULE, REPEATED FOR THE SUITE'S OWN BOOKKEEPING ──────────────────────
 * planStart = launch - 28d; week = floor((today - planStart)/7d) + 1; live = week <= 20. This is
 * here so the suite can PICK its subjects and predict what it should see. Every assertion below
 * still reads the answer off the page; this never stands in for one. */
const DAY = 86400000;
const midnight = (t) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
const localMid = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const weekIso = (iso) => Math.floor((midnight(new Date()) - (localMid(iso) - 28 * DAY)) / (7 * DAY)) + 1;
const isLiveIso = (iso) => weekIso(iso) <= 20;
/** YYYY-MM-DD n days from today, local wall clock, so nothing in this suite is a pinned date. */
const isoOffsetDays = (n) => {
  const t = new Date();
  const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const daysSince = (iso) => Math.abs(Math.round((localMid(iso) - midnight(new Date())) / DAY));

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
        cdPast: c.querySelector('[data-testid="card-countdown"]')?.dataset.past ?? null,
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
    noplan: T('[data-testid="bind-noplan"]'),
    planopt: T('[data-testid="bind-planopt"]'),
    planoptChecked: q('[data-testid="bind-planopt-box"]')?.checked ?? null,
    preview: T('[data-testid="bind-preview"]'),
    dupe: T('[data-testid="bind-dupe"]'),
    city: T('[data-testid="bind-city"]'),
    picker: document.querySelectorAll('[data-testid="bind-venue"], [data-testid="bind-existing"]').length,
    save: save ? { text: save.textContent.trim(), disabled: save.disabled, mode: save.dataset.mode,
      plan: save.dataset.plan } : null,
    dlgBtns: [...document.querySelectorAll('[data-testid="bind-dialog"] .df button')].map((b) => +b.getBoundingClientRect().height.toFixed(1)),
    dlgInputs: [...document.querySelectorAll('[data-testid="bind-dialog"] .fld input')].map((b) => +b.getBoundingClientRect().height.toFixed(1)),
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
            plan: r.querySelector('[data-testid="mr-go"]').dataset.plan,
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
    if (m === "GET" || m === "HEAD") {
      if (!opts.shiftVenue && !opts.shiftVenues) return route.fallback();
      /* ONE VENUE'S launch_date MOVED ON THE WAY PAST. A read-side fixture, never a write: the
       * present tense ("already launches") cannot otherwise be reached, because no venue in
       * production has a launch date in the future. */
      const res = await route.fetch();
      const j = await res.json().catch(() => null);
      if (!Array.isArray(j)) return route.fulfill({ response: res });
      for (const sh of opts.shiftVenues ?? (opts.shiftVenue ? [opts.shiftVenue] : [])) {
        const t = j.find((v) => v.id === sh.id);
        if (t) t.launch_date = sh.iso;
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    }
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
    if (!opts.inject?.length) return route.fallback();
    /* CARDS GIVEN A venue_id ON THE WAY PAST, so the bound assertions have subjects without a
     * write. TWO of them, deliberately: one venue past the plan window and one still inside it,
     * because "a launch that is over is not a countdown" needs both halves to mean anything. */
    const res = await route.fetch();
    const j = await res.json().catch(() => null);
    if (!Array.isArray(j)) return route.fulfill({ response: res });
    for (const inj of opts.inject) {
      const target = j.find((c) => c.id === inj.cardId);
      if (target) target.venue_id = inj.venueId;
    }
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
  /* ── THE SUBJECTS, READ OFF PRODUCTION RATHER THAN PINNED ────────────────────────────────────
   * "Inside the plan window" is a moving target, so which card is which is DERIVED from the data
   * on the day the suite runs. On 2026-09-13 exactly one matching card (Westlake, week 15) is
   * still inside it, and that is the kind of fact that must not be typed into a suite.
   *
   * EVERY SUBJECT IS A DIFFERENT CARD. A card the run injects a venue_id onto is BOUND, and a
   * bound card carries no chip at all — using one card for two jobs asserts against null. */
  const dated = (c) => byName.get(norm(c.title))?.launch_date;
  const matching = nonEmpty(
    confirmedUnbound.filter(dated),
    "confirmed cards whose title matches a field that has a launch date",
  );
  const liveMatches = nonEmpty(
    matching.filter((c) => isLiveIso(dated(c))),
    "confirmed cards matching a field still INSIDE the plan window",
  );
  /* linkCard drives every "the plan is still promised" assertion, so it has to be a LIVE one. */
  const linkCard = liveMatches[0];
  const linkVenue = byName.get(norm(linkCard.title));

  /* ── THE PAST-WINDOW SUBJECTS ARE MANUFACTURED, NOT FOUND ──────────────────────────────────
   * They used to be picked off production, and production ran out of them: every card matching an
   * old field has since been bound, so there is no unbound past-window card left to point at. A
   * suite that depends on a backlog existing dies the day the backlog is cleared.
   *
   * So the dates are SHIFTED ON THE READ instead. A card matching a venue with no launch date at
   * all becomes a past-window subject by giving that venue an old date on the way past. It is a
   * read-side fixture, never a write, and it holds whatever the board looks like. */
  const undatedMatches = nonEmpty(
    confirmedUnbound.filter((c) => byName.has(norm(c.title)) && !dated(c) && c.id !== linkCard.id),
    "confirmed cards matching a field that has NO launch date",
  );
  if (undatedMatches.length < 2) throw new Error(`need two undated matching cards, found ${undatedMatches.length}`);
  const OLD_ISO = isoOffsetDays(-260);
  /* pastCard drives the new no-plan state. */
  const pastCard = undatedMatches[0];
  const pastVenue = { ...byName.get(norm(pastCard.title)), launch_date: OLD_ISO };
  /* The injected pair. boundCard takes its own (shifted, past) venue; boundLiveCard takes a LIVE
   * venue that no card is named after, so injecting it disturbs no name resolution anywhere. */
  const boundCard = undatedMatches[1];
  const boundVenue = { ...byName.get(norm(boundCard.title)), launch_date: OLD_ISO };
  const liveVenueFree = nonEmpty(
    (venues ?? []).filter((v) => v.launch_date && isLiveIso(v.launch_date)
      && !matching.some((c) => norm(c.title) === norm(v.venue_name)) && v.id !== linkVenue.id),
    "live venues that no confirmed card is named after",
  )[0];
  /* ── THE TWO CARDS THAT MATCH NOTHING, TAKEN FROM ONE LIST SO THEY CANNOT BE THE SAME CARD ──
   * newCard has to stay UNBOUND (it is the "New field…" chip subject) and boundLiveCard gets a
   * venue injected onto it. Picking both with [0] of the same filter made them the same card, and
   * the chip assertions then read against a bound card that carries no chip. */
  const nonMatching = nonEmpty(
    confirmedUnbound.filter((c) => ![linkCard.id, pastCard.id, boundCard.id].includes(c.id)
      && !byName.has(norm(c.title))),
    "confirmed cards whose title matches no field",
  );
  if (nonMatching.length < 2) throw new Error(`need two non-matching cards, found ${nonMatching.length}`);
  const newCard = nonMatching[0];
  const boundLiveCard = nonMatching[1];
  /* PREFER A LIVE STAGE OVER archived — a collapsed Archived column renders no cards, and the
   * "not marked outside Confirmed" control would then be asserting against nothing. */
  const outsideAll = nonEmpty(
    (allCards ?? []).filter((c) => c.stage !== "confirmed" && c.venue_id == null),
    "unbound cards outside Confirmed",
  );
  const outside = outsideAll.find((c) => c.stage !== "archived") ?? outsideAll[0];
  console.log(`\nlink subject (LIVE)   : "${linkCard.title}" -> #${linkVenue.id} ${linkVenue.venue_name} launches ${linkVenue.launch_date} week ${weekIso(linkVenue.launch_date)}`);
  console.log(`past subject          : "${pastCard.title}" -> #${pastVenue.id} ${pastVenue.venue_name} launched ${pastVenue.launch_date} week ${weekIso(pastVenue.launch_date)}`);
  console.log(`bound past (injected) : "${boundCard.title}" -> #${boundVenue.id} ${boundVenue.venue_name} ${boundVenue.launch_date} week ${weekIso(boundVenue.launch_date)}`);
  console.log(`bound live (injected) : "${boundLiveCard.title}" -> #${liveVenueFree.id} ${liveVenueFree.venue_name} ${liveVenueFree.launch_date} week ${weekIso(liveVenueFree.launch_date)}`);
  console.log(`new subject  : "${newCard.title}" (matches nothing)`);
  console.log(`outside      : "${outside.title}" in ${outside.stage}`);
  console.log(`unbound confirmed: ${confirmedUnbound.length}`);

  const bindOpts = {
    inject: [
      { cardId: boundCard.id, venueId: boundVenue.id },
      { cardId: boundLiveCard.id, venueId: liveVenueFree.id },
    ],
    shiftVenues: [
      { id: pastVenue.id, iso: OLD_ISO },
      { id: boundVenue.id, iso: OLD_ISO },
    ],
  };

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
    const boundLiveC = d.cards.find((c) => c.id === boundLiveCard.id);
    const boundPastC = d.cards.find((c) => c.id === boundCard.id);
    yes("  CONTROL: both injected cards are on the board", boundLiveC != null && boundPastC != null);
    is("  CONTROL: a card that already has a field carries no chip at all", boundLiveC.chip, null);
    yes(`  a live one carries its countdown instead: "${boundLiveC.cd}"`,
      /days (to launch|since launch)|Launches today/.test(boundLiveC.cd ?? ""));
    is("  CONTROL: and is marked as a live countdown", boundLiveC.cdPast, "0");
    /* A LAUNCH THAT IS OVER IS NOT A COUNTDOWN. "236 days since launch" only ever goes up. */
    yes(`  a field past the plan window says when it opened instead: "${boundPastC.cd}"`,
      /^launched [A-Z][a-z]{2} \d{4}$/.test(boundPastC.cd ?? ""));
    is("  and is marked as past the window", boundPastC.cdPast, "1");
    yes("  CONTROL: with no growing day count on it",
      !/days since launch/.test(boundPastC.cd ?? ""), boundPastC.cd);
    yes(`  a card with no field still reads differently from one with (${newC.borderLeft} vs ${boundLiveC.borderLeft})`,
      newC.borderLeft !== boundLiveC.borderLeft);

    // 5. AN UNBOUND CARD OUTSIDE CONFIRMED IS NOT MARKED.
    const outC = d.cards.find((c) => c.id === outside.id);
    yes(`  CONTROL: the outside card is on the board (${outC?.stage})`, outC != null);
    is("  CONTROL: an unbound card OUTSIDE Confirmed is not marked", outC.needs, "0");
    is("  CONTROL: and carries no amber edge", outC.borderLeft, boundLiveC.borderLeft);
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

    await openModalFor(p, boundLiveCard.id);
    d = await p.evaluate(READ);
    is("  CONTROL: a bound card's row knows it is bound", d.mfield.state, "bound");
    is("  and names its field", d.mname, liveVenueFree.venue_name);
    yes(`  with city, launch date and countdown: "${d.mmeta}"`,
      d.mmeta.includes(liveVenueFree.city) && /launches/.test(d.mmeta) && /days (to launch|since launch)|Launches today/.test(d.mmeta));
    yes(`  and Change rather than Create: "${d.mbtn.text}"`, /Change/.test(d.mbtn.text));
    await closeModal(p);

    /* THE MODAL AGREES WITH THE CARD past the window: when it opened, and that there is no plan. */
    await openModalFor(p, boundCard.id);
    d = await p.evaluate(READ);
    is("  a past-window bound card is still bound", d.mfield.state, "bound");
    yes(`  and its row says so: "${d.mmeta}"`,
      /past the plan window/.test(d.mmeta ?? "") && /no launch plan/.test(d.mmeta ?? ""));
    yes(`  naming when it opened: "${d.mmeta}"`, /launched /.test(d.mmeta ?? ""));
    yes("  CONTROL: and not a growing day count", !/days since launch/.test(d.mmeta ?? ""), d.mmeta);
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
      d.match.includes(linkVenue.venue_name) && d.match.includes(linkVenue.city)
      && /already launch(ed|es)/.test(d.match));
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

  // ══ 5-8, 11-12. A FIELD THAT HAS BEEN RUNNING FOR MONTHS GETS NO PLAN ════════════════════
  // Ryan, with the dialog open on PRUMC: "its saying link and create the plan but we dont need a
  // plan for ones that have been going for a long time."
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1200, bindOpts);
    console.log("\n-- a long-running field --");
    await p.click(`[data-testid="card"][data-id="${pastCard.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(600);
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  a long-running field brings its real launch date in", d.launch.value, pastVenue.launch_date);
    /* THE DIALOG STILL READS THE DATE BACK HONESTLY. It is the promise underneath that changes. */
    yes(`  and reads it back honestly: "${d.cd ?? ""}"`, /days since launch/.test(d.bindText ?? ""));

    // 5. THE NOTE.
    yes("  the dialog says there is no plan to make", d.noplan != null);
    yes(`  and why, in the plan's own terms: "${(d.noplan ?? "").slice(0, 60)}…"`,
      /four weeks before to sixteen weeks after/.test(d.noplan ?? ""));
    yes(`  with how long it has actually been running (${daysSince(pastVenue.launch_date)} days)`,
      new RegExp(`${daysSince(pastVenue.launch_date)} days ago`).test(d.noplan ?? ""));
    yes("  and names the date it opened", d.noplan.includes(String(new Date(pastVenue.launch_date).getUTCFullYear())));
    // 12. NO EM-DASH IN COPY RYAN READS.
    is("  CONTROL: no em-dash in the no-plan note", /—/.test(d.noplan ?? ""), false);
    is("  CONTROL: nor anywhere in the dialog's copy", /—/.test(d.bindText ?? ""), false);

    // 5. THE BUTTON AND THE PREVIEW.
    is("  no plan will be seeded", d.save.plan, "0");
    is(`  and the button stops promising one`, d.save.text, "Link the field");
    yes(`  the preview says so too: "${(d.preview ?? "").slice(0, 58)}…"`, /No launch plan/.test(d.preview ?? ""));
    is("  CONTROL: and does not mention 24 tasks", /24 tasks/.test(d.preview ?? ""), false);
    yes("  it can still be linked, because the record is the point", d.save.disabled === false);
    is("  CONTROL: and nothing has been written by any of this", writes, []);

    // 6. THE RELAUNCH OPT-IN.
    yes("  a plan can still be asked for", d.planopt != null);
    is("  CONTROL: but it is off by default", d.planoptChecked, false);
    yes("  and says what it is for", /relaunch/i.test(d.planopt ?? ""));
    yes("  and what it will look like", /open overdue/i.test(d.planopt ?? ""));
    is("  CONTROL: em-dash free here too", /—/.test(d.planopt ?? ""), false);
    await p.check('[data-testid="bind-planopt-box"]');
    await p.waitForTimeout(400);
    d = await p.evaluate(READ);
    is("  ticking it brings the plan back", d.save.plan, "1");
    yes(`  and the button says so again: "${d.save.text}"`, /create the plan/i.test(d.save.text));
    yes("  CONTROL: and the preview counts them", /24 tasks/.test(d.preview ?? ""));
    /* THE OPT-IN IS ABOUT THE DATE IN THE BOX. Changing the date must not carry a tick across. */
    /* A DIFFERENT date, or React sees no change and the tick is never re-evaluated — the suite
     * would then be asserting that nothing happened when nothing was asked to. Still past the
     * window, so the opt-in is still on screen to be looked at. */
    await p.fill('[data-testid="bind-launch"]', isoOffsetDays(-400));
    await p.waitForTimeout(400);
    d = await p.evaluate(READ);
    is("  CONTROL: and changing the date clears the tick", d.planoptChecked, false);
    is("  CONTROL: so the plan is off again", d.save.plan, "0");
    await closeContext(ctx);
  }

  // ══ 7-8. A DATE INSIDE THE WINDOW IS UNTOUCHED ════════════════════════════════════════════
  {
    const { ctx, p, errs } = await boot(browser, storageState, 1200, bindOpts);
    console.log("\n-- a field still inside the window --");
    await p.click(`[data-testid="card"][data-id="${linkCard.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(600);
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is(`  CONTROL: ${linkCard.title} is week ${weekIso(linkVenue.launch_date)} and still gets its plan`, d.save.plan, "1");
    is("  CONTROL: with no no-plan notice", d.noplan, null);
    is("  CONTROL: and nothing to opt into", d.planopt, null);
    yes(`  CONTROL: the button promises the plan: "${d.save.text}"`, /Link and create the plan/.test(d.save.text));
    // 8. A FIELD THAT OPENED INSIDE THE WINDOW SAYS WHICH PART IS ALREADY PAST.
    const openedAlready = localMid(linkVenue.launch_date) < midnight(new Date());
    if (openedAlready) {
      yes("  and one that opened inside the window says which part of its plan is behind it",
        /build-up weeks are already behind it/.test(d.preview ?? ""), d.preview);
    } else {
      yes("  CONTROL: a launch still ahead makes no such claim",
        !/already behind it/.test(d.preview ?? ""), d.preview);
    }
    // 11. PAST TENSE.
    yes(`  the offer reads "already launched" for a date gone by: "${(d.match ?? "").slice(0, 62)}…"`,
      openedAlready && /already launched/.test(d.match ?? "") && !/already launches/.test(d.match ?? ""));
    await closeContext(ctx);
  }

  // ══ 11 CONTROL. "already launches" FOR A DATE STILL AHEAD ═════════════════════════════════
  // NO VENUE IN PRODUCTION HAS A FUTURE LAUNCH DATE (the newest is 28 days ago), so the present
  // tense is unreachable from real data. The venue read is shifted forward on the way past —
  // a READ-side fixture, not a write — so the control is real rather than skipped.
  {
    const ahead = isoOffsetDays(30);
    const { ctx, p, errs } = await boot(browser, storageState, 1200,
      { ...bindOpts, shiftVenues: [...bindOpts.shiftVenues, { id: linkVenue.id, iso: ahead }] });
    console.log("\n-- a launch still ahead --");
    await p.click(`[data-testid="card"][data-id="${linkCard.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(600);
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  CONTROL: the shifted date is the one offered", d.launch.value, ahead);
    yes(`  CONTROL: and the offer reads "already launches": "${(d.match ?? "").slice(0, 58)}…"`,
      /already launches/.test(d.match ?? "") && !/already launched/.test(d.match ?? ""));
    is("  CONTROL: a launch still ahead still gets its plan", d.save.plan, "1");
    yes("  CONTROL: and claims nothing is behind it", !/already behind it/.test(d.preview ?? ""));
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
    is("  every unbound confirmed card gets a row",
      d.rows.length, confirmedUnbound.length - bindOpts.inject.length);
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
    /* A LIVE VENUE, DELIBERATELY. Seeding a past-window field is now refused, so linking to one
     * would correctly write no plan and the shared-path assertion below would fail for the right
     * reason and tell us nothing. The refusal gets its own assertion afterwards. */
    const freeVenue = nonEmpty(
      (venues ?? []).filter((v) => v.launch_date && isLiveIso(v.launch_date)
        && v.id !== boundVenue.id && v.id !== linkVenue.id && v.id !== liveVenueFree.id
        && !(allCards ?? []).some((c) => c.venue_id === v.id)),
      "LIVE venues with a launch date that no card holds",
    )[0];
    await p.fill(`[data-testid="match-row"][data-id="${newCard.id}"] [data-testid="mr-name"]`, freeVenue.venue_name);
    await p.waitForTimeout(500);
    d = await p.evaluate(READ);
    const rFree = d.rows.find((r) => r.id === newCard.id);
    yes(`  a corrected name that is free resolves to a link: "${(rFree.res ?? "").slice(0, 48)}…"`,
      /Links to/.test(rFree.res) && rFree.res.includes(freeVenue.venue_name));
    is("  and brings that field's date in", rFree.date, freeVenue.launch_date);
    is("  CONTROL: which makes it saveable", rFree.go.disabled, false);

    // ══ 9. THE MATCH ROWS CARRY THE SAME RULE, WHERE THE DECISION IS TAKEN ══════════════════
    d = await p.evaluate(READ);
    const rowLive = d.rows.find((r) => r.id === linkCard.id);
    const rowPast = d.rows.find((r) => r.id === pastCard.id);
    yes("  CONTROL: both a live row and a past-window row are on the list", rowLive != null && rowPast != null);
    yes(`  a row inside the window says it starts the plan: "${(rowLive.res ?? "").slice(-40)}"`,
      /Starts a 24-task plan/.test(rowLive.res ?? ""));
    is("  and is marked as planning", rowLive.go.plan, "1");
    yes(`  CONTROL: a past-window row says No plan instead: "${(rowPast.res ?? "").slice(-58)}"`,
      /No plan/.test(rowPast.res ?? "") && /past the plan window/.test(rowPast.res ?? ""));
    yes(`  naming how long it has been open (${daysSince(pastVenue.launch_date)} days)`,
      new RegExp(`${daysSince(pastVenue.launch_date)} days ago`).test(rowPast.res ?? ""));
    is("  CONTROL: and is marked as not planning", rowPast.go.plan, "0");
    is("  CONTROL: and does not claim 24 tasks", /24-task/.test(rowPast.res ?? ""), false);
    yes("  CONTROL: but is still linkable, because the record is the point", rowPast.go.disabled === false);
    // 11 on a row: past tense there too.
    yes(`  the row reads "already launched" for a date gone by`,
      /already launched/.test(rowPast.res ?? "") && !/already launches/.test(rowPast.res ?? ""));

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

    /* ── 1. THE GUARD, AT THE WRITE LEVEL ───────────────────────────────────────────────────
     * The strongest form of "a field that has been running for months does not get a plan": press
     * Link on a past-window row and count what actually left the browser. */
    const before = writes.filter((w) => w.table === "field_launch_tasks").length;
    await p.click(`[data-testid="match-row"][data-id="${pastCard.id}"] [data-testid="mr-go"]`);
    await p.waitForTimeout(1600);
    const after = writes.filter((w) => w.table === "field_launch_tasks").length;
    is("  linking a past-window field writes NO launch plan", after, before);
    yes("  CONTROL: while the card itself is still bound",
      writes.filter((w) => w.table === "kanban_cards").length >= 2);
    await closeContext(ctx);
  }

  // ══ 2. force OVERRIDES THE GUARD, AND ONLY THE OPT-IN CAN SET IT ══════════════════════════
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1200, bindOpts);
    console.log("\n-- the relaunch override --");
    await p.click(`[data-testid="card"][data-id="${pastCard.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(500);
    is("  no page error", errs, []);
    /* SAVE WITHOUT TICKING IT FIRST: the refusal is the default. */
    await p.click('[data-testid="bind-save"]');
    await p.waitForTimeout(1600);
    is("  saving a past-window field writes no plan", writes.filter((w) => w.table === "field_launch_tasks").length, 0);
    yes("  CONTROL: but does write the binding", writes.some((w) => w.table === "kanban_cards"));
    await closeContext(ctx);
  }
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1200, bindOpts);
    await p.click(`[data-testid="card"][data-id="${pastCard.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(500);
    await p.check('[data-testid="bind-planopt-box"]');
    await p.waitForTimeout(400);
    await p.click('[data-testid="bind-save"]');
    await p.waitForTimeout(1800);
    is("  no page error", errs, []);
    const seeded = writes.find((w) => w.table === "field_launch_tasks");
    yes("  ticking the relaunch opt-in seeds the plan after all", seeded != null);
    if (seeded) is("  ...all 24 of it", JSON.parse(seeded.body).length, 24);
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
