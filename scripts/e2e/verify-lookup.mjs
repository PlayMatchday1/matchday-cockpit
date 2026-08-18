// Phase 18 — Player Lookup, driven in a real browser, hermetic. The lookup read route,
// the gameday day route and the guarded roster route are all route-fulfilled so no live
// data or writes happen. Walks search-detection -> profile -> add flow -> remove dialog,
// asserts the EDIT MATCHES gate both ways, and (390px) that rows WRAP not truncate.
//   node scripts/e2e/verify-lookup.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, sessionFor } from "./_session.mjs";
installHarnessGuard();
import { overflow } from "./checks.mjs";

const BASE = process.env.BASE || "http://localhost:3000";
const PAGE = `${BASE}/match-ops/player-lookup`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// patch the app_users read useAuth makes, so the gate is deterministic (server still enforces).
// edit = EDIT MATCHES, manage = MANAGE PLAYERS — INDEPENDENT so we can prove one on / one off.
const patchPerms = (edit, manage = edit, credits = false) => (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch();
  let json = await res.json().catch(() => null);
  // can_edit_credits is patched INDEPENDENTLY and defaults to FALSE — the whole point of Phase 27
  // is that it is not implied by matchops, edit-matches or manage-players.
  const patch = (r) => ({ ...r, can_edit_matches: edit, can_manage_players: manage, can_access_matchops: true, can_edit_credits: credits });
  json = Array.isArray(json) ? json.map(patch) : (json && typeof json === "object" ? patch(json) : json);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(json) });
});
const grantEdit = patchPerms(true, true);
const denyEdit = patchPerms(false, false);

// ── fixtures ─────────────────────────────────────────────────────────────────
const MARISOL = {
  env: "production",
  player: {
    id: 79214, name: "Marisol Reyes", email: "m.reyes@gmail.com", phone: "+12105557781", phoneVerified: true,
    city: "San Antonio", level: 6, registered: "2026-02-11T00:00:00.000Z", goals: 14, cityManager: false,
    credits: 1234, status: "ok", banReason: null, bannedAt: null, banExpiredAt: null, matchesPlayed: 1, upcoming: 1,
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
  accountHistory: [], // clean record -> Suspend + Expel offered
};
// a SUSPENDED non-member: strikes say "Members only"; account history shows the ban + Lift offered
const DANNY = {
  env: "production",
  player: { id: 60180, name: "Danny Vo", email: "danny@example.com", phone: "+18329015669", phoneVerified: true, city: "Houston", level: 3, registered: "2025-11-04T00:00:00.000Z", goals: 2, cityManager: false, credits: 0, status: "suspended", banReason: "Repeated late cancellations", bannedAt: "2026-07-07T18:55:00.000Z", banExpiredAt: "2026-08-31T00:00:00.000Z", matchesPlayed: 2, upcoming: 0 },
  membership: null,
  matches: [],
  strikes: { activeCount: 0, limit: 4, isSuspended: false, suspendedTo: null, expiredAt: null, firstStrikeAt: null, logs: [] },
  accountHistory: [{ action: "suspend", reason: "Repeated late cancellations", when: "2026-07-07T18:55:00.000Z", until: "2026-08-31T00:00:00.000Z", by: "Nick Zelfine" }],
};
// an OVER-threshold member: activeStrikes 5 > limit 4 — pips must show the overflow visibly
const OVER = {
  env: "production",
  player: { id: 88888, name: "Over Struck", email: "over@example.com", phone: "+15125550000", phoneVerified: true, city: "Austin", level: 5, registered: "2026-01-01T00:00:00.000Z", goals: 0, cityManager: false, credits: 0, status: "ok", banReason: null, bannedAt: null, banExpiredAt: null, matchesPlayed: 6, upcoming: 0 },
  membership: { status: "active", number: "sub_OVER", since: "2026-01-01T00:00:00.000Z", renews: "2026-12-01T00:00:00.000Z", canceledAt: null, price: 2900, city: "AUS" },
  matches: [],
  strikes: { activeCount: 5, limit: 4, isSuspended: true, suspendedTo: "2026-09-01T00:00:00.000Z", expiredAt: "2026-11-01T00:00:00.000Z", firstStrikeAt: "2026-06-01T00:00:00.000Z", logs: [] },
  accountHistory: [],
};
// a player whose Stripe read ERRORS — the panel must say so, never show an empty list
const ERRP = {
  env: "production",
  player: { id: 77777, name: "Err Or", email: "err@example.com", phone: "+15125559999", phoneVerified: true, city: "Austin", level: 4, registered: "2026-01-01T00:00:00.000Z", goals: 0, cityManager: false, credits: 0, status: "ok", banReason: null, bannedAt: null, banExpiredAt: null, matchesPlayed: 0, upcoming: 0 },
  membership: null, matches: [], strikes: { activeCount: 0, limit: 4, isSuspended: false, suspendedTo: null, expiredAt: null, firstStrikeAt: null, logs: [] }, accountHistory: [],
};
// HIGH-VOLUME player — 604 matches: 3 upcoming + 200 played + 1 no-show + 400 cancelled.
// Exercises: not-all-rendered, upcoming pinned above past, chip counts sum, show-more append.
const HV = (() => {
  const base = Date.now();
  const mk = (i, opts) => ({
    umId: 500000 + i, matchId: 600000 + i, name: `Match ${600000 + i}`,
    startDate: new Date(base + (opts.offDays || -i) * 86400e3).toISOString(),
    startDateUtc: new Date(base + (opts.offDays || -i) * 86400e3).toISOString(),
    team: 1, num: (i % 11) + 1, price: 1200, charged: 1266, userStatus: opts.userStatus ?? "NONE",
    state: opts.state, removable: opts.state === "upcoming",
  });
  const rows = [];
  let i = 0;
  for (let u = 0; u < 3; u++) rows.push(mk(i++, { state: "upcoming", offDays: 3 - u })); // future, unsorted-ish
  for (let p = 0; p < 200; p++) rows.push(mk(i++, { state: "played", offDays: -(p + 1) }));
  rows.push(mk(i++, { state: "played", userStatus: "NO_SHOW", offDays: -500 }));
  for (let c = 0; c < 400; c++) rows.push(mk(i++, { state: "cancelled", offDays: -(c + 1) }));
  return {
    env: "production",
    player: { id: 78, name: "Ryan Mancuso", email: "rmancuso1@gmail.com", phone: "+14348259300", phoneVerified: true, city: "Austin", level: 4, registered: "2023-04-10T03:05:15.239Z", goals: 105, cityManager: true, credits: 0, status: "ok", banReason: null, bannedAt: null, banExpiredAt: null, matchesPlayed: 201, upcoming: 3 },
    membership: null, matches: rows,
    strikes: { activeCount: 0, limit: 4, isSuspended: false, suspendedTo: null, expiredAt: null, firstStrikeAt: null, logs: [] },
    accountHistory: [],
  };
})();
// live payments fixtures — MARISOL covers all FIVE states + a membership + a match join
const PAY_MARISOL = { ok: true, customerMatched: true, foundVia: ["email"], email: "m.reyes@gmail.com", rows: [
  { id: "ch_1", description: "Soccer Central Field 6", created: "2026-08-09T19:00:00.000Z", card: "visa ••4242", status: "pending", amount: 1200, matchId: "17402", isMembership: false },
  { id: "ch_2", description: "Soccer Central Field 4", created: "2026-08-05T18:00:00.000Z", card: "visa ••4242", status: "succeeded", amount: 1200, matchId: "17244", isMembership: false },
  { id: "ch_3", description: "Unlimited Monthly", created: "2026-08-02T11:00:00.000Z", card: "amex ••1007", status: "succeeded", amount: 2900, matchId: null, isMembership: true },
  { id: "ch_4", description: "Soccer Central Field 1", created: "2026-08-02T08:00:00.000Z", card: "visa ••4242", status: "refunded", amount: 1200, matchId: "17190", isMembership: false },
  { id: "ch_5", description: "Havana Fields", created: "2026-07-05T16:00:00.000Z", card: "mc ••5588", status: "disputed", amount: 1200, matchId: "16880", isMembership: false },
  { id: "ch_6", description: "Old Match", created: "2026-06-01T10:00:00.000Z", card: "visa ••4242", status: "failed", amount: 1200, matchId: "16000", isMembership: false },
] };
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
  // ONE SESSION PER IDENTITY, cached across the whole gate run — see sessionFor in _session.mjs.
  const session = await sessionFor("rmancuso@playmatchday.com");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(session) }] }] };

  const todayYMD = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  let lastWrite = null; // capture the roster POST body
  let lastBan = null;   // capture the ban POST body
  let creditPosts = []; // every credit POST body — proves "attempted exactly once"
  const creditState = { balance: 1234, serverBalance: 1234 };  // CENTS, and deliberately non-round

  const routes = async (ctx, { edit, manage = edit, credits = false }) => {
    // NOTE: Playwright checks the LAST-registered matching route first. Register the
    // general lookup handler FIRST and the specific /ban handler LAST so /ban wins.
    await ctx.route("**/api/lookup/**", (route) => {
      const url = new URL(route.request().url());
      const id = url.searchParams.get("id");
      const q = url.searchParams.get("q");
      if (id) { const P = id === "60180" ? DANNY : id === "88888" ? OVER : id === "77777" ? ERRP : id === "78" ? HV : MARISOL; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(P) }); }
      // mimic detectKind for the kind field (component reads it for the hint too, but hint is local)
      const kind = !q ? "empty" : q.includes("@") ? "email" : /^\d{1,6}$/.test(q.trim()) ? "id" : q.replace(/\D/g, "").length >= 7 ? "phone" : "name";
      const results = q && /mari|reyes|79214|2105557781|m\.reyes/i.test(q) ? SEARCH_HITS
        : q && /danny|60180/i.test(q) ? [{ id: 60180, name: "Danny Vo", email: "danny@example.com", phone: "+18329015669", city: "Houston", status: "suspended", hasMembership: false }]
        : q && /over|88888/i.test(q) ? [{ id: 88888, name: "Over Struck", email: "over@example.com", phone: "+15125550000", city: "Austin", status: "ok", hasMembership: true }]
        : q && /err|77777/i.test(q) ? [{ id: 77777, name: "Err Or", email: "err@example.com", phone: "+15125559999", city: "Austin", status: "ok", hasMembership: false }]
        : q && /ryan|mancuso|^78$/i.test(q) ? [{ id: 78, name: "Ryan Mancuso", email: "rmancuso1@gmail.com", phone: "+14348259300", city: "Austin", status: "ok", hasMembership: false }]
        : [];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind, results }) });
    });
    // /ban and /payments registered LAST so they win over the general lookup handler.
    await ctx.route("**/api/lookup/**/ban", (route) => {
      lastBan = { url: route.request().url(), body: JSON.parse(route.request().postData() || "{}") };
      if (!manage) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "no MANAGE PLAYERS" }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, outcome: "LANDED", logRecorded: true }) });
    });
    await ctx.route("**/api/lookup/**/payments**", (route) => {
      const id = new URL(route.request().url()).searchParams.get("id");
      if (id === "60180") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, rows: [], customerMatched: false, foundVia: [], email: "danny@example.com" }) });
      if (id === "88888") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, rows: [{ id: "ch_o", description: "Unlimited Monthly", created: "2026-08-01T10:00:00.000Z", card: "visa ••0000", status: "succeeded", amount: 2900, matchId: null, isMembership: true }], customerMatched: false, foundVia: ["userId"], email: "over@example.com" }) });
      if (id === "77777") return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, kind: "unreachable", error: "connection reset by peer" }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PAY_MARISOL) });
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
    // ── CREDITS (Phase 27). A stateful balance so a landed adjustment can be re-read, plus the
    // two failure shapes that matter: the RACE (the balance moved) and a hard rejection.
    await ctx.route("**/api/matchday/**/players/**/credits", (route) => {
      const req = route.request();
      // The ROUTE gate, not the button: refused even if the client somehow posts.
      if (!credits) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "EDIT CREDITS is required to change a player's balance. This is not part of Match Ops and is granted separately." }) });
      if (req.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balanceCents: creditState.balance, canEditCredits: true }) });
      const b = JSON.parse(req.postData() || "{}");
      creditPosts.push(b);
      if (b.reason === "FAILME") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "rejected by the server", landed: false, outcome: "FAILED" }) });
      // THE RACE — the server re-read finds a different balance than the screen showed.
      if (creditState.serverBalance !== b.expectedBeforeCents) {
        return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({
          aborted: true, landed: false, outcome: "NOT APPLIED", balanceCents: creditState.serverBalance,
          error: `Aborted — nothing was sent. The balance changed from $${(b.expectedBeforeCents / 100).toFixed(2)} to $${(creditState.serverBalance / 100).toFixed(2)} between the screen loading and this click. Re-enter the adjustment against the new figure if you still want it.`,
        }) });
      }
      creditState.balance = creditState.serverBalance = creditState.serverBalance + b.deltaCents;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true, landed: true, outcome: "LANDED", beforeCents: b.expectedBeforeCents,
        intendedAfterCents: creditState.balance, balanceCents: creditState.balance, deltaCents: b.deltaCents, logRecorded: true,
      }) });
    });
    await ctx.route("**/api/veo**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: [] }) }));
    await patchPerms(edit, manage, credits)(ctx); // independent edit / manage / credits grants
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
  // DISMISS THE POPOVER BY ITS OWN SCRIM, not by clicking a corner of the page.
  //
  // This was `page.click("body", {position:{x:5,y:5}})` — "click somewhere harmless". That spot
  // stopped being harmless when TopNav became sticky: (5,5) is now inside the header, the click
  // never reached the scrim, `fieldsOpen` stayed true, and the popover's full-viewport
  // `.scrim-quiet` (z-15) then swallowed EVERY later click in this suite. It surfaced as a 30s
  // timeout on act-suspend, fifty assertions away from the cause, because the .catch() below
  // swallowed the miss.
  //
  // The scrim IS the dismiss affordance, so clicking it is both what a user does and stable
  // against anything that later occupies a corner of the viewport.
  await page.keyboard.press("Escape").catch(() => {});
  await page.click(".scrim-quiet").catch(() => {});
  // Prove it actually closed — the silent .catch() above is exactly how this hid the first time.
  await page.waitForSelector(".pop", { state: "detached", timeout: 5000 });

  // ── strikes panel (display-only), member with 2 of 4 active ──
  eq("strikes panel rendered for a member", !!(await page.$('[data-testid="strikes"]')), true);
  eq("strike count says POINTS (not rows) — '2 of 4 points'", (await page.$eval('[data-testid="strike-count"]', (e) => e.textContent)).trim(), "2 of 4 points");
  eq("strikebar spells out it is strike POINTS", await page.$eval('[data-testid="strikes"] .stxt', (e) => /strike points/.test(e.textContent)), true);
  eq("4 pips, 2 lit", { pips: await page.$$eval('[data-testid="strikes"] .pip', (e) => e.length), lit: await page.$$eval('[data-testid="strikes"] .pip.on', (e) => e.length) }, { pips: 4, lit: 2 });
  eq("reason labels come from userStatus; NONE renders STRIKE, never 'NONE'", await page.$$eval('[data-testid="strikes"] .srow .st:nth-child(2)', (els) => els.map((e) => e.textContent.trim())), ["LATE CANCEL", "LATE", "NO SHOW", "STRIKE"]);
  eq("no strike chip ever says NONE or ON TIME", await page.$$eval('[data-testid="strikes"] .srow .st', (els) => els.some((e) => /^(NONE|ON TIME)$/.test(e.textContent.trim()))), false);
  eq("NONE-reason strike shows 'reason not recorded', not a made-up reason", await page.$eval('[data-testid="strikes"] .srow:last-child .l2', (e) => /Reason not recorded/.test(e.textContent)), true);
  eq("cancellation strike shows hours-before-kickoff", await page.$eval('[data-testid="strikes"] .srow .l2', (e) => /3\.2h before kickoff/.test(e.textContent)), true);
  eq("expired strike marked EXPIRED not ACTIVE", await page.$$eval('[data-testid="strikes"] .srow', (els) => { const last = els[els.length - 1]; return { active: !!last.querySelector(".st.sactive"), expired: !!last.querySelector(".st.expired") }; }), { active: false, expired: true });
  eq("strikes panel is display-only (no write buttons)", await page.$$eval('[data-testid="strikes"] button', (e) => e.length), 0);

  // ── all five panels now present, in order ──
  eq("panels: MEMBERSHIP, STRIKES, MATCH HISTORY, PAYMENTS · STRIPE, ACCOUNT HISTORY", await page.$$eval(".ptitle h3", (els) => els.map((e) => e.textContent)), ["MEMBERSHIP", "STRIKES", "MATCH HISTORY", "PAYMENTS · STRIPE", "ACCOUNT HISTORY"]);

  // ── PAYMENTS: live panel, all five states legible AND distinct from each other ──
  await page.waitForSelector('[data-testid="payments"] .prow', { timeout: 5000 });
  eq("payments shows 6 charges (10-most cap not hit)", await page.$$eval('[data-testid="payments"] .prow', (e) => e.length), 6);
  eq("all five statuses render", await page.$$eval('[data-testid="payments"] .st[data-status]', (els) => [...new Set(els.map((e) => e.getAttribute("data-status")))].sort()), ["disputed", "failed", "pending", "refunded", "succeeded"]);
  eq("membership charge (no matchId) tagged Membership; match charge joined to its name", {
    mem: await page.$$eval('[data-testid="payments"] .prow', (els) => els.some((r) => /Membership/.test(r.querySelector(".l2")?.textContent || ""))),
    match: await page.$$eval('[data-testid="payments"] .prow', (els) => els.some((r) => /Soccer Central Field 6/.test(r.querySelector(".l2")?.textContent || ""))),
  }, { mem: true, match: true });
  // the five status chips: each text/bg >= 4.5 AND all five backgrounds distinct
  { const chips = await page.$$eval('[data-testid="payments"] .st[data-status]', (els) => {
      const seen = {}; const out = [];
      const pc = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); const p = m[1].split(",").map(Number); return { r: p[0], g: p[1], b: p[2] }; };
      const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      const ratio = (a, b) => { const x = L(a), y = L(b), hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); };
      for (const e of els) { const st = e.getAttribute("data-status"); if (seen[st]) continue; seen[st] = 1; const cs = getComputedStyle(e); const bg = pc(cs.backgroundColor), fg = pc(cs.color); out.push({ st, bg: cs.backgroundColor, textContrast: Math.round(ratio(fg, bg) * 100) / 100 }); }
      return out;
    });
    const minText = Math.min(...chips.map((c) => c.textContrast));
    const distinctBgs = new Set(chips.map((c) => c.bg)).size;
    eq("5 status chips, all backgrounds distinct", distinctBgs, 5);
    (minText >= 4.5) ? ok(`every status chip text/bg contrast >= 4.5 (min ${minText})`) : bad("status chip contrast", `min ${minText}: ${JSON.stringify(chips)}`); }
  eq("payments note counts pending + failed/disputed", await page.$eval('[data-testid="payments"] .ptitle .note', (e) => e.textContent).then((t) => /pending/.test(t) && /failed\/disputed/.test(t)), true);
  eq("found-by-email => NO 'via userId' mismatch note", !!(await page.$('[data-testid="pay-via-userid"]')), false);
  eq("payments amount note explains base vs charged (fee)", await page.$eval('[data-testid="pay-amount-note"]', (e) => /processing fee/i.test(e.textContent) && /base spot price/i.test(e.textContent)), true);

  // ── #5 PREFERABLE CITY renders the real value (from the list row), not "—" ──
  eq("PREFERABLE CITY shows the value, not a dash", await page.$$eval(".f", (els) => { const f = els.find((e) => e.querySelector(".k")?.textContent === "PREFERABLE CITY"); return f?.querySelector(".v")?.textContent?.trim(); }), "San Antonio");

  // ── #1d footer can't lie: all five panels present AND builtnote makes no "not built" claim ──
  eq("builtnote never claims a panel is 'not built'", await page.$eval('[data-testid="builtnote"]', (e) => /not built/i.test(e.textContent)), false);
  eq("no stale 'notbuilt' footer element exists", await page.$('[data-testid="notbuilt"]') === null, true);

  // ── account history: clean member offers Suspend + Expel (MANAGE PLAYERS held) ──
  eq("clean record shows Suspend + Expel, not Lift", { suspend: !!(await page.$('[data-testid="act-suspend"]')), expel: !!(await page.$('[data-testid="act-expel"]')), lift: !!(await page.$('[data-testid="act-lift"]')) }, { suspend: true, expel: true, lift: false });

  // ── SUSPEND flow: reason + until required, then writes {action:suspend} ──
  await page.click('[data-testid="act-suspend"]'); await page.waitForSelector(".modal", { timeout: 5000 });
  eq("suspend confirm disabled until reason + until", await page.$eval('[data-testid="ban-confirm"]', (e) => e.disabled), true);
  await page.fill('[data-testid="ban-reason"]', "Repeated late cancellations");
  eq("suspend still disabled with reason but no date", await page.$eval('[data-testid="ban-confirm"]', (e) => e.disabled), true);
  await page.fill('[data-testid="ban-until"]', "2026-09-30");
  eq("suspend enabled once reason + date set", await page.$eval('[data-testid="ban-confirm"]', (e) => e.disabled), false);
  lastBan = null; await page.click('[data-testid="ban-confirm"]'); await page.waitForTimeout(300);
  eq("suspend wrote {action:suspend, until, reason} for the player", { a: lastBan?.body?.action, u: lastBan?.body?.until, r: !!lastBan?.body?.reason, id: lastBan?.body?.playerId }, { a: "suspend", u: "2026-09-30", r: true, id: 79214 });

  // ── EXPEL flow: reason AND exact name typed ──
  await page.click('[data-testid="act-expel"]'); await page.waitForSelector(".modal", { timeout: 5000 });
  await page.fill('[data-testid="ban-reason"]', "Fraudulent dispute after playing");
  eq("expel disabled until the exact name is typed", await page.$eval('[data-testid="ban-confirm"]', (e) => e.disabled), true);
  await page.fill('[data-testid="ban-confirm-name"]', "Marisol Reyes");
  eq("expel enabled once name matches", await page.$eval('[data-testid="ban-confirm"]', (e) => e.disabled), false);
  lastBan = null; await page.click('[data-testid="ban-confirm"]'); await page.waitForTimeout(300);
  eq("expel wrote {action:expel, reason}", { a: lastBan?.body?.action, r: !!lastBan?.body?.reason }, { a: "expel", r: true });

  // ── OVER-threshold pips: 5 of 4 must not silently read as 4 ──
  await type("Over"); await page.waitForSelector('.res[data-pid="88888"]', { timeout: 5000 }); await page.click('.res[data-pid="88888"]');
  await page.waitForSelector('.idcard[data-pid="88888"]', { timeout: 5000 });
  eq("over-threshold shows '5 of 4 points'", (await page.$eval('[data-testid="strike-count"]', (e) => e.textContent)).trim(), "5 of 4 points");
  eq("overflow badge '+1' is shown (not silently clamped to 4 pips)", await page.$eval('[data-testid="pip-over"]', (e) => e.textContent).catch(() => ""), "+1");
  eq("strike-suspended banner present at/over threshold", !!(await page.$('[data-testid="strike-suspended"]')), true);
  // payments FOUND via metadata.userId (email mismatch rescued) — must SAY which route
  await page.waitForSelector('[data-testid="payments"] .prow, [data-testid="pay-via-userid"]', { timeout: 5000 });
  eq("payments via metadata.userId surfaces the mismatch note", !!(await page.$('[data-testid="pay-via-userid"]')), true);

  // ── PAYMENTS failure mode 2: Stripe errors -> panel says so, never an empty list ──
  await type("Err"); await page.waitForSelector('.res[data-pid="77777"]', { timeout: 5000 }); await page.click('.res[data-pid="77777"]');
  await page.waitForSelector('.idcard[data-pid="77777"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="pay-error"]', { timeout: 5000 });
  eq("Stripe error shows an explicit error, not an empty list", { err: /could not be read/i.test(await page.$eval('[data-testid="pay-error"]', (e) => e.textContent)), rows: await page.$$eval('[data-testid="payments"] .prow', (e) => e.length) }, { err: true, rows: 0 });

  // ── LIFT flow: a suspended player offers Lift, account history shows who/when/until ──
  await type("Danny"); await page.waitForSelector('.res[data-pid="60180"]', { timeout: 5000 }); await page.click('.res[data-pid="60180"]');
  await page.waitForSelector('.idcard[data-pid="60180"]', { timeout: 5000 });
  eq("suspended player offers Lift (not Suspend)", { lift: !!(await page.$('[data-testid="act-lift"]')), suspend: !!(await page.$('[data-testid="act-suspend"]')) }, { lift: true, suspend: false });
  // PAYMENTS failure mode 1: no Stripe customer -> explicit message, NOT an empty list
  await page.waitForSelector('[data-testid="pay-nomatch"]', { timeout: 5000 });
  eq("no-customer says 'No Stripe customer found', never an empty list", { msg: /No Stripe customer found/i.test(await page.$eval('[data-testid="pay-nomatch"]', (e) => e.textContent)), rows: await page.$$eval('[data-testid="payments"] .prow', (e) => e.length) }, { msg: true, rows: 0 });
  { const row = (await page.$eval('[data-testid="account-history"] .hrow', (e) => e.textContent)).replace(/\s+/g, " ");
    eq("account-history row shows action, reason, until, and WHO", { act: /SUSPENDED/.test(row), reason: /late cancellations/i.test(row), by: /Nick Zelfine/.test(row), until: /Aug 31/.test(row) }, { act: true, reason: true, by: true, until: true }); }
  await page.click('[data-testid="act-lift"]'); await page.waitForSelector(".modal", { timeout: 5000 });
  eq("lift disabled until reason", await page.$eval('[data-testid="ban-confirm"]', (e) => e.disabled), true);
  await page.fill('[data-testid="ban-reason"]', "Appealed, dispute resolved");
  lastBan = null; await page.click('[data-testid="ban-confirm"]'); await page.waitForTimeout(300);
  eq("lift wrote {action:lift, reason} for the player", { a: lastBan?.body?.action, r: !!lastBan?.body?.reason, id: lastBan?.body?.playerId }, { a: "lift", r: true, id: 60180 });
  await type("Marisol"); await page.waitForSelector('.res[data-pid="79214"]', { timeout: 5000 }); await page.click('.res[data-pid="79214"]');
  await page.waitForSelector('.idcard[data-pid="79214"]', { timeout: 5000 });

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

  // ══ #3/#4 HIGH-VOLUME (604 matches): structure, not just a limit ══
  await type("Ryan"); await page.waitForSelector('.res[data-pid="78"]', { timeout: 5000 }); await page.click('.res[data-pid="78"]');
  await page.waitForSelector('.idcard[data-pid="78"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="match-chips"]', { timeout: 5000 });
  const chipN = async (c) => Number(await page.$eval(`[data-chip="${c}"] b`, (e) => e.textContent));
  { const all = await chipN("all"), up = await chipN("upcoming"), pl = await chipN("played"), ns = await chipN("noshow"), ca = await chipN("cancelled");
    eq("chip counts partition the total (sum === All)", up + pl + ns + ca, all);
    eq("All chip === 604", all, 604);
    eq("header PLAYED fact === Played chip", Number(await page.$$eval(".f", (els) => { const f = els.find((e) => e.querySelector(".k")?.textContent === "PLAYED"); return f?.querySelector(".v")?.textContent?.trim(); })), pl); }
  eq("604 rows NOT all rendered (upcoming 3 + first 10 past = 13)", await page.$$eval('[data-testid="match-history"] .mrow', (e) => e.length), 13);
  eq("header says 'Showing 13 of 604'", (await page.$eval('[data-testid="match-showing"]', (e) => e.textContent)).includes("Showing 13 of 604"), true);
  eq("first 3 rows are UPCOMING (pinned to top regardless of date)", await page.$$eval('[data-testid="match-history"] .mrow', (els) => els.slice(0, 3).map((r) => r.getAttribute("data-bucket"))), ["upcoming", "upcoming", "upcoming"]);
  eq("row 4 is a PAST row (not upcoming)", await page.$$eval('[data-testid="match-history"] .mrow', (els) => els[3].getAttribute("data-bucket") !== "upcoming"), true);
  { const firstBefore = await page.$eval('[data-testid="match-history"] .mrow', (e) => e.getAttribute("data-match"));
    await page.click('[data-testid="show-more"]'); await page.waitForTimeout(120);
    eq("Show more APPENDS 25 (13 -> 38), does not replace", { rows: await page.$$eval('[data-testid="match-history"] .mrow', (e) => e.length), firstUnchanged: (await page.$eval('[data-testid="match-history"] .mrow', (e) => e.getAttribute("data-match"))) === firstBefore }, { rows: 38, firstUnchanged: true });
    eq("header updates to 'Showing 38 of 604'", (await page.$eval('[data-testid="match-showing"]', (e) => e.textContent)).includes("Showing 38 of 604"), true); }
  // filter to Cancelled: only cancelled rows, no upcoming pinned, count reconciles
  await page.click('[data-chip="cancelled"]'); await page.waitForTimeout(120);
  eq("Cancelled filter: 10 shown of 400, all rows cancelled, none upcoming", { showing: (await page.$eval('[data-testid="match-showing"]', (e) => e.textContent)).includes("Showing 10 of 400"), allCancelled: await page.$$eval('[data-testid="match-history"] .mrow', (els) => els.every((r) => r.getAttribute("data-bucket") === "cancelled")) }, { showing: true, allCancelled: true });
  // filter to Upcoming: all 3, no pagination, never truncated
  await page.click('[data-chip="upcoming"]'); await page.waitForTimeout(120);
  eq("Upcoming filter: all 3 shown, no Show-more", { rows: await page.$$eval('[data-testid="match-history"] .mrow', (e) => e.length), noMore: (await page.$('[data-testid="show-more"]')) === null }, { rows: 3, noMore: true });
  // back to Marisol for the write flows
  await type("Marisol"); await page.waitForSelector('.res[data-pid="79214"]', { timeout: 5000 }); await page.click('.res[data-pid="79214"]');
  await page.waitForSelector('.idcard[data-pid="79214"]', { timeout: 5000 });

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
  eq("read-only: ban actions locked (need MANAGE PLAYERS)", await rp.$eval('[data-testid="account-history"] .locked', (e) => /MANAGE PLAYERS/.test(e.textContent)).catch(() => false), true);
  eq("read-only: header says READ ONLY", await rp.$eval(".livetag", (e) => /READ ONLY/.test(e.textContent)), true);

  // ══ INDEPENDENCE: restoring one authority does NOT restore the other ══
  // EDIT MATCHES only -> Add/Remove enabled, but ban actions still locked.
  const eo = await browser.newContext({ viewport: { width: 1280, height: 1000 }, storageState });
  await routes(eo, { edit: true, manage: false });
  const ep = await eo.newPage();
  await ep.goto(PAGE, { waitUntil: "domcontentloaded" }); await ep.waitForSelector("#pl-q", { timeout: 30000 });
  await ep.fill("#pl-q", "Marisol"); await ep.waitForTimeout(260);
  await ep.waitForSelector('.res[data-pid="79214"]'); await ep.click('.res[data-pid="79214"]');
  await ep.waitForSelector('.idcard[data-pid="79214"]');
  eq("EDIT-only: Add enabled but ban actions LOCKED (independence)", { add: await ep.$eval('[data-testid="add-match"]', (e) => e.disabled), banLocked: await ep.$eval('[data-testid="account-history"] .locked', (e) => /MANAGE PLAYERS/.test(e.textContent)).catch(() => false) }, { add: false, banLocked: true });

  // MANAGE PLAYERS only -> ban actions enabled, but Add/Remove disabled.
  const mo = await browser.newContext({ viewport: { width: 1280, height: 1000 }, storageState });
  await routes(mo, { edit: false, manage: true });
  const mpg = await mo.newPage();
  await mpg.goto(PAGE, { waitUntil: "domcontentloaded" }); await mpg.waitForSelector("#pl-q", { timeout: 30000 });
  await mpg.fill("#pl-q", "Marisol"); await mpg.waitForTimeout(260);
  await mpg.waitForSelector('.res[data-pid="79214"]'); await mpg.click('.res[data-pid="79214"]');
  await mpg.waitForSelector('.idcard[data-pid="79214"]');
  eq("MANAGE-only: ban actions enabled but Add DISABLED (independence)", { suspend: await mpg.$eval('[data-testid="act-suspend"]', (e) => e.disabled).catch(() => "missing"), add: await mpg.$eval('[data-testid="add-match"]', (e) => e.disabled) }, { suspend: false, add: true });

  // ══════════════ PHASE 27 · CREDIT ADJUSTMENT ══════════════
  // Every assertion below is on a NON-ROUND balance (1234 cents = $12.34). $0.00 and $25.00 both
  // survive a 100x error in either direction and would prove nothing about the units.

  // ── (a) WITHOUT the grant: the control is disabled AND the route refuses ──────────────────────
  { const nc = await browser.newContext({ viewport: { width: 1280, height: 1200 }, storageState });
    await routes(nc, { edit: true, manage: true, credits: false });   // matchops + edit + manage, NO credits
    const np = await nc.newPage();
    await np.goto(PAGE, { waitUntil: "domcontentloaded" }); await np.waitForSelector("#pl-q", { timeout: 30000 });
    await np.fill("#pl-q", "Marisol"); await np.waitForTimeout(260);
    await np.click('.res[data-pid="79214"]'); await np.waitForSelector('.idcard[data-pid="79214"]');
    await np.waitForSelector('[data-testid="credit-panel"]', { timeout: 10000 });
    const st = await np.evaluate(() => ({
      amount: document.querySelector('[data-testid="credit-amount"]')?.disabled,
      reason: document.querySelector('[data-testid="credit-reason"]')?.disabled,
      apply: document.querySelector('[data-testid="credit-apply"]')?.disabled,
      locked: !!document.querySelector('[data-testid="credit-locked"]'),
    }));
    eq("credits: WITHOUT the grant every input and the button are disabled, and it says why",
      st, { amount: true, reason: true, apply: true, locked: true });
    // ...and the ROUTE refuses too — the button is a courtesy, not the control.
    creditPosts = [];
    const direct = await np.evaluate(async () => {
      const r = await fetch("/api/matchday/production/players/79214/credits", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deltaCents: 2500, expectedBeforeCents: 1234, reason: "bypassing the button" }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    });
    (direct.status === 403 && /granted separately/i.test(direct.body.error || ""))
      ? ok("credits: the ROUTE refuses a direct POST without the grant, not just the button")
      : bad("credits: route did not refuse", JSON.stringify(direct));
    await nc.close(); }

  // ── (b) WITH the grant ───────────────────────────────────────────────────────────────────────
  const cc = await browser.newContext({ viewport: { width: 1280, height: 1200 }, storageState });
  await routes(cc, { edit: true, manage: true, credits: true });
  const cp = await cc.newPage();
  const openMarisol = async () => {
    await cp.goto(PAGE, { waitUntil: "domcontentloaded" }); await cp.waitForSelector("#pl-q", { timeout: 30000 });
    await cp.fill("#pl-q", "Marisol"); await cp.waitForTimeout(260);
    await cp.click('.res[data-pid="79214"]'); await cp.waitForSelector('.idcard[data-pid="79214"]');
    await cp.waitForSelector('[data-testid="credit-panel"]', { timeout: 10000 });
  };
  await openMarisol();

  // UNITS — the headline and the panel agree, and both read $12.34 from 1234 cents
  { const shown = await cp.evaluate(() => ({
      panel: document.querySelector('[data-testid="credit-balance"]')?.textContent.trim(),
      cents: document.querySelector('[data-testid="credit-balance"]')?.getAttribute("data-cents"),
      headline: [...document.querySelectorAll(".facts .f")].find((f) => /CREDITS/.test(f.textContent))?.textContent,
    }));
    (shown.panel === "Balance $12.34" && shown.cents === "1234" && /\$12\.34/.test(shown.headline || ""))
      ? ok("credits: 1234 cents renders as $12.34 in BOTH the headline and the panel (not $1234.00, not $0.12)")
      : bad("credits: units", JSON.stringify(shown)); }

  // THE REASON IS REQUIRED
  await cp.fill('[data-testid="credit-amount"]', "+25");
  await cp.waitForTimeout(120);
  { const st = await cp.evaluate(() => ({
      apply: document.querySelector('[data-testid="credit-apply"]')?.disabled,
      err: [...document.querySelectorAll('[data-testid="credit-error"]')].some((e) => /reason is required/i.test(e.textContent)),
    }));
    (st.apply === true && st.err) ? ok("credits: an amount with NO reason leaves the button disabled and says a reason is required")
      : bad("credits: reason not required", JSON.stringify(st)); }

  // THE STATED CONSEQUENCE MATCHES THE DELTA ENTERED
  eq("credits: the consequence states the before and after in dollars, from the entered delta",
    await cp.$eval('[data-testid="credit-consequence"]', (e) => e.textContent.trim()),
    "Marisol Reyes's balance goes from $12.34 to $37.34.");
  await cp.fill('[data-testid="credit-amount"]', "-2.34");
  await cp.waitForTimeout(120);
  eq("credits: a subtraction restates it, still in cents-exact dollars",
    await cp.$eval('[data-testid="credit-consequence"]', (e) => e.textContent.trim()),
    "Marisol Reyes's balance goes from $12.34 to $10.00.");

  // THE CAP
  await cp.fill('[data-testid="credit-amount"]', "200.01");
  await cp.fill('[data-testid="credit-reason"]', "over the cap on purpose");
  await cp.waitForTimeout(150);
  { creditPosts = [];
    const st = await cp.evaluate(() => ({
      apply: document.querySelector('[data-testid="credit-apply"]')?.disabled,
      msg: [...document.querySelectorAll('[data-testid="credit-error"]')].map((e) => e.textContent).join(" "),
    }));
    (st.apply === true && /\$200\.00/.test(st.msg) && /typo guard/i.test(st.msg) && creditPosts.length === 0)
      ? ok("credits: an adjustment over the $200.00 cap is refused, explains it is a typo guard, and sends nothing")
      : bad("credits: cap", JSON.stringify(st)); }
  eq("credits: exactly $200.00 is allowed (the cap is inclusive)",
    await (async () => { await cp.fill('[data-testid="credit-amount"]', "200"); await cp.waitForTimeout(150);
      return cp.$eval('[data-testid="credit-apply"]', (e) => e.disabled); })(), false);

  // A HAPPY PATH — exactly ONE request, and the balance re-reads
  creditPosts = [];
  await cp.fill('[data-testid="credit-amount"]', "+12.66");
  await cp.fill('[data-testid="credit-reason"]', "goodwill after the Tuesday cancellation");
  await cp.waitForTimeout(150);
  await cp.click('[data-testid="credit-apply"]');
  await cp.waitForSelector('[data-testid="credit-result"]', { timeout: 10000 });
  { const r = await cp.evaluate(() => ({
      verdict: document.querySelector('[data-testid="credit-result"]')?.getAttribute("data-verdict"),
      text: document.querySelector('[data-testid="credit-result"]')?.textContent,
      balance: document.querySelector('[data-testid="credit-balance"]')?.getAttribute("data-cents"),
      headline: [...document.querySelectorAll(".facts .f")].find((f) => /CREDITS/.test(f.textContent))?.textContent,
    }));
    (r.verdict === "LANDED" && creditPosts.length === 1 && r.balance === "2500" && /\$25\.00/.test(r.text) && /\$25\.00/.test(r.headline || ""))
      ? ok("credits: one adjustment = exactly ONE request, reports LANDED from a re-read, and the true balance ($25.00) replaces the old one everywhere")
      : bad("credits: happy path", `${JSON.stringify(r)} posts=${creditPosts.length}`); }
  eq("credits: the request carried the DELTA and the expected before-balance — never an absolute new balance",
    { keys: Object.keys(creditPosts[0]).sort(), delta: creditPosts[0].deltaCents, expected: creditPosts[0].expectedBeforeCents, hasAbsolute: "creditAmount" in creditPosts[0] || "balanceCents" in creditPosts[0] },
    { keys: ["deltaCents", "expectedBeforeCents", "reason"], delta: 1266, expected: 1234, hasAbsolute: false });
  eq("credits: the reason travels with it, for the change log", creditPosts[0].reason, "goodwill after the Tuesday cancellation");

  // A FAILURE IS ATTEMPTED EXACTLY ONCE — no retry, ever
  creditPosts = [];
  await cp.fill('[data-testid="credit-amount"]', "+1");
  await cp.fill('[data-testid="credit-reason"]', "FAILME");
  await cp.waitForTimeout(150);
  await cp.click('[data-testid="credit-apply"]');
  await cp.waitForFunction(() => document.querySelector('[data-testid="credit-result"]')?.getAttribute("data-verdict") === "FAILED", null, { timeout: 10000 });
  await cp.waitForTimeout(900);   // give any retry time to appear
  { const balance = await cp.$eval('[data-testid="credit-balance"]', (e) => e.getAttribute("data-cents"));
    (creditPosts.length === 1 && balance === "2500")
      ? ok("credits: a FAILED write is attempted exactly ONCE — never retried — and the balance is unchanged")
      : bad("credits: retry on failure", `posts=${creditPosts.length} balance=${balance}`); }

  // THE RACE — the balance moved between the screen and the click
  creditState.serverBalance = 500;    // someone spent; the screen still shows $25.00
  creditPosts = [];
  await cp.fill('[data-testid="credit-amount"]', "+10");
  await cp.fill('[data-testid="credit-reason"]', "against a stale balance");
  await cp.waitForTimeout(150);
  await cp.click('[data-testid="credit-apply"]');
  await cp.waitForFunction(() => document.querySelector('[data-testid="credit-result"]')?.getAttribute("data-verdict") === "ABORTED", null, { timeout: 10000 });
  await cp.waitForTimeout(900);
  { const r = await cp.evaluate(() => ({
      text: document.querySelector('[data-testid="credit-result"]')?.textContent,
      balance: document.querySelector('[data-testid="credit-balance"]')?.getAttribute("data-cents"),
    }));
    const reportsNew = /\$5\.00/.test(r.text || "") && /\$25\.00/.test(r.text || "");
    (creditPosts.length === 1 && reportsNew && r.balance === "500" && creditState.serverBalance === 500)
      ? ok("credits: a balance that changed between read and write ABORTS, reports the new value ($5.00), applies nothing, and does not re-try with the new figure")
      : bad("credits: race", `${JSON.stringify(r)} posts=${creditPosts.length} server=${creditState.serverBalance}`); }

  // ...and the aborted attempt did not quietly become a second, re-based write
  eq("credits: after an abort the panel is showing the TRUE balance, so a deliberate retry is against real facts",
    await cp.$eval('[data-testid="credit-consequence"]', (e) => e.textContent.trim()),
    "Marisol Reyes's balance goes from $5.00 to $15.00.");

  // NEGATIVE — Clubhouse refuses to be the thing that finds out
  await cp.fill('[data-testid="credit-amount"]', "-10");
  await cp.waitForTimeout(150);
  { creditPosts = [];
    const st = await cp.evaluate(() => ({
      apply: document.querySelector('[data-testid="credit-apply"]')?.disabled,
      msg: [...document.querySelectorAll('[data-testid="credit-error"]')].map((e) => e.textContent).join(" "),
    }));
    (st.apply === true && /-\$5\.00/.test(st.msg) && creditPosts.length === 0)
      ? ok("credits: an adjustment that would go negative is refused before any request")
      : bad("credits: negative", JSON.stringify(st)); }

  // 390 PORTRAIT — the same control on a phone
  await cp.setViewportSize({ width: 390, height: 844 });
  await cp.waitForTimeout(200);
  { const m = await cp.evaluate(() => {
      const panel = document.querySelector('[data-testid="credit-panel"]');
      const r = panel.getBoundingClientRect();
      const fields = [...panel.querySelectorAll("input")];
      return {
        insideViewport: r.left >= -1 && r.right <= window.innerWidth + 1,
        pageLeak: document.documentElement.scrollWidth > window.innerWidth + 1,
        stacked: new Set(fields.map((f) => Math.round(f.getBoundingClientRect().top))).size === fields.length,
        tapTargets: fields.every((f) => f.getBoundingClientRect().height >= 36),
        consequenceVisible: !!panel.querySelector('[data-testid="credit-consequence"]'),
      }; });
    JSON.stringify(m) === JSON.stringify({ insideViewport: true, pageLeak: false, stacked: true, tapTargets: true, consequenceVisible: true })
      ? ok("credits @390 portrait: the panel fits, the fields stack one per band, tap targets survive, and the consequence is still shown")
      : bad("credits @390", JSON.stringify(m)); }
  await cc.close();

  await browser.close();
  console.log(`\nverify-lookup: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log("FAILURES:\n" + fails.map((f) => "  - " + f).join("\n")); process.exit(1); }
}
main().catch(fatal);
