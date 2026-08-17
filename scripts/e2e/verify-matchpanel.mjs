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
import { netRetry, installHarnessGuard, fatal, sessionFor } from "./_session.mjs";
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
let cancelPosts = []; // POSTs to the cancel route (Part C)
let forceNotApplied = false; // when set, roster ops return a 2xx the server did NOT apply (read-back test)
const rosterStates = {};
// A roster carrying the shapes production actually contains: counted rows, an unpaid retry chain
// (paidStatus WAITING — the 27-repeat case on 17516), a cancelled row and a refunded one. The route
// filters these; the fixture exists so the INVARIANT below can bite.
const twoTeamRoster = () => ({
  name: "PRUMC - Tuesday",
  teams: [{ id: 501, teamNumber: 1, name: "Green", locked: false }, { id: 502, teamNumber: 2, name: "Blue", locked: false }],
  players: [
    { umId: 9001, playerId: 1, team: 1, playerNumber: 1, name: "Alex Kim", phone: "+15125550101", fake: false, promoCode: "TOMBALL" },
    { umId: 9002, playerId: 2, team: 1, playerNumber: 2, name: "Sam Reyes", phone: null, fake: true, promoCode: null },
    { umId: 9003, playerId: 3, team: 2, playerNumber: 1, name: "Jordan Lee", phone: "+15125550103", fake: false, promoCode: "TOMBALL" },
  ], shape: { teamN: 2, perTeam: 9 }, maxPlayerCount: 18, occupancy: 3, _um: -1,
  promo: { spots: 2, codes: ["TOMBALL"] },
});
// ITEM 5's fixture: a team returned in the order the API actually uses. Measured on production, 55
// of 95 teams came back NOT ascending — [9,4,5,1,2,3] is the real shape of the White team the brief
// names. It also carries a NULL spot and a DUPLICATE, the two states that must not be papered over.
const shuffledRoster = () => ({
  name: "Shuffle Night",
  teams: [{ id: 701, teamNumber: 1, name: "White", locked: false }, { id: 702, teamNumber: 2, name: "Green", locked: false }],
  players: [
    { umId: 7009, playerId: 9, team: 1, playerNumber: 9, name: "Wanda Nine", phone: "+15125550909", fake: false },
    { umId: 7004, playerId: 4, team: 1, playerNumber: 4, name: "Wes Four", phone: "+15125550404", fake: false },
    { umId: 7005, playerId: 5, team: 1, playerNumber: 5, name: "Will Five", phone: "+15125550505", fake: false },
    { umId: 7001, playerId: 1, team: 1, playerNumber: 1, name: "Wynn One", phone: "+15125550101", fake: false },
    { umId: 7002, playerId: 2, team: 1, playerNumber: 2, name: "Wade Two", phone: "+15125550202", fake: false },
    { umId: 7003, playerId: 3, team: 1, playerNumber: 3, name: "Wren Three", phone: "+15125550303", fake: false },
    { umId: 7099, playerId: 99, team: 1, playerNumber: 3, name: "Dee Dupe", phone: "+15125550399", fake: false },   // DUPLICATE of spot 3
    { umId: 7000, playerId: 90, team: 1, playerNumber: null, name: "Nula Nospot", phone: "+15125550000", fake: false }, // NULL spot
    { umId: 7011, playerId: 11, team: 2, playerNumber: 1, name: "Gina One", phone: "+15125551111", fake: false },
    { umId: 7012, playerId: 12, team: 2, playerNumber: 2, name: "Gus Two", phone: "+15125551212", fake: false },
  ], shape: { teamN: 2, perTeam: 9 }, maxPlayerCount: 18, occupancy: 10, _um: -1,
});
// Four teams with names and phone numbers long enough to be the real test of item 4's layout —
// the brief's complaint was names crushed to "L", "T", "G" at this team count.
const fourTeamRoster = () => ({
  name: "Bracket Night",
  teams: [{ id: 601, teamNumber: 1, name: "Green", locked: false }, { id: 602, teamNumber: 2, name: "Blue", locked: false }, { id: 603, teamNumber: 3, name: "Red", locked: false }, { id: 604, teamNumber: 4, name: "Gold", locked: false }],
  players: [
    { umId: 8001, playerId: 1, team: 1, playerNumber: 1, name: "Alexandra Kimberly", phone: "+15125558001", fake: false },
    { umId: 8002, playerId: 2, team: 2, playerNumber: 1, name: "Bartholomew Reyes", phone: "+15125558002", fake: false },
    { umId: 8003, playerId: 3, team: 3, playerNumber: 1, name: "Christopher Vale", phone: "+15125558003", fake: false },
    { umId: 8004, playerId: 4, team: 4, playerNumber: 1, name: "Dana Poe-Fitzgerald", phone: "+15125558004", fake: false },
  ], shape: { teamN: 4, perTeam: 5 }, maxPlayerCount: 20, occupancy: 4, _um: -1,
});
const rosterFor = (id) => (rosterStates[id] ??= String(id).endsWith("4444") ? fourTeamRoster() : String(id).endsWith("7777") ? shuffledRoster() : twoTeamRoster());
const setTeamCount = (st, n) => {
  const cur = st.teams.length;
  if (n > cur) for (let k = cur + 1; k <= n; k++) st.teams.push({ id: 500 + k, teamNumber: k, name: `Team ${k}`, locked: false });
  else if (n < cur) { st.teams = st.teams.slice(0, n); st.players = st.players.map((p) => (p.team > n ? { ...p, team: 1 } : p)); }
};

function matchFor(id) {
  if (String(id).endsWith("9999")) return { ...REGULAR, id: Number(id), type: "BRACKET" };
  if (String(id).endsWith("2222")) return { ...REGULAR, id: Number(id), maxPlayerCount: 18, teams: [{ teamNumber: 1 }, { teamNumber: 2 }] };
  if (String(id).endsWith("4444")) return { ...REGULAR, id: Number(id), maxPlayerCount: 20, teams: [{ teamNumber: 1 }, { teamNumber: 2 }, { teamNumber: 3 }, { teamNumber: 4 }] };
  if (String(id).endsWith("7777")) return { ...REGULAR, id: Number(id), maxPlayerCount: 18, teams: [{ teamNumber: 1 }, { teamNumber: 2 }] };
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
  // cancel route (Part C) — GET is the LIVE preview; POST executes with the typed name. Registered
  // before the roster/matches routes; the matches regex is $-anchored on the id so /cancel never hits it.
  await ctx.route(/\/api\/matchday\/production\/matches\/\d+\/cancel(\?.*)?$/, async (route) => {
    const method = route.request().method();
    const json = (o, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    if (method === "GET") return json({ name: "PRUMC - Tuesday", count: 9, perPlayerCents: 1000, totalCents: 9000, alreadyCancelled: false });
    if (method === "POST") {
      const b = JSON.parse(route.request().postData() || "{}");
      cancelPosts.push(b);
      if (b.confirmName !== "PRUMC - Tuesday") return json({ error: "The typed name doesn't match.", nameMismatch: true }, 400);
      // report LANDED from match state (isCancelled), not the status code
      return json({ ok: true, landed: true, status: "LANDED", count: 9, totalCents: 9000, name: "PRUMC - Tuesday" });
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
      return json({ matchId: Number(id), name: st.name, teams: st.teams, players: st.players, shape: st.shape, maxPlayerCount: st.maxPlayerCount, occupancy: st.occupancy, promo: st.promo });
    }
    if (method === "POST") {
      const op = JSON.parse(route.request().postData() || "{}");
      rosterPosts.push(op);
      // read-back test: a 2xx the server did NOT apply — return notapplied and DON'T mutate state.
      if (forceNotApplied && (op.kind === "add" || op.kind === "move" || op.kind === "remove" || op.kind === "teams")) return json({ ok: true, outcome: "notapplied", result: {} });
      switch (op.kind) {
        case "teams": {
          if (op.fields?.name === "FAILNAME") return json({ error: "rename rejected by server" }, 400);
          const t = st.teams.find((x) => x.id === op.teamId); if (t) t.name = op.fields.name;
          return json({ ok: true, outcome: "landed", result: {} });
        }
        case "add": { const um = st._um--; st.players.push({ umId: um, playerId: op.playerId, team: op.team, playerNumber: op.playerNumber, name: "New Player", phone: "+15125559999", fake: false }); return json({ ok: true, outcome: "landed", result: { id: um } }); }
        case "add-fake": { const um = st._um--; st.players.push({ umId: um, playerId: null, team: op.team, playerNumber: op.playerNumber, name: "Fake player", phone: null, fake: true }); return json({ ok: true, outcome: "landed", result: { id: um } }); }
        case "bulk-fake": { for (let k = 0; k < (op.totalFakes || 0); k++) { const um = st._um--; st.players.push({ umId: um, playerId: null, team: 1, playerNumber: 90 + k, name: "Fake player", phone: null, fake: true }); } return json({ ok: true, outcome: "landed", result: {} }); }
        // spot 9 is the fixture's FAILING move — it lets the gate prove that a batch stops at the
        // first failure with the earlier writes still applied and the later ones never sent.
        case "move": {
          if (op.playerNumber === 9) return json({ error: "move rejected by server" }, 400);
          const p = st.players.find((x) => x.umId === op.userMatchId); if (p) { p.team = op.team; p.playerNumber = op.playerNumber; }
          return json({ ok: true, outcome: "landed", result: {} });
        }
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
  // REMOVED: mp-maxplayers was a typed capacity input. Capacity is now DERIVED and read-only —
  // teams × spots-per-team — so there is no text field to stage. The behaviour it covered
  // (maxPlayerCount enters the diff when changed) is asserted below through the stepper instead.
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
  // ONE SESSION PER IDENTITY, cached across the whole gate run — see sessionFor in _session.mjs.
  const session = await sessionFor("rmancuso@playmatchday.com");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] };

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
  // NEVER a rounded number: production had 0 non-divisible matches in 8 weeks, but if one exists the
  // TRUE stored total must be what is shown.
  eq("spots: the non-divisible case shows the TRUE stored total (18), not a rounded 16 or 20", {
    note: /stored capacity is 18/.test(await page.$eval('[data-testid="mp-spt-na"]', (e) => e.textContent)),
    cap: await page.$eval('[data-testid="mp-capacity"]', (e) => e.getAttribute("data-value")),
  }, { note: true, cap: "18" });

  // ══ SPOTS: capacity is DERIVED and read-only; teams is a picker ══
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-capacity"]', { timeout: 15000 });
  eq("spots: capacity is derived and NOT editable (no typed capacity input anywhere)", {
    readonly: await page.$eval('[data-testid="mp-capacity"]', (e) => e.tagName.toLowerCase()),
    noInput: await page.$$eval('[data-testid="mp-maxplayers"]', (e) => e.length),
    text: (await page.$eval('[data-testid="mp-capacity"]', (e) => e.textContent)).replace(/\s+/g, " ").trim(),
  }, { readonly: "span", noInput: 0, text: "18 total — 3 teams × 6" });
  // the picker offers exactly what production proved storable: 2, 3 and 4 (28 of 711 matches run 3)
  eq("spots: the TEAMS picker offers exactly 2 / 3 / 4", await page.$$eval('[data-testid="mp-teams-seg"] button', (b) => b.map((x) => x.textContent.trim())), ["2", "3", "4"]);
  eq("spots: the picker marks the match's CURRENT team count", await page.$eval('[data-testid="mp-teams-3"]', (e) => e.getAttribute("data-on")), "true");
  // (The 3-team rule — only maxPlayerCount is written, never a rung field — is asserted on the
  //  REQUEST BODY a few lines below, and always was. Deleting the sentence that explained it cost
  //  no coverage, which is the test this removal had to pass.)
  // stepping the per-team figure writes ONLY what changed, and TOTALS not per-side
  puts = [];
  await page.click('[data-testid="mp-spt-plus"]');       // 6 -> 7 per team, 3 teams => 21 total
  eq("spots: the stepper recomputes capacity as a TOTAL (3 × 7 = 21)",
    (await page.$eval('[data-testid="mp-capacity"]', (e) => e.textContent)).replace(/\s+/g, " ").trim(), "21 total — 3 teams × 7");
  await page.click('[data-testid="mp-save"]');
  await page.waitForTimeout(400);
  eq("spots: a 3-team save sends ONLY maxPlayerCount — no rung field, and nothing that did not change",
    puts.at(-1), { maxPlayerCount: 21 });

  // A 2-TEAM match writes its OWN rung and NEVER the other one — maxTeamSize4Team is the alternate
  // configuration the auto-bump ladder moves between, and clobbering it would corrupt that ladder.
  await page.goto(`${BASE}/match-ops/match-panel/12222`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-capacity"]', { timeout: 15000 });
  eq("spots: a 2-team match derives 18 total — 2 teams × 9",
    (await page.$eval('[data-testid="mp-capacity"]', (e) => e.textContent)).replace(/\s+/g, " ").trim(), "18 total — 2 teams × 9");
  puts = [];
  // Step UP: the fixture already stores maxTeamSize2Team 16, so stepping DOWN to 16 total would
  // correctly omit the rung as unchanged and prove nothing. 9 -> 10 changes both fields.
  await page.click('[data-testid="mp-spt-plus"]');       // 9 -> 10 per team, 2 teams => 20 total
  await page.click('[data-testid="mp-save"]');
  await page.waitForTimeout(400);
  eq("spots: a 2-team save writes maxPlayerCount + maxTeamSize2Team and NEVER touches maxTeamSize4Team", {
    body: puts.at(-1), touched4: Object.keys(puts.at(-1) ?? {}).includes("maxTeamSize4Team"),
  }, { body: { maxPlayerCount: 20, maxTeamSize2Team: 20 }, touched4: false });

  // ══════════════ TEAMS · ROSTER · TEAM COUNT — STAGED. Nothing leaves until Save. ══════════════
  // These gates used to assert the opposite: that a click fired a write immediately. The behaviour
  // they described was the thing the brief asked to remove, so the bodies below are new — each is
  // itemised in the commit against the gate it replaces. What SURVIVES unchanged is the coverage
  // that still applies: no password in any body, no roster edit inside the match PUT, the fake mark,
  // no price/lock control, the four-state read-back, and the add path (still immediate by design).
  await page.setViewportSize({ width: 1600, height: 1000 });
  delete rosterStates["17494"];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 20000 });

  // ITEM 1a — THE RED IS GONE. Asserted on computed colour and on the removed nodes, not on a class
  // name alone: a class can be renamed while the treatment stays.
  { const red = await page.evaluate(() => {
      const sec = document.querySelector('[data-testid="mp-teams"]');
      const holder = sec?.closest("[data-section]") ?? sec;
      const reddish = (c) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || ""); if (!m) return false;
        const [r, g, b] = [+m[1], +m[2], +m[3]]; return r > 120 && r - g > 45 && r - b > 45; };
      const nodes = [holder, ...(holder?.querySelectorAll("*") ?? [])].filter(Boolean);
      return {
        badge: !!document.querySelector('[data-testid="mp-immediate-banner"]'),
        legacyClasses: nodes.filter((e) => /mp-immbadge|mp-immbanner|mp-teams-hd|mp-teams-title/.test(e.className || "")).length,
        redBorders: nodes.filter((e) => { const st = getComputedStyle(e); return reddish(st.borderLeftColor) && parseFloat(st.borderLeftWidth) >= 3; }).length,
        redFills: nodes.filter((e) => reddish(getComputedStyle(e).backgroundColor)).length,
        savesImmediately: /SAVES IMMEDIATELY/i.test(holder?.textContent || ""),
      }; });
    JSON.stringify(red) === JSON.stringify({ badge: false, legacyClasses: 0, redBorders: 0, redFills: 0, savesImmediately: false })
      ? ok("item1a: no SAVES IMMEDIATELY badge, no red banner, no red border, no red fill anywhere in the section")
      : bad("item1a: the red survives", JSON.stringify(red)); }

  // ITEM 1b — CLICKING A MOVE ISSUES NO NETWORK REQUEST UNTIL SAVE. The single most important
  // assertion in this file: it is the whole difference between the old behaviour and the new one.
  rosterPosts = []; puts = [];
  await page.click('[data-testid="mp-move-9001"]');
  await page.waitForSelector('[data-testid="mp-movepick"]', { timeout: 6000 });
  await page.click('[data-testid="mp-movepick-team-2"]');
  await page.click('[data-testid="mp-movepick-spot-3"]');
  await page.waitForSelector('[data-testid="mp-pending-move"]', { timeout: 6000 });
  await page.click('[data-testid="mp-remove-9003"]');
  await page.waitForSelector('[data-testid="mp-pending-remove"]', { timeout: 6000 });
  await page.fill('[data-testid="mp-tname-1"]', "Orange");
  await page.click('[data-testid="mp-teamcount-4"]');
  await page.waitForTimeout(500);
  eq("item1b: a move, a removal, a rename and a team-count choice send NOTHING before Save",
    { roster: rosterPosts.length, matchPuts: puts.length }, { roster: 0, matchPuts: 0 });

  // ...and the pending rows SAY they are pending, rather than looking identical to saved ones
  { const marks = await page.evaluate(() => ({
      move: document.querySelector('[data-testid="mp-player"][data-um="9001"]')?.getAttribute("data-pending"),
      remove: document.querySelector('[data-testid="mp-player"][data-um="9003"]')?.getAttribute("data-pending"),
      moveTag: !!document.querySelector('[data-testid="mp-pending-move"]'),
      removeTag: !!document.querySelector('[data-testid="mp-pending-remove"]'),
      rename: !!document.querySelector('[data-testid="mp-rename-pending-1"]'),
      countPending: document.querySelector('[data-testid="mp-teamcount-pending"]')?.textContent,
    }));
    JSON.stringify(marks) === JSON.stringify({ move: "move", remove: "remove", moveTag: true, removeTag: true, rename: true, countPending: "4" })
      ? ok("item1c: every pending edit is visibly marked as pending") : bad("item1c", JSON.stringify(marks)); }

  // ITEM 1d — THE SAVE LABEL REFLECTS THE PENDING COUNT
  eq("item1d: the Save label counts the pending edits", await page.$eval('[data-testid="mp-save"]', (e) => e.textContent.trim()), "Save · 4 changes");

  // ITEM 1e — REVERT DISCARDS AND ISSUES NO REQUEST, and says so
  rosterPosts = []; puts = [];
  { const sub = await page.$eval('[data-testid="mp-revert"]', (e) => e.textContent);
    /sends nothing/i.test(sub) ? ok("item1e: Revert's own copy says it sends nothing") : bad("item1e copy", sub); }
  await page.click('[data-testid="mp-revert"]');
  await page.waitForTimeout(400);
  { const after = await page.evaluate(() => ({
      pendingRows: document.querySelectorAll('[data-testid="mp-player"][data-pending="move"],[data-testid="mp-player"][data-pending="remove"]').length,
      save: document.querySelector('[data-testid="mp-save"]')?.textContent.trim(),
      tname: document.querySelector('[data-testid="mp-tname-1"]')?.value,
    }));
    (rosterPosts.length === 0 && puts.length === 0 && after.pendingRows === 0 && after.save === "Save" && after.tname === "Green")
      ? ok("item1f: Revert discards every pending edit and issues NO request")
      : bad("item1f", `posts=${rosterPosts.length} puts=${puts.length} ${JSON.stringify(after)}`); }

  // ITEM 1g — SAVE ORDER: team count BEFORE moves, proven by the ORDER OF THE CALLS themselves.
  delete rosterStates["17494"]; rosterPosts = []; puts = [];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  await page.click('[data-testid="mp-teamcount-4"]');
  await page.click('[data-testid="mp-move-9001"]');
  await page.click('[data-testid="mp-movepick-team-2"]');
  await page.click('[data-testid="mp-movepick-spot-4"]');
  await page.click('[data-testid="mp-remove-9003"]');
  await page.fill('[data-testid="mp-tname-1"]', "Orange");
  await page.waitForTimeout(200);
  await page.click('[data-testid="mp-save"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mp-write-result"]').length >= 4, null, { timeout: 20000 });
  eq("item1g: Save sends team count FIRST, then the move, then the removal, then the rename — proven by call order",
    rosterPosts.map((o) => o.kind), ["shape", "move", "remove", "teams"]);
  eq("item1g2: the shape write carries teamNumbers and the move carries the chosen spot",
    { teamNumbers: rosterPosts[0]?.fields?.teamNumbers, move: { t: rosterPosts[1]?.team, n: rosterPosts[1]?.playerNumber } },
    { teamNumbers: 4, move: { t: 2, n: 4 } });
  eq("item1g3: every write in one Save shares ONE saveId, so change_log groups the batch",
    new Set(rosterPosts.map((o) => o.saveId)).size, 1);
  eq("item1g4: each write reports its OWN outcome, not one verdict for the Save",
    await page.$$eval('[data-testid="mp-write-result"]', (els) => els.map((e) => e.getAttribute("data-verdict"))),
    ["LANDED", "LANDED", "LANDED", "LANDED"]);

  // GATE 6 (kept) — password appears in no roster request body
  eq("gate6: no roster/teams request body contains 'password'", rosterPosts.some((o) => JSON.stringify(o).includes("password")), false);

  // GATE 2 (kept, re-aimed) — a roster edit NEVER enters the match PUT body. It used to be proved by
  // the staged diff excluding renames; now renames are staged too, so the honest place to prove
  // isolation is the request that actually goes to the match endpoint.
  delete rosterStates["17494"]; rosterPosts = []; puts = [];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  await page.fill('[data-testid="mp-name"]', "Renamed Match");
  await page.fill('[data-testid="mp-tname-1"]', "Teal");
  await page.waitForTimeout(200);
  await page.click('[data-testid="mp-save"]');
  await page.waitForFunction(() => /LANDED|NOT APPLIED|Save failed/.test(document.querySelector('[data-testid="mp-toast"]')?.textContent || ""), null, { timeout: 20000 });
  eq("gate2: a team rename never enters the match PUT body — the match write carries only the match field",
    { putKeys: Object.keys(puts[0] ?? {}), teamsPosts: rosterPosts.filter((o) => o.kind === "teams").length },
    { putKeys: ["name"], teamsPosts: 1 });

  // ITEM 1h — A FAILED SECOND WRITE LEAVES THE FIRST APPLIED AND THE REST PENDING.
  // The move to team 2 spot 9 is rejected by the fixture; the team-count write before it landed.
  delete rosterStates["17494"]; rosterPosts = []; puts = [];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  await page.click('[data-testid="mp-teamcount-4"]');
  await page.click('[data-testid="mp-move-9001"]');
  await page.click('[data-testid="mp-movepick-team-2"]');
  await page.click('[data-testid="mp-movepick-spot-9"]');   // FAILSPOT — the fixture rejects this one
  await page.click('[data-testid="mp-remove-9003"]');
  await page.waitForTimeout(200);
  await page.click('[data-testid="mp-save"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="mp-write-result"]')].some((e) => e.getAttribute("data-verdict") !== "LANDED"), null, { timeout: 20000 });
  { const st = await page.evaluate(() => ({
      verdicts: [...document.querySelectorAll('[data-testid="mp-write-result"]')].map((e) => e.getAttribute("data-verdict")),
      stillPendingRemove: !!document.querySelector('[data-testid="mp-pending-remove"]'),
      countPending: !!document.querySelector('[data-testid="mp-teamcount-pending"]'),
      toast: document.querySelector('[data-testid="mp-toast"]')?.textContent || "",
    }));
    const stopped = rosterPosts.filter((o) => o.kind === "remove").length === 0;
    (st.verdicts[0] === "LANDED" && st.verdicts[1] === "FAILED" && st.verdicts.length === 2 && stopped
      && st.stillPendingRemove && !st.countPending && /not undone|LANDED/i.test(st.toast))
      ? ok("item1h: the first write LANDED and is NOT auto-reverted, the failed one is reported, the rest stay pending and were never sent")
      : bad("item1h", `${JSON.stringify(st)} sentKinds=${JSON.stringify(rosterPosts.map((o) => o.kind))}`); }

  // GATE 7d (kept) — a 2xx the server did NOT apply reads as NOT APPLIED, never a blind success.
  delete rosterStates["17494"]; rosterPosts = []; forceNotApplied = true;
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  await page.click('[data-testid="mp-move-9001"]');
  await page.click('[data-testid="mp-movepick-team-2"]');
  await page.click('[data-testid="mp-movepick-spot-3"]');
  await page.waitForTimeout(150);
  await page.click('[data-testid="mp-save"]');
  await page.waitForSelector('[data-testid="mp-write-result"]', { timeout: 20000 });
  eq("gate7d: a roster write the server accepts but does NOT apply reads as NOT APPLIED (read-back, not blind 2xx)",
    await page.$eval('[data-testid="mp-write-result"]', (e) => e.getAttribute("data-verdict")), "NOT APPLIED");
  forceNotApplied = false;

  // GATE 5 (kept) — no price and no locked control anywhere in the section
  eq("gate5: TEAMS exposes no price and no locked control (count 0)", await page.$eval('[data-testid="mp-teams"]', (el) =>
    el.querySelectorAll('[data-testid*="price" i],[data-testid*="lock" i],input[name*="price" i],input[name*="lock" i],[aria-label*="lock" i],[aria-label*="price" i]').length), 0);

  // ── ADD — still immediate BY DESIGN, and it says so on itself ─────────────────────────────────
  delete rosterStates["17494"]; rosterPosts = []; puts = [];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  eq("add says on itself that it sends on click, not on Save",
    /sends on click, not on Save/i.test(await page.$eval('[data-testid="mp-add-immediate-note"]', (e) => e.textContent)), true);
  await page.fill('[data-testid="mp-add-search"]', "new");
  await page.waitForSelector('[data-testid="mp-add-result"]', { timeout: 6000 });
  await page.click('[data-testid="mp-add-result"]');
  await page.waitForSelector('[data-testid="mp-add-to-2"]', { timeout: 4000 });
  await page.click('[data-testid="mp-add-to-2"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="mp-player"]')].some((e) => e.textContent.includes("New Player")), null, { timeout: 6000 });
  eq("gate7a: add fires exactly one roster request, zero to the match endpoint", { add: rosterPosts.filter((o) => o.kind === "add").length, puts: puts.length }, { add: 1, puts: 0 });

  delete rosterStates["17494"]; rosterPosts = []; puts = [];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  await page.click('[data-testid="mp-add-fake"]');
  await page.waitForSelector('[data-testid="mp-add-to-1"]', { timeout: 4000 });
  await page.click('[data-testid="mp-add-to-1"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="mp-player"]')].some((e) => e.getAttribute("data-fake") === "1" && !!e.querySelector('[data-testid="mp-fake-tag"]') && /Fake player/.test(e.textContent || "")), null, { timeout: 6000 });
  eq("gate7f: add-fake fires exactly one add-fake request (no real add, none to the match endpoint) and the new player is marked FAKE",
    { fake: rosterPosts.filter((o) => o.kind === "add-fake").length, realAdd: rosterPosts.filter((o) => o.kind === "add").length, puts: puts.length }, { fake: 1, realAdd: 0, puts: 0 });

  delete rosterStates["17494"]; rosterPosts = []; puts = [];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  await page.fill('[data-testid="mp-bulk-fakes"]', "3");
  await page.click('[data-testid="mp-add-fakes-bulk"]');
  await page.waitForTimeout(400);
  eq("gate7g: bulk-fake sends exactly one bulk-fake request carrying totalFakes, zero to the match endpoint",
    { bulk: rosterPosts.filter((o) => o.kind === "bulk-fake").length, total: rosterPosts.find((o) => o.kind === "bulk-fake")?.totalFakes, puts: puts.length }, { bulk: 1, total: 3, puts: 0 });

  // GATE 8 (kept) — fake players are visibly marked; real players are not
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

  // GATE 10 (kept, re-aimed) — the team-count CONSEQUENCE is stated BEFORE the click, not in a
  // dialog after it, and choosing it still sends nothing.
  delete rosterStates["14444"]; rosterPosts = [];
  await page.goto(`${BASE}/match-ops/match-panel/14444`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-teamcount-2"]', { timeout: 15000 });
  { const line = await page.$eval('[data-testid="mp-teamcount-consequence"] li[data-n="2"]', (e) => e.textContent);
    const named = /Teams 3 and 4 are removed/.test(line) && /2 players move to teams 1 and 2/.test(line);
    await page.click('[data-testid="mp-teamcount-2"]');
    await page.waitForTimeout(400);
    (named && rosterPosts.length === 0)
      ? ok("gate10: 4→2 states its consequence BEFORE the click (teams removed + how many players move) and sends nothing")
      : bad("gate10", `line=${JSON.stringify(line)} posts=${rosterPosts.length}`); }

  // ── ITEM 2 · THE MOVE CONTROL SCALES ─────────────────────────────────────────────────────────
  delete rosterStates["14444"];
  await page.goto(`${BASE}/match-ops/match-panel/14444`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  { const perRow = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="mp-player"][data-um="8001"]');
      return { buttons: row.querySelectorAll("button").length, hasDestButtons: /→\s*[234]/.test(row.textContent || "") };
    });
    (perRow.buttons === 2 && !perRow.hasDestButtons)
      ? ok("item2a: at FOUR teams a row carries ONE move control + one remove — not → 2, → 3, → 4, ✕")
      : bad("item2a", JSON.stringify(perRow)); }
  await page.click('[data-testid="mp-move-8001"]');
  await page.waitForSelector('[data-testid="mp-movepick"][data-step="team"]', { timeout: 6000 });
  eq("item2b: step one offers every team", await page.$$eval('[data-testid="mp-movepick"] button[data-testid^="mp-movepick-team-"]', (e) => e.length), 4);
  await page.click('[data-testid="mp-movepick-team-3"]');
  await page.waitForSelector('[data-testid="mp-movepick"][data-step="spot"]', { timeout: 6000 });
  { const spots = await page.$$eval('[data-testid="mp-movepick"] [data-testid^="mp-movepick-spot-"]', (els) =>
      els.map((e) => ({ n: e.getAttribute("data-testid").replace("mp-movepick-spot-", ""), occupied: e.getAttribute("data-occupied") })));
    (spots.length === 5 && spots[0].occupied === "true" && spots[1].occupied === "false")
      ? ok("item2c: step two is that team's SPOT GRID, marking which are held — an open spot and a swap are one gesture")
      : bad("item2c", JSON.stringify(spots)); }
  rosterPosts = [];
  await page.click('[data-testid="mp-movepick-spot-1"]');   // OCCUPIED by Christopher Vale → a swap
  await page.waitForSelector('[data-testid="mp-pending-move"]', { timeout: 6000 });
  { const moving = await page.$$eval('[data-testid="mp-pending-move"]', (e) => e.length);
    (moving === 2 && rosterPosts.length === 0)
      ? ok("item2d: moving onto an occupied spot stages a SWAP — two pending moves, still zero requests")
      : bad("item2d", `movingRows=${moving} posts=${rosterPosts.length}`); }
  await page.click('[data-testid="mp-revert"]');
  await page.waitForTimeout(300);

  // ── ITEM 3 · NAME AND PHONE, ITEM 4 · FOUR TEAMS VISIBLE, at 1600 ────────────────────────────
  { const layout = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="mp-teamgrid"]');
      const panel = document.querySelector('[data-testid="mp-panel"]');
      const teams = [...grid.querySelectorAll('[data-testid="mp-team"]')];
      const pr = panel.getBoundingClientRect();
      const tops = [...new Set(teams.map((t) => Math.round(t.getBoundingClientRect().top)))];
      const clipped = (e) => e.scrollWidth > e.clientWidth + 1;
      const rows = [...grid.querySelectorAll('[data-testid="mp-player"]')];
      return {
        teams: teams.length,
        rowsOfTeams: tops.length,                                     // 2 x 2, not 4 abreast
        allInsidePanel: teams.every((t) => { const r = t.getBoundingClientRect(); return r.left >= pr.left - 1 && r.right <= pr.right + 1; }),
        gridOverflows: grid.scrollWidth > grid.clientWidth + 1,
        panelOverflows: panel.scrollWidth > panel.clientWidth + 1,
        everyRowHasBoth: rows.every((r) => (r.querySelector('[data-testid="mp-pname"]')?.textContent || "").trim().length > 0
                                        && (r.querySelector('[data-testid="mp-pphone"]')?.textContent || "").trim().length > 0),
        truncatedNames: rows.filter((r) => clipped(r.querySelector('[data-testid="mp-pname"]'))).length,
        truncatedPhones: rows.filter((r) => clipped(r.querySelector('[data-testid="mp-pphone"]'))).length,
        // two LINES, not two columns: the phone sits below the name
        phoneBelowName: rows.every((r) => r.querySelector('[data-testid="mp-pphone"]').getBoundingClientRect().top
                                        > r.querySelector('[data-testid="mp-pname"]').getBoundingClientRect().top),
        phoneText: rows[0]?.querySelector('[data-testid="mp-pphone"]')?.textContent,
      }; });
    JSON.stringify(layout) === JSON.stringify({ teams: 4, rowsOfTeams: 2, allInsidePanel: true, gridOverflows: false, panelOverflows: false,
      everyRowHasBoth: true, truncatedNames: 0, truncatedPhones: 0, phoneBelowName: true, phoneText: "+15125558001" })
      ? ok("item3+4 @1600: all four teams sit inside the panel as 2 x 2, no overflow, and every row shows a full name AND phone, neither truncated")
      : bad("item3+4 @1600", JSON.stringify(layout)); }

  // ── ITEM 5 · SORT BY SPOT, NULLS LAST, COLLISIONS MARKED ─────────────────────────────────────
  delete rosterStates["17777"];
  await page.goto(`${BASE}/match-ops/match-panel/17777`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  { const t1 = await page.$$eval('[data-testid="mp-team"][data-teamnumber="1"] [data-testid="mp-player"]', (els) =>
      els.map((e) => ({ spot: e.getAttribute("data-spot"), name: e.querySelector('[data-testid="mp-pname"]').textContent.trim(), clash: e.getAttribute("data-collision") })));
    const spots = t1.map((r) => r.spot);
    const nullLast = spots[spots.length - 1] === "";
    const clashRows = t1.filter((r) => r.clash === "true").map((r) => r.name);
    const adjacent = spots.indexOf("3") >= 0 && spots[spots.indexOf("3") + 1] === "3";
    (JSON.stringify(spots) === JSON.stringify(["1", "2", "3", "3", "4", "5", "9", ""]) && nullLast && adjacent
      && JSON.stringify(clashRows) === JSON.stringify(["Wren Three", "Dee Dupe"]))
      ? ok("item5: a shuffled team renders 1..N in order, a null spot lands LAST, and a duplicated spot renders BOTH rows adjacent and marked")
      : bad("item5", JSON.stringify(t1)); }
  eq("item5b: the collision is marked VISIBLY, not only in an attribute",
    await page.$$eval('[data-testid="mp-collision"]', (e) => e.length), 2);
  // a pending move sorts into its NEW position at once
  await page.click('[data-testid="mp-move-7009"]');   // Wanda, spot 9
  await page.click('[data-testid="mp-movepick-team-1"]');
  await page.click('[data-testid="mp-movepick-spot-6"]');
  await page.waitForSelector('[data-testid="mp-pending-move"]', { timeout: 6000 });
  eq("item5c: a pending move sorts into its NEW position immediately — the list reads the way it will look after Save",
    await page.$$eval('[data-testid="mp-team"][data-teamnumber="1"] [data-testid="mp-player"]', (els) => els.map((e) => e.getAttribute("data-spot"))),
    ["1", "2", "3", "3", "4", "5", "6", ""]);

  // ── ITEM 1 · THE UNSAVED-CHANGES GUARD (it ships with the batching, because batching creates it)
  { rosterPosts = [];
    dlg.accept = false; dlg.msg = null;
    await page.click('a[href="/match-ops/gameday"]').catch(() => {});
    await page.waitForTimeout(400);
    const stillHere = page.url().includes("/match-panel/17777");
    (stillHere && rosterPosts.length === 0)
      ? ok("item1i: a route change with pending edits is guarded — declining keeps you on the panel and sends nothing")
      : bad("item1i", `url=${page.url()} posts=${rosterPosts.length}`);
    dlg.accept = true; }

  // ── 390 PORTRAIT — the same behaviour on a phone ──────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  delete rosterStates["14444"];
  await page.goto(`${BASE}/match-ops/match-panel/14444`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 15000 });
  { const m = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="mp-teamgrid"]');
      const rows = [...grid.querySelectorAll('[data-testid="mp-player"]')];
      const clipped = (e) => e.scrollWidth > e.clientWidth + 1;
      return {
        teams: grid.querySelectorAll('[data-testid="mp-team"]').length,
        oneColumn: new Set([...grid.querySelectorAll('[data-testid="mp-team"]')].map((t) => Math.round(t.getBoundingClientRect().left))).size === 1,
        pageLeak: document.documentElement.scrollWidth > window.innerWidth + 1,
        everyRowHasBoth: rows.every((r) => (r.querySelector('[data-testid="mp-pname"]')?.textContent || "").trim() && (r.querySelector('[data-testid="mp-pphone"]')?.textContent || "").trim()),
        truncated: rows.filter((r) => clipped(r.querySelector('[data-testid="mp-pname"]')) || clipped(r.querySelector('[data-testid="mp-pphone"]'))).length,
        red: [...grid.querySelectorAll("*")].filter((e) => { const m2 = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(e).backgroundColor || ""); if (!m2) return false; const [r, g, b] = [+m2[1], +m2[2], +m2[3]]; return r > 120 && r - g > 45 && r - b > 45; }).length,
      }; });
    JSON.stringify(m) === JSON.stringify({ teams: 4, oneColumn: true, pageLeak: false, everyRowHasBoth: true, truncated: 0, red: 0 })
      ? ok("item3+4 @390 portrait: four teams stack to one column, no page overflow, name + phone both intact on every row, no red")
      : bad("item3+4 @390", JSON.stringify(m)); }
  { rosterPosts = [];
    await page.click('[data-testid="mp-move-8001"]');
    await page.waitForSelector('[data-testid="mp-movepick"]', { timeout: 6000 });
    await page.click('[data-testid="mp-movepick-team-2"]');
    await page.click('[data-testid="mp-movepick-spot-2"]');
    await page.waitForSelector('[data-testid="mp-pending-move"]', { timeout: 6000 });
    const save = await page.$eval('[data-testid="mp-save"]', (e) => e.textContent.trim());
    (rosterPosts.length === 0 && save === "Save · 1 change")
      ? ok("item1j @390: the two-step move works on a phone, still sends nothing, and the Save label counts it")
      : bad("item1j @390", `posts=${rosterPosts.length} save=${save}`);
    await page.click('[data-testid="mp-revert"]'); await page.waitForTimeout(200); }
  await page.setViewportSize({ width: 1600, height: 1000 });

  // ── the stripped panel on a phone: prose gone, chips legible, cancel word enforced ───────────
  await page.setViewportSize({ width: 390, height: 844 });
  delete rosterStates["17494"];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 20000 });
  { const m = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="mp-panel"]');
      const skip = (el) => el.closest('[data-testid="mp-desc"],[data-testid="mp-intro"],.mp-difflist,[data-testid="mp-toast"],[data-testid="mp-write-results"]');
      const long = [];
      const w = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const t = (n.textContent || "").trim();
        if (t.length > 120 && !(n.parentElement && skip(n.parentElement))) long.push(t.slice(0, 60));
      }
      const chip = panel.querySelector('[data-testid="mp-promo-tag"]');
      const row = chip?.closest('[data-testid="mp-player"]');
      return {
        longText: long.length,
        pageLeak: document.documentElement.scrollWidth > window.innerWidth + 1,
        camera: !!panel.querySelector('[data-section="CAMERA"]'),
        chipText: chip?.textContent?.trim() ?? null,
        // the chip must not push the name out of the row on a phone
        chipInsideRow: chip && row ? chip.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1 : false,
        countVisible: !!panel.querySelector('[data-testid="mp-promo-count"]')?.getBoundingClientRect().height,
      }; });
    eq("stripped @390 portrait: no prose, no overflow, no camera, the promo chip reads TOMBALL inside its row, and the per-match count survives",
      m, { longText: 0, pageLeak: false, camera: false, chipText: "TOMBALL", chipInsideRow: true, countVisible: true }); }
  await page.setViewportSize({ width: 1600, height: 1000 });

  // ══════════════ STRIPPED FOR SOMEONE WHO ALREADY KNOWS ══════════════
  delete rosterStates["17494"];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-team"]', { timeout: 20000 });

  // 1 — THE CAMERA SECTION IS GONE from the panel. (Master Schedule keeps the toggle; asserted in
  //     verify-schededit, which drives VeoMasterSchedule's own /api/veo/intent post.)
  eq("camera: no CAMERA section, no veo control and no veo markup anywhere in the panel",
    await page.evaluate(() => ({
      section: !!document.querySelector('[data-section="CAMERA"]'),
      toggle: !!document.querySelector('[data-testid="mp-veo"]'),
      state: !!document.querySelector('[data-testid="mp-veo-state"]'),
      result: !!document.querySelector('[data-testid="mp-veo-result"]'),
      cls: document.querySelectorAll('[class*="mp-veo"]').length,
      word: /\bveo\b/i.test(document.querySelector('[data-testid="mp-panel"]').textContent || ""),
    })), { section: false, toggle: false, state: false, result: false, cls: 0, word: false });

  // 2 — THE MECHANICAL PROSE CHECK. No text node over 120 chars outside the two free-text fields.
  //     This is what stops the paragraphs creeping back one sentence at a time.
  { const long = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="mp-panel"]');
      const skip = (el) => el.closest('[data-testid="mp-desc"],[data-testid="mp-intro"],.mp-difflist,[data-testid="mp-toast"],[data-testid="mp-write-results"]');
      const out = [];
      const w = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const t = (n.textContent || "").trim();
        if (t.length <= 120) continue;
        if (n.parentElement && skip(n.parentElement)) continue;
        out.push(t.slice(0, 90));
      }
      return out; });
    eq("prose: no text node in the panel exceeds 120 characters (DESCRIPTION / MANAGER INTRO aside)", long, []); }

  // ...and the MICROLABELS and COMPUTED VALUES survived. Deleting the prose must not delete these.
  { const kept = await page.evaluate(() => {
      const txt = document.querySelector('[data-testid="mp-panel"]').textContent || "";
      return {
        total: /\btotal\b/i.test(txt), staged: /staged|pending/i.test(txt), derived: /derived/i.test(txt),
        beforeKickoff: /before kickoff/i.test(txt), belowCancels: /below this, it cancels/i.test(txt),
        optional: /optional/i.test(txt), sendId: /send the id/i.test(txt),
        capacity: /\d+ total — \d+ teams × \d+/.test(txt.replace(/\s+/g, " ")),
      }; });
    eq("prose: the microlabels and computed values are all still there", kept,
      { total: true, staged: true, derived: true, beforeKickoff: true, belowCancels: true,
        optional: true, sendId: true, capacity: true }); }

  // 5 — WHO CAME IN ON A PROMO: the CODE NAME on the row, and the count once per match.
  { const promo = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="mp-player"]')];
      const chips = rows.map((r) => r.querySelector('[data-testid="mp-promo-tag"]')?.textContent?.trim() ?? null);
      const count = document.querySelector('[data-testid="mp-promo-count"]');
      return { chips, chipped: chips.filter(Boolean).length, countText: count?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        countAttr: count?.getAttribute("data-spots") ?? null }; });
    (promo.chips.filter((c) => c === "TOMBALL").length === 2
      && promo.chips.filter((c) => c === null).length === 1
      && promo.countAttr === "2" && /2 on a promo/.test(promo.countText ?? "") && /TOMBALL/.test(promo.countText ?? ""))
      ? ok("promo: rows with a code show the CODE NAME, the row without shows no chip, and the per-match count matches the chipped rows")
      : bad("promo chips", JSON.stringify(promo)); }

  // ══════════════ Part C · CANCEL — live numbers, typed-name gate, one request, credit not refund ══════════════
  delete rosterStates["17494"]; cancelPosts = [];
  await page.goto(`${BASE}/match-ops/match-panel/17494`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="mp-danger"]', { timeout: 15000 });
  await page.click('[data-testid="mp-cancel-open"]');
  await page.waitForSelector('[data-testid="mp-cancel-confirm"]', { timeout: 6000 });
  { const line = await page.$eval('[data-testid="mp-cancel-line"]', (e) => e.textContent);
    eq("cancelC1: the confirmation shows the LIVE count and amount (9 players, $90.00)", /9 players/.test(line) && /\$90\.00/.test(line), true); }
  { const zone = (await page.$eval('[data-testid="mp-danger"]', (e) => e.textContent)).toLowerCase();
    eq("cancelC2: the cancel copy says 'credit' and never 'refund'", { credit: zone.includes("credit"), refund: zone.includes("refund") }, { credit: true, refund: false }); }
  // wrong typed name → button stays disabled
  // TYPE "cancel" — lowercase, exact, trimmed. Each near-miss is asserted separately: a
  // case-insensitive or fuzzy compare would pass a single "wrong word" check and still be wrong.
  const capDisabled = () => page.$eval('[data-testid="mp-cancel-do"]', (e) => e.disabled);
  await page.fill('[data-testid="mp-cancel-name"]', "not the word");
  eq("cancelC3: a wrong word keeps the Cancel button disabled", await capDisabled(), true);
  await page.fill('[data-testid="mp-cancel-name"]', "PRUMC - Tuesday");
  eq("cancelC3b: the MATCH NAME no longer unlocks it — the word is 'cancel'", await capDisabled(), true);
  await page.fill('[data-testid="mp-cancel-name"]', "Cancel");
  eq("cancelC3c: 'Cancel' is refused — lowercase, exact", await capDisabled(), true);
  await page.fill('[data-testid="mp-cancel-name"]', "CANCEL");
  eq("cancelC3d: 'CANCEL' is refused", await capDisabled(), true);
  await page.fill('[data-testid="mp-cancel-name"]', "  cancel  ");
  eq("cancelC3e: ' cancel ' IS accepted — trimmed means surrounding whitespace", await capDisabled(), false);
  await page.fill('[data-testid="mp-cancel-name"]', "can cel");
  eq("cancelC3f: inner whitespace is NOT trimmed away", await capDisabled(), true);
  await page.fill('[data-testid="mp-cancel-name"]', "not the word");
  // abort sends nothing
  cancelPosts = [];
  await page.click('[data-testid="mp-cancel-abort"]');
  await page.waitForTimeout(150);
  eq("cancelC4: keeping the match (abort) sends no request", cancelPosts.length, 0);
  // correct name → exactly one request; verdict from match state
  await page.click('[data-testid="mp-cancel-open"]');
  await page.waitForSelector('[data-testid="mp-cancel-confirm"]', { timeout: 6000 });
  await page.fill('[data-testid="mp-cancel-name"]', "cancel");
  cancelPosts = [];
  await page.click('[data-testid="mp-cancel-do"]');
  await page.waitForSelector('[data-testid="mp-cancel-result"]', { timeout: 6000 });
  { const result = await page.$eval('[data-testid="mp-cancel-result"]', (e) => e.textContent);
    eq("cancelC5: one correct confirm sends exactly one cancel request and reports LANDED from match state", { posts: cancelPosts.length, name: cancelPosts[0]?.confirmName, landed: /LANDED/.test(result) }, { posts: 1, name: "PRUMC - Tuesday", landed: true }); }

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
