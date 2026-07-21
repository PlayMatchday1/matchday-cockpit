// One-row fix: Hattrick pre-system settlement paid_at
// 2026-05-02 → 2026-04-14.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// Resolve Hattrick's partner_dashboard_id by slug.
const { data: pd, error: pdErr } = await sb
  .from("partner_dashboards")
  .select("id, slug")
  .ilike("slug", "hattrick-%")
  .maybeSingle();
if (pdErr || !pd) {
  console.error("Hattrick lookup failed:", pdErr ?? "no row");
  process.exit(1);
}
console.log(`Hattrick partner_dashboard_id: ${pd.id} (slug=${pd.slug})`);

// 1. BEFORE.
const before = await sb
  .from("partner_weekly_payments")
  .select(
    "id, partner_dashboard_id, week_start_date, calculated_amount, status, paid_at, paid_notes, is_pre_system_settlement",
  )
  .eq("partner_dashboard_id", pd.id)
  .eq("is_pre_system_settlement", true)
  .eq("week_start_date", "2026-03-31");
if (before.error) {
  console.error("Before query failed:", before.error);
  process.exit(1);
}
console.log(`\nBEFORE — ${before.data?.length ?? 0} match(es):`);
for (const r of before.data ?? []) console.log(JSON.stringify(r, null, 2));
if ((before.data?.length ?? 0) !== 1) {
  console.error("ABORT: expected exactly 1 match.");
  process.exit(1);
}

// 2. UPDATE.
const upd = await sb
  .from("partner_weekly_payments")
  .update({ paid_at: "2026-04-14T12:00:00Z" })
  .eq("partner_dashboard_id", pd.id)
  .eq("is_pre_system_settlement", true)
  .eq("week_start_date", "2026-03-31")
  .select(
    "id, partner_dashboard_id, week_start_date, calculated_amount, status, paid_at, paid_notes, is_pre_system_settlement",
  );
if (upd.error) {
  console.error("\nUpdate failed:", upd.error);
  process.exit(1);
}
console.log(`\nAFTER — ${upd.data?.length ?? 0} row(s) updated:`);
for (const r of upd.data ?? []) console.log(JSON.stringify(r, null, 2));
