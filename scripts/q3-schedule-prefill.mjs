// Q3 2026 fin_schedule prefill + monthly_flat override carry-forward.
//
// Default: DRY-RUN. Prints counts, samples, rollback statements,
// touches nothing.
// To apply: pass --apply on the command line.
//
// Idempotent on re-run: skips fin_schedule rows whose (venue, date)
// already exists; skips overrides whose (venue_id, month) already
// exists.
//
// All schedule rows tagged created_by="q3-prefill-script" so a
// single DELETE WHERE created_by='q3-prefill-script' rolls back
// everything from this run.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const TAG = "q3-prefill-script";
const NOTES = "Q3 prefill — planning";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Q3 2026: Jul (31), Aug (31), Sep (30).
const Q3 = [
  { key: "Jul 2026", year: 2026, month: 7, days: 31 },
  { key: "Aug 2026", year: 2026, month: 8, days: 31 },
  { key: "Sep 2026", year: 2026, month: 9, days: 30 },
];

// Per-venue DOW → match_count. ATH Pearland is special: Jul uses a
// peak-push pattern; Aug/Sep revert to the May 7-day baseline.
//
// `pattern` applies to every month. `patternByMonth` overrides per
// month-key (used only by ATH Pearland Jul).
const VENUES = [
  {
    canonical: "ATH Katy",
    pattern: { Sun: 1, Mon: 1, Wed: 1, Thu: 1 },
  },
  {
    canonical: "ATH Pearland",
    patternByMonth: {
      "Jul 2026": { Sun: 1, Mon: 2, Tue: 2, Wed: 2, Thu: 2, Fri: 2, Sat: 1 },
      "Aug 2026": { Sun: 1, Mon: 1, Tue: 1, Wed: 1, Thu: 1, Fri: 1, Sat: 1 },
      "Sep 2026": { Sun: 1, Mon: 1, Tue: 1, Wed: 1, Thu: 1, Fri: 1, Sat: 1 },
    },
  },
  {
    canonical: "KISC (Katy Intl)",
    pattern: { Tue: 1, Fri: 1 },
  },
  {
    canonical: "Lou Fusz Outdoor",
    pattern: { Sun: 1, Mon: 1, Tue: 1, Wed: 1, Thu: 1 },
  },
  {
    canonical: "Majestic Gardens",
    pattern: { Mon: 1, Wed: 1, Sat: 1 },
  },
  {
    canonical: "Onion Creek",
    pattern: { Tue: 1, Thu: 1 },
  },
  {
    canonical: "PRUMC",
    pattern: { Sun: 1, Mon: 1, Tue: 1, Thu: 1 },
  },
  {
    canonical: "Scissortail Park",
    pattern: { Tue: 1, Wed: 1, Thu: 1, Fri: 1, Sun: 1 },
  },
];

const MONTHLY_FLAT_VENUES = ["Hattrick", "Soccer Central"];

// -----------------------------------------------------------------
// 1. Resolve venues — get city + id for every venue we touch.
// -----------------------------------------------------------------
const venueNames = [
  ...VENUES.map((v) => v.canonical),
  ...MONTHLY_FLAT_VENUES,
];
const { data: venueRows, error: vErr } = await sb
  .from("fin_venues")
  .select("id, venue_name, city, billing_type")
  .in("venue_name", venueNames);
if (vErr) {
  console.error("Failed to read fin_venues:", vErr);
  process.exit(1);
}
const venueByName = new Map(venueRows.map((v) => [v.venue_name, v]));

// Make sure every venue we expect actually exists.
const missing = venueNames.filter((n) => !venueByName.has(n));
if (missing.length > 0) {
  console.error("ERROR — these venues are NOT in fin_venues:");
  for (const m of missing) console.error("  -", m);
  process.exit(1);
}

// -----------------------------------------------------------------
// 2. Build the schedule INSERT plan.
// -----------------------------------------------------------------
function pad(n) {
  return String(n).padStart(2, "0");
}
function buildIsoDate(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}
function dowOf(year, month, day) {
  return DOW[new Date(year, month - 1, day, 12).getDay()];
}

const scheduleRows = [];
// Counts: venue → month → { rows, matches }
const counts = new Map();
for (const v of VENUES) {
  const venue = venueByName.get(v.canonical);
  counts.set(v.canonical, new Map());
  for (const m of Q3) {
    const pattern =
      v.patternByMonth?.[m.key] ?? v.pattern;
    let rows = 0;
    let matches = 0;
    for (let d = 1; d <= m.days; d++) {
      const dow = dowOf(m.year, m.month, d);
      const mc = pattern[dow];
      if (!mc) continue;
      scheduleRows.push({
        date: buildIsoDate(m.year, m.month, d),
        month: m.key,
        city: venue.city,
        venue: v.canonical,
        match_count: mc,
        total_hours: null,
        venue_cost: null,
        notes: NOTES,
        manual_entry: true,
        created_by: TAG,
      });
      rows++;
      matches += mc;
    }
    counts.get(v.canonical).set(m.key, { rows, matches });
  }
}

// -----------------------------------------------------------------
// 3. Idempotency check — drop any (venue, date) that already has a
//    row in fin_schedule for the Q3 month range. We can do this in
//    one query: pull existing Q3 rows for the touched venues.
// -----------------------------------------------------------------
const venueValues = VENUES.map((v) => v.canonical);
const { data: existingSched, error: eErr } = await sb
  .from("fin_schedule")
  .select("venue, date")
  .in("month", Q3.map((m) => m.key))
  .in("venue", venueValues);
if (eErr) {
  console.error("Failed to read existing fin_schedule:", eErr);
  process.exit(1);
}
const existingKey = new Set(
  existingSched.map((r) => `${r.venue}|${r.date}`),
);
const toInsert = scheduleRows.filter(
  (r) => !existingKey.has(`${r.venue}|${r.date}`),
);
const skipped = scheduleRows.length - toInsert.length;

// -----------------------------------------------------------------
// 4. Override carry-forward — read May 2026 overrides for the two
//    monthly_flat venues, then build 3 Q3 rows per venue (Jul/Aug/Sep).
// -----------------------------------------------------------------
const monthlyFlatIds = MONTHLY_FLAT_VENUES.map(
  (n) => venueByName.get(n).id,
);
const { data: mayOverrides, error: oErr } = await sb
  .from("fin_venue_cost_overrides")
  .select("venue_id, month, override_amount, reason")
  .in("venue_id", monthlyFlatIds)
  .eq("month", "May 2026");
if (oErr) {
  console.error("Failed to read May 2026 overrides:", oErr);
  process.exit(1);
}
const mayByVenueId = new Map(
  mayOverrides.map((r) => [r.venue_id, r]),
);
const missingMay = MONTHLY_FLAT_VENUES.filter(
  (n) => !mayByVenueId.has(venueByName.get(n).id),
);
if (missingMay.length > 0) {
  console.error(
    "ERROR — these venues have no May 2026 override row to carry forward:",
  );
  for (const n of missingMay) console.error("  -", n);
  process.exit(1);
}

// Existing Q3 overrides — skip-if-present.
const { data: existingQ3Overrides, error: e2 } = await sb
  .from("fin_venue_cost_overrides")
  .select("venue_id, month")
  .in("venue_id", monthlyFlatIds)
  .in("month", Q3.map((m) => m.key));
if (e2) {
  console.error("Failed to read existing Q3 overrides:", e2);
  process.exit(1);
}
const existingOverrideKey = new Set(
  existingQ3Overrides.map((r) => `${r.venue_id}|${r.month}`),
);

const overrideRows = [];
for (const name of MONTHLY_FLAT_VENUES) {
  const venue = venueByName.get(name);
  const may = mayByVenueId.get(venue.id);
  for (const m of Q3) {
    if (existingOverrideKey.has(`${venue.id}|${m.key}`)) continue;
    overrideRows.push({
      venue_id: venue.id,
      month: m.key,
      override_amount: may.override_amount,
      reason: may.reason ?? "Carried forward from May 2026 (Q3 prefill)",
      created_by: TAG,
    });
  }
}

// -----------------------------------------------------------------
// 5. Dry-run report (always printed).
// -----------------------------------------------------------------
console.log("=".repeat(72));
console.log(`Q3 2026 schedule prefill — ${APPLY ? "APPLY MODE" : "DRY RUN"}`);
console.log("=".repeat(72));
console.log();

console.log("Per-venue per-month breakdown (rows / matches):");
console.log();
let totalRows = 0,
  totalMatches = 0;
const monthTotals = Object.fromEntries(Q3.map((m) => [m.key, { rows: 0, matches: 0 }]));
for (const v of VENUES) {
  const c = counts.get(v.canonical);
  const parts = Q3.map((m) => {
    const { rows, matches } = c.get(m.key);
    monthTotals[m.key].rows += rows;
    monthTotals[m.key].matches += matches;
    totalRows += rows;
    totalMatches += matches;
    return `${m.key}: ${rows} rows / ${matches} matches`;
  });
  const tVenueRows = parts.reduce(
    (s, _, i) => s + c.get(Q3[i].key).rows,
    0,
  );
  const tVenueMatches = parts.reduce(
    (s, _, i) => s + c.get(Q3[i].key).matches,
    0,
  );
  console.log(
    `  ${v.canonical.padEnd(20)}  ${parts.join("   ")}   →  TOTAL ${tVenueRows} rows / ${tVenueMatches} matches`,
  );
}

console.log();
console.log("Per-month totals:");
for (const m of Q3) {
  const t = monthTotals[m.key];
  console.log(`  ${m.key}:  ${t.rows} rows  ·  ${t.matches} matches`);
}
console.log(`  GRAND TOTAL:  ${totalRows} rows  ·  ${totalMatches} matches`);

console.log();
console.log(
  `Idempotency check: ${scheduleRows.length} planned, ${toInsert.length} new, ${skipped} skipped (already exist).`,
);

console.log();
console.log("Override rows (monthly_flat carry-forward from May 2026):");
for (const o of overrideRows) {
  const name = MONTHLY_FLAT_VENUES.find(
    (n) => venueByName.get(n).id === o.venue_id,
  );
  console.log(
    `  ${name.padEnd(16)}  ${o.month}  $${o.override_amount}  reason="${o.reason}"`,
  );
}
console.log(`Override rows planned: ${overrideRows.length}`);

console.log();
console.log("Sample first 5 fin_schedule INSERT payloads (post-dedup):");
for (const r of toInsert.slice(0, 5)) {
  console.log(" ", JSON.stringify(r));
}
console.log();
console.log("Sample first override INSERT payload:");
if (overrideRows[0]) console.log(" ", JSON.stringify(overrideRows[0]));

console.log();
console.log("Rollback statements (after apply):");
console.log(
  `  DELETE FROM fin_schedule WHERE created_by = '${TAG}' AND month IN ('Jul 2026', 'Aug 2026', 'Sep 2026');`,
);
console.log(
  `  DELETE FROM fin_venue_cost_overrides WHERE created_by = '${TAG}' AND month IN ('Jul 2026', 'Aug 2026', 'Sep 2026');`,
);

// -----------------------------------------------------------------
// 6. Apply (if --apply flag) — otherwise stop here.
// -----------------------------------------------------------------
if (!APPLY) {
  console.log();
  console.log("DRY RUN COMPLETE. No rows were inserted. Re-run with --apply to actually insert.");
  process.exit(0);
}

console.log();
console.log("APPLY MODE — inserting now…");

if (toInsert.length > 0) {
  // Insert in chunks of 200 to keep payload size reasonable.
  const CHUNK = 200;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const batch = toInsert.slice(i, i + CHUNK);
    const { error: insErr, data: ins } = await sb
      .from("fin_schedule")
      .insert(batch)
      .select("id");
    if (insErr) {
      console.error(`Schedule insert failed at chunk ${i}:`, insErr);
      process.exit(1);
    }
    inserted += ins?.length ?? batch.length;
  }
  console.log(`fin_schedule: ${inserted} rows inserted, ${skipped} skipped.`);
} else {
  console.log("fin_schedule: nothing to insert (all rows already exist).");
}

if (overrideRows.length > 0) {
  const { error: ovErr, data: ovIns } = await sb
    .from("fin_venue_cost_overrides")
    .insert(overrideRows)
    .select("id");
  if (ovErr) {
    console.error("Override insert failed:", ovErr);
    process.exit(1);
  }
  console.log(`fin_venue_cost_overrides: ${ovIns?.length ?? overrideRows.length} rows inserted.`);
} else {
  console.log("fin_venue_cost_overrides: nothing to insert (all already exist).");
}

console.log();
console.log("Q3 prefill complete.");
