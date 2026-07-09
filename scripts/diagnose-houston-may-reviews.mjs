// Houston May 2026 dropped-rows investigation.
//
// Bug: useReviewData mapper shows Joba=5 for Houston May 2026, but
// mdapi_reviews has Joba=14, Reda=10, Leo=1, ... totalling ~25 rows.
// Most rows are being silently dropped somewhere in the filter chain:
//   1. parseLocal(start_date) returning null
//   2. star_rating null
//   3. normalizeCity(city_name) returning null
//
// This script:
//   1. Queries mdapi_reviews for everything that looks Houston-ish
//      (case-insensitive, leading/trailing whitespace tolerant) in
//      May 2026.
//   2. Runs each row through the exact same filter chain useReviewData
//      uses, counting drops per reason.
//   3. Prints the raw start_date values to see the format.
//   4. Prints distinct city_name values to catch case/whitespace bugs.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
function readVar(name) {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}

const supabaseUrl = readVar("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = readVar("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceKey) {
  console.error("missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL in .env.local");
  process.exit(1);
}
// mdapi_reviews RLS only allows `authenticated` SELECT, not `anon` —
// anon-key reads silently return zero rows. Service role bypasses
// RLS, matching what /api/sync/cron uses.
const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Same logic as useReviewData.ts's parseLocal, copied verbatim.
function parseLocal(s) {
  if (!s) return null;
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 5) return null;
  const [yr, mo, dy, hr, mn] = parts.map(Number);
  if ([yr, mo, dy, hr, mn].some((n) => Number.isNaN(n))) return null;
  return new Date(yr, mo - 1, dy, hr, mn);
}

// Same logic as cityMap.ts's normalizeCity, copied verbatim.
const CSV_TO_COCKPIT_CITY = {
  "Dallas / Fort Worth": "Dallas",
  "Oklahoma City": "OKC",
  Austin: "Austin",
  Houston: "Houston",
  "San Antonio": "San Antonio",
  "St. Louis": "St. Louis",
  Atlanta: "Atlanta",
  "El Paso": "El Paso",
};
function normalizeCity(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return CSV_TO_COCKPIT_CITY[trimmed] ?? null;
}

async function main() {
  // === 1. Distinct city_name values matching "houston" case-insensitively ===
  console.log("=== DISTINCT city_name values containing 'houston' ===\n");
  const { data: distinctCities, error: distinctErr } = await supabase
    .from("mdapi_reviews")
    .select("city_name")
    .ilike("city_name", "%houston%");
  if (distinctErr) {
    console.error("ilike query failed:", distinctErr.message);
  } else {
    const counts = new Map();
    for (const r of distinctCities ?? []) {
      const c = r.city_name;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    for (const [c, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      // Show literal value with quotes so leading/trailing whitespace is visible.
      console.log(`  ${JSON.stringify(c)} → ${n} rows`);
    }
  }

  // === 2. Raw Houston May 2026 rows — full data ===
  console.log("\n=== Raw Houston May 2026 rows from mdapi_reviews ===\n");

  // Match exactly what useReviewData would see — query for May 2026.
  // start_date is timestamptz; ISO bounds use UTC.
  const { data: rows, error: rowsErr } = await supabase
    .from("mdapi_reviews")
    .select(
      "api_id, city_name, start_date, star_rating, manager_first_name, manager_last_name",
    )
    .ilike("city_name", "%houston%")
    .gte("start_date", "2026-05-01T00:00:00Z")
    .lt("start_date", "2026-06-01T00:00:00Z")
    .order("start_date", { ascending: false });

  if (rowsErr) {
    console.error("rows query failed:", rowsErr.message);
    process.exit(1);
  }

  console.log(`Total rows returned: ${rows?.length ?? 0}\n`);

  // Show first 3 raw rows to inspect format
  console.log("Sample raw rows (first 3):");
  for (const r of (rows ?? []).slice(0, 3)) {
    console.log(`  ${JSON.stringify(r)}`);
  }

  // === 3. Run each row through the filter chain ===
  console.log("\n=== Filter trace ===\n");
  const stats = {
    total: rows?.length ?? 0,
    droppedNoStartDate: 0,
    droppedBadParse: 0,
    droppedNoStarRating: 0,
    droppedNoCity: 0,
    passed: 0,
  };
  const failureSamples = {
    noStartDate: [],
    badParse: [],
    noStarRating: [],
    noCity: [],
  };
  const passedByManager = new Map();

  for (const r of rows ?? []) {
    if (!r.start_date) {
      stats.droppedNoStartDate++;
      if (failureSamples.noStartDate.length < 3) failureSamples.noStartDate.push(r);
      continue;
    }
    const parsed = parseLocal(r.start_date);
    if (!parsed) {
      stats.droppedBadParse++;
      if (failureSamples.badParse.length < 3) failureSamples.badParse.push(r);
      continue;
    }
    if (r.star_rating === null) {
      stats.droppedNoStarRating++;
      if (failureSamples.noStarRating.length < 3) failureSamples.noStarRating.push(r);
      continue;
    }
    const city = normalizeCity(r.city_name);
    if (!city) {
      stats.droppedNoCity++;
      if (failureSamples.noCity.length < 3) failureSamples.noCity.push(r);
      continue;
    }
    stats.passed++;
    const mgr = `${r.manager_first_name ?? ""} ${r.manager_last_name ?? ""}`.trim();
    passedByManager.set(mgr, (passedByManager.get(mgr) ?? 0) + 1);
  }

  console.log(`Filter results:`);
  console.log(`  total:                  ${stats.total}`);
  console.log(`  dropped (no start_date):${stats.droppedNoStartDate}`);
  console.log(`  dropped (parseLocal):   ${stats.droppedBadParse}`);
  console.log(`  dropped (no star_rating): ${stats.droppedNoStarRating}`);
  console.log(`  dropped (no city):      ${stats.droppedNoCity}`);
  console.log(`  passed:                 ${stats.passed}`);

  if (failureSamples.noStartDate.length > 0) {
    console.log(`\n  noStartDate samples:`);
    for (const r of failureSamples.noStartDate) console.log(`    ${JSON.stringify(r)}`);
  }
  if (failureSamples.badParse.length > 0) {
    console.log(`\n  badParse samples:`);
    for (const r of failureSamples.badParse) console.log(`    ${JSON.stringify(r)}`);
  }
  if (failureSamples.noStarRating.length > 0) {
    console.log(`\n  noStarRating samples:`);
    for (const r of failureSamples.noStarRating) console.log(`    ${JSON.stringify(r)}`);
  }
  if (failureSamples.noCity.length > 0) {
    console.log(`\n  noCity samples:`);
    for (const r of failureSamples.noCity) console.log(`    ${JSON.stringify(r)}`);
  }

  console.log(`\n  Passed rows by manager:`);
  for (const [mgr, n] of [...passedByManager].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${mgr}: ${n}`);
  }

  // === 4. Show parseLocal behavior on the actual start_date values ===
  console.log("\n=== parseLocal behavior on first 5 actual start_date strings ===\n");
  for (const r of (rows ?? []).slice(0, 5)) {
    const sd = r.start_date;
    const sliced = sd ? sd.slice(0, 16) : null;
    const parts = sliced ? sliced.split(/[- T:]/) : [];
    const parsed = parseLocal(sd);
    console.log(`  raw:    ${JSON.stringify(sd)}`);
    console.log(`  sliced: ${JSON.stringify(sliced)}`);
    console.log(`  parts:  ${JSON.stringify(parts)} (length=${parts.length})`);
    console.log(`  parsed: ${parsed ? parsed.toISOString() : "null"}`);
    console.log("");
  }

  // === 5. Houston-only May 2026 with EXACT match (no ilike) — what useReviewData sees ===
  console.log("\n=== EXACT city_name='Houston' May 2026 (no ilike) ===\n");
  const { data: exactRows, error: exactErr } = await supabase
    .from("mdapi_reviews")
    .select("api_id, manager_first_name, manager_last_name")
    .eq("city_name", "Houston")
    .gte("start_date", "2026-05-01T00:00:00Z")
    .lt("start_date", "2026-06-01T00:00:00Z");
  if (exactErr) {
    console.error("exact match failed:", exactErr.message);
  } else {
    const byMgr = new Map();
    for (const r of exactRows ?? []) {
      const mgr = `${r.manager_first_name ?? ""} ${r.manager_last_name ?? ""}`.trim();
      byMgr.set(mgr, (byMgr.get(mgr) ?? 0) + 1);
    }
    console.log(`  total: ${exactRows?.length ?? 0}`);
    console.log(`  by manager:`);
    for (const [mgr, n] of [...byMgr].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${mgr}: ${n}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
