// Phase 23 Step 1 — the staged-field match panel. Drives the real MatchPanel with a mocked
// /api/matchday/production/matches/{id} (GET → match + managers + fields; PUT captures the diff body).
// Deep coverage: EVERY staged field renders its server value AND edits to exactly its own key (a
// wrong-key wiring is the likeliest bug in a panel this wide); multi-field diff; each of the five
// fakeSpotLeft ceilings independently; cents/minutes/totals conversions in the BODY; wall-clock with
// no shift; rising-ceiling warns-not-blocks; type read-only on a non-exposed type; manager name→id;
// password never in a body; layout at 1600 and 390 separately.
//   node scripts/e2e/verify-matchpanel.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const REGULAR = {
  id: 17494, name: "PRUMC - Tuesday", type: "REGULAR", category: "OPEN",
  managerId: 65903, secondManagerId: null, fieldId: 199,
  startDate: "2026-08-11T19:00:00.000Z", endDate: "2026-08-11T20:30:00.000Z",
  registrationPrice: 1000, additionalSpotPrice: null, guestCount: 10, isFreeMember: true,
  maxPlayerCount: 18,
  fakeSpotLeft36h: 12, fakeSpotLeft24h: 10, fakeSpotLeft12h: 6, fakeSpotLeft6h: 4, fakeSpotLeft3h: 3,
  autoCanceled: true, autoCanceledMinutes: 75, minPlayerCount: 6, isAutoBump: true,
  maxTeamSize2Team: 16, maxTeamSize4Team: 28,
  description: "Game will be recorded!", managerIntro: "I love the game as much as you do.",
  isCancelled: false, teams: [{ teamNumber: 1 }, { teamNumber: 2 }, { teamNumber: 3 }],
  occupancy: 12, realOccupancy: 1, cityName: "Atlanta", fieldTitle: "PRUMC", cityId: 5,
  manager: { firstName: "Troy", lastName: "" }, secondManager: null,
};
const MANAGERS = [{ id: 65903, name: "Troy" }, { id: 44120, name: "Christian Boada" }, { id: 51882, name: "Drea" }];
const FIELDS = [{ id: 199, title: "Atlanta — PRUMC", city: "Atlanta" }, { id: 201, title: "Austin — Onion Creek", city: "Austin" }];

let puts = [];

// ── Step 2 TEAMS (immediate) — a MUTABLE roster fixture per match id, driven by the SAME roster
// route the standalone editor used. rosterPosts captures every immediate write (by kind) so the gate
// can prove counts + endpoint isolation; the shape POST returns a deliberately MISLEADING outcome so
// the "report from teams[].length, not the response status" rule can be tested.
let rosterPosts = [];
let rosterGets = 0;
const rosterStates = {};
const twoTeamRoster = () => ({
  name: "PRUMC - Tuesday",
  teams: [{ id: 501, teamNumber: 1, name: "Green", locked: false }, { id: 502, teamNumber: 2, name: "Blue", locked: false }],
  players: [
    { umId: 9001, playerId: 1, team: 1, playerNumber: 1, name: "Alex Kim", fake: false },
    { umId: 9002, playerId: 2, team: 1, playerNumber: 2, name: "Sam Reyes", fake: true },
    { umId: 9003, playerId: 3, team: 2, playerNumber: 1, name: "Jordan Lee", fake: false },
  ], shape: { teamN: 2, perTeam: 9 }, maxPlayerCount: 18, occupancy: 3, _um: -1,
});
const fourTeamRoster = () => ({
  name: "Bracket Night",
  teams: [{ id: 601, teamNumber: 1, name: "Green", locked: false }, { id: 602, teamNumber: 2, name: "Blue", locked: false }, { id: 603, teamNumber: 3, name: "Red", locked: false }, { id: 604, teamNumber: 4, name: "Gold", locked: false }],
  players: [
    { umId: 8001, playerId: 1, team: 1, playerNumber: 1, name: "Alex Kim", fake: false },
    { umId: 8003, playerId: 3, team: 3, playerNumber: 1, name: "Chris Vale", fake: false },
    { umId: 8004, playerId: 4, team: 4, playerNumber: 1, name: "Dana Poe", fake: false },
  ], shape: { teamN: 4, perTeam: 5 }, maxPlayerCount: 20, occupancy: 3, _um: -1,
});
const rosterFor = (id) => (rosterStates[id] ??= String(id).endsWith("4444") ? fourTeamRoster() : twoTeamRoster());
const setTeamCount = (st, n) => {
  const cur = st.teams.length;
  if (n > cur) for (let k = cur + 1; k <= n; k++) st.teams.push({ id: 500 + k, teamNumber: k, name: `Team ${k}`, locked: false });
  else if (n < cur) { st.teams = st.teams.slice(0, n); st.players = st.players.map((p) => (p.team > n ? { ...p, team: 1 } : p)); }
};

function matchFor(id) {
  if (String(id).endsWith("9999")) return { ...REGULAR, id: Number(id), type: "BRACKET" };
  if (String(id).endsWith("8888")) return { ...REGULAR, id: Number(id), maxPlayerCount: 18, teams: [{ teamNumber: 1 }, { teamNumber: 2 }, { teamNumber: 3 }, { teamNumber: 4 }] }; // 18/4 = 4.5, non-divisible
  return { ...REGULAR, id: Number(id) };
}

const grantAdmin = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let j = await res.json().catch(() => null);
  const p = (r) => ({ ...r, is_admin: true, can_access_matchops: true, can_edit_matches: true, can_access_chats: true });
  j = Array.isArray(j) ? j.map(p) : (j && typeof j === "object" ? p(j) : j);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(j) });
});

async function routes(ctx) {
  await ctx.route("**/rest/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await ctx.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await ctx.route(/\/api\/matchday\/production\/matches\/\d+(\?.*)?$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const method = route.request().method();
    const json = (o) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (method === "GET") return json({ match: matchFor(id), fields: FIELDS, players: [], managers: MANAGERS });
    if (method === "PUT") {
      const b = JSON.parse(route.request().postData() || "{}");
      puts.push(b.changes || {});
      return json({ ok: true, outcome: "landed", logRecorded: true, match: { ...matchFor(id), ...(b.changes || {}) } });
    }
    return json({});
  });
  // roster route — the IMMEDIATE endpoint the TEAMS section fires on (rename / add / move / remove / shape)
  await ctx.route(/\/api\/matchday\/production\/roster\/\d+(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").pop();
    const method = route.request().method();
    const json = (o, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    const st = rosterFor(id);
    if (method === "GET") {
      if (url.searchParams.get("q") !== null) return json({ results: [{ id: 77, name: "New Player", isFake: false }] });
      rosterGets++;
      return json({ matchId: Number(id), name: st.name, teams: st.teams, players: st.players, shape: st.shape, maxPlayerCount: st.maxPlayerCount, occupancy: st.occupancy });
    }
    if (method === "POST") {
      const op = JSON.parse(route.request().postData() || "{}");
      rosterPosts.push(op);
      switch (op.kind) {
        case "teams": {
          if (op.fields?.name === "FAILNAME") return json({ error: "rename rejected by server" }, 400);
          const t = st.teams.find((x) => x.id === op.teamId); if (t) t.name = op.fields.name;
          return json({ ok: true, outcome: "landed", result: {} });
        }
        case "add": { const um = st._um--; st.players.push({ umId: um, playerId: op.playerId, team: op.team, playerNumber: op.playerNumber, name: "New Player", fake: false }); return json({ ok: true, outcome: "landed", result: { id: um } }); }
        case "move": { const p = st.players.find((x) => x.umId === op.userMatchId); if (p) { p.team = op.team; p.playerNumber = op.playerNumber; } return json({ ok: true, outcome: "landed", result: {} }); }
        case "remove": { st.players = st.players.filter((x) => x.umId !== op.userMatchId); return json({ ok: true, outcome: "landed", result: {} }); }
        // MISLEADING outcome on purpose: teams[].length (the re-read) is the only honest signal.
        case "shape": { setTeamCount(st, op.fields.teamNumbers); return json({ ok: true, outcome: "not applied", result: {} }); }
        default: return json({ ok: true });
      }
    }
    return json({});
  });
  await grantAdmin(ctx);
}

// every staged field: testid, key, its rendered server value, and an edit that changes it
const FLD = [
  { t: "mp-name", key: "name", kind: "text", render: "PRUMC - Tuesday", edit: { fill: "PRUMC NIGHT" } },
  { t: "mp-price", key: "registrationPrice", kind: "text", render: "10.00", edit: { fill: "20.00" } },
  { t: "mp-spot", key: "additionalSpotPrice", kind: "text", render: "", edit: { fill: "3.00" } },
  { t: "mp-guests", key: "guestCount", kind: "text", render: "10", edit: { fill: "5" } },
  { t: "mp-maxplayers", key: "maxPlayerCount", kind: "text", render: "18", edit: { fill: "24" } },
  { t: "mp-acmin", key: "autoCanceledMinutes", kind: "text", render: "75", edit: { fill: "90" } },
  { t: "mp-min", key: "minPlayerCount", kind: "text", render: "6", edit: { fill: "9" } },
  { t: "mp-fake36", key: "fakeSpotLeft36h", kind: "text", render: "12", edit: { fill: "14" } },
  { t: "mp-fake24", key: "fakeSpotLeft24h", kind: "text", render: "10", edit: { fill: "9" } },
  { t: "mp-fake12", key: "fakeSpotLeft12h", kind: "text", render: "6", edit: { fill: "5" } },
  { t: "mp-fake6", key: "fakeSpotLeft6h", kind: "text", render: "4", edit: { fill: "3" } },
  { t: "mp-fake3", key: "fakeSpotLeft3h", kind: "text", render: "3", edit: { fill: "2" } },
  { t: "mp-desc", key: "description", kind: "text", render: "Game will be recorded!", edit: { fill: "new description text" } },
  { t: "mp-intro", key: "managerIntro", kind: "text", render: "I love the game as much as you do.", edit: { fill: "new intro text" } },
  { t: "mp-type", key: "type", kind: "select", render: "REGULAR", edit: { select: "EVENT" } },
  { t: "mp-field", key: "fieldId", kind: "select", render: "199", edit: { select: "201" } },
  { t: "mp-mgr", key: "managerId", kind: "select", render: "65903", edit: { select: "44120" } },
  { t: "mp-mgr2", key: "secondManagerId", kind: "select", render: "", edit: { select: "51882" } },
  { t: "mp-max2", key: "maxTeamSize2Team", kind: "select", render: "16", edit: { select: "20" } },
  { t: "mp-max4", key: "maxTeamSize4Team", kind: "select", render: "28", edit: { select: "36" } },
  { t: "mp-free", key: "isFreeMember", kind: "toggle", render: true, edit: { click: true } },
  { t: "mp-ac", key: "autoCanceled", kind: "toggle", render: true, edit: { click: true } },
  { t: "mp-bump", key: "isAutoBump", kind: "toggle", render: true, edit: { click: true } },
];

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState });
  await routes(ctx);
  const page = await ctx.newPage();
  // one persistent dialog handler; each test sets the intent just before it acts (immediate ops and
  // Revert use window.confirm). dlg.msg captures the last message for assertion.
  const dlg = { accept: true, msg: null };
  page.on("dialog", async (d) => { dlg.msg = d.message(); if (dlg.accept) await d.accept(); else await d.dismiss(); });
  const openDiff = async () => { if (await page.$eval('[data-testid="mp-diffhd"]', (e) => e.getAttribute("aria-expanded")) === "false") await page.click('[data-testid="mp-diffhd"]'); };
  const diffKeysNow = () => page.$$eval('[data-testid="mp-diff-item"]', (els) => els.map((e) => e.getAttribute("data-key")).sort());
  const val = (t) => page.$eval(`[data-testid="${t}"]`, (e) => e.value);
  const has = async (t) => (await page.$(`[data-testid="${t}"]`)) !== null;
  const doEdit = async (f) => {
    if (f.edit.fill != null) await page.fill(`[data-testid="${f.t}"]`, f.edit.fill);
    else if (f.edit.select != null) await page.selectOption(`[data-testid="${f.t}"]`, f.edit.select);
    else if (f.edit.click) await page.click(`[data-testid="${f.t}"]`);
  };

  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-name"]', { timeout: 30000 });

  // ── RENDER: every staged field shows its server value ──
  for (const f of FLD) {
    const got = f.kind === "toggle" ? await page.$eval(`[data-testid="${f.t}"]`, (e) => e.checked) : await val(f.t);
    eq(`render: ${f.key} shows its server value`, got, f.render);
  }
  eq("render: start = 19:00 (raw wall time, no shift)", await val("mp-start"), "19:00");
  eq("render: date = 2026-08-11 (raw wall date)", await val("mp-date"), "2026-08-11");

  // SPOTS — divisible capacity (18 over 3 teams = 6/team) shows a WHOLE per-team, no na note
  eq("spots: divisible capacity (18/3) shows 6 per team, no total-only note", { spt: await page.$eval('[data-testid="mp-spt"]', (e) => e.textContent.trim()), na: await has("mp-spt-na") }, { spt: "6", na: false });

  // ── ISOLATE: editing each field stages EXACTLY its own key ──
  for (const f of FLD) {
    await doEdit(f);
    await openDiff();
    eq(`isolate: editing ${f.key} stages exactly [${f.key}]`, await diffKeysNow(), [f.key]);
    await page.click('[data-testid="mp-revert"]');
    await page.waitForTimeout(50);
  }
  // WHEN is a duration-preserving PAIR: a start-time edit stages BOTH date fields
  await page.fill('[data-testid="mp-start"]', "20:00");
  await openDiff();
  eq("isolate: a start-time edit stages the pair [endDate, startDate]", await diffKeysNow(), ["endDate", "startDate"]);
  await page.click('[data-testid="mp-revert"]');

  // ── multi-field edit → the diff contains exactly those keys ──
  await page.fill('[data-testid="mp-name"]', "Multi");
  await page.fill('[data-testid="mp-min"]', "8");
  await page.fill('[data-testid="mp-price"]', "14.00");
  await openDiff();
  eq("multi: a 3-field edit stages exactly those keys", await diffKeysNow(), ["minPlayerCount", "name", "registrationPrice"]);
  await page.click('[data-testid="mp-revert"]');

  // ── the five fakeSpotLeft ceilings, EACH independently: fake = max(0, capacity − real − ceiling) ──
  { const cap = 18, real = 1, ceil = { 36: 12, 24: 10, 12: 6, 6: 4, 3: 3 }; // capacity=maxPlayerCount, real=realOccupancy
    for (const h of [36, 24, 12, 6, 3]) {
      const shown = await page.$eval(`[data-testid="mp-fakeneed${h}"]`, (e) => e.textContent.trim());
      const need = Math.max(0, cap - real - ceil[h]);
      eq(`ceiling ${h}H: fake figure = max(0, ${cap} − ${real} − ${ceil[h]}) = ${need}`, shown, need === 0 ? "no fakes" : `${need} fake`);
    } }

  // ── SAVE-BODY conversions (the diff IS the body) ──
  puts = []; await page.fill('[data-testid="mp-price"]', "12.00"); await page.click('[data-testid="mp-save"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="mp-toast"]'), null, { timeout: 6000 });
  eq("cents: typing 12.00 sends registrationPrice 1200 in the body", puts.at(-1)?.registrationPrice, 1200);

  { const label = await page.$eval('[data-testid="mp-acmin"]', (e) => e.closest("label").querySelector(".mp-lb").textContent);
    puts = []; await page.fill('[data-testid="mp-acmin"]', "90"); await page.click('[data-testid="mp-save"]'); await page.waitForTimeout(400);
    (/MINUTES/i.test(label) && puts.at(-1)?.autoCanceledMinutes === 90) ? ok("minutes: autoCanceledMinutes labelled MINUTES and sent as 90 (not ×60)") : bad("minutes", `label=${label} sent=${puts.at(-1)?.autoCanceledMinutes}`); }

  puts = []; await page.selectOption('[data-testid="mp-max2"]', "20"); await page.click('[data-testid="mp-save"]'); await page.waitForTimeout(400);
  eq("totals: a 10 × 10 selection sends maxTeamSize2Team 20", puts.at(-1)?.maxTeamSize2Team, 20);

  puts = []; await page.selectOption('[data-testid="mp-mgr"]', "44120"); await page.click('[data-testid="mp-save"]'); await page.waitForTimeout(400);
  eq("manager: the staged body carries the numeric id 44120", puts.at(-1)?.managerId, 44120);

  // ── password NEVER in any body ──
  eq("password never appears in any PUT body", puts.concat([]).some((b) => JSON.stringify(b).includes("password")), false);

  // ── manager renders a NAME, and TYPE offers exactly two options ──
  { const optText = await page.$eval('[data-testid="mp-mgr"]', (e) => e.options[e.selectedIndex].textContent.trim());
    eq("manager renders a name (not an id)", /Christian Boada|Troy/.test(optText), true); }
  { const opts = await page.$$eval('[data-testid="mp-type"] option', (els) => els.map((o) => o.value));
    eq("type dropdown offers exactly REGULAR + EVENT on a Regular match", opts, ["REGULAR", "EVENT"]); }

  // ── rising ceiling warns naming both marks and does NOT block Save ── (state is clean post-save)
  await page.fill('[data-testid="mp-fake24"]', "15");
  await page.waitForTimeout(120);
  { const warn = await page.$('[data-testid="mp-ladderwarn"]'); const txt = warn ? await warn.textContent() : "";
    const saveDisabled = await page.$eval('[data-testid="mp-save"]', (e) => e.disabled);
    (warn && /24 H/.test(txt) && /36 H/.test(txt) && !saveDisabled) ? ok("rising ceiling warns naming both marks (24 H / 36 H) and does NOT block Save") : bad("ladder warn", `warn=${!!warn} saveDisabled=${saveDisabled}`); }
  await page.click('[data-testid="mp-revert"]');

  // ── Revert restores everything ──
  await page.fill('[data-testid="mp-name"]', "x"); await page.fill('[data-testid="mp-min"]', "1");
  await page.click('[data-testid="mp-revert"]'); await page.waitForTimeout(80);
  eq("Revert clears all staged changes", { count: await page.$eval('[data-testid="mp-diffcount"]', (e) => e.textContent.trim()), name: await val("mp-name") }, { count: "No changes", name: "PRUMC - Tuesday" });

  // ── a non-exposed type renders READ-ONLY (no dropdown that could silently rewrite it) ──
  await page.goto(`${BASE}/match-ops/match-panel/19999`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-name"]', { timeout: 15000 });
  eq("BRACKET match shows type read-only, no dropdown", { ro: await has("mp-type-readonly"), dropdown: await has("mp-type") }, { ro: true, dropdown: false });

  // ── non-divisible capacity (18 over 4 teams = 4.5): hide per-team, show total-only, say why ──
  await page.goto(`${BASE}/match-ops/match-panel/18888`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-name"]', { timeout: 15000 });
  eq("spots: 18/4 hides the per-team figure + stepper, shows a total-only note", { na: await has("mp-spt-na"), perTeam: await has("mp-spt"), stepper: await has("mp-spt-plus") }, { na: true, perTeam: false, stepper: false });
  eq("spots: the note says why (doesn't divide evenly into 4 teams)", /doesn't divide evenly into 4 teams/.test(await page.$eval('[data-testid="mp-spt-na"]', (e) => e.textContent)), true);

  // ══════════════ Step 2 · TEAMS — the IMMEDIATE half (each op fires now; Save/Revert never touch it) ══════════════
  await page.setViewportSize({ width: 1440, height: 1000 });
  delete rosterStates["17494"]; // fresh 2-team roster (Green / Blue)
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 20000 });
  eq("teams: the permanent banner says Save/Revert do not apply to these", /Save and Revert do not apply/i.test(await page.$eval('[data-testid="mp-immediate-banner"]', (e) => e.textContent)), true);

  // GATE 1 — a rename fires exactly one request to the roster/teams endpoint and NOTHING to the match endpoint
  rosterPosts = []; puts = []; dlg.accept = true;
  await page.fill('[data-testid="mp-tname-1"]', "Orange");
  await page.click('[data-testid="mp-rename-1"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="mp-tname-committed-1"]')?.textContent === "Orange", null, { timeout: 6000 });
  eq("gate1: rename → exactly one teams request, zero to the match endpoint",
    { teams: rosterPosts.filter((o) => o.kind === "teams").length, total: rosterPosts.length, puts: puts.length }, { teams: 1, total: 1, puts: 0 });

  // GATE 6 — password appears in no teams request body
  eq("gate6: no roster/teams request body contains 'password'", rosterPosts.some((o) => JSON.stringify(o).includes("password")), false);

  // GATE 2 — a rename never enters the staged diff (edit a match field AND rename → the diff is only the field)
  delete rosterStates["17494"]; rosterPosts = []; puts = [];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  await page.fill('[data-testid="mp-name"]', "Renamed Match");
  await page.fill('[data-testid="mp-tname-1"]', "Teal");
  await page.click('[data-testid="mp-rename-1"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="mp-tname-committed-1"]')?.textContent === "Teal", null, { timeout: 6000 });
  await openDiff();
  eq("gate2: a team rename never enters the staged diff (diff = only the match field)", await diffKeysNow(), ["name"]);

  // GATE 3 — Revert after a rename leaves the new name in place; its confirmation SAYS it won't undo immediate changes
  dlg.accept = true; dlg.msg = null;
  await page.click('[data-testid="mp-revert"]');
  await page.waitForTimeout(200);
  { const nameStays = await page.$eval('[data-testid="mp-tname-committed-1"]', (e) => e.textContent);
    const staged = await page.$eval('[data-testid="mp-diffcount"]', (e) => e.textContent.trim());
    (nameStays === "Teal" && /No changes/.test(staged) && dlg.msg && /does NOT undo|team\/roster/i.test(dlg.msg))
      ? ok("gate3: Revert leaves the renamed team in place and its confirmation says it won't undo immediate changes")
      : bad("gate3", `name=${nameStays} staged=${staged} dlg=${JSON.stringify(dlg.msg)}`); }

  // GATE 4 — rename failure: the shown name reverts, the typed text is kept, no success state
  delete rosterStates["17494"]; rosterPosts = [];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  await page.fill('[data-testid="mp-tname-2"]', "FAILNAME");
  await page.click('[data-testid="mp-rename-2"]');
  await page.waitForSelector('[data-testid="mp-optoast"].bad', { timeout: 6000 }).catch(() => {});
  { const committed = await page.$eval('[data-testid="mp-tname-committed-2"]', (e) => e.textContent);
    const typed = await val("mp-tname-2");
    const toastBad = await page.$('[data-testid="mp-optoast"].bad');
    (committed === "Blue" && typed === "FAILNAME" && !!toastBad)
      ? ok("gate4: rename failure keeps the typed text, reverts the shown name, shows no success")
      : bad("gate4", `committed=${committed} typed=${typed} bad=${!!toastBad}`); }

  // GATE 5 — no price and no locked control anywhere in TEAMS (count 0)
  eq("gate5: TEAMS exposes no price and no locked control (count 0)", await page.$eval('[data-testid="mp-teams"]', (el) =>
    el.querySelectorAll('[data-testid*="price" i],[data-testid*="lock" i],input[name*="price" i],input[name*="lock" i],[aria-label*="lock" i],[aria-label*="price" i]').length), 0);

  // GATE 7 — add / move / remove each fire exactly one request, none touch the match endpoint
  delete rosterStates["17494"]; rosterPosts = []; puts = [];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  await page.fill('[data-testid="mp-add-search"]', "new");
  await page.waitForSelector('[data-testid="mp-add-result"]', { timeout: 6000 });
  await page.click('[data-testid="mp-add-result"]');
  await page.waitForSelector('[data-testid="mp-add-to-2"]', { timeout: 4000 });
  await page.click('[data-testid="mp-add-to-2"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="mp-player"]')].some((e) => e.textContent.includes("New Player")), null, { timeout: 6000 });
  eq("gate7a: add fires exactly one roster request, zero to the match endpoint", { add: rosterPosts.filter((o) => o.kind === "add").length, puts: puts.length }, { add: 1, puts: 0 });

  rosterPosts = []; puts = [];
  await page.click('[data-testid="mp-move-9001-2"]');
  await page.waitForTimeout(400);
  eq("gate7b: move fires exactly one roster request, zero to the match endpoint", { move: rosterPosts.filter((o) => o.kind === "move").length, puts: puts.length }, { move: 1, puts: 0 });

  rosterPosts = []; puts = []; dlg.accept = true;
  await page.click('[data-testid="mp-remove-9003"]');
  await page.waitForTimeout(400);
  eq("gate7c: remove fires exactly one roster request, zero to the match endpoint", { remove: rosterPosts.filter((o) => o.kind === "remove").length, puts: puts.length }, { remove: 1, puts: 0 });

  // GATE 8 — fake players are visibly marked; real players are not
  delete rosterStates["17494"];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  { const marks = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="mp-player"]')];
      const fakeRows = rows.filter((r) => r.getAttribute("data-fake") === "1");
      return { fakeRows: fakeRows.length, taggedFakes: fakeRows.filter((r) => r.querySelector('[data-testid="mp-fake-tag"]')).length, taggedReal: rows.filter((r) => r.getAttribute("data-fake") === "0" && r.querySelector('[data-testid="mp-fake-tag"]')).length };
    });
    (marks.fakeRows >= 1 && marks.taggedFakes === marks.fakeRows && marks.taggedReal === 0)
      ? ok(`gate8: every fake player carries a FAKE mark (${marks.taggedFakes}) and no real player does`) : bad("gate8", JSON.stringify(marks)); }

  // GATE 9 — team count 2→4: the write is sent, the panel RE-READS, and the verdict comes from teams[].length,
  //          NOT the response status (the shape POST deliberately returns outcome "not applied").
  delete rosterStates["17494"]; rosterPosts = []; puts = [];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-teamcount-4"]', { timeout: 15000 });
  const getsBefore = rosterGets;
  await page.click('[data-testid="mp-teamcount-4"]');
  await page.waitForFunction(() => /LANDED|NOT APPLIED/.test(document.querySelector('[data-testid="mp-teamcount-result"]')?.textContent || ""), null, { timeout: 6000 });
  { const result = await page.$eval('[data-testid="mp-teamcount-result"]', (e) => e.textContent);
    const shapePost = rosterPosts.find((o) => o.kind === "shape");
    (shapePost?.fields?.teamNumbers === 4 && puts.length === 0 && /LANDED/.test(result) && /4 teams/.test(result) && rosterGets > getsBefore)
      ? ok("gate9: 2→4 sends teamNumbers, re-reads, reports LANDED from teams[].length (not the 'not applied' response)")
      : bad("gate9", `post=${JSON.stringify(shapePost)} result=${result} reRead=${rosterGets > getsBefore}`); }

  // GATE 10 — 4→2 with players on the disappearing teams: the confirmation NAMES the count; dismissing it sends nothing
  delete rosterStates["14444"]; rosterPosts = [];
  await page.goto(`${BASE}/match-ops/match-panel/14444`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-teamcount-2"]', { timeout: 15000 });
  dlg.accept = false; dlg.msg = null;
  await page.click('[data-testid="mp-teamcount-2"]');
  await page.waitForTimeout(400);
  { const named = dlg.msg && /2 player/.test(dlg.msg) && /reassigned/i.test(dlg.msg);
    const sent = rosterPosts.filter((o) => o.kind === "shape").length;
    (named && sent === 0) ? ok("gate10: 4→2 confirmation names the 2 affected players; dismissing sends nothing")
      : bad("gate10", `dlg=${JSON.stringify(dlg.msg)} shapePosts=${sent}`); }
  dlg.accept = true;

  // ── layout at 1600 and 390 — SEPARATE assertions (the TEAMS section is now VISIBLE; assert it fits) ──
  delete rosterStates["17494"];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-teams"]', { timeout: 15000 });
  for (const w of [1600, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const noOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
      const pr = document.querySelector('[data-testid="mp-panel"]').getBoundingClientRect();
      const fits = pr.right <= window.innerWidth + 1 && pr.left >= -1;
      const teams = document.querySelector('[data-testid="mp-teams"]');
      const teamsVisible = !!teams && getComputedStyle(teams).display !== "none";
      const tr = teams.getBoundingClientRect();
      const teamsFits = tr.right <= window.innerWidth + 1 && tr.left >= -1;
      return { noOverflow, fits, teamsVisible, teamsFits };
    });
    (r.noOverflow && r.fits && r.teamsVisible && r.teamsFits) ? ok(`layout at ${w}px — no overflow, panel + TEAMS fit, immediate section visible`) : bad(`layout ${w}px`, JSON.stringify(r));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
