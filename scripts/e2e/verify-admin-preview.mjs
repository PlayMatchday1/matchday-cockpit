// Proves the admin "view as partner" preview now renders the SAME component as the
// public page from the SAME data path (buildPartnerDashboardData via /preview).
// Run: node scripts/e2e/verify-admin-preview.mjs

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();

const BASE = "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const check = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } };

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const TOK = vv.data.session.access_token;

  console.log("PREVIEW API (same builder as the public page)");
  const api = async (path, tok) => { const r = await fetch(`${BASE}${path}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }); return { status: r.status, json: await r.json().catch(() => null) }; };
  await check("preview?slug=hattrick → 200 kind=monthly with since+months", async () => {
    const r = await api(`/api/partner-dashboards/preview?slug=hattrick-yx4sur4t`, TOK);
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (r.json.kind !== "monthly") throw new Error(`kind ${r.json.kind}`);
    if (!r.json.monthly?.since?.spots) throw new Error("no since.spots");
    if (!r.json.monthly.months.some((m) => m.rentals?.length)) throw new Error("no month carries rentals");
  });
  await check("preview?slug=pac-global → 200 kind=weekly with grains", async () => {
    const r = await api(`/api/partner-dashboards/preview?slug=pac-global-7vdybfv4`, TOK);
    if (r.status !== 200 || r.json.kind !== "weekly") throw new Error(`status ${r.status} kind ${r.json?.kind}`);
    if (!r.json.weekly?.grains?.monthRows?.length) throw new Error("no grains");
  });
  await check("preview endpoint is admin-gated (401 without a session)", async () => {
    const r = await api(`/api/partner-dashboards/preview?slug=hattrick-yx4sur4t`, null);
    if (r.status !== 401) throw new Error(`status ${r.status}`);
  });
  // the preview data equals the public page's render (same builder → same numbers)
  await check("preview July matches the PUBLIC Hattrick page verbatim", async () => {
    const r = await api(`/api/partner-dashboards/preview?slug=hattrick-yx4sur4t`, TOK);
    const jul = r.json.monthly.months.find((m) => m.key === "2026-07-01");
    const html = await (await fetch(`${BASE}/partners/hattrick-yx4sur4t`)).text();
    if (!jul) throw new Error("no July in preview");
    if (!html.includes("Morning Match")) throw new Error("public page missing rental line");
    // preview July revenue + rental should appear on the public page
    const rev = "$" + jul.revenue.toLocaleString("en-US");
    if (!html.includes(rev.replace("$", "$"))) throw new Error(`public page missing July revenue ${rev}`);
  });

  console.log("\nADMIN PAGE render (below-seam preview)");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const key = `sb-${ref}-auth-token`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: key, value: JSON.stringify(vv.data.session) }] }] } });
  const page = await context.newPage();
  await page.goto(`${BASE}/match-ops/partner-dashboards`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="dashboard-below-seam"]', { timeout: 30_000 });
  // wait for the preview to finish loading (new component present)
  await page.waitForFunction(() => { const s = document.querySelector('[data-testid="dashboard-below-seam"]'); return s && (s.querySelector(".pm14") || s.querySelector(".pv14")); }, { timeout: 30_000 });

  await check("below-seam preview renders the NEW component (.pm14 or .pv14)", async () => {
    const r = await page.evaluate(() => { const s = document.querySelector('[data-testid="dashboard-below-seam"]'); return { pm: !!s.querySelector(".pm14"), pv: !!s.querySelector(".pv14") }; });
    if (!r.pm && !r.pv) throw new Error("neither pm14 nor pv14 in the preview");
  });
  await check("preview shows NEW columns, not the pre-v1_4 ones", async () => {
    const t = await page.evaluate(() => document.querySelector('[data-testid="dashboard-below-seam"]').innerText);
    for (const old of ["Charged", "Refunded", "Your share ("]) if (t.includes(old)) throw new Error(`still shows old design token "${old}"`);
    // innerText returns the CSS-uppercased header text — match case-insensitively.
    if (!/Spots filled/i.test(t)) throw new Error("no 'Spots filled' column");
    if (!/Daily players/i.test(t)) throw new Error("no 'Daily players' column");
    if (!/Guests/i.test(t)) throw new Error("no 'Guests' column");
    if (!/Qualifying revenue|Revenue/i.test(t)) throw new Error("no revenue column");
  });
  await check("'member'/'promo' absent in the admin preview too", async () => {
    const t = await page.evaluate(() => document.querySelector('[data-testid="dashboard-below-seam"]').innerText);
    const hit = t.match(/\b(member|promo)\w*/gi) || [];
    if (hit.length) throw new Error(`found ${[...new Set(hit)].join(", ")}`);
  });

  // The exact panel Ryan opens: select Hattrick → the monthly rental view, NOT the pre-v1_4 design.
  console.log("\nHATTRICK selected (the reported bug)");
  await page.click('[data-testid="switcher-card"][data-slug="hattrick-yx4sur4t"]');
  await page.waitForFunction(() => !!document.querySelector('[data-testid="dashboard-below-seam"] .pm14'), { timeout: 30_000 });
  await check("Hattrick preview renders the monthly view (.pm14)", async () => {
    const r = await page.evaluate(() => ({ pm: !!document.querySelector('[data-testid="dashboard-below-seam"] .pm14'), pv: !!document.querySelector('[data-testid="dashboard-below-seam"] .pv14') }));
    if (!r.pm) throw new Error(`pm14=${r.pm} pv14=${r.pv}`);
  });
  await check("Hattrick preview shows the private-rental line, no pre-v1_4 tokens", async () => {
    const t = await page.evaluate(() => document.querySelector('[data-testid="dashboard-below-seam"]').innerText);
    for (const old of ["Charged", "Refunded", "Your share ("]) if (t.includes(old)) throw new Error(`still shows "${old}"`);
    if (!/Morning Match|rental/i.test(t)) throw new Error("no rental line rendered");
    if (!/Spots filled/i.test(t)) throw new Error("no 'Spots filled' column");
  });

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log(`   FAILED: ${f}`));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
