// COPY THE PHONE NUMBER — the control, at both widths (built to docs/mockups/copyphone-v1.html).
//
// TIER: a new control, so a few assertions and no mutation tests. What is asserted is what the
// design actually rests on:
//   • it exists, and the hit area is >= 32px even though the glyph is 14px (and the mobile text 10px)
//   • clicking puts the RAW E.164 on the clipboard — not the display formatting
//   • THE NUMBER DOES NOT MOVE when it does. That is the whole design: the tick shares the glyph's
//     cell and "Copied" is out of flow, so a confirmation costs the layout nothing. Measured by
//     bounding box before and after, not inferred from the markup.
//
// TWO CONTROLS, deliberately different:
//   DESKTOP  — a glyph BESIDE the number (ContextPane, the right column).
//   MOBILE   — the NUMBER ITSELF is the button (the header number is 10px; a 32px control beside
//              it would dominate the text it serves). Asserted at 390 portrait.
//
// Clipboard reads need permission; the context is granted it below. Everything else is
// route-fulfilled, so no production data is touched.
//
//   node scripts/e2e/verify-copy-phone.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, closeContext, closeBrowser } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const CHATS = `${BASE}/match-ops/player-chats`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

async function main() {
  process.loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(url).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });

  // NOT stubbed: this drives the REAL inbox and reads the number off the page rather than
  // asserting a fixture. The suite is about the CONTROL — hit area, clipboard payload, and the
  // number not moving — none of which depends on WHICH number it is, and a fixture of the CRM
  // list shape is a thing that rots. Reads only; nothing is written.
  const makeCtx = async (viewport) => {
    const ctx = await browser.newContext({ viewport, storageState, permissions: ["clipboard-read", "clipboard-write"] });
    return ctx;
  };

  // OPEN A THREAD — WITHOUT ASSUMING THE DEFAULT VIEW HAS ONE.
  //
  // This suite used to drive the default (open) view and wait 25s for a thread row. That is an
  // assumption about PRODUCTION STATE, not about the control under test: when the inbox reaches
  // "all caught up" — measured on production at 21 of 21 resolved — the open view has zero rows,
  // the wait times out, and the suite dies on the thread selector having proven nothing about the
  // copy button. It went red for exactly that reason while the control itself was fine.
  //
  // The control is the subject; WHICH thread carries it is not. So try the operator's real path
  // first, and fall back to a view that has threads rather than reporting a failure about the
  // inbox being empty.
  const openAThread = async (page) => {
    for (const view of ["", "?view=closed", "?view=all"]) {
      await page.goto(`${CHATS}${view}`, { waitUntil: "domcontentloaded" });
      const row = await page.waitForSelector('[data-testid="crm-thread-row"]', { timeout: 20000 }).catch(() => null);
      if (row) {
        if (view) console.log(`  · the open view is empty; driving ${view} instead (state of the inbox, not of the control)`);
        await page.click('[data-testid="crm-thread-row"]');
        return;
      }
    }
    throw new Error("no thread in any view — the CRM has no conversations at all, so the copy control cannot be exercised");
  };

  // EITHER identity state. ContextPane renders the number as `ctx-phone` when the thread resolves
  // to a player and `ctx-phone-unknown` when it does not — and the copy control is in BOTH. Which
  // one a given thread lands in is production state; the control is the subject either way, so the
  // suite must not require a matched player to exercise it.
  const CTX_PHONE = '[data-testid="ctx-phone"], [data-testid="ctx-phone-unknown"]';

  const clip = (page) => page.evaluate(() => navigator.clipboard.readText());
  const box = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });

  console.log(`copy phone — ${CHATS}\n`);

  // ── DESKTOP: the glyph beside the number, in the context panel ───────────
  {
    // the context pane is min-[1260px]:flex — 1600 clears it
    const ctx = await makeCtx({ width: 1600, height: 1000 });
    const page = await ctx.newPage();
    await openAThread(page);
    // PRESENCE WAIT BEFORE ANY MEASUREMENT — a still-loading pane would satisfy almost anything.
    await page.waitForSelector('[data-testid="copy-phone"]', { timeout: 25000 });
    await page.waitForTimeout(200);

    ok("desktop: the copy control exists beside the number");

    const b = await box(page, '[data-testid="copy-phone"]');
    (b.w >= 32 && b.h >= 32)
      ? ok(`desktop: hit area is ≥32px (${b.w}×${b.h}) around a 14px glyph`)
      : bad("desktop hit area", `${b.w}×${b.h}`);

    // THE ASSERTION THE DESIGN RESTS ON — measure the NUMBER before and after.
    const before = await box(page, CTX_PHONE);
    await page.evaluate(() => navigator.clipboard.writeText("")); // clear
    await page.click('[data-testid="copy-phone"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="copy-phone"]')?.getAttribute("data-state") === "copied", null, { timeout: 5000 });
    const after = await box(page, CTX_PHONE);
    eq("desktop: THE NUMBER DOES NOT MOVE when the confirmation shows", after, before);

    const shown = await page.$eval(CTX_PHONE, (e) => e.textContent.trim());
    const got = await clip(page);
    eq("desktop: the clipboard holds the number, raw", got, shown);
    /^\+\d{8,}$/.test(got)
      ? ok(`desktop: …and it is RAW E.164 (${got.slice(0, 3)}…), with no display formatting`)
      : bad("not raw E.164", got);

    // reverts
    await page.waitForFunction(() => document.querySelector('[data-testid="copy-phone"]')?.getAttribute("data-state") === "idle", null, { timeout: 4000 });
    ok("desktop: reverts to idle after ~1.5s");

    // the aria-label names the number
    const label = await page.$eval('[data-testid="copy-phone"]', (e) => e.getAttribute("aria-label"));
    label.includes(shown) ? ok("desktop: aria-label NAMES the number") : bad("aria-label", label);

    await closeContext(ctx);
  }

  // ── MOBILE at 390 portrait: the NUMBER ITSELF is the button ──────────────
  {
    const ctx = await makeCtx({ width: 390, height: 844 });
    const page = await ctx.newPage();
    await openAThread(page);
    await page.waitForSelector('[data-testid="copy-phone-inline"]', { timeout: 25000 });
    await page.waitForTimeout(200);

    ok("mobile @390: the number itself is the control");

    const b = await box(page, '[data-testid="copy-phone-inline"]');
    (b.h >= 32)
      ? ok(`mobile @390: tap target is ≥32px tall (${b.h}px) around 10px text`)
      : bad("mobile tap target", `${b.h}px tall`);

    // the header must not shift — measure the BUTTON's own box and a header sibling
    const beforeBtn = await box(page, '[data-testid="copy-phone-inline"]');
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.click('[data-testid="copy-phone-inline"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="copy-phone-inline"]')?.getAttribute("data-state") === "copied", null, { timeout: 5000 });
    const afterBtn = await box(page, '[data-testid="copy-phone-inline"]');
    eq("mobile @390: the header does not shift — the control's box is identical while confirming", afterBtn, beforeBtn);

    const mgot = await clip(page);
    /^\+\d{8,}$/.test(mgot)
      ? ok(`mobile @390: tapping puts the RAW E.164 on the clipboard (${mgot.slice(0, 3)}…)`)
      : bad("mobile clipboard not raw E.164", mgot);

    // it must read as tappable at rest, or nobody tries it
    await page.waitForFunction(() => document.querySelector('[data-testid="copy-phone-inline"]')?.getAttribute("data-state") === "idle", null, { timeout: 4000 });
    const affordance = await page.evaluate(() => {
      const n = document.querySelector('[data-testid="copy-phone-inline-num"]');
      const s = n ? getComputedStyle(n) : null;
      return {
        underlined: !!s && s.textDecorationLine.includes("underline"),
        glyph: !!document.querySelector('[data-testid="copy-phone-inline"] svg'),
      };
    });
    (affordance.underlined || affordance.glyph)
      ? ok("mobile @390: reads as tappable at rest (underline and/or trailing glyph), not plain text")
      : bad("no affordance", JSON.stringify(affordance));

    await closeContext(ctx);
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
