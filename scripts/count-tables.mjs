import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const tables = [
  "fin_revenue",
  "fin_expenses",
  "fin_schedule",
  "fin_members",
  "fin_pricing",
  "fin_member_spots",
  "fin_venue_aliases",
  "fin_venues",
  "fin_venue_cost_overrides",
  "fin_monthly_expenses",
  "fin_manager_pay",
  "fin_config",
  "fin_commentary",
  "fin_change_log",
  "reviews",
  "review_uploads",
  "match_registrations",
  "data_uploads",
  "topics",
  "topic_comments",
  "topic_action_items",
  "goal_comments",
  "goals",
  "org_groups",
  "org_people",
  "docs",
  "doc_sections",
  "app_users",
  "app_settings",
];

for (const t of tables) {
  const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
  if (error) console.log(`${t}: ERROR ${error.message}`);
  else console.log(`${t}: ${count}`);
}
