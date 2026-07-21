// Verify matchAllocatedMemberRevenueFor produces the expected
// pro-rata. Walk through one sample match and confirm the formula
// terms match what's in fin_member_spots / fin_revenue.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { mostRecentCompletedWeekMonday, sundayEndOf } from "../src/lib/weekWindow";
import { fetchWeekMatchPnL } from "../src/lib/matchPnL";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

async function fetchAll<T>(table: string, select: string, orderCol: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).order(orderCol).range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  // Build a minimal FinanceData with the fields the helper needs.
  const [revenue, venuesRaw, memberSpotsRaw, aliasesRaw] = await Promise.all([
    fetchAll<Record<string, unknown>>("fin_revenue", "*", "id"),
    fetchAll<Record<string, unknown>>("fin_venues", "*", "id"),
    fetchAll<Record<string, unknown>>("fin_member_spots", "*", "id"),
    fetchAll<Record<string, unknown>>("fin_venue_aliases", "*", "alias"),
  ]);

  const aliases = new Map<string, string>();
  for (const a of aliasesRaw) {
    aliases.set(String(a.alias), String(a.canonical_venue));
  }

  const venues = venuesRaw.map((v) => ({
    id: Number(v.id),
    venue_name: String(aliases.get(String(v.venue_name)) ?? v.venue_name),
    raw_venue_name: String(v.venue_name),
    city: String(v.city ?? ""),
    billing_type: String(v.billing_type ?? "per_match") as "per_match",
    hourly_rate: v.hourly_rate == null ? null : Number(v.hourly_rate),
    monthly_flat: v.monthly_flat == null ? null : Number(v.monthly_flat),
    per_match_rate: v.per_match_rate == null ? null : Number(v.per_match_rate),
    max_spots: v.max_spots == null ? null : Number(v.max_spots),
    dpp_price: v.dpp_price == null ? null : Number(v.dpp_price),
    member_price: v.member_price == null ? null : Number(v.member_price),
    cost_per_match: v.cost_per_match == null ? null : Number(v.cost_per_match),
    notes: null,
    launch_date: null,
    is_active: true,
  }));

  const data = {
    revenue: revenue.map((r) => ({
      id: Number(r.id),
      date: String(r.date ?? ""),
      month: String(r.month ?? ""),
      city: String(r.city ?? ""),
      venue: r.venue == null ? null : String(r.venue),
      type: String(r.type ?? ""),
      gross: Number(r.gross ?? 0),
      fees: Number(r.fees ?? 0),
      net: Number(r.net ?? 0),
      source: String(r.source ?? ""),
      notes: r.notes == null ? null : String(r.notes),
    })),
    expenses: [],
    managerPay: [],
    monthlyExpenses: [],
    schedule: [],
    venues,
    memberSpots: memberSpotsRaw.map((m) => ({
      id: Number(m.id),
      venue: String(m.venue ?? ""),
      city: String(m.city ?? ""),
      month: String(m.month ?? ""),
      member_spots: Number(m.member_spots ?? 0),
      dpp_spots: Number(m.dpp_spots ?? 0),
      other_spots: Number(m.other_spots ?? 0),
    })),
    members: [],
    pricing: [],
    commentary: null,
    overrides: [],
    venueAliases: aliases,
  };

  const weekStart = mostRecentCompletedWeekMonday();
  const weekEnd = sundayEndOf(weekStart);
  console.log(`Week: ${weekStart.toISOString().slice(0, 10)} → ${weekEnd.toISOString().slice(0, 10)}\n`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await fetchWeekMatchPnL(sb, weekStart, weekEnd, data as any);
  const sample = result.active.find((r) => r.memberSpots > 0 && r.allocatedMemberRev > 0);
  if (!sample) {
    console.log("No sample match found with member spots > 0.");
    return;
  }

  console.log("=== Sample match ===");
  console.log(`  ${sample.venueDisplayName} (${sample.city}) · ${sample.matchStartIso}`);
  console.log(`  spotsSold=${sample.spotsSold}, memberSpots=${sample.memberSpots}, grossRev=${sample.grossRevenue}`);
  console.log(`  allocatedMemberRev (lib): $${sample.allocatedMemberRev.toFixed(4)}`);
  console.log(`  fieldCost=${sample.fieldCost}, net=${sample.net?.toFixed(2)}, status=${sample.status}\n`);

  // Manual computation: pick the venue's monthly member spots and city's monthly stats.
  const monthLabel = sample.matchStartIso.slice(0, 7); // YYYY-MM
  const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][parseInt(monthLabel.slice(5), 10) - 1];
  const monthStr = `${monthName} ${monthLabel.slice(0, 4)}`;
  const venueRow = data.memberSpots.find((m) => m.city === sample.city && m.venue === sample.venueDisplayName && m.month === monthStr);
  const cityTotal = data.memberSpots.filter((m) => m.city === sample.city && m.month === monthStr).reduce((s, m) => s + m.member_spots, 0);
  const cityMembership = data.revenue.filter((r) => r.city === sample.city && r.month === monthStr && r.type === "Membership").reduce((s, r) => s + r.net, 0);

  console.log("=== Manual computation ===");
  console.log(`  month                            = "${monthStr}"`);
  console.log(`  venue.member_spots (this month)  = ${venueRow?.member_spots ?? "(no row)"}`);
  console.log(`  city total member_spots          = ${cityTotal}`);
  console.log(`  city membership rev ($)          = ${cityMembership.toFixed(2)}`);
  if (cityTotal === 0 || !venueRow) {
    console.log(`  → cannot compute (zero denominator)`);
    return;
  }
  const venueMonthRev = (venueRow.member_spots / cityTotal) * cityMembership;
  console.log(`  venue's allocated month rev ($)  = ${venueRow.member_spots} / ${cityTotal} × ${cityMembership.toFixed(2)} = ${venueMonthRev.toFixed(4)}`);
  const expected = (sample.memberSpots / venueRow.member_spots) * venueMonthRev;
  console.log(`  match share ($)                  = ${sample.memberSpots} / ${venueRow.member_spots} × ${venueMonthRev.toFixed(4)} = ${expected.toFixed(4)}`);
  console.log(`  lib output                       = ${sample.allocatedMemberRev.toFixed(4)}`);
  const diff = Math.abs(expected - sample.allocatedMemberRev);
  console.log(`  diff                             = ${diff.toExponential(2)}`);
  console.log(diff < 0.001 ? "  ✓ matches within rounding" : "  ✗ MISMATCH — investigate");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
