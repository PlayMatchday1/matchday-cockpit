import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) => Number(n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

// === Q1: fin_revenue April rows NEMP / Metropolitan / North East ===
const { data: rev } = await sb
  .from("fin_revenue")
  .select("venue, type, gross")
  .eq("month", "Apr 2026")
  .or("venue.ilike.%nemp%,venue.ilike.%metropolitan%,venue.ilike.%north east%");
const agg1 = new Map();
for (const r of rev ?? []) {
  const k = `${r.venue}|${r.type}`;
  const v = agg1.get(k) ?? { venue: r.venue, type: r.type, rows: 0, total: 0 };
  v.rows += 1;
  v.total += Number(r.gross ?? 0);
  agg1.set(k, v);
}
console.log("=== Q1: fin_revenue (Apr 2026) NEMP / Metropolitan / North East ===");
console.log("venue                                type                     rows     total_gross");
const sorted1 = [...agg1.values()].sort((a, b) => b.total - a.total);
for (const r of sorted1) {
  console.log(`${String(r.venue ?? "").padEnd(36)}  ${String(r.type ?? "").padEnd(22)}  ${String(r.rows).padStart(4)}   ${fmt(r.total).padStart(11)}`);
}
if (sorted1.length === 0) console.log("(no rows)");

// === Q2: mdapi_matches April field titles NEMP-ish ===
// Pull non-cancelled matches via start_date column + field_title column.
const matches = [];
for (let from = 0; ; from += 1000) {
  const { data } = await sb
    .from("mdapi_matches")
    .select("api_id, field_title, registration_price, is_cancelled")
    .gte("start_date", "2026-04-01")
    .lt("start_date", "2026-05-01")
    .eq("is_cancelled", false)
    .order("api_id")
    .range(from, from + 999);
  if (!data?.length) break;
  matches.push(...data);
  if (data.length < 1000) break;
}
const re = /(nemp|metropolitan|north east)/i;
const agg2 = new Map();
for (const m of matches) {
  const f = m.field_title ?? "";
  if (!re.test(f)) continue;
  const v = agg2.get(f) ?? { field: f, count: 0, sumPrice: 0 };
  v.count += 1;
  // registration_price is in cents → dollars
  v.sumPrice += (Number(m.registration_price ?? 0) || 0) / 100;
  agg2.set(f, v);
}
console.log("\n=== Q2: mdapi_matches (Apr 2026, !cancelled) NEMP-ish field titles ===");
console.log("field_title                                            match_count   per_spot_price_sum (DOLLARS)");
const sorted2 = [...agg2.values()].sort((a, b) => b.count - a.count);
for (const r of sorted2) {
  console.log(`${String(r.field).padEnd(54)}  ${String(r.count).padStart(11)}   ${fmt(r.sumPrice).padStart(10)}`);
}
if (sorted2.length === 0) console.log("(no rows)");

// === Q3: Does match_registrations / registrations table exist? ===
console.log("\n=== Q3: legacy match_registrations / registration tables ===");
for (const tbl of ["match_registrations", "match_registration", "registrations", "fin_match_registrations"]) {
  const { error } = await sb.from(tbl).select("*", { count: "exact", head: true });
  if (error) {
    console.log(`  ${tbl.padEnd(28)} → NOT FOUND (${error.message.slice(0, 60)})`);
  } else {
    const { count } = await sb.from(tbl).select("*", { count: "exact", head: true });
    console.log(`  ${tbl.padEnd(28)} → exists (${count} rows)`);
  }
}
console.log("\nNote: this cockpit reads player-level registrations from mdapi_match_players (synced from MatchDay platform API) — not a 'match_registrations' table. The partner-stats code refers to 'match_registrations' in comments/types as the legacy CSV shape; the live source is mdapi_match_players via fetchJoinedMatchPlayers().");
