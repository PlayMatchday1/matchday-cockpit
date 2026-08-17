// THE FINANCE PERIOD CONTROL — one control, three grains, read by every section.
//
// It replaced TWO controls doing one job: a QUARTER dropdown in the page frame and a MONTH segment
// inside the City P&L card that could only offer that quarter's three months. Both must be gone,
// and this suite fails if either comes back.
//
// THE ASSERTIONS THAT MATTER MOST are the ones about the partial chip, because it is the whole
// reason the control is safe to give someone. Stepping August → July is one click, and that is 17
// days against 31. Each grain must state ITS OWN denominator — borrowing one figure across grains
// would look precise and be wrong — and a CLOSED period must carry no chip at all, because the
// absence of the mark is what says the number is final.
//
// GRAIN CHANGE IS A ZOOM, NOT A JUMP: August 2026 widens to Q3 2026 and to 2026, and narrowing
// returns to August. Asserted as a round trip, since only the round trip catches an anchor being
// derived from the period's start (which lands on January).
//
//   node scripts/e2e/verify-finance-period.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, closeContext, closeBrowser } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// Which grains each section can honour, and therefore which of its buttons must be dead.
const SECTIONS = [
  ["/admin/finance/cities",        ["Month", "Quarter", "Year"]],
  ["/admin/finance/revenue",       ["Month", "Quarter", "Year"]],
  ["/admin/finance/cost",          ["Month", "Quarter", "Year"]],
  ["/admin/finance/cash-flow",     ["Quarter"]],
  ["/admin/finance/opex",          ["Month"]],
  ["/admin/finance/field-ranking", ["Month", "Quarter"]],
];

async function main() {
  process.loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(url).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1200 }, storageState });
  const page = await ctx.newPage();

  // READY = the bar is up. Every check below is about the bar, so this is the right signal; the
  // section's own data can still be loading and none of these assertions depend on it.
  const open = async (path = "/admin/finance/cities") => {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="finance-period-bar"]', { timeout: 120000 });
    await page.waitForTimeout(250);
  };
  const readBar = () => page.evaluate(() => {
    const btn = (t) => document.querySelector(`[data-testid="${t}"]`);
    return {
      label: document.querySelector('[data-testid="period-label"]')?.textContent?.trim() ?? null,
      grains: [...document.querySelectorAll('[data-testid^="period-grain-"]')].map((b) => ({
        name: b.textContent.trim(), on: b.getAttribute("aria-pressed") === "true", off: b.disabled,
      })),
      partial: document.querySelector('[data-testid="period-partial"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      nextDisabled: btn("period-next")?.disabled ?? null,
      prevDisabled: btn("period-prev")?.disabled ?? null,
      jump: btn("period-jump")?.textContent?.trim() ?? null,
    };
  });
  const setGrain = async (g) => {
    await page.click(`[data-testid="period-grain-${g}"]`);
    await page.waitForTimeout(700);
  };

  console.log("finance — the period control\n");
  await open();

  // ── SHAPE + DEFAULT ──────────────────────────────────────────────────────
  console.log("the control:");
  {
    const b = await readBar();
    eq("exactly Month, Quarter, Year", b.grains.map((g) => g.name), ["Month", "Quarter", "Year"]);
    eq("…with exactly one selected", b.grains.filter((g) => g.on).length, 1);
    eq("the default grain is Month", b.grains.find((g) => g.on)?.name, "Month");
    // The default is the CURRENT month — the question being asked nine times out of ten. Computed
    // here from the clock rather than hardcoded, so the assertion survives the month turning over.
    const nowLabel = await page.evaluate(() => {
      const d = new Date();
      return `${["January","February","March","April","May","June","July","August","September","October","November","December"][d.getMonth()]} ${d.getFullYear()}`;
    });
    eq("…and the default period is the current month", b.label, nowLabel);
    eq("the jump button names the active grain", b.jump, "This month");
  }

  console.log("\nthe old controls are gone:");
  {
    const g = await page.evaluate(() => ({
      quarterSelect: [...document.querySelectorAll("select")].some((x) => /quarter/i.test(x.getAttribute("aria-label") ?? "")),
      quarterWord: /\bQUARTER\b/.test(document.body.innerText),
      inCardMonth: !!document.querySelector('[role="group"][aria-label="Month"]'),
    }));
    eq("the page-level QUARTER dropdown is gone", [g.quarterSelect, g.quarterWord], [false, false]);
    eq("the in-card MONTH segment is gone", g.inCardMonth, false);
  }

  // ── THE LABEL MATCHES THE GRAIN ──────────────────────────────────────────
  console.log("\nthe label matches the grain:");
  const labels = {};
  for (const [g, re] of [["month", /^[A-Z][a-z]+ \d{4}$/], ["quarter", /^Q[1-4] \d{4}$/], ["year", /^\d{4}$/]]) {
    await setGrain(g);
    const b = await readBar();
    labels[g] = b.label;
    eq(`${g}: "${b.label}" matches its grain`, re.test(b.label ?? ""), true);
  }

  // ── GRAIN CHANGE IS A ZOOM ───────────────────────────────────────────────
  console.log("\nchanging grain keeps the point in time:");
  {
    // The month we started on must sit inside the quarter, and inside the year.
    const mi = MONTHS.indexOf(labels.month.split(" ")[0]);
    const yr = labels.month.split(" ")[1];
    eq(`${labels.month} is inside ${labels.quarter}`,
      labels.quarter, `Q${Math.floor(mi / 3) + 1} ${yr}`);
    eq(`…and inside ${labels.year}`, labels.year, yr);
    // ROUND TRIP: only this catches an anchor derived from the period's start, which would land
    // on January rather than back on the month we came from.
    await setGrain("month");
    eq("…and narrowing returns to the same month", (await readBar()).label, labels.month);
  }

  // ── THE PARTIAL CHIP ─────────────────────────────────────────────────────
  console.log("\nthe current period is partial at every grain, with its OWN denominator:");
  const denominators = [];
  for (const g of ["month", "quarter", "year"]) {
    await setGrain(g);
    const b = await readBar();
    eq(`${g}: shows a partial chip`, /Partial ·/.test(b.partial ?? ""), true);
    const m = (b.partial ?? "").match(/(\d+) of (\d+) days/);
    eq(`${g}: …stating elapsed of total`, !!m, true);
    if (m) denominators.push({ g, elapsed: +m[1], total: +m[2] });
    // THE FORWARD ARROW IS DEAD ON THE CURRENT PERIOD at every grain.
    eq(`${g}: the forward arrow is disabled`, b.nextDisabled, true);
  }
  {
    const totals = denominators.map((d) => d.total);
    eq("the three denominators are all different", new Set(totals).size, 3);
    // Each is its own grain's length, not a borrowed figure: a month is 28–31, a quarter 90–92,
    // a year 365–366.
    const byG = Object.fromEntries(denominators.map((d) => [d.g, d]));
    eq("…month is a month's length", byG.month.total >= 28 && byG.month.total <= 31, true);
    eq("…quarter is a quarter's length", byG.quarter.total >= 89 && byG.quarter.total <= 92, true);
    eq("…year is a year's length", byG.year.total === 365 || byG.year.total === 366, true);
    eq("…and elapsed is inside total at every grain",
      denominators.every((d) => d.elapsed >= 1 && d.elapsed <= d.total), true);
  }

  // ── A CLOSED PERIOD ──────────────────────────────────────────────────────
  console.log("\na closed period is final, and says so by saying nothing:");
  {
    await setGrain("month");
    await page.click('[data-testid="period-prev"]');
    await page.waitForTimeout(700);
    const b = await readBar();
    eq("stepping back leaves the current month", b.label !== labels.month, true);
    eq("…a closed period carries NO partial chip", b.partial, null);
    eq("…and its forward arrow is live", b.nextDisabled, false);
    // Back to now in one tap, which is what the jump button is for.
    await page.click('[data-testid="period-jump"]');
    await page.waitForTimeout(700);
    eq("the jump button returns to the current period", (await readBar()).label, labels.month);
  }

  // ── A FUTURE PERIOD ──────────────────────────────────────────────────────
  // Reachable by URL only. It must NOT look closed: a closed period carries no chip, and that
  // absence is this design's signal that the numbers are final. A period that has not started
  // would otherwise borrow that meaning.
  console.log("\na period that has not started is marked apart from a closed one:");
  {
    const yr = new Date().getFullYear();
    await page.goto(`${BASE}/admin/finance/cities?p=${yr + 1}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="finance-period-bar"]', { timeout: 120000 });
    await page.waitForTimeout(400);
    const b = await page.evaluate(() => ({
      label: document.querySelector('[data-testid="period-label"]')?.textContent?.trim(),
      partial: !!document.querySelector('[data-testid="period-partial"]'),
      future: document.querySelector('[data-testid="period-future"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      next: document.querySelector('[data-testid="period-next"]')?.disabled,
    }));
    eq("a future year renders", b.label, String(yr + 1));
    eq("…it does NOT carry the partial chip", b.partial, false);
    eq("…it carries a not-started mark instead", /Not started/.test(b.future ?? ""), true);
    eq("…stating zero elapsed", /0 of \d+ days/.test(b.future ?? ""), true);
    eq("…and its forward arrow stays dead", b.next, true);
  }

  // ── PER-SECTION GRAINS ───────────────────────────────────────────────────
  // A section that cannot render a grain must DISABLE it with the reason on the control. Silently
  // ignoring the selection is the failure this codebase bans.
  console.log("\nevery section states which grains it can honour:");
  for (const [path, supported] of SECTIONS) {
    await open(path);
    const b = await readBar();
    const live = b.grains.filter((g) => !g.off).map((g) => g.name);
    eq(`${path}: offers ${supported.join("/")}`, live, supported);
    const offOnes = b.grains.filter((g) => g.off);
    if (offOnes.length) {
      const titled = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="period-grain-"]')]
          .filter((x) => x.disabled).every((x) => (x.title ?? "").length > 20));
      eq(`${path}: …and each disabled grain says why`, titled, true);
    }
    // Whatever grain it lands on must be one it supports — never a window it will ignore.
    eq(`${path}: …and the selected grain is one of them`,
      supported.includes(b.grains.find((g) => g.on)?.name ?? ""), true);
  }

  // ── MOBILE ───────────────────────────────────────────────────────────────
  console.log("\nphone 390 — the bar wraps, both controls stay reachable:");
  {
    await page.setViewportSize({ width: 390, height: 900 });
    await open();
    const r = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="finance-period-bar"]');
      const grain = document.querySelector('[data-testid="period-grain-month"]');
      const step = document.querySelector('[data-testid="period-prev"]');
      const seen = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right <= window.innerWidth + 1 && b.left >= -1; };
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        barWraps: bar.getBoundingClientRect().height > 60, // more than one row
        grainReachable: seen(grain),
        stepReachable: seen(step),
        small: [...new Set([...bar.querySelectorAll("button:not([disabled])")]
          .filter((b) => { const x = b.getBoundingClientRect(); return x.width > 0 && Math.min(x.width, x.height) < 36; })
          .map((b) => b.textContent.trim().slice(0, 16)))],
      };
    });
    eq("390: the page does not scroll sideways", r.overflow, false);
    eq("390: the bar wraps to more than one row", r.barWraps, true);
    eq("390: the grain control is fully on screen", r.grainReachable, true);
    eq("390: the stepper is fully on screen", r.stepReachable, true);
    eq("390: every enabled control in the bar clears 36px", r.small, []);
    await page.setViewportSize({ width: 1560, height: 1200 });
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeContext(ctx);
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
