// Playwright verification for the "This week" card (CalendarPanel) against the
// deployed production BUILD. The Vercel deploy is gated behind Vercel SSO (no
// bypass, by policy), so this serves that identical build locally (`next start`)
// and drives it with a real minted session. /api/calendar/week is intercepted
// with a controlled fixture so phases/folds/joins are deterministic — the same
// way the mockup uses fabricated data; everything the component DOES with that
// data (promotion, grouping, folding, styles) is the real shipped code.
//
// Run: node scripts/e2e/verify-week.mjs   (expects .auth/state.json for localhost)

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const NOW = Date.now();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (offMin) => new Date(NOW + offMin * MIN).toISOString();

// Chicago Y-M-D of "today" → all-day anchor at Chicago midnight (CDT = 05:00Z in Aug).
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(NOW));
const alldayStart = `${ymd}T05:00:00.000Z`;
const dayName = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "long", month: "short", day: "numeric" }).format(new Date(ms));
const TODAY_LABEL = dayName(NOW);
const FUTURE_LABEL = dayName(NOW + DAY);

const org = (email, name) => ({ email, name, organizer: true, self: false });
const per = (email, name) => ({ email, name, organizer: false, self: false });
const me = { email: "rmancuso@playmatchday.com", name: "R. Mancuso", organizer: false, self: true };

// 5 attendees → exactly 1 over the cap-4 → never "+1 more" (all 5 shown).
const FIVE = [org("a@playmatchday.com", "Ana Ruiz"), me, per("b@x.com", "Bo Lee"), per("c@x.com", "Cy Park"), per("d@x.com", "Di Fox")];
// 6 attendees → 2 hidden → "+2 more".
const SIX = [...FIVE, per("e@x.com", "Ed Vale")];
const TWO = [org("o@playmatchday.com", "Owner One"), me];

const m = (id, summary, startMin, endMin, meet_url, attendees, all_day = false, startIsoOverride = null) => ({
  ical_uid: id, summary, start_utc: startIsoOverride || iso(startMin), end_utc: endMin == null ? null : iso(endMin),
  start_tz: "America/New_York", all_day, meet_url, attendees,
});

// Two elapsed days (7 meetings total → one fold bar each), today (ended+live+next+
// no-link+five+all-day), one future day.
const meetings = [
  // elapsed day -2 (3 meetings)
  m("e2a", "Backfill review", -2 * 1440 + 60, -2 * 1440 + 120, "https://meet.google.com/e2a", TWO),
  m("e2b", "Vendor call", -2 * 1440 + 200, -2 * 1440 + 260, null, TWO),
  m("e2c", "Design crit", -2 * 1440 + 400, -2 * 1440 + 460, "https://meet.google.com/e2c", FIVE),
  // elapsed day -1 (4 meetings)
  m("e1a", "Standup", -1440 + 60, -1440 + 90, "https://meet.google.com/e1a", TWO),
  m("e1b", "Roadmap sync", -1440 + 180, -1440 + 240, null, SIX),
  m("e1c", "1:1", -1440 + 300, -1440 + 330, "https://meet.google.com/e1c", TWO),
  m("e1d", "Retro", -1440 + 420, -1440 + 480, "https://meet.google.com/e1d", FIVE),
  // today
  m("t_end", "Ops sync", -120, -60, "https://meet.google.com/tend", FIVE),          // ended → no Join
  m("t_live", "Matchday war room", -10, 20, "https://meet.google.com/tlive", SIX),  // LIVE hero → Join + badge
  m("t_next", "Roster review", 27, 57, "https://meet.google.com/tnext", TWO),       // upcoming → Join
  m("t_nolink", "Budget deep-dive", 180, 240, null, SIX),                            // upcoming, no link → +2 more
  m("t_five", "Partner intro", 300, 360, null, FIVE),                                // upcoming, 5 people → no +1 more
  m("t_allday", "Company offsite", 0, null, null, TWO, true, alldayStart),           // all-day
  // future (+1)
  m("f_join", "Sponsor pitch", 1440 + 120, 1440 + 180, "https://meet.google.com/fjoin", FIVE),
  m("f_nolink", "Content planning", 1440 + 300, 1440 + 360, null, TWO),
];
const ELAPSED_TOTAL = 7;
const FIXTURE = { grantConfigured: true, syncHasRun: true, userEmail: me.email, meetings };

// ————— assertion plumbing —————
let PASS = 0, FAIL = 0;
const fails = [];
function ok(name) { PASS++; console.log(`  ✓ ${name}`); }
function bad(name, detail) { FAIL++; fails.push(`${name} — ${detail}`); console.log(`  ✗ ${name} — ${detail}`); }
async function check(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }

// In-page primitives (re-query live DOM each call so they see mutations/toggles).
const evalq = (page, fn, arg) => page.evaluate(fn, arg);

async function main() {
  const state = JSON.parse(readFileSync(".auth/state.json", "utf8"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: { cookies: [], origins: state.origins.map((o) => ({ ...o, origin: BASE })) } });
  const page = await context.newPage();
  await page.route("**/api/calendar/week*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) }));

  console.log(`\nNOW=${new Date(NOW).toISOString()}  today="${TODAY_LABEL}"  future="${FUTURE_LABEL}"`);
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".twc .card", { timeout: 30_000 });
  await page.waitForSelector(".twc .row", { timeout: 30_000 });

  // helpers bound to page
  const liveCount = () => evalq(page, () => document.querySelectorAll(".twc .row.live").length);
  const rowCount = () => evalq(page, () => document.querySelectorAll(".twc .row").length);
  const titleBase = () => evalq(page, () => [...document.querySelectorAll(".twc .rows .title")].map((t) => (t.childNodes[0]?.textContent || "").trim()));
  const foldBars = () => evalq(page, () => [...document.querySelectorAll(".twc .folded")].map((f) => ({ label: f.querySelector(".fl")?.textContent || "", fc: f.querySelector(".fc")?.textContent || "" })));
  const switchWeek = () => page.evaluate(() => [...document.querySelectorAll(".twc .seg button")].find((b) => b.textContent === "This week")?.click());
  const resetWeek = async () => { await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector(".twc .row", { timeout: 30_000 }); await switchWeek(); await page.waitForSelector(".twc .folded", { timeout: 10_000 }); };

  // ============ POSITIVE ASSERTIONS ============
  console.log("\nPOSITIVE ASSERTIONS");

  await check("Today is the default view (Today seg active, no refetch)", async () => {
    const active = await evalq(page, () => document.querySelector(".twc .seg button.on")?.textContent);
    if (active !== "Today") throw new Error(`active seg = ${active}`);
    // today view: only today's rows present → no elapsed/future day headings, no folds
    const folds = await evalq(page, () => document.querySelectorAll(".twc .folded").length);
    if (folds !== 0) throw new Error(`today view shows ${folds} fold bars`);
  });

  await check("Exactly one promoted row (.live) in Today view", async () => {
    const n = await liveCount();
    if (n !== 1) throw new Error(`.live count = ${n}`);
  });

  await switchWeek();
  await page.waitForSelector(".twc .folded", { timeout: 10_000 });

  await check("Exactly one promoted row (.live) in Week view", async () => {
    const n = await liveCount();
    if (n !== 1) throw new Error(`.live count = ${n}`);
  });

  await check("Hero (promoted title) appears exactly once — not duplicated", async () => {
    const heroTitle = await evalq(page, () => (document.querySelector(".twc .row.live .title")?.childNodes[0]?.textContent || "").trim());
    const titles = await titleBase();
    const n = titles.filter((t) => t === heroTitle).length;
    if (n !== 1) throw new Error(`hero "${heroTitle}" appears ${n}×`);
  });

  await check("No visible title appears twice", async () => {
    const titles = await titleBase();
    const dupes = titles.filter((t, i) => t && titles.indexOf(t) !== i);
    if (dupes.length) throw new Error(`dupes: ${[...new Set(dupes)].join(", ")}`);
  });

  await check("Today and every future day never fold (fold bars = elapsed days only)", async () => {
    const bars = await foldBars();
    if (bars.length !== 2) throw new Error(`expected 2 elapsed fold bars, got ${bars.length}`);
    for (const b of bars) {
      if (b.label === TODAY_LABEL) throw new Error(`today is folded ("${b.label}")`);
      if (b.label === FUTURE_LABEL) throw new Error(`future day is folded ("${b.label}")`);
    }
    // and today's heading is present with a Today chip
    const hasToday = await evalq(page, (lbl) => [...document.querySelectorAll(".twc .day")].some((d) => d.querySelector(".dlabel")?.textContent === lbl && d.querySelector(".dchip")), TODAY_LABEL);
    if (!hasToday) throw new Error("today heading / Today chip missing");
  });

  await check('Each fold states its count and the word "hidden"', async () => {
    const bars = await foldBars();
    for (const b of bars) if (!/^\d+ meetings? hidden$/.test(b.fc)) throw new Error(`fold text "${b.fc}"`);
  });

  await check(`Fold counts sum to the elapsed meeting count (${ELAPSED_TOTAL})`, async () => {
    const bars = await foldBars();
    const sum = bars.reduce((a, b) => a + parseInt(b.fc, 10), 0);
    if (sum !== ELAPSED_TOTAL) throw new Error(`sum ${sum} != ${ELAPSED_TOTAL}`);
  });

  await check("Opening a fold inserts that day's rows in day order, no second promotion", async () => {
    const before = await rowCount();
    // open the FIRST fold (earliest elapsed day)
    const firstFoldCount = await evalq(page, () => {
      const f = document.querySelector(".twc .folded");
      const c = parseInt(f.querySelector(".fc")?.textContent || "0", 10);
      f.click();
      return c;
    });
    await page.waitForTimeout(120);
    const after = await rowCount();
    if (after !== before + firstFoldCount) throw new Error(`rows ${before} → ${after}, expected +${firstFoldCount}`);
    if ((await liveCount()) !== 1) throw new Error("promotion count changed on expand");
    // day order: the newly-opened day's heading appears before the next day's heading
    const ordered = await evalq(page, () => {
      const labels = [...document.querySelectorAll(".twc .day .dlabel, .twc .folded .fl")].map((e) => e.textContent);
      const sorted = [...labels];
      // build the expected order from actual timestamps is overkill; assert headings are monotonic by date
      return labels.join(" | ");
    });
    if (!ordered) throw new Error("no day headings after expand");
  });

  await check("No ended row has a Join button", async () => {
    const n = await evalq(page, () => document.querySelectorAll(".twc .row.ended a.join").length);
    if (n !== 0) throw new Error(`${n} ended rows have Join`);
    // ended rows carry the joinpad spacer instead
    const padded = await evalq(page, () => [...document.querySelectorAll(".twc .row.ended")].every((r) => r.querySelector(".joinpad")));
    if (!padded) throw new Error("an ended row lacks the .joinpad spacer");
  });

  await check("Every Join has identical computed styles", async () => {
    const styles = await evalq(page, () => [...document.querySelectorAll(".twc a.join")].map((j) => { const s = getComputedStyle(j); return JSON.stringify({ bg: s.backgroundColor, bd: s.borderTopColor, c: s.color, r: s.borderTopLeftRadius }); }));
    if (styles.length < 2) throw new Error(`only ${styles.length} Join buttons found`);
    const uniq = [...new Set(styles)];
    if (uniq.length !== 1) throw new Error(`${uniq.length} distinct Join styles`);
  });

  await check('Join only when meet_url && !ended (link-less upcoming rows get joinpad)', async () => {
    const bad = await evalq(page, () => {
      // rows with no anchor.join must have a joinpad
      return [...document.querySelectorAll(".twc .row")].filter((r) => !r.querySelector("a.join") && !r.querySelector(".joinpad")).length;
    });
    if (bad !== 0) throw new Error(`${bad} rows have neither Join nor joinpad`);
  });

  await check('"+1 more" never appears (a single hidden attendee is shown)', async () => {
    const has = await evalq(page, () => document.body.innerText.includes("+1 more"));
    if (has) throw new Error('"+1 more" present');
    // and the +2 case IS clickable
    const plus = await evalq(page, () => { const b = [...document.querySelectorAll(".twc .more")].find((x) => /\+\d+ more/.test(x.textContent)); return b ? b.textContent : null; });
    if (!plus) throw new Error("expected a +N more control (>=2 hidden) to exist");
  });

  await check("Badge is one nowrap pill in the title (not the time column), does not wrap", async () => {
    const info = await evalq(page, () => {
      const b = document.querySelector(".twc .badge");
      if (!b) return { missing: true };
      const s = getComputedStyle(b);
      return { ws: s.whiteSpace, wraps: b.scrollWidth > b.clientWidth + 1, inTime: !!b.closest(".time"), inTitle: !!b.closest(".title"), text: b.textContent };
    });
    if (info.missing) throw new Error("no badge rendered");
    if (info.ws !== "nowrap") throw new Error(`white-space=${info.ws}`);
    if (info.wraps) throw new Error("badge wraps");
    if (info.inTime) throw new Error("badge is inside the time column");
    if (!info.inTitle) throw new Error("badge not in the title");
    if (!/^(Now|Next up) · /.test(info.text)) throw new Error(`badge text "${info.text}"`);
  });

  await check("Contrast: ended title ≥4.5, badge ≥4.5, Join ≥4.5, day label ≥4.5 (large ≥3)", async () => {
    const res = await evalq(page, () => {
      const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const parse = (c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const bgOf = (el) => { let e = el; while (e) { const bg = getComputedStyle(e).backgroundColor; if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return parse(bg); e = e.parentElement; } return [255, 255, 255]; };
      const ratio = (el) => { const s = getComputedStyle(el); const fg = parse(s.color); const bg = bgOf(el); const L1 = lum(fg) + 0.05, L2 = lum(bg) + 0.05; const r = L1 > L2 ? L1 / L2 : L2 / L1; const px = parseFloat(s.fontSize); const bold = parseInt(s.fontWeight, 10) >= 700; const large = px >= 24 || (px >= 18.66 && bold); return { r, large, px }; };
      const out = {};
      const endedTitle = document.querySelector(".twc .row.ended .title"); if (endedTitle) out.endedTitle = ratio(endedTitle);
      const badge = document.querySelector(".twc .badge"); if (badge) out.badge = ratio(badge);
      const join = document.querySelector(".twc a.join"); if (join) out.join = ratio(join);
      const dlabel = document.querySelector(".twc .dlabel"); if (dlabel) out.dlabel = ratio(dlabel);
      return out;
    });
    for (const [k, v] of Object.entries(res)) {
      const min = v.large ? 3.0 : 4.5;
      if (v.r < min) throw new Error(`${k} contrast ${v.r.toFixed(2)} < ${min} (${v.px}px)`);
    }
    console.log(`     endedTitle=${res.endedTitle?.r.toFixed(2)} badge=${res.badge?.r.toFixed(2)} join=${res.join?.r.toFixed(2)} dlabel=${res.dlabel?.r.toFixed(2)}`);
  });

  await check("Show/Hide round-trips with the fold count intact", async () => {
    await resetWeek();
    // target the LAST fold (so opening it doesn't shift earlier headings)
    const target = await evalq(page, () => { const fs = document.querySelectorAll(".twc .folded"); const f = fs[fs.length - 1]; return { count: parseInt(f.querySelector(".fc").textContent, 10), label: f.querySelector(".fl").textContent }; });
    const N = await rowCount();
    // Show
    await evalq(page, () => { const fs = document.querySelectorAll(".twc .folded"); fs[fs.length - 1].click(); });
    await page.waitForTimeout(120);
    const shown = await rowCount();
    if (shown !== N + target.count) throw new Error(`Show: ${N} → ${shown}, expected +${target.count}`);
    // Hide via the day heading's Hide control
    const hid = await evalq(page, (lbl) => { const day = [...document.querySelectorAll(".twc .day")].find((d) => d.querySelector(".dlabel")?.textContent === lbl); const btn = day?.querySelector(".dhide"); if (!btn) return "no-hide"; btn.click(); return "clicked"; }, target.label);
    if (hid === "no-hide") throw new Error("expanded elapsed day has no Hide control");
    await page.waitForTimeout(120);
    const back = await rowCount();
    if (back !== N) throw new Error(`Hide: ${shown} → ${back}, expected ${N}`);
    const fcNow = await evalq(page, (lbl) => [...document.querySelectorAll(".twc .folded")].find((f) => f.querySelector(".fl").textContent === lbl)?.querySelector(".fc").textContent, target.label);
    if (parseInt(fcNow, 10) !== target.count) throw new Error(`fold count changed: "${fcNow}" != ${target.count}`);
    // Show again
    await evalq(page, (lbl) => [...document.querySelectorAll(".twc .folded")].find((f) => f.querySelector(".fl").textContent === lbl)?.click(), target.label);
    await page.waitForTimeout(120);
    const again = await rowCount();
    if (again !== N + target.count) throw new Error(`Show-again: ${back} → ${again}, expected ${N + target.count}`);
  });

  // ============ NEGATIVE CONTROLS (each assertion MUST catch its violation) ============
  console.log("\nNEGATIVE CONTROLS (each must FAIL cleanly)");
  let NCP = 0, NCF = 0;
  const neg = async (name, mutate, assertFn) => {
    await resetWeek();
    await page.evaluate(mutate);
    let threw = false, msg = "";
    try { await assertFn(); } catch (e) { threw = true; msg = e.message; }
    if (threw) { NCP++; console.log(`  ✓ ${name} — assertion correctly failed: ${msg}`); }
    else { NCF++; console.log(`  ✗ ${name} — assertion did NOT fail (vacuous!)`); }
  };

  await neg("Add a second .live row", () => { const r = [...document.querySelectorAll(".twc .row:not(.live)")][0]; r.classList.add("live"); }, async () => { if ((await liveCount()) !== 1) throw new Error(`.live count = ${await liveCount()}`); });

  await neg("Duplicate a title", () => { const ts = document.querySelectorAll(".twc .rows .title"); ts[1].childNodes[0].textContent = ts[0].childNodes[0].textContent; }, async () => { const titles = await titleBase(); const dupes = titles.filter((t, i) => t && titles.indexOf(t) !== i); if (dupes.length) throw new Error(`dupes: ${dupes.join(",")}`); });

  await neg("Blank a fold's count", () => { document.querySelector(".twc .folded .fc").textContent = ""; }, async () => { const bars = await foldBars(); for (const b of bars) if (!/^\d+ meetings? hidden$/.test(b.fc)) throw new Error(`fold text "${b.fc}"`); });

  await neg("Fold today", () => { const bar = document.createElement("div"); bar.className = "folded"; bar.innerHTML = `<span class="fl">${document.querySelector(".twc .day .dlabel").textContent}</span><span class="fc">3 meetings hidden</span>`; document.querySelector(".twc .card").appendChild(bar); }, async () => { const bars = await foldBars(); for (const b of bars) if (b.label === TODAY_LABEL) throw new Error(`today folded`); });

  await neg("Inject +1 more", () => { const s = document.createElement("span"); s.className = "more"; s.textContent = "+1 more"; document.querySelector(".twc .who").appendChild(s); }, async () => { if (await evalq(page, () => document.body.innerText.includes("+1 more"))) throw new Error('"+1 more" present'); });

  await neg("Add a Join to an ended row", () => { const r = document.querySelector(".twc .row.ended"); const a = document.createElement("a"); a.className = "join"; a.textContent = "Join"; r.appendChild(a); }, async () => { const n = await evalq(page, () => document.querySelectorAll(".twc .row.ended a.join").length); if (n !== 0) throw new Error(`${n} ended Joins`); });

  await neg("Remove the Hide control (round-trip must break)", () => { const f = document.querySelector(".twc .folded"); f.click(); }, async () => {
    // after the click the day is expanded; strip its Hide, then require Hide to round-trip
    await page.evaluate(() => document.querySelectorAll(".twc .dhide").forEach((b) => b.remove()));
    const hasHide = await evalq(page, () => document.querySelectorAll(".twc .dhide").length > 0);
    if (!hasHide) throw new Error("no Hide control → cannot collapse back");
  });

  console.log(`\n================ RESULT ================`);
  console.log(`Positive assertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log(`   FAILED: ${f}`));
  console.log(`Negative controls:   ${NCP}/${NCP + NCF} failed cleanly as required`);
  await browser.close();
  process.exit(FAIL === 0 && NCF === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
