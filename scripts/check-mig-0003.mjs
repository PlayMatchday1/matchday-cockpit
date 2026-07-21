import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// 1. New columns on partner_dashboards?
const colsCheck = await sb
  .from("partner_dashboards")
  .select("revenue_share_pct, payment_start_date, payment_day_of_week")
  .limit(1);
const colsApplied = !colsCheck.error;
console.log("1. partner_dashboards new columns:", colsApplied ? "✓ present" : `✗ missing — ${colsCheck.error?.code} ${colsCheck.error?.message ?? ""}`);

// 2. partner_weekly_payments exists?
const tblCheck = await sb.from("partner_weekly_payments").select("id").limit(1);
const tblApplied = !tblCheck.error;
console.log("2. partner_weekly_payments table:", tblApplied ? "✓ exists" : `✗ missing — ${tblCheck.error?.code} ${tblCheck.error?.message ?? ""}`);

// 3. PAC Global's payment_start_date.
if (colsApplied) {
  const pac = await sb
    .from("partner_dashboards")
    .select("slug, payment_start_date, revenue_share_pct, payment_day_of_week")
    .eq("slug", "pac-global-7vdybfv4")
    .maybeSingle();
  if (pac.error) console.log(`3. PAC seed: ✗ query error ${pac.error.message}`);
  else if (!pac.data) console.log("3. PAC seed: ✗ row not found");
  else console.log(`3. PAC seed: payment_start_date=${pac.data.payment_start_date} share=${pac.data.revenue_share_pct} dow=${pac.data.payment_day_of_week}`);
} else {
  console.log("3. PAC seed: skipped (columns missing)");
}
