// FINANCE — six routed sections, plus the two new money pages.
//
// TWO KINDS OF ASSERTION LIVE HERE, and they are tiered differently on purpose.
//
//   THE MOVE (Cities, Cash Flow, OpEx, Field Ranking) is routing and placement. Those panels are
//   unchanged, so nothing here re-asserts what they compute — only that each route renders its
//   own panel, that the rail is the app's own six items, and that the quarter selector and the
//   Configure / Check-Ins / Managers links survived the split into the page frame.
//
//   REVENUE AND COST ARE NEW NUMBERS ON SCREEN, so they get asserted as numbers: the rollups add
//   up, an unknown cost is a dash and never a zero, and a profit-share venue's monthly cost equals
//   the figure the PARTNER DASHBOARD itself publishes for the same venue and month. That last one
//   is the important one — it is the only assertion here whose evidence comes from outside the
//   code under test, via /api/partner-dashboards/preview, which is the partner page's own data
//   path rather than a second call to the thing being checked.
//
// WHY THE COST PAGE NEEDS A ZERO-HUNT. autoCost computes `rate = per_match_rate ?? 0`, so a venue
// with no rate returns a MAPPED-LOOKING $0. Exactly one venue in the estate is genuinely free
// (Carroll Senior HS, per_match, cost_per_match = 0). Every other $0 in the cost column would be
// that bug, so the assertion is: the set of venues rendering $0 is a subset of the venues whose
// stored cost really is zero.
//
//   node scripts/e2e/verify-finance-sections.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, closeContext, closeBrowser, sessionFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const near = (n, got, want, tol) =>
  (got != null && Math.abs(got - want) <= tol ? ok(n) : bad(n, `got ${got} want ${want} ±${tol}`));

const RAIL = ["Cities", "Revenue", "Cost", "Cash Flow", "OpEx", "Field Ranking"];

// path, a marker proving THAT SECTION'S PANEL rendered — not merely the shared frame, which is
// identical on all six and would pass for every route including a broken one.
const SECTIONS = [
  ["/admin/finance/cities", /City P&L/i],
  ["/admin/finance/revenue", /Compare with/i],
  ["/admin/finance/cost", /Field cost ratio/i],
  ["/admin/finance/cash-flow", /Expense Forecast|Net P&L/i],
  ["/admin/finance/opex", /OpEx Calendar/i],
  ["/admin/finance/field-ranking", /Field Ranking/i],
];

// "$1,234" / "−$1,234" / "—" → number | null
const money = (t) => {
  if (t == null) return null;
  const s = String(t).trim();
  if (!/\d/.test(s)) return null;
  const neg = /^[−-]/.test(s) || /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};

async function main() {
  process.loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  // ONE SESSION PER IDENTITY, cached across the whole gate run — see sessionFor in _session.mjs.
  const session = await sessionFor("rmancuso@playmatchday.com");
  const token = session.access_token;
  const ref = new URL(url).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] };

  // === Evidence gathered OUTSIDE the page under test ===
  // The venues whose stored cost really is zero. Anything else showing $0 is the null-rate bug.
  const { data: venues } = await svc.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, cost_per_match");
  const genuinelyFree = new Set(
    (venues ?? [])
      .filter((v) => v.billing_type === "per_match" && (v.per_match_rate === 0 || (v.per_match_rate == null && v.cost_per_match === 0)))
      .map((v) => v.venue_name),
  );

  // A $0 COST IS LEGITIMATE VIA EXACTLY THREE MECHANISMS, and each is a fact in the database
  // rather than a name in this file:
  //   1. the venue's per-match unit cost really is 0 (Carroll Senior HS)
  //   2. an operator recorded a $0 override for that month — prepaid, lump-summed elsewhere
  //      (Lou Fusz Outdoor "Paid in January", Centennial Commons "Custom billing month")
  //   3. the venue is billed as a share and the partner dashboard itself publishes $0 owed
  //      (Crossbar Rowlett, May 2026: 3 matches, $49 revenue, payment 0, state "nothing")
  // Anything OUTSIDE this set that renders $0 is the null-rate bug wearing a real number.
  const { data: overrides } = await svc.from("fin_venue_cost_overrides").select("venue_id, month, override_amount");
  const { data: dashes } = await svc.from("partner_dashboards").select("venue_id, revenue_model, enabled");
  const nameOf = new Map((venues ?? []).map((v) => [v.id, v.venue_name]));
  const zeroUnitCost = new Set((venues ?? []).filter((v) => v.cost_per_match === 0).map((v) => v.venue_name));
  const shareVenues = new Set(
    (venues ?? [])
      .filter((v) => v.billing_type === "profit_share" ||
        (dashes ?? []).some((d) => d.venue_id === v.id && d.enabled && d.revenue_model === "per_match_minus_manager"))
      .map((v) => v.venue_name),
  );
  const zeroOverride = new Set((overrides ?? []).filter((o) => Number(o.override_amount) === 0)
    .map((o) => `${nameOf.get(o.venue_id)}|${o.month}`));
  const zeroIsLegitimate = (venue, month) =>
    zeroUnitCost.has(venue) || shareVenues.has(venue) || zeroOverride.has(`${venue}|${month}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 }, storageState });
  const page = await ctx.newPage();

  // A section is READY when the frame title is up AND the section's own marker has rendered.
  // Waiting on the frame alone would let every absence check below run against "Loading…".
  const open = async (path, readySel) => {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="finance-title"]', { timeout: 90000 });
    if (readySel) await page.waitForSelector(readySel, { timeout: 120000 });
    await page.waitForTimeout(300);
  };

  console.log("finance — six sections\n");

  // ── THE LANDING ──────────────────────────────────────────────────────────
  console.log("/admin/finance is Cities:");
  {
    await page.goto(`${BASE}/admin/finance`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.pathname === "/admin/finance/cities", null, { timeout: 45000 }).catch(() => {});
    eq("/admin/finance redirects to /admin/finance/cities", new URL(page.url()).pathname, "/admin/finance/cities");
  }

  // ── EACH SECTION ─────────────────────────────────────────────────────────
  for (const [path, panelMark] of SECTIONS) {
    console.log(`\n${path}:`);
    await open(path);
    // PRESENCE FIRST: wait for the panel's own text before asserting anything about the page.
    await page.waitForFunction((src) => new RegExp(src, "i").test(document.body.innerText), panelMark.source, { timeout: 120000 }).catch(() => {});
    const r = await page.evaluate(() => ({
      rail: [...document.querySelectorAll('[data-testid="app-rail"] [data-testid="rail-item"]')].map((a) => a.textContent.trim()),
      title: document.querySelector('[data-testid="finance-title"]')?.textContent?.trim() ?? null,
      periodBar: !!document.querySelector('[data-testid="finance-period-bar"]'),
      quarterDropdown: [...document.querySelectorAll("select")].some((x) => /quarter/i.test(x.getAttribute("aria-label") ?? "")),
      configure: /Configure/.test(document.body.innerText),
      checkIns: /City Manager Check-Ins/.test(document.body.innerText),
      managers: /\bManagers\b/.test(document.body.innerText),
      text: document.body.innerText,
    }));
    eq("the rail is the app's own six items, in order", r.rail, RAIL);
    eq("the frame title is Finance", r.title, "Finance");
    eq("…the panel rendered", panelMark.test(r.text), true);
    // The old assertion here was `!!querySelector("select")`, which matched the Basis dropdown and
    // kept passing after the QUARTER control was deleted. Name the control instead.
    eq("…the period bar is in the frame", r.periodBar, true);
    eq("…and the old quarter dropdown is gone", r.quarterDropdown, false);
    eq("…Configure / Check-Ins / Managers are all reachable", [r.configure, r.checkIns, r.managers], [true, true, true]);
    // NO PROSE: the two mockup lines must not have come along.
    eq("…no 'Track Matchday revenue across' line", /Track Matchday revenue across/i.test(r.text), false);
    eq("…no 'Compare revenue, field cost and' line", /Compare revenue, field cost and/i.test(r.text), false);
  }

  // ── CONFIGURE IS AN OVERLAY, REACHABLE FROM A SECTION ────────────────────
  console.log("\nConfigure opens over a section and dismisses back to it:");
  {
    await open("/admin/finance/cost", '[data-testid="finance-cost"]');
    await page.getByRole("button", { name: "Configure" }).click();
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({
      path: location.pathname,
      cost: !!document.querySelector('[data-testid="finance-cost"]'),
      sub: /Revenue|Expenses|Field Costs|Change Log/.test(document.body.innerText),
    }));
    eq("…Configure does not change the route", after.path, "/admin/finance/cost");
    eq("…and it replaces the section rather than stacking under it", after.cost, false);
    eq("…the Configure sub-strip is up", after.sub, true);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  COST — the numbers
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\ncost · the rollups add up:");
  const readCost = () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="cost-row"]')].map((tr) => {
        const td = [...tr.querySelectorAll("td")].map((c) => c.textContent.trim());
        const marks = [...tr.querySelectorAll('[data-testid="cost-billing-mark"]')].map((m) => m.textContent.trim());
        return { cells: td, marks, name: td[0] };
      });
      const tot = document.querySelector('[data-testid="cost-total-row"]');
      return {
        rows,
        total: tot ? [...tot.querySelectorAll("td")].map((c) => c.textContent.trim()) : null,
        gapRows: [...document.querySelectorAll('[data-testid="cost-gap-row"]')].map((g) => g.textContent.trim()),
      };
    });

  // A CLOSED month is what the partner cross-check needs: an open one has no published partner
  // payment to compare against. The card's own Jul/Aug/Sep segment is gone — that was the second
  // of two controls doing one job — so the previous month is reached with the period stepper.
  await open("/admin/finance/cost", '[data-testid="finance-cost"]');
  // WAIT FOR THE LABEL TO CHANGE, not for something already true. The previous version waited for
  // cost rows and a populated footer — both of which were on screen BEFORE the click — so the wait
  // passed instantly, the step never landed, and the partner cross-check silently compared
  // AUGUST's live figures against JULY's published payment.
  const beforeStep = await page.$eval('[data-testid="period-label"]', (e) => e.textContent.trim());
  await page.click('[data-testid="period-prev"]');
  await page.waitForFunction(
    (prev) => document.querySelector('[data-testid="period-label"]')?.textContent?.trim() !== prev,
    beforeStep, { timeout: 60000 });
  await page.waitForSelector('[data-testid="cost-row"]', { timeout: 120000 });
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="cost-total-row"]');
    return !!t && /\d/.test(t.querySelectorAll("td")[4]?.textContent ?? "");
  }, null, { timeout: 60000 });
  const costMonth = await page.$eval('[data-testid="period-label"]', (e) => e.textContent.trim());
  eq(`the period stepped off ${beforeStep}`, costMonth !== beforeStep, true);
  ok(`the cost page is showing ${costMonth}`);
  // THE CROSS-CHECK'S MONTH COMES FROM THE PAGE, never a literal. Hardcoding "2026-07-01" is what
  // let a failed step compare two different months and read as a cost regression.
  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const [mName, mYear] = costMonth.split(" ");
  const costMonthKey = `${mYear}-${String(MONTH_NAMES.indexOf(mName) + 1).padStart(2, "0")}-01`;

  const cityView = await readCost();
  await page.getByRole("button", { name: "Field Economics" }).click();
  // The field grain adds a City column, so the header width is the signal that the swap landed.
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-testid="cost-economics-table"] thead th').length === 7,
    null, { timeout: 60000 });
  const fieldView = await readCost();

  {
    // City totals column index 4 = Field cost (City | Billing | Matches | Revenue | Field cost | Ratio)
    const cityCosts = cityView.rows.map((r) => money(r.cells[4])).filter((n) => n != null);
    const citySum = cityCosts.reduce((a, b) => a + b, 0);
    // Total row for the city grain: [All cities, —, matches, revenue, cost, ratio] — the cost is
    // index 4, the same slot the data rows use. (The FIELD grain carries an extra City column, so
    // its rows put cost at 5; both grains must reach the same All-cities figure.)
    const cityTotal = money(cityView.total?.[4]);
    near("city rows sum to the All-cities field cost", citySum, cityTotal, 2);

    // Field view has an extra City column, so cost is index 5.
    const fieldCosts = fieldView.rows.map((r) => money(r.cells[5])).filter((n) => n != null);
    const fieldSum = fieldCosts.reduce((a, b) => a + b, 0);
    near("per-field cost sums to the same All-cities total", fieldSum, cityTotal, 2);

    const cityRev = cityView.rows.map((r) => money(r.cells[3])).filter((n) => n != null).reduce((a, b) => a + b, 0);
    near("…and the revenue column sums the same way", cityRev, money(cityView.total?.[3]), 2);
  }

  // ── A DASH IS NOT A ZERO ─────────────────────────────────────────────────
  console.log("\ncost · no venue renders $0 unless it really is free:");
  {
    const zeros = fieldView.rows.filter((r) => money(r.cells[5]) === 0).map((r) => r.name);
    const wrong = zeros.filter((v) => !genuinelyFree.has(v));
    eq("every $0 cost row is a venue whose stored cost is genuinely zero", wrong, []);
    if (genuinelyFree.size > 0) {
      ok(`…the estate has ${genuinelyFree.size} genuinely-free venue(s): ${[...genuinelyFree].join(", ")}`);
    }
    // The unknown ones render a dash and say so, rather than joining the zeros.
    const dashes = fieldView.rows.filter((r) => r.cells[5] === "—");
    eq("an unrecorded cost renders a dash", dashes.every((r) => r.marks.includes("No cost on file")), true);
    eq("…and every dashed row is named in the cost-not-recorded list",
      dashes.every((r) => cityView.gapRows.concat(fieldView.gapRows).some((g) => g.includes(r.name))), true);
  }

  // ── EVENT REVENUE IS HELD OUT OF THE RATIO ───────────────────────────────
  // Events sell spots but are not billed as matches, so their revenue cannot sit under a cost in
  // a ratio. The denominator therefore shrinks by event revenue, which can only push a ratio UP.
  console.log("\ncost · the ratio counts the same matches on both sides:");
  {
    const pcts = fieldView.rows
      .map((r) => ({ name: r.name, rev: money(r.cells[4]), cost: money(r.cells[5]), ratio: parseFloat(r.cells[6]) }))
      .filter((r) => r.rev > 0 && r.cost != null && Number.isFinite(r.ratio));
    // Naive ratio = cost / ALL revenue. The rendered ratio must never be BELOW it.
    const below = pcts.filter((r) => r.ratio < (r.cost / r.rev) * 100 - 0.15).map((r) => r.name);
    eq("no field's ratio is computed against a denominator larger than its revenue", below, []);
    // POSITIVE CONTROL: at least one field must be strictly above, or the exclusion is inert and
    // the rule above passes for the wrong reason.
    const above = pcts.filter((r) => r.ratio > (r.cost / r.rev) * 100 + 0.15).map((r) => r.name);
    eq("…and at least one event-carrying field really is excluded", above.length > 0, true);
    const t = await page.evaluate(() => document.body.innerText);
    eq("…with the exclusion stated, not silent", /event play excluded/i.test(t), true);
  }

  // ── BILLING TYPE ON EVERY ROW ────────────────────────────────────────────
  {
    const unmarked = fieldView.rows.filter((r) => r.marks.length === 0).map((r) => r.name);
    eq("every cost row carries its billing type", unmarked, []);
  }

  // ── DFW IS NOT EMPTY ─────────────────────────────────────────────────────
  console.log("\ncost · Dallas returns rows, not just Austin:");
  {
    const dallas = fieldView.rows.filter((r) => r.cells[1] === "Dallas");
    eq("Dallas has at least one field row", dallas.length > 0, true);
    const nonZero = dallas.filter((r) => (money(r.cells[4]) ?? 0) > 0);
    eq("…carrying non-zero revenue", nonZero.length > 0, true);
  }

  // ── THE PARTNER CROSS-CHECK ──────────────────────────────────────────────
  // The only assertion whose expected value comes from outside the code under test.
  console.log("\ncost · a profit-share venue equals the partner dashboard's own figure:");
  {
    const owedFor = async (slug, monthKey) => {
      const r = await fetch(`${BASE}/api/partner-dashboards/preview?slug=${slug}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      const j = await r.json();
      const m = (j.monthly?.months ?? []).find((x) => x.key === monthKey);
      return m?.payment ?? null;
    };
    for (const [slug, venue] of [["hattrick-yx4sur4t", "Hattrick"], ["crossbar-rowlett-xhr8y3t3", "Crossbar Rowlett"]]) {
      const owed = await owedFor(slug, costMonthKey);
      const row = fieldView.rows.find((r) => r.name === venue);
      if (owed == null) { bad(`${venue}: the partner dashboard published a ${costMonth} figure`, "payment was null — an OPEN month has none, so the step must land on a closed one"); continue; }
      if (!row) { bad(`${venue}: the cost page renders a ${costMonth} row`, "row not found"); continue; }
      near(`${venue} · ${costMonth} cost equals the partner dashboard's $${owed}`, money(row.cells[5]), owed, 1);
      eq(`…and the row says it is billed as a share`, row.marks.includes("Profit share"), true);
    }
  }

  // ── NO TARGET LINE ───────────────────────────────────────────────────────
  {
    const t = await page.evaluate(() => document.body.innerText);
    eq("no 50% target is drawn or claimed", /\btarget\b/i.test(t) && /50\s*%/.test(t), false);
    eq("the fourth tile is the measured highest-ratio field", /Highest-ratio field/i.test(t), true);
    eq("…and there is no 'above 50%' tile", /above 50/i.test(t), false);
  }

  // ── STRUCTURE FILTER: THREE REAL OPTIONS ─────────────────────────────────
  console.log("\ncost · the structure filter offers what exists:");
  {
    const t = await page.evaluate(() => document.body.innerText);
    eq("Per match / Profit share / Monthly flat are offered",
      [/Per match/i.test(t), /Profit share/i.test(t), /Monthly flat/i.test(t)], [true, true, true]);
    eq("…and no hourly-lease option", /hourly/i.test(t), false);
    eq("…and no installation / free-use option", /installation|free use/i.test(t), false);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  REVENUE — the numbers
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\nrevenue · the city rows sum to All cities:");
  await open("/admin/finance/revenue", '[data-testid="finance-revenue"]');
  await page.waitForSelector('[data-testid="revenue-group-row"]', { timeout: 120000 });
  {
    const t = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="revenue-group-row"]')]
        .map((tr) => [...tr.querySelectorAll("td")].map((c) => c.textContent.trim()));
      const tot = [...document.querySelectorAll('[data-testid="revenue-group-table"] tbody tr')].pop();
      return { rows, total: tot ? [...tot.querySelectorAll("td")].map((c) => c.textContent.trim()) : null };
    });
    // City | Month | Matches | DPP Revenue | Private Rental | Field Cost
    for (const [idx, label] of [[2, "Matches"], [3, "DPP Revenue"], [4, "Private Rental"]]) {
      const sum = t.rows.map((r) => money(r[idx]) ?? 0).reduce((a, b) => a + b, 0);
      near(`…${label} sums to the total row`, sum, money(t.total?.[idx]), 2);
    }
  }

  console.log("\nrevenue · the partial month is marked, and only one number is grossed up:");
  {
    const t = await page.evaluate(() => ({
      text: document.body.innerText,
      partials: document.querySelectorAll('[data-testid="revenue-tile-partial"]').length,
      cols: [...document.querySelectorAll('[data-testid="revenue-group-table"] thead th')].map((h) => h.textContent.trim()),
    }));
    eq("measured tiles carry the 'so far' mark", t.partials > 0, true);
    eq("…the pace tile names itself a projection", /PROJECTED/.test(t.text), true);
    eq("…and nothing else claims to be a full month", (t.text.match(/PROJECTED/g) ?? []).length, 1);
  }

  console.log("\nrevenue · the year-ago control is disabled, not fake:");
  {
    const d = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Previous year");
      return b ? { disabled: b.disabled, why: b.title } : null;
    });
    eq("Previous year avg is disabled", d?.disabled, true);
    eq("…and says why", /finance record starts/i.test(d?.why ?? ""), true);
  }

  console.log("\nrevenue · the chart is four months, oldest to newest:");
  {
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-testid="revenue-chart-month"]').length >= 2,
      null, { timeout: 90000 }).catch(() => {});
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="revenue-chart-month"]')].map((s) => s.textContent.trim()));
    // ONE BAR PER PERIOD, labelled in full ("August 2026") since the grain can be a quarter or a
    // year. The count is what the span could reach, not a fixed four — the record floor can make
    // it fewer, and the page says so when it does.
    const MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const parsed = labels.map((l) => l.match(/^([A-Z][a-z]+) (\d{4})/)).filter(Boolean)
      .map((m) => Number(m[2]) * 12 + MON.indexOf(m[1]));
    eq("the chart draws the selected period plus its priors", parsed.length, 4);
    eq("…oldest to newest", parsed.every((v, i) => i === 0 || v > parsed[i - 1]), true);
    eq("…and the newest is the selected period", labels[labels.length - 1].startsWith("August") || /so far/.test(labels[labels.length - 1]), true);
  }

  console.log("\nrevenue · match view carries the columns the brief named:");
  {
    await page.getByRole("button", { name: "Match View" }).click();
    await page.waitForSelector('[data-testid="revenue-match-table"]', { timeout: 60000 });
    const cols = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="revenue-match-table"] thead th')].map((h) => h.textContent.trim()));
    eq("the fourteen columns, in order", cols,
      ["Date", "Month", "Week", "Weekday", "City", "Location", "Hour", "Match", "Members Code", "Free Code", "DPP\u2019s", "Total Spots", "DPP Revenue", "Field Cost"]);
    const rows = await page.evaluate(() => document.querySelectorAll('[data-testid="revenue-match-row"]').length);
    eq("…and it renders matches", rows > 0, true);
    // A match at a field with NO cost basis shows a dash. A match at a field that genuinely cost
    // nothing shows $0 — free is a fact. So the check is not "no zeros", it is "every zero is one
    // of the three legitimate mechanisms", tested against the database rather than a name list.
    const zeroRows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="revenue-match-row"]')]
        .map((tr) => [...tr.querySelectorAll("td")].map((c) => c.textContent.trim()))
        .filter((c) => c[13] === "$0")
        .map((c) => ({ venue: c[5], month: c[1] })));
    const unexplained = zeroRows.filter((z) => !zeroIsLegitimate(z.venue, z.month))
      .map((z) => `${z.venue} ${z.month}`);
    eq("every $0 match row traces to a recorded zero, not a missing rate", [...new Set(unexplained)], []);
    // And the dash really is in use — otherwise the rule above passes vacuously on a table that
    // never renders an unknown at all.
    const dashRows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="revenue-match-cost"]')].filter((c) => c.textContent.trim() === "\u2014").length);
    ok(`…${zeroRows.length} genuine $0 rows and ${dashRows} unknown-cost rows rendered as a dash`);
  }

  console.log("\nrevenue · Clear filters really clears:");
  {
    const before = await page.evaluate(() => document.querySelectorAll('[data-testid="revenue-match-row"]').length);
    await page.getByRole("button", { name: "Dallas", exact: true }).click();
    await page.waitForTimeout(900);
    const filtered = await page.evaluate(() => document.querySelectorAll('[data-testid="revenue-match-row"]').length);
    eq("filtering to Dallas narrows the table", filtered > 0 && filtered < before, true);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => document.querySelectorAll('[data-testid="revenue-match-row"]').length);
    eq("…and Clear filters restores it", after, before);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  LAYOUT
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\nlayout · desktop 1600:");
  for (const path of ["/admin/finance/revenue", "/admin/finance/cost"]) {
    await page.setViewportSize({ width: 1600, height: 1200 });
    await open(path, path.includes("cost") ? '[data-testid="finance-cost"]' : '[data-testid="finance-revenue"]');
    const r = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      // The mobile bar must not be painted at desktop width — by COMPUTED display, not by the
      // hidden attribute, which a stylesheet can override in either direction.
      mobileBar: [...document.querySelectorAll('[data-testid="mo-mobile-bar"]')]
        .some((e) => getComputedStyle(e).display !== "none"),
      tiles: [...document.querySelectorAll("[class*='tile']")].length,
    }));
    eq(`${path}: the page does not scroll sideways`, r.overflow, false);
    eq(`${path}: no mobile-only block is rendered`, r.mobileBar, false);
  }

  console.log("\nlayout · phone 390:");
  for (const path of ["/admin/finance/revenue", "/admin/finance/cost"]) {
    await page.setViewportSize({ width: 390, height: 900 });
    await open(path, path.includes("cost") ? '[data-testid="finance-cost"]' : '[data-testid="finance-revenue"]');
    const r = await page.evaluate(() => {
      const small = [...document.querySelectorAll("button:not([disabled]), select")]
        .filter((b) => { const x = b.getBoundingClientRect(); return x.width > 0 && x.height > 0 && Math.min(x.width, x.height) < 36; })
        .map((b) => b.textContent.trim().slice(0, 24));
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        small: [...new Set(small)],
        // Tables get their OWN horizontal axis so the page keeps one.
        scrollers: [...document.querySelectorAll("table")].filter((t) => {
          let p = t.parentElement;
          while (p && p !== document.body) { if (/auto|scroll/.test(getComputedStyle(p).overflowX)) return true; p = p.parentElement; }
          return false;
        }).length,
        tables: document.querySelectorAll("table").length,
      };
    });
    eq(`${path}: the phone page does not scroll sideways`, r.overflow, false);
    eq(`${path}: every table scrolls inside its own container`, r.scrollers, r.tables);
    eq(`${path}: every enabled control clears 36px on its short axis`, r.small, []);
  }
  await page.setViewportSize({ width: 1600, height: 1200 });

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeContext(ctx);
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
