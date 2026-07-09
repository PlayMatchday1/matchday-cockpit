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

  // Count: full week, no field filter
  const a = await sb
    .from("match_registrations")
    .select("*", { count: "exact", head: true })
    .eq("upload_id", upload.id)
    .gte("match_start", isoStart)
    .lte("match_start", isoEnd);
  console.log(`Full week count (no field filter):           ${a.count}`);

  // Count: full week, field ILIKE 'katy'
  const b = await sb
    .from("match_registrations")
    .select("*", { count: "exact", head: true })
    .eq("upload_id", upload.id)
    .gte("match_start", isoStart)
    .lte("match_start", isoEnd)
    .ilike("field", "%katy%");
  console.log(`Full week count (.ilike '%katy%'):           ${b.count}`);

  // Count: full week, field exactly 'ATH Katy'
  const c = await sb
    .from("match_registrations")
    .select("*", { count: "exact", head: true })
    .eq("upload_id", upload.id)
    .gte("match_start", isoStart)
    .lte("match_start", isoEnd)
    .eq("field", "ATH Katy");
  console.log(`Full week count (.eq 'ATH Katy'):             ${c.count}`);

  // Count: ATH Katy Wed 9:15 PM specifically
  const d = await sb
    .from("match_registrations")
    .select("*", { count: "exact", head: true })
    .eq("upload_id", upload.id)
    .eq("field", "ATH Katy")
    .eq("match_start", "2026-04-29T21:15:00+00:00");
  console.log(`ATH Katy Wed 9:15 PM exact count:             ${d.count}`);

  // Same as above but with a different timestamp format Postgres might produce
  const e = await sb
    .from("match_registrations")
    .select("*", { count: "exact", head: true })
    .eq("upload_id", upload.id)
    .eq("field", "ATH Katy")
    .gte("match_start", "2026-04-29T21:15:00")
    .lte("match_start", "2026-04-29T21:15:00.999999");
  console.log(`ATH Katy Wed 9:15 PM (range eq):             ${e.count}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
