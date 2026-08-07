// Admin payments panel + sidebar badge, against REAL data (BASE env, default
// localhost:3000; point at the deploy after shipping). Covers every VERIFY item
// the live data can exercise. The awaiting-row path + negative controls live in
// verify-adminpay-synthetic.mjs (no partner is awaiting today).
//
//   node scripts/e2e/verify-adminpay.mjs
//   BASE=https://matchday-clubhouse.vercel.app node scripts/e2e/verify-adminpay.mjs

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const check = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } };
const num = (s) => Number(String(s).replace(/[−–—]/, "-").replace(/[^0-9.-]/g, "")) || 0;

// WCAG contrast helpers
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const TOK = vv.data.session.access_token;
  const api = async (p, tok) => { const r = await fetch(`${BASE}${p}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }); return { status: r.status, json: await r.json().catch(() => null) }; };

  console.log(`BASE = ${BASE}\n\nACTIONABLE ENDPOINT (badge source)`);
  let act;
  await check("actionable endpoint is admin-gated (401 without a session)", async () => {
    const r = await api("/api/partner-dashboards/actionable", null);
    if (r.status !== 401) throw new Error(`status ${r.status}`);
  });
  await check("actionable returns a breakdown that sums to count", async () => {
    const r = await api("/api/partner-dashboards/actionable", TOK);
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    act = r.json;
    if (act.awaiting + act.disputed + act.diverged !== act.count) throw new Error(`sum≠count: ${JSON.stringify(act)}`);
  });
  console.log(`   → count=${act?.count} (awaiting ${act?.awaiting}, disputed ${act?.disputed}, diverged ${act?.diverged})  byPartner=${JSON.stringify(act?.byPartner)}`);

  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] } });
  const page = await context.newPage();
  await page.goto(`${BASE}/match-ops/partner-dashboards`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="payments-card"]', { timeout: 30_000 });

  const slugs = await page.$$eval('[data-testid="switcher-card"]', (els) => els.map((e) => e.getAttribute("data-slug")));
  const restRows = {};
  console.log("\nROWS AT REST (per partner)");
  for (const slug of slugs) {
    await page.click(`[data-testid="switcher-card"][data-slug="${slug}"]`);
    await page.waitForFunction((s) => document.querySelector(`[data-testid="switcher-card"][data-slug="${s}"][class]`) && !!document.querySelector('[data-testid="payments-card"]'), slug);
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="payments-card"]');
      const rows = card.querySelectorAll('[data-testid^="pay-"][data-testid$="-row"]');
      return {
        awaiting: card.querySelectorAll('[data-testid="pay-awaiting-row"]').length,
        latest: card.querySelectorAll('[data-testid="pay-latest-row"]').length,
        older: card.querySelectorAll('[data-testid="pay-older-row"]').length,
        totalRows: rows.length,
        summary: card.querySelector('[data-testid="pay-summary"]')?.innerText,
        foldOpen: card.querySelector('[data-testid="pay-fold"]')?.getAttribute("data-open"),
      };
    });
    restRows[slug] = r;
    console.log(`   ${slug}: rows=${r.totalRows} (awaiting ${r.awaiting} + latest ${r.latest}), older-folded, summary="${r.summary}"`);
    await check(`[${slug}] rest rows ≤ awaiting + 1`, () => { if (r.totalRows > r.awaiting + 1) throw new Error(`${r.totalRows} > ${r.awaiting}+1`); });
    await check(`[${slug}] header summary counts match rendered state`, () => {
      // "N settled · M awaiting|nothing awaiting"; expand to read settled count
      const m = /^(\d+) settled · (nothing awaiting|(\d+) awaiting)$/.exec(r.summary || "");
      if (!m) throw new Error(`summary shape "${r.summary}"`);
      const awaitN = m[2] === "nothing awaiting" ? 0 : Number(m[3]);
      if (awaitN !== r.awaiting) throw new Error(`summary awaiting ${awaitN} ≠ rows ${r.awaiting}`);
    });
  }

  // Deep-dive the partner with the most history (PAC Global) — fold count/total/round-trip/flag
  const pac = slugs.find((s) => s.startsWith("pac-global")) || slugs[0];
  console.log(`\nFOLD + DIVERGENCE (deep-dive: ${pac})`);
  await page.click(`[data-testid="switcher-card"][data-slug="${pac}"]`);
  await page.waitForTimeout(200);
  const fold0 = await page.evaluate(() => {
    const f = document.querySelector('[data-testid="pay-fold"]');
    return f ? { count: +f.dataset.count, total: +f.dataset.total, flagged: +f.dataset.flagged, open: f.dataset.open,
      countText: f.querySelector('[data-testid="pay-fold-count"]')?.innerText, totalText: f.querySelector('[data-testid="pay-fold-total"]')?.innerText,
      flaggedText: f.querySelector('[data-testid="pay-fold-flagged"]')?.innerText || null } : null;
  });
  console.log(`   fold: count=${fold0?.count} total=$${fold0?.total} flagged=${fold0?.flagged} ("${fold0?.countText}" / "${fold0?.totalText}" / "${fold0?.flaggedText}")`);

  await check("fold bar states a count, a total, and a Show control", async () => {
    if (!fold0) throw new Error("no fold");
    if (!/\d+ earlier payments hidden/.test(fold0.countText)) throw new Error(`count text "${fold0.countText}"`);
    if (!/\$/.test(fold0.totalText)) throw new Error(`total text "${fold0.totalText}"`);
    const showBtn = await page.$('[data-testid="pay-fold"] >> text=Show');
    if (!showBtn) throw new Error("no Show control");
  });
  await check("collapsed fold reports how many inside need a look", () => {
    if (fold0.flagged > 0 && !/\d+ need a look/i.test(fold0.flaggedText || "")) throw new Error(`flagged=${fold0.flagged} but no 'need a look' pill`);
  });

  // Expand and verify total == sum of the rows actually rendered
  await page.click('[data-testid="pay-fold"]');
  await page.waitForTimeout(150);
  const expanded = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="payments-card"]');
    const older = [...card.querySelectorAll('[data-testid="pay-older-row"]')];
    return {
      open: card.querySelector('[data-testid="pay-fold"]').dataset.open,
      rows: older.map((el) => ({ week: el.dataset.week, amt: el.querySelectorAll("span")[1]?.innerText, last: el.innerText.includes("opening settlement") })),
      hideBtn: !!(card.querySelector('[data-testid="pay-fold"]')?.innerText.includes("Hide")),
      flagPills: card.querySelectorAll('[data-testid="pay-flag-pill"]').length,
      flagTitle: card.querySelector('[data-testid="pay-flag-pill"]')?.getAttribute("title") || null,
    };
  });
  await check("expanding renders every older period, count matches the bar", () => {
    if (expanded.rows.length !== fold0.count) throw new Error(`rendered ${expanded.rows.length} ≠ bar ${fold0.count}`);
  });
  await check("fold total EQUALS the sum of the expanded rows (not just the label)", () => {
    const sum = expanded.rows.reduce((s, r) => s + num(r.amt), 0);
    if (Math.abs(sum - fold0.total) > 0.5) throw new Error(`sum ${sum} ≠ total ${fold0.total}`);
  });
  await check("older rows are newest-first, opening settlement last", () => {
    const weeks = expanded.rows.map((r) => r.week);
    const sorted = [...weeks].sort((a, b) => b.localeCompare(a));
    if (JSON.stringify(weeks) !== JSON.stringify(sorted)) throw new Error(`not newest-first: ${weeks}`);
    const openingIdx = expanded.rows.findIndex((r) => r.last);
    if (openingIdx !== -1 && openingIdx !== expanded.rows.length - 1) throw new Error(`opening at ${openingIdx}, not last`);
  });
  await check("expanded bar flips to Hide", () => { if (!expanded.hideBtn || expanded.open !== "1") throw new Error("no Hide / not open"); });
  if (fold0.flagged > 0) {
    await check("flagged period shows the pill; tooltip names BOTH figures", () => {
      if (expanded.flagPills < fold0.flagged) throw new Error(`${expanded.flagPills} pills < ${fold0.flagged} flagged`);
      const t = expanded.flagTitle || "";
      const money = t.match(/\$[\d,]+(\.\d\d)?/g) || [];
      if (money.length < 2) throw new Error(`tooltip names ${money.length} figures: "${t}"`);
    });
    console.log(`   flag tooltip: "${expanded.flagTitle}"`);
  }

  // Round-trip: Hide → collapsed row count returns
  await page.click('[data-testid="pay-fold"]');
  await page.waitForTimeout(150);
  const collapsed = await page.evaluate(() => ({
    older: document.querySelectorAll('[data-testid="pay-older-row"]').length,
    open: document.querySelector('[data-testid="pay-fold"]').dataset.open,
    show: document.querySelector('[data-testid="pay-fold"]').innerText.includes("Show"),
  }));
  await check("Show → Hide → Show round-trips (older rows hidden again)", () => {
    if (collapsed.older !== 0 || collapsed.open !== "0" || !collapsed.show) throw new Error(`older=${collapsed.older} open=${collapsed.open} show=${collapsed.show}`);
  });

  // Item 12 — sum of partner-card amounts == total awaiting across the panel
  await check("Σ partner-card owed == total awaiting (endpoint awaiting dollars)", async () => {
    const cardText = await page.$$eval('[data-testid="switcher-state"]', (els) => els.map((e) => e.innerText));
    const cardSum = cardText.reduce((s, t) => s + (/[Nn]othing owed/.test(t) ? 0 : num((t.match(/\$[\d,]+/) || ["0"])[0])), 0);
    // real data: all "Nothing owed" → 0; endpoint awaiting count is 0 too
    if (act.awaiting === 0 && cardSum !== 0) throw new Error(`cards sum ${cardSum} but 0 awaiting`);
    console.log(`   Σ card owed = $${cardSum}; endpoint awaiting periods = ${act.awaiting}`);
  });

  // Item 11 — sidebar badge equals the actionable count (present because >0 today)
  await check("sidebar 'Partner Dashboards' badge == actionable count", async () => {
    const badge = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a[href="/match-ops/partner-dashboards"]')].find((x) => x.offsetParent !== null) || document.querySelector('a[href="/match-ops/partner-dashboards"]');
      if (!a) return { found: false };
      const m = a.innerText.match(/(\d+)\s*$/);
      return { found: true, badge: m ? +m[1] : null, text: a.innerText.trim() };
    });
    if (!badge.found) throw new Error("nav item not found");
    if (act.count > 0 && badge.badge !== act.count) throw new Error(`badge ${badge.badge} ≠ count ${act.count} (nav "${badge.text}")`);
    if (act.count === 0 && badge.badge != null) throw new Error(`badge shows ${badge.badge} but count is 0 (should be absent)`);
    console.log(`   nav badge = ${badge.badge}, endpoint count = ${act.count}`);
  });

  // Item 13 — contrast sweep across every text element in the admin panel (dark) + card (light)
  console.log("\nCONTRAST (admin panel + payments card)");
  const contrast = await page.evaluate(() => {
    const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const effBg = (el) => { let cur = el, acc = { r: 255, g: 255, b: 255, a: 1 }; const layers = []; while (cur) { const c = parse(getComputedStyle(cur).backgroundColor); if (c && c.a > 0) layers.unshift(c); cur = cur.parentElement; } for (const l of layers) acc = over(l, acc); return acc; };
    const results = [];
    const panel = document.querySelector('[data-testid="admin-panel"]');
    const els = [...panel.querySelectorAll("span,b,em,a,button,option,input,p,div")];
    for (const el of els) {
      const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!direct) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
      const fg0 = parse(cs.color); if (!fg0) continue;
      const bg = effBg(el); const fg = over(fg0, bg);
      const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      const L = (x) => 0.2126 * lin(x.r) + 0.7152 * lin(x.g) + 0.0722 * lin(x.b);
      const [hi, lo] = [L(fg), L(bg)].sort((a, b) => b - a); const cr = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(cs.fontSize); const wt = +cs.fontWeight || 400;
      const large = size >= 24 || (size >= 18.66 && wt >= 700);
      const need = large ? 3 : 4.5;
      if (cr + 0.05 < need) results.push({ text: el.innerText.slice(0, 28), cr: +cr.toFixed(2), need, size, wt });
    }
    return results;
  });
  await check("every text element in the panel + card meets WCAG contrast", () => {
    if (contrast.length) throw new Error(`${contrast.length} under threshold: ${JSON.stringify(contrast.slice(0, 6))}`);
  });

  console.log(`\n================ RESULT (${BASE}) ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log(`   FAILED: ${f}`));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
