// Reconciles the OLD Field Ranking formula (fin_revenue DPP.net, no
// privates) vs the NEW partner-dashboard formula (match-reg DAILY
// PAID + fin_revenue Private Rental) for several venues in April.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const STAFF = "matchday.com";

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

const VENUES = [
  { city: "Austin",  finVenue: "Hattrick",      fieldLike: "%hattrick%" },
  { city: "Austin",  finVenue: "NEMP",          fieldLike: "%nemp%" },
  { city: "Houston", finVenue: "ATH Pearland",  fieldLike: "%pearland%" },
  { city: "Houston", finVenue: "Stony Point",   fieldLike: "%stony point%" },
  { city: "SATX",    finVenue: "Soccer Central", fieldLike: "%soccer central%" },
];

for (const v of VENUES) {
  // OLD formula: fin_revenue DPP.net + nothing else
  const { data: dppRows } = await sb
    .from("fin_revenue")
    .select("net, gross")
    .ilike("venue", v.finVenue)
    .eq("type", "DPP")
    .gte("date", "2026-04-01")
    .lt("date", "2026-05-01");
  const oldDppNet = (dppRows ?? []).reduce((s, r) => s + Number(r.net), 0);

  // Private rentals (NEW formula adds these)
  const { data: prRows } = await sb
    .from("fin_revenue")
    .select("gross")
    .ilike("venue", v.finVenue)
    .eq("type", "Private Rental")
    .gte("date", "2026-04-01")
    .lt("date", "2026-05-01");
  const prRev = (prRows ?? []).reduce((s, r) => s + Number(r.gross), 0);

  // NEW formula: match-reg DPP from mdapi
  const matches = await pageAll(() =>
    sb.from("mdapi_matches")
      .select("api_id, is_cancelled")
      .ilike("field_title", v.fieldLike)
      .gte("start_date", "2026-04-01")
      .lt("start_date", "2026-05-01")
      .order("api_id"),
  );
  const ids = matches.map((m) => m.api_id);
  const matchById = new Map(matches.map((m) => [m.api_id, m]));
  let players = [];
  if (ids.length) {
    players = await pageAll(() =>
      sb.from("mdapi_match_players")
        .select("match_api_id, user_email, paid_status, user_type, promocode_id, amount")
        .in("match_api_id", ids)
        .order("api_id"),
    );
  }
  let dpRev = 0;
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
    dpRev += (Number(p.amount ?? 0) || 0) / 100;
  }
  const newRev = dpRev + prRev;
  const delta = newRev - oldDppNet;

  console.log(`${v.finVenue.padEnd(15)}  OLD $${oldDppNet.toFixed(2).padStart(9)}   NEW $${newRev.toFixed(2).padStart(9)}  (DPP $${dpRev.toFixed(2)} + PR $${prRev.toFixed(2)})  Δ ${delta >= 0 ? "+" : ""}$${delta.toFixed(2)}`);
}
