// Match Ops mobile verification harness — NOTCH MODE.
//
// A plain Playwright mobile viewport has no status bar / notch / home
// indicator: env(safe-area-inset-*) resolves to 0, so a safe-area defect is
// invisible to it BY CONSTRUCTION. This harness forces a notch by overriding
// the --sat/--sab CSS variables (the app routes every inset through them) and
// paints the OS-owned bands so a screenshot shows any violation. Then it
// HIT-TESTS the status band for tappable content, measures dead space at the
// bottom, and taps the section pills at their REAL coordinates (page.click
// auto-scrolls into view — a thumb does not).
//
// Run: BASE=http://localhost:3000 node scripts/matchops-mobile-harness.mjs
// (.env.local must be sourced for the Supabase admin session.)

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = (process.env.CLAUDE_JOB_DIR || ".") + "/tmp";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const ref = url.replace("https://", "").split(".")[0];
const admin = createClient(url, svc, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const cli = createClient(url, anon, { auth: { persistSession: false } });
const { data: sess } = await cli.auth.verifyOtp({ type: "email", token_hash: link.properties.hashed_token });
const storage = JSON.stringify(sess.session);

const NOTCH = { sat: 59, sab: 34 };
const PHONES = [
  { name: "390x844", width: 390, height: 844 },
  { name: "360x780", width: 360, height: 780 },
];

const notchInit = (n) => {
  addEventListener("DOMContentLoaded", () => {
    document.documentElement.style.setProperty("--sat", n.sat + "px");
    document.documentElement.style.setProperty("--sab", n.sab + "px");
    const mk = (side, px, label) => {
      const d = document.createElement("div");
      d.className = "osband";
      d.style.cssText = `position:fixed;left:0;right:0;${side}:0;height:${px}px;z-index:99999;pointer-events:none;background:rgba(226,80,43,.22);font:700 10px/${px}px sans-serif;color:#7a2410;text-align:center`;
      d.textContent = label;
      document.body.appendChild(d);
    };
    mk("top", n.sat, "iOS STATUS BAR — NOTHING TAPPABLE MAY SIT HERE");
    mk("bottom", n.sab, "HOME INDICATOR");
  });
};

async function newPage(browser, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [`sb-${ref}-auth-token`, storage]);
  await ctx.addInitScript(notchInit, NOTCH);
  return ctx;
}

// Fail fast: a missing control should not burn the 30s default and stall the
// whole run — every interactive step is wrapped in .catch already.
const ACTION_TIMEOUT = 6000;

// HIT-TEST the status band: sample elementFromPoint across it and collect any
// hit whose closest tappable ancestor is real (not the painted .osband).
async function probes(page, sat) {
  return page.evaluate((sat) => {
    const W = window.innerWidth;
    const hits = new Set();
    for (let y = 2; y < sat; y += 6) {
      for (let x = 6; x < W; x += 12) {
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        const tap = el.closest("button,input,a,[onclick],textarea,[role=button]");
        if (tap && !tap.classList.contains("osband")) {
          hits.add((tap.tagName + "." + (tap.className || "").toString().split(" ")[0]).slice(0, 40));
        }
      }
    }
    const navEl = document.querySelector('nav[aria-label="Primary"]');
    const composer = document.querySelector("textarea")?.closest("div[class]");
    const bottomEl = navEl && navEl.getBoundingClientRect().height > 0 ? navEl : composer;
    const deadBottom = bottomEl ? Math.round(window.innerHeight - bottomEl.getBoundingClientRect().bottom) : null;
    const pills = [...document.querySelectorAll("button")]
      .filter((b) => {
        const t = (b.textContent || "").trim();
        return /Master Schedule|Match Chats|Player Chats|Field Pipeline|Field Ops|Review/.test(t) && b.getBoundingClientRect().height > 0 && b.getBoundingClientRect().width < 300;
      })
      .map((b) => {
        const r = b.getBoundingClientRect();
        return { label: (b.textContent || "").trim().slice(0, 16), cx: Math.round(r.left + r.width / 2), off: r.left + r.width / 2 < 0 || r.left + r.width / 2 > W };
      });
    return { underStatusBar: [...hits], deadBottom, pills, hOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  }, sat);
}

const results = [];
async function state(browser, name, vp, path, action) {
  const ctx = await newPage(browser, vp);
  const page = await ctx.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT);
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("[pageerror] " + e.message));
  await page.goto(BASE + path, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (action) await action(page).catch((e) => console.log(`  (action skipped: ${String(e).split("\n")[0]})`));
  const p = await probes(page, NOTCH.sat);
  await page.screenshot({ path: `${OUT}/notch_${name}.png` });
  const line = { state: name, vp: vp.name, underStatusBar: p.underStatusBar, deadBottom: p.deadBottom, hOverflow: p.hOverflow, pillsOff: p.pills.filter((x) => x.off).map((x) => x.label), errs: errs.length };
  results.push(line);
  console.log(JSON.stringify(line));
  await ctx.close();
}

const browser = await chromium.launch();

for (const vp of PHONES) {
  await state(browser, `chats_list_${vp.width}`, vp, "/match-ops/match-chats");
  await state(browser, `chats_scrolled_${vp.width}`, vp, "/match-ops/match-chats", async (p) => {
    await p.evaluate(() => { const el = document.querySelector(".overflow-y-auto"); if (el) el.scrollTop = 400; });
    await p.waitForTimeout(400);
  });
  await state(browser, `players_${vp.width}`, vp, "/match-ops/player-chats");
  await state(browser, `section_sheet_${vp.width}`, vp, "/match-ops/match-chats", async (p) => {
    await p.getByRole("button", { name: "All Match Ops sections" }).click();
    await p.waitForTimeout(600);
  });
  await state(browser, `filter_${vp.width}`, vp, "/match-ops/match-chats", async (p) => {
    await p.getByRole("button", { name: /All cities|cities/ }).first().click().catch(() => {});
    await p.waitForTimeout(500);
  });
  await state(browser, `thread_${vp.width}`, vp, "/match-ops/match-chats", async (p) => {
    await p.locator("button").filter({ hasText: /:/ }).first().click().catch(() => {});
    await p.waitForTimeout(3000);
  });
}

// TAB-SWITCH TRAIL — real touch taps at each pill's true centre (page.click
// auto-scrolls; a thumb does not). The pills navigate to separate ROUTES, so
// each tap is checked by the URL it lands on, and the console is reloaded
// before the next tap. Every tap must land on its section's route AND its pill
// centre must be a real (non-status-bar) coordinate. Run twice.
console.log("=== TAB SWITCH TRAIL (touchscreen.tap, 390x844 notch) ===");
{
  const targets = [
    { name: "Player Chats", slug: "/match-ops/player-chats" },
    { name: "Master Schedule", slug: "/match-ops/master-schedule" },
    { name: "Field Ops", slug: "/match-ops/field-ops" },
  ];
  const trail = [];
  const ctx = await newPage(browser, PHONES[0]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT);
  for (let round = 0; round < 2; round++) {
    for (const t of targets) {
      await page.goto(BASE + "/match-ops/match-chats", { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(2500);
      const pill = page.getByRole("button", { name: t.name, exact: false }).first();
      await pill.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(400);
      const box = await pill.boundingBox().catch(() => null);
      let landed = "(no box)";
      if (box && box.y > NOTCH.sat) {
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(2200);
        landed = new URL(page.url()).pathname;
      } else if (box) {
        landed = `(under status bar y=${Math.round(box.y)})`;
      }
      trail.push({ tapped: t.name, expect: t.slug, landed, ok: landed === t.slug });
    }
  }
  console.log(JSON.stringify(trail, null, 1));
  console.log("tab-switch: " + (trail.every((x) => x.ok) ? "ALL TAPS LANDED" : "FAILURES PRESENT"));
  await ctx.close();
}

console.log("=== SUMMARY ===");
const bad = results.filter((r) => r.underStatusBar.length || r.deadBottom !== 0 || r.hOverflow !== 0 || r.errs);
console.log(bad.length ? "VIOLATIONS:\n" + JSON.stringify(bad, null, 1) : "all states clean: underStatusBar [] · deadBottom 0 · hOverflow 0 · no errors");
await browser.close();
process.exit(0);
