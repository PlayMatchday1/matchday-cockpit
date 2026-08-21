// REGISTERED PLAYERS — the table under Player Lookup's search.
//
// WHAT THIS SUITE CAN AND CANNOT PROVE TODAY. The Warsaw ACCOUNT does not exist yet, so the
// confined path is exercised the only honest way available: an unconfined account calling the same
// endpoint with ?city=WAW runs the identical scoping code — the union, the basis split, the count.
// What that CANNOT prove is the refusal a confined account gets when it names another city, because
// there is no confined session to make the call. Those assertions are named at the end and skipped
// out loud rather than quietly omitted.
//
// THE NUMBERS MOVED SINCE PART 1 AND THE SUITE FOLLOWS THE DATA, not the other way round. Part 1
// reported 3 Warsaw players from an ad-hoc scan that truncated; the chunked query the route uses
// finds 13 distinct roster user_ids, 12 of which resolve to a users row. So the split is 0
// registered / 11 roster / 1 both, not 1 / 2 / 0. Every figure below is derived from the mirror at
// run time — nothing here is a number written down.
//
//   node scripts/e2e/verify-registered-players.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0, SKIP = 0;
const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const skip = (n, why) => { SKIP++; console.log(`  ~ SKIPPED ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const CITY = "WAW";
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── THE TRUTH, FROM THE MIRROR, COMPUTED THE WAY THE ROUTE COMPUTES IT ─────────────────────────
const { data: wawMatches, error: mErr } = await svc
  .from("mdapi_matches").select("api_id, start_date").eq("city_identifier", CITY);
if (mErr) throw new Error(mErr.message);
const { data: rosterRows, error: rErr } = await svc
  .from("mdapi_match_players").select("user_id")
  .in("match_api_id", wawMatches.map((m) => m.api_id)).neq("user_is_fake_player", true);
if (rErr) throw new Error(rErr.message);
const rosterIds = new Set(rosterRows.map((r) => Number(r.user_id)));
const { data: regRows } = await svc
  .from("mdapi_users").select("id").eq("preferable_city_name", "Warsaw").neq("is_fake_player", true);
const registeredIds = new Set((regRows ?? []).map((r) => Number(r.id)));
const unionIds = [...new Set([...rosterIds, ...registeredIds])];
const { data: resolvable } = await svc.from("mdapi_users").select("id, is_fake_player").in("id", unionIds);
const resolvedIds = new Set((resolvable ?? []).filter((r) => r.is_fake_player !== true).map((r) => Number(r.id)));
const EXPECT_TOTAL = resolvedIds.size;
const EXPECT_SPLIT = { registered: 0, roster: 0, both: 0 };
for (const id of resolvedIds) {
  const reg = registeredIds.has(id), ros = rosterIds.has(id);
  if (reg && ros) EXPECT_SPLIT.both++;
  else if (reg) EXPECT_SPLIT.registered++;
  else EXPECT_SPLIT.roster++;
}
const { count: EXPECT_ALL } = await svc
  .from("mdapi_users").select("id", { count: "exact", head: true }).neq("is_fake_player", true);
const { data: fakeRow } = await svc.from("mdapi_users").select("id").eq("is_fake_player", true).limit(1);
const KNOWN_FAKE = Number(fakeRow?.[0]?.id ?? 0);
const { data: outsider } = await svc
  .from("mdapi_users").select("id").eq("preferable_city_name", "Austin").neq("is_fake_player", true).limit(1);
const KNOWN_NON_WARSAW = Number(outsider?.[0]?.id ?? 0);

console.log(`\nfrom the mirror: WAW matches ${wawMatches.length} · union ${unionIds.length} ids · resolvable ${EXPECT_TOTAL}`);
console.log(`  expected split: ${JSON.stringify(EXPECT_SPLIT)} · all-cities total ${EXPECT_ALL}`);

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1620, height: 1300 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${BASE}/match-ops/player-lookup`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="registered-table"]', { timeout: 120000 });
await page.waitForTimeout(3000);
eq("no uncaught page errors", errors, []);

const api = (qs) => page.evaluate(async (qs) => {
  const key = Object.keys(localStorage).find((k) => k.includes("auth-token"));
  const t = JSON.parse(localStorage.getItem(key) ?? "{}");
  const token = t?.access_token ?? t?.currentSession?.access_token;
  const r = await fetch(`/api/players/registered${qs}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store",
  });
  return { status: r.status, body: await r.json() };
}, qs);

// ── 1. THE SCOPED LIST ─────────────────────────────────────────────────────────────────────────
console.log("\n── the Warsaw list ──");
{
  const r = await api(`?city=${CITY}&page=1&size=200`);
  eq("  control — the endpoint answered", r.status, 200);
  eq("  control — it returned rows", (r.body.players ?? []).length > 0, true);
  eq("the total equals the resolvable union, not the id set", r.body.total, EXPECT_TOTAL);
  eq("  …and equals the number of rows it can actually show", r.body.total, r.body.players.length);
  eq("the basis split matches the mirror", r.body.basisCounts, EXPECT_SPLIT);
  eq("  …and the split adds up to the total",
     r.body.basisCounts.registered + r.body.basisCounts.roster + r.body.basisCounts.both, r.body.total);
  console.log(`     ${r.body.total} players · ${JSON.stringify(r.body.basisCounts)}`);

  // EVERY ROW MATCHES THE UNION RULE — the positive half is the assertion above (rows exist).
  const offenders = r.body.players.filter((p) => !resolvedIds.has(p.id));
  eq("every row matches the union rule", offenders.map((p) => p.id), []);

  // A KNOWN NON-WARSAW PLAYER IS ABSENT — the negative half, by id, not by count.
  eq(`  control — a known non-Warsaw player id was found (${KNOWN_NON_WARSAW})`, KNOWN_NON_WARSAW > 0, true);
  eq("a known non-Warsaw player is absent", r.body.players.some((p) => p.id === KNOWN_NON_WARSAW), false);

  // FAKE PLAYERS ARE ABSENT, asserted by a known id rather than by trusting the filter.
  eq(`  control — a known fake player id was found (${KNOWN_FAKE})`, KNOWN_FAKE > 0, true);
  eq("a known fake player is absent", r.body.players.some((p) => p.id === KNOWN_FAKE), false);

  // BASIS IS NEVER NULL IN A SCOPED LIST — a null there means the column silently gave up.
  eq("every scoped row carries a basis", r.body.players.every((p) => p.basis != null), true);
}

// ── 2. THE DASHES ──────────────────────────────────────────────────────────────────────────────
console.log("\n── empty cells are dashes, never blank ──");
{
  const r = await api(`?city=${CITY}&page=1&size=200`);
  const noPhone = r.body.players.filter((p) => p.phone == null);
  const noMatch = r.body.players.filter((p) => p.last_match == null);
  eq("  control — the Warsaw list contains a player with no played match", noMatch.length > 0, true);
  console.log(`     ${noPhone.length} without a phone · ${noMatch.length} with no played match`);

  const cells = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="rp-row"]')];
    return rows.map((tr) => ({
      id: Number(tr.getAttribute("data-pid")),
      phone: tr.querySelector('[data-testid="rp-phone"]')?.textContent ?? null,
      last: tr.querySelector('[data-testid="rp-lastmatch"]')?.textContent ?? null,
      member: tr.querySelector('[data-testid="rp-member"]')?.textContent ?? null,
    }));
  });
  eq("  control — the table rendered rows", cells.length > 0, true);
  eq("no rendered phone cell is blank", cells.filter((c) => (c.phone ?? "").trim() === "").length, 0);
  eq("no rendered last-match cell is blank", cells.filter((c) => (c.last ?? "").trim() === "").length, 0);
  eq("member reads yes or no, never a badge word",
     cells.every((c) => ["yes", "no"].includes((c.member ?? "").trim())), true);
}

// ── 3. NEWEST REGISTRATION FIRST ───────────────────────────────────────────────────────────────
console.log("\n── default sort ──");
{
  const r = await api("?page=1&size=5");
  eq("  control — at least two rows to compare", r.body.players.length >= 2, true);
  const [a, b] = r.body.players;
  eq("the first two rows are in newest-first order", a.registered >= b.registered, true);
  eq("  …and they are NOT equal, so the comparison had teeth", a.registered === b.registered, false);
  console.log(`     ${a.id}@${String(a.registered).slice(0, 19)} then ${b.id}@${String(b.registered).slice(0, 19)}`);

  const asc = await api("?page=1&size=5&dir=asc");
  eq("reversing the direction reverses the order",
     asc.body.players[0].registered <= asc.body.players[1].registered, true);
  eq("  …and returns a different first row", asc.body.players[0].id === a.id, false);
}

// ── 4. THE UNSCOPED LIST AND ITS COUNT ─────────────────────────────────────────────────────────
console.log("\n── all cities ──");
{
  const r = await api("?page=1&size=10");
  eq("the unconfined total is every non-fake player", r.body.total, EXPECT_ALL);
  eq("  …and it is greater than the scoped total", r.body.total > EXPECT_TOTAL, true);
  eq("  …and carries no basis split, which is a city-scoped idea", r.body.basisCounts, null);
  eq("a page is a page, not the whole table", r.body.players.length, 10);
  console.log(`     ${r.body.total} players across all cities vs ${EXPECT_TOTAL} in ${CITY}`);
}

// ── 5. NAMING A CITY ───────────────────────────────────────────────────────────────────────────
console.log("\n── naming a city ──");
{
  const bad1 = await api("?city=NOPE");
  eq("an unknown city is refused, not widened back to everyone", bad1.status, 400);
  // A LARGE CITY IS REFUSED WITH A REASON, NOT A TIMEOUT. The roster half walks match-by-match
  // because mdapi_match_players has no FK to mdapi_matches; Austin's 6,614 matches used to return
  // a 500 with an empty body. 501 and a sentence naming the missing key is recoverable; a 500 is
  // not, and neither is a quietly partial list.
  const big = await api("?city=ATX&page=1&size=3");
  eq("a city over the walk ceiling is refused, not timed out", big.status, 501);
  eq("  …and the refusal names the reason", /foreign key|no foreign key/i.test(big.body.error ?? ""), true);
  eq("  …and does NOT return a partial list", big.body.players, undefined);
  console.log(`     ATX: ${String(big.body.error).slice(0, 96)}…`);
}

// ── 6. THE MIRROR'S CLOCK IS ON SCREEN ─────────────────────────────────────────────────────────
console.log("\n── staleness is stated ──");
{
  const txt = await page.evaluate(() =>
    document.querySelector('[data-testid="registered-freshness"]')?.textContent ?? "");
  eq("the page states when the mirror last synced", /last synced/i.test(txt), true);
  eq("  …and says a newer signup is not here yet", /not here yet/i.test(txt), true);
  eq("  …and offers a refresh", await page.locator('[data-testid="registered-refresh"]').count() > 0, true);
  const r = await api("?page=1&size=1");
  eq("  …from a real timestamp, not a placeholder", typeof r.body.syncedAt === "string" && r.body.syncedAt.length > 10, true);
}

// ── 7. WHAT NEEDS THE WARSAW ACCOUNT ───────────────────────────────────────────────────────────
console.log("\n── needs a confined session ──");
skip("a confined account naming another city is refused",
     "the Warsaw account does not exist yet — assertScope is unit-tested in city-confinement-test");
skip("a confined account's list is its city with no ?city= param",
     "same — the scoping code above is the identical path, exercised via ?city=WAW");

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  " + f)); }
await closeContext(ctx);
await closeBrowser(browser);
process.exit(FAIL === 0 ? 0 : 1);
