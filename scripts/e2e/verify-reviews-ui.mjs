// Phase 26c — the Reviews COMMENTS panel: readable emails, three filters, group-by-match.
// Hermetic: mdapi_reviews / review_replies / mdapi_users / fin_sync_log are all fixtured, so the
// five gates assert behaviour rather than whatever production happens to hold today.
//   node scripts/e2e/verify-reviews-ui.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const REVIEWS = `${BASE}/match-ops/reviews`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// ── fixture ──────────────────────────────────────────────────────────────────
// Local wall-clock strings: useReviewData parses start_date as local, and the comments panel's
// default window is "this week", so everything sits a day or two back.
const pad = (n) => String(n).padStart(2, "0");
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const daysAgo = (n, h) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h, 0, 0, 0); return d; };

// The email that motivated this work: long enough to have been ellipsised at 180px.
const LONG_EMAIL = "mickeymaloney23.longaddress@gmail.com";

// THE COMMENTS PANEL DEFAULTS TO THE CURRENT MONDAY–SUNDAY WEEK.
//
// `cwin` opens on "week", and reviewsDerive.commentWindow("week") resolves that to
// monday(today) .. monday(today)+6 — a CALENDAR week, not a rolling seven days. The fixture used
// to sit at `daysAgo(1)` and `daysAgo(2)`, which asserted that "1 and 2 days ago" is always inside
// "this week". THAT WAS NEVER TRUE:
//
//   Wed–Sun  both rows land inside the week            → green
//   Tue      the 2-days-ago row is last Sunday          → 4 comment rows, NOT REVIEWED reads 3
//   Mon      BOTH rows are last week                    → 0 rows, and open() times out waiting
//            for data-s="done" on a table that rendered nothing
//
// It went red on Monday 2026-08-17 for exactly that reason, having been latently broken every
// Monday and Tuesday since it was written. Nothing in the page changed; the fixture aged into a
// weekday it could not survive.
//
// So the rows are now anchored INSIDE the current week: take the day we want, and clamp it
// forward to Monday if it would fall into the previous week. A stays strictly newer than B on
// every weekday (on Mon/Tue they share a date and are separated by the hour), which is what
// gate 4b's "newest match first" depends on.
//
// The hour can sit later than the clock on a Monday. That is immaterial here — commentWindow
// compares DATES at midnight, and nothing on this path filters a review for being in the future.
const mondayOf = (d) => {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Sun=0 → 6 days back, Mon=1 → 0
  x.setHours(0, 0, 0, 0);
  return x;
};
const thisWeek = (backDays, h) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const want = new Date(today); want.setDate(want.getDate() - backDays);
  const d = want < mondayOf(today) ? mondayOf(today) : want;
  d.setHours(h, 0, 0, 0);
  return d;
};

const A_START = local(thisWeek(1, 20)); // Crossbar — the newer match, 4 reviews
const B_START = local(thisWeek(2, 19)); // Hattrick — older, 2 reviews
const REV = (id, field, start, stars, email, comment) => ({
  api_id: id, city_name: "Austin", field_title: field,
  manager_first_name: "Troy", manager_last_name: "M", star_rating: stars,
  start_date: start, user_id: 900 + id, updated_at_rating: start,
  comment, user_first_name: "Player", user_last_name: String(id),
  user_email: email, tags_rating: [],
});
// Match A: 1,2,2,2 -> avg 1.75, all four owed a reply. Match B: 3 (owed) + 5 (praise).
const REVIEWS_FIXTURE = [
  REV(1, "Crossbar", A_START, 1, LONG_EMAIL, "started 25 minutes late"),
  REV(2, "Crossbar", A_START, 2, "b@example.com", "late start again"),
  REV(3, "Crossbar", A_START, 2, "c@example.com", "kick off was very late"),
  REV(4, "Crossbar", A_START, 2, "d@example.com", "no lights on half the pitch"),
  REV(5, "Hattrick", B_START, 3, "e@example.com", "teams were unbalanced"),
  REV(6, "Hattrick", B_START, 5, "f@example.com", "great game, well run"),
];
// One of the owed rows is already resolved, so NOT REVIEWED (4) differs from the raw owed set (5).
// That difference is the point of gate 3 — a hardcoded count would pass the wrong number.
const REPLIES_FIXTURE = [{ review_id: 2, replied_at: new Date().toISOString(), replied_by: "rmancuso@playmatchday.com", kind: "replied", note: null }];
const OWED = REVIEWS_FIXTURE.filter((r) => r.star_rating <= 3);
const RESOLVED = new Set(REPLIES_FIXTURE.map((r) => r.review_id));
const EXPECT_NOT_REVIEWED = OWED.filter((r) => !RESOLVED.has(r.api_id)).length; // 4
const EXPECT_ALL = REVIEWS_FIXTURE.length;                                      // 6

async function routes(ctx) {
  const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await ctx.route("**/rest/v1/**", (r) => json(r, []));
  await ctx.route("**/rest/v1/mdapi_reviews*", (r) => json(r, REVIEWS_FIXTURE));
  await ctx.route("**/rest/v1/review_replies*", (r) => (r.request().method() === "GET" ? json(r, REPLIES_FIXTURE) : json(r, [])));
  // app_users must reach the REAL table — the client access check reads it, and a blanket [] would
  // bounce the page to /login?error=not_authorized.
  await ctx.route("**/rest/v1/app_users*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    return route.fulfill({ status: res.status(), contentType: "application/json", body: await res.text() });
  });
  // Phase 29: the page now reads /api/reviews (scoped SERVER-side) instead of paginating
  // mdapi_reviews into the browser. Registered AFTER the catch-all so it wins, and it serves the
  // SAME fixture — this suite's subject is the UI, and the scoping itself is asserted in
  // scripts/reviews-scope-test.ts where it can be tested without a browser.
  await ctx.route(/\/api\//, (r) => json(r, {}));
  await ctx.route("**/api/reviews*", (r) => json(r, {
    scope: null, scopeName: null, isAdmin: true, rows: REVIEWS_FIXTURE,
    counts: { total: REVIEWS_FIXTURE.length, rated: REVIEWS_FIXTURE.length, withComment: 0, withoutComment: 0, averageStars: null, byCity: [] },
  }));
}

const rowCount = (page) => page.$$eval('.rv-ctab tbody tr', (trs) => trs.filter((t) => !t.hasAttribute("data-testid")).length);

async function open(page) {
  await page.goto(REVIEWS, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-rv="sev-all"]', { timeout: 25000 });
  await page.waitForFunction(() => document.querySelectorAll('.rv-ctab tbody tr').length > 0, null, { timeout: 15000 });
  // WAIT FOR review_replies TO LAND. The rows render as soon as the reviews arrive, but the
  // resolution marks are a SECOND fetch — until it resolves, every owed review still looks
  // unresolved and the NOT REVIEWED chip reads 5 instead of 4. Reading the chip before this point
  // is a race that passes locally and fails under a full-gate run (it did). The resolved row paints
  // data-s="done", so that attribute IS the signal that the marks are in.
  await page.waitForSelector('.rv-ctab tbody tr [data-s="done"]', { timeout: 15000 });
}

// THE FIXTURE MUST BE INSIDE THE WINDOW IT DEPENDS ON. Without this, a fixture that drifts out
// again surfaces as "waitForSelector timeout" — which reads as a slow page and sent the last
// investigation looking at the dev server, the network and three unrelated commits. It is a
// harness precondition, so it fails LOUDLY and by name.
function assertFixtureInWindow() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const a = mondayOf(today);
  const b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6);
  const dayOf = (iso) => { const p = iso.slice(0, 10).split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const out = [["A_START", A_START], ["B_START", B_START]].filter(([, iso]) => {
    const d = dayOf(iso);
    return d < a || d > b;
  });
  if (out.length) {
    const w = `${a.toDateString()} .. ${b.toDateString()}`;
    throw new Error(
      `FIXTURE OUT OF WINDOW: ${out.map(([n, iso]) => `${n}=${iso.slice(0, 10)}`).join(", ")} ` +
      `falls outside the comments panel's default week (${w}). The page is fine; the fixture drifted.`,
    );
  }
  // A newer than B is what gate 4b's "newest match first" rests on.
  if (!(A_START > B_START)) throw new Error(`FIXTURE ORDER: A_START ${A_START} must be newer than B_START ${B_START}`);
}

async function main() {
  assertFixtureInWindow();
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState });
    await routes(ctx);
    const page = await ctx.newPage();
    await open(page);

    // ── GATE 1 — the long email renders in full, wrapped, no ellipsis, selectable ──
    eq("gate1: a long email renders in full, WRAPS (no ellipsis / no clipping), and is selectable",
      await page.evaluate((email) => {
        const el = [...document.querySelectorAll('[data-testid="review-email"]')].find((e) => e.textContent.trim() === email);
        if (!el) return { found: false };
        const cs = getComputedStyle(el);
        const oneLine = parseFloat(cs.lineHeight) || 16;
        return {
          found: true,
          full: el.textContent.trim() === email,       // nothing dropped
          ellipsis: cs.textOverflow === "ellipsis",     // must be false
          nowrap: cs.whiteSpace.includes("nowrap"),     // must be false
          clipped: el.scrollWidth > el.clientWidth + 1, // must be false — wrapped, not cut
          wrapped: el.getBoundingClientRect().height > oneLine * 1.4, // actually took 2+ lines
          selectable: cs.userSelect !== "none" && cs.webkitUserSelect !== "none",
        };
      }, LONG_EMAIL),
      { found: true, full: true, ellipsis: false, nowrap: false, clipped: false, wrapped: true, selectable: true });

    // ── GATE 2 — exactly three filters, none labelled "Unanswered" ──
    eq("gate2: exactly THREE severity filters render, and nothing is labelled 'Unanswered'", {
      count: await page.$$eval('[data-rv^="sev-"]', (b) => b.length),
      labels: await page.$$eval('[data-rv^="sev-"]', (b) => b.map((x) => x.textContent.replace(/\s*\d+\s*$/, "").trim())),
      unanswered: (await page.content()).includes(">Unanswered"),
      needsAReply: (await page.content()).includes("Needs a reply"),
    }, { count: 3, labels: ["All", "Not reviewed", "Praise"], unanswered: false, needsAReply: false });

    // ── GATE 3 — the NOT REVIEWED count equals the rows in that state, from the data ──
    const chip = await page.$eval('[data-rv="sev-notreviewed"]', (e) => Number(e.textContent.replace(/\D+/g, "")));
    await page.click('[data-rv="sev-notreviewed"]');
    await page.waitForTimeout(400);
    eq("gate3: the NOT REVIEWED count matches the rows it renders, and both match the fixture", {
      chip, rows: await rowCount(page), fromData: EXPECT_NOT_REVIEWED,
    }, { chip: EXPECT_NOT_REVIEWED, rows: EXPECT_NOT_REVIEWED, fromData: EXPECT_NOT_REVIEWED });
    // it is genuinely narrower than "everything owed a reply" — a resolved row is excluded
    eq("gate3b: NOT REVIEWED excludes the already-resolved row (it is not just the <=3★ set)",
      { notReviewed: EXPECT_NOT_REVIEWED, owed: OWED.length }, { notReviewed: 4, owed: 5 });

    // ── GATE 4 — by-match: contiguous rows, and a header whose count matches them ──
    await page.click('[data-rv="sev-all"]');
    await page.click('[data-rv="sort-match"]');
    await page.waitForTimeout(500);
    eq("gate4: with the match sort on, each group has a header and its count matches the rows beneath",
      await page.$$eval('.rv-ctab tbody tr', (trs) => {
        const groups = []; let cur = null;
        for (const tr of trs) {
          if (tr.getAttribute("data-testid") === "match-group-header") {
            cur = { key: tr.getAttribute("data-key"), declared: Number(tr.getAttribute("data-count")), actual: 0 };
            groups.push(cur);
          } else if (cur) cur.actual++;
        }
        return {
          groups: groups.length,
          headerMatchesRows: groups.every((g) => g.declared === g.actual),
          // contiguity: a key must never reappear after another group started
          keysUnique: new Set(groups.map((g) => g.key)).size === groups.length,
          counts: groups.map((g) => g.actual),
        };
      }),
      { groups: 2, headerMatchesRows: true, keysUnique: true, counts: [4, 2] });
    // the header states the average for that match, and the newer match sorts first
    eq("gate4b: the group header carries the match average, newest match first",
      await page.$$eval('[data-testid="match-group-header"]', (hs) => hs.map((h) => h.innerText.replace(/\s+/g, " ").trim())).then((t) => ({
        first: t[0].includes("Crossbar") && t[0].includes("avg 1.8"),
        second: t[1].includes("Hattrick") && t[1].includes("avg 4.0"),
      })), { first: true, second: true });
    // and the default sort is still the old one
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-rv="sort-recent"]', { timeout: 20000 });
    eq("gate4c: 'Newest first' is still the DEFAULT sort (by-match is opt-in)",
      await page.$$eval('[data-testid="match-group-header"]', (h) => h.length), 0);

    // ── GATE 5 — layout at 1600 and 390 ──
    const layout = async (w) => {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(350);
      return page.evaluate(() => {
        const de = document.documentElement;
        // a mobile-only block leaking at desktop, by COMPUTED display (not the hidden attribute)
        const leaking = [...document.querySelectorAll('[class*="min-\\[900px\\]:hidden"], [class*="lg:hidden"]')]
          .filter((e) => getComputedStyle(e).display !== "none").length;
        return { overflow: de.scrollWidth - de.clientWidth, leaking };
      });
    };
    const at1600 = await layout(1600);
    eq("gate5a: no horizontal overflow at 1600 and no mobile-only block showing (computed display)", at1600, { overflow: 0, leaking: 0 });
    const at390 = await layout(390);
    eq("gate5b: no horizontal overflow at 390", { overflow: at390.overflow }, { overflow: 0 });

    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log(fails.map((f) => `  ✗ ${f}`).join("\n")); process.exit(1); }
}

main().catch(fatal);
