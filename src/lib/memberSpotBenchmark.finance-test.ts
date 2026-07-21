// Guards for the Match P&L member-spot benchmark denominator.
//
// The benchmark values every MEMBER fill at
//   cityMembershipRevenueFor(city, benchMonth) / memberSpots(city, benchMonth)
// so the numerator and denominator MUST describe the same calendar month,
// and the denominator MUST be complete for it. Four independent failures
// had compounded here; each test below pins one of them.
//
// Run: npx tsx --test src/lib/memberSpotBenchmark.finance-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  benchmarkMonthFetchBounds,
  coversBenchmarkMonth,
  mostRecentCompletedMonth,
} from "./quarters";
import {
  hasMembershipAtMatchTime,
  type MembershipWindowsByUserId,
} from "./mdapiMatchesRead";
import { isFakePlayerRow } from "./mdapiFakePlayer";
import {
  buildMdapiMemberSpotIndex,
  findStaleProjectionRevenue,
} from "./financeStats";
import type { FinRevenue } from "./useFinanceData";

// ---------------------------------------------------------------
// 1. Coverage guard: the fetch window must span the WHOLE benchmark
//    month, so the denominator month matches the numerator month.
//
// Regression: the quarter window (quarter.start − 14d) clipped the
// benchmark month to its last two weeks at the top of a quarter. Q3
// 2026 opened covering only Jun 17–30, cutting the Dallas denominator
// from 23 spots to 5 and inflating $/spot from $28.52 to $131.18.
// ---------------------------------------------------------------

const QUARTER_BUFFER_DAYS = 14;
function quarterBoundsAt(now: Date): { fromDate: string; toDate: string } {
  const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
  const start = new Date(now.getFullYear(), qStartMonth, 1);
  const end = new Date(now.getFullYear(), qStartMonth + 3, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    fromDate: iso(new Date(start.getTime() - QUARTER_BUFFER_DAYS * 86400_000)),
    toDate: iso(new Date(end.getTime() + QUARTER_BUFFER_DAYS * 86400_000)),
  };
}

test("benchmark bounds span the full previous calendar month", () => {
  // Mid-quarter.
  const b = benchmarkMonthFetchBounds(new Date(2026, 6, 20)); // Jul 2026
  assert.equal(b.fromDate, "2026-06-01");
  assert.equal(b.toDate, "2026-06-30");

  // Year boundary — January's benchmark is the previous December.
  const jan = benchmarkMonthFetchBounds(new Date(2026, 0, 5));
  assert.equal(jan.fromDate, "2025-12-01");
  assert.equal(jan.toDate, "2025-12-31");

  // February leap-year end.
  const mar = benchmarkMonthFetchBounds(new Date(2028, 2, 3));
  assert.equal(mar.fromDate, "2028-02-01");
  assert.equal(mar.toDate, "2028-02-29");
});

test("coverage guard rejects a quarter window that clips the benchmark month", () => {
  // The exact shipped failure: 2026-07-20 sits in Q3, whose padded
  // window starts 2026-06-17 and misses Jun 1–16.
  const shipped = new Date(2026, 6, 20);
  assert.equal(
    coversBenchmarkMonth(quarterBoundsAt(shipped), shipped),
    false,
    "Q3 window must be reported as NOT covering June — otherwise the targeted benchmark fetch is skipped and the denominator stays partial",
  );

  // A window that does span the month is accepted, so the redundant
  // second fetch is skipped.
  assert.equal(
    coversBenchmarkMonth({ fromDate: "2026-06-01", toDate: "2026-07-31" }, shipped),
    true,
  );
});

test("coverage guard holds at every quarter boundary in a year", () => {
  // First day of each quarter is the worst case: the padded window
  // reaches back only 14 days into the benchmark month.
  for (const month of [0, 3, 6, 9]) {
    const firstOfQuarter = new Date(2026, month, 1);
    const bounds = quarterBoundsAt(firstOfQuarter);
    const bench = benchmarkMonthFetchBounds(firstOfQuarter);
    if (!coversBenchmarkMonth(bounds, firstOfQuarter)) continue; // targeted fetch kicks in — fine
    assert.ok(
      bounds.fromDate <= bench.fromDate,
      `quarter starting month ${month}: window ${bounds.fromDate} claims to cover ${bench.fromDate} but does not`,
    );
  }
});

// ---------------------------------------------------------------
// 2. Membership is decided by the activation → cancel WINDOW around
//    the match, never by the subscription's status today.
//
// Regression: loading only status='ACTIVE' discarded ~84% of
// mdapi_subscriptions (2056 CANCELED vs 391 ACTIVE) and erased every
// member who played in the benchmark month and cancelled afterwards.
// ---------------------------------------------------------------

const MATCH_UTC = "2026-06-09T00:00:00+00:00";

function windows(
  entries: Array<[string, string, string | null]>,
): MembershipWindowsByUserId {
  const m: MembershipWindowsByUserId = new Map();
  for (const [userId, activation_date, canceled_at] of entries) {
    const list = m.get(userId) ?? [];
    list.push({ activation_date, canceled_at });
    m.set(userId, list);
  }
  return m;
}

test("member who cancelled AFTER the match still counts for that match", () => {
  // The dominant real-world case: subscription reads CANCELED today,
  // but the cancellation postdates the match.
  const subs = windows([["501", "2026-01-06T20:34:35Z", "2026-06-23T23:01:35Z"]]);
  assert.equal(hasMembershipAtMatchTime("501", MATCH_UTC, subs), true);
});

test("member who cancelled BEFORE the match does not count", () => {
  const subs = windows([["502", "2025-11-30T01:53:15Z", "2026-05-15T16:58:25Z"]]);
  assert.equal(hasMembershipAtMatchTime("502", MATCH_UTC, subs), false);
});

test("subscription activated after the match does not count", () => {
  const subs = windows([["503", "2026-07-01T00:00:00Z", null]]);
  assert.equal(hasMembershipAtMatchTime("503", MATCH_UTC, subs), false);
});

test("open-ended subscription activated before the match counts", () => {
  const subs = windows([["504", "2025-11-19T00:00:00Z", null]]);
  assert.equal(hasMembershipAtMatchTime("504", MATCH_UTC, subs), true);
});

test("cancel-and-resubscribe: only the window covering the match counts", () => {
  const subs = windows([
    ["505", "2025-01-01T00:00:00Z", "2026-02-01T00:00:00Z"], // ended before
    ["505", "2026-07-01T00:00:00Z", null], // began after
  ]);
  assert.equal(hasMembershipAtMatchTime("505", MATCH_UTC, subs), false);

  const covering = windows([
    ["506", "2025-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
    ["506", "2026-05-01T00:00:00Z", null], // straddles the match
  ]);
  assert.equal(hasMembershipAtMatchTime("506", MATCH_UTC, covering), true);
});

test("unknown user and null id are not members", () => {
  const subs = windows([["507", "2025-01-01T00:00:00Z", null]]);
  assert.equal(hasMembershipAtMatchTime("999", MATCH_UTC, subs), false);
  assert.equal(hasMembershipAtMatchTime(null, MATCH_UTC, subs), false);
  assert.equal(hasMembershipAtMatchTime("", MATCH_UTC, subs), false);
});

test("user_id is compared as an identity, not coerced loosely", () => {
  const subs = windows([["508", "2025-01-01T00:00:00Z", null]]);
  // Numeric and string forms of the same id must agree.
  assert.equal(hasMembershipAtMatchTime(508, MATCH_UTC, subs), true);
  assert.equal(hasMembershipAtMatchTime("508", MATCH_UTC, subs), true);
});

// ---------------------------------------------------------------
// 3. Membership windows compare against the TRUE instant.
//
// Regression: mdapi_matches.start_date is wall-clock wearing a
// "+00:00" suffix, so comparing it against genuine-UTC subscription
// timestamps ran 4–5h early (each city's DST offset) and dropped
// members who activated in that nightly gap. Two of Dallas's 23 June
// member spots were lost this way.
// ---------------------------------------------------------------

test("membership activated between wall-clock time and true instant still counts", () => {
  // Real case: uid 80552. Match wall-clock 2026-06-09T19:00 "+00:00",
  // true instant 2026-06-10T00:00Z. Subscription activated 22:06Z —
  // AFTER the mislabelled wall-clock stamp, BEFORE actual kickoff.
  const subs = windows([["80552", "2026-06-09T22:06:46.828+00:00", null]]);

  const wallClockStamp = "2026-06-09T19:00:00+00:00";
  const trueInstant = "2026-06-10T00:00:00+00:00";

  assert.equal(
    hasMembershipAtMatchTime("80552", trueInstant, subs),
    true,
    "must count as a member — activation precedes real kickoff",
  );
  assert.equal(
    hasMembershipAtMatchTime("80552", wallClockStamp, subs),
    false,
    "sanity check: the wall-clock stamp is what produced the wrong answer",
  );
});

test("cancellation inside the wall-clock/true-instant gap is respected", () => {
  // Mirror direction: cancelling before the wall-clock stamp but after
  // it would still be a non-member either way; cancelling between the
  // two stamps must exclude, since the cancel precedes real kickoff.
  const subs = windows([
    ["601", "2026-01-01T00:00:00Z", "2026-06-09T22:00:00+00:00"],
  ]);
  assert.equal(
    hasMembershipAtMatchTime("601", "2026-06-10T00:00:00+00:00", subs),
    false,
  );
});

test("unparseable timestamps never silently count as membership", () => {
  const subs = windows([["602", "not-a-date", null]]);
  assert.equal(hasMembershipAtMatchTime("602", MATCH_UTC, subs), false);

  const ok = windows([["603", "2025-01-01T00:00:00Z", null]]);
  assert.equal(hasMembershipAtMatchTime("603", "not-a-date", ok), false);
});

// ---------------------------------------------------------------
// 4. Fake-player exclusion regression guard.
//
// 314 of Dallas's 378 raw June FREE rows are synthetic fills. They are
// already dropped in mapJoinedRow; this pins the predicate so the
// exclusion cannot quietly regress, and re-pins the @playmatchday.com
// staff-domain trap.
// ---------------------------------------------------------------

test("fake players are detected by boolean OR @matchday.com email", () => {
  assert.equal(isFakePlayerRow({ user_is_fake_player: true, user_email: "a@b.com" }), true);
  assert.equal(isFakePlayerRow({ user_is_fake_player: null, user_email: "59@matchday.com" }), true);
  assert.equal(isFakePlayerRow({ user_is_fake_player: false, user_email: "114@MatchDay.com" }), true);
});

test("@playmatchday.com staff are NOT fake players", () => {
  // The trap: a substring check on "matchday.com" would match the
  // company's own staff domain and wrongly delete real attendance.
  assert.equal(
    isFakePlayerRow({ user_is_fake_player: null, user_email: "rmancuso@playmatchday.com" }),
    false,
  );
  assert.equal(isFakePlayerRow({ user_is_fake_player: null, user_email: "real@gmail.com" }), false);
  assert.equal(isFakePlayerRow({ user_is_fake_player: null, user_email: null }), false);
});

test("fake-player MEMBER rows never reach the city-month denominator", () => {
  // buildMdapiMemberSpotIndex trusts upstream filtering, so this
  // asserts the contract end-to-end: rows that survive to the index
  // are the ones that count, and a fake must not be among them.
  const venues = [
    {
      id: 1,
      venue_name: "Bicentennial Park",
      raw_venue_name: "Bicentennial Park",
      city: "Dallas",
      cost_per_match: 100,
    },
  ];
  const venueFields = new Map<number, number>([[900, 1]]);
  const base = {
    field: "Bicentennial Park",
    field_id: 900,
    match_api_id: 1,
    max_player_count: 20,
    match_start: "2026-06-09T19:00:00",
    match_start_utc: "2026-06-10T00:00:00+00:00",
    match_canceled: false,
    player_canceled_at: null,
    promocode: null,
    match_price_paid: 0,
    credit_paid: 0,
    user_type: "PLAYER",
  };

  const index = buildMdapiMemberSpotIndex(
    [
      { ...base, user_id: "1", email: "real@gmail.com", payment_type: "MEMBER" },
      { ...base, user_id: "2", email: "real2@gmail.com", payment_type: "MEMBER" },
    ],
    venues,
    venueFields,
  );
  assert.equal(index.byCityMonth.get("Dallas|Jun 2026")?.member, 2);

  // GUEST phantom seats and cancelled matches stay excluded too.
  const filtered = buildMdapiMemberSpotIndex(
    [
      { ...base, user_id: "1", email: "real@gmail.com", payment_type: "MEMBER" },
      { ...base, user_id: "3", email: "g@gmail.com", payment_type: "MEMBER", user_type: "GUEST" },
      { ...base, user_id: "4", email: "c@gmail.com", payment_type: "MEMBER", match_canceled: true },
      {
        ...base,
        user_id: "5",
        email: "x@gmail.com",
        payment_type: "MEMBER",
        player_canceled_at: "2026-06-08T17:25:18",
      },
    ],
    venues,
    venueFields,
  );
  assert.equal(
    filtered.byCityMonth.get("Dallas|Jun 2026")?.member,
    1,
    "guests, cancelled matches and withdrawn players must not inflate the denominator",
  );
});

// ---------------------------------------------------------------
// 5. Denominator month must equal numerator month.
// ---------------------------------------------------------------

test("index buckets by the match's own calendar month", () => {
  const venues = [
    {
      id: 1,
      venue_name: "V",
      raw_venue_name: "V",
      city: "Dallas",
      cost_per_match: 100,
    },
  ];
  const venueFields = new Map<number, number>([[900, 1]]);
  const row = (match_start: string, user_id: string) => ({
    field: "V",
    field_id: 900,
    match_api_id: 1,
    max_player_count: 20,
    match_start,
    match_start_utc: match_start,
    match_canceled: false,
    player_canceled_at: null,
    payment_type: "MEMBER",
    promocode: null,
    match_price_paid: 0,
    credit_paid: 0,
    user_type: "PLAYER",
    user_id,
    email: `${user_id}@x.com`,
  });

  const index = buildMdapiMemberSpotIndex(
    [
      row("2026-05-31T19:00:00", "1"),
      row("2026-06-01T19:00:00", "2"),
      row("2026-06-30T19:00:00", "3"),
      row("2026-07-01T19:00:00", "4"),
    ],
    venues,
    venueFields,
  );

  // June must hold exactly its own two matches — no bleed from the
  // adjacent months that the padded fetch window also pulls in.
  assert.equal(index.byCityMonth.get("Dallas|Jun 2026")?.member, 2);
  assert.equal(index.byCityMonth.get("Dallas|May 2026")?.member, 1);
  assert.equal(index.byCityMonth.get("Dallas|Jul 2026")?.member, 1);
});

// ---------------------------------------------------------------
// 6. Stale-projection guard.
//
// PROJECTION rows are "replace with actuals" placeholders. Every other
// read path drops them for completed months, but the benchmark
// NUMERATOR (cityMembershipRevenueFor) does not filter by source — so
// one left in a completed month and tagged to a real city would
// silently inflate that city's $/spot rate.
// ---------------------------------------------------------------

function revRow(over: Partial<FinRevenue>): FinRevenue {
  return {
    id: 1,
    date: "2026-06-30",
    month: "Jun 2026",
    city: "Dallas",
    venue: null,
    type: "Membership",
    gross: 0,
    fees: 0,
    net: 100,
    source: "Stripe",
    notes: null,
    manual_entry: false,
    ...over,
  };
}

const NOW = new Date(2026, 6, 20); // 2026-07-20; Jun 2026 is completed

test("stale PROJECTION rows in completed months are flagged", () => {
  // The real shipped rows: a $20,130.02 placeholder for Jun 2026.
  const rows = [
    revRow({ id: 65, source: "PROJECTION", net: 20130.02, city: "Deleted Account Revenue" }),
    revRow({ id: 66, source: "PROJECTION", net: 18692.16, month: "May 2026", city: "Deleted Account Revenue" }),
    revRow({ id: 10244, source: "Stripe", net: 69.6 }),
  ];
  const stale = findStaleProjectionRevenue(rows, NOW);
  assert.equal(stale.length, 2);
  assert.deepEqual(
    stale.map((r) => r.id).sort((a, b) => a - b),
    [65, 66],
  );
});

test("PROJECTION rows for FUTURE months are legitimate, not stale", () => {
  const rows = [
    revRow({ id: 70, source: "PROJECTION", month: "Aug 2026" }),
    revRow({ id: 71, source: "PROJECTION", month: "Sep 2026" }),
  ];
  assert.deepEqual(findStaleProjectionRevenue(rows, NOW), []);
});

test("a stale PROJECTION on a REAL city is what the guard exists to catch", () => {
  // Today all stale rows sit on the "Deleted Account Revenue"
  // pseudo-city, which has no matches, so no benchmark is touched.
  // Retagging one to a real city is the silent-corruption path.
  const rows = [
    revRow({ id: 80, source: "PROJECTION", city: "Deleted Account Revenue" }),
    revRow({ id: 81, source: "PROJECTION", city: "Dallas", net: 20000 }),
  ];
  const stale = findStaleProjectionRevenue(rows, NOW);
  assert.equal(stale.length, 2);

  const onRealCity = stale.filter((r) => r.city !== "Deleted Account Revenue");
  assert.equal(onRealCity.length, 1);
  assert.equal(
    onRealCity[0].city,
    "Dallas",
    "a PROJECTION row on a real city inflates that city's benchmark numerator with placeholder money",
  );
});

test("current month is not yet completed, so its PROJECTION row is not stale", () => {
  // July 2026 is in progress on 2026-07-20 — its projection row is
  // still doing its job.
  const rows = [revRow({ id: 90, source: "PROJECTION", month: "Jul 2026" })];
  assert.deepEqual(findStaleProjectionRevenue(rows, NOW), []);
});

test("mostRecentCompletedMonth agrees with the fetch bounds it drives", () => {
  // The benchmark month key and the fetch window are derived
  // independently; if they ever disagree the numerator and denominator
  // describe different months.
  for (const d of [
    new Date(2026, 6, 20),
    new Date(2026, 0, 1),
    new Date(2026, 11, 31),
    new Date(2028, 2, 3),
  ]) {
    const bounds = benchmarkMonthFetchBounds(d);
    const key = mostRecentCompletedMonth(d).key;
    const [mon, yr] = key.split(" ");
    const monthIdx = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ].indexOf(mon);
    assert.equal(
      bounds.fromDate,
      `${yr}-${String(monthIdx + 1).padStart(2, "0")}-01`,
      `benchmark key ${key} disagrees with fetch bounds ${bounds.fromDate}`,
    );
  }
});
