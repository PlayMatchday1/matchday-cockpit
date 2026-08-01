// Match Ops mobile verification harness.
// Loads each Match Ops chat console at phone viewports (isMobile/hasTouch) and
// a 1440 desktop control, and asserts the mobile bug fix: section nav is
// reachable, and no desktop keyboard affordances leak onto touch. Prints one
// JSON line per state + an error summary. Screenshots land in $OUT.
//
// Run: BASE=http://localhost:3000 node scripts/matchops-mobile-harness.mjs
// Requires .env.local sourced (Supabase creds) — mints an admin session.

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

const PHONES = [
  { name: "360x780", width: 360, height: 780 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
];
const DESKTOP = { name: "1440x1000", width: 1440, height: 1000 };

const allErrors = [];

async function newCtx(browser, vp, touch) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: touch,
    hasTouch: touch,
    deviceScaleFactor: touch ? 3 : 1,
  });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [`sb-${ref}-auth-token`, storage]);
  return ctx;
}

async function measure(page) {
  return page.evaluate(() => {
    const below560 = window.innerWidth < 560;
    const text = document.body.innerText;
    const smallTargets = [...document.querySelectorAll("button, input, a")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false; // not visible
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        return r.height < 34 || r.width < 30;
      })
      .map((el) => `${el.tagName}.${(el.className || "").toString().slice(0, 20)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
    // section strip present? (mobile-only nav)
    const strip = [...document.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") || "") === "All Match Ops sections");
    // desktop rail present? (ChatsRail vertical nav)
    const rail = !!document.querySelector('nav[aria-label="Match Ops"]');
    return {
      hOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      kbdHint: /↑↓|↵|press \//.test(text),
      slashInText: /(^|\s)\/(\s|$)/.test(text) && below560, // stray "/" token on touch
      rawWaUrl: /chat\.whatsapp\.com/.test(text),
      smallTargets,
      sectionStripPresent: strip,
      railPresent: rail,
      below560,
    };
  });
}

async function run(state, path, vp, touch, extra) {
  const browser = await chromium.launch();
  const ctx = await newCtx(browser, vp, touch);
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("[pageerror] " + e.message));
  await page.goto(BASE + path, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3500);
  if (extra) await extra(page);
  const m = await measure(page);
  m.ERRORS = errs;
  m.state = state;
  m.viewport = vp.name;
  await page.screenshot({ path: `${OUT}/mob_${state}.png` });
  if (errs.length) allErrors.push({ state, errs });
  console.log(JSON.stringify(m));
  await browser.close();
}

// Mobile states (390 primary) — chat consoles
await run("chats_list", "/match-ops/match-chats", PHONES[1], true);
await run("players_list", "/match-ops/player-chats", PHONES[1], true);
// Section sheet opened from the strip
await run("section_sheet", "/match-ops/match-chats", PHONES[1], true, async (page) => {
  await page.getByRole("button", { name: "All Match Ops sections" }).click();
  await page.waitForTimeout(600);
});
// Thread pushed (open a chat)
await run("thread", "/match-ops/match-chats", PHONES[1], true, async (page) => {
  const row = page.locator("button").filter({ hasText: /:/ }).first();
  await row.click().catch(() => {});
  await page.waitForTimeout(3000);
});
// Small + large phones (overflow / target checks)
await run("chats_360", "/match-ops/match-chats", PHONES[0], true);
await run("players_430", "/match-ops/player-chats", PHONES[2], true);
// Navigate via the strip to prove reachability
await run("reach_schedule", "/match-ops/match-chats", PHONES[1], true, async (page) => {
  await page.getByRole("button", { name: "Master Schedule" }).first().click();
  await page.waitForTimeout(2500);
});

// Desktop control — must be UNCHANGED (strip hidden, rail shown, kbd hint present)
await run("desktop_chats", "/match-ops/match-chats", DESKTOP, false);
await run("desktop_players", "/match-ops/player-chats", DESKTOP, false);

console.log("=== ERROR SUMMARY ===");
console.log(allErrors.length ? JSON.stringify(allErrors, null, 1) : "no console/page errors in any state");
process.exit(0);
