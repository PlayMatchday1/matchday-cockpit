// Read-only investigation: why does Atlanta's April benchmark show
// ~$1.18/member spot when other cities are $3-8?
//
// Answers questions 1, 2, 4, 5 from the brief. Question 3 (code
// construction) is answered from src/lib/financeStats.ts.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
function envVar(name) {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!m) return null;
  return m[1].replace(/^"+|"+$/g, "").trim();
}
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  envVar("NEXT_PUBLIC_SUPABASE_URL") ||
  "";
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  envVar("SUPABASE_SERVICE_ROLE_KEY") ||
  "";
if (!url || !key) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
      "Either populate .env.local or run inline: " +
      "NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/investigate-atlanta-april-benchmark.mjs",
  );
  process.exit(1);
}
const sb = createClient(url, key);

const CANON_CITIES = [
  "Austin", "Dallas", "Houston", "San Antonio",
  "Atlanta", "St. Louis", "OKC", "El Paso",
];

// Paginate a PostgREST select so we never silently cap at 1000.
async function selectAll(table, cols, filterFn) {
  const PAGE = 1000;
  let from = 0;
  const out = [];
  for (;;) {
    let q = sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// === Q1: April membership revenue per city ===
console.log("=".repeat(72));
console.log("Q1. April 2026 fin_revenue membership net by city");
console.log("    WHERE type='Membership' AND month='Apr 2026'");
console.log("=".repeat(72));
const memRev = await selectAll(
  "fin_revenue",
  "city, net",
  (q) => q.eq("type", "Membership").eq("month", "Apr 2026"),
);
const byCityRev = new Map();
for (const r of memRev) {
  const c = r.city ?? "(null)";
  byCityRev.set(c, (byCityRev.get(c) ?? 0) + Number(r.net ?? 0));
}
console.log(`city            | membership_net | rows`);
console.log(`----------------|----------------|------`);
const rowCounts = new Map();
for (const r of memRev) rowCounts.set(r.city ?? "(null)", (rowCounts.get(r.city ?? "(null)") ?? 0) + 1);
for (const [c, sum] of [...byCityRev.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
  console.log(
    `${String(c).padEnd(15)} | $${sum.toFixed(2).padStart(13)} | ${rowCounts.get(c)}`,
  );
}
console.log(`\nTotal Apr 2026 membership rows: ${memRev.length}`);
console.log(`Total Apr 2026 membership $:    $${[...byCityRev.values()].reduce((s, x) => s + x, 0).toFixed(2)}`);

// === Q2: distinct city values in April membership rows ===
console.log("\n" + "=".repeat(72));
console.log("Q2. Distinct cities in fin_revenue Apr 2026 Membership rows");
console.log("=".repeat(72));
const distinctCities = [...byCityRev.keys()].sort((a, b) => String(a).localeCompare(String(b)));
for (const c of distinctCities) {
  const canon = CANON_CITIES.includes(c) ? "✓ canonical" : "  NON-CANONICAL";
  console.log(`  ${canon}  "${c}"`);
}

// === Q4 (helper data): pull mdapi April active member spots ===
console.log("\n" + "=".repeat(72));
console.log("Q4. mdapi April member spots — direct query");
console.log("    Counting mdapi_match_players paid_status='FREE' joined to");
console.log("    mdapi_matches with start_date in [2026-04-01, 2026-05-01).");
console.log("=".repeat(72));

// Pull April matches (city_identifier + cancellation flag + field_id).
const aprMatches = await selectAll(
  "mdapi_matches",
  "api_id, city_identifier, field_id, field_title, is_cancelled, start_date",
  (q) => q.gte("start_date", "2026-04-01").lt("start_date", "2026-05-01"),
);
console.log(`mdapi_matches in April: ${aprMatches.length}`);

const matchById = new Map(aprMatches.map((m) => [m.api_id, m]));
const aprMatchIds = aprMatches.filter((m) => !m.is_cancelled).map((m) => m.api_id);
console.log(`  active (is_cancelled=false): ${aprMatchIds.length}`);
console.log(`  canceled:                    ${aprMatches.length - aprMatchIds.length}`);

// Pull players for those matches, in chunks (PostgREST .in() URL limit).
let players = [];
const CHUNK = 200;
for (let i = 0; i < aprMatchIds.length; i += CHUNK) {
  const ids = aprMatchIds.slice(i, i + CHUNK);
  const { data, error } = await sb
    .from("mdapi_match_players")
    .select("match_api_id, paid_status, promocode_id, user_type, is_cancelled, canceled_at, user_is_fake_player, is_absent")
    .in("match_api_id", ids);
  if (error) throw error;
  players.push(...(data ?? []));
}
console.log(`mdapi_match_players (April active matches): ${players.length}`);

// Mirror buildMdapiMemberSpotIndex filters:
//   skip if match cancelled, player_canceled_at non-empty, fake, absent,
//   paid_status not in {FREE, PAID}.
const memberByCityIdFromMdapi = new Map();
const allByCityIdFromMdapi = new Map(); // member + dpp + promo
let skippedFake = 0, skippedAbsent = 0, skippedCanceledPlayer = 0;
for (const p of players) {
  if (p.user_is_fake_player === true) { skippedFake++; continue; }
  if (p.is_absent === true) { skippedAbsent++; continue; }
  if (p.canceled_at || p.is_cancelled) { skippedCanceledPlayer++; continue; }
  if (p.paid_status !== "FREE" && p.paid_status !== "PAID") continue;
  const m = matchById.get(p.match_api_id);
  if (!m) continue;
  const cityId = m.city_identifier ?? "(null)";
  allByCityIdFromMdapi.set(cityId, (allByCityIdFromMdapi.get(cityId) ?? 0) + 1);
  if (p.paid_status === "FREE") {
    memberByCityIdFromMdapi.set(cityId, (memberByCityIdFromMdapi.get(cityId) ?? 0) + 1);
  }
}
console.log(
  `  skipped fake=${skippedFake} absent=${skippedAbsent} canceled-player=${skippedCanceledPlayer}`,
);
console.log("\nApril active member spots by mdapi_matches.city_identifier:");
console.log("city_id      | member_spots | all_spots");
console.log("-------------|--------------|----------");
const cityIds = new Set([...memberByCityIdFromMdapi.keys(), ...allByCityIdFromMdapi.keys()]);
for (const c of [...cityIds].sort()) {
  console.log(
    `${String(c).padEnd(12)} | ${String(memberByCityIdFromMdapi.get(c) ?? 0).padStart(12)} | ${String(allByCityIdFromMdapi.get(c) ?? 0).padStart(9)}`,
  );
}

// === Now compute via the SAME pipeline as buildMdapiMemberSpotIndex ===
// (fin_venue_fields → fin_venues.id → fin_venues.city). This is what
// the in-app `data.mdapiMemberSpots.byCityMonth.get("Atlanta|Apr 2026").member`
// actually returns.
console.log("\n" + "=".repeat(72));
console.log("Q5. byCityMonth pipeline replay for Atlanta|Apr 2026");
console.log("    Path: mdapi_match_players(FREE) → mdapi_matches.field_id");
console.log("        → fin_venue_fields.fin_venue_id → fin_venues.city");
console.log("=".repeat(72));

const venueFields = await selectAll(
  "fin_venue_fields",
  "fin_venue_id, mdapi_field_id",
);
const fieldToVenue = new Map(
  venueFields.map((r) => [r.mdapi_field_id, r.fin_venue_id]),
);
const venues = await selectAll(
  "fin_venues",
  "id, venue_name, raw_venue_name, city",
);
const venueById = new Map(venues.map((v) => [v.id, v]));

// Replay the index for April only.
const cityMemberSpotsApr = new Map();
const cityMemberSpotsAprBreakdown = new Map(); // city -> Map<venueName, count>
let droppedNoFieldId = 0, droppedNoVenueField = 0, droppedNoVenue = 0;
for (const p of players) {
  if (p.user_is_fake_player === true) continue;
  if (p.is_absent === true) continue;
  if (p.canceled_at || p.is_cancelled) continue;
  if (p.paid_status !== "FREE") continue;
  const m = matchById.get(p.match_api_id);
  if (!m) continue;
  if (m.is_cancelled) continue;
  if (m.field_id == null) { droppedNoFieldId++; continue; }
  const venueId = fieldToVenue.get(m.field_id);
  if (venueId == null) { droppedNoVenueField++; continue; }
  const v = venueById.get(venueId);
  if (!v) { droppedNoVenue++; continue; }
  cityMemberSpotsApr.set(v.city, (cityMemberSpotsApr.get(v.city) ?? 0) + 1);
  const inner = cityMemberSpotsAprBreakdown.get(v.city) ?? new Map();
  inner.set(v.venue_name, (inner.get(v.venue_name) ?? 0) + 1);
  cityMemberSpotsAprBreakdown.set(v.city, inner);
}

console.log(`Dropped — match has null field_id: ${droppedNoFieldId}`);
console.log(`Dropped — field_id not in fin_venue_fields: ${droppedNoVenueField}`);
console.log(`Dropped — venue id not in fin_venues:        ${droppedNoVenue}`);

console.log("\nApril member spots by fin_venues.city (== byCityMonth replay):");
console.log("city            | member_spots | membership_$   | $/spot");
console.log("----------------|--------------|----------------|---------");
const allCities = new Set([...cityMemberSpotsApr.keys(), ...byCityRev.keys()]);
for (const c of [...allCities].sort((a, b) => String(a).localeCompare(String(b)))) {
  const spots = cityMemberSpotsApr.get(c) ?? 0;
  const rev$ = byCityRev.get(c) ?? 0;
  const perSpot = spots > 0 ? rev$ / spots : null;
  console.log(
    `${String(c).padEnd(15)} | ${String(spots).padStart(12)} | $${rev$.toFixed(2).padStart(13)} | ${perSpot === null ? "    n/a" : `$${perSpot.toFixed(2).padStart(6)}`}`,
  );
}

// === Atlanta-specific deep dive ===
console.log("\n" + "=".repeat(72));
console.log("Q5 detail: Atlanta April member-spot breakdown by venue");
console.log("=".repeat(72));
const atlBreakdown = cityMemberSpotsAprBreakdown.get("Atlanta") ?? new Map();
console.log(`venue                                    | member_spots`);
console.log(`-----------------------------------------|-------------`);
for (const [venueName, count] of [...atlBreakdown.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(venueName).padEnd(40)} | ${String(count).padStart(11)}`);
}
const atlTotal = [...atlBreakdown.values()].reduce((s, x) => s + x, 0);
console.log(`-----------------------------------------|-------------`);
console.log(`TOTAL                                    | ${String(atlTotal).padStart(11)}`);

console.log("\nAtlanta fin_revenue Membership rows in Apr 2026:");
const atlMemRows = memRev.filter((r) => r.city === "Atlanta");
console.log(`  row count: ${atlMemRows.length}`);
console.log(`  sum net:   $${atlMemRows.reduce((s, r) => s + Number(r.net ?? 0), 0).toFixed(2)}`);

// === Sanity: are there other city-string variants for Atlanta in fin_revenue? ===
console.log("\nfin_revenue Apr 2026 Membership — variants that could BE Atlanta:");
for (const c of distinctCities) {
  if (/atl|geor|ga/i.test(c)) {
    console.log(`  match: "${c}" → $${byCityRev.get(c).toFixed(2)}`);
  }
}

// === City identifier → cockpit city mapping (so we can cross-check the
// mdapi side too) ===
console.log("\nDistinct mdapi_matches.city_identifier values present in April:");
const distinctMdapiCities = new Set(aprMatches.map((m) => m.city_identifier));
for (const c of [...distinctMdapiCities].sort()) {
  console.log(`  ${c}`);
}

// === Venue-table sanity: which fin_venues are tagged city='Atlanta'? ===
console.log("\nfin_venues with city='Atlanta':");
const atlVenues = venues.filter((v) => v.city === "Atlanta");
for (const v of atlVenues) {
  console.log(`  id=${v.id} name="${v.venue_name}" raw="${v.raw_venue_name}"`);
}
console.log(`  count: ${atlVenues.length}`);

// Also: any venues whose city LOOKS like Atlanta but is spelled differently?
console.log("\nfin_venues whose city contains 'atl'/'georg' (any case):");
for (const v of venues) {
  if (/atl|georg/i.test(v.city)) {
    if (v.city !== "Atlanta") {
      console.log(`  VARIANT: id=${v.id} city="${v.city}" venue="${v.venue_name}"`);
    }
  }
}
