// Phase 13 PART 5 — the roster editor, driven in a real browser, hermetic.
// GET/search/POST to /api/matchday/** are all route-fulfilled, so nothing touches
// a real MatchDay backend. Proves: live read + data-driven team count, the diff
// plan (there-and-back nets zero, changed-fields-only), swap-not-overwrite via the
// real drop handler, add-where, the remove confirm wording (NOT a refund), lock
// refusal, shape-shrink refusal that NAMES the stranded player, and — the heart —
// the FOUR read-back save states (LANDED / FAILED / NOT APPLIED / UNKNOWN) with
// UNKNOWN visually AND verbally distinct and the ONLY state that stops the run.
// Plus a full contrast sweep across every painted state, and an overflow check.
//   node scripts/e2e/auth.mjs   (optional; this script mints its own session)
//   node scripts/e2e/verify-roster.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { contrast, overflow } from "./checks.mjs";

// contrast, scoped to a subtree — the roster screen is what Phase 13 owns; the
// shared app-shell nav is a separate component. Same maths as checks.mjs, rooted.
async function contrastIn(page, rootSel) {
  return page.evaluate((rootSel) => {
    const root = document.querySelector(rootSel); if (!root) return { min: Infinity, minNode: null, failures: [] };
    const parseColor = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x.trim())); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
    const effBg = (el) => { let n = el; while (n && n.nodeType === 1) { const c = parseColor(getComputedStyle(n).backgroundColor); if (c && c.a > 0.85) return c; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const hasText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    const visible = (el) => { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false; return el.offsetParent !== null || s.position === "fixed"; };
    const failures = []; let min = Infinity, minNode = null;
    for (const el of root.querySelectorAll("*")) {
      if (!hasText(el) || !visible(el)) continue;
      const fg = parseColor(getComputedStyle(el).color); if (!fg) continue;
      const r = ratio(fg, effBg(el));
      const rec = { ratio: Math.round(r * 100) / 100, text: el.textContent.trim().slice(0, 40), cls: (el.getAttribute("class") || "").slice(0, 40), tag: el.tagName.toLowerCase() };
      if (r < min) { min = Math.round(r * 100) / 100; minNode = rec; }
      if (r < 4.5) failures.push(rec);
    }
    failures.sort((a, b) => a.ratio - b.ratio);
    return { min, minNode, failures };
  }, rootSel);
}

const BASE = process.env.BASE || "http://localhost:3000";
const MATCH = 17371;
const PAGE_URL = `${BASE}/match-ops/matches/${MATCH}/roster`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// ── the roster GET payload (route.ts shape). team = teamNumber (1-indexed). ──
const FRESH = () => ({
  matchId: MATCH, name: "Sunday Night 7s",
  teams: [
    { id: 9001, teamNumber: 1, name: "Team 1", locked: false },
    { id: 9002, teamNumber: 2, name: "Team 2", locked: false },
  ],
  players: [
    { umId: 5001, playerId: 101, team: 1, playerNumber: 1, name: "Alex Kim", fake: false },
    { umId: 5002, playerId: 102, team: 1, playerNumber: 7, name: "Blair Cruz", fake: false },
    { umId: 5003, playerId: 103, team: 2, playerNumber: 1, name: "Jo Park", fake: false },
  ],
  shape: { teamN: 2, perTeam: 7 }, maxPlayerCount: 14,
});

// mutate STATE to reflect an op landing (used only when a scenario "lands" it)
function applyOp(S, op, newUmId) {
  switch (op.kind) {
    case "teams": { const t = S.teams.find((x) => x.id === op.teamId); if (t) Object.assign(t, op.fields || {}); break; }
    case "move": { const p = S.players.find((x) => x.umId === op.userMatchId); if (p) { p.team = op.team; p.playerNumber = op.playerNumber; } break; }
    case "remove": S.players = S.players.filter((x) => x.umId !== op.userMatchId); break;
    case "add": S.players.push({ umId: newUmId, playerId: op.playerId, team: op.team, playerNumber: op.playerNumber, name: "Added Player", fake: false }); break;
    case "add-fake": S.players.push({ umId: newUmId, playerId: 900000 + newUmId, team: op.team, playerNumber: op.playerNumber, name: "Fake Player", fake: true }); break;
    case "shape": S.maxPlayerCount = op.fields?.maxPlayerCount ?? S.maxPlayerCount; break;
    case "fake": { const p = S.players.find((x) => x.playerId === op.playerId); if (p) p.fake = !p.fake; break; }
  }
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] } });

  // ── the programmable mock: STATE for GET, MODE + posts[] for POST ──
  let STATE = FRESH();
  let MODE = "landed"; let posts = []; let umSeq = 8000;
  await context.route("**/api/matchday/**", (route) => {
    const req = route.request(); const m = req.method(); const url = req.url();
    const J = (o, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    if (m === "GET") {
      if (url.includes("q=")) return J({ results: [{ id: 777, name: "Robin Vale", isFake: false }] });
      return J(STATE);
    }
    // POST — one planned op
    const op = JSON.parse(req.postData() || "{}"); posts.push(op); const i = posts.length - 1;
    const landRow = () => { const id = ++umSeq; applyOp(STATE, op, id); return J({ ok: true, result: { id } }); };
    if (MODE === "landed") return landRow();
    if (MODE === "failed") return i === 0 ? J({ error: "PLAYER_NUMBER_ALREADY_TAKEN" }, 403) : landRow();
    if (MODE === "notapplied") return i === 0 ? J({ ok: true, result: {} }) /* 2xx, NOT applied */ : landRow();
    if (MODE === "unknown") return i === 0 ? J({ error: "gateway timeout", ambiguous: true }, 502) : landRow();
    return landRow();
  });
  const page = await context.newPage();
  const dialogs = []; page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

  const load = async () => { await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-testid="roster"]', { timeout: 30000 }); await page.waitForTimeout(200); };
  const planCodes = () => page.$$eval('[data-testid="plan-row"]', (els) => els.map((e) => ({ state: e.getAttribute("data-state"), txt: e.textContent, code: (e.querySelector("code") || {}).textContent || "" })));
  const rowStates = () => page.$$eval('[data-testid="plan-row"]', (els) => els.map((e) => e.getAttribute("data-state")));

  const contrasts = []; // collect min/failures across every painted state

  // ═══ RENDER ═══
  STATE = FRESH(); await load();
  eq("team count comes from the data (2 sections)", await page.$$eval('[data-testid="team"]', (e) => e.length), 2);
  ok((await page.$eval('[data-testid="roster-env"]', (e) => e.textContent)).includes("PRODUCTION") ? "env badge reads PRODUCTION — LIVE EDITS" : bad("env badge PRODUCTION"));
  eq("all placed players rendered (3)", await page.$$eval('[data-testid="player"]', (e) => e.length), 3);
  eq("no changes on clean load -> plan empty + save disabled", { plan: (await planCodes()).length, save: await page.$eval('[data-testid="save"]', (b) => b.disabled) }, { plan: 0, save: true });
  contrasts.push(["base", await contrastIn(page, ".rse")]);
  { const o = await (async () => { await page.setViewportSize({ width: 1600, height: 1100 }); return overflow(page); })(); (!o.pageLeak) ? ok("no page-level horizontal overflow at 1600") : bad("horizontal overflow", JSON.stringify(o.offenders.slice(0, 3))); await page.setViewportSize({ width: 1440, height: 1100 }); }

  // ═══ DIFF IS A DIFF ═══
  await page.fill('[data-testid="tname-0"]', "Reds");
  { const p = await planCodes(); eq("one rename -> 1 request, teams endpoint", { n: p.length, teams: p[0]?.code.includes("/admin/teams/9001") }, { n: 1, teams: true }); }
  await page.fill('[data-testid="tname-0"]', "Team 1"); // rename back
  eq("there-and-back nets zero (diff, not a journal)", (await planCodes()).length, 0);

  // ═══ MOVE (plain) — keyed userMatchId, POST /admin/user-matches ═══
  await page.selectOption('[data-testid="slot"]:has([data-key="p101"]) [data-testid="move-menu"]', "1:2"); // Alex -> team2 #2 (open)
  { const p = await planCodes(); eq("plain move -> 1 row, POST /admin/user-matches", { n: p.length, kind: p[0]?.code }, { n: 1, kind: "POST /admin/user-matches" }); }
  await page.selectOption('[data-testid="slot"]:has([data-key="p101"]) [data-testid="move-menu"]', "0:1"); // move Alex back
  eq("move there-and-back nets zero", (await planCodes()).length, 0);

  // ═══ SWAP — drop onto an occupied slot swaps, never overwrites, never drops ═══
  await page.evaluate(() => {
    const src = document.querySelector('[data-key="p101"]'); // Alex, team1 #1
    const tgt = document.querySelector('[data-slot="1:1"]'); // Jo's slot, team2 #1
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    tgt.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(80);
  { const p = await planCodes(); const dels = p.filter((r) => r.code.startsWith("DELETE")); const moves = p.filter((r) => r.code === "POST /admin/user-matches");
    eq("drop onto occupied = 2 moves, no removals (swap not overwrite)", { moves: moves.length, dels: dels.length }, { moves: 2, dels: 0 });
    eq("swap keeps the roster whole (still 3 players)", await page.$$eval('[data-testid="player"]', (e) => e.length), 3); }

  // ═══ REMOVE — DELETE /admin/matches/user-matches/{um}; confirm says NOT a refund ═══
  STATE = FRESH(); await load(); dialogs.length = 0;
  await page.click('[data-testid="slot"]:has([data-key="p103"]) [data-testid="remove"]'); // remove Jo
  await page.waitForTimeout(60);
  { const p = await planCodes(); eq("remove -> DELETE /admin/matches/user-matches/{um}", p[0]?.code, "DELETE /admin/matches/user-matches/5003"); }
  { const msg = dialogs[0] || ""; const good = /NOT a refund/i.test(msg) && /refund-and-cancel/i.test(msg) && /UNCONFIRMED/i.test(msg);
    good ? ok("remove confirm: NOT a refund + deny-listed + charge UNCONFIRMED") : bad("remove confirm wording", JSON.stringify(msg.slice(0, 120))); }

  // ═══ ADD-WHERE — real player keyed playerId; fake keyed by team/slot ═══
  STATE = FRESH(); await load();
  await page.fill('[data-testid="add-search"]', "robin");
  await page.waitForSelector('[data-testid="add-result"]', { timeout: 5000 });
  await page.click('[data-testid="add-result"]');
  await page.waitForSelector('[data-testid="add-where"]');
  await page.click('[data-testid="add-to-0"]'); // add to Team 1
  { const p = await planCodes(); eq("add real player -> POST /admin/matches/{id}/players/{pid}", p.some((r) => r.code === `POST /admin/matches/${MATCH}/players/777`), true); }
  await page.click('[data-testid="add-fake"]');
  await page.waitForSelector('[data-testid="add-where"]');
  await page.click('[data-testid="add-to-1"]');
  { const p = await planCodes(); eq("add fake -> POST /admin/matches/{id}/fake-players", p.some((r) => r.code === `POST /admin/matches/${MATCH}/fake-players`), true); }

  // ═══ LOCK refuses a move in; only the lock request is planned ═══
  STATE = FRESH(); await load();
  await page.click('[data-testid="lock-1"]'); // lock Team 2
  await page.evaluate(() => { // try to drop Alex into the locked team
    const src = document.querySelector('[data-key="p101"]');
    const tgt = document.querySelector('[data-slot="1:3"]');
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    tgt.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(80);
  { const p = await planCodes(); const onlyLock = p.length === 1 && p[0].code.includes("/admin/teams/9002");
    onlyLock ? ok("locked team refuses a move in (only the lock request is planned)") : bad("lock refusal", JSON.stringify(p.map((r) => r.code))); }
  { const t = await page.$eval('[data-testid="toast"]', (e) => e.textContent).catch(() => ""); /(lock)/i.test(t) ? ok("lock refusal shows a spoken reason") : bad("lock toast", JSON.stringify(t)); }

  // ═══ SHAPE shrink refused when it would strand — and NAMES them ═══
  STATE = FRESH(); await load();
  await page.click('[data-testid="spots-dec"]'); // 7 -> 6 would strand Blair Cruz (#7)
  await page.waitForTimeout(60);
  { const v = await page.$eval('[data-testid="spots-v"]', (e) => e.textContent); const t = await page.$eval('[data-testid="toast"]', (e) => e.textContent).catch(() => "");
    (v === "7" && /Blair Cruz/.test(t)) ? ok("shrink refused: value unchanged + names the stranded player") : bad("shrink refusal", `spots=${v} toast=${JSON.stringify(t.slice(0, 90))}`); }

  // ═══ FOUR-STATE SAVE ═══ (two team renames per scenario)
  const twoRenames = async () => { await page.fill('[data-testid="tname-0"]', "Reds"); await page.fill('[data-testid="tname-1"]', "Blues"); };
  const runSave = async (mode) => { STATE = FRESH(); MODE = mode; posts = []; await load(); await twoRenames(); await page.click('[data-testid="save"]'); await page.waitForTimeout(1200); };

  // LANDED — both land after read-back; success + STATE reflects both; plan clears
  await runSave("landed");
  { const t = await page.$eval('[data-testid="toast"]', (e) => e.textContent).catch(() => ""); const names = STATE.teams.map((x) => x.name).sort();
    (posts.length === 2 && names.join(",") === "Blues,Reds" && /saved/i.test(t)) ? ok("LANDED: 2xx + read-back confirms -> both landed, success") : bad("LANDED", `posts=${posts.length} names=${names} toast=${JSON.stringify(t)}`); }
  contrasts.push(["landed", await contrastIn(page, ".rse")]);

  // FAILED — row0 clean-rejected, run CONTINUES, row1 lands; retry scoped to the failure
  await runSave("failed");
  { const s = await rowStates(); const retry = await page.$eval('[data-testid="retry"]', (b) => b.textContent).catch(() => null); const p = await planCodes();
    (s[0] === "failed" && s[1] === "landed" && /Retry\s*1/.test(retry || "") && /FAILED/i.test(p[0]?.txt || "")) ? ok("FAILED: rejected row fails, run continues, retry scoped to it") : bad("FAILED", `states=${s} retry=${retry}`); }
  contrasts.push(["failed", await contrastIn(page, ".rse")]);

  // NOT APPLIED — 2xx but read-back does NOT show it; distinct from FAILED, retryable
  await runSave("notapplied");
  { const s = await rowStates(); const p = await planCodes(); const retry = await page.$eval('[data-testid="retry"]', (b) => b.textContent).catch(() => null);
    (s[0] === "notapplied" && s[1] === "landed" && /NOT APPLIED/i.test(p[0]?.txt || "") && /Retry\s*1/.test(retry || "")) ? ok("NOT APPLIED: 2xx but read-back absent -> its own state, retryable, verbally distinct") : bad("NOT APPLIED", `states=${s} txt=${JSON.stringify(p[0]?.txt?.slice(0,80))}`); }
  const naBorder = await page.$eval('[data-testid="plan-row"][data-state="notapplied"]', (e) => getComputedStyle(e).borderTopWidth).catch(() => "");
  contrasts.push(["notapplied", await contrastIn(page, ".rse")]);

  // UNKNOWN — no answer: STOPS the run, leaves the rest UNSENT, says reload
  await runSave("unknown");
  { const s = await rowStates(); const cnt = await page.$eval('[data-testid="cnt"]', (e) => e.textContent).catch(() => ""); const p = await planCodes(); const hasRetry = await page.$('[data-testid="retry"]');
    (s[0] === "unknown" && s[1] === "pending" && posts.length === 1 && /reload/i.test(cnt) && /reload/i.test(p[0]?.txt || "") && !hasRetry)
      ? ok("UNKNOWN: stops the run, leaves rest UNSENT, retry withheld, says reload") : bad("UNKNOWN", `states=${s} posts=${posts.length} cnt=${JSON.stringify(cnt)} retry=${!!hasRetry}`); }
  const unkBorder = await page.$eval('[data-testid="plan-row"][data-state="unknown"]', (e) => getComputedStyle(e).borderTopWidth);
  (parseFloat(unkBorder) >= 2 && unkBorder !== naBorder) ? ok(`UNKNOWN is visually distinct (border ${unkBorder} vs NOT-APPLIED ${naBorder})`) : bad("UNKNOWN visual distinctness", `unknown=${unkBorder} notapplied=${naBorder}`);
  contrasts.push(["unknown", await contrastIn(page, ".rse")]);

  // ═══ CONTRAST SWEEP across every painted state (roster screen) ═══
  let gmin = Infinity, worst = null, allFails = [];
  for (const [label, c] of contrasts) { if (c.min < gmin) { gmin = c.min; worst = { label, node: c.minNode }; } for (const f of c.failures) allFails.push({ label, ...f }); }
  allFails.sort((a, b) => a.ratio - b.ratio);
  (allFails.length === 0) ? ok(`contrast: every roster text node >= 4.5:1 across ${contrasts.length} painted states (min ${gmin} @ ${worst?.label}: "${worst?.node?.text}")`)
    : bad(`contrast: ${allFails.length} roster node(s) below 4.5:1`, allFails.slice(0, 6).map((f) => `[${f.label}] ${f.ratio} "${f.text}" .${f.cls}`).join(" | "));
  // Surface (not bury) any sub-threshold nodes in the surrounding app shell — NOT
  // owned by Phase 13, but reported so they aren't silently passed.
  const full = await contrast(page);
  const chrome = full.failures.filter((f) => !/\b(mv|rse|slot|who|pill|cnt|st|txt)\b/.test(f.cls));
  if (chrome.length) console.log(`  ·  NOTE (app-shell, pre-existing, outside Phase 13): ${[...new Set(chrome.map((f) => `"${f.text}" ${f.ratio}:1`))].join(", ")}`);

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
