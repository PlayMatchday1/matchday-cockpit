// Simulates the post-fix Field Ranking computation (matching the new
// venuePartnerRevenueFor logic exactly: canonicalize each match-reg
// field via the shared pipeline, then sum DAILY PAID + Private Rental
// per fin_venues.venue_name).

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const STAFF = "matchday.com";
const fmt = (n) => Number(n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

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

// Replicate normField (mdapiMatchesRead.ts) — first-stage normalization.
function normField(name) {
  const t = (name ?? "").trim();
  if (!t) return "";
  if (["San Juan Diego Catholic High School","Premier at SJD","San Juan Diego Catholic HS"].includes(t)) return "San Juan Diego";
  if (t.includes("Tourney at Soccer Central") || t.includes("Soccer Central Complex") || t.includes("Soccer Central Field")) return "Soccer Central";
  if (t.includes("ATH Pearland") || t.includes("Tourney ATH Pearland")) return "ATH Pearland";
  if (t.includes("North East Metropolitan Park") || t.includes("NEMP")) return "NEMP";
  if (t.includes("Stadium Field at Round Rock") || t.includes("Round Rock")) return "Round Rock";
  if (t.includes("Lou Fusz") && t.includes("Indoor")) return "Lou Fusz Indoor";
  if (t.includes("Lou Fusz")) return "Lou Fusz Outdoor";
  if (t.includes("Onion Creek")) return "Onion Creek";
  if (t.includes("Hammond Park")) return "Hammond Park";
  if (t.includes("PRUMC")) return "PRUMC";
  if (t.includes("Scissortail")) return "Scissortail Park";
  if (t.includes("Bicentennial")) return "Bicentennial Park";
  if (t.includes("Majestic")) return "Majestic Gardens";
  if (t.includes("PAC GLOBAL") || t.includes("PAC Global")) return "PAC Global";
  if (t.includes("STAR Soccer")) return "STAR Soccer Complex";
  if (t.includes("Hattrick")) return "The Hattrick";
  if (t.includes("Stony Point")) return "Stony Point";
  if (t.includes("Galatzan")) return "Galatzan Park";
  if (t.includes("ATH Katy")) return "ATH Katy";
  if (t.includes("Katy International")) return "Katy International";
  if (t.includes("Centennial Commons")) return "Centennial Commons";
  if (t.includes("Carroll")) return "Carroll Senior HS";
  return t;
}

// Mirror normalizeMatchName (the relevant subset for our cases).
const CROSS = {
  "Premier": "San Juan Diego",
  "SJD": "San Juan Diego",
  "Premier at SJD": "San Juan Diego",
  "Katy International Sports Complex": "KISC (Katy Intl)",
  "The Hattrick": "Hattrick",
  "Tourney ATH Pearland": "ATH Pearland",
  "Tourney at Soccer Central": "Soccer Central",
  "San Juan Diego Catholic High School": "San Juan Diego",
  "Stadium Field at Round Rock M.C.": "Round Rock",
  "North East Metropolitan Park": "NEMP",
  "Lou Fusz Athletic Complex": "Lou Fusz Outdoor",
  "Lou Fusz Athletic Training Center": "Lou Fusz Indoor",
};
const PREFIX = [
  ["ATH Katy Sunday", "ATH Katy Sunday"],
  ["ATH Pearland Tournament", "ATH Pearland"],
  ["ATH Pearland Tourney", "ATH Pearland"],
  ["Katy International Sports Complex", "KISC (Katy Intl)"],
  ["Carroll Senior High School", "Carroll Senior HS"],
  ["Katy International", "KISC (Katy Intl)"],
  ["Carroll Senior HS", "Carroll Senior HS"],
  ["Katy Intl", "KISC (Katy Intl)"],
  ["ATH Pearland", "ATH Pearland"],
  ["ATH Katy", "ATH Katy"],
  ["Soccer Central", "Soccer Central"],
  ["Onion Creek", "Onion Creek"],
  ["Hammond Park", "Hammond Park"],
  ["Round Rock", "Round Rock"],
  ["Stony Point", "Stony Point"],
  ["PAC Global", "PAC Global"],
  ["Bicentennial", "Bicentennial Park"],
  ["Scissortail", "Scissortail Park"],
  ["PRUMC", "PRUMC"],
  ["NEMP", "NEMP"],
  ["STAR", "STAR"],
  ["KISC", "KISC (Katy Intl)"],
];

function canonicalize(field, aliases) {
  let n = (field ?? "").trim();
  if (!n) return null;
  if (CROSS[n]) return CROSS[n];
  if (aliases.has(n)) return aliases.get(n);
  const nLc = n.toLowerCase();
  for (const [prefix, can] of PREFIX) {
    const pLc = prefix.toLowerCase();
    if (nLc === pLc) return can;
    if (nLc.startsWith(pLc)) {
      const next = n.charAt(prefix.length);
      if (next === "" || next === " " || next === "-" || next === "/" || /[0-9A-Za-z]/.test(next)) return can;
    }
  }
  return n;
}

// Load DB aliases
const { data: aliasRows } = await sb.from("fin_venue_aliases").select("alias, canonical_venue");
const aliases = new Map();
for (const r of aliasRows ?? []) aliases.set(r.alias, r.canonical_venue);

// Pull April matches + their players
const matches = await pageAll(() =>
  sb.from("mdapi_matches")
    .select("api_id, field_title, is_cancelled")
    .gte("start_date", "2026-04-01")
    .lt("start_date", "2026-05-01")
    .eq("is_cancelled", false)
    .order("api_id"),
);
const ids = matches.map((m) => m.api_id);
const matchById = new Map(matches.map((m) => [m.api_id, m]));
let players = [];
for (let i = 0; i < ids.length; i += 200) {
  const chunk = ids.slice(i, i + 200);
  const got = await pageAll(() =>
    sb.from("mdapi_match_players")
      .select("match_api_id, user_email, paid_status, user_type, promocode_id, is_cancelled, amount")
      .in("match_api_id", chunk)
      .order("api_id"),
  );
  players.push(...got);
}

// Aggregate DAILY PAID per canonical venue
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
  const normFieldOutput = normField(m.field_title);
  const canonical = canonicalize(normFieldOutput, aliases);
  if (!canonical) continue;
  const cents = Number(p.amount ?? 0) || 0;
  dppByVenue.set(canonical, (dppByVenue.get(canonical) ?? 0) + cents / 100);
}

// Add Private Rentals from fin_revenue (already canonical in fin_revenue.venue)
const { data: prRows } = await sb
  .from("fin_revenue")
  .select("venue, gross")
  .eq("month", "Apr 2026")
  .eq("type", "Private Rental");
const prByVenue = new Map();
for (const r of prRows ?? []) {
  const v = r.venue ?? "";
  prByVenue.set(v, (prByVenue.get(v) ?? 0) + (Number(r.gross) || 0));
}

// Pull raw fin_revenue gross per venue for sanity comparison
const { data: revRows } = await sb
  .from("fin_revenue")
  .select("venue, type, gross, net")
  .eq("month", "Apr 2026");
const grossByVenue = new Map();
const netDppByVenue = new Map();
for (const r of revRows ?? []) {
  const v = r.venue ?? "";
  if (!v) continue;
  grossByVenue.set(v, (grossByVenue.get(v) ?? 0) + Number(r.gross));
  if (r.type === "DPP") netDppByVenue.set(v, (netDppByVenue.get(v) ?? 0) + Number(r.net));
}

const allVenues = new Set([...dppByVenue.keys(), ...prByVenue.keys(), ...netDppByVenue.keys()]);
const rows = [...allVenues].map((v) => {
  const dpp = dppByVenue.get(v) ?? 0;
  const pr = prByVenue.get(v) ?? 0;
  const newRev = dpp + pr;
  const oldRev = netDppByVenue.get(v) ?? 0;
  const finGross = grossByVenue.get(v) ?? 0;
  const exceedsGross = newRev > finGross + 1; // tolerance for rounding
  return { v, oldRev, dpp, pr, newRev, finGross, exceedsGross };
}).sort((a, b) => b.newRev - a.newRev);

console.log("\nVenue                           OLD (net DPP only)     NEW (canonical, DPP+PR)     fin_revenue GROSS     Δ vs OLD     exceeds-gross?");
console.log("-".repeat(125));
for (const r of rows) {
  const delta = r.newRev - r.oldRev;
  const flag = r.exceedsGross ? "⚠ EXCEEDS" : "";
  console.log(`${r.v.padEnd(28)}  ${fmt(r.oldRev).padStart(14)}  ${fmt(r.newRev).padStart(14)}  (DPP ${fmt(r.dpp).padStart(10)} + PR ${fmt(r.pr).padStart(8)})  ${fmt(r.finGross).padStart(11)}  ${(delta>=0?"+":"")}${fmt(delta).padStart(9)}  ${flag}`);
}
