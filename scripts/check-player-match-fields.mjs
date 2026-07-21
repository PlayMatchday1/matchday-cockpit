// Read-only probe: inspect player_match team/spot fields + raw JSON.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const strip = (s) => s.trim().replace(/^["']|["']$/g, "");
const url = strip(env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1]);
const serviceKey = strip(env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1]);
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

// 1) Inspect mdapi_match_players columns + an example row.
console.log("=== mdapi_match_players: example FUTURE registration ===");
const future = await sb
  .from("mdapi_match_players")
  .select("api_id, match_api_id, user_id, team, player_number, paid_status, is_cancelled, is_absent, canceled_at, raw")
  .order("created_at", { ascending: false })
  .limit(1);
if (future.error) {
  console.log("ERR", future.error);
} else if (future.data?.length) {
  const r = future.data[0];
  console.log("Top-level fields:");
  for (const [k, v] of Object.entries(r)) {
    if (k === "raw") continue;
    console.log(`  ${k}: ${typeof v} = ${JSON.stringify(v)}`);
  }
  console.log("\nraw JSON keys:", Object.keys(r.raw ?? {}).join(", "));
  console.log("\nraw values for team-ish keys:");
  for (const k of Object.keys(r.raw ?? {})) {
    if (/team|spot|number|color/i.test(k)) {
      console.log(`  raw.${k}: ${JSON.stringify(r.raw[k])}`);
    }
  }
}

// 2) Distribution of `team` integer values across all rows.
console.log("\n=== mdapi_match_players.team distribution (recent 1000) ===");
const sample = await sb
  .from("mdapi_match_players")
  .select("team")
  .order("created_at", { ascending: false })
  .limit(1000);
if (!sample.error) {
  const counts = new Map();
  for (const r of sample.data ?? []) {
    const k = r.team === null ? "null" : String(r.team);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  team=${k}: ${v}`);
  }
}

// 3) Find a player with future bookings to validate the query path.
console.log("\n=== Probe: any player with future bookings? ===");
const upcoming = await sb
  .from("mdapi_matches")
  .select("api_id, field_title, start_date, is_cancelled")
  .gt("start_date", new Date().toISOString())
  .order("start_date", { ascending: true })
  .limit(3);
if (!upcoming.error && upcoming.data?.length) {
  console.log(`Upcoming matches sample:`);
  for (const m of upcoming.data) {
    console.log(`  api_id=${m.api_id} start=${m.start_date} cancelled=${m.is_cancelled} venue=${m.field_title}`);
  }
  // Find a registration on the first upcoming match
  const reg = await sb
    .from("mdapi_match_players")
    .select("user_id, team, player_number, is_cancelled")
    .eq("match_api_id", upcoming.data[0].api_id)
    .limit(3);
  if (!reg.error && reg.data?.length) {
    console.log(`\nSample registrations for match ${upcoming.data[0].api_id}:`);
    for (const r of reg.data) {
      console.log(`  user_id=${r.user_id} team=${r.team} player_number=${r.player_number} cancelled=${r.is_cancelled}`);
    }
  }
}

// 4) Status / state values on mdapi_matches for future rows.
console.log("\n=== mdapi_matches: any status-like field for future rows? ===");
const m0 = await sb
  .from("mdapi_matches")
  .select("*")
  .gt("start_date", new Date().toISOString())
  .limit(1)
  .maybeSingle();
if (m0.data) {
  console.log("Field list (excluding raw):");
  for (const k of Object.keys(m0.data)) {
    if (k === "raw") continue;
    console.log(`  ${k}: ${typeof m0.data[k]}`);
  }
}
