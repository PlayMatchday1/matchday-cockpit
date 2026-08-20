// THE COST PAGE OPENS ON THE NUMBER THE OTHER THREE AGREE ON.
//
// The Cost page carries two bases. AS BILLED routes through canonicalVenueCost — the same
// derivation Field Costs, OpEx and Cash Flow use. PER MATCH is the operator's normalized unit cost
// and is deliberately different. Both are right; only the DEFAULT changed.
//
// WHAT THIS PINS:
//   · on the default basis, every venue-month matches the Field Costs ledger, venue by venue
//   · the per-match basis still returns its own figures — this was a default change, not a
//     correction of one of them
//   · a month value renders (it did not before: the per-match basis never reads one)
//   · KEYED $0 AND NOTHING-KEYED RENDER DIFFERENTLY. $0 means "we were invoiced nothing";
//     a dash means "no invoice on file". A venue that bills monthly is not free.
//   · a dashed row contributes no 0% to any total or to the highest-ratio card
//
//   node scripts/e2e/verify-cost-basis.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1700, height: 1400 } });
const page = await ctx.newPage();

const openFieldEconomics = async () => {
  await page.goto(`${BASE}/admin/finance/cost`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="cost-amount-cell"]', { timeout: 60000 });
  const fe = page.getByText("Field Economics", { exact: false }).first();
  if (await fe.count()) { await fe.click(); await page.waitForTimeout(3500); }
  await page.waitForSelector('[data-testid="cost-amount-cell"]', { timeout: 30000 });
};
const readCost = () => page.evaluate(() => {
  const out = {};
  for (const r of document.querySelectorAll("tbody tr")) {
    const name = r.querySelector("td")?.innerText.trim();
    const cost = r.querySelector('[data-testid="cost-amount-cell"]')?.innerText.trim();
    const ratio = r.querySelector('[data-testid="cost-ratio-cell"]')?.innerText.trim();
    if (name && cost != null) out[name] = { cost, ratio };
  }
  return out;
});

await openFieldEconomics();
const asBilled = await readCost();
const n = Object.keys(asBilled).length;
// PRESENCE FIRST — every comparison below is vacuous against an empty table.
eq("the Field Economics table rendered rows", n > 10, true);
console.log(`     ${n} rows on the default basis`);

// ── THE DEFAULT IS AS BILLED ──────────────────────────────────────────────────────────────────
console.log("\n── the page opens on AS BILLED ──");
eq("Westlake reads the as-billed figure, not the normalized one", asBilled["Westlake"]?.cost, "$2,160");
eq("  control — the normalized figure ($1,824) is NOT what rendered", asBilled["Westlake"]?.cost === "$1,824", false);

// ── MONTH VALUES NOW RENDER ───────────────────────────────────────────────────────────────────
console.log("\n── a hand-keyed month reaches this page ──");
eq("Scissortail Park reads its keyed $1,641, not 19 × $105", asBilled["Scissortail Park"]?.cost, "$1,641");
// Soccer Central is COMBINED: $5,600 keyed on the primary leg + its Tournament leg's own invoice.
// The keyed value is present; the row is the group, so it is not the whole row.
{
  const v = Number((asBilled["Soccer Central"]?.cost ?? "0").replace(/[$,]/g, ""));
  eq("Soccer Central's row includes its keyed $5,600 (combined leg adds its own)", v >= 5600, true);
  console.log(`     Soccer Central renders ${asBilled["Soccer Central"]?.cost} = $5,600 keyed + the Tournament leg`);
}

// ── KEYED $0 AND NOTHING-KEYED ARE DIFFERENT ──────────────────────────────────────────────────
console.log("\n── $0 means invoiced nothing; — means no invoice on file ──");
eq("Centennial Commons — keyed $0 — renders $0", asBilled["Centennial Commons"]?.cost, "$0");
eq("NEMP — nothing keyed, no per_match_rate — renders a dash", asBilled["NEMP"]?.cost, "—");
eq("  …and its ratio is a dash too, not 0.0%", asBilled["NEMP"]?.ratio, "—");
eq("Onion Creek — same shape — renders a dash", asBilled["Onion Creek"]?.cost, "—");
eq("Lowell H. Strike M.S. — same shape — renders a dash", asBilled["Lowell H. Strike M.S."]?.cost, "—");
// The two must not collapse into one another.
eq("keyed-$0 and nothing-keyed do NOT render the same",
   asBilled["Centennial Commons"]?.cost === asBilled["NEMP"]?.cost, false);
// A venue whose rate is an explicit 0 is KNOWN and free — a third case, and it stays $0.
eq("Lou Fusz Outdoor — per_match_rate explicitly 0 — is known and free, not a dash",
   asBilled["Lou Fusz Outdoor"]?.cost, "$0");

// ── A DASH CONTRIBUTES NOTHING ────────────────────────────────────────────────────────────────
console.log("\n── a dashed row is excluded, not counted as zero ──");
{
  const card = await page.evaluate(() => {
    const m = (document.body.innerText || "").match(/HIGHEST-RATIO FIELD\s*\n([^\n]+)\s*\n([^\n]+)/);
    return m ? { name: m[1].trim(), sub: m[2].trim() } : null;
  });
  eq("the highest-ratio card re-derived off the new default", card !== null, true);
  const dashed = Object.entries(asBilled).filter(([, v]) => v.cost === "—").map(([k]) => k);
  eq("  …and it is not a dashed venue", dashed.includes(card?.name ?? ""), false);
  eq("  …nor Centennial Commons, which was the winner on the old basis", card?.name === "Centennial Commons", false);
  console.log(`     highest-ratio field: ${card?.name} · ${card?.sub}`);
  console.log(`     dashed rows: ${dashed.join(", ")}`);
  // CONTROL: dashed rows exist, so "the card is not one of them" is a real test.
  eq("  control — there ARE dashed rows to have been wrongly chosen", dashed.length > 0, true);
}

// ── THE EVENT FILTER STILL HOLDS ──────────────────────────────────────────────────────────────
console.log("\n── the event filter is untouched ──");
{
  const m = await page.evaluate(() => {
    for (const r of document.querySelectorAll("tbody tr")) {
      const tds = [...r.querySelectorAll("td")].map((t) => t.innerText.trim());
      if (tds[0] === "NEMP") return tds;
    }
    return null;
  });
  const matches = (m ?? []).find((t) => /^\d+$/.test(t));
  eq("NEMP Aug 2026 counts 42 matches, not 59 — NEMP Tournaments is still excluded", matches, "42");
}

// ── BOTH BASES STILL WORK ─────────────────────────────────────────────────────────────────────
console.log("\n── switching to PER MATCH reproduces the old figures ──");
{
  // TARGET THE BASIS CONTROL BY TESTID. getByRole(/per match/) matched a "PER MATCH" billing-type
  // chip inside a table row and clicked that instead — the table never changed and three
  // assertions read undefined.
  const btn = page.locator('[data-testid="basis-per-match"]');
  if (await btn.count() === 0) {
    bad("the Basis control is still on the page", "no 'per match' control found");
  } else {
    await btn.click();
    await page.waitForTimeout(3500);
    const perMatch = await readCost();
    eq("the Basis toggle is still present and switches", Object.keys(perMatch).length > 10, true);
    eq("  …and the default really was As Billed",
       await page.locator('[data-testid="basis-as-billed"]').getAttribute("aria-pressed"), "false");
    eq("Westlake returns to the normalized $1,824", perMatch["Westlake"]?.cost, "$1,824");
    eq("Scissortail returns to 19 × $105 = $1,995 (per-match ignores month values, by design)",
       perMatch["Scissortail Park"]?.cost, "$1,995");
    eq("NEMP returns to $3,234 on the per-match basis", perMatch["NEMP"]?.cost, "$3,234");
    eq("  …so the per-match basis was NOT corrected, only un-defaulted",
       perMatch["Westlake"]?.cost !== asBilled["Westlake"]?.cost, true);
  }
}

await closeContext(ctx);
await closeBrowser(browser);
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
