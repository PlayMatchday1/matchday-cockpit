import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const serviceKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

for (const t of ["mdapi_users", "mdapi_players", "mdapi_signups", "users"]) {
  const { data, error } = await sb.from(t).select("*").limit(2);
  console.log(`${t}: error=${error?.message ?? "(none)"}, rows=${data?.length ?? "n/a"}`);
  if (data?.[0]) console.log("  cols:", Object.keys(data[0]));
}

// Also check pagination of match_players and confirm fields available for Phase 1+
console.log("\nFull match_players cohort (paginated):");
const all = [];
let offset = 0;
const PAGE = 1000;
while (true) {
  const { data, error } = await sb
    .from("mdapi_match_players")
    .select("user_id, user_email, raw, is_cancelled, user_is_fake_player, match_api_id")
    .range(offset, offset + PAGE - 1);
  if (error) { console.log("  err:", error.message); break; }
  if (!data || data.length === 0) break;
  all.push(...data);
  if (data.length < PAGE) break;
  offset += PAGE;
}
console.log(`  total rows: ${all.length}`);
const unique = new Map();
for (const r of all) {
  if (!r.user_id || r.user_is_fake_player) continue;
  if (!unique.has(r.user_id)) {
    unique.set(r.user_id, {
      user_id: r.user_id,
      email: r.user_email,
      createdAt: r.raw?.user?.createdAt,
      completedSignUpAt: r.raw?.user?.completedSignUpAt,
    });
  }
}
console.log(`  distinct non-fake user_ids: ${unique.size}`);

// Now match those to a played-1+-non-cancelled cohort
const playedAtLeastOnce = new Set();
for (const r of all) {
  if (!r.user_id || r.user_is_fake_player || r.is_cancelled) continue;
  playedAtLeastOnce.add(r.user_id);
}
console.log(`  played at least 1 non-cancelled match: ${playedAtLeastOnce.size}`);

// Earliest signup
let e = null, l = null;
for (const u of unique.values()) {
  const d = u.createdAt ? new Date(u.createdAt) : null;
  if (!d) continue;
  if (!e || d < e) e = d;
  if (!l || d > l) l = d;
}
console.log(`  signup date range: ${e?.toISOString().slice(0,10)} → ${l?.toISOString().slice(0,10)}`);
