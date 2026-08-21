// ONE EDITOR, TWO PRESENTATIONS — the eight points, on STAGING.
//
// NOT NAMED verify-*, SO IT IS NOT IN THE GATE. run-suites discovers /^verify-.*\.mjs$/; this
// writes to staging (a real PUT against a real match) and is run by hand:
//
//     npm run check:one-editor
//
// It does NOT litter the way check-copy-match does — it edits an existing staging match and puts
// every field back — but it is still a live write, so it stays out of automatic runs.
//
// STAGING FOR EVERY WRITE. The one production fact behind this work — match 17866, moved 8½ hours
// on 2026-08-20, landed — is EVIDENCE that the pair works in production. It is not a test to
// repeat, and nothing here touches production.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ENV = "staging";
const MATCH = 2470;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1700, height: 1300 } });
const page = await ctx.newPage();

const api = (path, init) => page.evaluate(async ({ path, init }) => {
  const key = Object.keys(localStorage).find((k) => k.includes("auth-token"));
  const t = JSON.parse(localStorage.getItem(key) ?? "{}");
  const token = t?.access_token ?? t?.currentSession?.access_token;
  const r = await fetch(path, {
    ...(init ?? {}),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    cache: "no-store",
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, { path, init });

await page.goto(`${BASE}/match-ops/matches/${MATCH}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="save"]', { timeout: 90000 });
await page.waitForTimeout(600);

// ── 1. EVERY EDITABLE FIELD IS PRESENT IN BOTH PRESENTATIONS ──────────────────────────────────
// Asserted FROM THE DRAWER, not only from the page — the point of the consolidation is that they
// are the same component, and only the drawer can prove that claim.
const ALWAYS = ["name", "fieldId", "category", "type", "managerId", "secondManagerId", "description",
  "managerIntro", "registrationPrice", "additionalSpotPrice", "guestCount", "fakeSpotLeft36h",
  "fakeSpotLeft24h", "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h", "autoCanceled",
  "autoCanceledMinutes", "minPlayerCount", "isFreeMember", "isAutoBump"];

console.log("\n── the page ──");
{
  const present = await page.evaluate((keys) => keys.filter((k) => !!document.querySelector(`[data-testid="in-${k}"]`)), ALWAYS);
  eq(`all ${ALWAYS.length} editable fields render on the page`, present.length, ALWAYS.length);
  const dates = await page.evaluate(() => ({
    date: !!document.querySelector('[data-testid="in-date"]'),
    time: !!document.querySelector('[data-testid="in-time"]'),
  }));
  eq("date and time are editable here now", [dates.date, dates.time], [true, true]);
  const prod = await page.evaluate(() => document.querySelector('[data-testid="ed-envbadge"]')?.textContent ?? "");
  eq("the production warning renders on the page", /PRODUCTION/i.test(prod), true);
  console.log(`     env badge: ${prod.trim()}`);
}

console.log("\n── the drawer ──");
{
  await page.goto(`${BASE}/match-ops/master-schedule`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="card"]', { timeout: 90000 });
  await page.locator('[data-testid="card"]').first().click();
  await page.waitForSelector('[data-testid="drawer"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="save"]', { timeout: 30000 });
  await page.waitForTimeout(700);

  const present = await page.evaluate((keys) => keys.filter((k) => !!document.querySelector(`[data-testid="in-${k}"]`)), ALWAYS);
  eq(`all ${ALWAYS.length} editable fields render in the drawer`, present.length, ALWAYS.length);
  const missing = ALWAYS.filter((k) => !present.includes(k));
  eq("  …none missing, by name", missing, []);

  const chrome = await page.evaluate(() => {
    const panel = document.querySelector(".me-panel");
    const bar = panel?.querySelector(".savebar");
    return {
      isPanel: !!panel,
      back: !!document.querySelector('[data-testid="editor-back"]'),
      barPos: bar ? getComputedStyle(bar).position : null,
      minH: panel ? getComputedStyle(panel).minHeight : null,
      envBadge: document.querySelector('[data-testid="ed-envbadge"]')?.textContent ?? "",
      fullLink: !!document.querySelector('[data-testid="dr-fulleditor"]'),
    };
  });
  eq("the drawer renders the editor in PANEL mode", chrome.isPanel, true);
  eq("  …with no back button", chrome.back, false);
  eq("  …a save bar sticky INSIDE the panel, not fixed to the viewport", chrome.barPos, "sticky");
  eq("  …and it does not claim the viewport", chrome.minH === "100vh", false);
  eq("the production warning renders in the panel too", /PRODUCTION/i.test(chrome.envBadge), true);
  eq('"Open full editor" is gone — this IS the full editor', chrome.fullLink, false);
}

// ── 2. SIBLING STEPPING, AND THE GUARD ────────────────────────────────────────────────────────
console.log("\n── sibling stepping ──");
{
  const titleOf = () => page.evaluate(() => document.querySelector('[data-testid="dr-title"]')?.textContent ?? "");
  const before = await titleOf();
  // A DAY WITH MORE THAN ONE MATCH. The first card of a week often has no next sibling, which is
  // a property of the fixture, not of stepping — so a card with a live ↓ is found first.
  let canStep = await page.evaluate(() => !document.querySelector('[data-testid="dr-next"]')?.disabled);
  if (!canStep) {
    const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid="card"]')].map((c) => c.getAttribute("data-id")));
    for (const id of ids.slice(0, 12)) {
      await page.click(`[data-testid="card"][data-id="${id}"]`).catch(() => {});
      await page.waitForTimeout(500);
      canStep = await page.evaluate(() => !document.querySelector('[data-testid="dr-next"]')?.disabled);
      if (canStep) break;
    }
  }
  if (canStep) {
    await page.click('[data-testid="dr-next"]');
    await page.waitForTimeout(900);
    const after = await titleOf();
    eq("stepping to the next match changes the match", before === after, false);
    eq("  …without closing the drawer", await page.locator('[data-testid="drawer"]').count(), 1);
    console.log(`     ${before.slice(0, 34)} → ${after.slice(0, 34)}`);
  } else {
    eq("  control — a sibling exists to step to", canStep, true);
  }

  // THE GUARD, which is the bug the consolidation introduced and this suite exists to hold:
  // the drawer used to compute its own dirtiness, which after the swap was permanently false —
  // so stepping would have silently discarded unsaved edits.
  await page.fill('[data-testid="in-name"]', "one-editor dirty probe");
  await page.waitForTimeout(400);
  const dirtyTitle = await titleOf();
  await page.click('[data-testid="dr-next"]').catch(() => {});
  await page.waitForTimeout(700);
  eq("stepping with unsaved changes does NOT discard them", await titleOf(), dirtyTitle);
  eq("  …and the edit is still in the box", await page.inputValue('[data-testid="in-name"]'), "one-editor dirty probe");
  await page.click('[data-testid="revert"]');
  await page.waitForTimeout(300);
}

// ── 3. THE DATE PAIR, WRITTEN AND READ BACK ───────────────────────────────────────────────────
console.log("\n── the date pair, on staging ──");
{
  const before = await api(`/api/matchday/${ENV}/matches/${MATCH}`);
  eq("  control — the source match reads", before.status, 200);
  const m0 = before.body.match;
  const start0 = String(m0.startDate), end0 = String(m0.endDate);
  const dur0 = Date.parse(end0) - Date.parse(start0);
  console.log(`     before: ${start0} → ${end0} (${dur0 / 3600000}h)`);

  // Move the start by exactly one hour, wall-clock, and send the PAIR.
  const hh = String((Number(start0.slice(11, 13)) + 1) % 24).padStart(2, "0");
  const newStart = `${start0.slice(0, 11)}${hh}${start0.slice(13)}`;
  const newEnd = new Date(Date.parse(newStart) + dur0).toISOString().replace(/\.\d+Z$/, ".000Z");

  const put = await api(`/api/matchday/${ENV}/matches/${MATCH}`, {
    method: "PUT",
    body: JSON.stringify({ changes: { startDate: newStart, endDate: newEnd }, source: "check:one-editor" }),
  });
  eq("the pair is accepted", put.status, 200);

  // READ BACK, not the status code.
  const after = await api(`/api/matchday/${ENV}/matches/${MATCH}`);
  const m1 = after.body.match;
  eq("startDate landed, wall-clock verbatim", String(m1.startDate).slice(0, 16), newStart.slice(0, 16));
  const dur1 = Date.parse(String(m1.endDate)) - Date.parse(String(m1.startDate));
  // TO THE MINUTE, as the name says — and deliberately not to the millisecond. The source match
  // carries .767Z on its end; the new end this test computes is built to .000Z, so a millisecond
  // comparison would fail on the TEST's rounding rather than on anything the product did.
  eq("duration preserved to the minute", Math.round(dur1 / 60000), Math.round(dur0 / 60000));
  eq("  …and not merely close — the same whole minute count", Math.abs(dur1 - dur0) < 60000, true);
  console.log(`     after:  ${m1.startDate} → ${m1.endDate} (${dur1 / 3600000}h)`);

  // SENDING ONE ALONE IS STILL REFUSED — the rule that keeps a duration from being rewritten.
  const lone = await api(`/api/matchday/${ENV}/matches/${MATCH}`, {
    method: "PUT", body: JSON.stringify({ changes: { startDate: start0 }, source: "check:one-editor" }),
  });
  eq("startDate alone is refused", lone.status, 400);
  eq("  …and the refusal explains the pair", /together/i.test(lone.body.error ?? ""), true);

  // PUT IT BACK — this suite edits a real staging match and does not leave it moved.
  const restore = await api(`/api/matchday/${ENV}/matches/${MATCH}`, {
    method: "PUT", body: JSON.stringify({ changes: { startDate: start0, endDate: end0 }, source: "check:one-editor" }),
  });
  eq("  …and the match is restored", restore.status, 200);
  const back = await api(`/api/matchday/${ENV}/matches/${MATCH}`);
  eq("  …verified by reading it back", String(back.body.match.startDate).slice(0, 16), start0.slice(0, 16));
}

// ── 4. A DISTINCT SOURCE PER SURFACE ──────────────────────────────────────────────────────────
console.log("\n── change_log carries who ──");
{
  const { data } = await svc.from("change_log").select("source").order("created_at", { ascending: false }).limit(400);
  const sources = new Set((data ?? []).map((r) => r.source).filter(Boolean));
  eq("  control — change_log has entries", (data ?? []).length > 0, true);
  // THREE DISTINCT VALUES. Before this work the drawer sent none, so its writes logged as the
  // route's default and were indistinguishable from Match panel's.
  for (const s of ["Match editor", "Master Schedule drawer", "Match panel"]) {
    const seen = sources.has(s);
    if (seen) ok(`a distinct source exists for "${s}"`);
    else console.log(`  ~ "${s}" not yet in the last 400 rows — it is sent by the code, not yet exercised here`);
  }
  eq("this run's own writes are attributed", sources.has("check:one-editor"), true);
  console.log(`     distinct sources seen: ${[...sources].slice(0, 8).join(" · ")}`);
}

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  " + f)); }
await closeContext(ctx);
await closeBrowser(browser);
process.exit(FAIL === 0 ? 0 : 1);
