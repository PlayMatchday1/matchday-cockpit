import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// 1. Confirm column names
console.log("=== Column probe ===");
const mpProbe = await sb.from("mdapi_match_players").select("*").limit(1);
if (mpProbe.data?.[0]) {
  console.log("  mdapi_match_players columns:");
  console.log("   ", Object.keys(mpProbe.data[0]).join(", "));
}

// 2. Table sizes
console.log("\n=== Row counts (head) ===");
const tables = ["mdapi_users", "mdapi_match_players", "mdapi_matches", "mdapi_subscriptions"];
for (const t of tables) {
  const r = await sb.from(t).select("*", { count: "exact", head: true });
  console.log(`  ${t.padEnd(28)} ${r.count}`);
}

// 3. The "selectAll" pagination util the route uses pages past
// PostgREST's 1000-row cap. For an ad-hoc DISTINCT count we need
// to page ourselves. Helper:
async function paginateAll(query, pageSize = 1000) {
  let from = 0;
  let all = [];
  for (;;) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Pull every player row's flag bundle, then count distinct user_ids
// across each variant.
console.log("\n=== Pulling all mdapi_match_players rows (paginated)…");
const t0 = Date.now();
const allPlayers = await paginateAll(
  sb.from("mdapi_match_players").select("user_id, match_api_id, is_cancelled, user_is_fake_player, user_type, canceled_at").order("api_id"),
  1000,
);
console.log(`  pulled ${allPlayers.length} rows in ${Date.now()-t0}ms`);

console.log("Pulling all mdapi_matches rows (paginated)…");
const t1 = Date.now();
const allMatches = await paginateAll(
  sb.from("mdapi_matches").select("api_id, is_cancelled, start_date").order("api_id"),
  1000,
);
console.log(`  pulled ${allMatches.length} rows in ${Date.now()-t1}ms`);

const matchById = new Map();
for (const m of allMatches) matchById.set(m.api_id, m);

const now = new Date();
const variants = {};

// A: distinct users with ANY player row
variants.A_all_player_rows = new Set();
// B: at least 1 non-cancelled player row (use is_cancelled; canceled_at if exists)
variants.B_player_not_cancelled = new Set();
// C: at least 1 player row whose match is NOT cancelled
variants.C_match_not_cancelled = new Set();
// D: full Cockpit logic (player.not-cancelled AND not fake AND user_type='PLAYER' AND match exists AND match.not-cancelled)
variants.D_cockpit_logic = new Set();
// E: match started before now (already happened)
variants.E_match_in_past = new Set();
// F: same as E but excluding canceled (player + match)
variants.F_past_not_canceled = new Set();
// G: at least 1 player row where user_type='PLAYER' (no other filters)
variants.G_user_type_player = new Set();
// H: at least 1 row that's neither fake nor cancelled (player level only — most permissive realistic "played")
variants.H_real_player_uncancelled = new Set();

let nullUserId = 0;
let nullMatchId = 0;
let cancelPlayer = 0;
let fakePlayer = 0;
let nonPlayerType = 0;
let cancelMatch = 0;
let missingMatch = 0;

for (const p of allPlayers) {
  if (!p.user_id) { nullUserId++; continue; }
  // A
  variants.A_all_player_rows.add(p.user_id);
  // B
  if (!p.is_cancelled) variants.B_player_not_cancelled.add(p.user_id);
  // G
  if (p.user_type === "PLAYER") variants.G_user_type_player.add(p.user_id);
  // H
  if (!p.is_cancelled && !p.user_is_fake_player) variants.H_real_player_uncancelled.add(p.user_id);
  // C / D / E / F need the match row
  if (p.match_api_id == null) { nullMatchId++; continue; }
  const m = matchById.get(p.match_api_id);
  if (!m) { missingMatch++; continue; }
  if (!m.is_cancelled) variants.C_match_not_cancelled.add(p.user_id);
  // D: full cockpit logic
  let drop = false;
  if (p.is_cancelled) { cancelPlayer++; drop = true; }
  if (p.user_is_fake_player) { fakePlayer++; drop = true; }
  if (p.user_type !== "PLAYER") { nonPlayerType++; drop = true; }
  if (m.is_cancelled) { cancelMatch++; drop = true; }
  if (!drop) variants.D_cockpit_logic.add(p.user_id);
  // E + F
  const start = m.start_date ? new Date(m.start_date) : null;
  if (start && start < now) {
    variants.E_match_in_past.add(p.user_id);
    if (!p.is_cancelled && !m.is_cancelled) variants.F_past_not_canceled.add(p.user_id);
  }
}

console.log("\n=== Variant counts (distinct user_id) ===");
const order = ["A_all_player_rows","B_player_not_cancelled","C_match_not_cancelled","D_cockpit_logic","E_match_in_past","F_past_not_canceled","G_user_type_player","H_real_player_uncancelled"];
for (const k of order) console.log(`  ${k.padEnd(34)} ${variants[k].size.toLocaleString()}`);

console.log("\n=== Row-level filter counters (player rows DROPPED by each Cockpit filter) ===");
console.log(`  player_row.user_id NULL         ${nullUserId}`);
console.log(`  player_row.match_api_id NULL    ${nullMatchId}`);
console.log(`  player_row.is_cancelled         ${cancelPlayer}`);
console.log(`  player_row.user_is_fake_player  ${fakePlayer}`);
console.log(`  player_row.user_type != PLAYER  ${nonPlayerType}`);
console.log(`  match.is_cancelled              ${cancelMatch}`);
console.log(`  match missing from mdapi_matches ${missingMatch}`);

// Cohort window — the hero KPI is windowed by user.created_at.
// We need to also apply this to the user side. Pull mdapi_users.
console.log("\n=== Pulling mdapi_users for user-side filter context…");
const tu = Date.now();
const allUsers = await paginateAll(
  sb.from("mdapi_users").select("id, email, is_fake_player, created_at, preferable_city_normalized").order("id"),
  1000,
);
console.log(`  pulled ${allUsers.length} users in ${Date.now()-tu}ms`);

// isInternalUser blocklist is in src; can't import. Use a heuristic
// proxy: is_fake_player OR email contains @matchday OR @playmatchday
// or generic test patterns. Print both totals + heuristic-internal so
// we can compute the bound.
const isLikelyInternal = (email, isFake) => {
  if (isFake) return true;
  if (!email) return false;
  const lc = email.toLowerCase();
  return lc.includes("@matchday") || lc.includes("@playmatchday") || lc.includes("+test") || lc.startsWith("test@") || lc.startsWith("admin@");
};
let internal = 0, fake = 0;
for (const u of allUsers) {
  if (u.is_fake_player) fake++;
  if (isLikelyInternal(u.email, u.is_fake_player)) internal++;
}
console.log(`  mdapi_users total           ${allUsers.length}`);
console.log(`  mdapi_users where is_fake   ${fake}`);
console.log(`  mdapi_users heuristic-internal ${internal}`);

const realUserIds = new Set(allUsers.filter(u => !isLikelyInternal(u.email, u.is_fake_player)).map(u => u.id));

console.log("\n=== Cockpit-equivalent variant D, also intersected with NON-internal users ===");
const cockpitMinusInternal = [...variants.D_cockpit_logic].filter(id => realUserIds.has(id));
console.log(`  ${cockpitMinusInternal.length.toLocaleString()}  (this is the closest we get to the 4,470 number)`);

console.log("\n=== Cleaner question: distinct user_id in mdapi_match_players whose user row exists in mdapi_users ===");
const userIdSet = new Set(allUsers.map(u => u.id));
const inUsers = [...variants.A_all_player_rows].filter(id => userIdSet.has(id));
const realInUsers = inUsers.filter(id => realUserIds.has(id));
console.log(`  A ∩ mdapi_users               ${inUsers.length.toLocaleString()}`);
console.log(`  A ∩ mdapi_users \\ internal    ${realInUsers.length.toLocaleString()}`);

// How many distinct user_ids exist in mdapi_match_players that DON'T have a mdapi_users row?
const orphans = [...variants.A_all_player_rows].filter(id => !userIdSet.has(id));
console.log(`  player.user_ids NOT in mdapi_users  ${orphans.length.toLocaleString()}  (orphan player rows — users not synced)`);

// Sync recency probe
console.log("\n=== Sync recency probes ===");
const recentPlayer = await sb.from("mdapi_match_players").select("synced_at").order("synced_at", { ascending: false }).limit(1).maybeSingle();
const oldestPlayer = await sb.from("mdapi_match_players").select("synced_at").order("synced_at", { ascending: true }).limit(1).maybeSingle();
console.log(`  mdapi_match_players  newest synced_at: ${recentPlayer.data?.synced_at}`);
console.log(`  mdapi_match_players  oldest synced_at: ${oldestPlayer.data?.synced_at}`);

const recentMatch = await sb.from("mdapi_matches").select("synced_at, start_date").order("start_date", { ascending: false }).limit(1).maybeSingle();
const oldestMatch = await sb.from("mdapi_matches").select("synced_at, start_date").order("start_date", { ascending: true }).limit(1).maybeSingle();
console.log(`  mdapi_matches  oldest start_date:      ${oldestMatch.data?.start_date}`);
console.log(`  mdapi_matches  newest start_date:      ${recentMatch.data?.start_date}`);

const recentUser = await sb.from("mdapi_users").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();
const oldestUser = await sb.from("mdapi_users").select("created_at").order("created_at", { ascending: true }).limit(1).maybeSingle();
console.log(`  mdapi_users  oldest created_at:        ${oldestUser.data?.created_at}`);
console.log(`  mdapi_users  newest created_at:        ${recentUser.data?.created_at}`);

console.log("\n=== Top-of-funnel sanity: distinct match_api_id in player rows vs mdapi_matches.api_id ===");
const playerMatchIds = new Set(allPlayers.map(p => p.match_api_id).filter(x => x != null));
const matchIdSet = new Set(allMatches.map(m => m.api_id));
const playerMatchesInMatches = [...playerMatchIds].filter(id => matchIdSet.has(id));
const playerMatchesNotInMatches = [...playerMatchIds].filter(id => !matchIdSet.has(id));
console.log(`  distinct player.match_api_id           ${playerMatchIds.size.toLocaleString()}`);
console.log(`  player.match_api_id IN mdapi_matches   ${playerMatchesInMatches.length.toLocaleString()}`);
console.log(`  player.match_api_id NOT IN matches     ${playerMatchesNotInMatches.length.toLocaleString()}  (orphan match refs)`);
