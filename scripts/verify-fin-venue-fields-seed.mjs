// Run AFTER migration 0041_fin_venue_fields.sql has been applied
// manually in Supabase Editor.
//
// Confirms:
//   1. fin_venue_fields exists with the expected columns
//   2. Row count is 35 (32 seeded + 3 linked to new fin_venues rows)
//   3. The three new fin_venues rows exist (Helix Park, Crossbar
//      Rowlett, Hattrick T.)
//   4. Every mdapi_field_id seen in mdapi_matches in the last 90
//      days has a fin_venue_fields entry — anything missing is
//      flagged for ops follow-up.
//   5. Every fin_venues row either has at least one fin_venue_fields
//      link OR is one of the intentional omissions (Westlake legacy,
//      ATH Katy Sunday billing artifact). Anything else gets flagged.
//
// Usage: node scripts/verify-fin-venue-fields-seed.mjs

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const INTENTIONAL_UNLINKED_NAMES = new Set([
  "ATH Katy Sunday", // billing artifact for split-rate accounting
  "Westlake",        // legacy / inactive, no mdapi or schedule_master rows
]);

const NEW_FIN_VENUES_EXPECTED = [
  { venue_name: "Helix Park",        city: "Houston" },
  { venue_name: "Crossbar Rowlett",  city: "Dallas" },
  { venue_name: "Hattrick T.",       city: "Houston" },
];

const EXPECTED_ROW_COUNT = 35;

let failures = 0;
function fail(msg) {
  failures += 1;
  console.error("  ✗ " + msg);
}
function ok(msg) {
  console.log("  ✓ " + msg);
}

// 1. Schema check ------------------------------------------------
console.log("\n[1] fin_venue_fields schema");
{
  const probe = await sb.from("fin_venue_fields").select("*").limit(1);
  if (probe.error) {
    fail(`SELECT failed: ${probe.error.message}`);
    console.error("\nAborting — table may not exist. Apply migration 0041 first.");
    process.exit(1);
  }
  const sample = probe.data?.[0];
  if (!sample) {
    fail("Table exists but is empty — did the seed INSERTs run?");
  } else {
    const expectedCols = [
      "fin_venue_id",
      "mdapi_field_id",
      "field_title_at_link",
      "created_at",
    ];
    for (const col of expectedCols) {
      if (!(col in sample)) fail(`Missing column: ${col}`);
    }
    if (failures === 0) ok("Table present with expected columns");
  }
}

// 2. Row count ----------------------------------------------------
console.log("\n[2] fin_venue_fields row count");
{
  const { count, error } = await sb
    .from("fin_venue_fields")
    .select("*", { count: "exact", head: true });
  if (error) {
    fail(`Count query failed: ${error.message}`);
  } else if (count !== EXPECTED_ROW_COUNT) {
    fail(`Expected ${EXPECTED_ROW_COUNT} rows, found ${count}`);
  } else {
    ok(`${count} rows (matches expected)`);
  }
}

// 3. New fin_venues rows ------------------------------------------
console.log("\n[3] new fin_venues rows from migration");
{
  for (const expected of NEW_FIN_VENUES_EXPECTED) {
    const { data, error } = await sb
      .from("fin_venues")
      .select("id, venue_name, city, is_active, billing_type, cost_per_match")
      .eq("venue_name", expected.venue_name)
      .eq("city", expected.city);
    if (error) {
      fail(`Lookup failed for ${expected.venue_name}: ${error.message}`);
      continue;
    }
    if (!data || data.length === 0) {
      fail(`${expected.venue_name} (${expected.city}) not found`);
    } else if (data.length > 1) {
      fail(`${expected.venue_name} (${expected.city}) — expected 1 row, found ${data.length}`);
    } else {
      const row = data[0];
      ok(`${row.venue_name} (${row.city}) — id=${row.id}, active=${row.is_active}, billing=${row.billing_type}, cost=${row.cost_per_match}`);
    }
  }
}

// 4. Cross-check mdapi_matches → fin_venue_fields ----------------
console.log("\n[4] mdapi field coverage (last 90 days)");
{
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString();
  // Paginate in case >1000 rows. We only need distinct field_ids,
  // but Supabase JS has no DISTINCT; pull and dedupe locally.
  const seenFieldIds = new Map(); // field_id → field_title (latest)
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from("mdapi_matches")
      .select("field_id, field_title, start_date")
      .gte("start_date", ninetyDaysAgo)
      .order("start_date", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) {
      fail(`mdapi_matches query failed: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    for (const m of data) {
      if (m.field_id != null && !seenFieldIds.has(m.field_id)) {
        seenFieldIds.set(m.field_id, m.field_title ?? "");
      }
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }

  const { data: linkRows, error: linkErr } = await sb
    .from("fin_venue_fields")
    .select("mdapi_field_id");
  if (linkErr) {
    fail(`fin_venue_fields query failed: ${linkErr.message}`);
  } else {
    const linkedIds = new Set(linkRows.map((r) => r.mdapi_field_id));
    const missing = [];
    for (const [fid, ftitle] of seenFieldIds) {
      if (!linkedIds.has(fid)) missing.push({ field_id: fid, field_title: ftitle });
    }
    if (missing.length === 0) {
      ok(`All ${seenFieldIds.size} distinct mdapi field_ids in the last 90 days are linked`);
    } else {
      fail(`${missing.length} mdapi field_ids in the last 90 days have no fin_venue_fields entry:`);
      for (const m of missing) {
        console.error(`      field_id=${m.field_id}  title="${m.field_title}"`);
      }
    }
  }
}

// 5. fin_venues without any link, excluding intentional omissions
console.log("\n[5] fin_venues without a fin_venue_fields link");
{
  const { data: venues, error: vErr } = await sb
    .from("fin_venues")
    .select("id, venue_name, city, is_active");
  if (vErr) {
    fail(`fin_venues query failed: ${vErr.message}`);
  } else {
    const { data: links, error: lErr } = await sb
      .from("fin_venue_fields")
      .select("fin_venue_id");
    if (lErr) {
      fail(`fin_venue_fields query failed: ${lErr.message}`);
    } else {
      const linkedVenueIds = new Set(links.map((r) => r.fin_venue_id));
      const unexpected = [];
      const expectedOmissions = [];
      for (const v of venues) {
        if (linkedVenueIds.has(v.id)) continue;
        if (INTENTIONAL_UNLINKED_NAMES.has(v.venue_name)) {
          expectedOmissions.push(v);
        } else {
          unexpected.push(v);
        }
      }
      for (const v of expectedOmissions) {
        ok(`expected omission: ${v.venue_name} (id=${v.id}, ${v.city})`);
      }
      if (unexpected.length === 0) {
        ok("No unexpected unlinked fin_venues rows");
      } else {
        fail(`${unexpected.length} unexpected unlinked fin_venues rows:`);
        for (const v of unexpected) {
          console.error(
            `      id=${v.id}  name="${v.venue_name}"  city="${v.city}"  active=${v.is_active}`,
          );
        }
      }
    }
  }
}

// Summary --------------------------------------------------------
console.log("\n" + "=".repeat(60));
if (failures === 0) {
  console.log("✓ All checks passed.");
  process.exit(0);
} else {
  console.error(`✗ ${failures} check(s) failed. See output above.`);
  process.exit(1);
}
