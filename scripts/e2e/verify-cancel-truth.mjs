// A PLAYER CANCELLED, THEN WE CANCELLED. THE ROW ONLY SAID WE DID.
//
// Ryan, on player 90289, Ann Richards, Sep 12: "this guy cancelled, but then I guess we cancelled
// and he's asking about credit. The player lookup should show he cancelled also but its not which
// would confuse someone working customer service."
//
// Three faults, not one:
//   1. mirrorHistory threw the player's cancellation away ("the club's cancellation outranks the
//      player's") — true about the MATCH, wrong about the row in HIS history.
//   2. playerProfile had the OPPOSITE precedence, so which fact the operator saw depended on which
//      row survived the merge. That is the deeper one.
//   3. A mirror-only row printed $0.00 while the Stripe block below it showed $25.98 SUCCEEDED.
//
// NOTHING IS WRITTEN. The real player is read; the other states are synthesised by rewriting the
// lookup response on the way past, which is a READ-side fixture.
//
//   node scripts/e2e/verify-cancel-truth.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PLAYER = 90289;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

const READ = () => {
  const q = (s) => document.querySelector(s);
  const rows = [...document.querySelectorAll('[data-testid="match-history"] .mrow')];
  const vw = document.documentElement.clientWidth;
  return {
    vw,
    hscroll: document.documentElement.scrollWidth > vw + 2,
    rows: rows.map((r) => {
      const st = r.querySelector(".st");
      const name = r.querySelector(".l1");
      return {
        state: st?.dataset.state ?? null,
        badge: st?.textContent.trim() ?? null,
        badgeBg: st ? getComputedStyle(st).backgroundColor : null,
        badgeClipped: st ? st.scrollWidth > st.clientWidth + 1 : false,
        name: name?.textContent.trim() ?? null,
        nameW: Math.round(name?.getBoundingClientRect().width ?? 0),
        cancel: r.querySelector('[data-testid="mrow-cancel"]')?.textContent.replace(/\s+/g, " ").trim() ?? null,
        charge: r.querySelector('[data-testid="mrow-charge"]')?.textContent.trim() ?? null,
        h: Math.round(r.getBoundingClientRect().height),
        /* TWO LINES means the badge sits BELOW the name's row, not beside it. */
        twoLine: (() => { const n = r.querySelector(".l1"), s2 = r.querySelector(".st");
          return n && s2 ? s2.getBoundingClientRect().top >= n.getBoundingClientRect().bottom - 1 : null; })(),
      };
    }),
    chips: [...document.querySelectorAll('[data-testid="match-history"] button')]
      .map((b) => b.textContent.replace(/\s+/g, " ").trim()).filter((t) => /^(All|Upcoming|Played|No.show|Cancelled)/i.test(t)),
  };
};

/* ── THE SYNTHETIC STATES ──────────────────────────────────────────────────────────────────────
 * The lookup response is rewritten on the way past so the four states, and the three timing edge
 * cases, can be asserted from one real player. Nothing is written and production is not touched. */
async function boot(browser, storageState, width, mutate) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: 950 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });
  const writes = [];
  await ctx.route("**/api/lookup/**", async (route) => {
    const m = route.request().method();
    if (m !== "GET" && m !== "HEAD") { writes.push(m); return route.fulfill({ status: 204, body: "" }); }
    if (!mutate) return route.fallback();
    const res = await route.fetch();
    const j = await res.json().catch(() => null);
    if (!j || !Array.isArray(j.matches)) return route.fulfill({ response: res });
    mutate(j);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(`${BASE}/match-ops/player-lookup?id=${PLAYER}`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await p.waitForSelector('[data-testid="match-history"]', { timeout: 120000 });
  await p.waitForTimeout(2200);
  return { ctx, p, writes, errs };
}

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  /* THE RAW FACTS THIS SUITE LEANS ON, read once and printed, so a failure says whether the app or
   * the data moved. */
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const bookings = nonEmpty(
    (await sb.from("mdapi_match_players").select("match_api_id,is_cancelled,canceled_at,amount,total_amount").eq("user_id", PLAYER)).data ?? [],
    `bookings for player ${PLAYER}`,
  );
  const matchId = bookings[0].match_api_id;
  const match = nonEmpty(
    (await sb.from("mdapi_matches").select("api_id,name,is_cancelled,start_date,start_date_utc").eq("api_id", matchId)).data ?? [],
    `mirror row for match ${matchId}`,
  )[0];
  const canceledAt = nonEmpty(bookings.filter((b) => b.canceled_at), "bookings with canceled_at")[0].canceled_at;
  const offsetMs = Date.parse(match.start_date) - Date.parse(match.start_date_utc);
  const wantHours = Math.round(((Date.parse(match.start_date_utc) - Date.parse(canceledAt)) / 3600e3) * 10) / 10;
  const wantClock = new Date(Date.parse(canceledAt) + offsetMs).toISOString();
  console.log(`\nplayer ${PLAYER} · match ${matchId} "${match.name}"`);
  console.log(`  canceled_at RAW        ${canceledAt}`);
  console.log(`  kickoff wall / instant ${match.start_date} / ${match.start_date_utc}`);
  console.log(`  venue offset           ${offsetMs / 3600e3}h`);
  console.log(`  so: ${wantHours}h before kickoff, pitch clock ${wantClock}`);
  console.log(`  match.is_cancelled=${match.is_cancelled}  player cancelled on ${bookings.filter((b) => b.is_cancelled).length} of ${bookings.length} bookings`);
  yes("  CONTROL: the data really is both-cancelled", match.is_cancelled === true && bookings.some((b) => b.is_cancelled === true));

  // ══ 1, 1c, 4, 6. THE REAL ROW ═════════════════════════════════════════════════════════════
  {
    const { ctx, p, writes, errs } = await boot(browser, storageState, 900, null);
    console.log("\n-- player 90289, as it stands --");
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  nothing written", writes, []);
    const row = nonEmpty(d.rows, "match rows")[0];
    is("  the row reads BOTH CANCELLED", row.badge, "BOTH CANCELLED");
    is("  and carries the state", row.state, "both_cancelled");
    // 1. THE HOURS AND THE CLOCK.
    yes(`  with the hours to kickoff: "${row.cancel}"`,
      new RegExp(`${wantHours}h before kickoff`).test(row.cancel ?? ""));
    yes("  hours FIRST, clock second", /^They cancelled \d/.test(row.cancel ?? ""));
    // 1c. THE CLOCK IS THE PITCH'S.
    const pitchHour = new Date(Date.parse(wantClock)).getUTCHours();
    const pitch12 = ((pitchHour + 11) % 12) + 1;
    yes(`  and the PITCH clock (${pitch12}${pitchHour >= 12 ? " PM" : " AM"}), not raw UTC`,
      new RegExp(`${pitch12}:\\d\\d ${pitchHour >= 12 ? "PM" : "AM"}`).test(row.cancel ?? ""));
    const rawHour = new Date(Date.parse(canceledAt)).getUTCHours();
    const raw12 = ((rawHour + 11) % 12) + 1;
    is(`  CONTROL: and NOT the raw UTC hour (${raw12}${rawHour >= 12 ? " PM" : " AM"}), which is ${Math.abs(offsetMs / 3600e3)}h out`,
      raw12 !== pitch12 ? new RegExp(`\\b${raw12}:\\d\\d ${rawHour >= 12 ? "PM" : "AM"}`).test(row.cancel ?? "") : false, false);
    // 4. THE PRICE.
    yes(`  an unknown price prints as unknown: "${row.charge}"`, /not in the mirror/.test(row.charge ?? ""));
    is("  CONTROL: and never as $0.00", /\$0\.00/.test(row.charge ?? ""), false);
    // 6. THE BUCKET.
    yes(`  the Cancelled chip still counts it: "${d.chips.find((c) => /Cancelled/i.test(c))}"`,
      /Cancelled\s*1\b/.test(d.chips.find((c) => /Cancelled/i.test(c)) ?? ""));
    // 7. NO CLAIM ABOUT ORDER.
    is("  CONTROL: the row never claims who cancelled first",
      /(first|before we|after we|we cancelled first|they cancelled first)/i.test(row.cancel ?? ""), false);
    is("  CONTROL: no em-dash in the line", /—/.test(row.cancel ?? ""), false);
    await closeContext(ctx);
  }

  // ══ 1b, 2. THE FOUR STATES, AND THE TIMING EDGE CASES ═════════════════════════════════════
  {
    /* ONE RESPONSE CARRYING ALL FOUR STATES, so their colours are compared in one paint. */
    const mutate = (j) => {
      const base = j.matches[0];
      const mk = (over) => ({ ...base, ...over });
      const kickoff = match.start_date_utc;
      const wall = match.start_date;
      const minus = (h) => new Date(Date.parse(kickoff) - h * 3600e3).toISOString();
      j.matches = [
        mk({ matchId: 900001, name: "Both", playerCancelled: true, clubCancelled: true,
          state: "both_cancelled", playerCancelledAt: minus(25.8), startDate: wall, startDateUtc: kickoff, price: null }),
        mk({ matchId: 900002, name: "Player only", playerCancelled: true, clubCancelled: false,
          state: "player_cancelled", playerCancelledAt: minus(1.5), startDate: wall, startDateUtc: kickoff, price: 2400 }),
        mk({ matchId: 900003, name: "Club only", playerCancelled: false, clubCancelled: true,
          state: "club_cancelled", playerCancelledAt: null, startDate: wall, startDateUtc: kickoff, price: null }),
        mk({ matchId: 900004, name: "Played", playerCancelled: false, clubCancelled: false,
          state: "played", playerCancelledAt: null, startDate: wall, startDateUtc: kickoff, price: 2400, userStatus: null }),
        mk({ matchId: 900005, name: "After kickoff", playerCancelled: true, clubCancelled: false,
          state: "player_cancelled", playerCancelledAt: minus(-2.1), startDate: wall, startDateUtc: kickoff, price: null }),
        mk({ matchId: 900006, name: "No timestamp", playerCancelled: true, clubCancelled: false,
          state: "player_cancelled", playerCancelledAt: null, startDate: wall, startDateUtc: kickoff, price: null }),
      ];
    };
    const { ctx, p, errs } = await boot(browser, storageState, 900, mutate);
    console.log("\n-- the four states and the timing edges --");
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    const by = Object.fromEntries(d.rows.map((r) => [r.name, r]));
    yes(`  CONTROL: all six synthetic rows rendered (${d.rows.length})`, d.rows.length === 6);
    // 2. FOUR DISTINGUISHABLE STATES.
    is("  BOTH reads Both cancelled", by["Both"].badge, "BOTH CANCELLED");
    is("  player-only reads They cancelled", by["Player only"].badge, "THEY CANCELLED");
    is("  club-only reads We cancelled", by["Club only"].badge, "WE CANCELLED");
    is("  played reads Played", by["Played"].badge, "PLAYED");
    const bgs = ["Both", "Player only", "Club only", "Played"].map((k) => by[k].badgeBg);
    is(`  CONTROL: all four differ in colour (${bgs.join(" / ")})`, new Set(bgs).size, 4);
    yes("  CONTROL: and BOTH is not WE CANCELLED's colour", by["Both"].badgeBg !== by["Club only"].badgeBg);
    yes("  CONTROL: nor THEY CANCELLED's", by["Both"].badgeBg !== by["Player only"].badgeBg);
    // 1b. THE HOURS, INCLUDING A 90-MINUTE CANCEL.
    yes(`  a cancel 90 minutes out reads as 1.5h: "${by["Player only"].cancel}"`,
      /1\.5h before kickoff/.test(by["Player only"].cancel ?? ""));
    is("  CONTROL: and not as a date alone", /^They cancelled [A-Z]/.test(by["Player only"].cancel ?? ""), false);
    yes(`  a cancel AFTER kickoff reads as after: "${by["After kickoff"].cancel}"`,
      /2\.1h after kickoff/.test(by["After kickoff"].cancel ?? ""));
    is("  CONTROL: never as a negative number", /-\d/.test(by["After kickoff"].cancel ?? ""), false);
    // 1c CONTROL: no timestamp.
    yes(`  a cancel with no timestamp says so: "${by["No timestamp"].cancel}"`,
      /time not recorded in the mirror/i.test(by["No timestamp"].cancel ?? ""));
    is("  CONTROL: and never renders 0h", /\b0h\b/.test(by["No timestamp"].cancel ?? ""), false);
    is("  CONTROL: nor NaN", /NaN/.test(by["No timestamp"].cancel ?? ""), false);
    // A row nobody cancelled carries no line at all.
    is("  CONTROL: a club-only row carries no cancellation line", by["Club only"].cancel, null);
    is("  CONTROL: nor does a played row", by["Played"].cancel, null);
    // 4 CONTROL: a known price still prints.
    yes(`  CONTROL: a row whose price we DO have still prints it ("${by["Player only"].charge}")`,
      /\$24\.00|\$/.test(by["Player only"].charge ?? "") && !/not in the mirror/.test(by["Player only"].charge ?? ""));
    is("  and an unknown one does not", /not in the mirror/.test(by["Both"].charge ?? ""), true);
    await closeContext(ctx);
  }

  // ══ 8. A PHONE ════════════════════════════════════════════════════════════════════════════
  for (const w of [390, 900]) {
    const { ctx, p, errs } = await boot(browser, storageState, w, null);
    console.log(`\n-- ${w}px --`);
    const d = await p.evaluate(READ);
    is("  no page error", errs, []);
    is("  no horizontal scroll", d.hscroll, false);
    const rows = nonEmpty(d.rows, `match rows at ${w}`);
    yes(`  no row is taller than 120px (${Math.max(...rows.map((r) => r.h))}px)`, rows.every((r) => r.h <= 120));
    yes(`  the match name gets at least 150px (${Math.min(...rows.map((r) => r.nameW))}px)`,
      rows.every((r) => r.nameW >= 150));
    /* GUARDED: "nothing is clipped" is zero, and a page with no rows prints the same zero. */
    is("  no badge is clipped",
      nonEmpty(rows, `rows at ${w}`).filter((r) => r.badgeClipped).map((r) => r.badge), []);
    if (w === 390) {
      is("  the row is two lines, badge below the name", rows[0].twoLine, true);
    } else {
      is("  CONTROL: and one line where there is room", rows[0].twoLine, false);
    }
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\ncancel-truth: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  XX ${f}`); process.exit(1); }
}

main().catch(fatal);
