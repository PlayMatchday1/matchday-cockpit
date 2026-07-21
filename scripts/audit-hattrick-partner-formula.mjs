import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// Mirror partnerStats.fetchPartnerRows: pull mdapi matches+players for
// any field whose title contains "Hattrick". Compute the same DPP sum
// + Private Rental sum for April 2026.

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

// Find Hattrick matches in April
const matches = await pageAll(() =>
  sb.from("mdapi_matches")
    .select("api_id, field_title, start_date, is_cancelled")
    .ilike("field_title", "%hattrick%")
    .gte("start_date", "2026-04-01")
    .lt("start_date", "2026-05-01")
    .order("api_id"),
);
console.log(`Hattrick matches in April: ${matches.length}`);
const ids = matches.map((m) => m.api_id);

// Pull players for those matches
const players = await pageAll(() =>
  sb.from("mdapi_match_players")
    .select("match_api_id, user_email, paid_status, user_type, promocode_id, is_cancelled, canceled_at, amount")
    .in("match_api_id", ids)
    .order("api_id"),
);

const matchById = new Map(matches.map((m) => [m.api_id, m]));

// Mirror partner-dashboard active filter + DAILY-PAID rule
const STAFF = "matchday.com";
let dpRev = 0;
let dppRows = 0;
let staffSkipped = 0;
let cancelSkipped = 0;
for (const p of players) {
  const m = matchById.get(p.match_api_id);
  if (!m) continue;
  // Active reg: match not canceled, player not canceled, payment type allowed
  if (m.is_cancelled) { cancelSkipped++; continue; }
  // Note: partner dashboard does NOT exclude player_canceled — only match_canceled.
  if (p.user_type !== "PLAYER") continue;

  // Determine payment_type per cockpit's Phase-5b mapping
  // FREE → MEMBER, PAID+promocode → PROMOCODE, PAID no promo → DAILY PAID
  let paymentType;
  if (p.paid_status === "FREE") paymentType = "MEMBER";
  else if (p.paid_status === "PAID" && p.promocode_id != null) paymentType = "PROMOCODE";
  else if (p.paid_status === "PAID") paymentType = "DAILY PAID";
  else continue; // WAITING etc.

  if (paymentType !== "DAILY PAID") continue;

  // Staff filter
  if (p.user_email && p.user_email.toLowerCase().includes(STAFF)) { staffSkipped++; continue; }

  // amount is in cents (Stripe convention) — convert to dollars.
  dpRev += (Number(p.amount ?? 0) || 0) / 100;
  dppRows++;
}
console.log(`DPP from match registrations (April): $${dpRev.toFixed(2)} across ${dppRows} player rows`);
console.log(`  (skipped ${staffSkipped} staff rows, ${cancelSkipped} canceled rows)`);

// Add private rentals
const { data: prRows } = await sb
  .from("fin_revenue")
  .select("date, gross, type, venue")
  .ilike("venue", "%hattrick%")
  .eq("type", "Private Rental")
  .gte("date", "2026-04-01")
  .lt("date", "2026-05-01");
const prRev = (prRows ?? []).reduce((s, r) => s + (Number(r.gross) || 0), 0);
console.log(`Private Rentals (fin_revenue, April): $${prRev.toFixed(2)} across ${(prRows ?? []).length} rows`);

console.log(`\nPartner-dashboard formula total: $${(dpRev + prRev).toFixed(2)}`);
console.log(`(Expected ~$1,910 per user spec)`);

// Compare to fin_revenue.net DPP (Field Ranking current formula)
const { data: dppFr } = await sb
  .from("fin_revenue")
  .select("gross, fees, net")
  .ilike("venue", "%hattrick%")
  .eq("type", "DPP")
  .gte("date", "2026-04-01")
  .lt("date", "2026-05-01");
const dppGross = (dppFr ?? []).reduce((s, r) => s + Number(r.gross), 0);
const dppNet = (dppFr ?? []).reduce((s, r) => s + Number(r.net), 0);
const dppFees = (dppFr ?? []).reduce((s, r) => s + Number(r.fees), 0);
console.log(`\nfin_revenue DPP (Field Ranking source today):`);
console.log(`  gross=$${dppGross.toFixed(2)}, net=$${dppNet.toFixed(2)}, fees=$${dppFees.toFixed(2)}`);
console.log(`(Net is what Field Ranking sums — user reported $1,327)`);
