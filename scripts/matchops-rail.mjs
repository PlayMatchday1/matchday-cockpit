// Match Ops rail unification harness. Verifies ONE rail component renders on
// every Match Ops route with a byte-identical bounding box, correct height,
// 44px touch targets, no horizontal overflow, and collapse that persists across
// navigation and reload. Screenshots each state.
//
// Run from repo root: node --env-file=.env.local scripts/matchops-rail.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = (process.env.CLAUDE_JOB_DIR || ".") + "/tmp";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY, anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const ref = url.replace("https://", "").split(".")[0];
const sb = createClient(url, svc, { auth: { persistSession: false } });
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const cli = createClient(url, anon, { auth: { persistSession: false } });
const { data: sess } = await cli.auth.verifyOtp({ type: "email", token_hash: link.properties.hashed_token });

const ROUTES = [
  ["master-schedule", "/match-ops/master-schedule"],
  ["match-chats", "/match-ops/match-chats"],
  ["player-chats", "/match-ops/player-chats"],
  ["field-pipeline", "/match-ops/field-pipeline"],
  ["field-ops", "/match-ops/field-ops"],
  ["review", "/match-ops/review"],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, [`sb-${ref}-auth-token`, JSON.stringify(sess.session)]);
// Fresh context → no collapse key → rail defaults expanded. We do NOT wipe the
// key on every load (that would defeat the persistence test below).
const pg = await ctx.newPage();
const errs = [];
pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
pg.on("pageerror", (e) => errs.push("[pageerror] " + e.message));

const probe = () => pg.evaluate(() => {
  const nav = document.querySelector('nav[aria-label="Match Ops"]');
  const r = nav ? nav.getBoundingClientRect() : null;
  // touch targets: rail links + the collapse button
  const targets = nav ? [...nav.querySelectorAll("a, button")] : [];
  const heights = targets.map((t) => Math.round(t.getBoundingClientRect().height)).filter((h) => h > 0);
  // player-chats badge (the span inside the Player Chats link)
  const pcLink = nav ? [...nav.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/match-ops/player-chats") : null;
  const pcBadge = pcLink ? (pcLink.querySelector("span.tabular-nums, span.rounded-full")?.textContent || "").trim() : null;
  // top-nav Match Ops pill
  const topPill = (() => {
    const el = [...document.querySelectorAll("a")].find((a) => /match ops/i.test(a.textContent || "") && a.getAttribute("href") === "/match-ops");
    if (!el) return null;
    const m = (el.textContent || "").match(/(\d+)/);
    return m ? m[1] : null;
  })();
  return {
    box: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    minTouch: heights.length ? Math.min(...heights) : null,
    itemCount: heights.length,
    pcBadge: pcBadge || null,
    topPill,
    vh: window.innerHeight,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

const boxes = {};
for (const [name, path] of ROUTES) {
  await pg.goto(BASE + path, { waitUntil: "load", timeout: 60000 });
  await pg.waitForTimeout(3500);
  const p = await probe();
  boxes[name] = p;
  await pg.screenshot({ path: `${OUT}/mor_${name}.png` });
  console.log(`${name.padEnd(16)} box=${JSON.stringify(p.box)} minTouch=${p.minTouch} items=${p.itemCount} pcBadge=${JSON.stringify(p.pcBadge)} topPill=${JSON.stringify(p.topPill)} vh=${p.vh} overflow=${p.docOverflow}`);
}

// identical-box assertion
const ref0 = boxes["master-schedule"].box;
const allSame = ROUTES.every(([n]) => JSON.stringify(boxes[n].box) === JSON.stringify(ref0));
console.log(`\nASSERT rail box identical on all 6: ${allSame ? "PASS" : "FAIL"} (ref ${JSON.stringify(ref0)})`);
console.log(`ASSERT rail height == viewport - 64 (topnav): ${ref0.h === boxes["master-schedule"].vh - 64 ? "PASS" : "FAIL"} (h=${ref0.h}, vh-64=${boxes["master-schedule"].vh - 64})`);
console.log(`ASSERT rail flush left (x=0) & under top nav (y=64): ${ref0.x === 0 && ref0.y === 64 ? "PASS" : "FAIL"}`);
const minTouch = Math.min(...ROUTES.map(([n]) => boxes[n].minTouch));
console.log(`ASSERT shortest touch target >= 44px: ${minTouch >= 44 ? "PASS" : "FAIL"} (shortest=${minTouch}px)`);
const badges = ROUTES.map(([n]) => boxes[n].pcBadge);
console.log(`ASSERT Player Chats badge identical string on all rails: ${new Set(badges).size === 1 ? "PASS" : "FAIL"} (${JSON.stringify(badges)})`);
console.log(`  (Problem 2) top-nav Match Ops pill = ${JSON.stringify(boxes["master-schedule"].topPill)} vs rail badge = ${JSON.stringify(badges[0])}`);
const maxOverflow = Math.max(...ROUTES.map(([n]) => boxes[n].docOverflow));
console.log(`ASSERT no horizontal overflow at 1280 on any route: ${maxOverflow <= 0 ? "PASS" : "FAIL"} (max=${maxOverflow})`);

// ---- collapse persistence ----
console.log("\n--- collapse persistence ---");
await pg.goto(BASE + "/match-ops/master-schedule", { waitUntil: "load" });
await pg.waitForTimeout(3000);
await pg.locator('nav[aria-label="Match Ops"] button[aria-label="Collapse rail"]').click();
await pg.waitForTimeout(600);
const collMS = (await probe()).box;
await pg.screenshot({ path: `${OUT}/mor_collapsed_master.png` });
console.log(`collapsed on master-schedule: box=${JSON.stringify(collMS)} (w should be 60)`);
// navigate to chats via a real client-side click (SPA nav — layout persists)
await pg.locator('nav[aria-label="Match Ops"] a[href="/match-ops/player-chats"]').click();
await pg.waitForTimeout(3000);
const collPC = (await probe()).box;
await pg.screenshot({ path: `${OUT}/mor_collapsed_chats.png` });
console.log(`after client-nav to player-chats: box=${JSON.stringify(collPC)} (w should still be 60)`);
// reload — localStorage should restore collapsed
await pg.reload({ waitUntil: "load" });
await pg.waitForTimeout(3000);
const collReload = (await probe()).box;
console.log(`after reload: box=${JSON.stringify(collReload)} (w should still be 60)`);
console.log(`ASSERT collapse persists across nav: ${collPC.w === 60 ? "PASS" : "FAIL"}`);
console.log(`ASSERT collapse persists across reload: ${collReload.w === 60 ? "PASS" : "FAIL"}`);
console.log(`ASSERT collapsed box still identical across routes: ${JSON.stringify(collMS) === JSON.stringify(collPC) ? "PASS" : "FAIL"}`);

console.log(`\nconsole/page errors: ${errs.length}`);
if (errs.length) console.log(errs.slice(0, 5).join("\n"));
await browser.close();
process.exit(0);
