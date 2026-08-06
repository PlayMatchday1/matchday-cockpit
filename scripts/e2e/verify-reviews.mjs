// Playwright verification for the REPLIED? column (ReviewsClient) against the
// production BUILD, served locally (the Vercel deploy is SSO-gated). Supabase
// reads are intercepted with a controlled fixture covering all four states plus a
// 400-word comment; the component logic (state derivation, one-click resolve,
// undo) is the shipped code. Run: node scripts/e2e/verify-reviews.mjs

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const RM = "50e7c3ba-e778-42eb-a960-81b69c18c1c5"; // rmancuso → resolves to "Ryan Mancuso"
// This week contains 2026-08-06; put every review inside it (comment window = week).
const START = "2026-08-05T20:00:00";
const RATED = "2026-08-05T20:30:00";
const LONG = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");

const rev = (api_id, star, comment, mgr) => ({
  api_id, city_name: "Austin", field_title: `Field ${api_id}`,
  manager_first_name: mgr, manager_last_name: "M", star_rating: star,
  start_date: START, user_id: `u${api_id}`, updated_at_rating: RATED,
  comment, user_first_name: "Pat", user_last_name: "Player", user_email: `p${api_id}@gmail.com`, tags_rating: null,
});
const REVIEWS = [
  rev(9001, 1, null, "Ana"),                       // due  (1★, wordless)
  rev(9002, 2, "Field had no lights again", "Bo"), // due  (2★)
  rev(9003, 5, "Great manager, super fair", "Cy"), // done (mark replied)
  rev(9004, 4, "Minor gripe about the goalie", "Di"), // closed (mark no_reply_needed)
  rev(9005, 5, "Best pitch in town", "Ed"),        // notreq (5★, open)
  rev(9006, 5, LONG, "Fi"),                        // notreq + 400-word comment
];
const REPLIES = [
  { review_id: 9003, replied_at: RATED, replied_by: RM, kind: "replied", note: null },
  { review_id: 9004, replied_at: RATED, replied_by: RM, kind: "no_reply_needed", note: null },
];

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const check = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } };
const distWhite = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return Math.sqrt((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2); };

async function main() {
  const state = JSON.parse(readFileSync(".auth/state.json", "utf8"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: { cookies: [], origins: state.origins.map((o) => ({ ...o, origin: BASE })) } });
  await context.route(/\/rest\/v1\//, (route) => {
    const req = route.request();
    const table = new URL(req.url()).pathname.split("/rest/v1/")[1].split("?")[0];
    const json = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (table === "app_users") return route.continue();
    if (table === "mdapi_reviews") return json(REVIEWS);
    if (table === "review_replies") return req.method() === "GET" ? json(REPLIES) : json([]);
    if (table === "mdapi_users") return json([]);
    if (table === "fin_sync_log") return json([{ completed_at: RATED }]);
    return route.continue();
  });
  const page = await context.newPage();
  const ev = (fn, arg) => page.evaluate(fn, arg);

  await page.goto(`${BASE}/match-ops/reviews`, { waitUntil: "domcontentloaded" });
  // all four states must be present before asserting
  for (const s of ["due", "done", "closed", "notreq"]) await page.waitForSelector(`.rv-rc[data-s="${s}"]`, { timeout: 30_000 });

  console.log("\nPOSITIVE ASSERTIONS");

  await check("every cell same left & width, same top-offset in its td (incl. 400-word row)", async () => {
    const m = await ev(() => [...document.querySelectorAll(".rv-rc")].map((c) => {
      const r = c.getBoundingClientRect(), td = c.closest("td").getBoundingClientRect();
      return { left: Math.round(r.left - td.left), width: Math.round(r.width), top: Math.round(r.top - td.top) };
    }));
    const spread = (k) => Math.max(...m.map((x) => x[k])) - Math.min(...m.map((x) => x[k]));
    if (spread("left") > 1) throw new Error(`left offset varies ${spread("left")}px`);
    if (spread("width") > 1) throw new Error(`width varies ${spread("width")}px`);
    if (spread("top") > 2) throw new Error(`top offset varies ${spread("top")}px`);
  });
  await check("heights vary ≤8px across all states (incl. the 400-word comment row)", async () => {
    const hs = await ev(() => [...document.querySelectorAll(".rv-rc")].map((c) => Math.round(c.getBoundingClientRect().height)));
    const spread = Math.max(...hs) - Math.min(...hs);
    if (spread > 8) throw new Error(`height spread ${spread}px (${Math.min(...hs)}–${Math.max(...hs)})`);
  });
  await check("status label first child, secondary link last child, every state", async () => {
    const bad = await ev(() => [...document.querySelectorAll(".rv-rc")].filter((c) => !c.firstElementChild?.classList.contains("rv-rl") || !c.lastElementChild?.classList.contains("rv-rx")).length);
    if (bad) throw new Error(`${bad} cells mis-ordered`);
  });
  await check("four distinct backgrounds AND four distinct borders", async () => {
    const s = await ev(() => ["due", "done", "closed", "notreq"].map((k) => { const c = document.querySelector(`.rv-rc[data-s="${k}"]`); const st = getComputedStyle(c); return { bg: st.backgroundColor, bd: st.borderTopColor }; }));
    if (new Set(s.map((x) => x.bg)).size !== 4) throw new Error(`only ${new Set(s.map((x) => x.bg)).size} distinct backgrounds`);
    if (new Set(s.map((x) => x.bd)).size !== 4) throw new Error(`only ${new Set(s.map((x) => x.bd)).size} distinct borders`);
  });
  await check("each state names itself in words", async () => {
    const want = { due: "Reply due", done: "Replied", closed: "Closed, no reply", notreq: "No reply owed" };
    for (const [k, label] of Object.entries(want)) {
      const t = await ev((k) => document.querySelector(`.rv-rc[data-s="${k}"] .rv-rl`)?.textContent?.trim(), k);
      if (t !== label) throw new Error(`${k} label "${t}" ≠ "${label}"`);
    }
  });
  await check("reply-due distance-from-white is greatest; no-reply-owed is zero", async () => {
    const bg = await ev(() => Object.fromEntries(["due", "done", "closed", "notreq"].map((k) => [k, getComputedStyle(document.querySelector(`.rv-rc[data-s="${k}"]`)).backgroundColor])));
    const d = Object.fromEntries(Object.entries(bg).map(([k, v]) => [k, distWhite(v)]));
    if (!(d.due > d.done && d.due > d.closed && d.due > d.notreq)) throw new Error(`due=${d.due.toFixed(1)} not greatest (done=${d.done.toFixed(1)} closed=${d.closed.toFixed(1)})`);
    if (d.notreq !== 0) throw new Error(`no-reply-owed dist ${d.notreq.toFixed(2)} ≠ 0`);
    console.log(`     due=${d.due.toFixed(1)} done=${d.done.toFixed(1)} closed=${d.closed.toFixed(1)} notreq=${d.notreq.toFixed(1)}`);
  });
  await check("exactly one filled primary button, only on reply-due", async () => {
    const perState = await ev(() => [...document.querySelectorAll(".rv-rc")].map((c) => ({ s: c.dataset.s, n: c.querySelectorAll(".rv-pri").length })));
    for (const c of perState) {
      if (c.s === "due" && c.n !== 1) throw new Error(`due has ${c.n} filled buttons`);
      if (c.s !== "due" && c.n !== 0) throw new Error(`${c.s} has ${c.n} filled buttons`);
    }
  });
  await check("no input/textarea/select/dialog anywhere in the column", async () => {
    const n = await ev(() => [...document.querySelectorAll(".rv-ctab tbody tr td:nth-child(7)")].reduce((s, td) => s + td.querySelectorAll("input,textarea,select,[role=dialog]").length, 0));
    if (n !== 0) throw new Error(`${n} form/dialog elements in the column`);
  });
  await check('"reason", "why", "explain" appear nowhere IN THE COLUMN', async () => {
    const hit = await ev(() => [...document.querySelectorAll(".rv-ctab tbody tr td:nth-child(7)")].map((td) => td.innerText).join(" ").toLowerCase().match(/reason|why|explain/g) || []);
    if (hit.length) throw new Error(`found: ${hit.join(", ")}`);
  });
  await check("legend swatches equal the cell fills", async () => {
    const r = await ev(() => {
      const pair = (el) => { const s = getComputedStyle(el); return `${s.backgroundColor}|${s.borderTopColor}`; };
      const out = {};
      for (const k of ["due", "done", "closed", "notreq"]) out[k] = [pair(document.querySelector(`.rv-legend i[data-swatch="${k}"]`)), pair(document.querySelector(`.rv-rc[data-s="${k}"]`))];
      return out;
    });
    for (const [k, [a, b]] of Object.entries(r)) if (a !== b) throw new Error(`${k}: swatch ${a} ≠ cell ${b}`);
  });
  await check("contrast ≥4.5 (labels, primary, body all small text)", async () => {
    const res = await ev(() => {
      const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const parse = (c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const bgOf = (el) => { let e = el; while (e) { const b = getComputedStyle(e).backgroundColor; if (b && b !== "rgba(0, 0, 0, 0)" && b !== "transparent") return parse(b); e = e.parentElement; } return [255, 255, 255]; };
      const ratio = (el) => { const fg = parse(getComputedStyle(el).color), bg = bgOf(el); const L1 = lum(fg) + 0.05, L2 = lum(bg) + 0.05; return L1 > L2 ? L1 / L2 : L2 / L1; };
      const out = {};
      for (const k of ["due", "done", "closed", "notreq"]) out[`${k}-label`] = ratio(document.querySelector(`.rv-rc[data-s="${k}"] .rv-rl`));
      out["due-primary"] = ratio(document.querySelector('.rv-rc[data-s="due"] .rv-pri'));
      out["notreq-body"] = ratio(document.querySelector('.rv-rc[data-s="notreq"] .rv-rw'));
      return out;
    });
    for (const [k, r] of Object.entries(res)) if (r < 4.5) throw new Error(`${k} contrast ${r.toFixed(2)} < 4.5`);
    console.log("     " + Object.entries(res).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" "));
  });

  // chip ↔ column reconciliation (must run before the mutating interaction tests)
  await check("Unanswered chip count == number of Reply-due cells (outstanding reconciles)", async () => {
    const chip = await ev(() => { const el = [...document.querySelectorAll("button,span,div")].find((n) => /^Unanswered\s+\d+$/.test(n.textContent?.trim() || "")); return el ? parseInt(el.textContent.match(/\d+/)[0], 10) : null; });
    const dueCells = await ev(() => document.querySelectorAll('.rv-rc[data-s="due"]').length);
    if (chip === null) throw new Error("Unanswered chip not found");
    if (chip !== dueCells) throw new Error(`chip=${chip} ≠ ${dueCells} due cells`);
    console.log(`     Unanswered chip = ${chip} = ${dueCells} due cells`);
  });

  console.log("\nINTERACTIONS");
  await check('"No reply needed" resolves in one click and records who + when', async () => {
    await ev(() => document.querySelector('.rv-rc[data-s="due"] .rv-rx').click());
    await page.waitForTimeout(200);
    const info = await ev(() => { const c = document.querySelector('.rv-rc[data-s="closed"]'); return { any: !!c, body: c?.querySelector(".rv-rw")?.textContent || "" }; });
    if (!info.any) throw new Error("no cell became closed");
    if (!/\w+.*·.*\d/.test(info.body)) throw new Error(`closed body has no who·when: "${info.body}"`);
  });
  await check("Mark replied → Undo round-trips", async () => {
    const before = await ev(() => document.querySelectorAll('.rv-rc[data-s="due"]').length);
    await ev(() => document.querySelector('.rv-rc[data-s="due"] .rv-pri').click());
    await page.waitForTimeout(200);
    const afterMark = await ev(() => ({ due: document.querySelectorAll('.rv-rc[data-s="due"]').length, done: document.querySelectorAll('.rv-rc[data-s="done"]').length }));
    if (afterMark.due !== before - 1) throw new Error(`Mark replied didn't reduce due (${before}→${afterMark.due})`);
    await ev(() => { const undo = [...document.querySelectorAll('.rv-rc[data-s="done"] .rv-rx')].find((b) => b.textContent.trim() === "Undo"); undo.click(); });
    await page.waitForTimeout(200);
    const afterUndo = await ev(() => document.querySelectorAll('.rv-rc[data-s="due"]').length);
    if (afterUndo !== before) throw new Error(`Undo didn't restore due (${afterMark.due}→${afterUndo}, want ${before})`);
  });

  // ── negative controls ──
  console.log("\nNEGATIVE CONTROLS (each must FAIL cleanly)");
  let NCP = 0, NCF = 0;
  const reset = async () => { await page.reload({ waitUntil: "domcontentloaded" }); for (const s of ["due", "done", "closed", "notreq"]) await page.waitForSelector(`.rv-rc[data-s="${s}"]`, { timeout: 30_000 }); };
  const neg = async (name, mutate, assertFn) => {
    await reset(); await ev(mutate);
    let threw = false, msg = "";
    try { await assertFn(); } catch (e) { threw = true; msg = e.message; }
    if (threw) { NCP++; console.log(`  ✓ ${name} — caught: ${msg}`); }
    else { NCF++; console.log(`  ✗ ${name} — assertion did NOT fail (vacuous!)`); }
  };
  const fourBg = async () => { const s = await ev(() => ["due", "done", "closed", "notreq"].map((k) => getComputedStyle(document.querySelector(`.rv-rc[data-s="${k}"]`)).backgroundColor)); if (new Set(s).size !== 4) throw new Error(`only ${new Set(s).size} distinct backgrounds`); };
  const firstChild = async () => { const b = await ev(() => [...document.querySelectorAll(".rv-rc")].filter((c) => !c.firstElementChild?.classList.contains("rv-rl")).length); if (b) throw new Error(`${b} mis-ordered`); };
  const sameTop = async () => { const m = await ev(() => [...document.querySelectorAll(".rv-rc")].map((c) => Math.round(c.getBoundingClientRect().top - c.closest("td").getBoundingClientRect().top))); const sp = Math.max(...m) - Math.min(...m); if (sp > 2) throw new Error(`top spread ${sp}px`); };
  const onePrimary = async () => { const worst = await ev(() => Math.max(...[...document.querySelectorAll('.rv-rc:not([data-s="due"])')].map((c) => c.querySelectorAll(".rv-pri").length))); if (worst > 0) throw new Error(`a resolved cell has ${worst} filled buttons`); };
  const noInput = async () => { const n = await ev(() => [...document.querySelectorAll(".rv-ctab tbody tr td:nth-child(7)")].reduce((s, td) => s + td.querySelectorAll("input,textarea,select,[role=dialog]").length, 0)); if (n) throw new Error(`${n} form elements`); };

  await neg("give two states the same background", () => { const d = getComputedStyle(document.querySelector('.rv-rc[data-s="due"]')).backgroundColor; document.querySelector('.rv-rc[data-s="closed"]').style.background = d; }, fourBg);
  await neg("move a status label to the end of its cell", () => { const c = document.querySelector(".rv-rc"); c.appendChild(c.firstElementChild); }, firstChild);
  await neg("add a top margin to one cell", () => { document.querySelector(".rv-rc").style.marginTop = "20px"; }, sameTop);
  await neg("add a filled primary button to a resolved state", () => { const c = document.querySelector('.rv-rc[data-s="done"]'); const b = document.createElement("button"); b.className = "rv-pri"; b.textContent = "Mark replied"; c.appendChild(b); }, onePrimary);
  await neg('inject an input with placeholder "Reason"', () => { const c = document.querySelector('.rv-rc[data-s="due"]'); const i = document.createElement("input"); i.placeholder = "Reason"; c.appendChild(i); }, noInput);

  console.log(`\n================ RESULT ================`);
  console.log(`Positive: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log(`   FAILED: ${f}`));
  console.log(`Negative controls: ${NCP}/${NCP + NCF} failed cleanly`);
  await browser.close();
  process.exit(FAIL === 0 && NCF === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
