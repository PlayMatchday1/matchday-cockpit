// Phase 18 — Player Lookup, driven in a real browser, hermetic. The lookup read route,
// the gameday day route and the guarded roster route are all route-fulfilled so no live
// data or writes happen. Walks search-detection -> profile -> add flow -> remove dialog,
// asserts the EDIT MATCHES gate both ways, and (390px) that rows WRAP not truncate.
//   node scripts/e2e/verify-lookup.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { overflow } from "./checks.mjs";

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/match-ops/player-lookup`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// patch the app_users read useAuth makes, so the gate is deterministic (server still enforces)
const patchPerms = (edit) => (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch();
  let json = await res.json().catch(() => null);
  const patch = (r) => ({ ...r, can_edit_matches: edit, can_access_matchops: true });
  json = Array.isArray(json) ? json.map(patch) : (json && typeof json === "object" ? patch(json) : json);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(json) });
});
const grantEdit = patchPerms(true);
const denyEdit = patchPerms(false);

// ── fixtures ─────────────────────────────────────────────────────────────────
const MARISOL = {
  env: "production",
  player: {
    id: 79214, name: "Marisol Reyes", email: "m.reyes@gmail.com", phone: "+12105557781", phoneVerified: true,
    city: "San Antonio", level: 6, registered: "2026-02-11T00:00:00.000Z", goals: 14, cityManager: false,
    credits: 0, status: "ok", banReason: null, bannedAt: null, banExpiredAt: null, matchesPlayed: 1, upcoming: 1,
  },
  membership: { status: "active", number: "sub_ABC123", since: "2026-03-02T00:00:00.000Z", renews: "2026-09-02T00:00:00.000Z", canceledAt: null, price: 2900, city: "SAT" },
  matches: [
    { umId: 900001, matchId: 17402, name: "Soccer Central Field 6", startDate: "2026-08-09T20:30:00.000Z", startDateUtc: new Date(Date.now() + 6 * 3600e3).toISOString(), team: 1, num: 3, price: 1200, state: "upcoming", removable: true },
    { umId: 900002, matchId: 17244, name: "Soccer Central Field 4", startDate: "2026-08-05T19:00:00.000Z", startDateUtc: "2026-08-05T19:00:00.000Z", team: 1, num: 2, price: 1200, state: "played", removable: false },
    { umId: 900003, matchId: 17190, name: "Soccer Central Field 1", startDate: "2026-08-02T18:00:00.000Z", startDateUtc: "2026-08-02T18:00:00.000Z", team: 2, num: 5, price: 1200, state: "cancelled", removable: false },
  ],
  strikes: {
    activeCount: 2, limit: 4, isSuspended: false, suspendedTo: null,
    expiredAt: "2026-10-04T00:00:00.000Z", firstStrikeAt: "2026-08-02T18:00:00.000Z",
    logs: [
      { penaltyPoint: 1, active: true, reason: "CANCEL_W_IN_SOME_HOURS", matchName: "Soccer Central Field 1", when: "2026-08-02T18:00:00.000Z", issued: "2026-08-02T14:48:00.000Z", canceledAt: "2026-08-02T14:48:00.000Z", hoursBefore: 3.2 },
      { penaltyPoint: 1, active: true, reason: "LATE", matchName: "Soccer Central Field 4", when: "2026-08-05T19:00:00.000Z", issued: "2026-08-05T19:14:00.000Z", canceledAt: null, hoursBefore: null },
      { penaltyPoint: 1, active: false, reason: "NO_SHOW", matchName: "Havana Fields", when: "2026-04-19T20:30:00.000Z", issued: "2026-04-19T20:30:00.000Z", canceledAt: null, hoursBefore: null },
      { penaltyPoint: 1, active: false, reason: "NONE", matchName: "Kickers Field 2", when: "2026-03-01T18:00:00.000Z", issued: "2026-03-01T18:00:00.000Z", canceledAt: null, hoursBefore: null },
    ],
  },
};
// a non-member: strikes panel must say "Members only", never invent strikes
const DANNY = {
  env: "production",
  player: { id: 60180, name: "Danny Vo", email: "danny@example.com", phone: "+18329015669", phoneVerified: true, city: "Houston", level: 3, registered: "2025-11-04T00:00:00.000Z", goals: 2, cityManager: false, credits: 0, status: "ok", banReason: null, bannedAt: null, banExpiredAt: null, matchesPlayed: 2, upcoming: 0 },
  membership: null,
  matches: [],
  strikes: { activeCount: 0, limit: 4, isSuspended: false, suspendedTo: null, expiredAt: null, firstStrikeAt: null, logs: [] },
};
const SEARCH_HITS = [
  { id: 79214, name: "Marisol Reyes", email: "m.reyes@gmail.com", phone: "+12105557781", city: "San Antonio", status: "ok", hasMembership: true },
];

function gamedayFixture(todayYMD) {
  const base = Date.now();
  const mk = (o) => ({
    id: 0, name: "M", isCancelled: false, maxPlayerCount: 18, minPlayerCount: 9, registrationPrice: 1200,
    fakeSpotLeft36h: 0, fakeSpotLeft24h: 0, fakeSpotLeft12h: 0, fakeSpotLeft6h: 0, fakeSpotLeft3h: 0,
    category: "OPEN", type: "REGULAR", _count: { players: 6, fakePlayers: 0 }, teams: [{ teamNumber: 1 }, { teamNumber: 2 }],
    field: { title: "F", city: { id: 1, name: "San Antonio", timeZone: { abbr: "CDT" } } },
    startDate: `${todayYMD}T18:00:00.000`, startDateUtc: new Date(base + 5 * 3600e3).toISOString(), ...o,
  });
  return [
    mk({ id: 17402, name: "Soccer Central Field 6", _count: { players: 4, fakePlayers: 0 } }), // player ALREADY IN this
    mk({ id: 17600, name: "Zilker Open", _count: { players: 5, fakePlayers: 0 }, startDateUtc: new Date(base + 6 * 3600e3).toISOString() }), // OPEN, addable
    mk({ id: 17700, name: "Kickers Full", maxPlayerCount: 12, _count: { players: 12, fakePlayers: 0 }, startDateUtc: new Date(base + 7 * 3600e3).toISOString() }), // FULL
  ];
}
// roster for the addable match 17600: two teams, size 9 each, team1 has 4 taken, team2 has 1 -> suggest team2 #2
const ROSTER_17600 = {
  matchId: 17600, name: "Zilker Open",
  teams: [{ id: 1, teamNumber: 1, name: "White", locked: false }, { id: 2, teamNumber: 2, name: "Dark", locked: false }],
  players: [
    { umId: 1, playerId: 11, team: 1, playerNumber: 1, name: "A", fake: false },
    { umId: 2, playerId: 12, team: 1, playerNumber: 2, name: "B", fake: false },
    { umId: 3, playerId: 13, team: 1, playerNumber: 3, name: "C", fake: false },
    { umId: 4, playerId: 14, team: 1, playerNumber: 4, name: "D", fake: false },
    { umId: 5, playerId: 15, team: 2, playerNumber: 1, name: "E", fake: false },
  ],
  shape: { teamN: 2, perTeam: 9 }, maxPlayerCount: 18,
};

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const todayYMD = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  let lastWrite = null; // capture the POST body the component sends

  const routes = async (ctx, { edit }) => {
    await ctx.route("**/api/lookup/**", (route) => {
      const url = new URL(route.request().url());
      const id = url.searchParams.get("id");
      const q = url.searchParams.get("q");
      if (id) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(id === "60180" ? DANNY : MARISOL) });
      // mimic detectKind for the kind field (component reads it for the hint too, but hint is local)
      const kind = !q ? "empty" : q.includes("@") ? "email" : /^\d{1,6}$/.test(q.trim()) ? "id" : q.replace(/\D/g, "").length >= 7 ? "phone" : "name";
      const results = q && /mari|reyes|79214|2105557781|m\.reyes/i.test(q) ? SEARCH_HITS
        : q && /danny|60180/i.test(q) ? [{ id: 60180, name: "Danny Vo", email: "danny@example.com", phone: "+18329015669", city: "Houston", status: "ok", hasMembership: false }]
        : [];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind, results }) });
    });
    await ctx.route("**/api/matchday/**/gameday**", (route) => {
      const date = new URL(route.request().url()).searchParams.get("date");
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ date, env: "production", matches: date === todayYMD ? gamedayFixture(todayYMD) : [] }) });
    });
    await ctx.route("**/api/matchday/**/roster/**", (route) => {
      const req = route.request();
      if (req.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ROSTER_17600) });
      // POST — capture, and honour the gate the server would apply
      lastWrite = { url: req.url(), body: JSON.parse(req.postData() || "{}") };
      if (!edit) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "read-only" }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ logged: true, outcome: "LANDED" }) });
    });
    await ctx.route("**/api/veo**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: [] }) }));
    await (edit ? grantEdit : denyEdit)(ctx);
  };

  const browser = await chromium.launch({ headless: true });

  // ══ desktop, EDIT MATCHES granted ══
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 }, storageState });
  await routes(ctx, { edit: true });
  const page = await ctx.newPage();
  const go = async () => { await page.goto(PAGE, { waitUntil: "domcontentloaded" }); await page.waitForSelector("#pl-q", { timeout: 30000 }); };
  await go();

  const hint = () => page.$eval("#pl-hint", (e) => e.textContent.toLowerCase());
  const type = async (v) => { await page.fill("#pl-q", v); await page.waitForTimeout(260); };

  // ── search detection drives the hint ──
  await type("m.reyes@gmail.com"); eq("email detected", (await hint()).includes("email address"), true);
  await type("2105557781"); eq("phone detected (10 digits)", (await hint()).includes("phone number"), true);
  await type("79214"); eq("bare 5 digits detected as player ID", (await hint()).includes("player id"), true);
  await type("Marisol"); eq("name detected", (await hint()).includes("name"), true);

  // ── results render, click opens the profile ──
  await page.waitForSelector('.res[data-pid="79214"]', { timeout: 5000 });
  ok("search result renders for a name query");
  await page.click('.res[data-pid="79214"]');
  await page.waitForSelector('.idcard[data-pid="79214"]', { timeout: 5000 });
  ok("clicking a result opens the profile");

  // ── identity + facts, membership, match history ──
  eq("identity shows the name", (await page.$eval(".who h2", (e) => e.textContent)).trim(), "Marisol Reyes");
  eq("MEMBER tag present", await page.$$eval(".idtags .tag", (els) => els.some((e) => /MEMBER/.test(e.textContent))), true);
  eq("membership panel shows ACTIVE", await page.$eval(".panel .note .tag", (e) => e.textContent).catch(() => ""), "ACTIVE");
  eq("match history has 3 rows", await page.$$eval(".mrow", (els) => els.length), 3);
  eq("upcoming row has a Remove button; played row does not", {
    up: await page.$$eval('.mrow', (els) => els.some((r) => r.getAttribute("data-match") === "17402" && !!r.querySelector(".rowbtn"))),
    played: await page.$$eval('.mrow', (els) => els.some((r) => r.getAttribute("data-match") === "17244" && !r.querySelector(".rowbtn"))),
  }, { up: true, played: true });

  // ── Fields picker: goals OFF by default -> ON reveals the fact ──
  eq("GOALS SCORED hidden by default", await page.$$eval(".f .k", (els) => els.some((e) => e.textContent === "GOALS SCORED")), false);
  await page.click(".fieldswrap .btn");
  await page.click('.pop input[data-field="goals"]');
  eq("toggling goals ON reveals GOALS SCORED", await page.$$eval(".f .k", (els) => els.some((e) => e.textContent === "GOALS SCORED")), true);
  await page.keyboard.press("Escape").catch(() => {});
  await page.click("body", { position: { x: 5, y: 5 } }).catch(() => {});

  // ── strikes panel (display-only), member with 2 of 4 active ──
  eq("strikes panel rendered for a member", !!(await page.$('[data-testid="strikes"]')), true);
  eq("strike count shows N of 4", (await page.$eval('[data-testid="strike-count"]', (e) => e.textContent)).trim(), "2 of 4 active");
  eq("4 pips, 2 lit", { pips: await page.$$eval('[data-testid="strikes"] .pip', (e) => e.length), lit: await page.$$eval('[data-testid="strikes"] .pip.on', (e) => e.length) }, { pips: 4, lit: 2 });
  eq("reason labels come from userStatus; NONE renders STRIKE, never 'NONE'", await page.$$eval('[data-testid="strikes"] .srow .st:nth-child(2)', (els) => els.map((e) => e.textContent.trim())), ["LATE CANCEL", "LATE", "NO SHOW", "STRIKE"]);
  eq("no strike chip ever says NONE or ON TIME", await page.$$eval('[data-testid="strikes"] .srow .st', (els) => els.some((e) => /^(NONE|ON TIME)$/.test(e.textContent.trim()))), false);
  eq("NONE-reason strike shows 'reason not recorded', not a made-up reason", await page.$eval('[data-testid="strikes"] .srow:last-child .l2', (e) => /Reason not recorded/.test(e.textContent)), true);
  eq("cancellation strike shows hours-before-kickoff", await page.$eval('[data-testid="strikes"] .srow .l2', (e) => /3\.2h before kickoff/.test(e.textContent)), true);
  eq("expired strike marked EXPIRED not ACTIVE", await page.$$eval('[data-testid="strikes"] .srow', (els) => { const last = els[els.length - 1]; return { active: !!last.querySelector(".st.sactive"), expired: !!last.querySelector(".st.expired") }; }), { active: false, expired: true });
  eq("strikes panel is display-only (no write buttons)", await page.$$eval('[data-testid="strikes"] button', (e) => e.length), 0);

  // ── not-built footer: Strikes is now built; only Payments + Account history remain ──
  { const foot = await page.$eval('[data-testid="notbuilt"]', (e) => e.textContent);
    eq("footer names Payments + Account history, NOT Strikes", { pay: foot.includes("Payments"), acct: foot.includes("Account history"), strike: /\bStrikes\b/.test(foot) }, { pay: true, acct: true, strike: false }); }
  eq("panels are MEMBERSHIP, STRIKES, MATCH HISTORY (no Payments panel)", await page.$$eval(".ptitle h3", (els) => els.map((e) => e.textContent)), ["MEMBERSHIP", "STRIKES", "MATCH HISTORY"]);

  // ── non-member: strikes panel says Members only, never invents strikes ──
  await type("Danny"); await page.waitForSelector('.res[data-pid="60180"]', { timeout: 5000 }); await page.click('.res[data-pid="60180"]');
  await page.waitForSelector('.idcard[data-pid="60180"]', { timeout: 5000 });
  eq("non-member strikes panel says Members only", await page.$eval('[data-testid="strikes-members-only"] .nomem b', (e) => e.textContent), "Members only");
  eq("non-member membership panel says Not a member", await page.$$eval(".nomem b", (els) => els.some((e) => e.textContent === "Not a member")), true);
  // back to the member for the write flows
  await type("Marisol"); await page.waitForSelector('.res[data-pid="79214"]', { timeout: 5000 }); await page.click('.res[data-pid="79214"]');
  await page.waitForSelector('.idcard[data-pid="79214"]', { timeout: 5000 });

  // ── ADD flow: walk it, suggestion pre-selected, then write ──
  await page.click('[data-testid="add-match"]');
  await page.waitForSelector('[data-testid="match-list"]', { timeout: 5000 });
  eq("already-in match is disabled in the picker", await page.$eval('.mopt[data-mid="17402"]', (e) => e.disabled), true);
  eq("full match is disabled in the picker", await page.$eval('.mopt[data-mid="17700"]', (e) => e.disabled), true);
  eq("open match is selectable", await page.$eval('.mopt[data-mid="17600"]', (e) => e.disabled), false);
  await page.click('.mopt[data-mid="17600"]');
  await page.waitForSelector(".spot", { timeout: 5000 });
  // suggestion = emptier side (team2, 1 taken) lowest free (#2) -> pre-selected + green
  eq("suggestion pre-selected", await page.$$eval(".spot[aria-pressed='true']", (els) => els.length), 1);
  eq("the suggested spot is the green one", await page.$eval(".spot.sug[aria-pressed='true']", (e) => e.textContent).catch(() => ""), "2");
  await page.waitForSelector('[data-testid="add-summary"]', { timeout: 3000 });
  ok("add summary shows before the write");
  await page.click('[data-testid="add-confirm"]');
  await page.waitForTimeout(300);
  eq("add wrote through the guarded roster route (kind=add, team #2 spot 2)", { kind: lastWrite?.body?.kind, playerId: lastWrite?.body?.playerId, team: lastWrite?.body?.team, num: lastWrite?.body?.playerNumber, mid: lastWrite?.url?.includes("/roster/17600") }, { kind: "add", playerId: 79214, team: 2, num: 2, mid: true });

  // ── REMOVE dialog: names the person, match, paid amount + unconfirmed refund ──
  lastWrite = null;
  await page.click('.mrow[data-match="17402"] .rowbtn');
  await page.waitForSelector(".modal", { timeout: 5000 });
  { const t = (await page.$eval(".mbody", (e) => e.textContent)).replace(/\s+/g, " ");
    eq("remove dialog names the player + match + paid amount + unconfirmed refund", {
      person: /Marisol Reyes/.test(t), match: /Soccer Central Field 6/.test(t), paid: /\$12\.00/.test(t), refund: /UNCONFIRMED/.test(t),
    }, { person: true, match: true, paid: true, refund: true }); }
  await page.click('[data-testid="remove-confirm"]');
  await page.waitForTimeout(300);
  eq("remove wrote kind=remove with the userMatchId", { kind: lastWrite?.body?.kind, um: lastWrite?.body?.userMatchId }, { kind: "remove", um: 900001 });

  // ── 390px: rows WRAP, never truncate; no horizontal leak ──
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState, isMobile: true, hasTouch: true });
  await routes(mob, { edit: true });
  const mp = await mob.newPage();
  await mp.goto(PAGE, { waitUntil: "domcontentloaded" }); await mp.waitForSelector("#pl-q", { timeout: 30000 });
  await mp.fill("#pl-q", "Marisol"); await mp.waitForTimeout(260);
  await mp.waitForSelector('.res[data-pid="79214"]'); await mp.click('.res[data-pid="79214"]');
  await mp.waitForSelector('.idcard[data-pid="79214"]');
  { const o = await overflow(mp);
    const leaks = o.offenders.filter((x) => /\bl1\b|\bl2\b|\brn\b|\brt\b|\bmtitle\b|\bsub\b/.test(x.cls) && !["auto", "scroll"].includes(x.overflowX));
    eq("no .l1/.l2/.rn/.rt row text truncates at 390 (wraps instead)", leaks, []);
    eq("no page-level horizontal leak at 390", o.pageLeak, false); }

  // ══ read-only context: EDIT MATCHES buttons disabled ══
  const ro = await browser.newContext({ viewport: { width: 1280, height: 1000 }, storageState });
  await routes(ro, { edit: false });
  const rp = await ro.newPage();
  await rp.goto(PAGE, { waitUntil: "domcontentloaded" }); await rp.waitForSelector("#pl-q", { timeout: 30000 });
  await rp.fill("#pl-q", "Marisol"); await rp.waitForTimeout(260);
  await rp.waitForSelector('.res[data-pid="79214"]'); await rp.click('.res[data-pid="79214"]');
  await rp.waitForSelector('.idcard[data-pid="79214"]');
  eq("read-only: Add to a match is disabled", await rp.$eval('[data-testid="add-match"]', (e) => e.disabled), true);
  eq("read-only: Remove is disabled", await rp.$eval('.mrow[data-match="17402"] .rowbtn', (e) => e.disabled), true);
  eq("read-only: header says READ ONLY", await rp.$eval(".livetag", (e) => /READ ONLY/.test(e.textContent)), true);

  await browser.close();
  console.log(`\nverify-lookup: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log("FAILURES:\n" + fails.map((f) => "  - " + f).join("\n")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
