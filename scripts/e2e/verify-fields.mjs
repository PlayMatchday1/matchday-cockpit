// Playwright verification for the Field Ops Schedule + Schedule-ends columns
// (CitiesFieldsLens) against the production BUILD. The Vercel deploy is behind
// Vercel SSO (no bypass), so this serves the identical build locally and drives
// it with a real minted admin session. The Supabase REST reads are intercepted
// with a controlled fixture so every schedule state (linked/needs-link/no-doc)
// and every ends state (standing/reserved-through/ends-soon/expired/not-set)
// renders deterministically — the same tactic the mockup uses with fabricated
// data. The component logic (state derivation, layout, editor) is the shipped code.
//
// Run: node scripts/e2e/verify-fields.mjs   (expects .auth/state.json for localhost)

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const RM = "50e7c3ba-e778-42eb-a960-81b69c18c1c5"; // rmancuso app_user id → resolves to "Ryan Mancuso"
const dISO = (off) => new Date(Date.now() + off * 864e5).toISOString().slice(0, 10);
const stamp = new Date(Date.now() - 2 * 864e5).toISOString();

// full fin_venues rows (both the main select and the ends select read these)
const v = (id, city, name, url, endDate, indefinite) => ({
  id, venue_name: name, city, contact_name: "Sam Ortiz", contact_number: "512-555-0100",
  min_players: 10, max_players: 30, schedule_url: url, is_active: true,
  schedule_end_date: endDate, schedule_indefinite: indefinite,
  schedule_end_updated_by: endDate || indefinite ? RM : null,
  schedule_end_updated_at: endDate || indefinite ? stamp : null,
});
const VENUES = [
  v(101, "Austin", "NEMP", "https://drive.google.com/nemp", null, true), // linked + standing
  v(102, "Austin", "Onion Creek", "https://drive.google.com/oc", dISO(100), false), // linked + reserved-through
  v(103, "Austin", "Round Rock", null, dISO(15), false), // needs-link + ends-soon
  v(104, "Austin", "LBJ ECHS", null, dISO(-10), false), // needs-link + expired
  v(105, "Austin", "Hattrick", null, null, false), // no-doc + not-set (mark below)
  v(106, "Houston", "PAC Global", null, dISO(200), false), // no-doc + reserved-through (mark below)
  v(107, "Houston", "Memorial Park", null, null, false), // needs-link + not-set
  v(108, "Houston", "Katy Fields", "https://drive.google.com/katy", dISO(5), false), // linked + ends-soon
];
// venue_schedule_marks → the "No document" state for 105 & 106
const MARKS = [
  { venue_id: 105, marked_by: RM, marked_at: stamp },
  { venue_id: 106, marked_by: RM, marked_at: stamp },
];

let PASS = 0, FAIL = 0; const fails = [];
function ok(n) { PASS++; console.log(`  ✓ ${n}`); }
function bad(n, d) { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); }
async function check(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } }
const distWhite = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return Math.sqrt((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2); };

async function main() {
  const state = JSON.parse(readFileSync(".auth/state.json", "utf8"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: { cookies: [], origins: state.origins.map((o) => ({ ...o, origin: BASE })) } });

  await context.route(/\/rest\/v1\//, (route) => {
    const req = route.request();
    const table = new URL(req.url()).pathname.split("/rest/v1/")[1].split("?")[0];
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (table === "app_users") return route.continue(); // real — auth + name resolution
    if (table === "fin_venues") return req.method() === "PATCH" ? json([{ id: 0 }]) : json(VENUES);
    if (table === "venue_schedule_marks") return json(MARKS);
    if (["city_managers", "fin_venue_fields", "mdapi_matches", "mdapi_match_players"].includes(table)) return json([]);
    return route.continue();
  });

  const page = await context.newPage();
  // wait for every state that later assertions/mutations rely on — .nodoc depends on
  // the async marks fetch, .over on the ends fetch, so a bare .se-sc wait races them.
  const ready = async () => {
    await page.waitForSelector(".se-sc.nodoc", { timeout: 30_000 });
    await page.waitForSelector(".se-sc.missing", { timeout: 30_000 });
    await page.waitForSelector(".se-sc.linked", { timeout: 30_000 });
    await page.waitForSelector('.se-ec[data-ends="over"]', { timeout: 30_000 });
    await page.waitForSelector('.se-ec[data-ends="unset"]', { timeout: 30_000 });
  };
  await page.goto(`${BASE}/match-ops/field-ops`, { waitUntil: "domcontentloaded" });
  await ready();

  const ev = (fn, arg) => page.evaluate(fn, arg);

  // ───────────────── POSITIVE — SHARED (both columns) ─────────────────
  console.log("\nPOSITIVE — both columns");

  for (const [col, sel] of [["Schedule", ".se-sc"], ["Schedule-ends", ".se-ec"]]) {
    await check(`[${col}] every cell same left & width, same top-offset in its row`, async () => {
      const m = await ev((s) => [...document.querySelectorAll(s)].map((c) => {
        const r = c.getBoundingClientRect(), row = c.closest(".fo-grid").getBoundingClientRect();
        return { left: Math.round(r.left), width: Math.round(r.width), top: Math.round(r.top - row.top) };
      }), sel);
      const spread = (k) => Math.max(...m.map((x) => x[k])) - Math.min(...m.map((x) => x[k]));
      if (spread("left") > 1) throw new Error(`left varies by ${spread("left")}px`);
      if (spread("width") > 1) throw new Error(`width varies by ${spread("width")}px`);
      if (spread("top") > 2) throw new Error(`top-offset varies by ${spread("top")}px`);
    });
    await check(`[${col}] heights vary ≤8px across all states`, async () => {
      const hs = await ev((s) => [...document.querySelectorAll(s)].map((c) => Math.round(c.getBoundingClientRect().height)), sel);
      const spread = Math.max(...hs) - Math.min(...hs);
      if (spread > 8) throw new Error(`height spread ${spread}px (${Math.min(...hs)}–${Math.max(...hs)})`);
    });
    await check(`[${col}] status label is the first child in every state`, async () => {
      const cls = col === "Schedule" ? "se-sl" : "se-el";
      const bad = await ev(({ s, cls }) => [...document.querySelectorAll(s)].filter((c) => !c.firstElementChild?.classList.contains(cls)).length, { s: sel, cls });
      if (bad) throw new Error(`${bad} cells whose first child is not .${cls}`);
    });
    await check(`[${col}] each state names itself in words`, async () => {
      const cls = col === "Schedule" ? "se-sl" : "se-el";
      const empties = await ev(({ s, cls }) => [...document.querySelectorAll(s)].filter((c) => !(c.querySelector("." + cls)?.textContent || "").trim()).length, { s: sel, cls });
      if (empties) throw new Error(`${empties} cells with an empty status label`);
    });
  }

  // Schedule (Part A): 3 distinct backgrounds AND borders
  await check("[Schedule] distinct background AND border per state (linked/needs-link/no-doc)", async () => {
    const s = await ev(() => ["linked", "missing", "nodoc"].map((k) => { const c = document.querySelector(".se-sc." + k); const st = getComputedStyle(c); return { k, bg: st.backgroundColor, bd: st.borderTopColor }; }));
    const bgs = new Set(s.map((x) => x.bg)), bds = new Set(s.map((x) => x.bd));
    if (bgs.size !== 3) throw new Error(`only ${bgs.size} distinct backgrounds`);
    if (bds.size !== 3) throw new Error(`only ${bds.size} distinct borders`);
  });

  // Schedule-ends (Part B): 5 distinct (bg,border-color,border-style) triples
  await check("[Schedule-ends] distinct fill/border per state (5 states)", async () => {
    const s = await ev(() => ["forever", "ok", "soon", "over", "unset"].map((k) => { const c = document.querySelector(`.se-ec.${k}, .se-ec[data-ends="${k}"]`); const st = getComputedStyle(c); return `${st.backgroundColor}|${st.borderTopColor}|${st.borderTopStyle}`; }));
    if (new Set(s).size !== 5) throw new Error(`only ${new Set(s).size} distinct fill/border triples across 5 states`);
  });

  await check("[Schedule] amber distance-from-white > mint > grey (grey smallest)", async () => {
    const b = await ev(() => ({ mint: getComputedStyle(document.querySelector(".se-sc.linked")).backgroundColor, amber: getComputedStyle(document.querySelector(".se-sc.missing")).backgroundColor, grey: getComputedStyle(document.querySelector(".se-sc.nodoc")).backgroundColor }));
    const dm = distWhite(b.mint), da = distWhite(b.amber), dg = distWhite(b.grey);
    if (!(da > dm && da > dg && dg < dm)) throw new Error(`amber=${da.toFixed(1)} mint=${dm.toFixed(1)} grey=${dg.toFixed(1)}`);
    console.log(`     amber=${da.toFixed(1)} mint=${dm.toFixed(1)} grey=${dg.toFixed(1)}`);
  });

  await check('[Schedule] "Open schedule" is an anchor with href and forest text', async () => {
    const a = await ev(() => { const el = document.querySelector(".se-sc.linked .se-open"); if (!el) return { missing: true }; return { tag: el.tagName, href: el.getAttribute("href"), color: getComputedStyle(el).color }; });
    if (a.missing) throw new Error("no .se-open in linked cell");
    if (a.tag !== "A") throw new Error(`tag=${a.tag}`);
    if (!a.href) throw new Error("no href");
    if (a.color !== "rgb(0, 51, 38)") throw new Error(`color=${a.color} (want forest rgb(0,51,38))`);
  });

  await check("[Schedule] no cell contains two primary controls", async () => {
    const worst = await ev(() => Math.max(...[...document.querySelectorAll(".se-sc")].map((c) => c.querySelectorAll(".se-open, .se-addlink").length)));
    if (worst > 1) throw new Error(`a cell has ${worst} primary controls`);
  });

  await check("legend swatches equal the cell fills", async () => {
    const r = await ev(() => {
      const sw = (k) => { const i = document.querySelector(`.se-legend i[data-swatch="${k}"]`); const s = getComputedStyle(i); return `${s.backgroundColor}|${s.borderTopColor}`; };
      const cell = (sel) => { const s = getComputedStyle(document.querySelector(sel)); return `${s.backgroundColor}|${s.borderTopColor}`; };
      return {
        linked: [sw("linked"), cell(".se-sc.linked")],
        amber: [sw("amber"), cell(".se-sc.missing")],
        grey: [sw("grey"), cell(".se-sc.nodoc")],
        coral: [sw("coral"), cell(".se-ec.over")],
      };
    });
    for (const [k, [a, b]] of Object.entries(r)) if (a !== b) throw new Error(`${k} swatch ${a} ≠ cell ${b}`);
  });

  // ───────────────── POSITIVE — SCHEDULE-ENDS specific ─────────────────
  console.log("\nPOSITIVE — Schedule-ends specifics");

  await check("no negative day count anywhere on the page", async () => {
    const hit = await ev(() => (document.body.innerText.match(/[-−]\d+\s+days?\b/g) || []));
    if (hit.length) throw new Error(`found: ${hit.join(", ")}`);
  });
  await check('expired cells read "N days ago"', async () => {
    const rels = await ev(() => [...document.querySelectorAll('.se-ec[data-ends="over"] .se-er')].map((e) => e.textContent));
    if (!rels.length) throw new Error("no expired cells in fixture");
    for (const r of rels) if (!/^\d+ days ago$/.test(r)) throw new Error(`rel "${r}"`);
  });
  await check('every dated cell prints an absolute "Mon D, YYYY" date', async () => {
    const vals = await ev(() => [...document.querySelectorAll('.se-ec[data-ends="over"] .se-ev, .se-ec[data-ends="soon"] .se-ev, .se-ec[data-ends="ok"] .se-ev')].map((e) => e.textContent));
    if (!vals.length) throw new Error("no dated cells");
    for (const t of vals) if (!/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(t)) throw new Error(`value "${t}"`);
  });
  await check("ends-soon within 30 days; reserved-through beyond 30", async () => {
    const soon = await ev(() => [...document.querySelectorAll('.se-ec[data-ends="soon"]')].map((e) => +e.dataset.days));
    const ok = await ev(() => [...document.querySelectorAll('.se-ec[data-ends="ok"]')].map((e) => +e.dataset.days));
    for (const d of soon) if (!(d >= 0 && d <= 30)) throw new Error(`soon has ${d} days`);
    for (const d of ok) if (!(d > 30)) throw new Error(`reserved-through has ${d} days`);
  });
  await check("Not set uses a dashed border, not a fill colour", async () => {
    const r = await ev(() => { const c = document.querySelector('.se-ec[data-ends="unset"]'); const s = getComputedStyle(c); return { style: s.borderTopStyle, bg: s.backgroundColor }; });
    if (r.style !== "dashed") throw new Error(`border-style=${r.style}`);
    if (r.bg !== "rgb(255, 255, 255)") throw new Error(`bg=${r.bg} (want white)`);
  });
  await check('the "Next match" line and "N of M in" line no longer appear', async () => {
    const t = await ev(() => document.body.innerText);
    if (/\bNEXT MATCH\b/.test(t)) throw new Error("NEXT MATCH header still present");
    if (/\d+ of \d+ in\b/.test(t)) throw new Error('"N of M in" line still present');
    if (/Nothing booked/.test(t)) throw new Error('"Nothing booked" still present');
    const hasEnds = await ev(() => [...document.querySelectorAll(".fo-grid div")].some((d) => d.textContent === "SCHEDULE ENDS"));
    if (!hasEnds) throw new Error("SCHEDULE ENDS header missing");
  });
  await check("clicking a cell opens exactly one editor with a date input and an Indefinite button", async () => {
    // venue 107 is needs-link + NOT set (not already standing), so the change is observable
    await ev(() => document.querySelector('.se-ec[data-venue="107"]').click());
    await page.waitForSelector(".se-edit", { timeout: 5000 });
    const r = await ev(() => ({ editors: document.querySelectorAll(".se-edit").length, date: !!document.querySelector('.se-edit input[type="date"]'), indef: [...document.querySelectorAll(".se-edit button")].some((b) => b.textContent.trim() === "Indefinite") }));
    if (r.editors !== 1) throw new Error(`${r.editors} editors open`);
    if (!r.date) throw new Error("no date input");
    if (!r.indef) throw new Error("no Indefinite button");
  });
  await check("choosing Indefinite writes the standing state (on that row) and closes the editor", async () => {
    await ev(() => [...document.querySelectorAll(".se-edit button")].find((b) => b.textContent.trim() === "Indefinite").click());
    await page.waitForTimeout(200);
    const r = await ev(() => { const c = document.querySelector('.se-ec[data-venue="107"]'); return { editors: document.querySelectorAll(".se-edit").length, forever: c?.dataset.ends === "forever", label: (c?.querySelector(".se-el")?.textContent || "").includes("Standing reservation"), value: c?.querySelector(".se-ev")?.textContent }; });
    if (r.editors !== 0) throw new Error("editor did not close");
    if (!r.forever || !r.label) throw new Error(`row 107 not standing (label ok=${r.label})`);
    if (r.value !== "Indefinite") throw new Error(`value="${r.value}"`);
  });
  await check("no row is both indefinite and dated (mutual exclusion holds in the DOM)", async () => {
    const bad = await ev(() => [...document.querySelectorAll(".se-ec")].filter((c) => { const ev = c.querySelector(".se-ev")?.textContent || ""; return c.dataset.ends === "forever" && /\d{4}/.test(ev); }).length);
    if (bad) throw new Error(`${bad} cells show both Indefinite and a date`);
  });

  // ───────────────── NEGATIVE CONTROLS ─────────────────
  console.log("\nNEGATIVE CONTROLS (each must FAIL cleanly)");
  let NCP = 0, NCF = 0;
  const reset = async () => { await page.reload({ waitUntil: "domcontentloaded" }); await ready(); };
  const neg = async (name, mutate, assertFn) => {
    await reset();
    await ev(mutate);
    let threw = false, msg = "";
    try { await assertFn(); } catch (e) { threw = true; msg = e.message; }
    if (threw) { NCP++; console.log(`  ✓ ${name} — assertion caught it: ${msg}`); }
    else { NCF++; console.log(`  ✗ ${name} — assertion did NOT fail (vacuous!)`); }
  };

  const bgDistinct = async () => { const s = await ev(() => ["linked", "missing", "nodoc"].map((k) => getComputedStyle(document.querySelector(".se-sc." + k)).backgroundColor)); if (new Set(s).size !== 3) throw new Error(`only ${new Set(s).size} distinct backgrounds`); };
  const firstChild = async () => { const bad = await ev(() => [...document.querySelectorAll(".se-sc")].filter((c) => !c.firstElementChild?.classList.contains("se-sl")).length); if (bad) throw new Error(`${bad} cells mis-ordered`); };
  const sameTop = async () => { const m = await ev(() => [...document.querySelectorAll(".se-sc")].map((c) => Math.round(c.getBoundingClientRect().top - c.closest(".fo-grid").getBoundingClientRect().top))); const spread = Math.max(...m) - Math.min(...m); if (spread > 2) throw new Error(`top-offset spread ${spread}px`); };
  const lumOrder = async () => { const b = await ev(() => ({ mint: getComputedStyle(document.querySelector(".se-sc.linked")).backgroundColor, amber: getComputedStyle(document.querySelector(".se-sc.missing")).backgroundColor, grey: getComputedStyle(document.querySelector(".se-sc.nodoc")).backgroundColor })); const dm = distWhite(b.mint), da = distWhite(b.amber), dg = distWhite(b.grey); if (!(da > dm && da > dg && dg < dm)) throw new Error(`ordering broken amber=${da.toFixed(1)} mint=${dm.toFixed(1)} grey=${dg.toFixed(1)}`); };
  const onePrimary = async () => { const worst = await ev(() => Math.max(...[...document.querySelectorAll(".se-sc")].map((c) => c.querySelectorAll(".se-open, .se-addlink").length))); if (worst > 1) throw new Error(`a cell has ${worst} primary controls`); };
  const noNeg = async () => { const hit = await ev(() => (document.body.innerText.match(/[-−]\d+\s+days?\b/g) || [])); if (hit.length) throw new Error(`found ${hit.join(",")}`); };
  const stateMatchesDate = async () => { const bad = await ev(() => [...document.querySelectorAll('.se-ec[data-ends="over"]')].filter((c) => +c.dataset.days >= 0).length); if (bad) throw new Error(`${bad} expired cells have a non-negative day count`); };

  await neg("recolour every no-doc cell to linked mint", () => { const mint = getComputedStyle(document.querySelector(".se-sc.linked")).backgroundColor; document.querySelectorAll(".se-sc.nodoc").forEach((c) => (c.style.background = mint)); }, bgDistinct);
  await neg("move a status label to the end of its cell", () => { const c = document.querySelector(".se-sc"); c.appendChild(c.firstElementChild); }, firstChild);
  await neg("add a top margin to one cell", () => { document.querySelector(".se-sc").style.marginTop = "20px"; }, sameTop);
  await neg("make no-doc louder than needs-a-link", () => { document.querySelectorAll(".se-sc.nodoc").forEach((c) => (c.style.background = "rgb(180, 40, 40)")); }, lumOrder);
  await neg("inject a second primary control into one cell", () => { const c = document.querySelector(".se-sc.linked"); const a = document.createElement("a"); a.className = "se-addlink"; a.textContent = "+ Add link"; c.appendChild(a); }, onePrimary);
  await neg('write "in -7 days" into an expired cell', () => { document.querySelector('.se-ec[data-ends="over"] .se-er').textContent = "in -7 days"; }, noNeg);
  await neg("set an expired cell 200 days out while leaving it coral", () => { const c = document.querySelector('.se-ec[data-ends="over"]'); c.dataset.days = "200"; }, stateMatchesDate);

  console.log(`\n================ RESULT ================`);
  console.log(`Positive assertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log(`   FAILED: ${f}`));
  console.log(`Negative controls:   ${NCP}/${NCP + NCF} failed cleanly as required`);
  await browser.close();
  process.exit(FAIL === 0 && NCF === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
