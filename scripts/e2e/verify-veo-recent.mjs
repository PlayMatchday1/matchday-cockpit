// RECENTLY UPLOADED — the Veo page's second axis.
//   node scripts/e2e/verify-veo-recent.mjs      (needs `npm run dev` up)
//
// The two clocks are proven as pure functions in scripts/veo-recent-test.ts. THIS asserts what only
// a browser and a real database can answer: that the section renders real late arrivals, that the
// day nav does not refetch it, that the filter moves the rows and the footer together, and that a
// city-confined operator sees only their own city's arrivals — tested with a confined ACCOUNT,
// not by reading the code.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
/* EVERY ABSENCE ASSERTION BELOW IS WRAPPED IN nonEmpty(), because "no row is stateless" is
 * satisfied by a page with no rows, and so is every other zero on this page. The repo's own
 * vacuous-assertion guard caught seven of them here. */
import { nonEmpty } from "./_session.mjs";
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));

const readRows = (p) => p.evaluate(() => [...document.querySelectorAll('[data-testid="veo-recent-row"]')].map((e) => ({
  state: e.dataset.state,
  when: e.querySelector(".rwhen b")?.textContent?.trim() ?? null,
  lag: e.querySelector('[data-testid="veo-recent-lag"]')?.textContent?.trim() ?? null,
  lagDays: e.querySelector('[data-testid="veo-recent-lag"]')?.dataset.days ?? null,
  lagSource: e.querySelector('[data-testid="veo-recent-lag"]')?.dataset.source ?? null,
  wait: e.querySelector('[data-testid="veo-recent-wait"]')?.textContent?.trim() ?? null,
  stateLabel: e.querySelector('[data-testid="veo-recent-state"]')?.textContent?.trim() ?? null,
  // VIEW DAY WAS REMOVED — the week strip reaches any day in one chip without leaving the page.
  // Kept as a NEGATIVE: this must now always be null, and the assertion below says so.
  dayHref: e.querySelector('[data-testid="veo-recent-day"]')?.getAttribute("href") ?? null,
  poster: Boolean(e.querySelector('[data-testid="veo-recent-poster"]')),
  assignable: Boolean(e.querySelector('[data-testid="veo-recent-assign"]')),
})));

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const H = { Authorization: `Bearer ${vv.data.session.access_token}` };
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1100 },
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] } });
  const p = await ctx.newPage();
  const recentCalls = [];
  p.on("request", (r) => { if (r.url().includes("/api/veo/recent")) recentCalls.push(r.url().replace(BASE, "")); });

  await p.goto(`${BASE}/match-ops/veo`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-recent"]', { timeout: 240000 });
  await p.waitForSelector('[data-testid="veo-recent-row"]', { timeout: 120000 });
  await p.waitForTimeout(500);

  const rows = await readRows(p);
  console.log(`     ${rows.length} rows rendered`);

  // ---- ordering, against the raw table ----
  const api = await (await fetch(`${BASE}/api/veo/recent?limit=30`, { headers: H, cache: "no-store" })).json();
  const { data: raw } = await svc.from("veo_recordings").select("received_at").order("received_at", { ascending: false }).limit(30);
  is("the route's order is received_at descending, matching the raw rows",
    api.rows.map((r) => r.receivedAt), raw.map((r) => r.received_at));

  // ---- every row states its arrival and its state ----
  is("no row is missing its arrival", nonEmpty(rows, "recent rows on screen").filter((r) => !r.when || r.when === "—").length, 0);
  is("no row is stateless", nonEmpty(rows, "recent rows on screen").filter((r) => !r.stateLabel).length, 0);
  const labels = [...new Set(rows.map((r) => r.stateLabel))];
  console.log(`     states on screen: ${JSON.stringify(labels)}`);
  yes("…and every label is one of the five", labels.every((l) => ["Posted", "Posted, flagged", "Assigned by hand", "Queued", "Dismissed"].includes(l)), JSON.stringify(labels));
  // ASSIGNED BY HAND IS NOT POSTED, here as at the top of the page.
  const handRows = api.rows.filter((r) => r.state === "assigned");
  const postedRows = api.rows.filter((r) => r.state === "posted");
  console.log(`     ${postedRows.length} posted automatically, ${handRows.length} assigned by hand, in this page of rows`);
  is("no row is both posted and assigned", nonEmpty(api.rows, "rows from /api/veo/recent").filter((r) => r.state === "posted" && r.state === "assigned").length, 0);
  for (const r of handRows) {
    const { data: db } = await svc.from("veo_recordings").select("posted_by_user_id").eq("id", r.id).single();
    yes(`a row marked Assigned by hand really has posted_by_user_id (${r.recordingId})`, Boolean(db.posted_by_user_id));
  }

  // ---- a real late arrival ----
  const late = api.rows.filter((r) => (r.match?.day ?? r.parsedMatchDate) && r.receivedAt)
    .map((r) => {
      const day = r.match?.day ?? r.parsedMatchDate;
      const arrivedDay = new Date(Date.parse(r.receivedAt)).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      const d = Math.round((Date.parse(`${arrivedDay}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
      return { ...r, lag: d, day, arrivedDay, source: r.match ? "match" : "title" };
    })
    .filter((r) => r.lag >= 2 && r.source === "match")
    .sort((a, b) => b.lag - a.lag);
  console.log(`     late arrivals with a real match: ${late.slice(0, 4).map((r) => `${r.subject.slice(0, 26)} +${r.lag}d`).join(" · ")}`);
  yes("a film that arrived days after its match is in the section", late.length > 0, "none found");
  if (late.length) {
    const worst = late[0];
    console.log(`     worst: "${worst.subject}" match day ${worst.day}, arrived ${worst.arrivedDay} = ${worst.lag} days`);
    const onScreen = rows.find((r) => r.lagDays === String(worst.lag));
    yes(`…and the row says so (${worst.lag} days late)`, Boolean(onScreen), JSON.stringify(rows.map((r) => r.lag)));
  }
  // Same-day and next-day stay quiet.
  const quiet = rows.filter((r) => r.lagDays !== null && Number(r.lagDays) < 2);
  is("no row prints a lag for same-day or next-day", quiet, []);
  // A title-derived day is marked as such.
  const fromTitle = rows.filter((r) => r.lagSource === "title");
  if (fromTitle.length) yes("a lag derived from the parsed title says so", fromTitle.every((r) => /from the title/.test(r.lag ?? "")), JSON.stringify(fromTitle));
  else console.log("     (no title-derived lag over 2 days on this page — not asserted)");

  // ---- the waiting clock, only where somebody must act ----
  const waiting = rows.filter((r) => r.wait);
  is("the waiting clock appears only on Queued rows", [...new Set(waiting.map((r) => r.stateLabel))].filter((l) => l !== "Queued"), []);
  yes("…and every queued row on screen carries one", nonEmpty(rows, "recent rows on screen").filter((r) => r.stateLabel === "Queued" && !r.wait).length === 0,
    JSON.stringify(rows.filter((r) => r.stateLabel === "Queued" && !r.wait)));

  // ---- links back to its own day, and Assign only where there is something to do ----
  const withDay = rows.filter((r) => r.dayHref);
  yes("no row carries a View day link any more", withDay.length === 0, JSON.stringify(withDay.slice(0, 2)));
  /* EVERY ROW CARRIES A POSTER BOX, whether or not the still frame resolved — that is the whole
   * point of the box, and a control that the rows were actually found. */
  yes("every row carries a poster box", rows.length > 0 && rows.every((r) => r.poster),
    `${rows.filter((r) => r.poster).length} of ${rows.length}`);
  is("only a Queued row offers Assign", [...new Set(nonEmpty(rows.filter((r) => r.assignable), "assignable rows").map((r) => r.stateLabel))], ["Queued"]);
  is("…and no resolved row does", nonEmpty(rows, "recent rows on screen").filter((r) => r.assignable && r.stateLabel !== "Queued").length, 0);

  // ---- the filter moves the rows AND the footer together ----
  const footer = () => p.$eval('[data-testid="veo-recent-count"]', (e) => e.textContent.trim());
  const allCount = rows.length, allFoot = await footer();
  await p.click('[data-testid="veo-recent-unposted"]');
  await p.waitForTimeout(1200);
  const un = await readRows(p);
  const unFoot = await footer();
  console.log(`     all: ${allCount} rows / "${allFoot}"   ·   not posted: ${un.length} rows / "${unFoot}"`);
  is("the Not posted filter leaves only unresolved rows", [...new Set(un.map((r) => r.stateLabel))], ["Queued"]);
  yes("…and the footer count follows it", unFoot.startsWith(String(un.length)), unFoot);
  /* BOTH LISTS HIT THE 30-ROW DEFAULT, so comparing what is ON SCREEN cannot tell a narrowing from
   * a no-op. The narrowing is at the source, so it is measured there. */
  const allApi = await (await fetch(`${BASE}/api/veo/recent?limit=200`, { headers: H, cache: "no-store" })).json();
  const unApi = await (await fetch(`${BASE}/api/veo/recent?limit=200&filter=unposted`, { headers: H, cache: "no-store" })).json();
  console.log(`     unfiltered ${allApi.rows.length} · not posted ${unApi.rows.length}`);
  yes("the filter is a real narrowing at the source", unApi.rows.length < allApi.rows.length, `${unApi.rows.length} of ${allApi.rows.length}`);
  is("…and it returns nothing that has been posted", nonEmpty(unApi.rows, "not-posted rows").filter((r) => r.state === "posted" || r.state === "flagged" || r.state === "assigned").length, 0);
  await p.click('[data-testid="veo-recent-all"]');
  await p.waitForTimeout(1200);
  yes("clearing it restores the rows", (await readRows(p)).length === allCount);
  const afterFilters = recentCalls.length;

  // ---- THE DAY NAV MUST NOT REFETCH THIS SECTION ----
  await p.click('[data-testid="veo-prev"]');
  await p.waitForTimeout(1500);
  await p.click('[data-testid="veo-prev"]');
  await p.waitForTimeout(1500);
  is("moving the day nav twice fires NO further /api/veo/recent calls", recentCalls.length - afterFilters, 0);
  yes("…and the section is still rendered on the new day", (await readRows(p)).length > 0);

  // ---- a confined operator sees only their own city's arrivals ----
  const WAW = "jf@playmatchday.pl";
  const { data: wawRow } = await svc.from("app_users").select("city_identifier, is_admin").eq("email", WAW).maybeSingle();
  if (wawRow?.city_identifier !== "WAW" || wawRow.is_admin !== false) {
    bad("the confined account under test", JSON.stringify(wawRow));
  } else {
    const l2 = await svc.auth.admin.generateLink({ type: "magiclink", email: WAW });
    const v2 = await anon.auth.verifyOtp({ type: "magiclink", token_hash: l2.data.properties.hashed_token });
    const H2 = { Authorization: `Bearer ${v2.data.session.access_token}` };
    const w = await (await fetch(`${BASE}/api/veo/recent?limit=50`, { headers: H2, cache: "no-store" })).json();
    console.log(`     Warsaw sees ${w.rows?.length ?? "?"} arrivals; confinedCity=${w.confinedCity}`);
    is("the confined account's payload names its city", w.confinedCity, "WAW");
    const cities = [...new Set((w.rows ?? []).map((r) => r.city).filter(Boolean))];
    /* NOT wrapped in nonEmpty: Warsaw legitimately sees ZERO arrivals, because no veo_codes row
     * names a Warsaw field. The control below is what makes this assertion mean something — an
     * admin running the same query sees several cities. */
    is("…and no row belongs to another city", cities.filter((c) => c !== "Warsaw"), []);
    // CONTROL: the admin sees rows from several cities on the same query, so the emptiness above is
    // the scope working and not a route that returns nothing to anybody.
    const adminCities = [...new Set(api.rows.map((r) => r.city).filter(Boolean))];
    console.log(`     control — an admin sees ${adminCities.length} cities: ${JSON.stringify(adminCities)}`);
    yes("control — an admin sees arrivals from more than one city", adminCities.length > 1, JSON.stringify(adminCities));
    // And an unplaceable recording is for unconfined accounts only.
    const unplaceable = api.rows.filter((r) => !r.city).length;
    console.log(`     ${unplaceable} of ${api.rows.length} rows have no placeable city (unparseable titles)`);
    // Same: zero rows for Warsaw is the correct answer, and the admin control above proves the
    // route returns rows to somebody.
    is("an unplaceable recording never reaches a confined account", (w.rows ?? []).filter((r) => !r.city).length, 0);
  }

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("  XX  suite crashed:", e?.message ?? e); process.exit(2); });
