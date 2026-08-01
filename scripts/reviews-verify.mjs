// Reviews page browser exercise (6d) + screenshots to LOOK at (6e).
// Drives filters, tiles, comment windows, severity chips, the reply-tick degrade
// state, the empty state, the share modal, and checks 1280px for overflow/towers.
//
// Run: node --env-file=.env.local scripts/reviews-verify.mjs

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

const browser = await chromium.launch();
const errs = [];
async function make(w = 1440) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 1000 } });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, [`sb-${ref}-auth-token`, JSON.stringify(sess.session)]);
  const pg = await ctx.newPage();
  pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  pg.on("pageerror", (e) => errs.push("[pageerror] " + e.message));
  return { ctx, pg };
}
const load = async (pg) => { await pg.goto(BASE + "/match-ops/reviews", { waitUntil: "load", timeout: 60000 }); await pg.waitForTimeout(4500); };
const shot = (pg, n) => pg.screenshot({ path: `${OUT}/rv_${n}.png` });

const { ctx, pg } = await make(1440);
await load(pg);

// default (Aug, sparse)
console.log("scope(default):", await pg.locator("text=/Showing/").first().textContent().catch(() => null));
await shot(pg, "1_default_aug");

// switch to Jul (full month)
const monthSel = pg.locator("select").first();
await monthSel.selectOption("2026-07");
await pg.waitForTimeout(1200);
await shot(pg, "2_jul_full");
console.log("Jul tiles avg/vol/attn/stand:", await pg.evaluate(() => ["avg", "volume", "attn", "stand"].map((k) => document.querySelector(`[data-rv="${k}"]`)?.textContent).join(" / ")));

// apply a city filter
const citySel = pg.locator("select").nth(1);
await citySel.selectOption({ label: "Austin" }).catch(() => {});
await pg.waitForTimeout(1000);
console.log("scope(Austin):", (await pg.locator("text=/Showing/").first().textContent()).trim());
console.log("clear-filters visible:", await pg.locator("button:has-text('Clear filters')").isVisible());
await shot(pg, "3_filter_austin");
await pg.locator("button:has-text('Clear filters')").click();
await pg.waitForTimeout(800);

// venue mode (manager table shows the 'not narrowed by venue' message)
const venueSel = pg.locator("select").nth(2);
const firstVenue = await venueSel.locator("option").nth(1).getAttribute("value");
await venueSel.selectOption(firstVenue);
await pg.waitForTimeout(900);
console.log("venue-mode manager note present:", await pg.locator("text=/do not narrow to a single venue/").isVisible());
await shot(pg, "4_venue_mode");
await pg.locator("button:has-text('Clear filters')").click();
await pg.waitForTimeout(800);

// clickable tiles → focus
await pg.getByRole("button", { name: /NEEDS ATTENTION/ }).click();
await pg.waitForTimeout(500);
const standoutsHiddenWhenAttn = !(await pg.locator("h2:has-text('STANDOUTS')").isVisible().catch(() => false));
console.log("focus=attn hides standouts panel:", standoutsHiddenWhenAttn);
await shot(pg, "5_focus_attn");
await pg.getByRole("button", { name: /NEEDS ATTENTION/ }).click(); // toggle off
await pg.waitForTimeout(400);

// comment windows
for (const w of ["This month", "Last 30 days", "This week"]) {
  await pg.locator(`button:has-text("${w}")`).first().click();
  await pg.waitForTimeout(700);
}
await shot(pg, "6_comments_week");
// severity chips
for (const s of ["Needs a reply", "Unanswered", "Praise", "All"]) {
  await pg.locator(`[data-rv^="sev-"]:has-text("${s}")`).click().catch(async () => { await pg.locator(`button:has-text("${s}")`).first().click().catch(() => {}); });
  await pg.waitForTimeout(500);
}
await pg.locator('[data-rv="sev-praise"]').click();
await pg.waitForTimeout(500);
await shot(pg, "7_severity_praise");

// reply-tick degrade state (migration not applied)
const degradeNote = await pg.locator("text=/Reply tracking not enabled yet/").isVisible().catch(() => false);
const firstTickDisabled = await pg.locator('button:has-text("Reply due"), button:has-text("Mark replied")').first().isDisabled().catch(() => null);
console.log("reply-tracking degrade note visible:", degradeNote, "| first tick disabled:", firstTickDisabled);

// empty state — a window/severity/filter combo with nothing
await pg.locator('[data-rv="sev-open"]').click();
await pg.waitForTimeout(400);
// narrow the comments to a manager unlikely to have unanswered this week + praise:
await pg.locator('[data-rv="sev-praise"]').click();
await pg.waitForTimeout(400);
await citySel.selectOption({ label: "El Paso" }).catch(() => {});
await pg.waitForTimeout(900);
console.log("empty-state sentence present:", await pg.locator("text=/Nothing to read|Widen the window/").isVisible().catch(() => false));
await shot(pg, "8_empty_state");
await pg.locator("button:has-text('Clear filters')").click().catch(() => {});
await pg.waitForTimeout(600);

// share modal
await pg.locator("button:has-text('Share leaderboard')").click();
await pg.waitForTimeout(700);
console.log("share floor disclosure present:", await pg.locator("text=/ranked among managers with 10\\+ reviews/i").isVisible().catch(() => false));
await shot(pg, "9_share_modal");
await pg.locator(".fixed button:has-text('Close')").click().catch(() => {});
await pg.waitForTimeout(400);
await ctx.close();

// 1280px overflow / towers
const { ctx: c2, pg: p2 } = await make(1280);
await load(p2);
await p2.locator("select").first().selectOption("2026-07");
await p2.waitForTimeout(1200);
const over = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const maxRowH = await p2.evaluate(() => Math.max(0, ...[...document.querySelectorAll(".rv-ctab tbody tr")].map((r) => r.getBoundingClientRect().height)));
console.log(`\n1280px: docOverflow=${over} (must be <=0) | tallest comment row=${Math.round(maxRowH)}px (tower check)`);
await shot(p2, "a_narrow_1280");
await c2.close();

console.log(`\nconsole/page errors: ${errs.length}`);
if (errs.length) console.log(errs.slice(0, 6).join("\n"));
await browser.close();
process.exit(0);
