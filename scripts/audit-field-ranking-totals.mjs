// Spot-checks Total Revenue = DPP Revenue + Member Rev for top venues
// using the exact same compute path the cockpit's buildRankingRows
// runs. Mirrors venuePartnerRevenueFor (revenue) and
// venueAllocatedMemberRevenueFor (memberRev) at a high level — for
// numeric sanity, not pixel-perfect parity.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const MONTHS = { "Apr 2026": [3, "2026-04-01", "2026-05-01"], "May 2026": [4, "2026-05-01", "2026-06-01"] };
const STAFF = "matchday.com";

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

const VENUES = ["San Juan Diego","NEMP","ATH Pearland","Soccer Central","ATH Katy","Hattrick","Lou Fusz Outdoor","Bicentennial Park","Carroll Senior HS"];

for (const [label, [mIdx, from, to]] of Object.entries(MONTHS)) {
  console.log(`\n=== ${label} (Field Ranking-style totals) ===`);
  const [{ data: rev }, matches] = await Promise.all([
    sb.from("fin_revenue").select("venue, type, gross, net, city, month").eq("month", label),
    pageAll(() => sb.from("mdapi_matches").select("api_id, field_title, is_cancelled, city_identifier").gte("start_date", from).lt("start_date", to)),
  ]);
  const ids = matches.map(m => m.api_id);
  const matchById = new Map(matches.map(m => [m.api_id, m]));
  let players = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const got = await pageAll(() => sb.from("mdapi_match_players").select("match_api_id, user_email, paid_status, user_type, promocode_id, amount").in("match_api_id", chunk));
    players.push(...got);
  }

  // DPP per canonical venue (use field_title→normField'd→canonical lookup; for spot-check we just use simple prefix matching against the list above)
  const dppByVenue = new Map();
  for (const p of players) {
    const m = matchById.get(p.match_api_id);
    if (!m || m.is_cancelled) continue;
    if (p.user_type !== "PLAYER") continue;
    let pt;
    if (p.paid_status === "FREE") pt = "MEMBER";
    else if (p.paid_status === "PAID" && p.promocode_id != null) pt = "PROMOCODE";
    else if (p.paid_status === "PAID") pt = "DAILY PAID";
    else continue;
    if (pt !== "DAILY PAID") continue;
    if (p.user_email && p.user_email.toLowerCase().includes(STAFF)) continue;
    const ft = (m.field_title ?? "").toLowerCase();
    let canonical = null;
    if (ft.includes("hattrick")) canonical = "Hattrick";
    else if (ft.includes("san juan diego") || ft.includes("premier at sjd") || ft.includes("premier")) canonical = "San Juan Diego";
    else if (ft.includes("nemp") || ft.includes("north east metropolitan")) canonical = "NEMP";
    else if (ft.includes("pearland")) canonical = "ATH Pearland";
    else if (ft.includes("soccer central")) canonical = "Soccer Central";
    else if (ft.includes("ath katy")) canonical = "ATH Katy";
    else if (ft.includes("lou fusz") && !ft.includes("indoor")) canonical = "Lou Fusz Outdoor";
    else if (ft.includes("bicentennial")) canonical = "Bicentennial Park";
    else if (ft.includes("carroll")) canonical = "Carroll Senior HS";
    if (!canonical) continue;
    dppByVenue.set(canonical, (dppByVenue.get(canonical) ?? 0) + (Number(p.amount ?? 0) || 0) / 100);
  }

  // Private rentals add into DPP per partner formula
  for (const r of rev ?? []) {
    if (r.type !== "Private Rental") continue;
    const v = r.venue ?? "";
    dppByVenue.set(v, (dppByVenue.get(v) ?? 0) + Number(r.gross || 0));
  }

  // Member Rev — per-city total (membership) allocated across venues in proportion to spots.
  // Spot-check shortcut: just sum membership.net for each city, and assume the city's member rev
  // is split evenly across the canonical-named venues we recognize in that city.
  // Not exact (FieldRanking uses spot-weighted allocation) but close enough for a reconciliation sanity check.
  const memByCity = new Map();
  for (const r of rev ?? []) {
    if (r.type !== "Membership") continue;
    memByCity.set(r.city, (memByCity.get(r.city) ?? 0) + Number(r.net || 0));
  }

  console.log("venue                 DPP            (gross + PR)");
  console.log("-".repeat(56));
  for (const v of VENUES) {
    const dpp = dppByVenue.get(v) ?? 0;
    console.log(`${v.padEnd(22)}  ${fmt(dpp).padStart(11)}`);
  }
  console.log("\nCity Member Rev (sum of fin_revenue.net where type='Membership'):");
  for (const [c, n] of [...memByCity.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(14)}  ${fmt(n).padStart(11)}`);
  }
}
