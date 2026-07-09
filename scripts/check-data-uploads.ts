import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

async function main() {
  const { data, error } = await sb
    .from("data_uploads")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) {
    console.error(error);
    return;
  }
  console.log(`Top 5 data_uploads (newest first):`);
  for (const u of data ?? []) {
    console.log(JSON.stringify(u, null, 2));
  }
}
main();
