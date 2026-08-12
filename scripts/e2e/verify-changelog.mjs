// Phase 16 PART F (UI) — the Change Log screen, hermetic. /api/changelog GET is
// route-fulfilled with synthetic rows; POST (resolve) is captured and reflected on the
// next GET so the resolve flow round-trips. Desktop + a 390×844 touch context.
//   node scripts/e2e/verify-changelog.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();
import { overflow } from "./checks.mjs";

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE_URL = `${BASE}/match-ops/change-log`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

async function contrastIn(pg) {
  return pg.evaluate(() => {
    const root = document.querySelector(".cl"); if (!root) return { failures: [], min: Infinity };
    const pc = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map(x => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a, b) => { const x = L(a), y = L(b), hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); };
    const bg = (el) => { let n = el; while (n && n.nodeType === 1) { const c = pc(getComputedStyle(n).backgroundColor); if (c && c.a > 0.85) return c; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const txt = (el) => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const vis = (el) => { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false; return el.offsetParent !== null || s.position === "fixed"; };
    const failures = []; let min = Infinity;
    for (const el of root.querySelectorAll("*")) { if (!txt(el) || !vis(el)) continue; const fg = pc(getComputedStyle(el).color); if (!fg) continue; const r = ratio(fg, bg(el)); if (r < min) min = Math.round(r * 100) / 100; if (r < 4.5) failures.push({ ratio: Math.round(r * 100) / 100, t: el.textContent.trim().slice(0, 30), c: (el.getAttribute("class") || "").slice(0, 30) }); }
    return { failures, min };
  });
}

function rows(base, resolved) {
  const iso = (offMin) => new Date(base - offMin * 60000).toISOString();
  const row = (o) => ({ id: `id-${o.saveId}-${o.i ?? 0}`, actorEmail: null, changes: [], serverSaid: null, resolved: null, resolvedBy: null, resolvedAt: null, env: "production", ...o });
  const R = [
    row({ saveId: "s1", i: 0, at: iso(5), actorName: "Ryan Mancuso", source: "Gameday Ops", matchId: 17303, matchName: "Kiest Park Saturday", method: "PUT", endpoint: "/admin/matches/17303", body: { registrationPrice: 1000 }, outcome: "landed", changes: [{ key: "registrationPrice", field: "registrationPrice", before: 1200, after: 1000 }] }),
    row({ saveId: "s2", i: 0, at: iso(20), actorName: "Deonna Garcia", source: "Gameday Ops", matchId: 17305, matchName: "Will Rogers Night", method: "PUT", endpoint: "/admin/matches/17305", body: { fakeSpotLeft3h: 0 }, outcome: "unknown", changes: [{ key: "fakeSpotLeft3h", field: "fakeSpotLeft3h", before: 4, after: 0 }] }),
    row({ saveId: "s3", i: 0, at: iso(30), actorName: "Ryan Mancuso", source: "Gameday Ops", matchId: 17305, matchName: "Will Rogers Night", method: "PUT", endpoint: "/admin/matches/17305", body: { fakeSpotLeft6h: 2 }, outcome: "notapplied", changes: [{ key: "fakeSpotLeft6h", field: "fakeSpotLeft6h", before: 4, after: 2 }] }),
    row({ saveId: "s4", i: 0, at: iso(40), actorName: "Michael Hollman", source: "Match editor", matchId: 17301, matchName: "PRUMC — Saturday", method: "PUT", endpoint: "/admin/matches/17301", body: { maxPlayerCount: 0 }, outcome: "failed", serverSaid: "400 maxPlayerCount must not be less than minPlayerCount", changes: [{ key: "maxPlayerCount", field: "maxPlayerCount", before: 20, after: 0 }] }),
    // a roster save: two requests, one saveId — "1 of 2 landed", outcome NO ANSWER
    row({ saveId: "sr", i: 0, at: iso(50), actorName: "Ryan Mancuso", source: "Roster", matchId: 17298, matchName: "Friday NEMP", method: "POST", endpoint: "/admin/user-matches", body: { p: 1 }, outcome: "landed", changes: [{ key: "move", field: "move", before: "White #3", after: "Green #4" }] }),
    row({ saveId: "sr", i: 1, at: iso(50), actorName: "Ryan Mancuso", source: "Roster", matchId: 17298, matchName: "Friday NEMP", method: "DELETE", endpoint: "/admin/matches/user-matches/9", body: { p: 2 }, outcome: "unknown", changes: [{ key: "remove", field: "remove", before: "Dark #9", after: "—" }] }),
    // already resolved: badge stays NO ANSWER, note underneath
    row({ saveId: "s6", i: 0, at: iso(90), actorName: "Deonna Garcia", source: "Roster", matchId: 17285, matchName: "Kiest Wednesday", method: "DELETE", endpoint: "/admin/matches/user-matches/291402", body: { p: 1 }, outcome: "unknown", resolved: "yes", resolvedBy: "Deonna Garcia", resolvedAt: iso(80), changes: [{ key: "remove", field: "remove", before: "Green #7", after: "—" }] }),
  ];
  // reflect any POST-resolved saves on subsequent GETs
  for (const r of R) if (resolved[r.saveId]) { r.resolved = resolved[r.saveId].verdict; r.resolvedBy = resolved[r.saveId].by; r.resolvedAt = iso(1); }
  return R;
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const resolved = {};
  const routes = async (ctx) => {
    await ctx.route("**/api/changelog", (route) => {
      const req = route.request();
      if (req.method() === "POST") { const b = JSON.parse(req.postData() || "{}"); resolved[b.saveId] = { verdict: b.verdict, by: "Ryan Mancuso" }; return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }); }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: rows(Date.now(), resolved) }) });
    });
  };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, storageState });
  await routes(ctx);
  const page = await ctx.newPage();
  const load = async () => { await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-testid="changelog"]'); await page.waitForSelector('[data-testid="entry"]'); await page.waitForTimeout(120); };
  const entry = (s) => `[data-testid="entry"][data-save="${s}"]`;
  await load();

  // all four outcomes recorded and labelled distinctly
  eq("all four outcome labels present and distinct", await page.$$eval('[data-testid="entry-state"]', (els) => [...new Set(els.map((e) => e.textContent))].sort()), ["FAILED", "LANDED", "NO ANSWER", "NOT APPLIED"]);
  eq("a single save with one change is one entry", await page.$eval(entry("s1"), (e) => e.getAttribute("data-outcome")), "landed");
  // roster save: ONE entry, "1 of 2 requests landed"
  eq("roster save is ONE entry stating how many landed", { entries: (await page.$$(entry("sr"))).length, sub: (await page.$eval(entry("sr") + " .sub", (e) => e.textContent)).includes("1 of 2") }, { entries: 1, sub: true });

  // the unresolved band counts open questions (s2 unk + s3 na + sr unk = 3; s6 resolved excluded)
  eq("unresolved band counts open questions (NO ANSWER + NOT APPLIED, minus resolved)", (await page.$eval('[data-testid="needs-count"]', (e) => e.textContent)).match(/^\d+/)[0], "3");

  // FAILED and LANDED are never unresolved (no resolve controls)
  eq("FAILED and LANDED offer no resolve controls", { failed: !!(await page.$(entry("s4") + ' [data-testid="resolve"]')), landed: !!(await page.$(entry("s1") + ' [data-testid="resolve"]')) }, { failed: false, landed: false });
  // NO ANSWER / NOT APPLIED do
  eq("NO ANSWER and NOT APPLIED offer resolve controls", { unk: !!(await page.$(entry("s2") + ' [data-testid="resolve"]')), na: !!(await page.$(entry("s3") + ' [data-testid="resolve"]')) }, { unk: true, na: true });

  // NO retry anywhere on the page
  eq("no retry control exists anywhere on the log", await page.$$eval('button, [role="button"]', (els) => els.filter((e) => /retry/i.test(e.textContent || "") || /retry/i.test(e.getAttribute("data-testid") || "")).length), 0);

  // details expand shows endpoint + body
  await page.click(entry("s4") + ' [data-testid="exp"]');
  await page.waitForSelector(entry("s4") + ' [data-testid="details"]');
  eq("details show endpoint, server message and body", { ep: (await page.$eval(entry("s4") + ' [data-testid="details"] code', (e) => e.textContent)).includes("/admin/matches/17301"), said: (await page.$eval(entry("s4") + ' [data-testid="details"]', (e) => e.textContent)).includes("must not be less") }, { ep: true, said: true });

  // filters COMBINE (person AND outcome AND source), not replace
  await page.click('[data-testid="who-Ryan Mancuso"]'); await page.click('[data-testid="out-landed"]'); await page.click('[data-testid="src-Gameday Ops"]'); await page.waitForTimeout(120);
  eq("filters combine to a single entry (Ryan + landed + Gameday)", await page.$$eval('[data-testid="entry"]', (e) => e.map((x) => x.getAttribute("data-save"))), ["s1"]);
  await page.click('[data-testid="out-all"]'); await page.click('[data-testid="who-all"]'); await page.click('[data-testid="src-all"]'); await page.waitForTimeout(120);

  // "Show only these" jumps to the needs filter
  await page.click('[data-testid="needs-go"]'); await page.waitForTimeout(120);
  eq("'Show only these' filters to the unresolved set (3)", (await page.$$('[data-testid="entry"]')).length, 3);
  await page.click('[data-testid="out-all"]'); await page.waitForTimeout(120);

  // resolving records a finding: NO write to MatchDay, badge stays NO ANSWER, note added, buttons gone
  await page.click(entry("s2") + ' [data-testid="resolve-yes"]');
  await page.waitForTimeout(400);
  eq("resolving keeps the outcome (still NO ANSWER), adds a note, removes the buttons", {
    badge: await page.$eval(entry("s2") + ' [data-testid="entry-state"]', (e) => e.textContent),
    note: !!(await page.$(entry("s2") + ' [data-testid="resolved-note"]')),
    stillHasButtons: !!(await page.$(entry("s2") + ' [data-testid="resolve"]')),
  }, { badge: "NO ANSWER", note: true, stillHasButtons: false });

  // says reads are not logged
  eq("the page states reads are not logged", (await page.$eval('[data-testid="foot"]', (e) => e.textContent)).toLowerCase().includes("reads are not logged"), true);

  // contrast sweep (all four coloured states on screen)
  { const c = await contrastIn(page); c.failures.length === 0 ? ok(`contrast: every log node >= 4.5:1 (min ${c.min}, all four states shown)`) : bad(`contrast: ${c.failures.length} < 4.5`, c.failures.slice(0, 5).map((f) => `${f.ratio} "${f.t}" .${f.c}`).join(" | ")); }
  { await page.setViewportSize({ width: 1600, height: 1200 }); const o = await overflow(page); (!o.pageLeak) ? ok("no page-level horizontal overflow at 1600") : bad("overflow", JSON.stringify(o.offenders.slice(0, 3))); }

  // ══════════════ PHONE ══════════════
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState });
  await routes(pctx);
  const ph = await pctx.newPage();
  await ph.goto(PAGE_URL, { waitUntil: "domcontentloaded" }); await ph.waitForSelector('[data-testid="entry"]'); await ph.waitForTimeout(150);
  { const o = await overflow(ph); const past = await ph.evaluate(() => { const w = innerWidth; const inScroller = (el) => { let n = el.parentElement; while (n) { const s = getComputedStyle(n); if (s.overflowX === "auto" || s.overflowX === "scroll") return true; n = n.parentElement; } return false; }; return [...document.querySelectorAll(".cl *")].filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return s.display !== "none" && r.width > 0 && r.right > w + 1 && !inScroller(e); }).length; });
    (!o.pageLeak && past === 0) ? ok("phone: no horizontal scroll, nothing past the edge") : bad("phone overflow", `leak=${o.pageLeak} past=${past}`); }
  { const small = await ph.evaluate(() => { const out = []; for (const el of document.querySelectorAll('.cl button')) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); if (s.display === "none" || r.width === 0) continue; if (r.height < 32) out.push({ c: (el.className || "").toString().slice(0, 22), h: Math.round(r.height * 10) / 10 }); } return out; });
    small.length === 0 ? ok("phone: every control >= 32px tall") : bad(`phone: ${small.length} under 32px`, JSON.stringify(small.slice(0, 6))); }
  { const c = await contrastIn(ph); c.failures.length === 0 ? ok(`phone contrast: every log node >= 4.5:1 (min ${c.min})`) : bad(`phone contrast: ${c.failures.length} < 4.5`, c.failures.slice(0, 5).map((f) => `${f.ratio} "${f.t}"`).join(" | ")); }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
