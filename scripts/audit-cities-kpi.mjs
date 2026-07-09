import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// ISO week containing 2026-05-11..2026-05-17 (Mon..Sun)
const WEEK_START = "2026-05-11";
const WEEK_END_EXCLUSIVE = "2026-05-18";

async function pageAll(builder) {
  const out = [];
  for (let from = 0;; from += 1000) {
    const { data, error } = await builder().range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// 1. mdapi_matches with start_date in the week (start_date stores
//    venue-local wall-clock as misleading-Z; for "is in this Central
//    week" the wall-clock day check is what we want).
const matches = await pageAll(() =>
  sb.from("mdapi_matches")
    .select("api_id, city_identifier, field_title, start_date, is_cancelled")
    .gte("start_date", `${WEEK_START}T00:00:00Z`)
    .lt("start_date", `${WEEK_END_EXCLUSIVE}T00:00:00Z`)
    .order("api_id"),
);

const scheduledCount = matches.length;
const cancelled = matches.filter((m) => m.is_cancelled).length;
const ran = scheduledCount - cancelled;
console.log("=== mdapi_matches for Mon 2026-05-11 → Sun 2026-05-17 ===");
console.log(`  scheduled (incl. cancelled): ${scheduledCount}`);
console.log(`  cancelled:                   ${cancelled}`);
console.log(`  ran (= scheduled - cancelled): ${ran}`);
console.log(`  cancel rate: ${scheduledCount === 0 ? 0 : Math.round((cancelled/scheduledCount)*100)}%`);

// Distinct (field_title, start_date) key — what getWeeklyCancellationStats does
const distinctKeys = new Set();
const distinctCancelled = new Set();
for (const m of matches) {
  const key = `${m.start_date}|${m.field_title ?? ""}`;
  distinctKeys.add(key);
  if (m.is_cancelled) distinctCancelled.add(key);
}
console.log(`\nDistinct (field, match_start) keys: ${distinctKeys.size}`);
console.log(`Distinct cancelled keys:             ${distinctCancelled.size}`);

// 2. Spots booked = non-cancelled player rows on non-cancelled matches
const matchIds = matches.map((m) => m.api_id);
let players = [];
for (let i = 0; i < matchIds.length; i += 200) {
  const chunk = matchIds.slice(i, i + 200);
  const got = await pageAll(() =>
    sb.from("mdapi_match_players")
      .select("match_api_id, is_cancelled, canceled_at, user_type, user_is_fake_player, paid_status")
      .in("match_api_id", chunk)
      .order("api_id"),
  );
  players.push(...got);
}

// Mirror getWeeklySpots filter: !matchCanceled && playerCanceledAt === null
const matchById = new Map(matches.map((m) => [m.api_id, m]));
let spotsBooked = 0;
let totalPlayerRows = 0;
let activePlayerRows = 0;
for (const p of players) {
  totalPlayerRows++;
  const m = matchById.get(p.match_api_id);
  if (!m) continue;
  if (m.is_cancelled) continue;
  if (p.canceled_at && p.canceled_at.trim() !== "") continue;
  // Spots = anything not cancelled — note this includes MEMBER/PROMOCODE/DAILY PAID.
  // useMatchData uses fetchJoinedMatchPlayers which already filters out WAITING.
  // Approximate by requiring a valid paid_status.
  if (!["FREE", "PAID"].includes(p.paid_status)) continue;
  if (p.user_type !== "PLAYER") continue;
  spotsBooked++;
  activePlayerRows++;
}
console.log(`\nPlayer rows (raw):                   ${totalPlayerRows}`);
console.log(`Spots booked (Card 1 subtitle calc): ${spotsBooked}`);
console.log(`Card 1 "matches" formula = spots/18 = ${(spotsBooked/18).toFixed(3)} → rounds to ${(Math.round((spotsBooked/18)*10)/10).toFixed(1)}`);

// 3. Active members — mirror useMembers + isActiveMember exactly
const subs = await pageAll(() =>
  sb.from("mdapi_subscriptions")
    .select("status, price, member_email, activation_date, canceled_at, city_identifier")
    .order("membership_id"),
);
const INTERNAL_RX = /@matchday\.|@playmatchday\./i;
// cityFromAbbr drops members with unmapped city codes — replicate by
// requiring city_identifier matches the canonical set.
const KNOWN_CITY_ABBRS = new Set(["ATX","ATL","DFW","HOU","OKC","SATX","STL","ELP","KSC","KIC"]);
let activeCount = 0;
let droppedCity = 0;
let droppedPrice = 0;
let droppedEmail = 0;
let droppedStatus = 0;
let droppedIncomplete = 0;
for (const s of subs ?? []) {
  if (!s.city_identifier || !KNOWN_CITY_ABBRS.has(s.city_identifier)) { droppedCity++; continue; }
  const priceCents = Math.round((Number(s.price ?? 0)) * 100);
  if (priceCents <= 0) { droppedPrice++; continue; }
  if (s.member_email && INTERNAL_RX.test(s.member_email)) { droppedEmail++; continue; }
  if (s.status?.toUpperCase().startsWith("INCOMPLETE")) { droppedIncomplete++; continue; }
  if (s.status !== "ACTIVE") { droppedStatus++; continue; }
  activeCount++;
}
console.log(`\nActive paid members (Card 4): ${activeCount}`);
console.log(`  (dropped: unmapped city=${droppedCity}, zero price=${droppedPrice}, internal email=${droppedEmail}, INCOMPLETE=${droppedIncomplete}, non-ACTIVE status=${droppedStatus})`);
console.log(`  Total subs rows: ${(subs ?? []).length}`);

// 4. Reconciliation check
console.log(`\n=== Reconciliation ===`);
console.log(`If Card 2 shows "58 of 59 ran" then 59 = distinct (field, match_start) scheduled keys.`);
console.log(`If Card 1 shows 26.3 with subtitle "474 spots booked" then matches = 474/18 = ${(474/18).toFixed(3)}.`);
console.log(`Ratio: ${scheduledCount} matches × ${(spotsBooked/scheduledCount).toFixed(1)} avg spots = ${(scheduledCount * spotsBooked / scheduledCount).toFixed(0)}`);
console.log(`But Card 1's "matches" denominator is the hardcoded MATCH_DENOMINATOR=18, not the actual avg.`);
