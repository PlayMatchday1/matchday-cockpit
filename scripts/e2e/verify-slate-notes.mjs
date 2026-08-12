// Phase 26 — Slate Review notes PERSIST (table slate_notes, migration 0119, route /api/slate-notes).
//
// This suite deliberately hits the REAL route and the REAL table: the whole claim is "it survives a
// reload", and a mocked API would prove nothing about that. It is made safe by a per-run MARKER
// baked into every string it types — setup and teardown hard-delete only rows carrying that marker,
// so a real Austin note sitting in the box is never touched.
//   node scripts/e2e/verify-slate-notes.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const SLATE = `${BASE}/match-ops/slate-review`;
const CITY = "Austin"; // the page's default chip
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const MARK = `E2E${Date.now()}`;
const NOTE_TXT = `${MARK} chase the Crossbar invoice`;   // no day+time => a NOTE, kept verbatim
const PROP_TXT = `8PM thurs Crossbar ${MARK}`;           // day + time + field => a PROPOSAL

// Everything except the notes route is stubbed, so the page renders without waiting on the real
// match/finance reads. /api/slate-notes is deliberately NOT stubbed.
async function routes(ctx) {
  await ctx.route("**/rest/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await ctx.route(/\/api\/(?!slate-notes)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  // app_users must reach the REAL table — the client-side access check reads it, and the blanket
  // rest/v1 stub above would answer [] and bounce us to /login?error=not_authorized.
  // (Playwright matches the most recently registered route first, so this wins.)
  await ctx.route("**/rest/v1/app_users*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    return route.fulfill({ status: res.status(), contentType: "application/json", body: await res.text() });
  });
}

const rows = (page) => page.$$eval('[data-testid="slate-note-row"]', (els) => els.map((e) => ({
  kind: e.getAttribute("data-kind"),
  text: e.querySelector("span:nth-child(2)")?.innerText?.trim() ?? "",
  // the raw line ALONE — `text` also carries the week tag and the author, so it can't be
  // compared against what was typed
  raw: e.querySelector('[data-testid="slate-note-raw"]')?.innerText?.trim() ?? "",
  week: e.querySelector('[data-testid="slate-note-week"]')?.textContent?.trim() ?? "",
  who: e.querySelector('[data-testid="slate-note-who"]')?.textContent?.trim() ?? "",
})));
const mine = async (page) => (await rows(page)).filter((r) => r.text.includes(MARK));

async function openSlate(page) {
  await page.goto(SLATE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="slate-note-input"]', { timeout: 25000 });
  // the list has finished its load (the "Loading notes…" line is gone)
  await page.waitForFunction(() => !document.body.innerText.includes("Loading notes…"), null, { timeout: 15000 });
}
async function type(page, text) {
  await page.fill('[data-testid="slate-note-input"]', text);
  await page.click('[data-testid="slate-note-add"]');
  // CONFIRM THEN APPEND — wait for the row the server returned, never an optimistic one
  await page.waitForFunction((t) => [...document.querySelectorAll('[data-testid="slate-note-row"]')].some((e) => e.innerText.includes(t)), text.slice(0, 24), { timeout: 15000 });
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const wipe = () => svc.from("slate_notes").delete().like("raw", `%${MARK}%`);
  await wipe();

  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState });
    await routes(ctx);
    const page = await ctx.newPage();
    await openSlate(page);

    // ── GATE 1 — add a note, reload, still there ──────────────────────────────
    await type(page, NOTE_TXT);
    await openSlate(page); // full reload
    eq("gate1: a note survives a reload, verbatim, tagged with who added it", await mine(page).then((r) => {
      const n = r.find((x) => x.kind === "note");
      return { found: !!n, verbatim: n?.raw === NOTE_TXT, who: n?.who || "" };
    }), { found: true, verbatim: true, who: "rmancuso" });

    // ── GATE 2 — add a proposal, reload, right day / time / field ─────────────
    await type(page, PROP_TXT);
    await openSlate(page);
    eq("gate2: a proposal survives a reload with the right day, time and field", await page.$$eval('[data-testid="slate-proposal"]', (els, m) => {
      const e = els.find((x) => x.innerText.includes(m));
      return e ? { day: e.getAttribute("data-day"), text: e.innerText.replace(/\s+/g, " ").trim() } : null;
    }, MARK), { day: "Thu", text: `8:00 PM Crossbar ${MARK} NEW` });
    // and the raw text is stored next to the parse, so a mis-parse stays reviewable
    eq("gate2b: the proposal row shows the RAW typed text alongside the parse", await mine(page).then((r) => {
      const p = r.find((x) => x.kind === "proposal");
      return { day: !!p?.text.includes("Thu 8:00 PM"), raw: !!p?.text.includes(`typed: “${PROP_TXT}”`) };
    }), { day: true, raw: true });

    // ── GATE 3 — change week: the note stays (tagged); the proposal does not ──
    const weekTagBefore = (await mine(page)).find((r) => r.kind === "note")?.week ?? "";
    await page.click('button[aria-label="Next week"]');
    await page.waitForTimeout(400);
    eq("gate3: changing week keeps the NOTE (same week tag) and drops the PROPOSAL", await mine(page).then((r) => ({
      kinds: r.map((x) => x.kind).sort(),
      tagUnchanged: (r.find((x) => x.kind === "note")?.week ?? "") === weekTagBefore,
      tagged: /^week of \w+ \d+$/.test(r.find((x) => x.kind === "note")?.week ?? ""),
    })), { kinds: ["note"], tagUnchanged: true, tagged: true });
    eq("gate3b: no proposal chip renders on the other week either", await page.$$eval('[data-testid="slate-proposal"]', (els, m) => els.filter((e) => e.innerText.includes(m)).length, MARK), 0);

    // ── GATE 5 — layout at 1600 and 390 (asserted before the delete empties it) ──
    const layout = async (w) => {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(250);
      return page.evaluate(() => {
        const de = document.documentElement;
        const inp = document.querySelector('[data-testid="slate-note-input"]').getBoundingClientRect();
        const btn = document.querySelector('[data-testid="slate-note-add"]').getBoundingClientRect();
        const row = document.querySelector('[data-testid="slate-note-row"]')?.getBoundingClientRect();
        return {
          overflow: de.scrollWidth - de.clientWidth,
          // input + Add sit in ONE band (a wrapped Add button is the failure this catches)
          oneBand: Math.abs(inp.top - btn.top) < 4,
          rowInside: row ? row.right <= de.clientWidth + 1 : true,
        };
      });
    };
    eq("gate5a: no horizontal overflow at 1600, input + Add on one band, row inside the viewport", await layout(1600), { overflow: 0, oneBand: true, rowInside: true });
    eq("gate5b: no horizontal overflow at 390, input + Add on one band, row inside the viewport", await layout(390), { overflow: 0, oneBand: true, rowInside: true });
    await page.setViewportSize({ width: 1600, height: 1000 });

    // ── GATE 4 — delete removes it, and it stays gone after reload ────────────
    // Reload FIRST: gate 3 left us on the next week, where the proposal is hidden. Deleting only
    // what happens to be on screen would leave it in the table and call that a pass.
    await openSlate(page);
    let guard = 0;
    for (;;) {
      const row = await page.$(`[data-testid="slate-note-row"]:has-text("${MARK}")`);
      if (!row || guard++ > 10) break;
      await row.$eval('[data-testid="slate-note-delete"]', (b) => b.click());
      await page.waitForTimeout(600);
    }
    const goneNow = (await mine(page)).length;
    await openSlate(page); // and it stays gone across a reload
    const dbLeft = await svc.from("slate_notes").select("id").like("raw", `%${MARK}%`);
    eq("gate4: delete removes both rows, they stay gone after reload, and the table rows are HARD deleted",
      { goneNow, afterReload: (await mine(page)).length, inDb: (dbLeft.data ?? []).length }, { goneNow: 0, afterReload: 0, inDb: 0 });

    await ctx.close();
  } finally {
    await wipe();
    await browser.close();
  }

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log(fails.map((f) => `  ✗ ${f}`).join("\n")); process.exit(1); }
}

main().catch(fatal);
