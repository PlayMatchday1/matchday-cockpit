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
import { netRetry, installHarnessGuard, fatal, closeContext, closeBrowser, sessionFor } from "./_session.mjs";
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
  // ONE SESSION PER IDENTITY, cached across the whole gate run — see sessionFor in _session.mjs.
  const session = await sessionFor("rmancuso@playmatchday.com");
  const ref = new URL(url).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] };

  // ── THE ONE REAL WRITE IN THIS SUITE ────────────────────────────────────────────────────────
  // OpEx is the only Finance SECTION that accepts input (inline amount/date on a manual_entry
  // expense). The brief asks that entry on a FUTURE period saves and reads back, so this creates
  // its own row, drives the real UI, reads it back from the database and deletes it.
  //
  // fin_expenses feeds Cash Flow, OpEx and City P&L overhead — a leaked row would corrupt reported
  // money. So the row carries an unmistakable vendor, the sweep runs BEFORE the suite as well as
  // after (catching anything a crashed run left behind), and the delete sits in a finally.
  const MARK = "ZZ-E2E-PERIOD-DELETE-ME";
  const sweep = () => svc.from("fin_expenses").delete().eq("vendor", MARK);
  await sweep();

  const SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const nowD = new Date();
  const fut = new Date(nowD.getFullYear(), nowD.getMonth() + 2, 12); // two months out — unambiguously not started
  const futMonthKey = `${SHORT[fut.getMonth()]} ${fut.getFullYear()}`;
  const futUrlKey = `${fut.getFullYear()}-${String(fut.getMonth() + 1).padStart(2, "0")}`;
  const futDate = `${fut.getFullYear()}-${String(fut.getMonth() + 1).padStart(2, "0")}-12`;

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
  // WAIT FOR THE CONTROL TO ACTUALLY MOVE, never for a fixed delay. The first grain change after a
  // page load re-renders a full section, and a flat 700ms read the PREVIOUS label often enough to
  // fail one grain and pass the next — which looks like a logic bug in the quarter branch and is
  // not. aria-pressed flipping is the state change itself, so it is the right signal.
  const setGrain = async (g) => {
    await page.click(`[data-testid="period-grain-${g}"]`);
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("aria-pressed") === "true",
      `[data-testid="period-grain-${g}"]`, { timeout: 30000 });
    await page.waitForTimeout(120);
  };
  // Same rule for the stepper: wait for the label to leave the one we came from.
  const step = async (dir) => {
    const before = await page.$eval('[data-testid="period-label"]', (e) => e.textContent.trim());
    await page.click(`[data-testid="period-${dir === -1 ? "prev" : "next"}"]`);
    await page.waitForFunction(
      (prev) => document.querySelector('[data-testid="period-label"]')?.textContent?.trim() !== prev,
      before, { timeout: 30000 });
    await page.waitForTimeout(120);
    return before;
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
    // FORWARD IS NOT CAPPED — future periods carry entry surfaces (OpEx expenses, cash-flow
    // projections) and have to be reachable. The not-started chip, asserted below, is what keeps
    // an empty future period from reading as a closed one.
    eq(`${g}: the forward arrow is live`, b.nextDisabled, false);
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
    await step(-1);
    const b = await readBar();
    eq("stepping back leaves the current month", b.label !== labels.month, true);
    eq("…a closed period carries NO partial chip", b.partial, null);
    eq("…and its forward arrow is live", b.nextDisabled, false);
    // Back to now in one tap, which is what the jump button is for.
    await page.click('[data-testid="period-jump"]');
    await page.waitForFunction((want) => document.querySelector('[data-testid="period-label"]')?.textContent?.trim() === want,
      labels.month, { timeout: 30000 }).catch(() => {});
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
    eq("…and you can keep stepping forward from it", b.next, false);
  }

  // ── FORWARD IS NOT CAPPED ────────────────────────────────────────────────
  // Future periods have to be reachable: expenses and cash-flow projections are entered ahead of
  // time. The model does not end going forward, so nothing stops the arrow.
  console.log("\nyou can step forward from the current period at every grain:");
  for (const g of ["month", "quarter", "year"]) {
    await open();
    await setGrain(g);
    const before = await readBar();
    eq(`${g}: the forward arrow is live on the current period`, before.nextDisabled, false);
    await step(1);
    const after = await readBar();
    eq(`${g}: …stepping forward moves off ${before.label}`, after.label !== before.label, true);
    eq(`${g}: …the next period carries no PARTIAL chip`, after.partial, null);
    const future = await page.evaluate(() =>
      document.querySelector('[data-testid="period-future"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null);
    eq(`${g}: …it carries the NOT STARTED chip instead`, /Not started · 0 of \d+ days/.test(future ?? ""), true);
    // And you can keep going — no invented ceiling one step out.
    await step(1);
    eq(`${g}: …and forward again still works`, (await readBar()).label !== after.label, true);
  }

  // ── THE YEAR'S EXCLUSION SITS ON THE BAR ─────────────────────────────────
  console.log("\n'2026' is not 2026, and the bar says so where the year is read:");
  {
    await open();
    await setGrain("year");
    const r = await page.evaluate(() => {
      const om = document.querySelector('[data-testid="period-omitted"]');
      const lab = document.querySelector('[data-testid="period-label"]');
      if (!om || !lab) return { present: !!om, text: om?.textContent?.trim() ?? null, gap: null };
      // "Next to the year" is a geometric claim, so measure it: same row, and closer to the label
      // than the width of the bar. A footnote would fail both.
      const a = lab.getBoundingClientRect(), b = om.getBoundingClientRect();
      return {
        present: true,
        text: om.textContent.replace(/\s+/g, " ").trim(),
        sameRow: Math.abs(a.top - b.top) < 30,
        gap: Math.round(b.left - a.right),
      };
    });
    eq("the exclusion note is on the bar", r.present, true);
    if (r.present) {
      eq("…it names how many months and where the record starts", /\d+ months? before \w+ \d{4} not on record/.test(r.text), true);
      eq("…on the same row as the year label", r.sameRow, true);
      eq("…and adjacent to it, not at the far end", r.gap != null && r.gap < 320, true);
    }
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

  // ── ENTRY ON A FUTURE PERIOD ─────────────────────────────────────────────
  // A control that looks editable on a future period and will not save is worse than showing
  // nothing. This proves the whole path: the row renders, the affordance is live, the save lands
  // in the database, and the page reads it back.
  console.log(`\nOpEx accepts entry on a future period (${futMonthKey}):`);
  let expenseId = null;
  try {
    const { data: ins, error: insErr } = await svc.from("fin_expenses").insert({
      date: futDate, month: futMonthKey, city: "Austin", category: "Marketing",
      vendor: MARK, amount: 111, notes: "period-control e2e", manual_entry: true,
    }).select("id").maybeSingle();
    if (insErr) throw new Error(`fixture insert failed: ${insErr.message}`);
    expenseId = ins.id;

    await page.goto(`${BASE}/admin/finance/opex?p=${futUrlKey}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="finance-period-bar"]', { timeout: 120000 });
    const b = await readBar();
    eq("the future month is what the bar shows", b.label,
      `${["January","February","March","April","May","June","July","August","September","October","November","December"][fut.getMonth()]} ${fut.getFullYear()}`);
    eq("…and it is marked Not started, not closed", b.partial, null);

    // EXPAND THE CATEGORY FIRST. The calendar renders leaf rows only while their category group
    // is open (`{opened && group.rows.map(...)}`), so the chip is in the DOM but unrendered until
    // the header is clicked. Waiting for it without expanding times out against a page that is
    // working perfectly.
    await page.waitForSelector("tr.ox-cat", { timeout: 60000 });
    const chipSel = `[data-testid="opex-amount-chip"][data-expense-id="${expenseId}"]`;
    for (const row of await page.$$("tr.ox-cat")) {
      if (await page.$(chipSel)) break;
      await row.click();
      await page.waitForTimeout(250);
    }
    // The chip is the edit affordance. It exists only when the row is editable, so its presence
    // IS the "this will accept input" claim being tested.
    const chip = page.locator(chipSel);
    await chip.waitFor({ state: "visible", timeout: 60000 });
    ok("the expense renders on the future month with a live edit affordance");

    await chip.click();
    await page.waitForSelector('[data-testid="opex-edit-row"]', { timeout: 30000 });
    await page.fill('[data-testid="opex-amount-input"]', "222.50");
    await page.click('[data-testid="opex-save"]');
    // The editor unmounts on success — that is the page's own signal that the write landed.
    await page.waitForSelector('[data-testid="opex-edit-row"]', { state: "detached", timeout: 45000 });

    // READ BACK FROM THE DATABASE, not from the screen. A 2xx is not proof, and neither is a
    // re-render of optimistic state.
    const { data: after } = await svc.from("fin_expenses").select("amount, month").eq("id", expenseId).maybeSingle();
    eq("the value SAVED on a future period", Number(after?.amount), 222.5);
    eq("…and stayed in the future month", after?.month, futMonthKey);

    // And the page shows it back.
    const shown = await page.locator(`[data-testid="opex-amount-chip"][data-expense-id="${expenseId}"]`)
      .textContent().catch(() => null);
    eq("…and the page reads it back", /222/.test(shown ?? ""), true);
  } catch (e) {
    bad("OpEx entry on a future period", e.message.split("\n")[0].slice(0, 140));
  } finally {
    await sweep();
    const { data: left } = await svc.from("fin_expenses").select("id").eq("vendor", MARK);
    eq("the test expense is removed", (left ?? []).length, 0);
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
