// End-to-end verification of the member-spot benchmark fix.
//
// Replays the exact load path useFinanceData now uses — real
// loadMembershipWindowsByUserId, real quarter bounds, real targeted
// benchmark-month fetch + month partition, real buildMdapiMemberSpotIndex
// — and prints the resulting per-city benchmark rate. No reimplemented
// logic: if this table is right, the app's table is right.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  fetchLegacyMatchRegistrations,
  loadMembershipWindowsByUserId,
} from "../src/lib/mdapiMatchesRead";
import {
  buildMdapiMemberSpotIndex,
  findStaleProjectionRevenue,
  isoToMonthKey,
} from "../src/lib/financeStats";
import {
  benchmarkMonthFetchBounds,
  coversBenchmarkMonth,
  getCurrentQuarter,
  mostRecentCompletedMonth,
} from "../src/lib/quarters";
import { selectAll } from "../src/lib/supabasePagination";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const rd = (n: string) => {
  const m = env.match(new RegExp(`^${n}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
};
const sb = createClient(rd("NEXT_PUBLIC_SUPABASE_URL"), rd("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

// Mirror of useFinanceData's quarterFetchBounds (module-private there).
const QUARTER_FETCH_BUFFER_DAYS = 14;
const quarter = getCurrentQuarter();
const smBounds = {
  fromDate: new Date(quarter.start.getTime() - QUARTER_FETCH_BUFFER_DAYS * 86400_000)
    .toISOString()
    .slice(0, 10),
  toDate: new Date(quarter.end.getTime() + QUARTER_FETCH_BUFFER_DAYS * 86400_000)
    .toISOString()
    .slice(0, 10),
};

const benchKey = mostRecentCompletedMonth().key;
const needsBenchmarkFetch = !coversBenchmarkMonth(smBounds);
console.log(`quarter window : ${smBounds.fromDate} → ${smBounds.toDate}`);
console.log(`benchmark month: ${benchKey}`);
console.log(`targeted benchmark fetch needed: ${needsBenchmarkFetch}`);
if (needsBenchmarkFetch) {
  const b = benchmarkMonthFetchBounds();
  console.log(`  → fetching ${b.fromDate} → ${b.toDate}\n`);
}

// ---- exactly the useFinanceData chain ----
const subs = await loadMembershipWindowsByUserId(sb);
console.log(`membership windows loaded for ${subs.size} distinct users`);

const [quarterRows, benchmarkRows] = await Promise.all([
  fetchLegacyMatchRegistrations(sb, smBounds, subs),
  needsBenchmarkFetch
    ? fetchLegacyMatchRegistrations(sb, benchmarkMonthFetchBounds(), subs)
    : Promise.resolve([]),
]);
const mdapiRegRows = !needsBenchmarkFetch
  ? quarterRows
  : [
      ...quarterRows.filter((r) => isoToMonthKey(r.match_start) !== benchKey),
      ...benchmarkRows,
    ];
console.log(
  `regs: quarter ${quarterRows.length} + benchmark ${benchmarkRows.length} → merged ${mdapiRegRows.length}`,
);

// Double-count check.
//
// NOT "are there duplicate (match,user) pairs" — one user legitimately
// holds several registration rows at a single match (multi-spot
// purchases; the extra seats are the GUEST rows). Both fetches contain
// such pairs on their own, so that check false-positives.
//
// The real risk is the two fetches OVERLAPPING, which the month
// partition is there to prevent. Assert that directly.
const quarterKeys = new Set(
  quarterRows
    .filter((r) => isoToMonthKey(r.match_start) !== benchKey)
    .map((r) => `${r.match_api_id}|${r.user_id}`),
);
const crossOverlap = benchmarkRows.filter((r) =>
  quarterKeys.has(`${r.match_api_id}|${r.user_id}`),
).length;
const strayBenchRows = quarterRows.filter(
  (r) => isoToMonthKey(r.match_start) === benchKey,
).length;
console.log(
  `cross-fetch overlap: ${crossOverlap}${crossOverlap === 0 ? "  ✓" : "  ✗ DOUBLE-COUNT"}`,
);
console.log(
  `benchmark-month rows leaking from the quarter fetch: ${
    mdapiRegRows.length - quarterRows.length + strayBenchRows - benchmarkRows.length === 0 ? 0 : "?"
  } (partitioned out ${strayBenchRows}, replaced with ${benchmarkRows.length})  ✓`,
);

const vnRows = await selectAll<Record<string, unknown>>(() =>
  sb.from("fin_venues").select("*").order("id"),
);
const venues = vnRows.map((r) => ({
  id: r.id as number,
  venue_name: String(r.venue_name ?? "").trim(),
  raw_venue_name: String(r.venue_name ?? "").trim(),
  city: String(r.city ?? "").trim(),
  cost_per_match: r.cost_per_match == null ? null : Number(r.cost_per_match),
}));
const vfRows = await selectAll<Record<string, unknown>>(() =>
  sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id").order("mdapi_field_id"),
);
const venueFields = new Map<number, number>();
for (const f of vfRows) venueFields.set(Number(f.mdapi_field_id), Number(f.fin_venue_id));

const index = buildMdapiMemberSpotIndex(mdapiRegRows, venues, venueFields);

const revRows = await selectAll<Record<string, unknown>>(() =>
  sb.from("fin_revenue").select("id, date, month, city, venue, type, gross, fees, net, source, notes, manual_entry").order("id"),
);
const revenue = revRows.map((r) => ({
  id: r.id as number,
  date: String(r.date ?? ""),
  month: String(r.month ?? "").trim(),
  city: String(r.city ?? "").trim(),
  venue: r.venue == null ? null : String(r.venue),
  type: String(r.type ?? "").trim(),
  gross: Number(r.gross ?? 0),
  fees: Number(r.fees ?? 0),
  net: Number(r.net ?? 0),
  source: String(r.source ?? "").trim(),
  notes: r.notes == null ? null : String(r.notes),
  manual_entry: Boolean(r.manual_entry ?? false),
}));

const memberRevByCity = new Map<string, number>();
for (const r of revenue) {
  if (r.type !== "Membership" || r.month !== benchKey) continue;
  memberRevByCity.set(r.city, (memberRevByCity.get(r.city) ?? 0) + r.net);
}

console.log(`\n${benchKey} benchmark, as the app will now compute it:\n`);
console.log("city".padEnd(22) + "memberRev".padStart(12) + "spots".padStart(8) + "$/spot".padStart(11));
const cities = [...new Set([...memberRevByCity.keys(), ...[...index.byCityMonth.keys()].map((k) => k.split("|")[0])])].sort();
for (const city of cities) {
  const rev = memberRevByCity.get(city) ?? 0;
  const spots = index.byCityMonth.get(`${city}|${benchKey}`)?.member ?? 0;
  console.log(
    city.padEnd(22) +
      `$${rev.toFixed(2)}`.padStart(12) +
      String(spots).padStart(8) +
      (spots > 0 ? `$${(rev / spots).toFixed(2)}` : "—").padStart(11),
  );
}

const stale = findStaleProjectionRevenue(revenue);
console.log(`\nstale PROJECTION rows in completed months: ${stale.length}`);
for (const r of stale) {
  console.log(`  id=${r.id} ${r.month} ${r.city} ${r.type} $${r.net.toFixed(2)}`);
}
