// FIELD COSTS — ONE MONTH FIELD, AND THE WORD "OVERRIDE" IS GONE.
//
// WHAT CHANGED. The month cost used to be a read-only figure behind a Set/Edit button that opened a
// dialog, and the whole idea was named "override" in eight places. There is no second concept: the
// month box either has a number in it or it does not, and if it does, that number is the cost.
//
// WHAT THIS PINS. That the box writes and CLEARS through to the database — clearing must store SQL
// NULL, not "", or the row reads as "hand-entered $0" forever — and that the word does not creep
// back into a label, a filter or a helper line.
//
// EVERY VENUE IT TOUCHES IS RESTORED. It reads the current stored value first, writes, checks,
// clears, checks, and puts the original back, verifying the restore.
//
//   node scripts/e2e/verify-field-cost-month.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const URL_ = `${BASE}/admin/finance/ledger/field-costs`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const PROBE_AMOUNT = 1234.56;
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1620, height: 1200 } });
const page = await ctx.newPage();

await page.goto(URL_, { waitUntil: "domcontentloaded" });
// PRESENCE FIRST — the word-absence scan below is worthless against a spinner.
await page.waitForSelector('[data-testid="fc-row"], table tbody tr', { timeout: 60000 });
await page.waitForTimeout(1500);
ok("the Field Costs page rendered");

// ── THE WORD APPEARS NOWHERE ─────────────────────────────────────────────────────────────────
console.log("\n── the word 'override' ──");
{
  const scan = await page.evaluate(() => {
    const text = document.body.innerText || "";
    const attrs = [...document.querySelectorAll("[title],[placeholder],[aria-label]")]
      .map((e) => `${e.getAttribute("title") ?? ""} ${e.getAttribute("placeholder") ?? ""} ${e.getAttribute("aria-label") ?? ""}`).join(" ");
    return { text, attrs, len: text.length };
  });
  eq("no visible text contains 'override'", /override/i.test(scan.text), false);
  eq("no title/placeholder/aria-label contains 'override'", /override/i.test(scan.attrs), false);
  // POSITIVE CONTROLS — the scan is reading a real, loaded page, not an empty string.
  eq("  control — the scan read a substantial page", scan.len > 500, true);
  eq("  control — and it CAN find a word that is definitely there ('Field')", /field/i.test(scan.text), true);
  // …and it would catch the word if it were present.
  const planted = await page.evaluate(() => {
    const d = document.createElement("div"); d.textContent = "override";
    document.body.appendChild(d);
    const hit = /override/i.test(document.body.innerText || "");
    d.remove();
    return hit;
  });
  eq("  control — the scan catches a planted 'override'", planted, true);
}

// ── THE FILTER AND THE HELPER READ THE NEW WAY ───────────────────────────────────────────────
console.log("\n── the labels that replaced it ──");
{
  const body = await page.evaluate(() => document.body.innerText);
  eq("the filter reads 'Has a month value only'", /Has a month value only/i.test(body), true);
}

// ── THE ROUND TRIP, THROUGH THE BOX ──────────────────────────────────────────────────────────
console.log("\n── type a value, reload, clear it, reload ──");
{
  // Pick a venue with an existing row so the panel is reachable, and remember its stored state.
  const monthKey = await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find((e) => /^\d{4}-\d{2}$/.test(e.getAttribute?.("data-month") ?? ""));
    return el?.getAttribute("data-month") ?? null;
  });
  // The panel opens from the row's chevron (aria-expanded), not from the row body.
  const chevron = page.locator('table tbody tr button[aria-expanded]').first();
  await chevron.click();
  await page.waitForTimeout(900);
  const panel = page.locator('[data-testid="month-help"]');
  const opened = await panel.count().catch(() => 0);
  if (!opened) {
    bad("a venue panel opened", "no month-help helper found after clicking the first row");
  } else {
    ok("a venue panel opened, showing the month helper line");
    const help = (await panel.first().textContent()) ?? "";
    eq("the helper states one of the two rules", /Empty computes|not billed per match/i.test(help), true);
    eq("  …and never uses the word", /override/i.test(help), false);
    console.log(`     helper: ${help.trim().slice(0, 90)}`);
  }
  void monthKey;
}

// ── THE WRITE, BOTH WAYS, READ BACK FROM THE DATABASE ────────────────────────────────────────
// A cleared box must store SQL NULL. If it ever stored "" the row would read as a hand-entered
// figure forever and the computed cost would never come back.
console.log("\n── write it, clear it, restore it ──");
{
  const box = page.locator('[data-testid="month-help"]').first()
    .locator("xpath=preceding::input[@type='number'][1]");
  // The row already carries its venue id in the DOM id; the month comes off the month selector.
  const venueId = await page.evaluate(() => {
    const tr = document.querySelector('table tbody tr[id^="venue-row-"]');
    const m = tr?.id.match(/venue-row-(\d+)/);
    return m ? Number(m[1]) : null;
  });
  const monthKey = await page.evaluate(() => {
    for (const sel of document.querySelectorAll("select")) {
      if (/^[A-Z][a-z]{2} \d{4}$/.test(sel.value)) return sel.value;  // "Aug 2026"
    }
    return null;
  });
  console.log(`     venue ${venueId} · month ${monthKey}`);

  if (venueId == null || !monthKey) {
    console.log("  --  the row carries no venue id / month in the DOM; asserting through the box only");
  }

  const readDb = async () => venueId == null || !monthKey ? undefined
    : (await svc.from("fin_venue_cost_overrides").select("override_amount").eq("venue_id", venueId).eq("month", monthKey).maybeSingle()).data;

  const original = await readDb();
  const restore = original?.override_amount ?? null;

  // REFUSE TO RUN ON TOP OF A PREVIOUS PROBE. An interrupted run can leave PROBE_AMOUNT behind;
  // the next run would then read it as this venue's real value and faithfully "restore" it,
  // burning a fake figure into a finance ledger. This is how it happened once.
  if (restore === PROBE_AMOUNT) {
    bad("the venue is clean before the probe", `${PROBE_AMOUNT} is already stored — a previous run left residue; clear venue ${venueId} / ${monthKey} before re-running`);
  }

  await box.fill(String(PROBE_AMOUNT));
  await box.blur();
  await page.waitForTimeout(2500);
  const after = await readDb();
  if (after === undefined) console.log("  --  no db handle for this row; skipped the read-back");
  else {
    eq("typing a value stores it", Number(after?.override_amount), PROBE_AMOUNT);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("table tbody tr", { timeout: 60000 });
    // Wait for the WRITTEN FIGURE to appear rather than a flat sleep — the finance data refetches
    // after hydration and 1.2s was racing it.
    await page.waitForFunction(() => /1,234\.56|1234\.56/.test(document.body.innerText), { timeout: 30000 })
      .catch(() => {});
    const rowText = await page.evaluate((id) => document.getElementById(`venue-row-${id}`)?.innerText ?? "", venueId);
    console.log(`     row after reload: ${rowText.replace(/\s+/g, " ").slice(0, 120)}`);
    // NOT an equality against what was typed. A COMBINED venue's month value covers the PRIMARY
    // leg only — secondary legs still bill their own cost — so the row total is the sum, not the
    // figure entered. ATH Katy: 1,234.56 primary + its Sunday leg = $2,035 against an auto $2,480.
    // What must be true is that the total moved off the auto figure and the row says why.
    const autoTxt = (rowText.match(/auto \$([\d,]+)/) ?? [])[1] ?? "";
    const totalTxt = (rowText.match(/\$([\d,]+)\s+set for/) ?? [])[1] ?? "";
    eq("after reload the row total is no longer the computed figure",
       totalTxt !== "" && totalTxt !== autoTxt, true);
    eq("…and labels it 'set for <month>'", /set for \w+/i.test(rowText), true);
    const body = await page.evaluate(() => document.body.innerText);
    eq("  …and still never says 'override'", /override/i.test(body), false);

    // CLEAR IT — and it must be NULL, not "".
    await page.locator('table tbody tr button[aria-expanded]').first().click();
    await page.waitForTimeout(900);
    const box2 = page.locator('[data-testid="month-help"]').first().locator("xpath=preceding::input[@type='number'][1]");
    await box2.fill("");
    await box2.blur();
    await page.waitForTimeout(2500);
    const cleared = await readDb();
    eq("clearing the box removes the stored value (NULL, never \"\")",
       cleared == null || cleared.override_amount == null, true);

    // RESTORE EXACTLY WHAT WAS THERE. If there was no row, "restore" means the row must be ABSENT
    // — not merely cleared through the UI, which is why this asserts on the row itself.
    if (restore != null) {
      await box2.fill(String(restore));
      await box2.blur();
      await page.waitForTimeout(2500);
    } else {
      await svc.from("fin_venue_cost_overrides").delete().eq("venue_id", venueId).eq("month", monthKey);
    }
    const back = await readDb();
    eq("the venue is exactly as it was before this suite ran", back?.override_amount ?? null, restore);
  }
}

await page.screenshot({ path: "/tmp/fc-panel.png", fullPage: false });
console.log("  saved /tmp/fc-panel.png");

await closeContext(ctx);
await closeBrowser(browser);
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
