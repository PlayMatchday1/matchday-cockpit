// One-shot digest for Ryan's weekly exec summary. Pulls every metric
// his "Watch items:" framing needs into a sectioned plaintext digest.
// He pastes the output to Claude, who writes the prose in his voice.
//
// Run: npx tsx scripts/exec-summary-data.ts [--month=YYYY-MM]
//   No flag → defaults to current month.
//
// Read-only. No DB writes. No file writes. Output to stdout.
//
// Data sources (all populated by the cron orchestrator):
//   - fin_revenue                 → revenue ($), filter source != PROJECTION
//   - mdapi_matches               → per-match metadata, gone-dark detection
//   - mdapi_match_players         → per-registration spot mix, cancellations
//                                   (joined via mdapiMatchesRead — promocode_id
//                                    already resolved to code text)
//   - mdapi_subscriptions         → membership counts + activation/cancel dates
//   - members_monthly_snapshots   → avg matches/member trailing
//
// Predicates (from Phase 5b investigation):
//   paymentType "MEMBER"     ← paid_status='FREE'
//   paymentType "DAILY PAID" ← paid_status='PAID' AND promocode_id IS NULL
//   paymentType "PROMOCODE"  ← paid_status='PAID' AND promocode_id IS NOT NULL
//   WAITING                  ← row dropped (incomplete payment)

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "../src/lib/supabasePagination";
import { fetchJoinedMatchPlayers } from "../src/lib/mdapiMatchesRead";

// ===== Env loading =====

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
function readVar(name: string): string | undefined {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}
// Mirror to process.env so transitively-loaded src/lib/supabase.ts
// can construct itself (mdapiMatchesRead doesn't use the singleton
// directly, but its dependencies might load it).
const supabaseUrl = readVar("NEXT_PUBLIC_SUPABASE_URL");
const publishableKey = readVar("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const serviceKey = readVar("SUPABASE_SERVICE_ROLE_KEY");
if (supabaseUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
if (publishableKey)
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = publishableKey;

// ===== Format helpers =====

const $ = (n: number): string =>
  "$" + Math.round(n).toLocaleString("en-US");
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const signed = (n: number, fmt: (x: number) => string = $): string =>
  (n >= 0 ? "+" : "") + fmt(n);
const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Wall-clock-aware parser, mirrors useMatchData's parseLocal.
function parseLocal(s: string | null | undefined): Date | null {
  if (!s) return null;
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 5) return null;
  const [yr, mo, dy, hr, mn] = parts.map(Number);
  if ([yr, mo, dy, hr, mn].some((n) => Number.isNaN(n))) return null;
  return new Date(yr, mo - 1, dy, hr, mn);
}

// Monday-start week boundary. Returns the Date of the Monday on or
// before `d`. Mirrors matchPnL's convention.
function mondayOf(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = out.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  out.setDate(out.getDate() + offset);
  return out;
}

// ===== Date math =====

function parseMonthArg(): { year: number; month: number } {
  const arg = process.argv.find((a) => a.startsWith("--month="));
  if (!arg) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  }
  const [y, m] = arg.slice("--month=".length).split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) {
    console.error("Invalid --month=YYYY-MM");
    process.exit(1);
  }
  return { year: y, month: m - 1 };
}

const { year, month } = parseMonthArg();
const TODAY = new Date();
const monthStart = new Date(year, month, 1);
const monthEnd = new Date(year, month + 1, 1); // exclusive
const daysInMonth = new Date(year, month + 1, 0).getDate();
// "today" within the target month — capped to last day if --month is past.
const isCurrentMonth =
  TODAY.getFullYear() === year && TODAY.getMonth() === month;
const todayDay = isCurrentMonth
  ? TODAY.getDate()
  : TODAY > monthEnd
    ? daysInMonth
    : 1;
const today = new Date(year, month, todayDay);
const daysElapsed = todayDay;
const daysRemaining = daysInMonth - todayDay;

const lastMonthStart = new Date(year, month - 1, 1);
const lastMonthSameDay = new Date(year, month - 1, todayDay);
// 90 days back for new-venue + streak windows
const ninetyDaysAgo = new Date(today.getTime() - 90 * 86_400_000);
const fourteenDaysAgo = new Date(today.getTime() - 14 * 86_400_000);
const fortyFourDaysAgo = new Date(today.getTime() - 44 * 86_400_000); // 14 + 30

// ===== Types =====

type FinRevRow = {
  date: string;
  city: string | null;
  venue: string | null;
  type: string;
  gross: number | null;
  source: string;
};

type SubRow = {
  status: string | null;
  price: number | null;
  member_email: string | null;
  activation_date: string | null;
  canceled_at: string | null;
  city_identifier: string | null;
};

type SnapRow = {
  month: string;
  active_count: number | null;
  avg_matches_per_member: number | null;
  by_city: Record<string, { active: number; new: number; cancelled: number }> | null;
};

// ===== Fetch =====

async function fetchAll(sb: SupabaseClient) {
  // Cast revenue/projects fetch lower bound at lastMonth start so we
  // have everything for SDLM + 90d streak analysis.
  const [revenue, joined, subs, snapshots, matchesAll] = await Promise.all([
    selectAll<FinRevRow>(() =>
      sb
        .from("fin_revenue")
        .select("date, city, venue, type, gross, source")
        .neq("source", "PROJECTION")
        .gte("date", ymd(ninetyDaysAgo))
        .order("id"),
    ),
    fetchJoinedMatchPlayers(sb, {
      // Cover MTD plus enough lookback for gone-dark detection (44d back)
      fromDate: ymd(fortyFourDaysAgo),
      toDate: ymd(monthEnd),
    }),
    selectAll<SubRow>(() =>
      sb
        .from("mdapi_subscriptions")
        .select(
          "status, price, member_email, activation_date, canceled_at, city_identifier",
        )
        .order("membership_id"),
    ),
    sb
      .from("members_monthly_snapshots")
      .select("month, active_count, avg_matches_per_member, by_city")
      .order("month", { ascending: false })
      .limit(2)
      .then((r) => (r.data ?? []) as SnapRow[]),
    // For new-venues + gone-dark: need full match history (api_id +
    // city + field + start_date + cancelled). Light query, ~2k rows.
    selectAll<{
      city_identifier: string | null;
      field_title: string | null;
      start_date: string | null;
      is_cancelled: boolean | null;
    }>(() =>
      sb
        .from("mdapi_matches")
        .select("city_identifier, field_title, start_date, is_cancelled")
        .order("api_id"),
    ),
  ]);
  return { revenue, joined, subs, snapshots, matchesAll };
}

// ===== City normalization =====

const CITY_ABBR_TO_NAME: Record<string, string> = {
  ATX: "Austin",
  HOU: "Houston",
  SATX: "San Antonio",
  DFW: "Dallas",
  ATL: "Atlanta",
  OKC: "OKC",
  STL: "St. Louis",
  ELP: "El Paso",
};
function cityFromAbbr(abbr: string | null | undefined): string | null {
  return abbr ? (CITY_ABBR_TO_NAME[abbr.trim()] ?? null) : null;
}

// ===== Section computations =====

function inMonth(dateStr: string): boolean {
  return dateStr >= ymd(monthStart) && dateStr < ymd(monthEnd);
}
function inLastMonthSameDay(dateStr: string): boolean {
  return dateStr >= ymd(lastMonthStart) && dateStr <= ymd(lastMonthSameDay);
}
function isCurrentDate(d: Date): boolean {
  return d >= monthStart && d < monthEnd;
}
function isInDateRange(d: Date, start: Date, end: Date): boolean {
  return d >= start && d < end;
}

function fmtSection(title: string): string {
  return `\n=== ${title} ===\n`;
}

// === Section 1: Header ===

function sectionHeader(rev: FinRevRow[]) {
  const out: string[] = [];
  out.push(fmtSection("HEADER"));
  const monthName = monthStart.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  out.push(`Month: ${monthName}`);
  out.push(`Today: ${ymd(TODAY)}`);
  out.push(`Days elapsed: ${daysElapsed}`);
  out.push(`Days remaining: ${daysRemaining}`);

  // SDLM pace
  let mtd = 0;
  for (const r of rev) if (inMonth(r.date)) mtd += r.gross ?? 0;
  let sdlm = 0;
  for (const r of rev) if (inLastMonthSameDay(r.date)) sdlm += r.gross ?? 0;
  const delta = sdlm > 0 ? (mtd - sdlm) / sdlm : 0;
  out.push(
    `MTD pace vs last month same-day: ${$(mtd)} vs ${$(sdlm)} (${signed(delta, pct)})`,
  );
  return out.join("\n");
}

// === Section 2: Revenue ===

function sectionRevenue(rev: FinRevRow[]) {
  const out: string[] = [];
  out.push(fmtSection("REVENUE"));

  let mtd = 0;
  let sdlm = 0;
  const byCity = new Map<string, number>();
  for (const r of rev) {
    if (!r.gross) continue;
    if (inMonth(r.date)) {
      mtd += r.gross;
      const c = r.city ?? "—";
      byCity.set(c, (byCity.get(c) ?? 0) + r.gross);
    }
    if (inLastMonthSameDay(r.date)) sdlm += r.gross;
  }

  out.push(`Network MTD gross: ${$(mtd)}`);
  out.push(
    `Same-day last month: ${$(sdlm)} (${sdlm > 0 ? signed((mtd - sdlm) / sdlm, pct) : "n/a"})`,
  );
  const projected =
    daysElapsed > 0 ? Math.round((mtd / daysElapsed) * daysInMonth) : mtd;
  out.push(`Projected month-end (linear): ${$(projected)}`);

  // 7-day momentum per city: last 7 days vs prior 7 days
  const last7Start = new Date(today.getTime() - 7 * 86_400_000);
  const prior7Start = new Date(today.getTime() - 14 * 86_400_000);
  const cityLast7 = new Map<string, number>();
  const cityPrior7 = new Map<string, number>();
  for (const r of rev) {
    if (!r.gross) continue;
    const d = new Date(r.date);
    const c = r.city ?? "—";
    if (d >= last7Start && d <= today)
      cityLast7.set(c, (cityLast7.get(c) ?? 0) + r.gross);
    else if (d >= prior7Start && d < last7Start)
      cityPrior7.set(c, (cityPrior7.get(c) ?? 0) + r.gross);
  }

  out.push("");
  out.push("By city:");
  const cityRows = [...byCity.entries()].sort((a, b) => b[1] - a[1]);
  for (const [city, gross] of cityRows) {
    const sharePct = mtd > 0 ? gross / mtd : 0;
    const last = cityLast7.get(city) ?? 0;
    const prior = cityPrior7.get(city) ?? 0;
    const arrow =
      prior === 0 ? "—" : last > prior * 1.05 ? "▲" : last < prior * 0.95 ? "▼" : "→";
    out.push(`  ${city}: ${$(gross)} (${pct(sharePct)} of network) ${arrow} 7d`);
  }
  return out.join("\n");
}

// === Section 3: Venue performance ===

function sectionVenuePerformance(
  rev: FinRevRow[],
  matchesAll: { city_identifier: string | null; field_title: string | null; start_date: string | null }[],
) {
  const out: string[] = [];
  out.push(fmtSection("VENUE PERFORMANCE"));

  // Top/Bottom by MTD revenue
  const venueMtd = new Map<string, { city: string; gross: number }>();
  for (const r of rev) {
    if (!r.gross || !r.venue) continue;
    if (!inMonth(r.date)) continue;
    const cur = venueMtd.get(r.venue) ?? {
      city: r.city ?? "—",
      gross: 0,
    };
    cur.gross += r.gross;
    venueMtd.set(r.venue, cur);
  }
  // "Active venues" — at least one match this month
  const venuesWithMatches = new Set<string>();
  for (const m of matchesAll) {
    if (!m.start_date || !m.field_title) continue;
    if (!inMonth(m.start_date.slice(0, 10))) continue;
    venuesWithMatches.add(m.field_title);
  }
  // Note: m.field_title is raw API; fin_revenue.venue is canonical.
  // Bottom-5 should filter on fin_revenue.venue presence in revenue
  // map AND existence in matches at all (not strict join).
  const sorted = [...venueMtd.entries()].sort((a, b) => b[1].gross - a[1].gross);
  out.push("Top 5 by MTD revenue:");
  for (let i = 0; i < Math.min(5, sorted.length); i++) {
    const [venue, info] = sorted[i];
    const share = sorted[0][1].gross > 0 ? info.gross / sorted.reduce((s, x) => s + x[1].gross, 0) : 0;
    out.push(`  ${i + 1}. ${venue} (${info.city}): ${$(info.gross)} (${pct(share)})`);
  }
  out.push("");
  out.push("Bottom 5 (active venues with revenue this month):");
  const bottom = sorted.slice().reverse().slice(0, 5);
  for (let i = 0; i < bottom.length; i++) {
    const [venue, info] = bottom[i];
    out.push(`  ${i + 1}. ${venue} (${info.city}): ${$(info.gross)}`);
  }

  // Weekly per-venue revenue for streak detection
  const weekRev = new Map<string, Map<string, number>>(); // venue → weekStartIso → $
  for (const r of rev) {
    if (!r.gross || !r.venue) continue;
    const d = new Date(r.date);
    const wk = ymd(mondayOf(d));
    const cur = weekRev.get(r.venue) ?? new Map<string, number>();
    cur.set(wk, (cur.get(wk) ?? 0) + r.gross);
    weekRev.set(r.venue, cur);
  }
  // Build last 4 complete weeks (Mondays) ending in the most recent
  // Sunday strictly before today.
  const lastSunday = new Date(today.getTime() - ((today.getDay() || 7)) * 86_400_000);
  const recentMondays: string[] = [];
  for (let i = 3; i >= 0; i--) {
    const monday = new Date(lastSunday);
    monday.setDate(lastSunday.getDate() - 6 - i * 7);
    recentMondays.push(ymd(monday));
  }

  const growthStreaks: { venue: string; city: string; trend: string }[] = [];
  const declineStreaks: { venue: string; city: string; trend: string }[] = [];
  for (const [venue, weeks] of weekRev) {
    const seq = recentMondays.map((m) => weeks.get(m) ?? 0);
    if (seq.every((v) => v === 0)) continue;
    const trend = seq.map((v) => $(v)).join(" → ");
    const city = venueMtd.get(venue)?.city ?? "—";
    // 3+ consecutive WoW gains across the 4-point sequence
    if (seq[0] < seq[1] && seq[1] < seq[2] && seq[2] < seq[3] && seq[0] > 0) {
      growthStreaks.push({ venue, city, trend });
    }
    // 2+ consecutive WoW declines
    if (seq[1] < seq[0] && seq[2] < seq[1] && seq[0] > 0) {
      declineStreaks.push({ venue, city, trend });
    } else if (seq[2] < seq[1] && seq[3] < seq[2] && seq[1] > 0) {
      declineStreaks.push({ venue, city, trend });
    }
  }
  out.push("");
  out.push(`Growth streaks (3 weeks of consecutive WoW gains, last 4 complete weeks):`);
  if (growthStreaks.length === 0) out.push(`  (none)`);
  for (const s of growthStreaks)
    out.push(`  ${s.venue} (${s.city}): ${s.trend}`);
  out.push("");
  out.push(`Decline streaks (2+ consecutive WoW declines, last 4 complete weeks):`);
  if (declineStreaks.length === 0) out.push(`  (none)`);
  for (const s of declineStreaks)
    out.push(`  ${s.venue} (${s.city}): ${s.trend}`);

  return out.join("\n");
}

// === Section 4: Spot mix ===

type Joined = Awaited<ReturnType<typeof fetchJoinedMatchPlayers>>[number];

function sectionSpotMix(joined: Joined[]) {
  const out: string[] = [];
  out.push(fmtSection("SPOT MIX"));

  // MTD only, exclude cancelled-match registrations and player-cancelled
  const mtd = joined.filter(
    (r) =>
      r.matchStart >= monthStart &&
      r.matchStart < monthEnd &&
      !r.matchCanceled &&
      !r.playerCanceledAt,
  );
  let total = 0,
    member = 0,
    dpp = 0,
    promo = 0;
  const byCity = new Map<
    string,
    { total: number; member: number; dpp: number; promo: number }
  >();
  for (const r of mtd) {
    total++;
    const cur = byCity.get(r.city) ?? { total: 0, member: 0, dpp: 0, promo: 0 };
    cur.total++;
    if (r.paymentType === "MEMBER") {
      member++;
      cur.member++;
    } else if (r.paymentType === "PROMOCODE") {
      promo++;
      cur.promo++;
    } else if (r.paymentType === "DAILY PAID") {
      dpp++;
      cur.dpp++;
    }
    byCity.set(r.city, cur);
  }
  out.push(
    `Network MTD: ${total.toLocaleString()} total spots (${member} MEMBER · ${dpp} DPP · ${promo} PROMO)`,
  );
  if (total > 0) {
    out.push(
      `  Mix: ${pct(member / total)} member · ${pct(dpp / total)} DPP · ${pct(promo / total)} promo`,
    );
  }
  out.push("");
  out.push("By city:");
  const cityRows = [...byCity.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [city, b] of cityRows) {
    out.push(
      `  ${city}: ${b.total} spots (${pct(b.member / b.total)}/${pct(b.dpp / b.total)}/${pct(b.promo / b.total)} mem/DPP/promo)`,
    );
  }

  // Members-heavy fields: ≥35% member, ≥30 spots
  const byVenue = new Map<
    string,
    { city: string; total: number; member: number; promo: number }
  >();
  for (const r of mtd) {
    const cur = byVenue.get(r.field) ?? {
      city: r.city,
      total: 0,
      member: 0,
      promo: 0,
    };
    cur.total++;
    if (r.paymentType === "MEMBER") cur.member++;
    if (r.paymentType === "PROMOCODE") cur.promo++;
    byVenue.set(r.field, cur);
  }
  const memberHeavy = [...byVenue.entries()]
    .filter(([, v]) => v.total >= 30 && v.member / v.total >= 0.35)
    .sort((a, b) => b[1].member / b[1].total - a[1].member / a[1].total);
  out.push("");
  out.push("Members-heavy fields (≥35% member, 30+ spots):");
  if (memberHeavy.length === 0) out.push("  (none)");
  for (const [field, v] of memberHeavy.slice(0, 10)) {
    out.push(
      `  ${field} (${v.city}): ${pct(v.member / v.total)} member (${v.total} spots)`,
    );
  }

  const promoHeavy = [...byVenue.entries()]
    .filter(([, v]) => v.total >= 30 && v.promo / v.total >= 0.2)
    .sort((a, b) => b[1].promo / b[1].total - a[1].promo / a[1].total);
  out.push("");
  out.push("High promo usage fields (≥20% promo, 30+ spots):");
  if (promoHeavy.length === 0) out.push("  (none)");
  for (const [field, v] of promoHeavy.slice(0, 10)) {
    out.push(
      `  ${field} (${v.city}): ${pct(v.promo / v.total)} promo (${v.total} spots)`,
    );
  }

  // Top promocodes (MTD redemptions, code text)
  const codeCounts = new Map<string, number>();
  for (const r of mtd) {
    if (r.paymentType !== "PROMOCODE") continue;
    if (!r.promocode) continue;
    codeCounts.set(r.promocode, (codeCounts.get(r.promocode) ?? 0) + 1);
  }
  const topCodes = [...codeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  out.push("");
  out.push("Top promocodes (MTD redemptions):");
  if (topCodes.length === 0) out.push("  (none)");
  for (const [code, n] of topCodes) out.push(`  ${code}: ${n}`);

  return out.join("\n");
}

// === Section 5: Cancellations ===

function sectionCancellations(joined: Joined[]) {
  const out: string[] = [];
  out.push(fmtSection("CANCELLATIONS"));

  // Filter to MTD signups (non-cancelled-match)
  const mtdSignups = joined.filter(
    (r) => r.matchStart >= monthStart && r.matchStart < monthEnd && !r.matchCanceled,
  );
  const total = mtdSignups.length;
  const cancelled = mtdSignups.filter((r) => r.playerCanceledAt !== null).length;
  out.push(
    `Network MTD cancellation rate: ${pct(total > 0 ? cancelled / total : 0)} (${cancelled} cancelled / ${total} signups)`,
  );

  // By city
  const cityCancel = new Map<string, { total: number; cancel: number }>();
  for (const r of mtdSignups) {
    const cur = cityCancel.get(r.city) ?? { total: 0, cancel: 0 };
    cur.total++;
    if (r.playerCanceledAt) cur.cancel++;
    cityCancel.set(r.city, cur);
  }
  out.push("");
  out.push("By city:");
  for (const [city, b] of [...cityCancel.entries()].sort((a, b) => b[1].total - a[1].total)) {
    out.push(`  ${city}: ${pct(b.total > 0 ? b.cancel / b.total : 0)} (${b.cancel}/${b.total})`);
  }

  // Match-level cancellations MTD (distinct cancelled matches in the month)
  const cancelledMatches = new Set<number>();
  for (const r of joined) {
    if (r.matchStart < monthStart || r.matchStart >= monthEnd) continue;
    if (r.matchCanceled) cancelledMatches.add(r.matchApiId);
  }
  out.push("");
  out.push(`Match-level cancellations MTD: ${cancelledMatches.size}`);

  // Top 5 venues by player cancel rate (≥30 signups)
  const venueCancel = new Map<string, { city: string; total: number; cancel: number }>();
  for (const r of mtdSignups) {
    const cur = venueCancel.get(r.field) ?? { city: r.city, total: 0, cancel: 0 };
    cur.total++;
    if (r.playerCanceledAt) cur.cancel++;
    venueCancel.set(r.field, cur);
  }
  const top = [...venueCancel.entries()]
    .filter(([, v]) => v.total >= 30)
    .sort((a, b) => b[1].cancel / b[1].total - a[1].cancel / a[1].total)
    .slice(0, 5);
  out.push("");
  out.push("Top 5 venues by player cancel rate (≥30 signups):");
  if (top.length === 0) out.push("  (none)");
  for (const [field, v] of top) {
    out.push(
      `  ${field} (${v.city}): ${pct(v.cancel / v.total)} (${v.cancel}/${v.total})`,
    );
  }

  return out.join("\n");
}

// === Section 6: Membership ===

function sectionMembership(subs: SubRow[], snapshots: SnapRow[]) {
  const out: string[] = [];
  out.push(fmtSection("MEMBERSHIP"));

  function isPaidExternal(s: SubRow): boolean {
    if (!s.price || s.price <= 0) return false;
    if (s.member_email && /@matchday\.|@playmatchday\./i.test(s.member_email))
      return false;
    if (s.status?.toUpperCase().startsWith("INCOMPLETE")) return false;
    return true;
  }
  function isActive(s: SubRow): boolean {
    return s.status === "ACTIVE" && isPaidExternal(s);
  }
  function isNewInMonth(s: SubRow): boolean {
    if (!isPaidExternal(s)) return false;
    if (s.status?.toUpperCase() === "CANCELED" && !s.canceled_at) return false; // phantom
    if (!s.activation_date) return false;
    return s.activation_date >= ymd(monthStart) && s.activation_date < ymd(monthEnd);
  }
  function isCancelledInMonth(s: SubRow): boolean {
    if (!s.canceled_at) return false;
    const ca = s.canceled_at.slice(0, 10);
    return ca >= ymd(monthStart) && ca < ymd(monthEnd);
  }

  const active = subs.filter(isActive);
  const activeByCity = new Map<string, number>();
  for (const s of active) {
    const city = cityFromAbbr(s.city_identifier) ?? "—";
    activeByCity.set(city, (activeByCity.get(city) ?? 0) + 1);
  }
  out.push(`Active today (network): ${active.length}`);
  out.push("By city:");
  for (const [city, n] of [...activeByCity.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`  ${city}: ${n}`);
  }

  const newMtd = subs.filter(isNewInMonth).length;
  const cancelledMtd = subs.filter(isCancelledInMonth).length;
  out.push("");
  out.push(`New activations MTD: ${newMtd}`);
  out.push(`Cancellations MTD: ${cancelledMtd}`);
  out.push(`Net change MTD: ${signed(newMtd - cancelledMtd, (n) => String(n))}`);

  // Day-1 renewals: active members whose activation_date day-of-month === 1
  const day1 = active.filter((s) => {
    if (!s.activation_date) return false;
    return s.activation_date.endsWith("-01");
  }).length;
  out.push(`Day-1 renewals (active members billed on the 1st): ${day1}`);

  // Avg matches/member from latest snapshot
  const latest = snapshots[0];
  if (latest) {
    out.push(
      `Avg matches/member (${latest.month}): ${latest.avg_matches_per_member?.toFixed(2) ?? "n/a"}`,
    );
  }

  return out.join("\n");
}

// === Section 7: New venues (last 90d) ===

function sectionNewVenues(
  matchesAll: { city_identifier: string | null; field_title: string | null; start_date: string | null }[],
  joined: Joined[],
  rev: FinRevRow[],
) {
  const out: string[] = [];
  out.push(fmtSection("NEW VENUES (first match in last 90 days)"));

  const venueFirstMatch = new Map<string, { city: string; first: Date }>();
  for (const m of matchesAll) {
    if (!m.field_title || !m.start_date) continue;
    const city = cityFromAbbr(m.city_identifier) ?? "—";
    const d = parseLocal(m.start_date);
    if (!d) continue;
    const cur = venueFirstMatch.get(m.field_title);
    if (!cur || d < cur.first) {
      venueFirstMatch.set(m.field_title, { city, first: d });
    }
  }
  const newVenues = [...venueFirstMatch.entries()]
    .filter(([, v]) => v.first >= ninetyDaysAgo)
    .sort((a, b) => a[1].first.getTime() - b[1].first.getTime());

  if (newVenues.length === 0) {
    out.push("  (none in last 90 days)");
    return out.join("\n");
  }

  // MTD spots / member % per new venue
  const venueMtd = new Map<string, { total: number; member: number }>();
  for (const r of joined) {
    if (r.matchStart < monthStart || r.matchStart >= monthEnd) continue;
    if (r.matchCanceled || r.playerCanceledAt) continue;
    const cur = venueMtd.get(r.field) ?? { total: 0, member: 0 };
    cur.total++;
    if (r.paymentType === "MEMBER") cur.member++;
    venueMtd.set(r.field, cur);
  }
  const venueMtdRev = new Map<string, number>();
  for (const r of rev) {
    if (!r.venue || !r.gross) continue;
    if (!inMonth(r.date)) continue;
    venueMtdRev.set(r.venue, (venueMtdRev.get(r.venue) ?? 0) + r.gross);
  }

  for (const [venue, info] of newVenues) {
    const spots = venueMtd.get(venue);
    const revVal = venueMtdRev.get(venue) ?? 0;
    const spotsLine =
      spots && spots.total > 0
        ? `${spots.total} spots (${pct(spots.member / spots.total)} member)`
        : "no MTD spots";
    out.push(
      `  ${venue} (${info.city}), launched ${ymd(info.first)}: ${$(revVal)} MTD · ${spotsLine}`,
    );
  }
  return out.join("\n");
}

// === Section 8: Watch items ===

function sectionWatchItems(
  rev: FinRevRow[],
  matchesAll: { city_identifier: string | null; field_title: string | null; start_date: string | null }[],
  joined: Joined[],
  subs: SubRow[],
  snapshots: SnapRow[],
) {
  const out: string[] = [];
  out.push(fmtSection("WATCH ITEMS"));
  const items: string[] = [];

  // 1. Venue with >50% WoW decline (last week vs prior week)
  const lastSunday = new Date(today.getTime() - ((today.getDay() || 7)) * 86_400_000);
  const lastWeekStart = new Date(lastSunday);
  lastWeekStart.setDate(lastSunday.getDate() - 6);
  const priorWeekStart = new Date(lastWeekStart);
  priorWeekStart.setDate(lastWeekStart.getDate() - 7);
  const venueLast = new Map<string, { city: string; gross: number }>();
  const venuePrior = new Map<string, number>();
  for (const r of rev) {
    if (!r.venue || !r.gross) continue;
    const d = new Date(r.date);
    if (d >= lastWeekStart && d <= lastSunday) {
      const cur = venueLast.get(r.venue) ?? { city: r.city ?? "—", gross: 0 };
      cur.gross += r.gross;
      venueLast.set(r.venue, cur);
    } else if (d >= priorWeekStart && d < lastWeekStart) {
      venuePrior.set(r.venue, (venuePrior.get(r.venue) ?? 0) + r.gross);
    }
  }
  for (const [venue, info] of venueLast) {
    const prior = venuePrior.get(venue) ?? 0;
    if (prior < 200) continue; // skip tiny baselines
    if (info.gross < prior * 0.5) {
      const drop = ((info.gross - prior) / prior) * 100;
      items.push(
        `${venue} (${info.city}): WoW revenue ${$(prior)} → ${$(info.gross)} (${drop.toFixed(0)}%)`,
      );
    }
  }

  // 2. City with active member count down >5 MoM (current vs last snapshot)
  if (snapshots.length >= 2) {
    const cur = snapshots[0]?.by_city ?? {};
    const prev = snapshots[1]?.by_city ?? {};
    for (const city of Object.keys(cur)) {
      const c = cur[city]?.active ?? 0;
      const p = prev[city]?.active ?? 0;
      if (p - c > 5) {
        items.push(
          `City ${city}: ${p} → ${c} active members MoM (-${p - c})`,
        );
      }
    }
  }

  // 3. Venue with >25% cancellation rate MTD (≥30 signups baseline)
  const venueCancel = new Map<string, { city: string; total: number; cancel: number }>();
  for (const r of joined) {
    if (r.matchStart < monthStart || r.matchStart >= monthEnd) continue;
    if (r.matchCanceled) continue;
    const cur = venueCancel.get(r.field) ?? { city: r.city, total: 0, cancel: 0 };
    cur.total++;
    if (r.playerCanceledAt) cur.cancel++;
    venueCancel.set(r.field, cur);
  }
  for (const [venue, v] of venueCancel) {
    if (v.total < 30) continue;
    const rate = v.cancel / v.total;
    if (rate > 0.25) {
      items.push(
        `${venue} (${v.city}): ${pct(rate)} cancel rate MTD (${v.cancel}/${v.total})`,
      );
    }
  }

  // 4. Gone dark: 0 matches in last 14 days, prior 30 days had matches
  const venueRecentMatches = new Map<string, { city: string; last14: number; prior30: number }>();
  for (const m of matchesAll) {
    if (!m.field_title || !m.start_date) continue;
    const d = parseLocal(m.start_date);
    if (!d) continue;
    const city = cityFromAbbr(m.city_identifier) ?? "—";
    const cur = venueRecentMatches.get(m.field_title) ?? { city, last14: 0, prior30: 0 };
    if (isInDateRange(d, fourteenDaysAgo, today)) cur.last14++;
    else if (isInDateRange(d, fortyFourDaysAgo, fourteenDaysAgo)) cur.prior30++;
    venueRecentMatches.set(m.field_title, cur);
  }
  for (const [venue, v] of venueRecentMatches) {
    if (v.last14 === 0 && v.prior30 >= 3) {
      items.push(
        `${venue} (${v.city}): gone dark — 0 matches in last 14d, ${v.prior30} in prior 30d`,
      );
    }
  }

  if (items.length === 0) {
    out.push("(no auto-flagged signals this run)");
  } else {
    for (const i of items) out.push(`- ${i}`);
  }
  return out.join("\n");
}

// ===== Main =====

async function main() {
  if (!supabaseUrl || !serviceKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
    );
    process.exit(1);
  }
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  process.stderr.write("Fetching data...\n");
  const data = await fetchAll(sb);
  process.stderr.write(
    `  fin_revenue: ${data.revenue.length}, joined match-players: ${data.joined.length}, subs: ${data.subs.length}, matches: ${data.matchesAll.length}, snapshots: ${data.snapshots.length}\n\n`,
  );

  const sections = [
    sectionHeader(data.revenue),
    sectionRevenue(data.revenue),
    sectionVenuePerformance(data.revenue, data.matchesAll),
    sectionSpotMix(data.joined),
    sectionCancellations(data.joined),
    sectionMembership(data.subs, data.snapshots),
    sectionNewVenues(data.matchesAll, data.joined, data.revenue),
    sectionWatchItems(
      data.revenue,
      data.matchesAll,
      data.joined,
      data.subs,
      data.snapshots,
    ),
  ];
  console.log(sections.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
