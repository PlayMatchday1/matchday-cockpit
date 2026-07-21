// Compare OLD reviews table vs NEW mdapi_reviews for Houston May 2026.
// If OLD reviews has Joba=5 (matching the preview output), the
// "5 vs 14" delta is data drift, not a code bug — production is
// showing what the CSV had at last upload, preview is showing what
// the API has fresher.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
function readVar(name) {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}
const supabase = createClient(
  readVar("NEXT_PUBLIC_SUPABASE_URL"),
  readVar("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function parseLocal(s) {
  if (!s) return null;
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 5) return null;
  const [yr, mo, dy, hr, mn] = parts.map(Number);
  if ([yr, mo, dy, hr, mn].some((n) => Number.isNaN(n))) return null;
  return new Date(yr, mo - 1, dy, hr, mn);
}

async function main() {
  // Get the current upload_id from review_uploads (matches what
  // useReviewData does today on production).
  const { data: uploadRow } = await supabase
    .from("review_uploads")
    .select("id, filename, created_at, row_count")
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log("=== Current upload metadata ===\n");
  console.log(`  ${JSON.stringify(uploadRow)}\n`);

  if (!uploadRow) {
    console.log("No current upload — production would show empty.");
    return;
  }

  // Pull all Houston rows for that upload (paginated)
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("reviews")
      .select(
        "id, city, start_date, star_rating, manager_first_name, manager_last_name",
      )
      .eq("upload_id", uploadRow.id)
      .eq("city", "Houston")
      .order("start_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }

  console.log(`Total Houston rows in OLD reviews table (current upload): ${all.length}\n`);

  // Filter to May 2026 (parsed-local)
  const may26 = [];
  for (const r of all) {
    const d = parseLocal(r.start_date);
    if (!d) continue;
    if (d.getFullYear() !== 2026 || d.getMonth() !== 4) continue;
    may26.push(r);
  }

  console.log(`May 2026 Houston rows (OLD reviews table): ${may26.length}`);

  const byMgr = new Map();
  const dateVariants = new Set();
  for (const r of may26) {
    const mgr = `${r.manager_first_name ?? ""} ${r.manager_last_name ?? ""}`.trim();
    byMgr.set(mgr, (byMgr.get(mgr) ?? 0) + 1);
    dateVariants.add(r.start_date);
  }

  console.log(`Distinct start_date strings: ${dateVariants.size}`);
  for (const d of [...dateVariants].sort()) {
    console.log(`  ${JSON.stringify(d)}`);
  }
  console.log(`\nBy manager:`);
  for (const [m, n] of [...byMgr].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${m}: ${n}`);
  }

  // Sample 3 raw rows to see start_date format
  console.log("\nSample raw rows (first 3):");
  for (const r of may26.slice(0, 3)) {
    console.log(`  ${JSON.stringify(r)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
