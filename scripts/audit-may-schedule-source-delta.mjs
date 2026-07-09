// Read-only audit. Compares May 2026 match counts per venue between:
//   - fin_schedule.match_count (current Finance source)
//   - schedule_master row count (proposed source: one row per match)
// Then projects the $ delta against each venue's per_match_rate or
// hourly_rate × derived hours, and surfaces venues that exist in one
// source but not the other.
//
// Matching strategy: we join on fin_venues.id.
//   - fin_schedule already carries fin_venue_id (backfilled per PR-F),
//     but for safety we also resolve by raw_venue_name when null.
//   - schedule_master uses mdapi_field_id (PR-D backfill) → fin_venue_fields
//     → fin_venues.id. Fallback: (city, venue) lowercased string match
//     against fin_venues(city, venue_name) — same logic as
//     src/app/api/schedule-master/discrepancies/route.ts.
//
// Output: per-venue table + summary totals. No writes.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key, { auth: { persistSession: false } });

const MAY_START = "2026-05-01";
const MAY_END = "2026-05-31";

// City code → display name and the reverse. schedule_master.city uses
// display names (Atlanta / Austin / Dallas / OKC / Houston / etc.)
// matching fin_venues.city, so no remap needed for the string-fallback
// path. Kept here only for readable logging.
const fmtMoney = (n) => {
  const v = Math.round(n);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US")}`;
};

async function selectAll(builderFactory) {
  const PAGE = 1000;
  let from = 0;
  const all = [];
  while (true) {
    const { data, error } = await builderFactory().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

const [venues, fields, finSchedule, scheduleMaster, aliases] = await Promise.all(
  [
    selectAll(() =>
      sb
        .from("fin_venues")
        .select(
          "id, city, venue_name, billing_type, per_match_rate, hourly_rate, is_active",
        )
        .order("id"),
    ),
    selectAll(() =>
      sb
        .from("fin_venue_fields")
        .select("fin_venue_id, mdapi_field_id"),
    ),
    selectAll(() =>
      sb
        .from("fin_schedule")
        .select(
          "id, city, venue, date, month, match_count, total_hours, fin_venue_id",
        )
        .eq("month", "May 2026"),
    ),
    selectAll(() =>
      sb
        .from("schedule_master")
        .select("id, city, venue, match_date, mdapi_field_id")
        .gte("match_date", MAY_START)
        .lte("match_date", MAY_END),
    ),
    selectAll(() =>
      sb.from("fin_venue_aliases").select("alias, canonical_venue"),
    ),
  ],
);

// Build alias map for venue-name canonicalization, matching
// useFinanceData's behavior.
const aliasMap = new Map();
for (const a of aliases) {
  if (a.alias && a.canonical_venue) aliasMap.set(a.alias, a.canonical_venue);
}
const canonName = (s) => aliasMap.get(s) ?? s;

// venueId → venue row
const venueById = new Map();
for (const v of venues) venueById.set(v.id, v);

// (city, canonical_venue_name_lower) → venueId
const nameToVenueId = new Map();
for (const v of venues) {
  const key = `${v.city}|${canonName(v.venue_name).toLowerCase()}`;
  nameToVenueId.set(key, v.id);
}
// Also key by raw venue_name (pre-alias) — fin_venues sometimes
// carries the pre-alias string directly.
for (const v of venues) {
  const key = `${v.city}|${v.venue_name.toLowerCase()}`;
  if (!nameToVenueId.has(key)) nameToVenueId.set(key, v.id);
}

// fieldId → venueId
const fieldToVenueId = new Map();
for (const f of fields) {
  if (f.mdapi_field_id != null && f.fin_venue_id != null) {
    fieldToVenueId.set(Number(f.mdapi_field_id), Number(f.fin_venue_id));
  }
}

function resolveScheduleMasterVenueId(row) {
  if (row.mdapi_field_id != null) {
    const vid = fieldToVenueId.get(Number(row.mdapi_field_id));
    if (vid != null) return { venueId: vid, via: "field_id" };
  }
  const raw = canonName(row.venue ?? "");
  const key = `${row.city}|${raw.toLowerCase()}`;
  const vid = nameToVenueId.get(key);
  if (vid != null) return { venueId: vid, via: "name" };
  return { venueId: null, via: "unresolved" };
}

function resolveFinScheduleVenueId(row) {
  if (row.fin_venue_id != null) return { venueId: Number(row.fin_venue_id), via: "fin_venue_id" };
  const raw = canonName(row.venue ?? "");
  const key = `${row.city}|${raw.toLowerCase()}`;
  const vid = nameToVenueId.get(key);
  if (vid != null) return { venueId: vid, via: "name" };
  return { venueId: null, via: "unresolved" };
}

// Aggregate counts per venueId from each source.
const finByVenue = new Map(); // venueId → { matchCount, totalHours, rows }
let finUnresolved = 0;
for (const r of finSchedule) {
  const { venueId } = resolveFinScheduleVenueId(r);
  if (venueId == null) {
    finUnresolved += 1;
    continue;
  }
  if (!finByVenue.has(venueId)) {
    finByVenue.set(venueId, { matchCount: 0, totalHours: 0, rows: 0 });
  }
  const acc = finByVenue.get(venueId);
  acc.matchCount += Number(r.match_count ?? 0);
  acc.totalHours += Number(r.total_hours ?? 0);
  acc.rows += 1;
}

const smByVenue = new Map(); // venueId → { count, rows: ScheduleMasterRow[] }
const smUnresolved = [];
for (const r of scheduleMaster) {
  const { venueId, via } = resolveScheduleMasterVenueId(r);
  if (venueId == null) {
    smUnresolved.push({ city: r.city, venue: r.venue, date: r.match_date });
    continue;
  }
  if (!smByVenue.has(venueId)) {
    smByVenue.set(venueId, { count: 0, rows: [], resolvedVia: via });
  }
  const acc = smByVenue.get(venueId);
  acc.count += 1;
  acc.rows.push(r);
}

// Union of venueIds — only include venues active or referenced.
const allVenueIds = new Set([...finByVenue.keys(), ...smByVenue.keys()]);

const rows = [];
for (const vid of allVenueIds) {
  const v = venueById.get(vid);
  if (!v) continue;
  const fin = finByVenue.get(vid) ?? { matchCount: 0, totalHours: 0, rows: 0 };
  const sm = smByVenue.get(vid) ?? { count: 0, rows: [], resolvedVia: "—" };

  // Cost projection. Only applies to per_match (most common); per_hour
  // uses total_hours which schedule_master does not currently encode.
  let finCost = 0;
  let smCost = 0;
  let costNote = "";
  if (v.billing_type === "per_match") {
    const rate = Number(v.per_match_rate ?? 0);
    finCost = fin.matchCount * rate;
    smCost = sm.count * rate;
    costNote = `× $${rate}`;
  } else if (v.billing_type === "per_hour") {
    // Per-hour venues' cost is currently driven by fin_schedule.total_hours.
    // schedule_master doesn't carry hours per match, so we can't restate
    // cost from it directly. Surface this as a caveat row.
    costNote = `per_hour (no hours in schedule_master)`;
  } else {
    costNote = v.billing_type;
  }

  rows.push({
    venueId: vid,
    city: v.city,
    venueName: v.venue_name,
    billingType: v.billing_type,
    isActive: v.is_active,
    finMatchCount: fin.matchCount,
    finScheduleRows: fin.rows,
    smMatchCount: sm.count,
    deltaCount: sm.count - fin.matchCount,
    finCost,
    smCost,
    deltaCost: smCost - finCost,
    costNote,
    resolvedVia: sm.resolvedVia,
  });
}

rows.sort((a, b) => {
  const k = a.city.localeCompare(b.city);
  if (k !== 0) return k;
  return a.venueName.localeCompare(b.venueName);
});

console.log("\n=== May 2026 — match count per venue ===");
console.log(
  "(billing_type) city · venue                              fin → sm   Δcnt    finCost → smCost    Δcost      note",
);
console.log("".padEnd(125, "-"));
for (const r of rows) {
  const activeMark = r.isActive ? " " : "*";
  const left = `${activeMark}(${r.billingType.padEnd(13)}) ${r.city.padEnd(8)} · ${r.venueName}`.padEnd(60);
  const cnt = `${String(r.finMatchCount).padStart(4)} → ${String(r.smMatchCount).padStart(4)}`;
  const dcnt =
    r.deltaCount === 0
      ? "  0".padStart(6)
      : (r.deltaCount > 0 ? `+${r.deltaCount}` : String(r.deltaCount)).padStart(6);
  const cost =
    r.billingType === "per_match"
      ? `${fmtMoney(r.finCost).padStart(8)} → ${fmtMoney(r.smCost).padStart(8)}`
      : "         —          —";
  const dcost =
    r.billingType === "per_match"
      ? (r.deltaCost === 0
          ? "  $0"
          : r.deltaCost > 0
            ? `+${fmtMoney(r.deltaCost)}`
            : fmtMoney(r.deltaCost)
        ).padStart(10)
      : "        —";
  console.log(`${left}  ${cnt}  ${dcnt}  ${cost}  ${dcost}   ${r.costNote}`);
}
console.log("(* = is_active=false)");

// Totals only for per_match (where we can compute cost).
const perMatch = rows.filter((r) => r.billingType === "per_match");
const totalFin = perMatch.reduce((s, r) => s + r.finCost, 0);
const totalSm = perMatch.reduce((s, r) => s + r.smCost, 0);
const totalFinCount = perMatch.reduce((s, r) => s + r.finMatchCount, 0);
const totalSmCount = perMatch.reduce((s, r) => s + r.smMatchCount, 0);

console.log("\n=== Totals (per_match venues only) ===");
console.log(`  fin_schedule:   ${totalFinCount} matches → ${fmtMoney(totalFin)}`);
console.log(`  schedule_master: ${totalSmCount} matches → ${fmtMoney(totalSm)}`);
console.log(
  `  delta:          ${totalSmCount - totalFinCount >= 0 ? "+" : ""}${
    totalSmCount - totalFinCount
  } matches → ${totalSm - totalFin >= 0 ? "+" : ""}${fmtMoney(totalSm - totalFin)}`,
);

// Venues only present in one source
const onlyInFin = rows.filter(
  (r) => r.finMatchCount > 0 && r.smMatchCount === 0,
);
const onlyInSm = rows.filter(
  (r) => r.smMatchCount > 0 && r.finMatchCount === 0,
);
console.log("\n=== Asymmetries ===");
if (onlyInFin.length) {
  console.log(`  Present in fin_schedule but NOT schedule_master (${onlyInFin.length}):`);
  for (const r of onlyInFin)
    console.log(
      `    ${r.city.padEnd(8)} · ${r.venueName.padEnd(35)} fin=${r.finMatchCount} (${r.billingType})`,
    );
}
if (onlyInSm.length) {
  console.log(`  Present in schedule_master but NOT fin_schedule (${onlyInSm.length}):`);
  for (const r of onlyInSm)
    console.log(
      `    ${r.city.padEnd(8)} · ${r.venueName.padEnd(35)} sm=${r.smMatchCount} (${r.billingType})`,
    );
}

console.log("\n=== Unresolved ===");
console.log(`  fin_schedule rows with no fin_venues match: ${finUnresolved}`);
if (smUnresolved.length) {
  console.log(`  schedule_master rows with no fin_venues match: ${smUnresolved.length}`);
  const seen = new Set();
  for (const u of smUnresolved) {
    const k = `${u.city}|${u.venue}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`    ${u.city.padEnd(8)} · ${u.venue}`);
  }
}

console.log("\n=== Source row counts ===");
console.log(`  fin_schedule    rows (May 2026): ${finSchedule.length}`);
console.log(`  schedule_master rows (May 2026): ${scheduleMaster.length}`);
