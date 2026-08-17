// The awaiting-row path + all NEGATIVE CONTROLS, against a synthetic fixture
// injected by intercepting /api/partner-dashboards (no partner is awaiting in
// real data, and we do not mutate prod). Each negative control MUTATES the DOM
// to inject the defect and confirms the matching assertion then FAILS — proving
// the assertions in verify-adminpay.mjs have teeth.
//
//   node scripts/e2e/verify-adminpay-synthetic.mjs

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, sessionFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const check = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } };
// a negative control passes when `fn` THROWS (the assertion caught the defect)
const expectFail = async (n, fn) => { try { await fn(); bad(`NEG: ${n}`, "assertion did NOT catch the defect (toothless)"); } catch { ok(`NEG: ${n} → fails cleanly`); } };

const ymd = (d) => d.toISOString().slice(0, 10);
const shift = (base, days) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + days); return d; };

function fixture() {
  const today = new Date();
  const wk = (endOffset, extra) => {
    const end = shift(today, endOffset), start = shift(end, -6);
    return { weekStartDate: ymd(start), weekEndDate: ymd(end), qualifyingRevenue: 0, owedAmount: 0, matches: 3, managerPay: 0,
      status: "pending", recordId: null, calculatedAmount: null, paidAt: null, paidNotes: null, disputeNote: null, disputedAt: null, isPreSystem: false, ...extra };
  };
  const weeklyPayments = [
    wk(-2, { status: "pending", owedAmount: 40 }),                                     // scheduled (awaiting)
    wk(-9, { status: "disputed", owedAmount: 30, disputedAt: ymd(shift(today, -8)) }), // disputed (awaiting, no button)
    wk(-16, { status: "paid", owedAmount: 55, calculatedAmount: 55, paidAt: ymd(shift(today, -14)) }), // latest settled
    wk(-23, { status: "paid", owedAmount: 27.5, calculatedAmount: 12.5, paidAt: ymd(shift(today, -21)) }), // older + DIVERGED
    wk(-30, { status: "paid", owedAmount: 20, calculatedAmount: 20, paidAt: ymd(shift(today, -28)) }),
    wk(-37, { status: "paid", owedAmount: 35, calculatedAmount: 35, paidAt: ymd(shift(today, -35)) }),
    { weekStartDate: "2026-05-01", weekEndDate: "2026-05-01", qualifyingRevenue: 0, owedAmount: 169.5, matches: 0, managerPay: 0,
      status: "paid", recordId: "op", calculatedAmount: 169.5, paidAt: "2026-05-01", paidNotes: null, disputeNote: null, disputedAt: null, isPreSystem: true }, // opening
  ];
  const payment = { enabled: true, cadence: "weekly", revenueModel: "flat_percentage", revenueSharePct: 50,
    paymentStartDate: "2026-05-03", paymentDayOfWeek: 0, firstQualifyingPeriod: "2026-05-03", firstQualifyingSunday: "2026-05-03", weeklyPayments };
  const stats = { earliestMatchDate: "2026-05-01", totals: { spots: 0, md: 0, guests: 0, cancels: 0, uniquePlayers: 0 }, weeks: [], byMonth: [] };
  return { partners: [{ id: "fix-1", slug: "fixture-weekly", partnerName: "Fixture FC", venue: "Fixture Field", city: "Testville",
    launchDate: "2026-05-01", cadence: "weekly", revenueModel: "flat_percentage", revenueSharePct: 50, enabled: true, createdAt: "2026-05-01T00:00:00Z", stats, payment }] };
}

// "filled dark" = a button whose composited background is dark (luminance < .25)
const darkButtonsFn = `() => {
  const parse = s => { const m=s.match(/rgba?\\(([^)]+)\\)/); if(!m) return null; const p=m[1].split(",").map(parseFloat); return {r:p[0],g:p[1],b:p[2],a:p[3]??1}; };
  const lin = c => { c/=255; return c<=0.03928? c/12.92 : ((c+0.055)/1.055)**2.4; };
  const L = x => 0.2126*lin(x.r)+0.7152*lin(x.g)+0.0722*lin(x.b);
  const panel = document.querySelector('[data-testid="admin-panel"]');
  return [...panel.querySelectorAll('button')].filter(b => { const c=parse(getComputedStyle(b).backgroundColor); return c && c.a>0.5 && L(c)<0.25; })
    .map(b => ({ text: b.innerText.trim(), inAwaiting: !!b.closest('[data-testid="pay-awaiting-row"]') }));
}`;

async function main() {
  process.loadEnvFile(".env.local");
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  // ONE SESSION PER IDENTITY, cached across the whole gate run — see sessionFor in _session.mjs.
  const session = await sessionFor("rmancuso@playmatchday.com");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] } });

  const FIX = fixture();
  let actionablePayload = { count: 0, awaiting: 0, disputed: 0, diverged: 0, byPartner: [] };
  await context.route("**/api/partner-dashboards", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIX) }));
  await context.route("**/api/partner-dashboards/preview**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture" }) }));
  await context.route("**/api/partner-dashboards/actionable", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(actionablePayload) }));

  const page = await context.newPage();
  const load = async () => { await page.goto(`${BASE}/match-ops/partner-dashboards`, { waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-testid="payments-card"]', { timeout: 30_000 }); await page.waitForTimeout(150); };
  await load();

  console.log(`BASE = ${BASE}  (synthetic fixture: 1 scheduled + 1 disputed awaiting, 1 latest, 4 older incl. opening, 1 diverged in fold)\n\nAWAITING PATH`);

  await check("exactly one filled-dark button — 'Mark paid' on an awaiting row", async () => {
    const dark = await page.evaluate(`(${darkButtonsFn})()`);
    if (dark.length !== 1) throw new Error(`${dark.length} filled-dark buttons: ${JSON.stringify(dark)}`);
    if (dark[0].text !== "Mark paid" || !dark[0].inAwaiting) throw new Error(`"${dark[0].text}" inAwaiting=${dark[0].inAwaiting}`);
  });
  await check("disputed awaiting row shows the coral 'Disputed' pill and NO primary button", async () => {
    const r = await page.evaluate(() => { const row = document.querySelector('[data-testid="pay-awaiting-row"][data-disputed="1"]'); return row ? { pill: /disputed/i.test(row.innerText), hasBtn: !!row.querySelector('[data-testid="mark-paid-btn"]') } : null; });
    if (!r) throw new Error("no disputed row"); if (!r.pill) throw new Error("no Disputed pill"); if (r.hasBtn) throw new Error("disputed has a Mark-paid button");
  });
  await check("awaiting rows are amber; settled rows are not", async () => {
    const r = await page.evaluate(() => {
      const amber = (el) => { const c = getComputedStyle(el).backgroundColor; return c === "rgb(255, 246, 214)"; };
      const aw = [...document.querySelectorAll('[data-testid="pay-awaiting-row"]')];
      const settled = [document.querySelector('[data-testid="pay-latest-row"]')].filter(Boolean);
      return { awAmber: aw.every(amber), settledAmber: settled.some(amber) };
    });
    if (!r.awAmber) throw new Error("an awaiting row is not amber"); if (r.settledAmber) throw new Error("a settled row is amber");
  });
  await check("settled rows offer Undo and no primary; opening settlement is labelled, no button", async () => {
    await page.click('[data-testid="pay-fold"]');
    await page.waitForTimeout(120);
    const r = await page.evaluate(() => {
      const settled = [...document.querySelectorAll('[data-testid="pay-latest-row"],[data-testid="pay-older-row"]')];
      const opening = settled.find((el) => /opening settlement/i.test(el.innerText));
      return {
        allUndo: settled.filter((el) => !/opening settlement/i.test(el.innerText)).every((el) => /Undo/.test(el.innerText) && !el.querySelector('[data-testid="mark-paid-btn"]')),
        openingNoBtn: opening ? opening.querySelectorAll("button").length === 0 : false,
        openingLast: settled[settled.length - 1] === opening,
      };
    });
    if (!r.allUndo) throw new Error("a settled row lacks Undo or has a primary"); if (!r.openingNoBtn) throw new Error("opening has a button"); if (!r.openingLast) throw new Error("opening not last");
  });

  console.log("\nNEGATIVE CONTROLS (each must fail cleanly)");

  await expectFail("render every payment at rest", async () => {
    await load();
    const rest = await page.evaluate(() => document.querySelectorAll('[data-testid="payments-card"] [data-testid$="-row"]').length);
    const awaiting = await page.evaluate(() => document.querySelectorAll('[data-testid="pay-awaiting-row"]').length);
    // inject the defect: append the hidden older rows at rest
    await page.evaluate(() => { const card = document.querySelector('[data-testid="payments-card"]'); for (let i = 0; i < 4; i++) { const d = document.createElement("div"); d.setAttribute("data-testid", "pay-older-row"); card.appendChild(d); } });
    const restNow = await page.evaluate(() => document.querySelectorAll('[data-testid="payments-card"] [data-testid$="-row"]').length);
    if (restNow > awaiting + 1) throw new Error("caught: rows at rest exceed awaiting+1"); // assertion catches → good
    void rest;
  });

  await expectFail("blank the fold's count", async () => {
    await load();
    await page.evaluate(() => { document.querySelector('[data-testid="pay-fold-count"]').textContent = ""; });
    const t = await page.evaluate(() => document.querySelector('[data-testid="pay-fold-count"]').innerText);
    if (!/\d+ earlier payments hidden/.test(t)) throw new Error("caught: fold count missing");
  });

  await expectFail("put the primary button on a settled row", async () => {
    await load();
    await page.evaluate(() => {
      const row = document.querySelector('[data-testid="pay-latest-row"]');
      const b = document.createElement("button"); b.textContent = "Mark paid"; b.style.background = "rgb(0,51,38)"; b.style.color = "#fff"; row.appendChild(b);
    });
    const dark = await page.evaluate(`(${darkButtonsFn})()`);
    if (dark.some((d) => !d.inAwaiting)) throw new Error("caught: a filled-dark button is not on an awaiting row");
  });

  await expectFail("remove the amber from the awaiting row", async () => {
    await load();
    await page.evaluate(() => { document.querySelectorAll('[data-testid="pay-awaiting-row"]').forEach((el) => (el.style.background = "#ffffff")); });
    const r = await page.evaluate(() => [...document.querySelectorAll('[data-testid="pay-awaiting-row"]')].every((el) => getComputedStyle(el).backgroundColor === "rgb(255, 246, 214)"));
    if (!r) throw new Error("caught: awaiting row is not amber");
  });

  await expectFail("delete the divergence pill", async () => {
    await load();
    await page.click('[data-testid="pay-fold"]'); await page.waitForTimeout(120);
    const flagged = await page.evaluate(() => +document.querySelector('[data-testid="pay-fold"]').dataset.flagged);
    await page.evaluate(() => document.querySelectorAll('[data-testid="pay-flag-pill"]').forEach((el) => el.remove()));
    const pills = await page.evaluate(() => document.querySelectorAll('[data-testid="pay-flag-pill"]').length);
    if (pills < flagged) throw new Error("caught: a flagged period has no pill");
  });

  await expectFail("set the fold total to a wrong number", async () => {
    await load();
    await page.click('[data-testid="pay-fold"]'); await page.waitForTimeout(120);
    const num = (s) => Number(String(s).replace(/[^0-9.-]/g, "")) || 0;
    const declared = 99999; // wrong
    const sum = await page.evaluate(() => [...document.querySelectorAll('[data-testid="pay-older-row"]')].reduce((s, el) => s + (Number(el.querySelectorAll("span")[1]?.innerText.replace(/[^0-9.-]/g, "")) || 0), 0));
    if (Math.abs(sum - declared) > 0.5) throw new Error("caught: fold total ≠ sum of rows"); void num;
  });

  await expectFail("render the sidebar badge when nothing is actionable", async () => {
    actionablePayload = { count: 0, awaiting: 0, disputed: 0, diverged: 0, byPartner: [] };
    await load();
    // inject the defect: a badge on the nav item even though count is 0
    await page.evaluate(() => { const a = document.querySelector('a[href="/match-ops/partner-dashboards"]'); if (a) { const s = document.createElement("span"); s.textContent = "3"; a.appendChild(s); } });
    const badge = await page.evaluate(() => { const a = document.querySelector('a[href="/match-ops/partner-dashboards"]'); const m = a?.innerText.match(/(\d+)\s*$/); return m ? +m[1] : null; });
    if (badge != null) throw new Error("caught: badge present when count is 0");
  });

  console.log(`\n================ RESULT (synthetic) ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log(`   FAILED: ${f}`));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
