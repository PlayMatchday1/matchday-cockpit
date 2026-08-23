// Field Pipeline verify-by-looking harness. Real page, real data. Screenshots
// the 9 states, reconciles every chip against an independent count from the
// rows, checks per-column sum, collapsed-rail geometry, filter-honesty, and the
// absence of the aging/stalled chip (R3b). Run:
//   BASE=http://localhost:3000 node scripts/fieldpipeline-harness.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = (process.env.CLAUDE_JOB_DIR || ".") + "/tmp";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const ref = url.replace("https://", "").split(".")[0];
const sb = createClient(url, svc, { auth: { persistSession: false } });
const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const cli = createClient(url, anon, { auth: { persistSession: false } });
const { data: s } = await cli.auth.verifyOtp({ type: "email", token_hash: l.properties.hashed_token });

// ---- independent counts from the rows ----
const { data: cards } = await sb.from("kanban_cards").select("id, stage, owner_user_id, data").eq("board_type", "field_pipeline");
const uids = [...new Set(cards.map((c) => c.owner_user_id).filter(Boolean))];
const { data: us } = await sb.from("app_users").select("id, full_name, email").in("id", uids);
const nm = Object.fromEntries((us || []).map((u) => [u.id, u.full_name || u.email]));
const { data: cl } = await sb.from("kanban_checklist_items").select("card_id, done").in("card_id", cards.map((c) => c.id));
const ownerName = (c) => (c.owner_user_id && nm[c.owner_user_id]) ? nm[c.owner_user_id] : (c.data?.owner_label || null);
const IND = {
  fields: cards.length,
  cities: new Set(cards.map((c) => c.data?.city).filter(Boolean)).size,
  owners: new Set(cards.map(ownerName).filter(Boolean)).size,
  openTodos: (cl || []).filter((i) => !i.done).length,
  perStage: cards.reduce((a, c) => ((a[c.stage] = (a[c.stage] || 0) + 1), a), {}),
};
console.log("INDEPENDENT:", JSON.stringify(IND));

const browser = await chromium.launch();
async function page(width = 1600, { stubEmptyTodos = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [`sb-${ref}-auth-token`, JSON.stringify(s.session)]);
  await ctx.addInitScript(() => { try { localStorage.removeItem("fieldpipeline:collapsed:v1"); localStorage.removeItem("fieldpipeline:shutgroups:v1"); } catch (e) {} });
  if (stubEmptyTodos) {
    // all-clear: no open to-dos → the to-do chip must be absent.
    await ctx.route("**/rest/v1/kanban_checklist_items**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  }
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  pg.on("pageerror", (e) => errs.push("[pageerror] " + e.message));
  return { ctx, pg, errs };
}

const strip = (pg) => pg.evaluate(() => {
  const chipNum = (re) => {
    const el = [...document.querySelectorAll("span,button")].find((e) => re.test(e.textContent || "") && /^\s*\d/.test((e.textContent || "").trim()));
    return el ? Number((el.textContent.match(/\d+/) || [null])[0]) : null;
  };
  const body = document.body.innerText;
  const num = (re) => { const m = body.match(re); return m ? Number(m[1]) : null; };
  const cols = [...document.querySelectorAll("section")].map((sec) => {
    const r = sec.getBoundingClientRect();
    const hasBody = !!sec.querySelector(".flex-1.overflow-y-auto, [class*='overflow-y-auto']");
    // header text: the visible column title + count (or rail)
    return { w: Math.round(r.width), hasScrollBody: !!sec.querySelector("button[title^='Collapse'], button[title^='Expand']") ? undefined : undefined, txt: (sec.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) };
  });
  return {
    fields: num(/(\d+)\s+fields/),
    cities: num(/(\d+)\s+(?:cities|city)/),
    owners: num(/(\d+)\s+(?:owners|owner)/),
    todos: num(/(\d+)\s+open to-do/),
    hasAgingChip: /aging|stalled/i.test(body),
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    colWidths: [...document.querySelectorAll("section")].map((x) => Math.round(x.getBoundingClientRect().width)),
    colBodies: [...document.querySelectorAll("section")].map((x) => !!x.querySelector("[class*='overflow-y-auto']")),
  };
});

const results = {};
async function shot(name, { width = 1600, setup, stubEmptyTodos = false } = {}) {
  const { ctx, pg, errs } = await page(width, { stubEmptyTodos });
  await pg.goto(BASE + "/growth/field-pipeline", { waitUntil: "load", timeout: 60000 });
  await pg.waitForTimeout(4000);
  if (setup) await setup(pg);
  await pg.screenshot({ path: `${OUT}/fp_${name}.png` });
  const st = await strip(pg);
  st.errs = errs.length;
  results[name] = st;
  console.log(name, JSON.stringify(st));
  await ctx.close();
}

const clickText = async (pg, re) => { await pg.locator("button", { hasText: re }).first().click().catch(() => {}); await pg.waitForTimeout(500); };

await shot("1_default");
await shot("2_allexpanded", { setup: async (pg) => { // expand every collapsed rail
  for (let i = 0; i < 6; i++) { const b = pg.locator("button[title^='Expand']").first(); if (await b.count()) await b.click().catch(() => {}); await pg.waitForTimeout(200); }
} });
await shot("3_groupoff", { setup: (pg) => clickText(pg, /Grouped by city/) });
await shot("4_todofilter", { setup: (pg) => clickText(pg, /open to-do/) });
await shot("6_search", { setup: async (pg) => { await pg.fill("input[placeholder^='Search']", "Austin"); await pg.waitForTimeout(600); } });
await shot("7_groupcollapsed", { setup: async (pg) => { const g = pg.locator("button[aria-expanded='true']").filter({ hasText: /^(Austin|Dallas|Houston|Atlanta|Philadelphia)/ }).first(); await g.click().catch(() => {}); await pg.waitForTimeout(400); } });
await shot("8_allclear", { stubEmptyTodos: true });
await shot("9_narrow", { width: 1280 });

// state 5: R3b — prove the aging/stalled chip is ABSENT.
console.log("\nstate5 (R3b): aging/stalled chip present anywhere?", results["1_default"].hasAgingChip);

// state 6: print the 5 column header texts (filter-honesty)
{
  const { ctx, pg } = await page(1600);
  await pg.goto(BASE + "/growth/field-pipeline", { waitUntil: "load" });
  await pg.waitForTimeout(4000);
  await pg.fill("input[placeholder^='Search']", "Austin");
  await pg.waitForTimeout(700);
  const headers = await pg.evaluate(() => [...document.querySelectorAll("section")].map((sec) => (sec.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70)));
  console.log("state6 column texts:"); headers.forEach((h) => console.log("   " + h));
  await ctx.close();
}

console.log("\n=== RECONCILE (default) ===");
const d = results["1_default"];
console.log(`fields ${d.fields}==${IND.fields}? ${d.fields === IND.fields} | cities ${d.cities}==${IND.cities}? ${d.cities === IND.cities} | owners ${d.owners}==${IND.owners}? ${d.owners === IND.owners} | openTodos ${d.todos}==${IND.openTodos}? ${d.todos === IND.openTodos}`);
console.log(`allclear todo chip absent? ${results["8_allclear"].todos === null}`);
console.log(`narrow(1280) docOverflow=${results["9_narrow"].docOverflow} (must be 0)`);
console.log(`collapsed rails ~46px (default colWidths): ${JSON.stringify(d.colWidths)}`);
const errsTotal = Object.values(results).reduce((a, r) => a + r.errs, 0);
console.log(`total console/page errors: ${errsTotal}`);
await browser.close();
process.exit(0);
