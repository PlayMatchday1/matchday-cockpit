// Confirm the new fake/absent filter via the real fetch path.
// Calls fetchPartnerRows + computePartnerStats with the page.tsx
// Mar 31 baseline applied, mirrors what the live route runs.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  computePartnerStats,
  fetchPartnerRows,
} from "../src/lib/partnerStats";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key =
  env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)?.[1].trim() ??
  env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

async function probe(slug: string, baseline: string | null) {
  const { data: pd } = await sb
    .from("partner_dashboards")
    .select("venue_id, partner_name")
    .eq("slug", slug)
    .maybeSingle<{ venue_id: number; partner_name: string }>();
  if (!pd) {
    console.log(`  (slug ${slug} not found in partner_dashboards)`);
    return;
  }
  const { rows } = await fetchPartnerRows(sb, pd.venue_id);
  const filtered = baseline
    ? rows.filter((r) => r.match_start.slice(0, 10) >= baseline)
    : rows;
  const stats = computePartnerStats(filtered, []);
  console.log(`  ${pd.partner_name} (${slug})`);
  console.log(
    `    rows fetched=${rows.length}  post-baseline=${filtered.length}  baseline=${baseline ?? "(none)"}`,
  );
  console.log(
    `    Total spots filled: ${stats.totals.spots}  MD reg: ${stats.totals.md}  Guests: ${stats.totals.guests}  Cancels: ${stats.totals.cancels}  Unique: ${stats.totals.uniquePlayers}`,
  );
}

async function main() {
  console.log("=== Hattrick (with Mar 31 baseline) ===");
  await probe("hattrick-yx4sur4t", "2026-03-31");

  // Spot-check another partner to confirm no breakage. Pull all
  // enabled slugs and probe one that isn't Hattrick.
  const { data: others } = await sb
    .from("partner_dashboards")
    .select("slug, partner_name")
    .eq("enabled", true);
  const sample = (others ?? [])
    .filter((p: any) => p.slug !== "hattrick-yx4sur4t")
    .slice(0, 3);
  console.log("\n=== Other partners (no baseline) ===");
  for (const p of sample as any[]) await probe(p.slug, null);
}
main().catch(console.error);
