// Preview Hattrick's expected Monthly Payments table after the
// payment_cadence='monthly' migration applies.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) =>
  "$" + Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// 1. Find Hattrick's partner_dashboards row.
const { data: pd } = await sb
  .from("partner_dashboards")
  .select("id, slug, partner_name, venue_id, revenue_share_pct, payment_start_date, payment_day_of_week")
  .ilike("slug", "hattrick-%")
  .maybeSingle();
console.log("Hattrick partner_dashboards row:");
console.log(pd ?? "(not found)");
if (!pd) process.exit(1);

// 2. Venue.
const { data: vn } = await sb
  .from("fin_venues")
  .select("id, venue_name, city")
  .eq("id", pd.venue_id)
  .maybeSingle();
console.log("\nVenue:", vn);

// 3. Existing partner_weekly_payments rows for Hattrick.
const { data: wp } = await sb
  .from("partner_weekly_payments")
  .select("id, week_start_date, calculated_amount, status, paid_at, paid_notes, dispute_note, is_pre_system_settlement")
  .eq("partner_dashboard_id", pd.id)
  .order("week_start_date");
console.log("\nExisting partner_weekly_payments rows for Hattrick:", wp?.length ?? 0);
for (const r of (wp ?? [])) {
  console.log(`  week=${r.week_start_date}  amt=${fmt(r.calculated_amount)}  status=${r.status}  pre_system=${r.is_pre_system_settlement}  notes="${r.paid_notes ?? ""}"`);
}

// 4. Match registrations for Hattrick (current upload, scoped to venue
// via field-name substring match — same logic as partnerStats.ts).
const { data: upload } = await sb
  .from("data_uploads")
  .select("id")
  .eq("is_current", true)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
console.log("\nActive upload:", upload?.id);

let mr = [];
if (upload && vn) {
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("match_registrations")
      .select("user_id, email, field, match_start, match_canceled, player_canceled_at, payment_type, match_price_paid")
      .eq("upload_id", upload.id)
      .ilike("field", `%${vn.venue_name}%`)
      .order("match_start")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    mr.push(...data);
    if (data.length < 1000) break;
  }
}
console.log(`Hattrick match_registrations rows: ${mr.length}`);

// 5. Filter (mirrors partnerStats.ts pacAll → pac).
const STAFF = "matchday.com";
mr = mr.filter((r) => !(r.email && r.email.toLowerCase().includes(STAFF)));
const active = mr.filter((r) => !r.match_canceled);
console.log(`After staff drop: ${mr.length}, after match_canceled drop: ${active.length}`);

// 6. fin_revenue Private Rental rows for Hattrick.
const { data: rev } = await sb
  .from("fin_revenue")
  .select("date, type, gross, source")
  .ilike("venue", `%${vn?.venue_name ?? ""}%`)
  .neq("source", "PROJECTION")
  .not("type", "in", '("DPP","Membership")');
console.log(`\nfin_revenue extras (non-DPP, non-Membership) for Hattrick: ${rev?.length ?? 0}`);
for (const r of (rev ?? [])) {
  console.log(`  ${r.date}  type=${r.type}  gross=${fmt(r.gross)}  source=${r.source}`);
}

// 7. Compute monthly buckets (Mar/Apr/May 2026).
const months = ["2026-03", "2026-04", "2026-05"];
console.log("\n=== Monthly qualifying revenue ===");
console.log("MONTH      DPP        PRIV_RENTAL  TOTAL      OWED@50%");
console.log("-".repeat(70));
for (const ym of months) {
  let dpp = 0;
  for (const r of active) {
    if (r.payment_type !== "DAILY PAID") continue;
    if (!r.match_start.startsWith(ym)) continue;
    dpp += Number(r.match_price_paid ?? 0) || 0;
  }
  let pr = 0;
  for (const e of (rev ?? [])) {
    if (e.type !== "Private Rental") continue;
    if (!e.date || !e.date.startsWith(ym)) continue;
    pr += Number(e.gross ?? 0) || 0;
  }
  const total = dpp + pr;
  const owed = Math.round(total * 50) / 100;
  console.log(
    `${ym}    ${fmt(dpp).padStart(9)}  ${fmt(pr).padStart(11)}  ${fmt(total).padStart(9)}  ${fmt(owed).padStart(9)}`,
  );
}

// 8. First qualifying month from payment_start_date.
console.log(`\npayment_start_date: ${pd.payment_start_date}`);
if (pd.payment_start_date) {
  const d = new Date(pd.payment_start_date + "T00:00:00Z");
  const day = d.getUTCDate();
  let firstMonth;
  if (day === 1) {
    firstMonth = pd.payment_start_date.slice(0, 7);
  } else {
    // First day of next month.
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(1);
    firstMonth = d.toISOString().slice(0, 7);
  }
  console.log(`First qualifying month: ${firstMonth}`);
}
console.log(`Today (UTC): ${new Date().toISOString().slice(0, 10)}`);
