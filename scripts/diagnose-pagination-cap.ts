// Test: does Supabase's per-request row cap make pagination
// terminate before all rows are fetched? Also: count actual total
// rows in the week via head:true so we know the right number.
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
  const { data: upload } = await sb
    .from("data_uploads")
    .select("id")
    .eq("is_current", true)
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!upload) throw new Error("no current upload");

  const isoStart = "2026-04-27T00:00:00";
  const isoEnd = "2026-05-03T23:59:59";

  // Total count via HEAD (no rows returned, just the count).
  const { count, error: cntErr } = await sb
    .from("match_registrations")
    .select("*", { count: "exact", head: true })
    .eq("upload_id", upload.id)
    .gte("match_start", isoStart)
    .lte("match_start", isoEnd);
  if (cntErr) throw new Error(cntErr.message);
  console.log(`Exact count for the week: ${count}\n`);

  // Now paginate and count what we actually get.
  let totalReturned = 0;
  for (let from = 0; from < (count ?? 0) + 5000; from += 1000) {
    const { data, error } = await sb
      .from("match_registrations")
      .select("id", { head: false })
      .eq("upload_id", upload.id)
      .gte("match_start", isoStart)
      .lte("match_start", isoEnd)
      .range(from, from + 999);
    if (error) {
      console.log(`  page from=${from}: ERROR ${error.message}`);
      break;
    }
    const len = data?.length ?? 0;
    totalReturned += len;
    console.log(`  page from=${from}: returned ${len} rows`);
    if (len === 0) {
      console.log("  → empty page, stopping");
      break;
    }
    if (totalReturned >= (count ?? 0)) {
      console.log("  → reached known total, stopping");
      break;
    }
  }
  console.log(`\nTotal returned via pagination: ${totalReturned}`);
  console.log(`Exact count expected:          ${count}`);
  console.log(
    `Match: ${totalReturned === count ? "✓" : "✗ — pagination is incomplete"}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
