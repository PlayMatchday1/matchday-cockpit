// Master Schedule harness (S7). Verifies the collapsible banners on the real
// /match-ops/master-schedule page: the board reclaims real pixels when the
// cards collapse, the count lives only on the chip, all-clear is a chip (not a
// bar), and a collapsed banner never changes the duplicate number.
//
// Run: BASE=http://localhost:3000 node scripts/masterschedule-harness.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = (process.env.CLAUDE_JOB_DIR || ".") + "/tmp";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const ref = url.replace("https://", "").split(".")[0];
const admin = createClient(url, svc, { auth: { persistSession: false } });
const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const cli = createClient(url, anon, { auth: { persistSession: false } });
const { data: s } = await cli.auth.verifyOtp({ type: "email", token_hash: l.properties.hashed_token });

const MS = BASE + "/match-ops/master-schedule";
const chipByText = (re) => `button:has-text("")`; // placeholder (unused)

const browser = await chromium.launch();

async function makePage({ stubAllClear = false, width = 1600 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [`sb-${ref}-auth-token`, JSON.stringify(s.session)]);
  if (stubAllClear) {
    // Force reviews=0, duplicates=0, unchecked=0: a clean payload (1 match per
    // slot at mapped venues), empty discrepancies, real field-map.
    await ctx.route("**/api/schedule-master?**", async (route) => {
      const body = {
        week_start: "2026-07-27",
        week_end: "2026-08-03",
        cities: [
          {
            name: "Austin",
            total: 1,
            days: [
              { date: "2026-07-27", day_of_week: "Mon", matches: [{ id: "x1", venue: "NEMP", detail: "7 PM NEMP", time: "7:00 PM", max_spots: 20, mdapi_field_id: 10, source: "template" }] },
              ...["Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => ({ date: `2026-07-2${8 + i}`.slice(0, 10), day_of_week: d, matches: [] })),
            ],
          },
        ],
      };
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await ctx.route("**/api/schedule-master/discrepancies?**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ week_start: "2026-07-27", week_end: "2026-08-03", total_schedule_master: 1, total_mdapi_matches: 1, missing_in_db: [], extra_in_db: [], mismatched: [], cancelled: [] }) }),
    );
  }
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("[pageerror] " + e.message));
  return { ctx, page, errs };
}

async function probes(page) {
  return page.evaluate(() => {
    const board = document.querySelector("[data-ms-board]");
    const dupCard = document.querySelector("[data-ms-dup-card]");
    const revCard = document.querySelector("[data-ms-review-card]");
    const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
    const boardTop = board ? board.getBoundingClientRect().top : window.innerHeight;
    const chips = [...document.querySelectorAll("button")]
      .filter((b) => /need review|possible duplicate/.test(b.textContent || ""))
      .map((b) => {
        const label = /need review/.test(b.textContent) ? "review" : "dup";
        const target = label === "review" ? "[data-ms-review-card]" : "[data-ms-dup-card]";
        return {
          label,
          ariaExpanded: b.getAttribute("aria-expanded") === "true",
          cardShown: !!document.querySelector(target),
          tagName: b.tagName,
        };
      });
    const dupChip = [...document.querySelectorAll("button")].find((b) => /possible duplicate/.test(b.textContent || ""));
    const dupNum = dupChip ? Number((dupChip.textContent.match(/\d+/) || [0])[0]) : null;
    // The all-clear ELEMENT is the leaf-most node carrying the exact text (the
    // chip), not a wide ancestor container.
    const okEl = [...document.querySelectorAll("span,div,button,p")]
      .filter((e) => /MatchDay agrees on every session/.test(e.textContent || ""))
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];
    const okChip = !!okEl;
    // okIsBar: is that element a full-width (>90%) bar? A chip is not.
    const okIsBar = okEl ? okEl.getBoundingClientRect().width > window.innerWidth * 0.9 : false;
    return {
      boardH: board ? Math.round(window.innerHeight - boardTop) : null,
      bannerH: { dup: h(dupCard), review: h(revCard) },
      chipState: chips,
      dupNum,
      okShown: okChip,
      okIsBar,
    };
  });
}

const clickChip = async (page, re) => {
  await page.locator("button", { hasText: re }).first().click().catch(() => {});
  await page.waitForTimeout(500);
};

const results = {};
async function run(name, setup, { width = 1600 } = {}) {
  const { ctx, page, errs } = await makePage({ width, stubAllClear: name === "allclear" });
  await page.goto(MS, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(4500);
  if (setup) await setup(page);
  const p = await probes(page);
  p.errs = errs.length;
  await page.screenshot({ path: `${OUT}/msh_${name}.png` });
  results[name] = p;
  console.log(name, JSON.stringify(p));
  await ctx.close();
}

await run("collapsed", null);
await run("revopen", (pg) => clickChip(pg, /need review/));
await run("dupopen", (pg) => clickChip(pg, /possible duplicate/));
await run("bothopen", async (pg) => { await clickChip(pg, /need review/); await clickChip(pg, /possible duplicate/); });
await run("reclose", async (pg) => { await clickChip(pg, /need review/); await clickChip(pg, /possible duplicate/); await clickChip(pg, /need review/); await clickChip(pg, /possible duplicate/); });
await run("cardcx", async (pg) => { await clickChip(pg, /possible duplicate/); await pg.locator("[data-ms-dup-card] button[aria-label='Collapse duplicates']").click().catch(() => {}); await pg.waitForTimeout(400); });
await run("allclear", null);
await run("collapsed_narrow", null, { width: 1280 });

console.log("\n=== DERIVED ===");
const dCol = results.collapsed.boardH, dBoth = results.bothopen.boardH;
console.log(`boardH collapsed=${dCol} bothopen=${dBoth} delta=${dCol - dBoth} (collapsed strictly larger? ${dCol > dBoth})`);
console.log(`bannerH collapsed dup/review = ${results.collapsed.bannerH.dup}/${results.collapsed.bannerH.review} (must be 0/0)`);
console.log(`dupSumOK: collapsed dupNum=${results.collapsed.dupNum} == dupopen dupNum=${results.dupopen.dupNum} (collapse didn't change it? ${results.collapsed.dupNum === results.dupopen.dupNum})`);
console.log(`allclear: okShown=${results.allclear.okShown} okIsBar=${results.allclear.okIsBar} dupChipPresent=${results.allclear.dupNum !== null}`);
console.log(`cardcx: dup card gone after X? ${results.cardcx.bannerH.dup === 0}`);
const errsTotal = Object.values(results).reduce((a, r) => a + r.errs, 0);
console.log(`total console/page errors across states: ${errsTotal}`);
void chipByText;
await browser.close();
process.exit(0);
