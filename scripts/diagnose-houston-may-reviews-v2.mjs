// Round 2 — round 1 found that for Houston May 2026 (UTC bounds),
// mdapi_reviews has exactly 25 rows that all pass the filter chain
// cleanly. So the new useReviewData mapper is correct in isolation.
//
// But the dashboard shows only Joba=5 instead of Joba=14. So either:
//   A. There are MORE Houston May 2026 rows I missed (date stored
//      with a different format or my UTC bounds excluded some).
//   B. selectAll pagination is dropping rows somewhere.
//   C. The consumer-side date filter (getMonthlyManagerStats) is
//      treating these differently than expected.
//
// This script:
//   1. Pulls ALL Houston rows (paginated, no date filter), counts
//      by month.
//   2. Counts Houston May 2026 by manager from the full set, with
//      all date variants enumerated.
//   3. Verifies the parseLocal output shape on each row.
//   4. Tests pagination — does selectAll-equivalent return all 2773
//      rows the user previously confirmed exist?

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

// === 1. Paginate ALL Houston rows ===
async function fetchAllHouston() {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("mdapi_reviews")
      .select("api_id, city_name, start_date, star_rating, manager_first_name, manager_last_name")
      .eq("city_name", "Houston")
      .order("start_date", { ascending: true })
      .order("api_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function main() {
  console.log("=== Pull ALL Houston rows from mdapi_reviews (paginated) ===\n");
  const all = await fetchAllHouston();
  console.log(`Total Houston rows returned: ${all.length}`);
  console.log(`(User's prior probe said 2773 — does this match?)\n`);

  // Count by parseLocal-derived month (mimics what useReviewData
  // produces when the rows reach getMonthlyManagerStats).
  const byParsedMonth = new Map();
  let parseFails = 0;
  for (const r of all) {
    const d = parseLocal(r.start_date);
    if (!d) {
      parseFails++;
      continue;
    }
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    byParsedMonth.set(key, (byParsedMonth.get(key) ?? 0) + 1);
  }
  console.log(`parseLocal failures: ${parseFails}`);
  console.log(`\nHouston rows by parsed-month (uses parseLocal — wall-clock local):`);
  for (const [m, n] of [...byParsedMonth].sort()) {
    console.log(`  ${m}: ${n}`);
  }

  // === 2. Now zoom into May 2026 (parseLocal-defined) ===
  console.log("\n=== Houston May 2026 (parsed local) — by manager ===\n");
  const may26 = [];
  for (const r of all) {
    const d = parseLocal(r.start_date);
    if (!d) continue;
    if (d.getFullYear() !== 2026 || d.getMonth() !== 4) continue;
    may26.push(r);
  }
  console.log(`May 2026 rows: ${may26.length}`);
  const byMgr = new Map();
  const dateVariants = new Set();
  for (const r of may26) {
    const mgr = `${r.manager_first_name ?? ""} ${r.manager_last_name ?? ""}`.trim();
    byMgr.set(mgr, (byMgr.get(mgr) ?? 0) + 1);
    dateVariants.add(r.start_date);
  }
  console.log(`Distinct start_date strings in May 2026: ${dateVariants.size}`);
  for (const d of [...dateVariants].sort()) {
    console.log(`  ${JSON.stringify(d)}`);
  }
  console.log(`\nBy manager:`);
  for (const [m, n] of [...byMgr].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${m}: ${n}`);
  }

  // === 3. UTC bounds vs parseLocal bounds — do they differ? ===
  console.log("\n=== UTC-bound May 2026 vs parsed-local May 2026 ===\n");
  let utcInRange = 0;
  let utcOnly = 0;
  let parsedOnly = 0;
  for (const r of all) {
    const utcMatch =
      r.start_date >= "2026-05-01T00:00:00Z" &&
      r.start_date < "2026-06-01T00:00:00Z";
    const d = parseLocal(r.start_date);
    const parsedMatch = d && d.getFullYear() === 2026 && d.getMonth() === 4;
    if (utcMatch && parsedMatch) utcInRange++;
    else if (utcMatch && !parsedMatch) utcOnly++;
    else if (!utcMatch && parsedMatch) parsedOnly++;
  }
  console.log(`Both UTC AND parsed-local say May 2026: ${utcInRange}`);
  console.log(`UTC says May, parsed-local says elsewhere: ${utcOnly}`);
  console.log(`UTC says elsewhere, parsed-local says May: ${parsedOnly}`);

  // === 4. Sample 3 Joba rows specifically ===
  console.log("\n=== Sample 3 Joba May 2026 rows (does start_date format vary?) ===\n");
  const jobaRows = may26.filter(
    (r) => (r.manager_first_name ?? "").toLowerCase() === "joba",
  );
  console.log(`Total Joba May 2026 rows: ${jobaRows.length}`);
  for (const r of jobaRows.slice(0, 5)) {
    console.log(`  ${JSON.stringify(r)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
