import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const serviceKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Try every plausible user-table name.
const candidates = [
  "mdapi_users",
  "mdapi_user",
  "mdapi_players",
  "mdapi_player",
  "mdapi_signups",
  "mdapi_registrations",
  "mdapi_member_signups",
  "users",
  "match_users",
  "matchday_users",
  "matchday_players",
];

for (const t of candidates) {
  const { count, error } = await sb
    .from(t)
    .select("*", { count: "exact", head: true });
  if (error) {
    console.log(`  ${t}: NOT FOUND (${error.code ?? error.message?.slice(0, 50)})`);
  } else {
    console.log(`  ${t}: ✓ exists (${count} rows)`);
  }
}

console.log(
  "\nReconstructing user cohort from mdapi_match_players raw.user.createdAt:",
);
const { data: mpAll } = await sb
  .from("mdapi_match_players")
  .select("user_id, user_email, user_first_name, user_last_name, raw, match_api_id, is_cancelled, user_is_fake_player");
console.log(`  total rows pulled: ${mpAll?.length ?? 0}`);

const userMap = new Map();
for (const r of mpAll ?? []) {
  if (!r.user_id) continue;
  if (r.user_is_fake_player) continue;
  if (!userMap.has(r.user_id)) {
    userMap.set(r.user_id, {
      user_id: r.user_id,
      email: r.user_email,
      first_name: r.user_first_name,
      last_name: r.user_last_name,
      createdAt: r.raw?.user?.createdAt ?? null,
      completedSignUpAt: r.raw?.user?.completedSignUpAt ?? null,
      match_count: 0,
      non_cancelled_count: 0,
    });
  }
  const u = userMap.get(r.user_id);
  u.match_count += 1;
  if (!r.is_cancelled) u.non_cancelled_count += 1;
}
console.log(`  distinct (non-fake) user_ids in match_players: ${userMap.size}`);

const withCreatedAt = [...userMap.values()].filter((u) => u.createdAt);
console.log(`  users with raw.user.createdAt populated: ${withCreatedAt.length}`);

const withCompletedSignUpAt = [...userMap.values()].filter(
  (u) => u.completedSignUpAt,
);
console.log(
  `  users with raw.user.completedSignUpAt populated: ${withCompletedSignUpAt.length}`,
);

// Earliest/latest createdAt — does raw.user.createdAt give us a reasonable signup-date series?
let earliest = null;
let latest = null;
for (const u of withCreatedAt) {
  const d = new Date(u.createdAt);
  if (!earliest || d < earliest) earliest = d;
  if (!latest || d > latest) latest = d;
}
console.log(
  `  createdAt range: ${earliest?.toISOString().slice(0, 10)} → ${latest?.toISOString().slice(0, 10)}`,
);

// Same for the subscriptions side
const { data: subsAll } = await sb
  .from("mdapi_subscriptions")
  .select("user_id, city_identifier, status, price, member_email, first_name, last_name");
const subMap = new Map();
for (const s of subsAll ?? []) {
  if (!s.user_id) continue;
  if (!subMap.has(s.user_id)) subMap.set(s.user_id, []);
  subMap.get(s.user_id).push(s);
}
console.log(`\n  distinct user_ids in subscriptions: ${subMap.size}`);

// Cross — how many users in match_players also in subscriptions?
let bothCount = 0;
for (const id of userMap.keys()) if (subMap.has(id)) bothCount += 1;
console.log(
  `  match_player users also in subscriptions: ${bothCount} (${((bothCount / userMap.size) * 100).toFixed(1)}%)`,
);

// Subscription users NOT in match_players (joined the membership without ever playing? interesting cohort)
let subOnly = 0;
for (const id of subMap.keys()) if (!userMap.has(id)) subOnly += 1;
console.log(
  `  subscription users with no match_player rows: ${subOnly}`,
);

// City inference: what does subscriptions.city_identifier look like?
const cityIds = new Map();
for (const s of subsAll ?? []) {
  cityIds.set(
    s.city_identifier,
    (cityIds.get(s.city_identifier) ?? 0) + 1,
  );
}
console.log("\n  subscriptions.city_identifier distribution:");
console.table(
  [...cityIds.entries()]
    .map(([k, v]) => ({ city_identifier: k, count: v }))
    .sort((a, b) => b.count - a.count),
);

// Is there city_name on matches we can use as the canonical city?
// Already have mdapi_matches.city_identifier and city_name from earlier probe.
const { data: matchCity } = await sb
  .from("mdapi_matches")
  .select("city_identifier, city_name")
  .limit(2000);
const matchCityMap = new Map();
for (const m of matchCity ?? []) {
  const k = `${m.city_identifier} | ${m.city_name}`;
  matchCityMap.set(k, (matchCityMap.get(k) ?? 0) + 1);
}
console.log("\n  mdapi_matches city_identifier → city_name (sample 2000):");
console.table(
  [...matchCityMap.entries()].map(([combo, n]) => ({ combo, count: n })),
);
