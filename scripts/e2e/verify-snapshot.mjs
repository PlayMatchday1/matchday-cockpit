// Gameday Ops — the Snapshot view, hermetic. Phase 21 rebuilt the ROW: one unified
// still-to-come predicate (chip == group == rows), a four-number counts line (no "open"),
// the printed minimum under a three-state marker (glyph AND fill change), the vs MIN chip,
// two ABSOLUTE clocks (kickoff + DECIDE BY), the at-min rail tier, and the removed Risk sort.
// Still proves the two views derive real/fake/open/short from the SAME gamedayModel, over an
// adversarial set. Desktop (1280) + a 390x844 touch context.
//   node scripts/e2e/verify-snapshot.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();
import { overflow } from "./checks.mjs";

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/match-ops/gameday`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const near = (n, got, want, tol) => (Math.abs(got - want) <= tol ? ok(n) : bad(n, `got ${got} want ${want}±${tol}`));

// WCAG contrast ratio for the marker check (white on #8a5600), computed in-process.
const rgb = (s) => { const m = s.match(/(\d+),\s*(\d+),\s*(\d+)/); return m ? { r: +m[1], g: +m[2], b: +m[3] } : null; };
const lin1 = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const Lum = (c) => 0.2126 * lin1(c.r) + 0.7152 * lin1(c.g) + 0.0722 * lin1(c.b);
const cratio = (a, b) => { const x = Lum(a), y = Lum(b), hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); };

// Contrast sweep SCOPED to the board (.gdo). Every visible text node's colour vs its effective
// background must be >= 4.5:1 — including the min label, the three marker states, the vs MIN
// chips, the muted counts line, and the red cancelled row.
async function contrastIn(pg) {
  return pg.evaluate(() => {
    const root = document.querySelector(".gdo"); if (!root) return { failures: [], min: Infinity };
    const pc = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a, b) => { const x = L(a), y = L(b), hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); };
    const bg = (el) => { let n = el; while (n && n.nodeType === 1) { const c = pc(getComputedStyle(n).backgroundColor); if (c && c.a > 0.85) return c; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const txt = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const vis = (el) => { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false; return el.offsetParent !== null || s.position === "fixed"; };
    const failures = []; let min = Infinity;
    for (const el of root.querySelectorAll("*")) { if (!txt(el) || !vis(el)) continue; const fg = pc(getComputedStyle(el).color); if (!fg) continue; const r = ratio(fg, bg(el)); if (r < min) min = Math.round(r * 100) / 100; if (r < 4.5) failures.push({ ratio: Math.round(r * 100) / 100, t: el.textContent.trim().slice(0, 32), c: (el.getAttribute("class") || "").slice(0, 34) }); }
    return { failures, min };
  });
}

const grantEdit = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, can_edit_matches: true, can_access_matchops: true });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

// id, city, mins-to-kickoff, real, fake, min, cap, acMin, mgr, price, tz, [state]
// acMin 75 = the STANDARD lead (row hides "cancels 75m before"); anything else is shown.
const MAIN = [
  [601, "Houston",      120,  3, 3, 12, 18, 75, "Reda",  1200, "CST"], // short+imminent (deadline 45m): red rail, −9 short, marker !
  [602, "Austin",       300,  5, 3, 12, 20, 90, "Tobi",  1200, "CST"], // short+far (deadline 210m): amber rail, −7 short, lead 90 SHOWN
  [603, "Austin",        60, 14, 0, 12, 20, 75, "Cami",  1200, "CST"], // OVER: green rail, +2 over, marker ✓, zero-fake MUTED
  [604, "Dallas",       400, 12, 0, 12, 18, 75, "Devon", 1400, "CST"], // AT MIN: amber rail, "0 at min", HOLLOW marker ✓
  [605, "San Antonio",  200,  7, 7, 11, 18, 75, "Ricki", 1200, "CST"], // LBJ TRAP: 7 real 7 fake min 11 -> short; hatch runs PAST marker
  [606, "Houston",      500,  5, 0, 18, 18, 75, "Ivy",   1200, "CST"], // near-CAP min (min==cap): marker at 100%, stays in row
  [607, "Austin",       500,  0, 0,  1, 18, 75, "Max",   1200, "CST"], // near-0 min (1/18): marker ~5.6%, stays in row
];
// §0 — a spread of future + IN-PLAY + finished so the chip, the group, and the rows must agree.
const S0 = [
  [901, "Austin",  30, 5, 0, 12, 18, 75, "A", 1200, "CST"],           // still to come
  [902, "Austin", 180, 5, 0, 12, 18, 75, "B", 1200, "CST"],           // still to come
  [903, "Austin", -10, 8, 0, 12, 18, 75, "C", 1200, "CST", "live"],   // IN PLAY (kicked off 10m ago)
  [904, "Austin", -70, 8, 0, 12, 18, 75, "D", 1200, "CST", "live"],   // IN PLAY (kicked off 70m ago, <90m)
  [905, "Austin",   0, 9, 0, 12, 18, 75, "E", 1200, "CST", "done"],   // finished (5h ago)
];
// Adversarial — the two views must agree field-by-field on these hard shapes too.
const ADV = [
  [701, "Austin", 300, 4, 9, 12, 18, 30, "A", 1200, "CST"],   // fake > real
  [702, "Austin", 300, 0, 12, 8, 16, 30, "B", 1200, "CST"],   // zero real, many fakes
  [703, "Dallas", 300, 12, 6, 12, 18, 30, "C", 1200, "CST"],  // completely FULL (open 0)
  [704, "Houston", 300, 5, 0, 14, 10, 30, "D", 1200, "CST"],  // minimum EXCEEDS capacity (14 > 10)
  [705, "Houston", 20, 6, 0, 12, 18, 30, "E", 1200, "CST"],   // auto-cancel deadline ALREADY passed
  [706, "Austin", 300, 10, 0, 12, 20, 30, "F", 1200, "CST"],  // zero fakes
];
// All group states — both views must agree which GROUP each is in.
const GRP = [
  [801, "Austin", 180, 3, 0, 12, 18, 75, "T", 1200, "CST"],          // still to come (short)
  [802, "Austin", 180, 3, 0, 12, 18, 75, "C", 1200, "CST", "cx"],    // cancelled
  [803, "Austin", 0, 14, 2, 12, 18, 75, "F", 1200, "CST", "done"],   // finished (past kickoff)
];
let activeRaw = MAIN; // route serves this; flipped mid-run to exercise S0 / ADV / GRP
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
// Read real/fake/open/short off the DATA ATTRIBUTES both views now expose (robust vs text).
const readAttrs = () => (els) => Object.fromEntries(els.map((e) => [e.getAttribute("data-id"), {
  real: Number(e.getAttribute("data-real")), fake: Number(e.getAttribute("data-fake")),
  open: Number(e.getAttribute("data-open")), short: Number(e.getAttribute("data-short")),
}]));

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
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
  const row = (id) => `[data-testid="snap-row"][data-id="${id}"]`;

  // ── one snapshot row per match, desktop keeps the 8-column single-line layout ──
  eq("one snapshot row per match (7)", (await page.$$('[data-testid="snap-row"]')).length, 7);
  eq("desktop: snapshot row keeps the 8-column single-line layout at 1280", await page.$eval('[data-testid="snap-row"]', (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length), 8);

  // ══════════════ §1 — THE COUNTS LINE: four numbers, no "open", nothing to subtract ══════════════
  { const t603 = (await page.$eval(row(603) + ' [data-testid="snap-spots"]', (e) => e.textContent)).replace(/\s+/g, " ").trim();
    eq("§1: counts read 'real · fake · total of cap spots' (603: 14/0/14/20)", t603, "14 real · 0 fake · 14 total of 20 spots");
    const nums = t603.match(/\d+/g) || [];
    eq("§1: exactly FOUR number groups in the counts line", nums.length, 4);
    ok(!/\bopen\b/.test(t603) ? "§1: the word 'open' appears nowhere in the counts line" : bad("§1 'open' survives", t603)); }
  // whole-row 'open' check on every row
  { const anyOpen = await page.$$eval('[data-testid="snap-row"]', (els) => els.filter((e) => /\bopen\b/.test(e.textContent)).length);
    eq("§1: no row anywhere says 'open'", anyOpen, 0); }
  // "of N spots" (capacity) is a LIGHTER weight than the counts numbers (an anchor, not a headline)
  { const w = await page.$eval(row(603) + ' [data-testid="snap-spots"]', (e) => ({ cap: +getComputedStyle(e.querySelector(".ofcap")).fontWeight, real: +getComputedStyle(e.querySelector("b")).fontWeight }));
    ok(w.cap < w.real ? `§1: 'of N spots' weight (${w.cap}) is lighter than the counts (${w.real})` : bad("§1 capacity not lighter", JSON.stringify(w))); }
  // zero fakes render MUTED; non-zero do not (603 has 0, 601 has 3) — the number carries the colour
  { const z = await page.$eval(row(603) + ' [data-testid="snap-spots"] .fk', (e) => ({ z: e.classList.contains("z"), col: getComputedStyle(e.querySelector("b")).color }));
    const nz = await page.$eval(row(601) + ' [data-testid="snap-spots"] .fk', (e) => ({ z: e.classList.contains("z"), col: getComputedStyle(e.querySelector("b")).color }));
    (z.z && !nz.z && z.col !== nz.col) ? ok("§1: zero fakes render muted, non-zero fakes do not (distinct colour)") : bad("§1 fake muting", JSON.stringify({ z, nz })); }

  // ══════════════ §5 — vs MIN replaces SHORT / "N of M" ══════════════
  eq("§5: the column header is renamed 'vs MIN'", (await page.$$eval('[data-testid="snapshot"] .colhead > span', (els) => els.map((e) => e.textContent))).includes("vs MIN"), true);
  eq("§5: over -> '+N over' (603: +2 over)", (await page.$eval(row(603) + ' [data-testid="snap-short"]', (e) => e.textContent)).trim(), "+2 over");
  eq("§5: at min -> '0 at min' (604)", (await page.$eval(row(604) + ' [data-testid="snap-short"]', (e) => e.textContent)).trim(), "0 at min");
  eq("§5: short -> '−N short' (601: −9 short)", (await page.$eval(row(601) + ' [data-testid="snap-short"]', (e) => e.textContent)).trim(), "−9 short");
  // every chip the same height, none wraps/clips
  { const chips = await page.$$eval('[data-testid="snap-row"] .vsmin:not(.none)', (els) => els.map((e) => ({ h: Math.round(e.getBoundingClientRect().height), clip: e.scrollWidth > e.clientWidth + 1, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || "16")) })));
    const heights = [...new Set(chips.map((c) => c.h))];
    (heights.length === 1) ? ok(`§5: every vs MIN chip is the same height (${heights[0]}px)`) : bad("§5 chip heights differ", JSON.stringify(heights));
    (chips.every((c) => !c.clip)) ? ok("§5: no vs MIN chip clips its text") : bad("§5 chip clips"); }
  // no "N of M" survives anywhere in a row (the counts "total of 18" has no digit before "of")
  { const nofm = await page.$$eval('[data-testid="snap-row"]', (els) => els.filter((e) => /\d+\s+of\s+\d+/.test(e.textContent.replace(/\s+/g, " "))).map((e) => e.getAttribute("data-id")));
    eq("§5: no 'N of M' pair survives on any row", nofm, []); }

  // ══════════════ §2/§3/§4 — THE PRINTED MINIMUM + THE MARKER ══════════════
  // printed minimum is ON SCREEN, "min N"
  eq("§2: the minimum is printed on screen as 'min N' (601: min 12)", (await page.$eval(row(601) + ' [data-testid="snap-min"]', (e) => e.textContent)).trim(), "min 12");
  // centred within ~2px of the marker centre (mid-range row 601, marker at 66.7%)
  { const mkc = await page.$eval(row(601) + ' [data-testid="snap-marker"]', (e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; });
    const lbc = await page.$eval(row(601) + ' [data-testid="snap-min"]', (e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; });
    near("§2: 'min N' centred within 2px of the marker centre", lbc, mkc, 2); }
  // below the marker (not overlapping), and above the counts line (not overlapping)
  { const g = await page.$eval(row(601), (e) => { const m = e.querySelector('[data-testid="snap-marker"]').getBoundingClientRect(); const l = e.querySelector('[data-testid="snap-min"]').getBoundingClientRect(); const s = e.querySelector('[data-testid="snap-spots"]').getBoundingClientRect(); return { mBottom: m.bottom, lTop: l.top, lBottom: l.bottom, sTop: s.top }; });
    (g.lTop >= g.mBottom - 0.5) ? ok("§2: 'min N' sits BELOW the marker (no overlap)") : bad("§2 label overlaps marker", JSON.stringify(g));
    (g.lBottom <= g.sTop + 0.5) ? ok("§2: 'min N' does not overlap the counts line beneath") : bad("§2 label overlaps counts", JSON.stringify(g)); }
  // stays inside the row when the minimum is near capacity (606: min==cap) and near 0 (607: min 1)
  for (const [id, lab] of [[606, "near capacity"], [607, "near 0"]]) {
    const g = await page.$eval(row(id), (e) => { const b = e.querySelector(".bar").getBoundingClientRect(); const l = e.querySelector('[data-testid="snap-min"]').getBoundingClientRect(); const r = e.getBoundingClientRect(); return { bl: b.left, br: b.right, ll: l.left, lr: l.right, rl: r.left, rr: r.right }; });
    (g.ll >= g.rl - 0.5 && g.lr <= g.rr + 0.5) ? ok(`§2: printed minimum stays inside the row (${lab})`) : bad(`§2 label overflows row (${lab})`, JSON.stringify(g));
  }
  // real − printed-minimum == the vs MIN chip number, checked against SOURCE DATA (data attrs)
  { const bad2 = [];
    for (const [id, want] of [[601, -9], [603, 2], [604, 0], [606, -13], [607, -1]]) {
      const real = await page.$eval(row(id), (e) => Number(e.getAttribute("data-real")));
      const min = await page.$eval(row(id), (e) => Number(e.getAttribute("data-min")));
      if (real - min !== want) bad2.push(`${id}: real-min=${real - min} want ${want}`);
    }
    bad2.length === 0 ? ok("§2: real − printed-minimum === the vs MIN number on every row (source-consistent)") : bad("§2 min consistency", bad2.join(" | ")); }
  // rows are the same height within 1px and none exceeds ~92px
  { const hs = await page.$$eval('[data-testid="snap-row"]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    const spread = Math.max(...hs) - Math.min(...hs);
    (spread <= 1) ? ok(`§2: all rows the same height within 1px (${Math.min(...hs)}..${Math.max(...hs)})`) : bad("§2 row heights differ", JSON.stringify(hs));
    (Math.max(...hs) <= 92) ? ok(`§2: no row exceeds ~92px (max ${Math.max(...hs)})`) : bad("§2 row too tall", `${Math.max(...hs)}`); }

  // §3 — the marker: three states, GLYPH changes too
  { const markers = await page.$$eval('[data-testid="snap-marker"]', (els) => els.map((e) => ({ id: e.closest("[data-id]").getAttribute("data-id"), state: e.getAttribute("data-state"), glyph: e.textContent.trim(), bg: getComputedStyle(e).backgroundColor, border: getComputedStyle(e).borderColor })));
    const by = Object.fromEntries(markers.map((m) => [m.id, m]));
    ok(by["601"].glyph === "!" ? "§3: below-min glyph is NOT a check (601 shows '!')" : bad("§3 below glyph", by["601"].glyph));
    ok(by["605"].glyph === "!" ? "§3: LBJ (605) below-min glyph is '!'" : bad("§3 LBJ glyph", by["605"].glyph));
    ok(by["603"].glyph === "✓" && by["604"].glyph === "✓" ? "§3: over(603) and at-min(604) keep the CHECK glyph" : bad("§3 check glyph"));
    const glyphs = new Set(markers.map((m) => m.glyph));
    ok(glyphs.has("✓") && glyphs.has("!") ? "§3: both glyphs (✓ and !) are in use" : bad("§3 both glyphs", [...glyphs].join()));
    const fills = new Set([by["603"].bg, by["604"].bg, by["601"].bg]);
    ok(fills.size === 3 ? "§3: three distinct marker fills (over / at-min / below)" : bad("§3 fills not distinct", JSON.stringify([...fills])));
    // at-line is the ONLY hollow one — its fill is white while the other two are solid colour
    const white = (s) => { const c = rgb(s); return c && c.r > 240 && c.g > 240 && c.b > 240; };
    ok(white(by["604"].bg) && !white(by["603"].bg) && !white(by["601"].bg) ? "§3: at-min is the ONLY hollow marker (white fill, amber border)" : bad("§3 hollow", JSON.stringify({ at: by["604"].bg, over: by["603"].bg, below: by["601"].bg })));
    // white on the below-min amber #8a5600 clears 4.5:1
    const amber = rgb(by["601"].bg);
    ok(cratio({ r: 255, g: 255, b: 255 }, amber) >= 4.5 ? `§3: white glyph on the below-min amber clears 4.5:1 (${cratio({ r: 255, g: 255, b: 255 }, amber).toFixed(2)})` : bad("§3 amber contrast", JSON.stringify(amber))); }
  // marker titles
  eq("§3: cleared/at-line title names the minimum", await page.$eval(row(604) + ' [data-testid="snap-marker"]', (e) => e.getAttribute("title")), "Minimum 12 real players");
  eq("§3: below-min title says how many short", await page.$eval(row(601) + ' [data-testid="snap-marker"]', (e) => e.getAttribute("title")), "9 short of the 12 real players needed");

  // §4 — THE TRAP: marker state is (real − min), NOT total fill. Assert GEOMETRY, not class.
  const edges = async (id) => page.$eval(row(id), (e) => {
    const bar = e.querySelector(".bar").getBoundingClientRect();
    const solid = e.querySelector(".seg1").getBoundingClientRect();
    const hatchEl = e.querySelector(".seg2");           // only present when there are fakes
    const hatch = hatchEl ? hatchEl.getBoundingClientRect() : null;
    const mkEl = e.querySelector('[data-testid="snap-marker"]');
    const mk = mkEl.getBoundingClientRect();
    return { barW: bar.width, solidRight: solid.right, hatchRight: hatch ? hatch.right : null, markerCx: mk.left + mk.width / 2, glyph: mkEl.textContent.trim() };
  });
  { const e603 = await edges(603); ok(e603.solidRight > e603.markerCx ? "§4: real>min — solid edge is RIGHT of the marker (603)" : bad("§4 603", JSON.stringify(e603))); }
  { const e601 = await edges(601); ok(e601.solidRight < e601.markerCx ? "§4: real<min — solid edge is LEFT of the marker (601)" : bad("§4 601", JSON.stringify(e601))); }
  { const e604 = await edges(604); near("§4: real==min — solid edge within ~2px of the marker (604)", e604.solidRight, e604.markerCx, 2.5); }
  // THE REGRESSION: LBJ (605) — hatch RIGHT of marker AND solid LEFT of it AND glyph "!"
  { const lbj = await edges(605);
    const good = lbj.hatchRight > lbj.markerCx && lbj.solidRight < lbj.markerCx && lbj.glyph === "!";
    good ? ok("§4: LBJ regression — hatch runs PAST the marker, solid edge LEFT of it, glyph '!' (fakes never clear the minimum)") : bad("§4 LBJ", JSON.stringify(lbj)); }

  // ══════════════ §6 — THE AT-MIN TIER: three distinct rail colours, distinct chip ══════════════
  const railColour = (id) => page.$eval(row(id) + " .rail", (e) => getComputedStyle(e).backgroundColor);
  { const over = await railColour(603), atmin = await railColour(604), red = await railColour(601);
    const set = new Set([over, atmin, red]);
    (set.size === 3) ? ok(`§6: three distinct rail colours (over / at-min / short-imminent)`) : bad("§6 rails not distinct", JSON.stringify([over, atmin, red]));
    (atmin !== over && atmin !== red) ? ok("§6: the at-min rail differs from BOTH over(green) and short(red)") : bad("§6 at-min rail not distinct"); }
  eq("§6: at-min row carries data-rail='amber' while riskTier stays 'green' (§9 display layer)", { rail: await page.$eval(row(604), (e) => e.getAttribute("data-rail")), risk: await page.$eval(row(604), (e) => e.getAttribute("data-risk")) }, { rail: "amber", risk: "green" });
  // the at-min CHIP colour differs from both over and short
  { const cols = {}; for (const id of [603, 604, 601]) cols[id] = await page.$eval(row(id) + ' [data-testid="snap-short"]', (e) => getComputedStyle(e).color);
    (cols[604] !== cols[603] && cols[604] !== cols[601]) ? ok("§6: the '0 at min' chip colour differs from both over and short") : bad("§6 at-min chip", JSON.stringify(cols)); }
  // at-min counts toward Needs attention (604 present under the filter)
  { await page.click('[data-testid="filter-att"]'); await page.waitForTimeout(150);
    const ids = await page.$$eval('[data-testid="snap-row"]', (els) => els.map((e) => Number(e.getAttribute("data-id"))).sort((a, b) => a - b));
    ok(ids.includes(604) ? "§6: the at-min match (604) counts toward Needs attention" : bad("§6 at-min not in attention", JSON.stringify(ids)));
    await page.click('[data-testid="filter-all"]'); await page.waitForTimeout(120); }

  // ══════════════ 21b item 4 — the at-min tier (604): ALL FOUR signals fire together ══════════════
  // 0 of 23 live matches sit at-min today, so this is the only place the tier renders. Assert
  // every channel on the one at-min row, not just one, so it can't be wrong the first time it fires.
  { const chip = await page.$eval(row(604) + ' [data-testid="snap-short"]', (e) => ({ txt: e.textContent.trim(), col: getComputedStyle(e).color }));
    const overChipCol = await page.$eval(row(603) + ' [data-testid="snap-short"]', (e) => getComputedStyle(e).color);
    const shortChipCol = await page.$eval(row(601) + ' [data-testid="snap-short"]', (e) => getComputedStyle(e).color);
    const mk = await page.$eval(row(604) + ' [data-testid="snap-marker"]', (e) => ({ state: e.getAttribute("data-state"), glyph: e.textContent.trim(), bg: getComputedStyle(e).backgroundColor, border: getComputedStyle(e).borderColor }));
    const rail = await page.$eval(row(604) + " .rail", (e) => getComputedStyle(e).backgroundColor);
    const overRail = await page.$eval(row(603) + " .rail", (e) => getComputedStyle(e).backgroundColor);
    const shortRail = await page.$eval(row(601) + " .rail", (e) => getComputedStyle(e).backgroundColor);
    const white = (s) => { const c = rgb(s); return c && c.r > 240 && c.g > 240 && c.b > 240; };
    const isAmber = (s) => { const c = rgb(s); return c && c.r === 138 && c.g === 86 && c.b === 0; }; // #8a5600
    // (1) gap chip
    eq("21b§4(1): 604 gap chip reads '0 at min', colour distinct from BOTH over and short", { txt: chip.txt, distinct: chip.col !== overChipCol && chip.col !== shortChipCol }, { txt: "0 at min", distinct: true });
    // (2) marker: at-line state — hollow (white fill), AMBER border, and a CHECK (not a bang)
    eq("21b§4(2): 604 marker is at-line — data-state 'at', hollow white fill, amber border, CHECK glyph", { state: mk.state, hollow: white(mk.bg), amberBorder: isAmber(mk.border), glyph: mk.glyph }, { state: "at", hollow: true, amberBorder: true, glyph: "✓" });
    // (3) row rail is the third distinct colour
    ok(rail !== overRail && rail !== shortRail ? "21b§4(3): 604 rail is the third distinct colour (≠ over-green, ≠ short-red)" : bad("21b§4(3) rail not distinct", JSON.stringify({ rail, overRail, shortRail })));
    // (4) counts toward Needs attention
    await page.click('[data-testid="filter-att"]'); await page.waitForTimeout(150);
    const inAtt = await page.$('[data-testid="snap-row"][data-id="604"]');
    ok(inAtt ? "21b§4(4): 604 (at-min) is present under the Needs-attention filter" : bad("21b§4(4) at-min not in attention"));
    await page.click('[data-testid="filter-all"]'); await page.waitForTimeout(120); }

  // ══════════════ §7 — THE TWO CLOCKS ══════════════
  eq("§7c: the DECIDE BY column header replaces AUTO-CANCEL", (await page.$$eval('[data-testid="snapshot"] .colhead > span', (els) => els.map((e) => e.textContent))).includes("DECIDE BY"), true);
  ok(!(await page.$$eval('[data-testid="snapshot"] .colhead > span', (els) => els.map((e) => e.textContent))).includes("AUTO-CANCEL") ? "§7c: 'AUTO-CANCEL' is gone from the snapshot header" : bad("§7c AUTO-CANCEL survives"));
  // both clocks lead with an ABSOLUTE time + zone marker (601: kickoff & decide-by)
  { const kick = (await page.$eval(row(601) + ' .c-time .t1', (e) => e.textContent)).replace(/\s+/g, " ").trim();
    const dec = (await page.$eval(row(601) + ' .c-cxl .c1.clk', (e) => e.textContent)).replace(/\s+/g, " ").trim();
    ok(/\d{1,2}:\d{2}\s*(AM|PM)\s*CST/.test(kick) ? `§7a: kickoff leads with an absolute clock + zone (${kick})` : bad("§7a kickoff clock", kick));
    ok(/\d{1,2}:\d{2}\s*(AM|PM)\s*CST/.test(dec) ? `§7a: decide-by leads with an absolute clock + zone (${dec})` : bad("§7a decide clock", dec)); }
  // deadline is DERIVED from kickoff − lead. 601 kickoff 12:00 PM, lead 75 -> 10:45 AM. The clock
  // text node and the zone <em> are separate; read the clock text node for the exact derived time.
  eq("§7d: decide-by is kickoff minus the lead (601: 12:00 PM − 75m = 10:45 AM)", (await page.$eval(row(601) + ' .c-cxl .c1.clk', (e) => e.childNodes[0].textContent)).trim(), "10:45 AM");
  // the deadline SUB is a budget ("X left" / "passed"), never "in ..."
  { const sub = (await page.$eval(row(601) + ' .c-cxl .c2', (e) => e.textContent)).trim();
    ok(!/^in\b/.test(sub) ? `§7b: the decide-by sub does NOT start with 'in' (${sub})` : bad("§7b decide sub starts with in", sub)); }
  // no row contains more than one "in Xm" phrase
  { const worst = await page.$$eval('[data-testid="snap-row"]', (els) => Math.max(...els.map((e) => (e.textContent.match(/\bin\s+\d/g) || []).length)));
    (worst <= 1) ? ok("§7g: no row contains more than one 'in Xm' phrase") : bad("§7g multiple 'in' phrases", `${worst}`); }
  // the mechanism is stated ONCE in the legend; a row names its lead only when it DIFFERS from 75
  eq("§7e: the decide-by mechanism is in the legend, once", /auto-cancels .* 75 minutes before kickoff/i.test(await page.$eval('[data-testid="decideby-legend"]', (e) => e.textContent)), true);
  ok(!/cancels\s+75m\s+before/i.test(await page.$eval(row(601) + ' .c-cxl', (e) => e.textContent)) ? "§7e: a standard-lead row (75m) does NOT repeat 'cancels 75m before'" : bad("§7e standard lead repeated"));
  ok(/cancels\s+90m\s+before/i.test(await page.$eval(row(602) + ' .c-cxl', (e) => e.textContent)) ? "§7e: a non-standard-lead row (90m) DOES name its lead" : bad("§7e non-standard lead missing"));
  // prominence follows the shortfall: a cleared row's deadline differs in BOTH colour and weight from a short row's
  { const clr = await page.$eval(row(603) + ' .c-cxl .c2', (e) => ({ c: getComputedStyle(e).color, w: getComputedStyle(e).fontWeight }));
    const sht = await page.$eval(row(601) + ' .c-cxl .c2', (e) => ({ c: getComputedStyle(e).color, w: getComputedStyle(e).fontWeight }));
    (clr.c !== sht.c && clr.w !== sht.w) ? ok("§7f: a cleared row's decide-by differs in BOTH colour and weight from a short row's") : bad("§7f prominence", JSON.stringify({ clr, sht })); }

  // ══════════════ §8 — THE RISK SORT IS GONE ══════════════
  { const gone = await page.evaluate(() => ["sort-time", "sort-risk", "m-sort-time", "m-sort-risk"].every((t) => !document.querySelector(`[data-testid="${t}"]`)));
    ok(gone ? "§8: the Sort control (Time/Risk) is entirely removed — no sort-* controls remain" : bad("§8 sort control survives")); }

  // ══════════════ §0 — ONE PREDICATE: chip == group == rows, no 'in play' inside the group ══════════════
  activeRaw = S0;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="snapshot"]'); await page.waitForTimeout(200);
  { const chip = await page.$eval('[data-testid="filter-upc"] .b', (e) => Number(e.textContent));
    const groupCount = await page.$eval('[data-testid="snap-group-todo"] .grouphd .n', (e) => Number(e.textContent));
    const rowsInGroup = (await page.$$('[data-testid="snap-group-todo"] [data-testid="snap-row"]')).length;
    eq("§0: header chip == STILL TO COME group count == rows rendered in the group", { chip, groupCount, rowsInGroup }, { chip: 2, groupCount: 2, rowsInGroup: 2 });
    // no row INSIDE the still-to-come group reads "in play"
    const inPlayInGroup = await page.$$eval('[data-testid="snap-group-todo"] [data-testid="snap-row"] .c-time .t2', (els) => els.filter((e) => /in play/i.test(e.textContent)).length);
    eq("§0: no row inside STILL TO COME ever reads 'in play'", inPlayInGroup, 0);
    // the two in-play matches sit in their own IN PLAY group and DO read "in play"
    // byKickoff order: 904 kicked off earlier (70m ago) sorts before 903 (10m ago).
    const ip = await page.$$eval('[data-testid="snap-group-inplay"] [data-testid="snap-row"]', (els) => els.map((e) => e.getAttribute("data-id")));
    eq("§0: the two in-play matches land in the IN PLAY group (kickoff order)", ip, ["904", "903"]);
    eq("§0: an IN PLAY row reads 'in play'", /in play/i.test(await page.$eval('[data-testid="snap-group-inplay"] [data-testid="snap-row"] .c-time .t2', (e) => e.textContent)), true); }

  // ══════════════ BOTH VIEWS AGREE (adversarial), via data attributes ══════════════
  activeRaw = ADV;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="snapshot"]'); await page.waitForTimeout(200);
  const snapA = await page.$$eval('[data-testid="snap-row"]', readAttrs());
  await page.click('[data-testid="view-detail"]'); await page.waitForSelector('[data-testid="tile"]'); await page.waitForTimeout(150);
  const detailA = await page.$$eval('[data-testid="tile"]', readAttrs());
  eq("adversarial: both views cover the same six hard cases", Object.keys(snapA).sort(), ["701", "702", "703", "704", "705", "706"]);
  { const dis = Object.keys(snapA).filter((id) => JSON.stringify(snapA[id]) !== JSON.stringify(detailA[id]));
    dis.length === 0 ? ok("Snapshot & Detail agree on real/fake/open/short across ALL adversarial cases") : bad("adversarial views disagree", dis.map((id) => `${id}: ${JSON.stringify(snapA[id])} vs ${JSON.stringify(detailA[id])}`).join(" | ")); }
  eq("adversarial VALUES are the intended truth, not a shared wrong number", snapA, {
    "701": { real: 4, fake: 9, open: 5, short: 8 },    // fake > real
    "702": { real: 0, fake: 12, open: 4, short: 8 },   // zero real, many fakes
    "703": { real: 12, fake: 6, open: 0, short: 0 },   // completely full
    "704": { real: 5, fake: 0, open: 5, short: 9 },    // minimum (14) exceeds capacity (10)
    "705": { real: 6, fake: 0, open: 12, short: 6 },   // deadline already passed
    "706": { real: 10, fake: 0, open: 10, short: 2 },  // zero fakes
  });
  await page.click('[data-testid="view-snapshot"]'); await page.waitForTimeout(100);

  // ══ BOTH VIEWS AGREE ON GROUP across all states, and the group order ══
  activeRaw = GRP;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="snapshot"]'); await page.waitForTimeout(200);
  const groupOf = (sel) => page.$$eval(sel, (els) => Object.fromEntries(els.map((e) => [e.getAttribute("data-id"), e.getAttribute("data-group")])));
  const snapG = await groupOf('[data-testid="snap-row"]');
  eq("snapshot assigns each state to its group", snapG, { "801": "todo", "802": "cancelled", "803": "finished" });
  eq("snapshot renders the non-empty groups in order (empty IN PLAY filtered out)", await page.$$eval('[data-testid="snapshot"] > section', (els) => els.map((e) => e.getAttribute("data-testid"))), ["snap-group-todo", "snap-group-cancelled", "snap-group-finished"]);
  eq("snapshot cancelled row: solid CANCELLED badge, NO vs MIN chip", { badge: !!(await page.$(row(802) + ' [data-testid="snap-cx-badge"]')), noShort: (await page.$(row(802) + ' [data-testid="snap-short"]')) === null }, { badge: true, noShort: true });
  eq("snapshot cancelled time slot reads 'was due'", /was due/i.test(await page.$eval(row(802) + ' .c-time', (e) => e.textContent)), true);
  await page.click('[data-testid="view-detail"]'); await page.waitForSelector('[data-testid="tile"]'); await page.waitForTimeout(150);
  const detailG = await groupOf('[data-testid="tile"]');
  eq("BOTH views agree on the group for every match (all states)", snapG, detailG);
  await page.click('[data-testid="view-snapshot"]'); await page.waitForTimeout(100);

  activeRaw = MAIN; // restore for the phone section

  // ══════════════ PHONE ══════════════
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState });
  await routes(pctx);
  const ph = await pctx.newPage();
  await ph.addInitScript(() => localStorage.setItem("gameday-view", "snapshot"));
  await ph.goto(PAGE, { waitUntil: "domcontentloaded" });
  await ph.waitForSelector('[data-testid="snapshot"]'); await ph.waitForTimeout(200);
  const prow = (id) => `[data-testid="snap-row"][data-id="${id}"]`;
  { const o = await overflow(ph); const past = await ph.evaluate(() => { const w = innerWidth; const inScroller = (el) => { let n = el.parentElement; while (n) { const s = getComputedStyle(n); if (s.overflowX === "auto" || s.overflowX === "scroll") return true; n = n.parentElement; } return false; }; return [...document.querySelectorAll(".gdo *")].filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return s.display !== "none" && r.width > 0 && r.right > w + 1 && !inScroller(e); }).length; });
    (!o.pageLeak && past === 0) ? ok("phone: no horizontal overflow (city + filter chips scroll)") : bad("phone overflow", `leak=${o.pageLeak} past=${past}`); }
  { const h = await ph.$eval(".gdo .mhead", (e) => Math.round(e.getBoundingClientRect().height)); (h < 140) ? ok(`phone: header under 140px (${h})`) : bad("phone header too tall", `${h}px`); }
  { const scr = await ph.evaluate(() => { const out = []; for (const e of document.querySelectorAll(".gdo *")) { const s = getComputedStyle(e); if (s.display === "none" || s.visibility === "hidden") continue; if ((s.overflowX === "auto" || s.overflowX === "scroll") && e.getBoundingClientRect().width > 0 && e.scrollWidth > e.clientWidth + 2) out.push(e.getAttribute("data-testid") || (e.className || "").toString().slice(0, 20)); } return out; });
    (scr.length === 1 && scr[0] === "mchips") ? ok("phone: exactly one horizontal scroller, and it is the filter chips") : bad("phone scrollers", JSON.stringify(scr)); }
  // §10 — the bar stays readable (>=220px) and the marker stays >=14px
  { const b = await ph.$eval(prow(601) + " .bar", (e) => Math.round(e.getBoundingClientRect().width));
    (b >= 220) ? ok(`phone: the fill bar stays at least 220px wide (${b})`) : bad("phone bar too narrow", `${b}px`); }
  { const m = await ph.$eval(prow(601) + ' [data-testid="snap-marker"]', (e) => Math.round(e.getBoundingClientRect().width));
    (m >= 14) ? ok(`phone: the marker stays at least 14px (${m})`) : bad("phone marker too small", `${m}px`); }
  // §10 — the three counts, the capacity, the printed minimum and the vs MIN chip all survive
  { const spots = (await ph.$eval(prow(601) + ' [data-testid="snap-spots"]', (e) => e.textContent)).replace(/\s+/g, " ").trim();
    eq("phone: counts line survives with all four numbers (601)", spots, "3 real · 3 fake · 6 total of 18 spots");
    const minlab = (await ph.$eval(prow(601) + ' [data-testid="snap-min"]', (e) => e.textContent)).trim();
    eq("phone: printed minimum survives", minlab, "min 12");
    const chip = (await ph.$eval(prow(601) + ' [data-testid="snap-short"]', (e) => e.textContent)).trim();
    eq("phone: vs MIN chip survives", chip, "−9 short"); }
  // §10 — both clocks keep their ABSOLUTE times (kickoff in the row, decide-by in the mobile line)
  { const kick = (await ph.$eval(prow(601) + ' .c-time .t1', (e) => e.textContent)).replace(/\s+/g, " ").trim();
    const mob = (await ph.$eval(prow(601) + ' [data-testid="snap-cxlmob"]', (e) => e.textContent)).replace(/\s+/g, " ").trim();
    ok(/\d{1,2}:\d{2}\s*(AM|PM)/.test(kick) ? "phone: kickoff keeps its absolute clock" : bad("phone kickoff clock", kick));
    ok(/10:45\s*(AM|PM)/.test(mob) ? `phone: decide-by keeps its absolute clock (${mob})` : bad("phone decide clock", mob)); }
  // §10 — nothing truncates
  { const trunc = await ph.$$eval('[data-testid="snap-row"] .m1, [data-testid="snap-row"] [data-testid="snap-spots"]', (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    (trunc === 0) ? ok("phone: names and counts never truncate") : bad("phone truncation", `${trunc} node(s)`); }
  { const edge = await ph.$eval('[data-testid="snap-row"]', (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return { left: Math.round(r.left), rightAtVw: Math.round(r.right) === innerWidth, radii: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius] }; });
    eq("phone: snapshot rows edge-to-edge, border-radius 0", { left: edge.left, rightAtVw: edge.rightAtVw, radiusZero: edge.radii.every((x) => x === "0px") }, { left: 0, rightAtVw: true, radiusZero: true }); }
  { const nested = await ph.$$eval(".gdo button button", (els) => els.length);
    (nested === 0) ? ok("phone: no nested buttons") : bad("phone nested buttons", `${nested}`); }
  { const small = await ph.evaluate(() => { const out = []; for (const el of document.querySelectorAll('.gdo button, .gdo [role="switch"]')) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || r.width === 0) continue; if (r.height < 30) out.push({ c: (el.className || "").toString().slice(0, 24), h: Math.round(r.height * 10) / 10 }); } return out; });
    small.length === 0 ? ok("phone: no tap target under 30px tall") : bad(`phone: ${small.length} under 30px`, JSON.stringify(small.slice(0, 6))); }

  // ══════════════ §11 — CONTRAST over every new element (incl. the marker states + min label) ══════════════
  { const c = await contrastIn(ph); c.failures.length === 0 ? ok(`phone contrast (MAIN): every board node >= 4.5:1 (min ${c.min})`) : bad(`phone contrast: ${c.failures.length} < 4.5`, c.failures.slice(0, 6).map((f) => `${f.ratio} "${f.t}" .${f.c}`).join(" | ")); }
  // and on the CANCELLED red background
  activeRaw = GRP;
  await ph.reload({ waitUntil: "domcontentloaded" });
  await ph.waitForSelector('[data-testid="snapshot"]'); await ph.waitForTimeout(200);
  { const c = await contrastIn(ph); c.failures.length === 0 ? ok(`phone contrast (cancelled row): every board node >= 4.5:1 (min ${c.min})`) : bad(`phone contrast cx: ${c.failures.length} < 4.5`, c.failures.slice(0, 6).map((f) => `${f.ratio} "${f.t}" .${f.c}`).join(" | ")); }
  { const sticky = await ph.$eval('[data-testid="snapshot"] .grouphd', (e) => getComputedStyle(e).position); (sticky === "sticky") ? ok("phone: group subheads are sticky") : bad("group head not sticky", sticky); }

  // the screen picker still replaces the tab strip
  await ph.click('[data-testid="screen-picker"]');
  await ph.waitForSelector('[data-testid="screen-sheet"]'); await ph.waitForTimeout(150);
  eq("phone: screen picker opens the sheet with Gameday Ops marked current", { open: !!(await ph.$('[data-testid="screen-sheet"]')), current: await ph.$eval('[data-testid="screen-dest-gameday"]', (e) => e.getAttribute("aria-current")) }, { open: true, current: "page" });

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
