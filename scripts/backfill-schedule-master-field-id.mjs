// One-time backfill: populate schedule_master.mdapi_field_id for
// every row where the (city, venue) pair resolves to a single
// "regular" fin_venue_fields entry per the Option A strategy
// agreed in PR-D investigation.
//
// Regular field per fin_venues = the single fin_venue_fields row
// whose field_title_at_link does NOT match the keyword regex
// /Tournament|Tourney|Premier|Combine|Showdown|World Cup|Stadium/i.
// Per the PR-A seed, every ambiguous fin_venues row has exactly
// one entry left after that exclusion. Anything that breaks that
// invariant (e.g. ops adds a second non-special entry later) is
// reported as a skip with reason "multiple-regular-fields".
//
// Run AFTER migration 0042_schedule_master_field_id.sql is
// applied. Idempotent: only updates rows where mdapi_field_id IS
// NULL, so re-running after a partial run is safe.
//
// Usage: node scripts/backfill-schedule-master-field-id.mjs

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// City normalization — kept inline so this script has no src/
// imports. Mirrors src/lib/cityNormalization.ts CITY_MAP. If a
// new city is added there, update here too.
const CITY_MAP = {
  austin: "ATX", atx: "ATX",
  atlanta: "ATL", atl: "ATL",
  dallas: "DFW",
  "dallas / fort worth": "DFW",
  "dallas/fort worth": "DFW",
  dfw: "DFW",
  houston: "HOU", hou: "HOU",
  "oklahoma city": "OKC", okc: "OKC",
  "san antonio": "SATX", satx: "SATX",
  "st. louis": "STL", "st louis": "STL", "saint louis": "STL", stl: "STL",
  "el paso": "ELP", elp: "ELP",
};
function normalizeCityName(raw) {
  if (raw == null) return null;
  const k = String(raw).trim().toLowerCase();
  if (!k) return null;
  return CITY_MAP[k] ?? null;
}

const SPECIAL_FIELD_RE = /Tournament|Tourney|Premier|Combine|Showdown|World Cup|Stadium/i;

function fail(msg, err) {
  console.error(msg);
  if (err) console.error(JSON.stringify(err, null, 2));
  process.exit(1);
}

// 1. Load fin_venues + fin_venue_fields ---------------------------
console.log("Loading fin_venues + fin_venue_fields…");
const venuesRes = await sb
  .from("fin_venues")
  .select("id, venue_name, city");
if (venuesRes.error) fail("fin_venues query failed", venuesRes.error);
const venues = venuesRes.data ?? [];

const linksRes = await sb
  .from("fin_venue_fields")
  .select("fin_venue_id, mdapi_field_id, field_title_at_link");
if (linksRes.error) fail("fin_venue_fields query failed", linksRes.error);
const links = linksRes.data ?? [];

console.log(`  ${venues.length} fin_venues, ${links.length} fin_venue_fields`);

// 2. Resolve the "regular" field_id per fin_venues ----------------
// Group links by fin_venue_id, filter out specials, expect exactly
// one survivor.
const linksByVenue = new Map();
for (const l of links) {
  if (!linksByVenue.has(l.fin_venue_id)) linksByVenue.set(l.fin_venue_id, []);
  linksByVenue.get(l.fin_venue_id).push(l);
}
const regularFieldByVenue = new Map(); // fin_venues.id → mdapi_field_id
const venueResolutionWarnings = []; // { venue_id, reason, candidates }
for (const [venueId, group] of linksByVenue) {
  const nonSpecial = group.filter(
    (l) => !SPECIAL_FIELD_RE.test(l.field_title_at_link ?? ""),
  );
  if (nonSpecial.length === 1) {
    regularFieldByVenue.set(venueId, nonSpecial[0].mdapi_field_id);
  } else if (nonSpecial.length === 0) {
    venueResolutionWarnings.push({
      venue_id: venueId,
      reason: "no-regular-field",
      candidates: group.map((l) => `${l.mdapi_field_id} "${l.field_title_at_link}"`),
    });
  } else {
    venueResolutionWarnings.push({
      venue_id: venueId,
      reason: "multiple-regular-fields",
      candidates: nonSpecial.map((l) => `${l.mdapi_field_id} "${l.field_title_at_link}"`),
    });
  }
}

// 3. Build (cityCode, venue_name_lower) → fin_venues.id map ------
const venueNameToVenueId = new Map();
for (const v of venues) {
  const code = normalizeCityName(v.city);
  if (!code) continue;
  venueNameToVenueId.set(
    `${code}|${(v.venue_name ?? "").trim().toLowerCase()}`,
    v.id,
  );
}

// 4. Load schedule_master rows needing backfill -------------------
console.log("\nLoading schedule_master rows with mdapi_field_id IS NULL…");
const smRes = await sb
  .from("schedule_master")
  .select("id, city, venue")
  .is("mdapi_field_id", null);
if (smRes.error) fail("schedule_master query failed", smRes.error);
const rows = smRes.data ?? [];
console.log(`  ${rows.length} rows to consider`);

// 5. Walk rows, classify, batch updates ---------------------------
const toUpdate = []; // { id, field_id }
const skippedByReason = new Map(); // reason → count
const skippedExamples = new Map(); // reason → first 3 example rows
function bumpSkip(reason, row) {
  skippedByReason.set(reason, (skippedByReason.get(reason) ?? 0) + 1);
  if (!skippedExamples.has(reason)) skippedExamples.set(reason, []);
  const exs = skippedExamples.get(reason);
  if (exs.length < 3) exs.push(row);
}

for (const r of rows) {
  const code = normalizeCityName(r.city);
  if (!code) {
    bumpSkip("unknown-city", r);
    continue;
  }
  const venueId = venueNameToVenueId.get(
    `${code}|${(r.venue ?? "").trim().toLowerCase()}`,
  );
  if (venueId == null) {
    bumpSkip("no-fin-venues-match", r);
    continue;
  }
  const fieldId = regularFieldByVenue.get(venueId);
  if (fieldId == null) {
    bumpSkip("no-regular-field-for-venue", { ...r, venueId });
    continue;
  }
  toUpdate.push({ id: r.id, field_id: fieldId });
}

console.log(`\nResolved ${toUpdate.length} rows; skipping ${rows.length - toUpdate.length}`);

// 6. Apply updates in batches -------------------------------------
let updated = 0;
let updateErrors = 0;
const BATCH = 200;
for (let i = 0; i < toUpdate.length; i += BATCH) {
  const slice = toUpdate.slice(i, i + BATCH);
  await Promise.all(
    slice.map(async ({ id, field_id }) => {
      const u = await sb
        .from("schedule_master")
        .update({ mdapi_field_id: field_id })
        .eq("id", id);
      if (u.error) {
        updateErrors += 1;
        console.error(`  UPDATE failed for id=${id}:`, u.error.message);
      } else {
        updated += 1;
      }
    }),
  );
  process.stdout.write(`  ${Math.min(i + BATCH, toUpdate.length)}/${toUpdate.length}\r`);
}
console.log("");

// 7. Summary ------------------------------------------------------
console.log("\n" + "=".repeat(60));
console.log("BACKFILL SUMMARY");
console.log("=".repeat(60));
console.log(`Rows considered:   ${rows.length}`);
console.log(`Rows updated:      ${updated}`);
console.log(`Update errors:     ${updateErrors}`);
console.log(`Rows skipped:      ${rows.length - toUpdate.length}`);

if (skippedByReason.size > 0) {
  console.log("\nSkipped breakdown:");
  for (const [reason, count] of skippedByReason) {
    console.log(`  ${reason}: ${count}`);
    const exs = skippedExamples.get(reason) ?? [];
    for (const ex of exs) {
      console.log(`    e.g. id=${ex.id}  city="${ex.city}"  venue="${ex.venue}"${ex.venueId ? `  venueId=${ex.venueId}` : ""}`);
    }
  }
}

if (venueResolutionWarnings.length > 0) {
  console.log("\nfin_venue_fields resolution warnings:");
  for (const w of venueResolutionWarnings) {
    console.log(`  venue_id=${w.venue_id}: ${w.reason}`);
    for (const c of w.candidates) console.log(`    candidate: ${c}`);
  }
}

if (updateErrors > 0) {
  console.error("\n✗ Completed with update errors. Re-run after diagnosing.");
  process.exit(1);
}
console.log("\n✓ Backfill complete.");
