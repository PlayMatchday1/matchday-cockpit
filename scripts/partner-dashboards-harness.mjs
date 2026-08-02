// Partner Dashboards harness. READ-ONLY: injects an admin session and navigates;
// never submits a form, never clicks a mutation button, never writes to prod.
// Asserts the 14 invariants the prompt lists, then proves the harness works with
// three runtime negative controls. Run:
//   BASE=http://localhost:3111 node scripts/partner-dashboards-harness.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3111";
const OUT = (process.env.CLAUDE_JOB_DIR || ".") + "/tmp";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const ref = url.replace("https://", "").split(".")[0];
const sb = createClient(url, svc, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// admin session
const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const cli = createClient(url, anon, { auth: { persistSession: false } });
const { data: s } = await cli.auth.verifyOtp({ type: "email", token_hash: l.properties.hashed_token });

// partners (for the public-route cross-leak checks)
const { data: pdRows } = await sb.from("partner_dashboards").select("slug, partner_name, venue_id, enabled").eq("enabled", true);
const { data: venRows } = await sb.from("fin_venues").select("id, venue_name").in("id", (pdRows ?? []).map((p) => p.venue_id));
const venName = new Map((venRows ?? []).map((v) => [v.id, v.venue_name]));
const PARTNERS = (pdRows ?? []).map((p) => ({ slug: p.slug, name: p.partner_name, venue: venName.get(p.venue_id) || "" }));
console.log("partners:", PARTNERS.map((p) => p.slug).join(", "), "\n");

const CURRENCY_GRAMMAR = /^−?\$\d{1,3}(,\d{3})*$/;
const SING_ALLOW = new Set(["is", "as", "was", "has", "this", "its", "us", "less", "across"]);
const PRESENCE = /\b(present|attended|attendance|checked in|check-in|showed up|physically arrived|arrived)\b/i;
const DENIAL = /\b(not|no|never|does not|doesn't|excluded|isn't)\b/i;

// Extractors that run in the page. cellMain skips block-level sub-notes by
// COMPUTED DISPLAY (they're display:block spans), so "−$460" over a note
// "8 matches" doesn't concatenate to "−$4608".
const PAGE_HELPERS = `
  window.__cellMain = function(cell){
    let s = "";
    cell.childNodes.forEach(function(n){
      if (n.nodeType === 3) s += n.textContent;
      else if (n.nodeType === 1) {
        if (getComputedStyle(n).display === "block") return;
        s += window.__cellMain(n);
      }
    });
    return s.replace(/\\s+/g, " ").trim();
  };
  window.__tableRows = function(){
    var t = document.querySelector('[data-testid="period-table"]');
    if (!t) return [];
    var trs = Array.prototype.slice.call(t.querySelectorAll("tbody tr"));
    return trs.map(function(tr){
      var tds = Array.prototype.slice.call(tr.children);
      return tds.map(function(td){ return window.__cellMain(td); });
    });
  };
`;

const browser = await chromium.launch();
async function ctxPage(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [`sb-${ref}-auth-token`, JSON.stringify(s.session)]);
  const pg = await ctx.newPage();
  await pg.addInitScript(PAGE_HELPERS);
  return { ctx, pg };
}
const num = (str) => Number((str || "").replace(/[^0-9.-]/g, "")) || 0;

// ── admin index assertions, per selected partner + width ──
async function runAdmin(width) {
  const label = `[admin @ ${width}]`;
  console.log(`\n=== ${label} ===`);
  const { ctx, pg } = await ctxPage(width);
  await pg.goto(`${BASE}/match-ops/partner-dashboards`, { waitUntil: "networkidle" });
  await pg.waitForSelector('[data-testid="period-table"]', { timeout: 20000 });

  // 14) no horizontal overflow at this width
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`${label} no horizontal overflow (${overflow}px)`, overflow <= 1, `${overflow}px`);

  // 13) every button on THIS page (not the outer Clubhouse chrome) ≥26px tall
  const shortBtns = await pg.$$eval('[data-testid="partner-page"] button', (els) => els.filter((b) => b.offsetParent !== null && b.getBoundingClientRect().height > 0 && b.getBoundingClientRect().height < 26).map((b) => (b.textContent || "").slice(0, 20)));
  ok(`${label} every page button ≥26px tall`, shortBtns.length === 0, shortBtns.join(","));

  const cards = await pg.$$('[data-testid="switcher-card"]');
  for (let i = 0; i < cards.length; i++) {
    await cards[i].click();
    await pg.waitForTimeout(150);
    const slug = await cards[i].getAttribute("data-slug");
    const lab = `${label} ${slug}`;

    // 4) exactly ONE table in the dashboard
    const nTables = await pg.$$eval('[data-testid="dashboard-below-seam"] table', (t) => t.length);
    ok(`${lab} dashboard has exactly one table`, nTables === 1, `${nTables} tables`);

    // 1) one currency grammar across the whole page
    const dash = await pg.$eval('[data-testid="dashboard-below-seam"]', (el) => el.innerText);
    const currency = dash.match(/−?\$[\d.,]+/g) || [];
    const badCur = currency.filter((c) => !CURRENCY_GRAMMAR.test(c));
    ok(`${lab} all currency matches one grammar`, badCur.length === 0, badCur.slice(0, 3).join(","));

    // 2) no "1 <plural>" (allowlist)
    const singles = [...dash.matchAll(/\b1 (\w+s)\b/g)].map((m) => m[1]).filter((w) => !SING_ALLOW.has(w.toLowerCase()));
    ok(`${lab} no unpluralised "1 <word>s"`, singles.length === 0, singles.join(","));

    // 3) no sentence asserts presence unless it also denies measuring it
    const sentences = dash.split(/(?<=[.!?])\s+/);
    const bad = sentences.filter((s2) => PRESENCE.test(s2) && !DENIAL.test(s2));
    ok(`${lab} no sentence claims a person was present`, bad.length === 0, bad.slice(0, 1).join(" | "));

    // parse rows: [PERIOD, MATCHES, CHARGED, REFUNDED, QUALIFYING, MGR/SHARE, PAYMENT, STATUS, WHEN]
    const rows = await pg.evaluate(() => window.__tableRows());
    const dataRows = rows.filter((r) => r.length >= 9 && !/^All /.test(r[0]));
    const perMatch = slug.startsWith("crossbar");

    for (const r of dataRows) {
      const charged = num(r[2]), refunded = num(r[3]), qualifying = num(r[4]);
      const isPre = /^Through /.test(r[0]);
      // 5) charged − refunded = qualifying (skip pre-system "—" rows)
      if (!isPre && r[2] !== "—") ok(`${lab} charged−refunded=qualifying (${r[0]})`, Math.abs((charged - refunded) - qualifying) < 1, `${charged}−${refunded}≠${qualifying}`);
      // 8) open row payment cell has no "$"
      const isOpen = /Partial/.test(r[0]) || /In progress/.test(r[7]);
      if (isOpen) ok(`${lab} open period payment has no $ (${r[0]})`, !r[6].includes("$"), `pay="${r[6]}"`);
      // 7) no row both $0 and Paid
      if (!isOpen) ok(`${lab} row not both $0 and Paid (${r[0]})`, !(num(r[6]) === 0 && /Paid/.test(r[7])), `pay=${r[6]} status=${r[7]}`);
      // 6) per_match closed rows: payment = max(0, qualifying − managerPay)
      if (perMatch && !isOpen && !isPre) {
        const mgr = Math.abs(num(r[5]));
        const expect = Math.max(0, qualifying - mgr);
        ok(`${lab} payment=max(0,qual−mgr) (${r[0]})`, Math.abs(num(r[6]) - expect) < 1, `pay=${num(r[6])} exp=${expect}`);
      }
    }

    // 9) switcher amount == Σ Scheduled+Past-due payment rows below
    const stateLine = await pg.$eval(`[data-testid="switcher-card"][data-slug="${slug}"] [data-testid="switcher-state"]`, (el) => el.textContent || "");
    const switcherOwed = /Nothing owed/.test(stateLine) ? 0 : num(stateLine.split("owed")[0]);
    const tableOwed = dataRows.filter((r) => /Scheduled|Past due/.test(r[7])).reduce((sum, r) => sum + num(r[6]), 0);
    ok(`${lab} switcher owed = Σ scheduled+past-due rows (${switcherOwed} vs ${tableOwed})`, Math.abs(switcherOwed - tableOwed) < 1, `switcher=${switcherOwed} table=${tableOwed}`);
  }

  // 12) view-as: only preview bar + dashboard have height
  await pg.click('[data-testid="switcher-card"]');
  await pg.click("text=View as");
  await pg.waitForSelector('[data-testid="viewas-root"]', { timeout: 5000 });
  await pg.waitForTimeout(200);
  const bodyHeights = await pg.evaluate(() => {
    // walk EVERY body child; anything outside the preview root must have 0 height
    const preview = document.querySelector('[data-partner-preview]');
    const offenders = [];
    for (const el of Array.from(document.body.children)) {
      if (preview && (el === preview || el.contains(preview))) continue;
      const h = el.getBoundingClientRect().height;
      if (h > 0) offenders.push((el.tagName || "") + "." + (el.className || "").toString().slice(0, 30) + "=" + Math.round(h));
    }
    return offenders;
  });
  ok(`${label} view-as: only preview has height`, bodyHeights.length === 0, bodyHeights.slice(0, 3).join(" | "));
  await pg.screenshot({ path: `${OUT}/partners-viewas-${width}.png` });

  await ctx.close();
}

// ── public route assertions (raw response body + rendered) ──
async function runPublic(width) {
  const label = `[public @ ${width}]`;
  console.log(`\n=== ${label} ===`);
  const { ctx, pg } = await ctxPage(width);
  const ADMIN_STRINGS = ["Regenerate", "Copy link", "Add partner", "Disable", "Delete", "View as", "BELOW THIS LINE"];
  for (const p of PARTNERS) {
    // 10) response BODY (not DOM) leaks no OTHER partner
    const res = await fetch(`${BASE}/partners/${p.slug}`);
    const body = await res.text();
    const others = PARTNERS.filter((x) => x.slug !== p.slug);
    const leaks = [];
    for (const o of others) {
      if (o.slug && body.includes(o.slug)) leaks.push(o.slug);
      if (o.name && body.includes(o.name)) leaks.push(o.name);
      if (o.venue && o.venue !== p.venue && body.includes(o.venue)) leaks.push(o.venue);
    }
    ok(`${label} ${p.slug} body leaks no other partner`, leaks.length === 0, leaks.slice(0, 3).join(","));
    // 11) no admin control strings in the body
    const admin = ADMIN_STRINGS.filter((a) => body.includes(a));
    ok(`${label} ${p.slug} body has no admin control string`, admin.length === 0, admin.join(","));

    // rendered checks (one table, currency grammar, presence)
    await pg.goto(`${BASE}/partners/${p.slug}`, { waitUntil: "networkidle" });
    await pg.waitForSelector('[data-testid="period-table"]', { timeout: 15000 }).catch(() => {});
    const nTables = await pg.$$eval("table", (t) => t.length);
    ok(`${label} ${p.slug} exactly one table`, nTables === 1, `${nTables}`);
    const txt = await pg.evaluate(() => document.body.innerText);
    const badCur = (txt.match(/−?\$[\d.,]+/g) || []).filter((c) => !CURRENCY_GRAMMAR.test(c));
    ok(`${label} ${p.slug} currency grammar`, badCur.length === 0, badCur.slice(0, 3).join(","));
    const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`${label} ${p.slug} no horizontal overflow (${overflow})`, overflow <= 1, `${overflow}px`);
  }
  await pg.goto(`${BASE}/partners/${PARTNERS[0].slug}`, { waitUntil: "networkidle" });
  await pg.screenshot({ path: `${OUT}/partners-public-${width}.png` });
  await ctx.close();
}

// ── negative controls: break 3 things at runtime, confirm each fires ──
async function negativeControls() {
  console.log(`\n=== NEGATIVE CONTROLS (prove the harness fails) ===`);
  const { ctx, pg } = await ctxPage(1600);
  await pg.goto(`${BASE}/match-ops/partner-dashboards`, { waitUntil: "networkidle" });
  await pg.waitForSelector('[data-testid="period-table"]', { timeout: 20000 });

  // NC1 — currency grammar: inject "$1000.00" into the dashboard
  await pg.evaluate(() => { const d = document.querySelector('[data-testid="dashboard-below-seam"]'); const s2 = document.createElement("span"); s2.textContent = "$1000.00"; d.appendChild(s2); });
  let cur = (await pg.$eval('[data-testid="dashboard-below-seam"]', (el) => el.innerText)).match(/−?\$[\d.,]+/g) || [];
  const nc1 = cur.some((c) => !CURRENCY_GRAMMAR.test(c));
  console.log(`  NC1 injected "$1000.00" → grammar assertion fails: ${nc1}`);
  ok(`NEGATIVE CONTROL 1 (currency) fires`, nc1);
  await pg.reload({ waitUntil: "networkidle" }); await pg.waitForSelector('[data-testid="period-table"]');
  cur = (await pg.$eval('[data-testid="dashboard-below-seam"]', (el) => el.innerText)).match(/−?\$[\d.,]+/g) || [];
  ok(`NEGATIVE CONTROL 1 restored green`, !cur.some((c) => !CURRENCY_GRAMMAR.test(c)));

  // NC2 — pluralisation: inject "1 matches"
  await pg.evaluate(() => { const d = document.querySelector('[data-testid="dashboard-below-seam"]'); const s2 = document.createElement("span"); s2.textContent = " 1 matches "; d.appendChild(s2); });
  let sing = [...(await pg.$eval('[data-testid="dashboard-below-seam"]', (el) => el.innerText)).matchAll(/\b1 (\w+s)\b/g)].map((m) => m[1]).filter((w) => !SING_ALLOW.has(w.toLowerCase()));
  console.log(`  NC2 injected "1 matches" → plural assertion fails: ${sing.length > 0}`);
  ok(`NEGATIVE CONTROL 2 (plural) fires`, sing.length > 0);
  await pg.reload({ waitUntil: "networkidle" }); await pg.waitForSelector('[data-testid="period-table"]');
  sing = [...(await pg.$eval('[data-testid="dashboard-below-seam"]', (el) => el.innerText)).matchAll(/\b1 (\w+s)\b/g)].map((m) => m[1]).filter((w) => !SING_ALLOW.has(w.toLowerCase()));
  ok(`NEGATIVE CONTROL 2 restored green`, sing.length === 0);

  // NC3 — view-as height: enter view-as, then un-hide a body child, confirm #12 fires
  await pg.click('[data-testid="switcher-card"]');
  await pg.click("text=View as");
  await pg.waitForSelector('[data-testid="viewas-root"]');
  await pg.waitForTimeout(150);
  const countOffenders = () => pg.evaluate(() => {
    const preview = document.querySelector('[data-partner-preview]');
    return Array.from(document.body.children).filter((el) => el !== preview && !el.contains(preview) && el.getBoundingClientRect().height > 0).length;
  });
  const before = await countOffenders();
  // simulate a chrome element that "survived" into view-as: append a real,
  // sized body node outside the preview and confirm assertion #12 catches it.
  await pg.evaluate(() => { const d = document.createElement("div"); d.id = "nc3-survivor"; d.style.height = "40px"; d.textContent = "surviving chrome"; document.body.appendChild(d); });
  const after = await countOffenders();
  await pg.evaluate(() => { document.getElementById("nc3-survivor")?.remove(); });
  const restored = await countOffenders();
  console.log(`  NC3 view-as offenders before=${before} after appending one=${after} restored=${restored}`);
  ok(`NEGATIVE CONTROL 3 (view-as height) green then fires`, before === 0 && after > 0 && restored === 0, `before=${before} after=${after} restored=${restored}`);

  await ctx.close();
}

try {
  await runAdmin(1600);
  await runAdmin(1280);
  await runPublic(1600);
  await runPublic(1280);
  await negativeControls();
} finally {
  await browser.close();
}
console.log(`\n${"=".repeat(52)}\nPASS ${pass}  FAIL ${fail}`);
if (fails.length) { console.log("FAILURES:\n" + fails.map((f) => "  - " + f).join("\n")); process.exit(1); }
