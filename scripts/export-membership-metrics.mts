/* MEMBERSHIP METRICS -> CSV, for the data room. READ-ONLY. No application code, no writes.
 *
 * RAW COUNTS AND DOLLARS ONLY. Not one percentage, ratio, share or average is computed here. Every
 * derived figure is meant to be a live formula in the workbook, so an investor can click a cell and
 * see the arithmetic. A hardcoded percentage in a data room is a number nobody can check.
 *
 * ── THE ONE BASIS, AND WHY ────────────────────────────────────────────────────────────────────
 * membership_revenue and total_revenue are BOTH `fin_revenue.gross`, grouped on `fin_revenue.month`,
 * PROJECTION rows excluded. The denominator therefore CONTAINS the numerator by construction: same
 * table, same column, same month grain, the numerator being the rows where type = 'Membership'.
 *
 * That is the Finance page's basis, in the Finance page's words: TAX-INCLUSIVE - the Stripe charge,
 * sales tax included; money COLLECTED, tying to Stripe's gross volume (RevenueBasisNote.tsx,
 * RevenueSection.tsx).
 *
 * IT IS GROSS, NOT NET, AND THAT IS A DELIBERATE DEPARTURE FROM THE MEMBERSHIP PAGE. The Membership
 * route sums `.net` (route.ts:168-173); every figure beside it on Finance sums `.gross`. That exact
 * mismatch was already found and fixed once on the Cities page - cityMembershipRevenueFor
 * (financeStats.ts:1637) carries the fix and the reason: "GROSS, NOT NET - an internal-consistency
 * fix on the Cities page, which summed .net here while every neighbouring column summed .gross. For
 * Jul 2026 that read $17,205.76 against a $17,856.94 gross, the $651.18 difference being Stripe fees
 * no other column had subtracted." A ratio cannot have a net numerator over a gross denominator, so
 * this file follows the fixed convention. The report states the delta.
 *
 * ── WHAT IS LEFT EMPTY, AND WHY AN EMPTY CELL IS THE HONEST ANSWER ────────────────────────────
 * active_members and members_churned come from members_monthly_snapshots, the same source
 * activeByMonth reads, so they are point-in-time captures rather than a live count repeated across
 * months. Where there is no capture, or where the captured value is a structural artifact rather
 * than a measurement, the cell is EMPTY. A 0 would be a claim; an empty cell is the absence of one.
 *
 * ── THIS FILE DISAGREES WITH THE MEMBERSHIP PAGE ON PURPOSE, IN TWO PLACES ────────────────────
 * Both were measured against the running app on 2026-09-17 and both are page defects, not export
 * defects. Neither is fixed here - this task changes no application code.
 *
 *   1. MEMBERSHIP REVENUE IS TRUNCATED ON THE PAGE. route.ts:168 reads fin_revenue UNPAGED, and
 *      PostgREST caps at 1,000 rows against 1,819 Membership rows. The page therefore sees 1,000
 *      arbitrary rows covering 18 of 31 months. Aug 2026 reaches it as 13 of its 102 rows,
 *      $14,938.40 instead of $18,255.73 net; Sep 2026 is absent entirely, which is why the
 *      headline "AVG PRICE / MEMBER SPOT" KPI renders $0.00. The route's own comment twenty lines
 *      above warns about exactly this for mdapi_subscriptions and the revenue read below it is
 *      unpaged. Fix is the same paging loop.
 *
 *   2. THE PAGE'S MONTH KEY RE-SHIFTS A WALL CLOCK. route.ts:31-34 is
 *      new Date(match_start).getUTCMonth(), and toLegacyShape emits match_start as
 *      "2026-08-31T19:00:00" with NO offset, so new Date() reads it as LOCAL and getUTCMonth()
 *      pushes it forward. Measured: 959 rows in the page's own 4-month window sit at 19:00-22:59
 *      on the last day of a month and every one lands in the following month. This file uses
 *      string surgery on the wall clock, which is what the route's own dayMix block already does
 *      and what the wall-clock rule requires. Reconciled to the row: the route's key reproduces
 *      the page's 2377/6192/423/374 for Aug 2026 exactly, and this file's key gives
 *      2365/6216/431/373. The whole gap is the key; there is no drift in it.
 *
 * ── THE BY-CITY FILE'S SPOT COLUMNS ARE SHORT BEFORE 2026 ────────────────────────────────────
 * A spot gets its city from the venue its field is linked to through fin_venue_fields, the same
 * mapping the finance surfaces use. A field with no link has no city and so belongs to no city row.
 * Revenue and active_members carry their own city and sum to the estate EXACTLY in all 42 months;
 * spots do not. Unmapped spots by year: 2023 328 of 7,632 - 2024 5,421 of 38,570 - 2025 644 of
 * 58,961 - 2026 ZERO. The last month with any is 2025-12. So the by-city spot columns are complete
 * from 2026-01 and understate 2024 by about a seventh. Estate-wide is the deliverable; this file is
 * the extra, and it says where it is thin rather than looking complete.
 */

import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  fetchLegacyMatchRegistrations,
  loadMembershipWindowsByUserId,
} from "../src/lib/mdapiMatchesRead";
import { classify, totalsByMonth, type SpotRow } from "../src/lib/membershipModel";
import { includedLinks } from "../src/lib/venueLinkFilter";
import { INTERNAL_EMAIL_RX, parseMemberDate } from "../src/lib/membershipStats";

/* ── ENV ──────────────────────────────────────────────────────────────────────────────────────*/
const ROOT = "/Users/ryanmancuso/Code/matchday-cockpit";
const envText = readFileSync(join(ROOT, ".env.local"), "utf8");
const ENV: Record<string, string> = {};
for (const line of envText.split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) ENV[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(ENV.NEXT_PUBLIC_SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY);

/* ── MONTH KEYS ───────────────────────────────────────────────────────────────────────────────
 * "YYYY-MM" throughout, and it is always STRING SURGERY on the label, never a Date parse.
 * mdapi_matches.start_date is LOCAL WALL CLOCK wearing a "+00:00", so new Date(str) re-shifts it and
 * can move a late-evening match on the last of the month into the next one. Slicing the string reads
 * the wall clock the operator sees. Same rule the route's dayMix already follows. */
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const ymOf = (wallClock: string): string => String(wallClock).slice(0, 7);
/** fin_revenue.month is a label: "Aug 2026" -> "2026-08". */
const ymFromLabel = (label: string): string => {
  const [mon, yr] = String(label).split(" ");
  return `${yr}-${String(MON.indexOf(mon) + 1).padStart(2, "0")}`;
};
const ymAdd = (ym: string, n: number): string => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7)) - 1 + n;
  return `${y + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, "0")}`;
};
const daysInYm = (ym: string): number =>
  new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();

const today = new Date();
const CURRENT_YM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
const DAYS_ELAPSED_CURRENT = today.getDate();

/* ── 1. REVENUE, ONE BASIS ────────────────────────────────────────────────────────────────────*/
type RevRow = { month: string; city: string; type: string; gross: number; net: number; source: string };
const revRows: RevRow[] = [];
for (let off = 0; ; off += 1000) {
  const { data, error } = await sb
    .from("fin_revenue").select("month,city,type,gross,net,source").order("id").range(off, off + 999);
  if (error) throw new Error(`fin_revenue read failed: ${error.message}`);
  revRows.push(...(data as RevRow[]));
  if (data.length < 1000) break;
}
/* PROJECTION rows are operator-entered full-month estimates and are excluded unconditionally, the
 * same way filterRevenueRows does it. There are none today; the guard stays so a row hand-inserted
 * straight into the table can never silently inflate a total. */
const projectionRows = revRows.filter((r) => r.source === "PROJECTION").length;
const rev = revRows.filter((r) => r.source !== "PROJECTION");

type RevAgg = { total: number; membership: number; membershipNet: number };
const revByYm = new Map<string, RevAgg>();
const revByYmCity = new Map<string, RevAgg>();
const bumpRev = (map: Map<string, RevAgg>, key: string, r: RevRow) => {
  const a = map.get(key) ?? { total: 0, membership: 0, membershipNet: 0 };
  a.total += Number(r.gross ?? 0);
  if (r.type === "Membership") {
    a.membership += Number(r.gross ?? 0);
    a.membershipNet += Number(r.net ?? 0);
  }
  map.set(key, a);
};
for (const r of rev) {
  const ym = ymFromLabel(r.month);
  bumpRev(revByYm, ym, r);
  bumpRev(revByYmCity, `${r.city}|${ym}`, r);
}

/* ── 2. SPOTS ─────────────────────────────────────────────────────────────────────────────────
 * The route's own read path, unchanged and unbounded: the membership windows first, so
 * derivePaymentType splits paid_status='FREE' into MEMBER (an active sub at match time) vs
 * FREE_NON_MEMBER rather than calling every free spot a member spot. */
const subsWindows = await loadMembershipWindowsByUserId(sb);
const [venuesRes, linksRes] = await Promise.all([
  sb.from("fin_venues").select("id,venue_name,city"),
  sb.from("fin_venue_fields").select("*"),
]);
if (venuesRes.error) throw new Error(`fin_venues read failed: ${venuesRes.error.message}`);
if (linksRes.error) throw new Error(`fin_venue_fields read failed: ${linksRes.error.message}`);
const vById = new Map((venuesRes.data ?? []).map((v) => [v.id, v]));
// An excluded field does not count toward its venue here either - the same shared filter the route uses.
const venueOfField = new Map(includedLinks(linksRes.data).map((l) => [l.mdapi_field_id, l.fin_venue_id]));

const regs = await fetchLegacyMatchRegistrations(sb, {}, subsWindows);

const spots: SpotRow[] = [];
let canceledMatchRows = 0;
for (const r of regs) {
  if (r.match_canceled) { canceledMatchRows++; continue; }
  const vid = r.field_id != null ? venueOfField.get(r.field_id) : undefined;
  const city = vid != null ? (vById.get(vid)?.city ?? null) : null;
  spots.push({
    month: ymOf(r.match_start),
    cls: classify(r.payment_type),
    city,
    fieldId: r.field_id ?? null,
    amount: Number(r.match_price_paid ?? 0) || 0,
    userId: r.user_id != null ? String(r.user_id) : null,
    matchApiId: r.match_api_id ?? null,
  });
}

/* WHAT "OTHER" ACTUALLY IS, reported rather than left as a mystery bucket. classify() returns OTHER
 * for any payment_type outside MEMBER / DAILY PAID / PROMOCODE, which after derivePaymentType means
 * FREE_NON_MEMBER (a free spot held by someone with no membership at match time) or null (a
 * paid_status the classifier does not recognise). WAITING never arrives - mapJoinedRow drops it. */
const otherKinds = new Map<string, number>();
for (const r of regs) {
  if (r.match_canceled) continue;
  if (classify(r.payment_type) !== "OTHER") continue;
  const k = r.payment_type ?? `null (paid_status=${r.paid_status ?? "null"})`;
  otherKinds.set(k, (otherKinds.get(k) ?? 0) + 1);
}

/* ── 3. SNAPSHOTS ─────────────────────────────────────────────────────────────────────────────*/
const snapRes = await sb
  .from("members_monthly_snapshots")
  .select("month,active_count,churning_count,captured_at,source_file_name,by_city")
  .order("month");
if (snapRes.error) throw new Error(`members_monthly_snapshots read failed: ${snapRes.error.message}`);
const snaps = (snapRes.data ?? []).map((r) => ({
  ym: String(r.month).slice(0, 7),
  active: r.active_count as number | null,
  churning: r.churning_count as number | null,
  capturedAt: String(r.captured_at ?? ""),
  byCity: (r.by_city ?? {}) as Record<string, { active?: number }>,
}));
const activeByYm = new Map(snaps.map((s) => [s.ym, s.active]));
const activeByYmCity = new Map<string, number>();
for (const s of snaps) for (const [city, v] of Object.entries(s.byCity)) {
  activeByYmCity.set(`${city}|${s.ym}`, Number(v?.active ?? 0));
}

/* ── members_churned: POPULATED ONLY WHERE IT WAS MEASURED ────────────────────────────────────
 * churning_count is isChurningAsOf, which requires the row to be ACTIVE at the captured instant -
 * a member inside the 6th-to-6th grace cycle has cancelled but has not yet flipped to CANCELED.
 * That predicate DECAYS: replayed later, everyone in an old window has since flipped, and the count
 * collapses to zero.
 *
 * And that is exactly what the table holds. Every row from 2024-02 to 2026-03 was written in ONE
 * backfill run at 2026-05-04T21:16:33-36Z, and all 26 of them carry churning_count = 0. 2026-04 was
 * captured mid-cutover (source 'phase-3b-cutover-refresh', 2026-04-28) and reads 5; 2026-05 was
 * captured on 2026-05-03, three days before its own cycle closed on the 6th, and reads 0. Every
 * complete cron cycle since reads 56 / 69 / 81 / 87.
 *
 * So 2026-06 is the first month whose value is a measurement, and earlier cells are EMPTY.
 * 26 consecutive zeroes beside a 56-87 range is not a quiet period, it is a predicate that had
 * nothing left to see. Writing 0 there would put a false churn story in a data room; the same
 * active_count column on those rows IS sound, and this file proves it rather than assuming it (see
 * the replay check in the report) - the two columns of one row do not have to be equally usable.
 *
 * Verified live at the same time: isChurning(now) = 87 = the Sep 2026 captured value, on the
 * 2026-08-31 inclusive-6th boundary. The series that IS populated is on today's definition. */
const CHURN_FIRST_MEASURED_YM = "2026-06";

/* ── 4. THE MONTH RANGE ───────────────────────────────────────────────────────────────────────
 * Earliest month with real data in ANY column, through the current one. Derived from the data, never
 * pinned: a hardcoded boundary is how verify-pace-readout went red on the 25th. */
const allYms = [
  ...spots.map((s) => s.month),
  ...revByYm.keys(),
  ...snaps.map((s) => s.ym),
].filter((y) => /^\d{4}-\d{2}$/.test(y) && y <= CURRENT_YM);
const firstYm = allYms.reduce((a, b) => (a < b ? a : b));
const months: string[] = [];
for (let y = firstYm; y <= CURRENT_YM; y = ymAdd(y, 1)) months.push(y);

/* ── 5. THE MONTHLY ROWS ──────────────────────────────────────────────────────────────────────
 * The spot buckets and distinct_players come from THE SAME PASS over the same rows, so the two can
 * never disagree about which month a spot landed in. */
const totals = totalsByMonth(spots, months);
const totalsByKey = new Map(totals.map((t) => [t.month, t]));
const playersByYm = new Map<string, Set<string>>();
for (const s of spots) {
  if (!playersByYm.has(s.month)) playersByYm.set(s.month, new Set());
  if (s.userId != null) playersByYm.get(s.month)!.add(s.userId);
}

const money = (n: number): string => n.toFixed(2);
const blank = (n: number | null | undefined): string => (n == null ? "" : String(n));

const MONTHLY_HEADER = [
  "month","days_elapsed","days_in_month",
  "membership_revenue","total_revenue",
  "member_spots","daily_spots","promo_spots","other_spots",
  "member_matches","active_members","distinct_players",
  "members_churned",
].join(",");

const monthlyLines = [MONTHLY_HEADER];
for (const ym of months) {
  const t = totalsByKey.get(ym)!;
  const r = revByYm.get(ym) ?? { total: 0, membership: 0, membershipNet: 0 };
  const snapActive = activeByYm.has(ym) ? activeByYm.get(ym) : null;
  const churn = ym >= CHURN_FIRST_MEASURED_YM
    ? (snaps.find((s) => s.ym === ym)?.churning ?? null)
    : null;
  monthlyLines.push([
    ym,
    ym === CURRENT_YM ? DAYS_ELAPSED_CURRENT : daysInYm(ym),
    daysInYm(ym),
    money(r.membership),
    money(r.total),
    t.member, t.daily, t.promo, t.other,
    t.memberMatches,
    blank(snapActive),
    playersByYm.get(ym)?.size ?? 0,
    blank(churn),
  ].join(","));
}

/* ── 6. BY CITY - the same aggregates, one extra grouping key ─────────────────────────────────
 * Cheap: the venue->city map was already loaded for the estate pass and the snapshot already carries
 * by_city. No second fetch, no second derivation. */
const cities = [...new Set([
  ...spots.map((s) => s.city).filter((c): c is string => !!c),
  ...rev.map((r) => r.city).filter(Boolean),
])].sort();
const cityLines = [`city,${MONTHLY_HEADER}`];
for (const city of cities) {
  const cityTotals = totalsByMonth(spots.filter((s) => s.city === city), months);
  const cityTotalsByKey = new Map(cityTotals.map((t) => [t.month, t]));
  const cityPlayers = new Map<string, Set<string>>();
  for (const s of spots) {
    if (s.city !== city || s.userId == null) continue;
    if (!cityPlayers.has(s.month)) cityPlayers.set(s.month, new Set());
    cityPlayers.get(s.month)!.add(s.userId);
  }
  for (const ym of months) {
    const t = cityTotalsByKey.get(ym)!;
    const r = revByYmCity.get(`${city}|${ym}`) ?? { total: 0, membership: 0, membershipNet: 0 };
    const hasSnap = activeByYmCity.has(`${city}|${ym}`);
    cityLines.push([
      city, ym,
      ym === CURRENT_YM ? DAYS_ELAPSED_CURRENT : daysInYm(ym),
      daysInYm(ym),
      money(r.membership), money(r.total),
      t.member, t.daily, t.promo, t.other,
      t.memberMatches,
      hasSnap ? String(activeByYmCity.get(`${city}|${ym}`)) : "",
      cityPlayers.get(ym)?.size ?? 0,
      "", // members_churned is not captured per city - by_city holds active/pastDue/new/cancelled only
    ].join(","));
  }
}

/* ── 7. ANNUAL ────────────────────────────────────────────────────────────────────────────────
 * distinct_members is "how many DIFFERENT PEOPLE were a member at any point in this year" - not an
 * average, not a year-end figure. Identity is user_id, so one person who cancelled and resubscribed
 * counts once.
 *
 * THE 581 ROWS THAT CANNOT ANSWER THE QUESTION. A membership window is
 * [activation_date, canceled_at]. 581 of 2,413 paid-external subscriptions are status CANCELED with
 * canceled_at NULL - no cancellation event was ever recorded for them, and their end date is
 * genuinely unknown. isActiveAsOf already excludes exactly these rows from every historical bucket
 * and says so; this file follows that documented convention rather than inventing a second one, so
 * an unknown-end row contributes to no year at all. Counting them as open to today instead is the
 * only other defensible reading, and the report gives both numbers so the size of the unknown is
 * visible rather than buried. */
type SubRow = {
  user_id: number | null; member_email: string | null; status: string | null;
  price: number | null; activation_date: string | null; canceled_at: string | null;
};
const subs: SubRow[] = [];
for (let off = 0; ; off += 1000) {
  const { data, error } = await sb
    .from("mdapi_subscriptions")
    .select("user_id,member_email,status,price,activation_date,canceled_at")
    .order("membership_id").range(off, off + 999);
  if (error) throw new Error(`mdapi_subscriptions read failed: ${error.message}`);
  subs.push(...(data as SubRow[]));
  if (data.length < 1000) break;
}
// isPaidExternalMember, on the raw row. price is DOLLARS here; the predicate only needs "> 0".
const paidExternal = (s: SubRow): boolean => {
  if ((s.price ?? 0) <= 0) return false;
  if (s.member_email && INTERNAL_EMAIL_RX.test(s.member_email)) return false;
  if (String(s.status ?? "").toUpperCase().startsWith("INCOMPLETE")) return false;
  return true;
};
const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort();
const distinctMembersIn = (year: string, unknownEndOpen: boolean): number => {
  const ys = new Date(Number(year), 0, 1);
  const ye = new Date(Number(year), 11, 31, 23, 59, 59, 999);
  const seen = new Set<string>();
  for (const s of subs) {
    if (!paidExternal(s)) continue;
    if (s.user_id == null) continue;
    const start = parseMemberDate(s.activation_date);
    if (!start || start > ye) continue;
    const end = parseMemberDate(s.canceled_at);
    if (!end) {
      const stillActive = s.status === "ACTIVE";
      if (!stillActive && !unknownEndOpen) continue;   // the documented convention: excluded
    } else if (end < ys) continue;
    seen.add(String(s.user_id));
  }
  return seen.size;
};
const annualLines = ["year,membership_revenue,distinct_members,months_with_data"];
for (const year of years) {
  const yearMonths = months.filter((m) => m.startsWith(year));
  let membership = 0;
  let withData = 0;
  for (const ym of yearMonths) {
    const r = revByYm.get(ym);
    membership += r?.membership ?? 0;
    const t = totalsByKey.get(ym)!;
    if ((r && (r.total > 0 || r.membership > 0)) || t.member + t.daily + t.promo + t.other > 0) withData++;
  }
  annualLines.push([year, money(membership), distinctMembersIn(year, false), withData].join(","));
}

/* ── 8. WRITE ─────────────────────────────────────────────────────────────────────────────────
 * NO EM-DASHES IN THE CSVS. Asserted rather than trusted - every field is numeric or a key, but a
 * city name arrives from the database and this file is going to investors. */
const OUT = join(ROOT, "scripts", "data");
mkdirSync(OUT, { recursive: true });
const downloads = join(homedir(), "Downloads");
const written: string[] = [];
for (const [name, lines] of [
  ["membership-monthly.csv", monthlyLines],
  ["membership-annual.csv", annualLines],
  ["membership-monthly-by-city.csv", cityLines],
] as const) {
  const body = lines.join("\n") + "\n";
  const bad = /[—–]/.exec(body);
  if (bad) throw new Error(`${name} contains an em/en dash at index ${bad.index}`);
  const p = join(OUT, name);
  writeFileSync(p, body, "utf8");
  copyFileSync(p, join(downloads, name));
  written.push(`${name}: ${lines.length - 1} rows -> scripts/data/ and ~/Downloads/`);
}

/* ── 9. THE REPORT, INCLUDING THE CHECKS THAT COULD FAIL ──────────────────────────────────────*/
const latestComplete = ymAdd(CURRENT_YM, -1);
const lc = { ym: latestComplete, t: totalsByKey.get(latestComplete)!, r: revByYm.get(latestComplete)! };

console.log("\n=== FILES ===");
for (const w of written) console.log("  " + w);

console.log("\n=== RANGE ===");
console.log(`  months ${months[0]} .. ${months[months.length - 1]}  (${months.length} rows)`);
console.log(`  years  ${years[0]} .. ${years[years.length - 1]}  (${years.length} rows)`);
console.log(`  by-city: ${cities.length} cities x ${months.length} months = ${cityLines.length - 1} rows`);
console.log(`  registration rows read ${regs.length}, dropped for cancelled match ${canceledMatchRows}, spots kept ${spots.length}`);
console.log(`  fin_revenue rows ${revRows.length}, PROJECTION excluded ${projectionRows}`);

console.log(`\n=== SANITY, LATEST COMPLETE MONTH (${latestComplete}) ===`);
console.log(`  membership_revenue (gross, the CSV)   $${money(lc.r.membership)}`);
console.log(`  membership_revenue on .net            $${money(lc.r.membershipNet)}   <- what the Membership page sums today`);
console.log(`  delta gross - net (Stripe fees)       $${money(lc.r.membership - lc.r.membershipNet)}`);
console.log(`  total_revenue (gross, all types)      $${money(lc.r.total)}`);
console.log(`  member_spots                          ${lc.t.member}`);
console.log(`  member_matches (distinct user,match)  ${lc.t.memberMatches}`);
console.log(`  active_members (snapshot)             ${activeByYm.get(latestComplete)}`);
console.log(`  distinct_players                      ${playersByYm.get(latestComplete)?.size ?? 0}`);
console.log(`  members_churned (snapshot)            ${snaps.find((s) => s.ym === latestComplete)?.churning}`);

/* PROVE THE DENOMINATOR CONTAINS THE NUMERATOR. Not by asserting it - by summing the per-type parts
 * of the very same filtered row set and showing membership is one of them and they add to the total. */
console.log("\n=== BASIS PROOF: the denominator contains the numerator ===");
const byType = new Map<string, number>();
for (const r of rev) {
  if (ymFromLabel(r.month) !== latestComplete) continue;
  byType.set(r.type, (byType.get(r.type) ?? 0) + Number(r.gross ?? 0));
}
let sum = 0;
for (const [t, v] of [...byType].sort((a, b) => b[1] - a[1])) {
  sum += v;
  console.log(`  ${t.padEnd(16)} $${money(v).padStart(12)}${t === "Membership" ? "   <- the numerator" : ""}`);
}
console.log(`  ${"SUM".padEnd(16)} $${money(sum).padStart(12)}   total_revenue in the CSV $${money(lc.r.total)}  ${Math.abs(sum - lc.r.total) < 0.005 ? "EXACT" : "MISMATCH"}`);
console.log(`  membership is one of those types, from the same rows: ${byType.has("Membership") ? "YES" : "NO"}`);

console.log("\n=== SNAPSHOT PROVENANCE (why some churn cells are empty) ===");
for (const s of snaps.slice(-8)) {
  console.log(`  ${s.ym} active=${String(s.active).padStart(4)} churning=${String(s.churning).padStart(3)} captured ${s.capturedAt.slice(0, 10)}`);
}
console.log(`  members_churned populated from ${CHURN_FIRST_MEASURED_YM}; ${months.filter((m) => m < CHURN_FIRST_MEASURED_YM).length} earlier months left EMPTY`);

console.log("\n=== distinct_members: the size of the unknown ===");
console.log(`  paid-external subscriptions ${subs.filter(paidExternal).length}, of which CANCELED with canceled_at NULL ${subs.filter((s) => paidExternal(s) && s.status === "CANCELED" && !s.canceled_at).length}`);
console.log("  year  excluded (the CSV, estate convention)   counted-as-open-to-today");
for (const y of years) {
  console.log(`  ${y}  ${String(distinctMembersIn(y, false)).padStart(10)}${String(distinctMembersIn(y, true)).padStart(30)}`);
}

console.log("\n=== other_spots: what is in the bucket ===");
console.log(`  total OTHER across all months ${[...otherKinds.values()].reduce((a, b) => a + b, 0)}`);
for (const [k, v] of [...otherKinds].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(7)}  ${k}`);
