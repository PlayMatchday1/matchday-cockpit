import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const MONTHS = ["Jul 2026", "Aug 2026", "Sep 2026"];

// Schedule audit
const { data: sched } = await sb
  .from("fin_schedule")
  .select("venue, month, match_count")
  .eq("created_by", "q3-prefill-script")
  .in("month", MONTHS);

const byVenueMonth = new Map();
const byMonth = new Map();
for (const r of sched) {
  const k = `${r.venue}|${r.month}`;
  if (!byVenueMonth.has(k)) byVenueMonth.set(k, { rows: 0, matches: 0 });
  byVenueMonth.get(k).rows++;
  byVenueMonth.get(k).matches += r.match_count;
  if (!byMonth.has(r.month)) byMonth.set(r.month, { rows: 0, matches: 0 });
  byMonth.get(r.month).rows++;
  byMonth.get(r.month).matches += r.match_count;
}

console.log("=== DB post-apply: fin_schedule (created_by=q3-prefill-script) ===");
const venueSet = [...new Set(sched.map(r => r.venue))].sort();
for (const v of venueSet) {
  const parts = MONTHS.map(m => {
    const x = byVenueMonth.get(`${v}|${m}`);
    return x ? `${m}=${x.rows}r/${x.matches}m` : `${m}=0r/0m`;
  });
  console.log(`  ${v.padEnd(20)}  ${parts.join("   ")}`);
}
console.log();
console.log("Per-month totals:");
for (const m of MONTHS) {
  const x = byMonth.get(m);
  console.log(`  ${m}:  ${x?.rows ?? 0} rows  ·  ${x?.matches ?? 0} matches`);
}
const total = [...byMonth.values()].reduce((s, x) => ({ rows: s.rows+x.rows, matches: s.matches+x.matches }), { rows: 0, matches: 0 });
console.log(`  GRAND TOTAL:  ${total.rows} rows  ·  ${total.matches} matches`);

// Override audit
const { data: overs } = await sb
  .from("fin_venue_cost_overrides")
  .select("venue_id, month, override_amount, reason")
  .eq("created_by", "q3-prefill-script")
  .in("month", MONTHS);

// Join venue names
const venueIds = [...new Set(overs.map(o => o.venue_id))];
const { data: venues } = await sb.from("fin_venues").select("id, venue_name").in("id", venueIds);
const nameById = new Map(venues.map(v => [v.id, v.venue_name]));

console.log("\n=== DB post-apply: fin_venue_cost_overrides (created_by=q3-prefill-script) ===");
console.log(`Count: ${overs.length}`);
for (const o of overs.sort((a,b) => (nameById.get(a.venue_id) ?? "").localeCompare(nameById.get(b.venue_id) ?? "") || a.month.localeCompare(b.month))) {
  console.log(`  ${(nameById.get(o.venue_id) ?? "?").padEnd(16)}  ${o.month}  $${o.override_amount}`);
}
