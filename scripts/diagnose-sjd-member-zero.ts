// Diagnose: SJD matches in Apr 27 - May 3 week show Member $0 even
// when members played. Investigation only — no code changes.
//
// Steps:
//  1. Find the SJD venue + matches in that week
//  2. For one $0 match, list all players from mdapi_match_players
//  3. Apply derivePaymentType logic; count buckets
//  4. Check fin_member_spots for the venue/month — is the denominator 0?
//  5. Compare to a working match (SJD Mon)

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key =
  env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)?.[1].trim() ??
  env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

function derivePaymentType(p: {
  paid_status: string | null;
  promocode_id: number | null;
}): string | null {
  if (p.paid_status === "FREE") return "MEMBER";
  if (p.paid_status === "PAID") {
    return p.promocode_id != null ? "PROMOCODE" : "DAILY PAID";
  }
  return null;
}

async function main() {
  // 1. Find SJD-related matches Apr 27 - May 3
  const { data: matches, error: mErr } = await sb
    .from("mdapi_matches")
    .select(
      "api_id, city_identifier, field_title, start_date, is_cancelled",
    )
    .gte("start_date", "2026-04-27")
    .lte("start_date", "2026-05-04")
    .ilike("field_title", "%San Juan Diego%")
    .order("start_date");
  if (mErr) throw mErr;
  console.log(`# Matches with field LIKE '%San Juan Diego%' in week:\n`);
  for (const m of matches ?? []) {
    console.log(
      `  api_id=${m.api_id}  city=${m.city_identifier}  field="${m.field_title}"  start=${m.start_date}  cancelled=${m.is_cancelled}`,
    );
  }
  console.log();

  if (!matches || matches.length === 0) {
    console.log("No matches found. Trying broader 'Juan Diego' search…");
    const { data: m2 } = await sb
      .from("mdapi_matches")
      .select(
        "api_id, city_identifier, field_title, start_date, is_cancelled",
      )
      .gte("start_date", "2026-04-27")
      .lte("start_date", "2026-05-04")
      .ilike("field_title", "%Juan Diego%")
      .order("start_date");
    console.log(JSON.stringify(m2, null, 2));
    return;
  }

  // 2. Pick the Sat 10:00 AM $0 match if present, else first non-Mon match
  const target =
    matches.find((m) => m.start_date?.includes("2026-05-02") && m.start_date?.includes("10:00")) ??
    matches.find((m) => !m.start_date?.includes("Mon"));
  if (!target) return;
  console.log(`# TARGET MATCH (expected $0 member):`);
  console.log(`  api_id=${target.api_id}  field="${target.field_title}"  start=${target.start_date}\n`);

  const { data: players } = await sb
    .from("mdapi_match_players")
    .select(
      "api_id, match_api_id, user_id, user_email, user_type, paid_status, promocode_id, is_cancelled, canceled_at, amount",
    )
    .eq("match_api_id", target.api_id)
    .order("api_id");

  console.log(`# Players (n=${players?.length ?? 0}):\n`);
  let memberN = 0,
    paidN = 0,
    promoN = 0,
    waitN = 0,
    cancelledN = 0;
  for (const p of players ?? []) {
    const pt = derivePaymentType(p);
    if (p.paid_status === "WAITING") waitN++;
    if (p.is_cancelled) cancelledN++;
    if (pt === "MEMBER") memberN++;
    else if (pt === "DAILY PAID") paidN++;
    else if (pt === "PROMOCODE") promoN++;
    console.log(
      `  api_id=${p.api_id} email=${p.user_email} user_type=${p.user_type} paid=${p.paid_status} promo=${p.promocode_id} cancelled=${p.is_cancelled} cancel_at=${p.canceled_at ?? "—"} amount=${p.amount} → ${pt ?? "DROPPED"}`,
    );
  }
  console.log(
    `\n  Counts: MEMBER=${memberN}  DAILY PAID=${paidN}  PROMOCODE=${promoN}  WAITING=${waitN}  is_cancelled=${cancelledN}\n`,
  );

  // 3. Check fin_member_spots for this venue/month
  console.log(`# fin_member_spots probe for "San Juan Diego" matches in Apr/May 2026:\n`);
  const { data: spots } = await sb
    .from("fin_member_spots")
    .select("city, venue, month, member_spots, dpp_spots, other_spots")
    .ilike("venue", "%Juan Diego%");
  for (const s of spots ?? []) console.log(`  ${JSON.stringify(s)}`);
  console.log();

  // 4. Compare with working SJD Mon match
  const monTarget = matches.find((m) => m.start_date?.startsWith("2026-04-27") && m.start_date?.includes("19:30"));
  if (monTarget) {
    console.log(`# WORKING MATCH (SJD Mon 7:30 PM, expected ~$104 member):`);
    console.log(`  api_id=${monTarget.api_id}  start=${monTarget.start_date}\n`);
    const { data: monPlayers } = await sb
      .from("mdapi_match_players")
      .select("api_id, paid_status, promocode_id, is_cancelled, amount, user_email")
      .eq("match_api_id", monTarget.api_id);
    let m = 0, dp = 0, pr = 0;
    for (const p of monPlayers ?? []) {
      const pt = derivePaymentType(p);
      if (pt === "MEMBER") m++;
      else if (pt === "DAILY PAID") dp++;
      else if (pt === "PROMOCODE") pr++;
    }
    console.log(`  Counts: MEMBER=${m}  DAILY PAID=${dp}  PROMOCODE=${pr}  total=${monPlayers?.length}\n`);
  }

  // 5. Check fin_member_spots venue names for the city to confirm naming convention
  console.log(`# fin_member_spots all venues in same city as SJD matches:\n`);
  const cityAbbr = target.city_identifier;
  const { data: allSpots } = await sb
    .from("fin_member_spots")
    .select("city, venue, month, member_spots")
    .eq("month", "Apr 2026");
  for (const s of allSpots ?? []) console.log(`  ${JSON.stringify(s)}`);
}

main().catch(console.error);
