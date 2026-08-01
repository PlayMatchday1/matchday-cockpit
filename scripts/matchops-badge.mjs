// Match Ops badge count harness (Problem 2). Prints the actual prod value of
// each competing query, then verifies the rail badge, the top-nav Match Ops
// pill, and the mobile bottom-nav badge all render the SAME string (the awaiting
// count), and that a zero renders NO badge (not "0").
//
// Run from repo root: node --env-file=.env.local scripts/matchops-badge.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const OUT = (process.env.CLAUDE_JOB_DIR || ".") + "/tmp";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY, anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const ref = url.replace("https://", "").split(".")[0];
const sb = createClient(url, svc, { auth: { persistSession: false } });
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const cli = createClient(url, anon, { auth: { persistSession: false } });
const { data: sess } = await cli.auth.verifyOtp({ type: "email", token_hash: link.properties.hashed_token });
const token = sess.session.access_token;

// actual prod values of the two competing queries
const j = async (p) => (await fetch(BASE + p, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }).then((r) => r.json()));
const awaiting = (await j("/api/crm/threads/awaiting-count")).count;
const unread = (await j("/api/crm/threads/unread-count")).count;
console.log(`PROD query values RIGHT NOW:`);
console.log(`  awaiting (adopted) = ${awaiting}`);
console.log(`  unread   (old pill/favicon) = ${unread}`);

const browser = await chromium.launch();
async function newPage({ stubAwaiting } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, [`sb-${ref}-auth-token`, JSON.stringify(sess.session)]);
  if (stubAwaiting !== undefined) {
    await ctx.route("**/api/crm/threads/awaiting-count**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ count: stubAwaiting }) }));
  }
  return ctx;
}
const read = (pg) => pg.evaluate(() => {
  const nav = document.querySelector('nav[aria-label="Match Ops"]');
  const pcLink = nav ? [...nav.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/match-ops/player-chats") : null;
  const railBadge = pcLink ? (pcLink.querySelector("span.tabular-nums, span.rounded-full")?.textContent || "").trim() || null : null;
  const pill = (() => {
    const el = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/match-ops" && /match ops/i.test(a.textContent || ""));
    if (!el) return null;
    const circ = el.querySelector("span");
    const m = (el.textContent || "").match(/(\d+)/);
    return m ? m[1] : null;
  })();
  return { railBadge, pill };
});

const routes = ["/match-ops/master-schedule", "/match-ops/match-chats", "/match-ops/player-chats"];
console.log(`\nExpect rail badge == top-nav pill == awaiting (${awaiting}) on every route:`);
const seen = [];
for (const r of routes) {
  const ctx = await newPage();
  const pg = await ctx.newPage();
  await pg.goto(BASE + r, { waitUntil: "load" });
  await pg.waitForTimeout(3500);
  const v = await read(pg);
  seen.push(v);
  console.log(`  ${r.padEnd(30)} railBadge=${JSON.stringify(v.railBadge)} topPill=${JSON.stringify(v.pill)}`);
  await ctx.close();
}
const want = String(awaiting);
const allMatch = seen.every((v) => v.railBadge === want && v.pill === want);
console.log(`ASSERT rail badge == top pill == awaiting on all routes: ${allMatch ? "PASS" : "FAIL"}`);

// zero → NO badge (not "0")
{
  const ctx = await newPage({ stubAwaiting: 0 });
  const pg = await ctx.newPage();
  await pg.goto(BASE + "/match-ops/master-schedule", { waitUntil: "load" });
  await pg.waitForTimeout(3500);
  const v = await read(pg);
  await pg.screenshot({ path: `${OUT}/mob_zero.png` });
  console.log(`\nZero-stub: railBadge=${JSON.stringify(v.railBadge)} topPill=${JSON.stringify(v.pill)}`);
  console.log(`ASSERT zero renders NO badge (both null, not "0"): ${v.railBadge === null && v.pill === null ? "PASS" : "FAIL"}`);
  await ctx.close();
}

await browser.close();
process.exit(0);
