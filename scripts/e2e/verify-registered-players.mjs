// REGISTERED PLAYERS — the table under Player Lookup's search.
//
// WHAT THIS SUITE CAN AND CANNOT PROVE TODAY. The Warsaw ACCOUNT does not exist yet, so the
// confined path is exercised the only honest way available: an unconfined account calling the same
// endpoint with ?city=WAW runs the identical scoping code — the union, the basis split, the count.
// What that CANNOT prove is the refusal a confined account gets when it names another city, because
// there is no confined session to make the call. Those assertions are named at the end and skipped
// out loud rather than quietly omitted.
//
// ONE RULE: preferable_city_name. The roster half is gone and the counts are why — it added 11
// rows to Warsaw's 1 and every one was a placeholder (Guest 1-7, NYCSC x3, Manager, all on
// 5555555555, all registered to Atlanta or New York) parked on Warsaw matches to fill them.
// Warsaw is 1 real signup. Every figure below is derived from the mirror at run time.
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
const CITY_NAME = "Warsaw";
const { data: regRows, error: rErr } = await svc
  .from("mdapi_users").select("id, first_name").eq("preferable_city_name", CITY_NAME).neq("is_fake_player", true);
if (rErr) throw new Error(rErr.message);
const EXPECT_IDS = new Set(regRows.map((r) => Number(r.id)));
const EXPECT_TOTAL = EXPECT_IDS.size;

// THE PLACEHOLDERS THE ROSTER RULE USED TO DRAG IN — asserted ABSENT by id, not by count. Without
// this the suite would pass on a route that quietly kept the union and simply returned more rows.
const { data: wawMatches } = await svc
  .from("mdapi_matches").select("api_id").eq("city_identifier", "WAW");
const { data: rosterRows } = await svc
  .from("mdapi_match_players").select("user_id")
  .in("match_api_id", (wawMatches ?? []).map((m) => m.api_id));
const ROSTER_ONLY = [...new Set((rosterRows ?? []).map((r) => Number(r.user_id)))]
  .filter((id) => !EXPECT_IDS.has(id));

const { count: EXPECT_ALL } = await svc
  .from("mdapi_users").select("id", { count: "exact", head: true }).neq("is_fake_player", true);
const { data: fakeRow } = await svc.from("mdapi_users").select("id").eq("is_fake_player", true).limit(1);
const KNOWN_FAKE = Number(fakeRow?.[0]?.id ?? 0);
const { data: outsider } = await svc
  .from("mdapi_users").select("id").eq("preferable_city_name", "Austin").neq("is_fake_player", true).limit(1);
const KNOWN_NON_WARSAW = Number(outsider?.[0]?.id ?? 0);

console.log(`\nfrom the mirror: ${CITY_NAME} signups ${EXPECT_TOTAL} · roster-only placeholders ${ROSTER_ONLY.length} (must be absent)`);
console.log(`  all-cities total ${EXPECT_ALL}`);

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
  eq("the total is the signup count", r.body.total, EXPECT_TOTAL);
  eq("  …and equals the rows it can actually show", r.body.total, r.body.players.length);
  eq("no basis column survives", r.body.players.every((p) => p.basis === undefined), true);
  eq("no split is reported", r.body.basisCounts, undefined);
  console.log(`     ${r.body.total} signups: ${r.body.players.map((p) => `${p.id} ${p.name ?? "—"}`).join(", ")}`);

  // EVERY ROW IS A SIGNUP IN THIS CITY.
  const offenders = r.body.players.filter((p) => !EXPECT_IDS.has(p.id));
  eq("every row is a signup in the city", offenders.map((p) => p.id), []);

  // THE PLACEHOLDERS ARE GONE — by id, and the control proves there were some to lose.
  eq(`  control — the roster rule used to add ${ROSTER_ONLY.length} rows`, ROSTER_ONLY.length > 0, true);
  const stillThere = r.body.players.filter((p) => ROSTER_ONLY.includes(p.id));
  eq("no roster-only placeholder is in the list", stillThere.map((p) => p.id), []);

  // A KNOWN NON-WARSAW PLAYER IS ABSENT — by id, not by count.
  eq(`  control — a known non-Warsaw player id was found (${KNOWN_NON_WARSAW})`, KNOWN_NON_WARSAW > 0, true);
  eq("a known non-Warsaw player is absent", r.body.players.some((p) => p.id === KNOWN_NON_WARSAW), false);

  // FAKE PLAYERS ARE ABSENT, asserted by a known id rather than by trusting the filter.
  eq(`  control — a known fake player id was found (${KNOWN_FAKE})`, KNOWN_FAKE > 0, true);
  eq("a known fake player is absent", r.body.players.some((p) => p.id === KNOWN_FAKE), false);
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
  eq("  …and reports no basis split at all — the field is gone, not null", r.body.basisCounts, undefined);
  eq("a page is a page, not the whole table", r.body.players.length, 10);
  console.log(`     ${r.body.total} players across all cities vs ${EXPECT_TOTAL} in ${CITY}`);
}

// ── 5. NAMING A CITY ───────────────────────────────────────────────────────────────────────────
console.log("\n── naming a city ──");
{
  const bad1 = await api("?city=NOPE");
  eq("an unknown city is refused, not widened back to everyone", bad1.status, 400);
  // A LARGE CITY NOW WORKS. With the roster walk gone there is no match-by-match loop and no
  // ceiling: this is a single .eq() with SQL paging, so Austin behaves exactly as Warsaw does.
  // It used to 501 above 400 matches, and Austin has 6,614.
  const big = await api("?city=ATX&page=1&size=5");
  eq("a large city is served, not refused", big.status, 200);
  eq("  …with a real total", big.body.total > 1000, true);
  eq("  …and a page, not the whole city", big.body.players.length, 5);
  eq("  …and it is a different city from Warsaw", big.body.total !== EXPECT_TOTAL, true);
  console.log(`     ATX: ${big.body.total.toLocaleString()} signups, page of ${big.body.players.length}`);
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
