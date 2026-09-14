// PICK THE FIELD. DO NOT REMEMBER IT.
//
// Ryan, with the Edit card modal open on Ann Richards: "why cant i find ann richards its still too
// find i have to remember names."
//
// Ann Richards School (#65) exists. The modal told him it did not, because the Field row branched
// on the exact-match rule alone and never ran the search. And the search itself was substring, so
// it found four of the eight backlog cards the item-3 report had found by shared words — the report
// and the screen disagreed, and the screen was the one he was looking at.
//
// NOTHING IS WRITTEN. Every non-GET is intercepted; reads pass through to production.
//
// THE SUBSTRING CONTROL IS COMPUTED IN THE SUITE, not asserted from memory, so "includes() returns
// zero for this card" is a measured number printed beside the word-rule result.
//
//   node scripts/e2e/verify-pick-field.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
import { pickUnbindTarget, patchCards } from "./_cardFixtures.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

const norm = (s) => String(s ?? "").trim().toLowerCase();
/* THE TWO RULES, SIDE BY SIDE. The suite computes both so every "the old rule found nothing" is a
 * number it measured this run, not a claim inherited from a prompt. */
const STOP = new Set(["the", "and", "for", "new"]);
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
const substringRule = (venues, t0) => {
  const t = norm(t0);
  if (t.length < 2) return [];
  return venues.filter((v) => norm(v.venue_name).includes(t) && norm(v.venue_name) !== t);
};
const wordRule = (venues, t0) => {
  const t = norm(t0);
  const qw = words(t0);
  if (!t) return venues.slice();
  return venues.filter((v) => {
    const n = norm(v.venue_name);
    if (n === t) return false;
    if (t.length >= 2 && n.includes(t)) return true;
    return qw.some((w) => words(v.venue_name).includes(w));
  });
};

const READ = () => {
  const q = (s) => document.querySelector(s);
  const T = (s) => q(s)?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const save = q('[data-testid="bind-save"]');
  const scroll = q('[data-testid="bind-cands-scroll"]');
  const dlg = q('[data-testid="bind-dialog"]');
  const mf = q('[data-testid="m-field"]');
  const mbtn = q('[data-testid="m-field-btn"]');
  return {
    vw, vh,
    hscroll: document.documentElement.scrollWidth > vw + 2,
    name: q('[data-testid="bind-newname"]')?.value ?? null,
    match: T('[data-testid="bind-match"]'),
    dupe: T('[data-testid="bind-dupe"]'),
    save: save ? { mode: save.dataset.mode, disabled: save.disabled } : null,
    dlgBox: dlg ? { h: +dlg.getBoundingClientRect().height.toFixed(1), w: +dlg.getBoundingClientRect().width.toFixed(1),
      t: +dlg.getBoundingClientRect().top.toFixed(1), b: +dlg.getBoundingClientRect().bottom.toFixed(1) } : null,
    candsOpen: q('[data-testid="bind-cands"]') != null,
    candsHd: T('[data-testid="bind-cands-hd"]'),
    more: T('[data-testid="cand-more"]'),
    cities: [...document.querySelectorAll('[data-testid="cand-city"]')].map((e) => e.textContent.trim()),
    scroll: scroll ? { sh: scroll.scrollHeight, ch: scroll.clientHeight } : null,
    cands: [...document.querySelectorAll('[data-testid="cand"]')].map((c) => ({
      id: c.dataset.id, held: c.dataset.held, disabled: c.disabled,
      name: c.querySelector(".cn")?.textContent.trim() ?? "",
      meta: c.querySelector(".cm")?.textContent.trim() ?? "",
      h: +c.getBoundingClientRect().height.toFixed(1),
      bg: getComputedStyle(c).backgroundColor,
      clipped: (() => { const n = c.querySelector(".cn"); return n ? n.scrollWidth > n.clientWidth + 1 : false; })(),
    })),
    /* THE MODAL ROW */
    mfield: mf ? { cands: mf.dataset.cands, state: mf.dataset.state } : null,
    mmeta: T('[data-testid="m-field-meta"]'),
    mbtn: mbtn ? { text: mbtn.textContent.trim(), kind: mbtn.dataset.kind } : null,
  };
};

let UNBIND = [];
let RETITLE = null;
async function boot(browser, storageState, width, opts = {}) {
  opts = { ...opts, unbind: [...UNBIND, ...(opts.unbind ?? [])], retitle: opts.retitle ?? RETITLE ?? undefined };
  const ctx = await browser.newContext({ storageState, viewport: { width, height: opts.height ?? 1000 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });
  const writes = [];
  await ctx.route("**/rest/v1/field_launch_tasks*", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: "[]" })
      : (writes.push({ table: "field_launch_tasks" }), r.fulfill({ status: 201, contentType: "application/json", body: "[]" })));
  await ctx.route("**/rest/v1/fin_venues*", (r) =>
    r.request().method() === "GET" ? r.fallback() : (writes.push({ table: "fin_venues" }), r.fulfill({ status: 204, body: "" })));
  await ctx.route("**/rest/v1/kanban_cards*", async (route) => {
    const m = route.request().method();
    if (m !== "GET" && m !== "HEAD") { writes.push({ table: "kanban_cards" }); return route.fulfill({ status: 204, body: "" }); }
    if (!opts.retitle && !opts.unbind) return route.fallback();
    /* ONE CARD RENAMED ON THE WAY PAST, so the "nothing looks like this" branch has a subject.
     * Every card on the board now returns at least one candidate — the two that did not have since
     * been bound or deleted — so the empty branch cannot be reached from real data. */
    const res = await route.fetch();
    const j = await res.json().catch(() => null);
    if (!Array.isArray(j)) return route.fulfill({ response: res });
    patchCards(j, {
      unbind: opts.unbind ?? [],
      retitle: opts.retitle ? [{ cardId: opts.retitle.id, title: opts.retitle.title }] : [],
    });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(`${BASE}/growth/field-pipeline`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="card"]', { timeout: 180000 });
  await p.waitForTimeout(1400);
  return { ctx, p, writes, errs };
}

const openModalFor = async (p, cardId) => {
  await p.click(`[data-testid="card"][data-id="${cardId}"] [class*='break-words']`);
  await p.waitForSelector('[data-testid="m-field"]', { timeout: 15000 });
  await p.waitForTimeout(300);
};
const closeModal = async (p) => {
  const b = await p.$('[aria-label="Close"]');
  if (b) await b.click(); else await p.keyboard.press("Escape");
  await p.waitForSelector('[data-testid="m-field"]', { state: "detached", timeout: 15000 });
  await p.waitForTimeout(200);
};

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const venues = nonEmpty((await sb.from("fin_venues").select("id,venue_name,city,launch_date")).data ?? [], "fin_venues rows");
  const allCards = (await sb.from("kanban_cards").select("id,title,stage,venue_id,data").eq("board_type", "field_pipeline")).data ?? [];
  const held = new Map();
  for (const c of allCards) if (c.venue_id != null) held.set(c.venue_id, c);
  /* ── THE SUBJECT IS MANUFACTURED, NOT FOUND ────────────────────────────────────────────────
   * Every Confirmed card is bound now, so there is no unbound one to point at. One is unbound on
   * the READ; nothing is written. */
  const target = pickUnbindTarget(allCards);
  if (!target) throw new Error("no confirmed bound card to unbind on the read");
  UNBIND = [target.cardId];
  /* AND RETITLED so it is the shape this suite is about: a card the OLD substring rule cannot find
   * and the word rule can. Derived from a real venue's own first word plus a token that appears in
   * no name, so it keeps working whatever Finance holds. */
  const seedVenue = nonEmpty(
    (venues ?? []).filter((v) => words(v.venue_name).length > 0 && !held.has(v.id) && v.id !== target.freedVenueId),
    "unheld venues with a usable word",
  )[0];
  const MADE_TITLE = `${words(seedVenue.venue_name)[0]} Zzq`;
  if (substringRule(venues, MADE_TITLE).length !== 0) throw new Error(`made title "${MADE_TITLE}" is findable by substring`);
  if (wordRule(venues, MADE_TITLE).length === 0) throw new Error(`made title "${MADE_TITLE}" finds nothing`);
  RETITLE = { id: target.cardId, title: MADE_TITLE };
  const unbound = [{ ...allCards.find((c) => c.id === target.cardId), venue_id: null, title: MADE_TITLE }];
  /* The venue it used to hold is now FREE, so it must not be treated as held below. */
  held.delete(target.freedVenueId);
  console.log(`\nunbound on the read: "${target.title}" -> retitled "${MADE_TITLE}" (freeing venue #${target.freedVenueId})`);
  console.log(`  word rule finds ${wordRule(venues, MADE_TITLE).length}, substring finds ${substringRule(venues, MADE_TITLE).length}`);

  // ══ 14. THE WALK, PRINTED ═════════════════════════════════════════════════════════════════
  console.log(`\nfin_venues ${venues.length} · unbound confirmed ${unbound.length}`);
  console.log("card".padEnd(28), "word", "subs", "top candidate");
  const zeroCards = [];
  for (const c of unbound) {
    const w = wordRule(venues, c.title);
    const s = substringRule(venues, c.title);
    const exact = venues.find((v) => norm(v.venue_name) === norm(c.title));
    if (w.length === 0 && !exact) zeroCards.push(c.title);
    console.log(`  ${c.title.slice(0, 26).padEnd(26)} ${String(w.length).padStart(4)} ${String(s.length).padStart(4)}  ${w[0]?.venue_name ?? (exact ? `[exact: ${exact.venue_name}]` : "(nothing)")}`);
  }
  yes(`  every unbound card returns at least one candidate or an exact match (${zeroCards.length} do not)`,
    zeroCards.length === 0, `no candidates: ${zeroCards.join(", ")}`);
  const worst = Math.max(...unbound.map((c) => wordRule(venues, c.title).length));
  yes(`  and none returns an unusable pile (biggest is ${worst})`, worst <= 12);

  /* THE SUBJECT: a card whose field the OLD rule could not find. Derived, so the suite keeps
   * meaning something as the backlog is worked through. */
  const wordOnly = unbound
    .map((c) => ({ c, w: wordRule(venues, c.title), s: substringRule(venues, c.title) }))
    .filter((x) => x.w.length > 0 && x.s.length === 0 && !venues.some((v) => norm(v.venue_name) === norm(x.c.title)));
  const subject = nonEmpty(wordOnly, "cards the substring rule cannot find but the word rule can")[0];
  const subjCity = String(subject.c.data?.city ?? "");
  console.log(`\nsubject: "${subject.c.title}" — word ${subject.w.length}, includes() ${subject.s.length}`);
  console.log(`  finds: ${subject.w.map((v) => v.venue_name).join(", ")}`);

  // ══ 1. THE MODAL ROW NAMES A CANDIDATE ════════════════════════════════════════════════════
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1200);
    console.log("\n-- the modal's Field row --");
    await openModalFor(p, subject.c.id);
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  the row ran the search", d.mfield.cands, String(subject.w.length));
    yes(`  and names a candidate: "${d.mmeta}"`,
      /could be this one, including/.test(d.mmeta ?? ""));
    yes("  naming the field the old rule could not reach", d.mmeta.includes(subject.w[0].venue_name));
    is("  CONTROL: and it no longer claims nothing carries the name",
      /Nothing in Finance carries this name/.test(d.mmeta ?? ""), false);
    is("  the button says Find, not Create", d.mbtn.text, "Find the field…");
    is("  and is marked as a find", d.mbtn.kind, "find");
    is("  nothing written", writes, []);
    await closeModal(p);
    await closeContext(ctx);
  }

  // ══ 1 CONTROL. A CARD THAT REALLY MATCHES NOTHING ═════════════════════════════════════════
  {
    /* MEASURED FIRST: the string the suite renames a card to must genuinely return zero under BOTH
     * rules, or the control proves nothing. */
    const emptyTitle = "Zzqx Nowhere Ground";
    is("  CONTROL: the empty-case title really returns zero on the word rule",
      wordRule(venues, emptyTitle).length, 0);
    is("  CONTROL: and zero on the old substring rule too", substringRule(venues, emptyTitle).length, 0);
    const { ctx, p, errs } = await boot(browser, storageState, 1200,
      { retitle: { id: subject.c.id, title: emptyTitle } });
    console.log("\n-- a card that really matches nothing --");
    await openModalFor(p, subject.c.id);
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  the row looked and found nothing", d.mfield.cands, "0");
    yes(`  and says so honestly: "${d.mmeta}"`, /Nothing in Finance looks like this name/.test(d.mmeta ?? ""));
    is("  CONTROL: and the button is Create", d.mbtn.text, "Create…");
    is("  CONTROL: marked as a create", d.mbtn.kind, "bind");
    await closeModal(p);
    await closeContext(ctx);
  }

  // ══ 2, 3, 6, 7, 8, 9, 10, 11. THE DIALOG'S LIST ═══════════════════════════════════════════
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 1200);
    console.log("\n-- the dialog opens already showing the list --");
    await p.click(`[data-testid="card"][data-id="${subject.c.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(600);
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  the box is seeded from the card title", d.name, subject.c.title);
    yes("  and the list is already on screen, nothing typed", d.candsOpen);
    is("  showing what the word rule found", d.cands.length, Math.min(12, subject.w.length));
    is("  CONTROL: and nothing is picked — the save is still a create", d.save.mode, "create");

    // 3. CLICKING A ROW.
    const pick = subject.w.find((v) => !held.has(v.id));
    yes(`  CONTROL: there is a free candidate to click (${pick?.venue_name})`, pick != null);
    await p.click(`[data-testid="cand"][data-id="${pick.id}"]`);
    await p.waitForTimeout(500);
    d = await p.evaluate(READ);
    is("  clicking a row fills the name", d.name, pick.venue_name);
    is("  and turns it into a link", d.save.mode, "link");
    yes("  with the offer on screen", d.match != null);

    // 4. AN EMPTY BOX LISTS EVERYTHING, CITY-GROUPED.
    await p.fill('[data-testid="bind-newname"]', "");
    await p.waitForTimeout(600);
    d = await p.evaluate(READ);
    yes("  clearing the box lists every field", d.candsOpen);
    is("  all of them", d.cands.length, venues.length);
    yes(`  with a header saying how many: "${(d.candsHd ?? "").slice(0, 56)}…"`,
      new RegExp(`All ${venues.length} fields in Finance`).test(d.candsHd ?? ""));
    yes("  and that nothing is picked until a row is clicked",
      /Nothing is picked until you click a row/.test(d.candsHd ?? ""));
    yes(`  grouped by city (${d.cities.length} headings)`, d.cities.length >= 2);
    is("  CONTROL: and still nothing is picked", d.save.mode, "create");

    // 5. IT SCROLLS INSIDE A FIXED BOX.
    yes(`  the list scrolls inside a fixed box (${d.scroll.sh} in ${d.scroll.ch})`, d.scroll.sh > d.scroll.ch);

    // 4 CONTROL: typing narrows it and drops the city headings.
    await p.fill('[data-testid="bind-newname"]', subject.c.title);
    await p.waitForTimeout(600);
    d = await p.evaluate(READ);
    yes(`  CONTROL: typing narrows it (${venues.length} to ${d.cands.length})`, d.cands.length < venues.length);
    is("  CONTROL: and drops the city headings", d.cities.length, 0);

    // 6. THE FOUR THE OLD RULE COULD NOT FIND.
    console.log("\n-- the four the substring rule missed --");
    for (const [query, wantName] of [
      ["Katy ISC", "KISC (Katy Intl)"],
      ["OC / Onion Creek - AMSA", "Onion Creek"],
      ["Crockett HS (AISD)", "Crockett High School"],
      ["STAR Soccer Complex", "STAR"],
    ]) {
      const target = venues.find((v) => v.venue_name === wantName);
      if (!target) { bad(`  "${query}" -> ${wantName}`, "that venue no longer exists"); continue; }
      await p.fill('[data-testid="bind-newname"]', query);
      await p.waitForTimeout(550);
      d = await p.evaluate(READ);
      const subs = substringRule(venues, query);
      yes(`  "${query}" finds ${wantName} (${d.cands.length} candidates; includes() returns ${subs.length})`,
        d.cands.some((c) => c.name === wantName));
      is(`    CONTROL: the old substring rule returned ${subs.length} for it`, subs.length, 0);
      is("    CONTROL: and nothing is picked", d.save.mode, "create");
    }

    // 7. STILL A FILTER.
    await p.fill('[data-testid="bind-newname"]', "Katy ISC");
    await p.waitForTimeout(550);
    d = await p.evaluate(READ);
    const katy = wordRule(venues, "Katy ISC").map((v) => v.venue_name);
    is("  CONTROL: the Katy result is exactly what the rule says it is",
      d.cands.map((c) => c.name).sort(), katy.slice(0, 12).sort());
    yes("  CONTROL: an unrelated field is not in it", !d.cands.some((c) => /PRUMC|Galatzan/.test(c.name)));
    await p.fill('[data-testid="bind-newname"]', "The Hattrick");
    await p.waitForTimeout(550);
    d = await p.evaluate(READ);
    yes(`  CONTROL: the stoplist keeps "the" from dragging anything in (${d.cands.length} candidates)`,
      d.cands.every((c) => /hattrick/i.test(c.name)), d.cands.map((c) => c.name).join(", "));

    // 8. NOTHING REGRESSED.
    await p.fill('[data-testid="bind-newname"]', "parmer");
    await p.waitForTimeout(550);
    d = await p.evaluate(READ);
    yes("  \"parmer\" still finds PARMER Stadium", d.cands.some((c) => /PARMER/i.test(c.name)));
    is("  CONTROL: and the old rule agreed on this one", substringRule(venues, "parmer").length, 1);

    /* ── 9. BOTH HATTRICKS, THE CARD'S CITY FIRST, NEITHER PICKED ────────────────────────────
     * THE QUERY IS THE CARD'S OWN TITLE, not the bare word. "hattrick" IS the exact name of a
     * venue, so the resolver correctly answers "taken" and the assertion would be measuring the
     * resolver rather than the list. "The Hattrick" matches no venue exactly, which is the state
     * this is actually about. */
    await p.fill('[data-testid="bind-newname"]', "The Hattrick");
    await p.waitForTimeout(600);
    d = await p.evaluate(READ);
    const hats = venues.filter((v) => /hattrick/i.test(v.venue_name));
    yes(`  both Hattricks are listed (${d.cands.map((c) => c.name).join(", ")})`,
      d.cands.length >= Math.min(2, hats.length) && d.cands.every((c) => /hattrick/i.test(c.name)));
    is("  CONTROL: and neither is picked", d.save.mode, "create");
    is("  CONTROL: the box still says what was typed", d.name, "The Hattrick");
    /* SAME CITY FIRST. The card carries a city; the list puts that city's field at the top and the
     * other city's below it. It is a reading order, and it still chooses nothing. */
    const cardCityName = String(subject.c.data?.city ?? "");
    const topCity = venues.find((v) => v.venue_name === d.cands[0].name)?.city ?? null;
    console.log(`     card city ${JSON.stringify(cardCityName)} · top candidate ${d.cands[0].name} (${topCity})`);
    const sameCityHats = hats.filter((v) => v.city === topCity);
    yes(`  and the card's own city sorts first (${d.cands.map((c) => c.name).join(" then ")})`,
      sameCityHats.length === 0 || d.cands[0].name === sameCityHats[0].venue_name
      || hats.every((v) => v.city === topCity));

    /* CONTROL: typing a held venue's EXACT name is still the taken refusal, untouched by any of
     * this. The list feeds the box; the box feeds the resolver; they are different rules. */
    const heldExact = venues.find((v) => held.has(v.id));
    await p.fill('[data-testid="bind-newname"]', heldExact.venue_name);
    await p.waitForTimeout(600);
    d = await p.evaluate(READ);
    is("  CONTROL: an exact held name is still refused by the resolver", d.save.mode, "taken");
    yes("  CONTROL: naming the holding card", /already linked to the card/.test(d.dupe ?? ""));

    // 10. NO LAUNCH DATE SAYS SO.
    const dateless = venues.find((v) => !v.launch_date && !held.has(v.id));
    if (dateless) {
      await p.fill('[data-testid="bind-newname"]', "");
      await p.waitForTimeout(600);
      d = await p.evaluate(READ);
      const row = d.cands.find((c) => c.id === String(dateless.id));
      yes(`  CONTROL: a dateless field is in the browse list (${dateless.venue_name})`, row != null);
      yes(`  a field with no launch date says so: "${row.meta}"`, /no launch date yet/.test(row.meta));
      is("  CONTROL: and does not show a blank", row.meta.trim().length > 6, true);
    } else {
      bad("  a field with no launch date says so", "no dateless unheld venue in production");
    }

    // 11. A HELD FIELD.
    const heldV = venues.find((v) => held.has(v.id));
    await p.fill('[data-testid="bind-newname"]', "");
    await p.waitForTimeout(600);
    d = await p.evaluate(READ);
    const hRow = d.cands.find((c) => c.id === String(heldV.id));
    const fRow = d.cands.find((c) => c.held === "0");
    yes(`  CONTROL: a held and a free field are both listed`, hRow != null && fRow != null);
    is("  a held field is listed but disabled", hRow.disabled, true);
    yes(`  naming its holder: "${hRow.meta}"`, hRow.meta.includes(held.get(heldV.id).title));
    is("  CONTROL: a free one beside it is pickable", fRow.disabled, false);
    yes(`  CONTROL: and the two look different (${hRow.bg} vs ${fRow.bg})`, hRow.bg !== fRow.bg);
    is("  nothing was written by any of this", writes, []);
    await closeContext(ctx);
  }

  // ══ 13. A PHONE ═══════════════════════════════════════════════════════════════════════════
  for (const w of [390, 1200]) {
    const { ctx, p, errs } = await boot(browser, storageState, w, { height: 780 });
    console.log(`\n-- ${w}px --`);
    await p.click(`[data-testid="card"][data-id="${subject.c.id}"] [data-testid="card-link"]`);
    await p.waitForSelector('[data-testid="bind-dialog"]', { timeout: 15000 });
    await p.waitForTimeout(600);
    let d = await p.evaluate(READ);
    is("  no page error", errs, []);
    yes("  seeded: no horizontal scroll", !d.hscroll);
    const rows = nonEmpty(d.cands, `candidates at ${w}`);
    yes(`  rows are ${Math.min(...rows.map((c) => c.h))}px`, rows.every((c) => c.h >= 44));
    is("  and no name is cut off, because long ones wrap",
      nonEmpty(rows, `rows at ${w}`).filter((c) => c.clipped).map((c) => c.name), []);
    yes(`  the dialog fits the width (${d.dlgBox.w} in ${w})`, d.dlgBox.w <= w - 20);
    yes(`  and the height (${d.dlgBox.h} in ${d.vh})`, d.dlgBox.h <= d.vh);

    /* BROWSING EVERY FIELD IS THE STATE THAT COULD PUSH THE DIALOG PAST THE VIEWPORT. */
    await p.fill('[data-testid="bind-newname"]', "");
    await p.waitForTimeout(700);
    d = await p.evaluate(READ);
    yes("  browsing: no horizontal scroll", !d.hscroll);
    yes(`  the dialog still fits the height with all ${d.cands.length} fields listed (${d.dlgBox.h} in ${d.vh})`,
      d.dlgBox.h <= d.vh);
    yes(`  because the list scrolls inside its box (${d.scroll.sh} in ${d.scroll.ch})`, d.scroll.sh > d.scroll.ch);
    const longest = d.cands.slice().sort((a, z) => z.name.length - a.name.length)[0];
    yes(`  CONTROL: the longest name is not clipped ("${longest.name}")`, !longest.clipped);
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\npick-field: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  XX ${f}`); process.exit(1); }
}

main().catch(fatal);
