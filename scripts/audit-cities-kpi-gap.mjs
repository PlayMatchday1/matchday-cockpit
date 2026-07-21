import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

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

// (a) "True" scheduled — direct from mdapi_matches
const matches = await pageAll(() =>
  sb.from("mdapi_matches")
    .select("api_id, city_identifier, field_title, start_date, is_cancelled")
    .gte("start_date", `${WEEK_START}T00:00:00Z`)
    .lt("start_date", `${WEEK_END_EXCLUSIVE}T00:00:00Z`)
    .order("api_id"),
);
const trueDistinct = new Set();
const trueDistinctNonCancelled = new Set();
const trueByCity = new Map();
const trueByDay = new Map();
for (const m of matches) {
  // The cockpit dedups by (matchStart timestamp, field) — start_date
  // string contains the timestamp; field_title is normField'd in code
  // but we mirror raw here for an apples-to-apples count.
  const k = `${m.start_date}|${m.field_title ?? ""}`;
  trueDistinct.add(k);
  if (!m.is_cancelled) trueDistinctNonCancelled.add(k);
  // Per-city (using city_identifier directly)
  const c = m.city_identifier ?? "?";
  trueByCity.set(c, (trueByCity.get(c) ?? 0) + 1);
  // Per-day (Central wall-clock — start_date is misleading-Z but its
  // YYYY-MM-DD portion already matches the venue-local day)
  const day = (m.start_date ?? "").slice(0, 10);
  trueByDay.set(day, (trueByDay.get(day) ?? 0) + 1);
}
console.log(`=== (a) DIRECT from mdapi_matches (Mon ${WEEK_START} → Sun 2026-05-17) ===`);
console.log(`  Total rows:                   ${matches.length}`);
console.log(`  Distinct (start_date, field): ${trueDistinct.size}`);
console.log(`  Non-cancelled distinct:       ${trueDistinctNonCancelled.size}`);

// (b) "Visible to cockpit" — matches that have at least one player row
const matchIds = matches.map((m) => m.api_id);
let players = [];
for (let i = 0; i < matchIds.length; i += 200) {
  const chunk = matchIds.slice(i, i + 200);
  const got = await pageAll(() =>
    sb.from("mdapi_match_players")
      .select("match_api_id, paid_status, user_type, is_cancelled")
      .in("match_api_id", chunk)
      .order("api_id"),
  );
  players.push(...got);
}

// Reproduce mapJoinedRow filter: PLAYER user_type, status FREE or PAID.
// Looking at mdapiMatchesRead, the only drop is WAITING; mapJoinedRow
// keeps everything else and the join only emits a row per player.
const visibleMatchIds = new Set();
for (const p of players) {
  // mdapiMatchesRead doesn't drop player rows beyond the upstream
  // paid_status filter; the JoinedMatchPlayerRow output includes every
  // player joined to its match. Any match with ≥1 player → visible.
  // (We refine below for "PLAYER user_type only", matching cityStats's
  // implicit assumption.)
  if (p.user_type !== "PLAYER") continue;
  visibleMatchIds.add(p.match_api_id);
}
const visibleDistinct = new Set();
const visibleDistinctNonCancelled = new Set();
const visibleByCity = new Map();
const visibleByDay = new Map();
for (const m of matches) {
  if (!visibleMatchIds.has(m.api_id)) continue;
  const k = `${m.start_date}|${m.field_title ?? ""}`;
  visibleDistinct.add(k);
  if (!m.is_cancelled) visibleDistinctNonCancelled.add(k);
  const c = m.city_identifier ?? "?";
  visibleByCity.set(c, (visibleByCity.get(c) ?? 0) + 1);
  const day = (m.start_date ?? "").slice(0, 10);
  visibleByDay.set(day, (visibleByDay.get(day) ?? 0) + 1);
}
console.log(`\n=== (b) VIA mdapi_match_players join (cockpit's getWeeklyCancellationStats) ===`);
console.log(`  Distinct (start_date, field):       ${visibleDistinct.size}`);
console.log(`  Non-cancelled distinct (excludes empty): ${visibleDistinctNonCancelled.size}`);
console.log(`  GAP vs direct: ${trueDistinct.size - visibleDistinct.size} matches missing`);

// Per-day gap
console.log(`\n=== Day-by-day breakdown ===`);
console.log(`day        direct  via-join  gap`);
for (let i = 0; i < 7; i++) {
  const d = new Date(`${WEEK_START}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  const day = d.toISOString().slice(0, 10);
  const direct = trueByDay.get(day) ?? 0;
  const visible = visibleByDay.get(day) ?? 0;
  console.log(`${day}  ${String(direct).padStart(6)}  ${String(visible).padStart(8)}  ${String(direct - visible).padStart(3)}`);
}

// Per-city gap (focus on ATX for the user's specific question)
console.log(`\n=== Per-city breakdown ===`);
console.log(`city  direct  via-join  gap`);
const cities = new Set([...trueByCity.keys(), ...visibleByCity.keys()]);
for (const c of [...cities].sort()) {
  const direct = trueByCity.get(c) ?? 0;
  const visible = visibleByCity.get(c) ?? 0;
  console.log(`${c.padEnd(5)}  ${String(direct).padStart(6)}  ${String(visible).padStart(8)}  ${String(direct - visible).padStart(3)}`);
}

// Which specific matches are "empty"? Sample for grounding.
console.log(`\n=== Sample of 'invisible' (empty) matches missed by the join ===`);
let shown = 0;
for (const m of matches) {
  if (visibleMatchIds.has(m.api_id)) continue;
  if (m.is_cancelled) continue;
  console.log(`  ${m.start_date}  ${m.city_identifier}  ${m.field_title}  (id=${m.api_id})`);
  if (++shown >= 12) break;
}
console.log(`  (and ${trueDistinct.size - visibleDistinct.size - shown} more not shown)`);
