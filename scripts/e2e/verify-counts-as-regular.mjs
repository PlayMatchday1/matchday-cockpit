// THE PER-LINK EVENT EXCEPTION — fin_venue_fields.counts_as_regular_play (migration 0130).
//
// THE DEFECT IT ANSWERS. EVENT_MARKERS (venueResolver.ts:55) classifies a match as an event from
// its field_title. mdapi field 22 is named "Tourney ATH Pearland" and carries the ordinary weekly
// schedule, so every match on it has been dropped from venue cost since the link was made — 519
// alive matches, $83,040 at $160. The marker is matching a name, not a fact.
//
// THE EXCEPTION IS APPLIED IN EXACTLY ONE PLACE: useFinanceData's mapMdapiRowToSchedule, where
// `category` is decided. isEventSchedule has 24 call sites across five files; wiring the flag at
// any of them would mean wiring it at all of them. This suite proves the single point works by
// checking pages that read through four different call sites.
//
// THE ASSERTION THAT MATTERS MOST IS THE REVENUE ONE. These matches are ALREADY counted in
// revenue — fin_revenue keys on the venue name string and never consults `category`, which is why
// $7,002 of August revenue survived while cost went to zero. If the flag ever reached the revenue
// path it would double-count, and that is the one way this fix could make things worse.
//
// IT MUTATES ONE PRODUCTION ROW AND PUTS IT BACK. The flag is flipped on field 22, measured, and
// reverted in a finally. Preconditions assert every flag is off before it starts, and the last
// assertion re-checks that every flag is off after — a suite that leaves this on would silently
// restate 26 closed months.
//
//   node scripts/e2e/verify-counts-as-regular.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const money = (t) => Number(String(t ?? "").replace(/[^0-9.-]/g, ""));

const FIELD = 22;                 // "Tourney ATH Pearland"
const VENUE = "ATH Pearland";
const CITY = "Houston";
const CONTROL_VENUE = "ATH Katy"; // a venue with no event-marked link, to prove nothing else moves
const RATE = 160;

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const flagsOn = async () => {
  const { data, error } = await svc.from("fin_venue_fields").select("mdapi_field_id").eq("counts_as_regular_play", true);
  if (error) throw new Error(error.message);
  return data.map((r) => r.mdapi_field_id).sort((a, b) => a - b);
};
const setFlag = async (fieldId, v) => {
  const { error } = await svc.from("fin_venue_fields").update({ counts_as_regular_play: v }).eq("mdapi_field_id", fieldId);
  if (error) throw new Error(error.message);
};

// The August truth, straight from mdapi_matches — the number the page must land on.
const { data: mrows, error: mErr } = await svc
  .from("mdapi_matches").select("api_id,is_cancelled,deleted_at,start_date")
  .eq("field_id", FIELD).gte("start_date", "2026-08-01").lte("start_date", "2026-08-31T23:59:59");
if (mErr) throw new Error(mErr.message);
const ALIVE = mrows.filter((r) => r.deleted_at == null && !r.is_cancelled).length;
const EXPECT_COST = ALIVE * RATE;

// THE WHOLE QUARTER, PER MONTH. Cash Flow shows Jul/Aug/Sep and a total, so the flag moves more
// than August — which is the point of "this changes closed months". Derived from mdapi_matches
// rather than written down: ATH Pearland has charge_on_cancel=true, so a cancelled match is
// billable and belongs in the expectation.
const { data: qrows, error: qErr } = await svc
  .from("mdapi_matches").select("is_cancelled,deleted_at,start_date")
  .eq("field_id", FIELD).gte("start_date", "2026-07-01").lte("start_date", "2026-09-30T23:59:59");
if (qErr) throw new Error(qErr.message);
const perMonth = {};
for (const r of qrows) {
  if (r.deleted_at != null) continue;
  const m = String(r.start_date).slice(0, 7);
  perMonth[m] = (perMonth[m] ?? 0) + RATE;   // charge_on_cancel=true → cancelled counts too
}
const QUARTER_TOTAL = Object.values(perMonth).reduce((a, b) => a + b, 0);
const EXPECTED_DELTAS = new Set([...Object.values(perMonth), QUARTER_TOTAL].map(Math.round));

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1620, height: 1400 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const rowsOf = async (url) => {
  await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length > 3, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(3500);
  return page.evaluate(() => [...document.querySelectorAll("tbody tr")]
    .map((r) => [...r.querySelectorAll("td,th")].map((c) => c.innerText.trim().replace(/\s+/g, " ")).join(" | ")));
};
const find = (rows, needle) => rows.find((r) => r.startsWith(needle)) ?? null;
const snapshot = async () => ({
  fc: await rowsOf("/admin/finance/ledger/field-costs"),
  cost: await rowsOf("/admin/finance/cost"),
});

let restored = false;
try {
  console.log("── preconditions ──");
  const before = await flagsOn();
  eq("every link starts with the flag OFF", before, []);
  eq(`  control — August has alive matches on field ${FIELD} to count`, ALIVE > 0, true);
  console.log(`     field ${FIELD}: ${ALIVE} alive matches in Aug 2026 → $${EXPECT_COST.toLocaleString()} at $${RATE}`);

  // ── FLAG OFF ────────────────────────────────────────────────────────────────────────────────
  console.log("\n── flag off ──");
  const OFF = await snapshot();
  eq("no uncaught page errors", errors, []);
  const offVenue = find(OFF.fc, VENUE), offControl = find(OFF.fc, CONTROL_VENUE), offCity = find(OFF.cost, null) ?? null;
  eq("  control — the venue row rendered", offVenue != null, true);
  eq("  control — the control venue rendered", offControl != null, true);
  const offHouston = OFF.cost.find((r) => r.includes(`| ${CITY} |`));
  eq("  control — the city row rendered on the Cost page", offHouston != null, true);
  const offMatches = Number((offVenue.split("|")[3] ?? "").trim());
  eq(`${VENUE} shows 0 matches with the flag off`, offMatches, 0);
  eq("  …and no August cost", /—|not billed/.test(offVenue.split("|")[4] ?? ""), true);
  const offCityRev = money(offHouston.split("|")[2]), offCityCost = money(offHouston.split("|")[3]);
  console.log(`     ${VENUE}: ${offMatches} matches ·${offVenue.split("|")[4]}`);
  console.log(`     ${CITY}: revenue $${offCityRev.toLocaleString()} · cost $${offCityCost.toLocaleString()}`);

  // ── FLAG ON ─────────────────────────────────────────────────────────────────────────────────
  console.log("\n── flag on, field 22 only ──");
  await setFlag(FIELD, true);
  eq("  control — exactly one link now carries the flag", await flagsOn(), [FIELD]);
  const ON = await snapshot();
  const onVenue = find(ON.fc, VENUE), onControl = find(ON.fc, CONTROL_VENUE);
  const onHouston = ON.cost.find((r) => r.includes(`| ${CITY} |`));
  const onMatches = Number((onVenue.split("|")[3] ?? "").trim());

  // THE NUMBER, NOT "IT CHANGED".
  eq(`${VENUE} counts ${ALIVE} matches with the flag on`, onMatches, ALIVE);
  eq(`  …and bills $${EXPECT_COST.toLocaleString()}`, money(onVenue.split("|")[4]), EXPECT_COST);
  console.log(`     ${VENUE}: ${onMatches} matches ·${onVenue.split("|")[4]}`);

  // REVENUE IS UNTOUCHED. This is the double-count assertion.
  const onCityRev = money(onHouston.split("|")[2]), onCityCost = money(onHouston.split("|")[3]);
  eq(`${CITY} revenue is identical with the flag on`, onCityRev, offCityRev);
  eq("  …while its cost rises by exactly the venue's new cost", onCityCost - offCityCost, EXPECT_COST);
  console.log(`     ${CITY}: revenue $${onCityRev.toLocaleString()} (unchanged) · cost $${offCityCost.toLocaleString()} → $${onCityCost.toLocaleString()}`);

  // NOTHING ELSE MOVES. The control venue and every other Field Costs row are byte-identical.
  eq(`${CONTROL_VENUE} is byte-identical with the flag on`, onControl, offControl);
  const moved = OFF.fc.filter((r, i) => ON.fc[i] !== r);
  eq("exactly one Field Costs row changed", moved.length, 1);
  eq("  …and it is the venue we flagged", moved[0].startsWith(VENUE), true);

  // ── THE PANEL LISTS WHAT THE VENUE IS MADE OF ───────────────────────────────────────────────
  console.log("\n── the field list ──");
  await page.goto(`${BASE}/admin/finance/ledger/field-costs`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length > 3, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const opened = await page.evaluate((venue) => {
    const tr = [...document.querySelectorAll("tbody tr")].find((r) => r.innerText.trim().startsWith(venue));
    const btn = tr?.querySelector("button[aria-expanded]");
    if (!btn) return false; btn.click(); return true;
  }, VENUE);
  eq("  control — the venue panel opened", opened, true);
  await page.waitForTimeout(1200);
  const L = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="venue-field-row"]')];
    return rows.map((r) => ({
      id: Number(r.getAttribute("data-field-id")),
      counted: r.getAttribute("data-counted"),
      status: r.querySelector('[data-testid="venue-field-status"]')?.textContent?.trim(),
      title: r.querySelector("span")?.textContent?.trim(),
      hasToggle: !!r.querySelector('[data-testid="venue-field-toggle"]'),
    }));
  });
  eq(`${VENUE} lists both of its links`, L.length, 2);
  const clean = L.find((x) => x.id === 32), marked = L.find((x) => x.id === FIELD);
  eq("  the clean link is listed as counting", [clean?.counted, clean?.status], ["yes", "counts"]);
  eq("  …and offers no exception toggle", clean?.hasToggle, false);
  eq("  the marked link shows it is counting under the exception", [marked?.counted, marked?.status], ["yes", "counts (exception)"]);
  eq("  …and does offer the toggle", marked?.hasToggle, true);
  console.log(`     ${L.map((x) => `${x.title}: ${x.status}`).join(" · ")}`);

  // ── FOUR PAGES, ONE FIGURE ──────────────────────────────────────────────────────────────────
  // FOUR PAGES, ONE FIGURE — and the test is the DELTA, not that a page rendered. "Rendered
  // without error" would pass on a page that ignores the flag entirely, which is the failure this
  // is for: the exception is applied at one derivation and every page must inherit it.
  console.log("\n── the pages agree on the delta ──");
  for (const [name, url, needle, col] of [
    ["OpEx", "/admin/finance/opex", "FIELD COSTS", 0],
    ["Cash Flow", "/admin/finance/cash-flow", "Field Costs", 2],
  ]) {
    const rowsOn = await rowsOf(url);
    await setFlag(FIELD, false);
    const rowsOff = await rowsOf(url);
    await setFlag(FIELD, true);
    const pick = (rows) => rows.find((r) => r.startsWith(needle)) ?? null;
    const a = pick(rowsOff), b = pick(rowsOn);
    eq(`  control — ${name} has a Field Costs line`, a != null && b != null, true);
    // The line's own August figure, whichever column carries it on that page.
    const nums = (r) => (r.match(/[\d,]+\.?\d*/g) ?? []).map((x) => Number(x.replace(/,/g, "")));
    const deltas = nums(b).map((v, i) => v - (nums(a)[i] ?? 0)).filter((d) => Math.abs(d) > 0.5);
    eq(`${name}'s Field Costs line moves by exactly $${EXPECT_COST.toLocaleString()}`,
       deltas.some((d) => Math.round(d) === EXPECT_COST), true);
    // EVERY delta on that line is a month of this field's own matches, or the quarter's sum of
    // them. Derived above from mdapi_matches — nothing here is a number I wrote down.
    eq(`  …and every figure it moves by is a month of field ${FIELD} or their total`,
       deltas.every((d) => EXPECTED_DELTAS.has(Math.round(d))), true);
    console.log(`     ${name}: deltas ${deltas.map((d) => "$" + Math.round(d).toLocaleString()).join(", ")} · expected from the ledger ${[...EXPECTED_DELTAS].map((d) => "$" + d.toLocaleString()).join(", ")}`);
  }
} finally {
  // ── PUT IT BACK, WHATEVER HAPPENED ABOVE ───────────────────────────────────────────────────
  try {
    await setFlag(FIELD, false);
    const after = await flagsOn();
    restored = after.length === 0;
    console.log("\n── revert ──");
    eq("every link is OFF again after the run", after, []);
  } catch (e) {
    console.log("  ✗ REVERT FAILED —", e instanceof Error ? e.message : String(e));
    FAIL++;
  }
}

// AND THE PAGE IS BACK WHERE IT STARTED.
if (restored) {
  const back = await rowsOf("/admin/finance/ledger/field-costs");
  const backVenue = find(back, VENUE);
  eq(`${VENUE} is back to 0 matches after the revert`, Number((backVenue.split("|")[3] ?? "").trim()), 0);
}

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  " + f)); }
await closeContext(ctx);
await closeBrowser(browser);
process.exit(FAIL === 0 ? 0 : 1);
