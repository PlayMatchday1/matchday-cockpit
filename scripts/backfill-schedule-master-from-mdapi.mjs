// Backfill schedule_master from mdapi_matches (additive-only).
//
// Window: 2026-03-01 .. 2026-05-21 inclusive.
//
// Source: alive (is_cancelled IS NOT TRUE) mdapi_matches with a
// resolvable venue via fin_venue_fields.mdapi_field_id. Cancelled
// rows are excluded (they didn't run, no cost). Unresolvable rows
// are excluded and surfaced so missing fin_venue_fields links can
// be added before re-running.
//
// Dedup: (venue_id, match_date, hh:mm). venue_id resolves from
// mdapi_field_id on the mdapi side; from existing
// schedule_master.mdapi_field_id (primary) or (city, venue)
// case-insensitive string match (fallback for pre-PR-D rows) on
// the schedule_master side. hh:mm on the schedule_master side
// parses match_time with the same regex as
// src/app/api/schedule-master/discrepancies/route.ts so the dedup
// agrees with the live reconciliation view.
//
// Field mapping (mdapi → schedule_master):
//   mdapi_field_id  ← m.field_id
//   city / venue    ← fin_venues row reached via fin_venue_fields
//   detail          ← m.field_title
//   match_date      ← (m.start_date AT TIME ZONE UTC)::date
//   match_time      ← "H:MM AM/PM - H:MM AM/PM" with end = start + 1h
//   max_spots       ← m.max_player_count
//
// Audit: each insert writes a paired schedule_master_audit row
// (action='create', user_email='backfill-script') so the audit
// ledger reflects every backfilled row.
//
// Idempotent: re-running picks up only new misses. ADDITIVE ONLY —
// the script never updates or deletes existing schedule_master rows
// (the stray-row cleanup is a separate pass with row-level review).
//
// Usage:
//   node scripts/backfill-schedule-master-from-mdapi.mjs --dry-run
//   node scripts/backfill-schedule-master-from-mdapi.mjs --apply

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const apply = args.includes("--apply");
if ((dryRun && apply) || (!dryRun && !apply)) {
  console.error("Pass exactly one of --dry-run or --apply.");
  process.exit(2);
}

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
function readEnv(name) {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, "");
}
const url = readEnv("NEXT_PUBLIC_SUPABASE_URL");
const key = readEnv("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.",
  );
  process.exit(2);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const START_DATE = "2026-03-01";
const END_DATE = "2026-05-21";
const START_STAMP = "2026-03-01T00:00:00Z";
const END_STAMP = "2026-05-22T00:00:00Z"; // exclusive upper

async function selectAll(factory) {
  const PAGE = 1000;
  let from = 0;
  const all = [];
  while (true) {
    const { data, error } = await factory().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Mirrors parseStartHHMM in
// src/app/api/schedule-master/discrepancies/route.ts so existing-row
// dedup keys agree with the live reconciliation view.
function parseStartHHMM(time) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/.exec(time ?? "");
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// mdapi.start_date encodes venue-local wall clock as timestamptz at
// UTC offset (see src/lib/cityTimezones.ts header) — so reading UTC
// parts gives the local calendar date/time directly.
function mdapiLocalDate(startDate) {
  const d = new Date(startDate);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}
function mdapiLocalHHMM(startDate) {
  const d = new Date(startDate);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes(),
  ).padStart(2, "0")}`;
}

function fmt12(h24, min) {
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}
function formatMatchTime(startDate) {
  const d = new Date(startDate);
  const h24 = d.getUTCHours();
  const min = d.getUTCMinutes();
  const endH = (h24 + 1) % 24;
  return `${fmt12(h24, min)} - ${fmt12(endH, min)}`;
}

// Monday of the ISO week containing dateStr (YYYY-MM-DD). UTC math
// because match_date is a calendar date and we want grouping to
// agree across DST etc.
function weekStartMonday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun .. 6=Sat
  const offset = (dow + 6) % 7; // Sun→6, Mon→0, Tue→1 ...
  d.setUTCDate(d.getUTCDate() - offset);
  return mdapiLocalDate(d.toISOString());
}

console.log(
  `\n=== schedule_master backfill ${dryRun ? "DRY-RUN" : "APPLY"} ===`,
);
console.log(`Window: ${START_DATE} .. ${END_DATE}`);

const [mdapi, sm, vfRows, venues] = await Promise.all([
  selectAll(() =>
    sb
      .from("mdapi_matches")
      .select(
        "api_id, field_id, field_title, start_date, is_cancelled, max_player_count",
      )
      .gte("start_date", START_STAMP)
      .lt("start_date", END_STAMP),
  ),
  selectAll(() =>
    sb
      .from("schedule_master")
      .select("id, city, venue, match_date, match_time, mdapi_field_id")
      .gte("match_date", START_DATE)
      .lte("match_date", END_DATE),
  ),
  selectAll(() =>
    sb
      .from("fin_venue_fields")
      .select("mdapi_field_id, fin_venue_id"),
  ),
  selectAll(() =>
    sb.from("fin_venues").select("id, city, venue_name"),
  ),
]);

const fieldToVenueId = new Map();
for (const r of vfRows)
  fieldToVenueId.set(Number(r.mdapi_field_id), Number(r.fin_venue_id));
const venueById = new Map();
for (const v of venues) venueById.set(Number(v.id), v);
const nameToVenueId = new Map();
for (const v of venues) {
  nameToVenueId.set(
    `${v.city.trim().toLowerCase()}|${v.venue_name.trim().toLowerCase()}`,
    Number(v.id),
  );
}

// Build the dedup index from existing schedule_master rows.
const existing = new Set();
let smUnresolved = 0;
let smUnparsedTime = 0;
for (const s of sm) {
  let venueId =
    s.mdapi_field_id != null
      ? fieldToVenueId.get(Number(s.mdapi_field_id))
      : undefined;
  if (venueId == null) {
    venueId = nameToVenueId.get(
      `${(s.city ?? "").trim().toLowerCase()}|${(s.venue ?? "")
        .trim()
        .toLowerCase()}`,
    );
  }
  if (venueId == null) {
    smUnresolved += 1;
    continue;
  }
  const hhmm = parseStartHHMM(s.match_time);
  if (!hhmm) {
    smUnparsedTime += 1;
    continue;
  }
  existing.add(`${venueId}|${s.match_date}|${hhmm}`);
}

// Build the candidate set from alive, resolvable mdapi rows.
const candidates = [];
let cancelled = 0;
let unresolvable = 0;
const unresolvableSet = new Map(); // field_id → { title, count }
for (const m of mdapi) {
  if (m.is_cancelled === true) {
    cancelled += 1;
    continue;
  }
  if (m.field_id == null) {
    unresolvable += 1;
    continue;
  }
  const venueId = fieldToVenueId.get(Number(m.field_id));
  if (venueId == null) {
    unresolvable += 1;
    const k = String(m.field_id);
    if (!unresolvableSet.has(k))
      unresolvableSet.set(k, { title: m.field_title ?? "", count: 0 });
    unresolvableSet.get(k).count += 1;
    continue;
  }
  const v = venueById.get(venueId);
  if (!v) {
    unresolvable += 1;
    continue;
  }
  const matchDate = mdapiLocalDate(m.start_date);
  const hhmm = mdapiLocalHHMM(m.start_date);
  const dedupKey = `${venueId}|${matchDate}|${hhmm}`;
  if (existing.has(dedupKey)) continue;
  candidates.push({
    _venueId: venueId,
    _hhmm: hhmm,
    _apiId: m.api_id,
    city: v.city,
    venue: v.venue_name,
    detail: m.field_title ?? v.venue_name,
    match_date: matchDate,
    match_time: formatMatchTime(m.start_date),
    max_spots: Number(m.max_player_count ?? 0) || 0,
    mdapi_field_id: Number(m.field_id),
  });
}

// Self-dedup (defensive — rare: same field_id, date, hhmm appearing
// twice in mdapi). Keep first occurrence.
const seen = new Set();
const finalInserts = [];
let selfDup = 0;
for (const c of candidates) {
  const k = `${c._venueId}|${c.match_date}|${c._hhmm}`;
  if (seen.has(k)) {
    selfDup += 1;
    continue;
  }
  seen.add(k);
  finalInserts.push(c);
}

// Grouping for the summary.
const byMonth = new Map();
for (const c of finalInserts) {
  const k = c.match_date.slice(0, 7);
  byMonth.set(k, (byMonth.get(k) ?? 0) + 1);
}
const byVenueWeek = new Map();
for (const c of finalInserts) {
  const week = weekStartMonday(c.match_date);
  const k = `${c.city}|${c.venue}|${week}`;
  if (!byVenueWeek.has(k)) {
    byVenueWeek.set(k, { city: c.city, venue: c.venue, week, count: 0 });
  }
  byVenueWeek.get(k).count += 1;
}
const rows = [...byVenueWeek.values()].sort(
  (a, b) =>
    a.city.localeCompare(b.city) ||
    a.venue.localeCompare(b.venue) ||
    a.week.localeCompare(b.week),
);

console.log(`\nSource mdapi_matches in window: ${mdapi.length}`);
console.log(`  cancelled (excluded):              ${cancelled}`);
console.log(`  alive unresolvable (excluded):     ${unresolvable}`);
console.log(
  `  alive candidates after sm dedup:   ${candidates.length}`,
);
console.log(`  self-dedup collapsed:              ${selfDup}`);
console.log(`Existing schedule_master in window: ${sm.length}`);
console.log(`  sm unresolvable (excluded from dedup): ${smUnresolved}`);
console.log(`  sm with unparsable match_time:         ${smUnparsedTime}`);

if (unresolvableSet.size > 0) {
  console.log(`\nUnresolvable mdapi field_ids (need fin_venue_fields entry):`);
  for (const [fid, { title, count }] of [...unresolvableSet.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    console.log(`  field_id=${fid}  "${title}"  ${count} alive matches`);
  }
}

console.log("\n=== By month ===");
for (const [m, n] of [...byMonth.entries()].sort()) {
  console.log(`  ${m}:  +${n}`);
}

console.log("\n=== By venue · week ===");
let curCity = "";
for (const r of rows) {
  if (r.city !== curCity) {
    console.log(`\n${r.city}`);
    curCity = r.city;
  }
  console.log(`  ${r.venue.padEnd(38)} week ${r.week}  +${r.count}`);
}

console.log(`\nTOTAL inserts: ${finalInserts.length}`);

if (dryRun) {
  console.log("\nDRY-RUN — no writes. Re-run with --apply to insert.");
  process.exit(0);
}

// --apply path. Insert in batches of 100; write paired audit rows
// after each batch using the returned ids. Halt the run on any
// schedule_master insert error so partial writes don't fan out.
const BATCH_SIZE = 100;
console.log(`\nApplying in batches of ${BATCH_SIZE}...`);
let inserted = 0;
let auditWritten = 0;
let auditFailures = 0;
for (let i = 0; i < finalInserts.length; i += BATCH_SIZE) {
  const batch = finalInserts.slice(i, i + BATCH_SIZE);
  const payload = batch.map((c) => ({
    city: c.city,
    venue: c.venue,
    detail: c.detail,
    match_date: c.match_date,
    match_time: c.match_time,
    max_spots: c.max_spots,
    mdapi_field_id: c.mdapi_field_id,
  }));
  const { data, error } = await sb
    .from("schedule_master")
    .insert(payload)
    .select("id");
  if (error) {
    console.error(`Batch starting at ${i} failed:`, error);
    process.exit(1);
  }
  inserted += data?.length ?? 0;

  // Audit. Postgres-side ordering of returned rows mirrors input
  // order for insert ... returning, but assert for safety.
  if ((data?.length ?? 0) !== payload.length) {
    console.error(
      `Batch ${i / BATCH_SIZE}: expected ${payload.length} rows back, got ${
        data?.length ?? 0
      }. Aborting before audit.`,
    );
    process.exit(1);
  }
  const auditPayload = data.map((r, idx) => ({
    row_id: r.id,
    action: "create",
    user_email: "backfill-script",
    old_values: null,
    new_values: payload[idx],
  }));
  const { error: aerr } = await sb
    .from("schedule_master_audit")
    .insert(auditPayload);
  if (aerr) {
    auditFailures += auditPayload.length;
    console.error(
      `Batch ${i / BATCH_SIZE} audit insert failed (${auditPayload.length} rows, schedule_master rows already written):`,
      aerr,
    );
  } else {
    auditWritten += auditPayload.length;
  }
  console.log(
    `  inserted ${inserted}/${finalInserts.length} (audit ok ${auditWritten}, audit failures ${auditFailures})`,
  );
}
console.log(
  `\nDone. Inserted ${inserted} rows. Audit rows written: ${auditWritten}. Audit failures: ${auditFailures}.`,
);
