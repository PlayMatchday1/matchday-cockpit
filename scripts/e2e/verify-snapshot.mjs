// Gameday Ops — the Snapshot view, hermetic. Proves the snapshot derives real/fake/open/
// short from the SAME gamedayModel functions as the card view (the two must never
// disagree), the three risk tiers (full-but-imminent stays green), the minimum tick at
// min/cap (not real/cap), MORE FAKE on exactly fake>real, risk sort ordering, filters +
// cities compose, and the phone layout. Desktop + a 390x844 touch context.
//   node scripts/e2e/verify-snapshot.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { overflow } from "./checks.mjs";

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/match-ops/gameday`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const near = (n, got, want, tol) => (Math.abs(got - want) <= tol ? ok(n) : bad(n, `got ${got} want ${want}±${tol}`));

const grantEdit = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, can_edit_matches: true, can_access_matchops: true });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

// id, city, mins-to-kickoff, real, fake, min, cap, acMin, mgr, price, tz
const MAIN = [
  [601, "Houston", 120, 3, 3, 12, 18, 30, "Reda", 1200, "CST"],       // red   (short9, acIn90)
  [602, "Austin", 300, 5, 3, 12, 20, 30, "Tobi", 1200, "CST"],        // amber (short7, acIn270)
  [603, "Austin", 60, 14, 2, 12, 20, 0, "Cami", 1200, "CST"],         // GREEN — met AND imminent (acIn60)
  [604, "Dallas", 400, 4, 9, 12, 18, 30, "Devon", 1400, "CST"],       // amber + MORE FAKE (short8)
  [605, "San Antonio", 135, 0, 12, 8, 16, 30, "Ricki", 1200, "CST"],  // red + MORE FAKE, EMPTY (0 real); acIn 105 < 120
];
// Adversarial set — the two views must agree here too, not just on a happy fixture.
// One fixture agreeing proves a shared bug as well as a shared truth.
const ADV = [
  [701, "Austin", 300, 4, 9, 12, 18, 30, "A", 1200, "CST"],   // fake > real
  [702, "Austin", 300, 0, 12, 8, 16, 30, "B", 1200, "CST"],   // zero real, many fakes
  [703, "Dallas", 300, 12, 6, 12, 18, 30, "C", 1200, "CST"],  // completely FULL (open 0)
  [704, "Houston", 300, 5, 0, 14, 10, 30, "D", 1200, "CST"],  // minimum EXCEEDS capacity (14 > 10)
  [705, "Houston", 20, 6, 0, 12, 18, 30, "E", 1200, "CST"],   // auto-cancel deadline ALREADY passed (acIn -10)
  [706, "Austin", 300, 10, 0, 12, 20, 30, "F", 1200, "CST"],  // zero fakes
];
// All three states (Phase 18) — both views must agree which GROUP each is in.
const GRP = [
  [801, "Austin", 180, 3, 0, 12, 18, 30, "T", 1200, "CST"],          // still to come (short)
  [802, "Austin", 180, 3, 0, 12, 18, 30, "C", 1200, "CST", "cx"],    // cancelled
  [803, "Austin", 0, 14, 2, 12, 18, 30, "F", 1200, "CST", "done"],   // finished (past kickoff)
];
let activeRaw = MAIN; // route serves this; flipped mid-run to exercise ADV / GRP
function build(raw, base, ymd) {
  return raw.map(([id, city, mins, real, fake, min, cap, acMin, mgr, price, tz, st]) => ({
    id, name: `Match ${id}`, startDate: `${ymd}T12:00:00.000`,
    startDateUtc: st === "done" ? new Date(base - 5 * 3600000).toISOString() : new Date(base + mins * 60000).toISOString(),
    isCancelled: st === "cx", autoCanceledMinutes: acMin, minPlayerCount: min, maxPlayerCount: cap,
    registrationPrice: price, additionalSpotPrice: 400, fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0,
    isAutoBump: false, category: "OPEN", type: "REGULAR", _count: { players: real + fake, fakePlayers: fake },
    manager: { firstName: mgr, lastName: "" }, teams: [{ teamNumber: 1 }, { teamNumber: 2 }],
    field: { title: `Field ${id}`, city: { id: 1, name: city, timeZone: { abbr: tz } } },
  }));
}
// Parse "10 real · 6 fake · 2 open of 18" -> {real,fake,open}
const parseSpots = (txt) => { const m = /(\d+)\s*real.*?(\d+)\s*fake.*?(\d+)\s*open/s.exec(txt); return m ? { real: +m[1], fake: +m[2], open: +m[3] } : null; };

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };
  const ymd = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

  const routes = async (ctx) => {
    await ctx.route("**/api/matchday/**/gameday**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ date: ymd, env: "production", matches: build(activeRaw, Date.now(), ymd) }) }));
    await ctx.route("**/api/veo**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: [] }) }));
    await grantEdit(ctx);
  };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, storageState });
  await routes(ctx);
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem("gameday-view", "snapshot"));
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="snapshot"]'); await page.waitForTimeout(200);

  // ── snapshot renders one row per match ──
  eq("one snapshot row per match (5)", (await page.$$('[data-testid="snap-row"]')).length, 5);

  // ── real is players − fakes, asserted DIRECTLY (601: 3 real, not 6) ──
  { const spots = await page.$eval('[data-testid="snap-row"][data-id="601"] [data-testid="snap-spots"]', (e) => e.textContent);
    const p = parseSpots(spots);
    eq("601: 3 real · 3 fake · 12 open of 18 (real is NOT the occupied 6)", p, { real: 3, fake: 3, open: 12 });
    eq("601: data-real is 3 (real != filled 6)", await page.$eval('[data-testid="snap-row"][data-id="601"]', (e) => Number(e.getAttribute("data-real"))), 3); }

  // ── risk tiers: full-but-imminent stays GREEN; short+<=2h red; short+>2h amber ──
  const riskOf = async (id) => page.$eval(`[data-testid="snap-row"][data-id="${id}"]`, (e) => e.getAttribute("data-risk"));
  eq("603 full-but-imminent (met, deadline <2h) is GREEN, not red", await riskOf(603), "green");
  eq("601 short + cancel call <2h is red", await riskOf(601), "red");
  eq("605 short + cancel call <2h is red", await riskOf(605), "red");
  eq("602 short but >2h is amber", await riskOf(602), "amber");
  eq("604 short but >2h is amber", await riskOf(604), "amber");

  // ── the minimum tick sits at min/cap, NOT real/cap (601: 12/18=66.7%, not 3/18) ──
  { const bar = await page.$eval('[data-testid="snap-row"][data-id="601"] .bar', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, w: r.width }; });
    const tick = await page.$eval('[data-testid="snap-row"][data-id="601"] [data-testid="snap-tick"]', (e) => e.getBoundingClientRect().left);
    const pct = (tick - bar.left) / bar.w * 100;
    near("minimum tick measured at min/cap (66.7%)", pct, 66.7, 3);
    ok(Math.abs(pct - 16.7) > 5 ? "tick is NOT at real/cap (16.7%)" : bad("tick at real/cap — wrong")); }

  // ── MORE FAKE on EXACTLY the fake>real rows (604, 605), not the others ──
  { const withBadge = await page.$$eval('[data-testid="snap-row"]', (els) => els.filter((e) => e.querySelector('[data-testid="more-fake"]')).map((e) => Number(e.getAttribute("data-id"))).sort());
    eq("MORE FAKE appears on exactly fake>real rows (604, 605)", withBadge, [604, 605]); }
  eq("605 surfaces the empty match: 0 real · 12 fake", parseSpots(await page.$eval('[data-testid="snap-row"][data-id="605"] [data-testid="snap-spots"]', (e) => e.textContent)), { real: 0, fake: 12, open: 4 });

  // ── BOTH VIEWS AGREE, field by field, over the same fixture ──
  const readView = async (rowSel, spotsSel) => {
    return page.$$eval(rowSel, (els, spotsSel) => els.map((e) => {
      const id = Number(e.getAttribute("data-id"));
      const spots = (e.querySelector(spotsSel)?.textContent || "");
      // The card omits "· 0 fake" when there are none; the snapshot always shows it.
      // Parse each field independently and treat a missing fake as 0 — the NUMBERS still
      // have to agree; only the display of a zero differs.
      const rr = /(\d+)\s*real/.exec(spots), ff = /(\d+)\s*fake/.exec(spots), oo = /(\d+)\s*open/.exec(spots);
      const m = rr && oo ? [null, rr[1], ff ? ff[1] : "0", oo[1]] : null;
      // shortfall: snapshot carries data-short; the card shows it inside the minlab
      // element ("N TO GO"; else MADE IT = 0). Read the minlab specifically so we don't
      // catch "of 18" + "9 TO GO" = "189" from the concatenated tile text.
      let s = e.getAttribute("data-short");
      if (s == null) { const ml = e.querySelector('[data-testid="minlab"]')?.textContent || ""; const mm = /(\d+)\s*TO GO/.exec(ml); s = mm ? mm[1] : "0"; }
      return [id, { real: m ? +m[1] : null, fake: m ? +m[2] : null, open: m ? +m[3] : null, short: Number(s) }];
    }), spotsSel);
  };
  const snap = Object.fromEntries(await readView('[data-testid="snap-row"]', '[data-testid="snap-spots"]'));
  await page.click('[data-testid="view-detail"]'); await page.waitForSelector('[data-testid="tile"]'); await page.waitForTimeout(150);
  const detail = Object.fromEntries(await readView('[data-testid="tile"]', '[data-testid="fill-nums"]'));
  eq("both views cover the same matches", Object.keys(snap).sort(), Object.keys(detail).sort());
  { const disagree = Object.keys(snap).filter((id) => JSON.stringify(snap[id]) !== JSON.stringify(detail[id]));
    disagree.length === 0 ? ok("Snapshot and Detail agree on real/fake/open/short for every match") : bad("views disagree", disagree.map((id) => `${id}: snap ${JSON.stringify(snap[id])} vs detail ${JSON.stringify(detail[id])}`).join(" | ")); }
  await page.click('[data-testid="view-snapshot"]'); await page.waitForSelector('[data-testid="snapshot"]'); await page.waitForTimeout(150);

  // ── risk sort: red (by soonest cancel call), then amber, then green ──
  await page.click('[data-testid="sort-risk"]'); await page.waitForTimeout(150);
  eq("risk sort: reds by soonest call, then amber, then green", await page.$$eval('[data-testid="snap-row"]', (els) => els.map((e) => Number(e.getAttribute("data-id")))), [601, 605, 602, 604, 603]);
  await page.click('[data-testid="sort-time"]'); await page.waitForTimeout(150);

  // ── filters + cities compose; badges follow CITY only ──
  { const before = await page.$eval('[data-testid="filter-all"] .b', (e) => Number(e.textContent));
    await page.click('[data-testid="city-Austin"]'); await page.waitForTimeout(120);
    const after = await page.$eval('[data-testid="filter-all"] .b', (e) => Number(e.textContent));
    const rows = (await page.$$('[data-testid="snap-row"]')).length;
    eq("city filter drives rows AND the All badge (Austin: 2), not the risk filter", { before, after, rows }, { before: 5, after: 2, rows: 2 });
    // compose: Austin + Needs attention -> only 602 (603 is met)
    await page.click('[data-testid="filter-att"]'); await page.waitForTimeout(120);
    eq("Austin AND Needs attention composes to the one short Austin match", await page.$$eval('[data-testid="snap-row"]', (els) => els.map((e) => Number(e.getAttribute("data-id")))), [602]);
    await page.click('[data-testid="filter-all"]'); await page.click('[data-testid="city-all"]'); await page.waitForTimeout(120); }

  // ── row click opens the drawer (same as a card click) ──
  await page.click('[data-testid="snap-row"][data-id="601"]'); await page.waitForTimeout(400);
  eq("clicking a snapshot row opens the edit drawer (same as a card)", !!(await page.$('.mdw, [role="dialog"], [data-testid="gameday"] aside')), true);
  await page.keyboard.press("Escape"); await page.waitForTimeout(150);

  // ── the two views AGREE across an ADVERSARIAL fixture SET ──
  // fake>real, zero real, completely full, minimum>capacity, deadline already passed,
  // zero fakes. And the VALUES are pinned — agreement alone would pass a shared bug.
  activeRaw = ADV;
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="snapshot"]'); await page.waitForTimeout(200);
  const snapA = Object.fromEntries(await readView('[data-testid="snap-row"]', '[data-testid="snap-spots"]'));
  await page.click('[data-testid="view-detail"]'); await page.waitForSelector('[data-testid="tile"]'); await page.waitForTimeout(150);
  const detailA = Object.fromEntries(await readView('[data-testid="tile"]', '[data-testid="fill-nums"]'));
  eq("adversarial: both views cover the same six hard cases", Object.keys(snapA).sort(), ["701", "702", "703", "704", "705", "706"]);
  { const dis = Object.keys(snapA).filter((id) => JSON.stringify(snapA[id]) !== JSON.stringify(detailA[id]));
    dis.length === 0 ? ok("Snapshot & Detail agree on real/fake/open/short across ALL adversarial cases") : bad("adversarial views disagree", dis.map((id) => `${id}: snap ${JSON.stringify(snapA[id])} vs detail ${JSON.stringify(detailA[id])}`).join(" | ")); }
  eq("adversarial VALUES are the intended truth, not a shared wrong number", snapA, {
    "701": { real: 4, fake: 9, open: 5, short: 8 },    // fake > real
    "702": { real: 0, fake: 12, open: 4, short: 8 },   // zero real, many fakes
    "703": { real: 12, fake: 6, open: 0, short: 0 },   // completely full
    "704": { real: 5, fake: 0, open: 5, short: 9 },    // minimum (14) exceeds capacity (10)
    "705": { real: 6, fake: 0, open: 12, short: 6 },   // deadline already passed
    "706": { real: 10, fake: 0, open: 10, short: 2 },  // zero fakes
  });
  { const rf = ["701", "702", "703"].filter((id) => snapA[id].fake > 0 && snapA[id].real === snapA[id].real + snapA[id].fake);
    rf.length === 0 ? ok("real != filled on every fake-bearing adversarial row (701/702/703)") : bad("real==filled", rf.join(",")); }
  await page.click('[data-testid="view-snapshot"]'); await page.waitForTimeout(100);

  // ══ BOTH VIEWS AGREE ON GROUP across all three states (Phase 18) ══
  // Same discipline as the real/fake agreement: one grouping function, so Snapshot and
  // Detail can never put a match in different groups.
  activeRaw = GRP;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="snapshot"]'); await page.waitForTimeout(200);
  const groupOf = (sel) => page.$$eval(sel, (els) => Object.fromEntries(els.map((e) => [e.getAttribute("data-id"), e.getAttribute("data-group")])));
  const snapG = await groupOf('[data-testid="snap-row"]');
  eq("snapshot assigns each state to its group", snapG, { "801": "todo", "802": "cancelled", "803": "finished" });
  eq("snapshot renders the three groups in order", await page.$$eval('[data-testid="snapshot"] > section', (els) => els.map((e) => e.getAttribute("data-testid"))), ["snap-group-todo", "snap-group-cancelled", "snap-group-finished"]);
  eq("snapshot cancelled row: solid CANCELLED badge, NO −N short chip", { badge: !!(await page.$('[data-testid="snap-row"][data-id="802"] [data-testid="snap-cx-badge"]')), noShort: (await page.$('[data-testid="snap-row"][data-id="802"] [data-testid="snap-short"]')) === null }, { badge: true, noShort: true });
  await page.click('[data-testid="view-detail"]'); await page.waitForSelector('[data-testid="tile"]'); await page.waitForTimeout(150);
  const detailG = await groupOf('[data-testid="tile"]');
  eq("BOTH views agree on the group for every match (all three states)", snapG, detailG);
  await page.click('[data-testid="view-snapshot"]'); await page.waitForTimeout(100);

  activeRaw = MAIN; // restore for the phone section

  // ══════════════ PHONE ══════════════
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState });
  await routes(pctx);
  const ph = await pctx.newPage();
  await ph.addInitScript(() => localStorage.setItem("gameday-view", "snapshot"));
  await ph.goto(PAGE, { waitUntil: "domcontentloaded" });
  await ph.waitForSelector('[data-testid="snapshot"]'); await ph.waitForTimeout(200);
  { const o = await overflow(ph); const past = await ph.evaluate(() => { const w = innerWidth; const inScroller = (el) => { let n = el.parentElement; while (n) { const s = getComputedStyle(n); if (s.overflowX === "auto" || s.overflowX === "scroll") return true; n = n.parentElement; } return false; }; return [...document.querySelectorAll(".gdo *")].filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return s.display !== "none" && r.width > 0 && r.right > w + 1 && !inScroller(e); }).length; });
    (!o.pageLeak && past === 0) ? ok("phone: no horizontal overflow (city + filter chips scroll)") : bad("phone overflow", `leak=${o.pageLeak} past=${past}`); }
  { const h = await ph.$eval(".gdo .head", (e) => Math.round(e.getBoundingClientRect().height)); (h < 300) ? ok(`phone: header under 300px (${h})`) : bad("phone header too tall", `${h}px`); }
  { const txt = (await ph.$eval('[data-testid="snap-row"][data-id="601"]', (e) => e.textContent)).replace(/\s+/g, " ");
    (txt.includes("Reda") && txt.includes("$12.00")) ? ok("phone: manager and price stay readable in the row (line 4)") : bad("phone row missing mgr/price", txt.slice(0, 120)); }
  { const small = await ph.evaluate(() => { const out = []; for (const el of document.querySelectorAll('.gdo button, .gdo [role="switch"]')) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || r.width === 0) continue; if (r.height < 30) out.push({ c: (el.className || "").toString().slice(0, 24), h: Math.round(r.height * 10) / 10 }); } return out; });
    small.length === 0 ? ok("phone: no tap target under 30px tall") : bad(`phone: ${small.length} under 30px`, JSON.stringify(small.slice(0, 6))); }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
