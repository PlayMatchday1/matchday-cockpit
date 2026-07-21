import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const serviceKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const sectionBreak = "\n" + "=".repeat(70) + "\n";

// ---------------------------------------------------------------
console.log("1. SCHEMA — app_users");
// ---------------------------------------------------------------
const { data: u1, error: e1 } = await sb.from("app_users").select("*").limit(1);
if (e1) {
  console.log("  ERROR:", e1.message);
} else {
  console.log("  columns:", Object.keys(u1?.[0] ?? {}));
  if (u1?.[0]) {
    console.log("  sample row:", JSON.stringify(u1[0], null, 2));
  }
}

console.log(sectionBreak + "2. SCHEMA — mdapi_match_players");
const { data: mp1 } = await sb.from("mdapi_match_players").select("*").limit(1);
console.log("  columns:", Object.keys(mp1?.[0] ?? {}));
if (mp1?.[0]) console.log("  sample row:", JSON.stringify(mp1[0], null, 2));

console.log(sectionBreak + "3. SCHEMA — mdapi_subscriptions");
const { data: s1 } = await sb.from("mdapi_subscriptions").select("*").limit(1);
console.log("  columns:", Object.keys(s1?.[0] ?? {}));
if (s1?.[0]) console.log("  sample row:", JSON.stringify(s1[0], null, 2));

console.log(sectionBreak + "4. SCHEMA — mdapi_matches (for date join)");
const { data: m1 } = await sb.from("mdapi_matches").select("*").limit(1);
console.log("  columns:", Object.keys(m1?.[0] ?? {}));
if (m1?.[0]) console.log("  sample row:", JSON.stringify(m1[0], null, 2));

// ---------------------------------------------------------------
console.log(sectionBreak + "5. COUNTS");
// ---------------------------------------------------------------
const { count: totalUsers } = await sb
  .from("app_users")
  .select("*", { count: "exact", head: true });
console.log(`  app_users total: ${totalUsers}`);

const { count: matchPlayersTotal } = await sb
  .from("mdapi_match_players")
  .select("*", { count: "exact", head: true });
console.log(`  mdapi_match_players total: ${matchPlayersTotal}`);

const { count: subsTotal } = await sb
  .from("mdapi_subscriptions")
  .select("*", { count: "exact", head: true });
console.log(`  mdapi_subscriptions total: ${subsTotal}`);

const { count: matchesTotal } = await sb
  .from("mdapi_matches")
  .select("*", { count: "exact", head: true });
console.log(`  mdapi_matches total: ${matchesTotal}`);

// ---------------------------------------------------------------
console.log(sectionBreak + "6. app_users — home_city distribution");
// ---------------------------------------------------------------
// Fetch all home_city values (anticipate < 5k rows; service role bypasses limits)
const { data: usersAll } = await sb
  .from("app_users")
  .select("id, user_id, email, home_city, created_at, is_admin");
console.log(`  rows fetched: ${usersAll?.length ?? 0}`);
const byHomeCity = new Map();
let nullHC = 0;
for (const u of usersAll ?? []) {
  const k = (u.home_city ?? "").trim();
  if (!k) {
    nullHC += 1;
    continue;
  }
  byHomeCity.set(k, (byHomeCity.get(k) ?? 0) + 1);
}
console.log(`  null/empty home_city: ${nullHC}`);
console.log("  per-city counts:");
console.table(
  [...byHomeCity.entries()]
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count),
);

// ---------------------------------------------------------------
console.log(sectionBreak + "7. is_admin distribution (filter consideration)");
// ---------------------------------------------------------------
const adminCount = (usersAll ?? []).filter((u) => u.is_admin).length;
console.log(`  is_admin=true: ${adminCount}`);
console.log(`  non-admin: ${(usersAll?.length ?? 0) - adminCount}`);

// ---------------------------------------------------------------
console.log(sectionBreak + "8. JOIN — app_users.user_id present in mdapi_match_players");
// ---------------------------------------------------------------
// Sample distinct user_ids from match_players to see what shape they are.
const { data: mpSample } = await sb
  .from("mdapi_match_players")
  .select("user_id, match_id, status")
  .limit(2000);
const distinctMpUsers = new Set();
let mpStatuses = new Map();
for (const r of mpSample ?? []) {
  if (r.user_id) distinctMpUsers.add(r.user_id);
  mpStatuses.set(r.status, (mpStatuses.get(r.status) ?? 0) + 1);
}
console.log(`  match_players sample: ${mpSample?.length ?? 0} rows`);
console.log(`  distinct user_ids in sample: ${distinctMpUsers.size}`);
console.log("  status distribution in sample:");
console.table(
  [...mpStatuses.entries()].map(([status, n]) => ({ status, count: n })),
);

// Sample app_users.user_id shape
const sampleUserIds = (usersAll ?? [])
  .slice(0, 5)
  .map((u) => ({ app_users_id: u.id, user_id: u.user_id, email: u.email }));
console.log("  sample app_users (first 5):");
console.table(sampleUserIds);

// Try joining: pull all mdapi_match_players with user_id, see overlap
const { data: mpAll } = await sb
  .from("mdapi_match_players")
  .select("user_id, status, match_id");
console.log(`  match_players full pull: ${mpAll?.length ?? 0}`);
const allMpUsers = new Set();
const nonCancelledMpUsers = new Set();
for (const r of mpAll ?? []) {
  if (!r.user_id) continue;
  allMpUsers.add(r.user_id);
  if (
    r.status &&
    !String(r.status).toLowerCase().includes("cancel")
  ) {
    nonCancelledMpUsers.add(r.user_id);
  }
}
console.log(`  distinct user_ids in match_players (any status): ${allMpUsers.size}`);
console.log(
  `  distinct user_ids non-cancelled: ${nonCancelledMpUsers.size}`,
);

// Check overlap with app_users
const appUserIds = new Set((usersAll ?? []).map((u) => u.user_id));
let overlap = 0;
for (const id of nonCancelledMpUsers) if (appUserIds.has(id)) overlap += 1;
console.log(
  `  overlap (app_users.user_id ∈ non-cancelled match_players): ${overlap} of ${appUserIds.size} app_users (${((overlap / appUserIds.size) * 100).toFixed(1)}%)`,
);

// ---------------------------------------------------------------
console.log(
  sectionBreak + "9. SUBSCRIPTION OVERLAP — paid+ACTIVE",
);
// ---------------------------------------------------------------
const { data: subsAll } = await sb
  .from("mdapi_subscriptions")
  .select("user_id, status, price");
const activeMembers = new Set();
let statusCounts = new Map();
for (const s of subsAll ?? []) {
  statusCounts.set(s.status, (statusCounts.get(s.status) ?? 0) + 1);
  if (
    s.status === "ACTIVE" &&
    s.price !== null &&
    Number(s.price) > 0
  ) {
    if (s.user_id) activeMembers.add(s.user_id);
  }
}
console.log("  subscription status distribution:");
console.table(
  [...statusCounts.entries()].map(([status, n]) => ({ status, count: n })),
);
console.log(`  distinct user_ids ACTIVE+paid: ${activeMembers.size}`);
let memberOverlap = 0;
for (const id of activeMembers) if (appUserIds.has(id)) memberOverlap += 1;
console.log(
  `  overlap with app_users: ${memberOverlap} of ${activeMembers.size} (${((memberOverlap / Math.max(1, activeMembers.size)) * 100).toFixed(1)}%)`,
);

// ---------------------------------------------------------------
console.log(sectionBreak + "10. RECENT signups (sanity for new-this-week / month)");
// ---------------------------------------------------------------
const now = new Date();
const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
let last7 = 0;
let last30 = 0;
for (const u of usersAll ?? []) {
  const d = u.created_at ? new Date(u.created_at) : null;
  if (!d) continue;
  if (d >= oneWeekAgo) last7 += 1;
  if (d >= oneMonthAgo) last30 += 1;
}
console.log(`  signups in last 7 days: ${last7}`);
console.log(`  signups in last 30 days: ${last30}`);

// Earliest + latest created_at
let earliest = null;
let latest = null;
for (const u of usersAll ?? []) {
  if (!u.created_at) continue;
  const d = new Date(u.created_at);
  if (!earliest || d < earliest) earliest = d;
  if (!latest || d > latest) latest = d;
}
console.log(
  `  created_at range: ${earliest?.toISOString().slice(0, 10)} → ${latest?.toISOString().slice(0, 10)}`,
);
