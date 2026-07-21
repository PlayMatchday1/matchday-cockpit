// Read-only verification: dump all members_monthly_snapshots rows.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

async function main() {
  const { data, error } = await sb
    .from("members_monthly_snapshots")
    .select("month, active_count, new_count, cancelled_count, churning_count")
    .order("month", { ascending: true });
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`${data?.length ?? 0} rows in members_monthly_snapshots:\n`);
  console.log(
    "month       | active | new | cancl | churn",
  );
  console.log(
    "------------|--------|-----|-------|------",
  );
  for (const r of data ?? []) {
    const pad = (n: number | null, w: number) =>
      String(n ?? "—").padStart(w);
    console.log(
      `${r.month}  | ${pad(r.active_count, 6)} | ${pad(r.new_count, 3)} | ${pad(r.cancelled_count, 5)} | ${pad(r.churning_count, 5)}`,
    );
  }
}

main();
