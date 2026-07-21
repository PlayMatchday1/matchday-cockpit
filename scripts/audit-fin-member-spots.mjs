import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// 1. What months exist in fin_member_spots?
const { data: ms } = await sb.from("fin_member_spots").select("month, city, venue, member_spots, dpp_spots, other_spots");
console.log(`=== fin_member_spots — ${ms?.length ?? 0} total rows ===`);
const byMonth = new Map();
for (const r of ms ?? []) {
  byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + 1);
}
for (const [m, n] of [...byMonth.entries()].sort()) {
  console.log(`  ${m.padEnd(12)} → ${n} rows`);
}

// 2. SJD specifically (Austin) Apr vs May
console.log("\n=== San Juan Diego rows ===");
const sjd = (ms ?? []).filter(r => r.venue === "San Juan Diego");
for (const r of sjd.sort((a, b) => (a.month ?? "").localeCompare(b.month ?? ""))) {
  console.log(`  ${r.month.padEnd(12)}  member=${r.member_spots}  dpp=${r.dpp_spots}  other=${r.other_spots}`);
}

// 3. What does mdapiMemberSpots produce for SJD in May? Simulate the
//    index build by counting mdapi_match_players for SJD May matches.
console.log("\n=== Live mdapi spots for San Juan Diego, May 2026 ===");
const { data: matches } = await sb
  .from("mdapi_matches")
  .select("api_id, field_title, is_cancelled")
  .gte("start_date", "2026-05-01")
  .lt("start_date", "2026-06-01")
  .or("field_title.ilike.%san juan%,field_title.ilike.%premier at sjd%,field_title.ilike.%premier match at%");
console.log(`SJD matches in May: ${matches?.length ?? 0}`);
if ((matches?.length ?? 0) > 0) {
  const ids = matches.map(m => m.api_id);
  let players = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: ps } = await sb.from("mdapi_match_players").select("paid_status, promocode_id, user_type, is_cancelled").in("match_api_id", chunk);
    players.push(...(ps ?? []));
  }
  let mem = 0, dpp = 0, promo = 0;
  for (const p of players) {
    if (p.user_type !== "PLAYER") continue;
    if (p.is_cancelled) continue;
    if (p.paid_status === "FREE") mem++;
    else if (p.paid_status === "PAID" && p.promocode_id != null) promo++;
    else if (p.paid_status === "PAID") dpp++;
  }
  console.log(`  Live MEMBER spots:    ${mem}`);
  console.log(`  Live DAILY PAID spots: ${dpp}`);
  console.log(`  Live PROMOCODE spots: ${promo}`);
}

// 4. mdapi_subscriptions row count May vs April — rules out the "stale stripe" hypothesis
console.log("\n=== mdapi_subscriptions activation by month ===");
const { data: subs } = await sb.from("mdapi_subscriptions").select("activation_date").gte("activation_date", "2026-04-01").lt("activation_date", "2026-06-01");
let apr = 0, may = 0;
for (const s of subs ?? []) {
  const d = s.activation_date ?? "";
  if (d.startsWith("2026-04")) apr++;
  else if (d.startsWith("2026-05")) may++;
}
console.log(`  Apr activations: ${apr}`);
console.log(`  May activations: ${may}`);
