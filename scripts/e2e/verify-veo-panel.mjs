// THE VEO PANEL — the film plays here, and the chat is one click away.
//   node scripts/e2e/verify-veo-panel.mjs      (needs `npm run dev` up)
//
// The URL derivation and the button/caption logic are proven as source and unit assertions in
// scripts/veo-day-test.ts. THIS asserts the things only a browser can: that pressing the control
// actually plays a film (currentTime advances — an element appearing proves nothing), that nothing
// is fetched from the CDN before that click, that the stage does not jump, and that the chat panel
// opens on the right thread.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
/* nonEmpty on the row list: "no film is fetched before anyone presses play" is satisfied by a page
 * with no rows to expand, and so is every other zero below it. */
import { nonEmpty } from "./_session.mjs";
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

  // A day with a POSTED row, so there is a real film to play and a real chat to open.
  const { data: posted } = await svc.from("veo_recordings")
    .select("matched_api_id, email_subject, flagged, posted_by_user_id")
    .eq("status", "posted").not("matched_api_id", "is", null).order("received_at", { ascending: false }).limit(12);
  const { data: ms } = await svc.from("mdapi_matches").select("api_id, start_date")
    .in("api_id", posted.map((r) => r.matched_api_id));
  const dayOf = new Map(ms.map((m) => [m.api_id, String(m.start_date).slice(0, 10)]));
  const auto = posted.find((r) => !r.posted_by_user_id && dayOf.get(r.matched_api_id));
  const DAY = dayOf.get(auto.matched_api_id);
  console.log(`     ${DAY}, on match ${auto.matched_api_id}: "${auto.email_subject.slice(0, 42)}" (flagged=${auto.flagged})`);

  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1100 },
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] } });
  const p = await ctx.newPage();
  const cdn = [];
  p.on("request", (r) => { if (r.url().includes("c.veocdn.com")) cdn.push(r.url().split("/").pop()); });

  await p.goto(`${BASE}/match-ops/veo?date=${DAY}`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-row"]', { timeout: 240000 });
  await p.waitForFunction(() => !document.body.innerText.includes("Loading…"), { timeout: 120000 });

  // Expand EVERY row on the day — a page of open rows must stream nothing.
  const rows = nonEmpty(await p.$$('[data-testid="veo-row"] > button'), "expandable rows on the day");
  // The positive control for every zero below: a day with no rows would satisfy all of them.
  yes(`the day has ${rows.length} rows to expand`, rows.length > 0);
  for (const r of rows) { await r.click(); await p.waitForTimeout(250); }
  await p.waitForTimeout(3000);
  console.log(`     ${rows.length} rows expanded; CDN requests so far: ${JSON.stringify(cdn)}`);
  is("no film is fetched before anyone presses play", cdn.filter((u) => u === "video.mp4"), []);
  yes("…though the still frames are", cdn.some((u) => u === "thumbnail.jpg"), JSON.stringify(cdn));
  // Collapse them again, then open just the one with the film.
  for (const r of rows) { await r.click(); await p.waitForTimeout(120); }
  await p.click(`[data-api-id="${auto.matched_api_id}"] > button`);
  await p.waitForSelector('[data-testid="veo-play"]', { timeout: 60000 });

  // ---- the control itself ----
  const btn = await p.evaluate(() => {
    const e = document.querySelector('[data-testid="veo-play"]');
    const r = e.getBoundingClientRect();
    return { tag: e.tagName, w: Math.round(r.width), h: Math.round(r.height), label: e.getAttribute("aria-label") };
  });
  console.log(`     play control: ${JSON.stringify(btn)}`);
  is("the play control is a real BUTTON", btn.tag, "BUTTON");
  yes("…at least 44x44", btn.w >= 44 && btn.h >= 44, JSON.stringify(btn));
  yes("…and it is labelled", Boolean(btn.label), JSON.stringify(btn));

  // Reachable by keyboard, and ENTER starts it.
  const stageBefore = await p.$eval('[data-testid="veo-stage"]', (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
  await p.focus('[data-testid="veo-play"]');
  is("it takes keyboard focus", await p.evaluate(() => document.activeElement?.getAttribute("data-testid")), "veo-play");
  await p.keyboard.press("Enter");
  await p.waitForSelector('[data-testid="veo-video"]', { timeout: 30000 });
  ok("pressing Enter mounts the film");

  /* THE ONLY ASSERTION THAT PROVES THE BUTTON WORKS. An element appearing proves nothing; the film
   * has to actually be playing. */
  const played = await p.waitForFunction(() => {
    const v = document.querySelector('[data-testid="veo-video"]');
    return v && v.readyState >= 2 && v.currentTime > 0.05 ? { rs: v.readyState, t: v.currentTime, src: v.currentSrc.split("/").pop() } : null;
  }, { timeout: 90000 }).then((h) => h.jsonValue()).catch(() => null);
  console.log(`     video: ${JSON.stringify(played)}`);
  yes("the film reaches readyState >= 2 and its currentTime advances", Boolean(played), "it never started");
  if (played) is("…and it is the mp4 beside the still frame", played.src, "video.mp4");
  yes("…and only then is the CDN asked for it", cdn.includes("video.mp4"), JSON.stringify(cdn));

  // ---- the stage does not move ----
  const stageAfter = await p.$eval('[data-testid="veo-stage"]', (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
  console.log(`     stage before ${JSON.stringify(stageBefore)} after ${JSON.stringify(stageAfter)}`);
  is("the stage keeps its box and its position", stageAfter, stageBefore);
  is("the poster is replaced, not stacked behind the film", await p.$$eval('[data-testid="veo-thumb"]', (e) => e.length), 0);

  // ---- the two verdict buttons ----
  const acts = await p.$$eval('[data-testid="veo-actions"] button', (els) => els.map((e) => e.textContent.trim()));
  const note = await p.$eval('[data-testid="veo-posted-note"]', (e) => e.textContent.trim());
  const state = await p.$eval(`[data-api-id="${auto.matched_api_id}"]`, (e) => e.dataset.state);
  console.log(`     ${state} row actions: ${JSON.stringify(acts)}`);
  console.log(`     note: ${JSON.stringify(note)}`);
  if (state === "posted") {
    is("a CLEAN post is not offered a flag to clear", acts.filter((a) => /clear the flag/i.test(a)), []);
    yes("…and the line under the buttons says why", /already off the review list/.test(note), note);
  } else {
    yes("a FLAGGED post is offered the flag", acts.some((a) => /clear the flag/i.test(a)), JSON.stringify(acts));
  }
  yes("…and both rows get move and not-ours", acts.some((a) => /move it/i.test(a)) && acts.some((a) => /not our film/i.test(a)), JSON.stringify(acts));
  const body = await p.$eval(".veo", (e) => e.innerText);
  is("the 'not wired yet' caption is nowhere on the page", /not wired yet|drawn disabled rather than shipped live/.test(body), false);

  // ---- Match chat ----
  await p.click('[data-testid="veo-match-chat"]');
  await p.waitForSelector('[data-testid="gday-panel"]', { timeout: 60000 });
  await p.waitForTimeout(1500);
  const panel = await p.evaluate(() => ({
    chatId: document.querySelector('[data-testid="gday-panel-chat"]')?.dataset.chatId ?? null,
    chatHidden: document.querySelector('[data-testid="gday-panel-chat"]')?.className.includes("gpanel-hide"),
    detailsHidden: document.querySelector('[data-testid="gday-panel-details"]')?.className.includes("gpanel-hide"),
    tabs: [...document.querySelectorAll('[data-testid="gday-panel-tabs"] button')].map((e) => `${e.textContent.trim()}:${e.getAttribute("aria-selected")}`),
    steps: document.querySelectorAll('[data-testid="gday-prev"]').length,
  }));
  console.log(`     panel: ${JSON.stringify(panel)}`);
  is("it opens on the row's own match id", panel.chatId, String(auto.matched_api_id));
  is("…on the Chat tab", panel.chatHidden, false);
  is("…with Details hidden", panel.detailsHidden, true);
  is("…and no stepping control, because this page has no sibling list", panel.steps, 0);
  // Flipping does not unmount either side.
  await p.click('[data-testid="gday-tab-details"]');
  await p.waitForTimeout(600);
  const flipped = await p.evaluate(() => ({
    chat: Boolean(document.querySelector('[data-testid="gday-panel-chat"]')),
    details: Boolean(document.querySelector('[data-testid="gday-panel-details"]')),
    chatHidden: document.querySelector('[data-testid="gday-panel-chat"]')?.className.includes("gpanel-hide"),
  }));
  yes("flipping to Details unmounts neither side", flipped.chat && flipped.details, JSON.stringify(flipped));
  is("…it only hides the chat", flipped.chatHidden, true);

  // ---- Gameday Ops still works, with its own extras ----
  await p.goto(`${BASE}/match-ops/gameday`, { waitUntil: "domcontentloaded" });
  /* gday-row, NOT snap-row. `snap-row` was the old eight-column row, and GamedayBoard's own comment
   * records that it was deleted in the five-column rebuild — scripts/e2e/verify-city-confinement.mjs
   * still waits on it and has therefore been timing out on a clean tree, which is the "unrelated
   * wait" I put down to contention earlier. It is a dated selector. */
  await p.waitForSelector('[data-testid="gday-row"]', { timeout: 240000 });
  await p.click('[data-testid="gday-row"]');
  await p.waitForSelector('[data-testid="gday-panel"]', { timeout: 60000 });
  await p.waitForTimeout(1200);
  const g = await p.evaluate(() => ({
    tabs: document.querySelectorAll('[data-testid="gday-panel-tabs"] button').length,
    steps: document.querySelectorAll('[data-testid="gday-prev"]').length,
    details: Boolean(document.querySelector('[data-testid="gday-panel-details"]')),
    chat: Boolean(document.querySelector('[data-testid="gday-panel-chat"]')),
    width: Math.round(document.querySelector('[data-testid="gday-panel"]').getBoundingClientRect().width),
    bg: getComputedStyle(document.querySelector('[data-testid="gday-panel"]')).backgroundColor,
  }));
  console.log(`     gameday panel: ${JSON.stringify(g)}`);
  is("Gameday Ops still opens its panel with both tabs", [g.tabs, g.details, g.chat], [2, true, true]);
  is("…and keeps its stepping control", g.steps, 1);
  yes("…and its chrome still renders (a real width and its own background)", g.width > 400 && g.bg !== "rgba(0, 0, 0, 0)", JSON.stringify(g));
  await p.click('[data-testid="gday-tab-chat"]');
  await p.waitForTimeout(800);
  is("…and its Chat tab still selects", await p.$eval('[data-testid="gday-panel-chat"]', (e) => e.className.includes("gpanel-hide")), false);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("  XX  suite crashed:", e?.message ?? e); process.exit(2); });
