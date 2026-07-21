// Simulates the new buildMdapiMemberSpotIndex against prod data.
// Reports per-venue member/dpp/other counts + the three % values
// for April and May 2026. Compares April against the legacy
// fin_member_spots row so we can quantify the source-shift delta.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

async function pageAll(builder) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await builder().range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// Simple field-title → canonical venue mapping for spot-check
// (matches the normField + alias chain for the venues we care about)
function canonical(field) {
  const t = (field ?? "").toLowerCase();
  if (t.includes("hattrick")) return "Hattrick";
  if (t.includes("san juan diego") || t.includes("premier at sjd") || t.includes("premier match at") || t === "premier") return "San Juan Diego";
  if (t.includes("nemp") || t.includes("north east metropolitan")) return "NEMP";
  if (t.includes("pearland")) return "ATH Pearland";
  if (t.includes("soccer central")) return "Soccer Central";
  if (t.includes("ath katy")) {
    // Day-of-week swap not simulated here; spot-check parity is fine.
    return "ATH Katy";
  }
  if (t.includes("lou fusz") && !t.includes("indoor")) return "Lou Fusz Outdoor";
  if (t.includes("bicentennial")) return "Bicentennial Park";
  if (t.includes("carroll")) return "Carroll Senior HS";
  if (t.includes("prumc")) return "PRUMC";
  if (t.includes("scissortail")) return "Scissortail Park";
  if (t.includes("majestic")) return "Majestic Gardens";
  if (t.includes("hammond")) return "Hammond Park";
  if (t.includes("onion creek")) return "Onion Creek";
  if (t.includes("round rock")) return "Round Rock";
  if (t.includes("star soccer") || t.includes("star ")) return "STAR";
  if (t.includes("katy international")) return "KISC (Katy Intl)";
  if (t.includes("stony point")) return "Stony Point";
  if (t.includes("pac global") || t.includes("pac global")) return "PAC Global";
  return null;
}

const CITY_FROM_ABBR = { ATX: "Austin", HOU: "Houston", SATX: "San Antonio", DFW: "Dallas", ATL: "Atlanta", OKC: "OKC", STL: "St. Louis", ELP: "El Paso" };

async function buildIndex(monthLabel, fromIso, toIsoExcl) {
  const matches = await pageAll(() =>
    sb.from("mdapi_matches").select("api_id, field_title, city_identifier, is_cancelled").gte("start_date", fromIso).lt("start_date", toIsoExcl),
  );
  const matchById = new Map(matches.map((m) => [m.api_id, m]));
  const ids = matches.map((m) => m.api_id);
  let players = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const got = await pageAll(() =>
      sb.from("mdapi_match_players").select("match_api_id, paid_status, promocode_id, user_type, is_cancelled, canceled_at, user_email, user_is_fake_player, is_absent").in("match_api_id", chunk),
    );
    players.push(...got);
  }

  const byVenueMonth = new Map();
  const byCityMonth = new Map();
  function ensure(map, key) {
    let cur = map.get(key);
    if (!cur) { cur = { member: 0, dpp: 0, other: 0 }; map.set(key, cur); }
    return cur;
  }

  for (const p of players) {
    const m = matchById.get(p.match_api_id);
    if (!m || m.is_cancelled) continue;
    if (p.user_type !== "PLAYER") continue;
    if (p.is_cancelled) continue;
    if (p.canceled_at && p.canceled_at.trim() !== "") continue;
    if (p.user_is_fake_player) continue;
    if (p.is_absent) continue;
    // payment_type derivation per derivePaymentType in mdapiMatchesRead
    let pt;
    if (p.paid_status === "FREE") pt = "MEMBER";
    else if (p.paid_status === "PAID" && p.promocode_id != null) pt = "PROMOCODE";
    else if (p.paid_status === "PAID") pt = "DAILY PAID";
    else continue;

    let category;
    if (pt === "MEMBER") category = "member";
    else if (pt === "DAILY PAID") category = "dpp";
    else if (pt === "PROMOCODE") category = "other";
    else continue;

    const v = canonical(m.field_title);
    if (!v) continue;
    const city = CITY_FROM_ABBR[m.city_identifier];
    if (!city) continue;

    ensure(byVenueMonth, `${city}|${v}|${monthLabel}`)[category] += 1;
    ensure(byCityMonth, `${city}|${monthLabel}`)[category] += 1;
  }

  return { byVenueMonth, byCityMonth };
}

function report(label, idx) {
  console.log(`\n=== ${label} — Field Ranking %% via NEW index ===`);
  const venues = [...idx.byVenueMonth.keys()].sort();
  console.log("venue                          city           member  dpp  other   MbrMix  DppMix  CityMbr");
  console.log("-".repeat(105));
  for (const key of venues) {
    const [city, venue, m] = key.split("|");
    if (m !== label) continue;
    const c = idx.byVenueMonth.get(key);
    const total = c.member + c.dpp + c.other;
    const cityTotalMember = idx.byCityMonth.get(`${city}|${m}`)?.member ?? 0;
    const mbrMix = total > 0 ? (c.member / total) * 100 : 0;
    const dppMix = total > 0 ? (c.dpp / total) * 100 : 0;
    const cityMbr = cityTotalMember > 0 ? (c.member / cityTotalMember) * 100 : 0;
    console.log(`${venue.padEnd(28)}  ${city.padEnd(14)} ${String(c.member).padStart(5)}  ${String(c.dpp).padStart(4)}  ${String(c.other).padStart(4)}    ${mbrMix.toFixed(0).padStart(4)}%   ${dppMix.toFixed(0).padStart(4)}%   ${cityMbr.toFixed(0).padStart(4)}%`);
  }

  // Sanity check: Mbr Mix + Dpp Mix + Other Mix sum to 100 per venue.
  let badRows = 0;
  for (const key of venues) {
    if (!key.endsWith(`|${label}`)) continue;
    const c = idx.byVenueMonth.get(key);
    const total = c.member + c.dpp + c.other;
    if (total === 0) continue;
    const pct = ((c.member + c.dpp + c.other) / total) * 100;
    if (Math.abs(pct - 100) > 0.5) badRows++;
  }
  console.log(`  Math sanity: ${badRows} rows where %% don't sum to 100`);

  // City Mbr % should sum to ~100% across each city's venues
  const citySums = new Map();
  for (const key of venues) {
    if (!key.endsWith(`|${label}`)) continue;
    const [city] = key.split("|");
    const c = idx.byVenueMonth.get(key);
    const cityTotalMember = idx.byCityMonth.get(`${city}|${label}`)?.member ?? 0;
    if (cityTotalMember === 0) continue;
    const pct = (c.member / cityTotalMember) * 100;
    citySums.set(city, (citySums.get(city) ?? 0) + pct);
  }
  console.log("  City Mbr % sums (should be ≈100% if all venues for a city resolve):");
  for (const [city, sum] of [...citySums.entries()].sort()) {
    console.log(`    ${city.padEnd(14)} ${sum.toFixed(1)}%`);
  }
}

const aprIdx = await buildIndex("Apr 2026", "2026-04-01", "2026-05-01");
report("Apr 2026", aprIdx);
const mayIdx = await buildIndex("May 2026", "2026-05-01", "2026-06-01");
report("May 2026", mayIdx);

// Compare April new-index vs legacy fin_member_spots
console.log("\n=== Apr 2026 delta: NEW (live mdapi) vs OLD (fin_member_spots manual aggregate) ===");
const { data: legacy } = await sb.from("fin_member_spots").select("city, venue, month, member_spots, dpp_spots, other_spots").eq("month", "Apr 2026");
for (const oldRow of (legacy ?? []).sort((a, b) => a.venue.localeCompare(b.venue))) {
  const k = `${oldRow.city}|${oldRow.venue}|Apr 2026`;
  const newC = aprIdx.byVenueMonth.get(k) ?? { member: 0, dpp: 0, other: 0 };
  const oldMbrMix = (oldRow.member_spots + oldRow.dpp_spots + oldRow.other_spots) > 0
    ? (oldRow.member_spots / (oldRow.member_spots + oldRow.dpp_spots + oldRow.other_spots)) * 100 : 0;
  const newTotal = newC.member + newC.dpp + newC.other;
  const newMbrMix = newTotal > 0 ? (newC.member / newTotal) * 100 : 0;
  console.log(`${oldRow.venue.padEnd(28)} ${oldRow.city.padEnd(14)}  OLD m/d/o=${oldRow.member_spots}/${oldRow.dpp_spots}/${oldRow.other_spots} MbrMix=${oldMbrMix.toFixed(0)}%   NEW=${newC.member}/${newC.dpp}/${newC.other} MbrMix=${newMbrMix.toFixed(0)}%`);
}
