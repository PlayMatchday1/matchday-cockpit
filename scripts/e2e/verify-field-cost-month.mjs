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

// ── THE DELETED PROSE STAYS DELETED ──────────────────────────────────────────────────────────
// Two blocks of explanation were cut: the clamping paragraph in WHEN IT BILLS, and the page-level
// banner about monthly venues. Both restated what the page already answers per row, and both are
// the kind of thing that grows back one helpful sentence at a time.
console.log("\n── the removed prose ──");
{
  // EXPAND A VENUE FIRST. The clamping paragraph only ever rendered inside an open panel, so
  // scanning a collapsed table would report it absent no matter what.
  await page.locator('table tbody tr button[aria-expanded]').first().click();
  await page.waitForTimeout(900);
  const expanded = await page.locator('[data-testid="month-help"]').count();
  eq("  control — a venue panel is expanded, so panel prose is in scope", expanded > 0, true);

  const scan = await page.evaluate(() => document.body.innerText || "");
  eq("  control — the scan read a real rendered page", scan.length > 800, true);
  // …and it finds text that IS on the page, so a zero below means absent, not unscanned.
  eq("  control — it finds a string that is present ('Billing day')", /Billing day/i.test(scan), true);

  eq("the clamping paragraph is gone ('clamped')", /clamped/i.test(scan), false);
  eq("…including its last clause", /nothing could tell the two apart/i.test(scan), false);
  eq("the page banner is gone ('Monthly venues bill within the month')",
     /Monthly venues bill within the month/i.test(scan), false);

  // THE THIRD CONTROL: plant each removed string and prove the scan would have caught it.
  for (const needle of ["clamped", "nothing could tell the two apart", "Monthly venues bill within the month"]) {
    const caught = await page.evaluate((t) => {
      const d = document.createElement("div"); d.textContent = t;
      document.body.appendChild(d);
      const hit = document.body.innerText.includes(t);
      d.remove();
      return hit;
    }, needle);
    eq(`  control — a planted "${needle.slice(0, 28)}" IS caught`, caught, true);
  }

  // THE ANSWER SURVIVES THE EXPLANATION. The resolved line is what actually tells you the date.
  const resolved = await page.evaluate(() => {
    const hit = [...document.querySelectorAll("div")]
      .map((e) => e.textContent ?? "")
      .find((t) => /bills\s+\w{3}\s+\d{1,2}$/.test(t.trim()) && t.length < 80);
    return hit?.trim() ?? null;
  });
  eq("the resolved-date line still renders", resolved !== null, true);
  if (resolved) console.log(`     resolved line: ${resolved}`);

  // THE CLAMP MUST STILL BE VISIBLE IN THE ANSWER even though the explanation is gone. ATH Katy
  // is billing_day 15 (id 7) and Westlake is billing_day 31 (id 49); a 30-day month is where 31
  // has to resolve to the 30th. If that ever silently became "Sep 31" the paragraph's removal
  // would have hidden a real defect.
  eq("  day 15 resolves to the 15th", /bills\s+\w{3}\s+15\b/.test(resolved ?? ""), true);

  await page.locator('table tbody tr button[aria-expanded]').first().click(); // collapse
  await page.waitForTimeout(400);

  // Switch to a 30-day month and open the day-31 venue.
  const monthSel = page.locator("select").filter({ hasText: /\d{4}/ }).first();
  const opts = await page.evaluate(() => {
    for (const sel of document.querySelectorAll("select")) {
      const vals = [...sel.options].map((o) => o.value);
      if (vals.some((v) => /^[A-Z][a-z]{2} \d{4}$/.test(v))) return vals;
    }
    return [];
  });
  const thirty = opts.find((v) => /^(Apr|Jun|Sep|Nov) /.test(v));
  if (!thirty) {
    console.log("  --  no 30-day month in the selector; day-31 clamp not exercised this run");
  } else {
    await monthSel.selectOption(thirty);
    await page.waitForTimeout(2500);
    const row31 = page.locator("#venue-row-49");
    if (await row31.count() === 0) {
      console.log(`  --  Westlake (day 31) not listed in ${thirty}; clamp not exercised`);
    } else {
      await row31.locator('button[aria-expanded]').first().click();
      await page.waitForTimeout(1200);
      const line = await page.evaluate(() => {
        const hit = [...document.querySelectorAll("div")].map((e) => e.textContent ?? "")
          .find((t) => /bills\s+\w{3}\s+\d{1,2}$/.test(t.trim()) && t.length < 80);
        return hit?.trim() ?? null;
      });
      console.log(`     ${thirty} day-31 venue: ${line}`);
      eq(`  day 31 in a 30-day month resolves to the 30th, not the 31st`,
         /bills\s+\w{3}\s+30\b/.test(line ?? ""), true);
      eq("  …and never prints a 31st in a 30-day month", /bills\s+\w{3}\s+31\b/.test(line ?? ""), false);
    }
  }
}

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("table tbody tr", { timeout: 60000 });
await page.waitForTimeout(2000);

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
    /* THE MARKER READS "KEYED", NOT "set for". Changed deliberately: "set for August" was the only
     * thing distinguishing a deliberate $0 from "nothing keyed", and it did not say what it was.
     * These two lines pinned the old copy; the behaviour they guard — a keyed value replacing the
     * computed one — is unchanged and still asserted. */
    const totalTxt = (rowText.match(/\$([\d,]+)\s+KEYED/) ?? [])[1] ?? "";
    eq("after reload the row total is no longer the computed figure",
       totalTxt !== "" && totalTxt !== autoTxt, true);
    eq("…and labels it KEYED <month>", /KEYED \w+/.test(rowText), true);
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

// ── THE RATE COLUMN AND THE KEYED MARKER ──────────────────────────────────────────────────────
// Three display faults, all of which made correct costs look wrong:
//   · a combined venue stating ONE leg's rate — ATH Katy showed "$140 / match" against 17 matches
//     and $2,480, an arithmetic nobody performed;
//   · a rate that drives nothing — Crossbar Rowlett is priced by its partner dashboard, so its
//     $100 never touched the money;
//   · a keyed $0 rendering as an em dash, indistinguishable from "nothing keyed, nothing billable".
// No cost logic changed. These assert the DISPLAY, and each carries the control that proves the
// scan can tell the difference.
console.log("\n── the rate column states only rates the cost used ──");
{
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="fc-rate"]')].map((c) => {
    const tr = c.closest("tr");
    return {
      name: tr?.querySelector("td")?.innerText.split("\n")[0]?.trim() ?? "",
      rates: Number(c.getAttribute("data-rates")),
      legs: tr.querySelectorAll('[data-testid="fc-rate-leg"]').length,
      rateText: c.innerText.replace(/\s+/g, " ").trim(),
      cost: tr?.querySelector('[data-testid="fc-cost-amount"]')?.textContent?.trim() ?? "",
      keyed: tr?.querySelector('[data-testid="fc-keyed"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    };
  }));
  eq("  control — the table rendered rows", rows.length > 0, true);

  /* 29 ROWS, NOT 30. There are 30 venue GROUPS, but El Paso is a paused market and isCityHidden
   * drops Galatzan Park before the table is built, so it never renders. The unchanged count is
   * therefore 22 — the figure that says this change is contained. */
  /* ITEMISED — AN EXPECTATION CHANGE, NOT A SELECTOR EDIT. 29 -> 30 (31 groups, El Paso hidden):
   * migration 0142 created the San Antonio venue "New Braunfels" for MatchDay field 1618, so the
   * ledger has one more row. Predicted before 0142 was applied. */
  eq("the table renders 30 rows (31 groups, El Paso hidden)", rows.length, 30);

  const combined = rows.filter((r) => r.rates > 1);
  eq("exactly two rows state more than one rate", combined.map((r) => r.name).sort(),
    ["ATH Katy", "Soccer Central"]);
  for (const r of combined) {
    eq(`  ${r.name} renders one rate per leg`, r.legs, r.rates);
    eq(`  …and states ${r.rates} of them`, r.rates, 2);
  }
  // THE LABELS COME FROM COMBINED_LEG_LABELS, in per_match_rate ASC order, never re-sorted.
  const katy = rows.find((r) => r.name === "ATH Katy");
  eq("ATH Katy names its weekday rate before its Sunday rate",
    /\$140\s*weekday.*\$160\s*Sunday/.test(katy?.rateText ?? ""), true);
  const sc = rows.find((r) => r.name === "Soccer Central");
  eq("Soccer Central names normal before tournament",
    /\$80\s*normal.*\$120\s*tournament/.test(sc?.rateText ?? ""), true);

  // A DASHBOARD-PRICED VENUE STATES NO PER-MATCH RATE AT ALL.
  const cross = rows.find((r) => r.name === "Crossbar Rowlett");
  eq("  control — Crossbar Rowlett is on the table", !!cross, true);
  eq("Crossbar Rowlett states no per-match rate", cross?.rates, 0);
  eq("  …and says what does decide the money", /Partner payout/.test(cross?.rateText ?? ""), true);
  eq("  …with no per-match figure anywhere in the cell", /\/ match/.test(cross?.rateText ?? ""), false);

  /* POSITIVE CONTROLS — the honest rows are untouched. The three flat_percentage dashboards still
   * read "Share of revenue", and every other row still states exactly one rate. */
  for (const n of ["Hattrick", "PAC Global", "PARMER Stadium"]) {
    const r = rows.find((x) => x.name === n);
    eq(`  control — ${n} still reads "Share of revenue"`, /Share of revenue/.test(r?.rateText ?? ""), true);
  }
  const plain = rows.filter((r) => r.rates === 1);
  eq("every other row states exactly one rate", plain.length, rows.length - combined.length - 1);
  /* TWO DIFFERENT COUNTS, and conflating them is how "22" first came out as 26.
   *   26 rows state exactly ONE rate — their RATE cell is untouched.
   *   22 rows are untouched ENTIRELY — the other four state one rate but had their COST cell
   *      change, because they carry a keyed value.
   * The containment claim is the second number, so it is computed as "one rate AND no keyed
   * marker" rather than assumed to be the same set. */
  const untouched = rows.filter((r) => r.rates === 1 && !r.keyed);
  // 22 -> 23, the arithmetic below the row count above: 30 rendered − 7 changed.
  eq("  …and 23 rows are untouched entirely (30 rendered − 7 changed)", untouched.length, 23);
  eq("  …the difference being the four keyed rows that still state one rate",
    plain.length - untouched.length, 4);
}

console.log("\n── a keyed value is visibly keyed, and zero is a value ──");
{
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="fc-cost"]')].map((c) => {
    const tr = c.closest("tr");
    return {
      name: tr?.querySelector("td")?.innerText.split("\n")[0]?.trim() ?? "",
      cost: c.querySelector('[data-testid="fc-cost-amount"]')?.textContent?.trim() ?? "",
      keyed: c.querySelector('[data-testid="fc-keyed"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    };
  }));
  const keyed = rows.filter((r) => r.keyed);
  eq("all five August keyed values carry the marker", keyed.length, 5);
  eq("  …and every marker says KEYED", keyed.every((r) => r.keyed.startsWith("KEYED")), true);

  // ZERO IS A VALUE. A keyed $0 prints $0; an unkeyed zero still prints an em dash; and the two
  // must be DIFFERENT marks, which is the whole point — four straight months of Centennial dashes
  // read as "this venue is free".
  const zeros = keyed.filter((r) => r.cost === "$0");
  eq("  control — August has keyed zeros to check", zeros.length > 0, true);
  eq("every keyed zero renders $0", keyed.filter((r) => r.cost === "—").length, 0);
  const cent = rows.find((r) => r.name === "Centennial Commons");
  eq("Centennial Commons renders $0, not a dash", cent?.cost, "$0");
  eq("  …and names the derived figure beside it", /derived \$300/.test(cent?.keyed ?? ""), true);

  // THE POSITIVE CONTROL FOR THE DASH: a row with nothing keyed and nothing billable still shows
  // one, and it is a DIFFERENT mark from the keyed zero.
  const unkeyed = rows.filter((r) => !r.keyed && r.cost === "—");
  eq("  control — unkeyed, unbillable rows still render an em dash", unkeyed.length > 0, true);
  eq("a keyed zero and an unkeyed zero are different marks", cent?.cost === unkeyed[0]?.cost, false);

  /* SOCCER CENTRAL IS THE ROW IN BOTH CASES — two rates AND a keyed value — and is the one most
   * likely to have one fix clobber the other. Ryan is still deciding its $5,600 against a $3,400
   * derived, so this asserts the PRESENTATION, not the figure. */
  const sc = rows.find((r) => r.name === "Soccer Central");
  eq("Soccer Central carries its keyed marker", sc?.keyed?.startsWith("KEYED"), true);
  eq("  …and names its derived figure", /derived/.test(sc?.keyed ?? ""), true);
  const scRates = await page.evaluate(() => {
    const tr = [...document.querySelectorAll("tr")].find((t) => t.innerText.startsWith("Soccer Central"));
    return Number(tr?.querySelector('[data-testid="fc-rate"]')?.getAttribute("data-rates"));
  });
  eq("  …while still stating both of its rates", scRates, 2);
}


await closeContext(ctx);
await closeBrowser(browser);

console.log(`\n${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
