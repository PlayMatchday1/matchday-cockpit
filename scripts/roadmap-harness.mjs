// Tech Roadmap — verify-by-behaviour harness. Real page, real data, admin
// session. Asserts the invariants the mockup's comments defend, on both boards
// at 1600px and 1280px. Behaviour, not appearance: every check reads the DOM
// the page actually produced. Run:
//   BASE=http://localhost:3000 node scripts/roadmap-harness.mjs
//
// It manages its own fixtures via the service role (no live card is currently
// "stuck", so it inserts one, verifies the stuck affordance, and deletes it),
// and it proves the squashed-card assertions CAN fail by removing the
// flex:0 0 auto rule at runtime and confirming they go red, then green.

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = (process.env.CLAUDE_JOB_DIR || ".") + "/tmp";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const ref = url.replace("https://", "").split(".")[0];
const sb = createClient(url, svc, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// ── admin session ──
const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const cli = createClient(url, anon, { auth: { persistSession: false } });
const { data: s } = await cli.auth.verifyOtp({ type: "email", token_hash: l.properties.hashed_token });

// ── does the migration exist yet? (board column + clubhouse seed) ──
let hasBoardCol = true;
{ const probe = await sb.from("kanban_cards").select("board").limit(1); if (probe.error) hasBoardCol = false; }
const chProbe = hasBoardCol ? await sb.from("kanban_cards").select("id").eq("board_type", "tech_roadmap").eq("board", "clubhouse") : { data: [] };
const clubhouseSeeded = (chProbe.data ?? []).length > 0;
console.log(`\nMIGRATION STATE: board column=${hasBoardCol}, clubhouse cards=${(chProbe.data ?? []).length}\n`);

const boardOf = (c) => (hasBoardCol && c.board === "clubhouse" ? "clubhouse" : "app");

// ── a temporary STUCK fixture on the App board (in_plan, moved 60d ago) ──
const sixtyAgo = new Date(Date.now() - 60 * 864e5).toISOString();
const fx = await sb.from("kanban_cards").insert({
  board_type: "tech_roadmap", title: "E2E STUCK FIXTURE", stage: "in_plan",
  owner_user_id: null, sort_order: 9999, data: { priority: "High", description: "" },
  stage_entered_at: sixtyAgo,
}).select("*").single();
if (fx.error) { console.error("FIXTURE INSERT FAILED:", fx.error.message); process.exit(1); }
const fixtureId = fx.data.id;
console.log("inserted stuck fixture", fixtureId.slice(0, 8), "\n");

// ── independent card counts per board (from the DB), AFTER the fixture insert
//    so the count the page loads (which includes the fixture) matches ──
const sel = "id, board_type, stage, owner_user_id, data, created_at, updated_at, stage_entered_at" + (hasBoardCol ? ", board" : "");
const { data: allCards } = await sb.from("kanban_cards").select(sel).eq("board_type", "tech_roadmap");

const browser = await chromium.launch();

async function openBoard(width, boardKey) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [`sb-${ref}-auth-token`, JSON.stringify(s.session)]);
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/tech/tech-roadmap`, { waitUntil: "networkidle" });
  await pg.waitForSelector('[data-testid="statebar"]', { timeout: 15000 });
  if (boardKey === "clubhouse") { await pg.click('[data-testid="rail-clubhouse"]'); await pg.waitForTimeout(300); }
  return { ctx, pg };
}
const readBar = (pg) => pg.evaluate(() => {
  const g = (k) => { const el = document.querySelector(`[data-stat="${k}"]`); return el ? (el.textContent || "").trim() : null; };
  return { total: g("total"), inprogress: g("inprogress"), fresh: g("fresh"), stale: g("stale"), esthours: g("esthours") };
});
const colCounts = (pg) => pg.evaluate(() => {
  const ids = ["ideas", "in_plan", "in_progress", "shipped"];
  const out = {};
  for (const id of ids) { const el = document.querySelector(`[data-testid="colcount-${id}"]`); out[id] = el ? (el.textContent || "").trim() : null; }
  return out;
});
// visible count = leading number of "N" or "N of M"
const visN = (s) => (s == null ? 0 : Number((s.match(/^\d+/) || [0])[0]));

async function runBoard(width, boardKey) {
  const label = `[${boardKey} @ ${width}]`;
  console.log(`\n=== ${label} ===`);
  const { ctx, pg } = await openBoard(width, boardKey);
  const indCount = allCards.filter((c) => boardOf(c) === boardKey).length;

  // 1) rail badge == board card count
  const badge = Number((await pg.textContent(`[data-testid="rail-badge-${boardKey}"]`)).trim());
  ok(`${label} rail badge equals card count (${badge} vs ${indCount})`, badge === indCount, `badge=${badge} db=${indCount}`);

  if (indCount === 0) {
    // empty board (clubhouse pre-migration): assert empty-state, skip card checks
    const emptyText = await pg.textContent('[data-testid="board"]');
    ok(`${label} empty board renders "Nothing in" placeholders`, /Nothing in/.test(emptyText));
    const foot = await pg.textContent('[data-testid="footer"]');
    ok(`${label} footer states no cards yet`, /no cards yet/.test(foot));
    const barH = await pg.evaluate(() => document.querySelector('[data-testid="statebar"]').getBoundingClientRect().height);
    ok(`${label} state bar under 130px (${Math.round(barH)})`, barH <= 130, `${barH}px`);
    console.log(`  · (${boardKey} is empty — card-level assertions pending migration)`);
    await ctx.close();
    return;
  }

  // 2) state bar figures unchanged by every filter (individually + combined)
  const base = await readBar(pg);
  const applyEach = [
    ["search", async () => pg.fill('[data-testid="search"]', "a")],
    ["owner", async () => pg.selectOption('[data-testid="owner-filter"]', { index: 1 }).catch(() => {})],
    ["priority", async () => pg.selectOption('[data-testid="priority-filter"]', "High")],
    ["stuck", async () => pg.click('[data-testid="stuck-toggle"]')],
  ];
  let allSame = true, detail = "";
  for (const [nm, fn] of applyEach) {
    await fn(); await pg.waitForTimeout(120);
    const now = await readBar(pg);
    if (JSON.stringify(now) !== JSON.stringify(base)) { allSame = false; detail += `${nm}:${JSON.stringify(now)} `; }
    // reset this filter
    if (nm === "search") await pg.fill('[data-testid="search"]', "");
    else if (nm === "owner") await pg.selectOption('[data-testid="owner-filter"]', "");
    else if (nm === "priority") await pg.selectOption('[data-testid="priority-filter"]', "");
    else if (nm === "stuck") { const t = await pg.getAttribute('[data-testid="stuck-toggle"]', "class"); if (/warn/i.test(t) || (await pg.textContent('[data-testid="stuck-toggle"]')).includes("Showing")) await pg.click('[data-testid="stuck-toggle"]'); }
    await pg.waitForTimeout(80);
  }
  // combined
  await pg.fill('[data-testid="search"]', "a"); await pg.selectOption('[data-testid="priority-filter"]', "High"); await pg.click('[data-testid="stuck-toggle"]');
  await pg.waitForTimeout(150);
  const combined = await readBar(pg);
  if (JSON.stringify(combined) !== JSON.stringify(base)) { allSame = false; detail += `combined:${JSON.stringify(combined)}`; }
  ok(`${label} state bar figures unchanged by every filter`, allSame, detail || `base=${JSON.stringify(base)}`);
  // reset
  await pg.fill('[data-testid="search"]', ""); await pg.selectOption('[data-testid="priority-filter"]', "");
  if ((await pg.textContent('[data-testid="stuck-toggle"]')).includes("Showing")) await pg.click('[data-testid="stuck-toggle"]');
  await pg.waitForTimeout(120);

  // 3) stuck affordance: button before filter, plain text "showing these" after
  const staleN = Number(base.stale);
  if (staleN > 0) {
    const kindBefore = await pg.getAttribute('[data-testid="stuck-affordance"]', "data-kind");
    ok(`${label} stuck affordance is a BUTTON before filtering`, kindBefore === "button", `kind=${kindBefore}`);
    await pg.click('[data-testid="stuck-affordance"]'); await pg.waitForTimeout(150);
    const kindAfter = await pg.getAttribute('[data-testid="stuck-affordance"]', "data-kind");
    const txtAfter = (await pg.textContent('[data-testid="stuck-affordance"]')) || "";
    ok(`${label} stuck affordance is plain TEXT "showing these" after`, kindAfter === "text" && /showing these/.test(txtAfter), `kind=${kindAfter} txt="${txtAfter.trim()}"`);
    // reset
    if ((await pg.textContent('[data-testid="stuck-toggle"]')).includes("Showing")) await pg.click('[data-testid="stuck-toggle"]');
    await pg.waitForTimeout(120);
  } else {
    const kind = await pg.getAttribute('[data-testid="stuck-affordance"]', "data-kind");
    ok(`${label} 0 stuck → affordance is plain text (no dead control)`, kind === "text", `kind=${kind}`);
  }

  // 4+5+6+7) per-card assertions
  const cardData = await pg.$$eval('[data-testid="card"]', (els) => els.map((el) => {
    const meta = el.querySelector('[data-testid="card-meta"]');
    const cardRect = el.getBoundingClientRect();
    const metaRect = meta ? meta.getBoundingClientRect() : null;
    const chips = [...el.querySelectorAll('[data-testid="chip-stuck"],[data-testid="chip-noest"]')].map((c) => c.textContent || "");
    const stuckChip = !!el.querySelector('[data-testid="chip-stuck"]');
    return {
      idea: el.getAttribute("data-idea") === "1",
      stage: el.getAttribute("data-stage"),
      metaText: meta ? (meta.textContent || "").replace(/\s+/g, " ").trim() : "",
      scrollH: el.scrollHeight, clientH: el.clientHeight,
      metaInside: metaRect ? (metaRect.bottom <= cardRect.bottom + 1 && metaRect.top >= cardRect.top - 1) : true,
      chips, stuckChip,
    };
  }));
  // 4) age/date on every non-idea card, none on ideas
  const nonIdeaMissingAge = cardData.filter((c) => !c.idea && !/moved|shipped/.test(c.metaText));
  ok(`${label} every non-idea card states an age or date`, nonIdeaMissingAge.length === 0, `${nonIdeaMissingAge.length} missing`);
  const ideaWithAge = cardData.filter((c) => c.idea && /moved|shipped|\bago\b|\d+\s*d\b/.test(c.metaText));
  ok(`${label} no idea card states an age/date`, ideaWithAge.length === 0, `${ideaWithAge.length} offending`);
  // 5) no stuck chip on ideas
  ok(`${label} no stuck chip on any idea card`, cardData.filter((c) => c.idea && c.stuckChip).length === 0);
  // 6) chips carry no number (the "same number twice on one line" defect class)
  const chipWithDigit = cardData.flatMap((c) => c.chips).filter((t) => /\d/.test(t));
  ok(`${label} no chip carries a number (no age printed twice)`, chipWithDigit.length === 0, chipWithDigit.join(","));
  // 7) no card squashed shorter than its content; meta row inside the card box
  const squashed = cardData.filter((c) => c.scrollH > c.clientH + 1);
  const metaOutside = cardData.filter((c) => !c.metaInside);
  ok(`${label} no card squashed shorter than its content`, squashed.length === 0, `${squashed.length} squashed`);
  ok(`${label} every card's meta row is inside its card box`, metaOutside.length === 0, `${metaOutside.length} outside`);

  // 8) column-header line keeps its threshold number (not truncated away)
  const meta = await pg.evaluate(() => {
    const get = (id) => { const el = document.querySelector(`[data-testid="colmeta-${id}"]`); return el ? { txt: (el.textContent || "").trim(), trunc: el.scrollWidth > el.clientWidth + 1 } : null; };
    return { ideas: get("ideas"), in_plan: get("in_plan"), in_progress: get("in_progress") };
  });
  if (meta.ideas) ok(`${label} ideas column line keeps "120" threshold`, /120/.test(meta.ideas.txt) && !meta.ideas.trunc, JSON.stringify(meta.ideas));
  if (meta.in_plan) ok(`${label} in-plan column line keeps "30" threshold`, /30/.test(meta.in_plan.txt) && !meta.in_plan.trunc, JSON.stringify(meta.in_plan));

  // 9) state bar under 130px, estimate sentence present
  const barH = await pg.evaluate(() => document.querySelector('[data-testid="statebar"]').getBoundingClientRect().height);
  ok(`${label} state bar under 130px (${Math.round(barH)})`, barH <= 130, `${Math.round(barH)}px`);
  const estPresent = await pg.evaluate(() => !!document.querySelector('[data-stat="esthours"]'));
  ok(`${label} estimate sentence present`, estPresent);

  // 10) sum of column counts == board count (unfiltered) and == visible (filtered)
  const cc = await colCounts(pg);
  const sumVis = ["ideas", "in_plan", "in_progress", "shipped"].reduce((a, k) => a + visN(cc[k]), 0);
  ok(`${label} column counts sum to board count, unfiltered (${sumVis} vs ${indCount})`, sumVis === indCount, `sum=${sumVis} board=${indCount}`);
  await pg.fill('[data-testid="search"]', "a"); await pg.waitForTimeout(150);
  const ccF = await colCounts(pg);
  const sumVisF = ["ideas", "in_plan", "in_progress", "shipped"].reduce((a, k) => a + visN(ccF[k]), 0);
  const domVisF = await pg.$$eval('[data-testid="card"]', (els) => els.length);
  ok(`${label} column counts sum to visible cards, filtered (${sumVisF} vs ${domVisF})`, sumVisF === domVisF, `sum=${sumVisF} dom=${domVisF}`);
  await pg.fill('[data-testid="search"]', ""); await pg.waitForTimeout(120);

  // 11) opening a card populates the drawer; closing restores the board
  await pg.click('[data-testid="card"]'); await pg.waitForTimeout(200);
  const drawerTitle = await pg.textContent('[data-testid="drawer-title"]').catch(() => null);
  ok(`${label} opening a card populates the drawer`, !!drawerTitle && drawerTitle.length > 0, `title="${drawerTitle}"`);
  // eye-pass regression class: generated column-name sentences must not double a
  // word ("a card in in plan"). Check the whole drawer for any doubled word.
  const drawerText = (await pg.textContent('[data-testid="drawer"]')) || "";
  const dbl = drawerText.toLowerCase().match(/\b(\w+)\s+\1\b/);
  ok(`${label} drawer prose has no doubled word`, !dbl, dbl ? `"${dbl[0]}"` : "");
  await pg.click('[data-testid="scrim"]'); await pg.waitForTimeout(150);
  const drawerGone = await pg.$('[data-testid="drawer"]');
  ok(`${label} closing the drawer restores the board`, drawerGone === null);

  // screenshot for the eye pass
  await pg.screenshot({ path: `${OUT}/roadmap-${boardKey}-${width}.png`, fullPage: true });

  await ctx.close();
}

// ── failure proof: remove flex:0 0 auto at runtime → squash assertions go red ──
async function failureProof() {
  console.log(`\n=== FAILURE PROOF (App @ 1600, ideas column overflows) ===`);
  const { ctx, pg } = await openBoard(1600, "app");
  const measure = () => pg.$$eval('[data-testid="card"]', (els) => {
    let squashed = 0, outside = 0;
    for (const el of els) {
      const cr = el.getBoundingClientRect();
      const m = el.querySelector('[data-testid="card-meta"]');
      if (el.scrollHeight > el.clientHeight + 1) squashed++;
      if (m && m.getBoundingClientRect().bottom > cr.bottom + 1) outside++;
    }
    return { squashed, outside, n: els.length };
  });
  const before = await measure();
  // simulate deleting `flex: 0 0 auto` from the card rule
  await pg.addStyleTag({ content: `[data-testid="card"]{flex:1 1 auto !important}` });
  await pg.waitForTimeout(200);
  const after = await measure();
  console.log(`  before(with flex-none): squashed=${before.squashed} outside=${before.outside} of ${before.n}`);
  console.log(`  after (flex:1 1 auto):  squashed=${after.squashed} outside=${after.outside} of ${after.n}`);
  ok(`FAILURE PROOF: squash assertion GREEN with the rule`, before.squashed === 0 && before.outside === 0);
  ok(`FAILURE PROOF: squash assertion RED without the rule`, after.squashed > 0 || after.outside > 0, `after squashed=${after.squashed} outside=${after.outside}`);
  await ctx.close();
}

try {
  for (const w of [1600, 1280]) {
    await runBoard(w, "app");
    await runBoard(w, "clubhouse");
  }
  await failureProof();
} finally {
  await browser.close();
  await sb.from("kanban_cards").delete().eq("id", fixtureId);
  console.log("\ndeleted fixture", fixtureId.slice(0, 8));
}

console.log(`\n${"=".repeat(50)}\nPASS ${pass}  FAIL ${fail}`);
if (fails.length) { console.log("FAILURES:\n" + fails.map((f) => "  - " + f).join("\n")); process.exit(1); }
