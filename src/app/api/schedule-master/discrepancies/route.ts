// GET /api/schedule-master/discrepancies — compare the curated
// schedule_master template against actual mdapi_matches in a
// one-week window starting at week_start.
//
// Four buckets are reported:
//   missing_in_db — schedule_master rows with no matching
//                   mdapi_matches row on (city, venue, date, start time).
//   extra_in_db   — mdapi_matches rows with no schedule_master row.
//                   Includes cancelled mdapi rows that have no
//                   template entry — they are still "extra".
//   mismatched    — reserved. Always empty for now. max_spots
//                   was the original criterion but drifts per
//                   match in mdapi (bookings, weather), so it
//                   was retired as a false-positive source.
//                   Future: time-of-day drift inside the same
//                   hour, or other real mismatch signals.
//   cancelled     — mdapi_matches rows with is_cancelled=true AND a
//                   matching schedule_master entry. This is the
//                   operationally interesting case: the template
//                   says the match should happen but the live row
//                   has been cancelled (weather, low spots, etc).
//
// Matching key: (city_canonical, venue_canonical, match_date,
// hh:mm).
//
// City canonical is the short code produced by normalizeCityName
// in src/lib/cityNormalization.ts. Both sides are run through the
// same helper, which accepts either the human-readable name
// ("Austin", "Dallas / Fort Worth") or the canonical code ("ATX",
// "DFW") and returns the canonical code. On the mdapi side the
// city is read from raw.field.city.name first (some rows have
// their city info only in the raw JSONB and not in
// city_identifier), then falls back to city_identifier.
//
// Venue canonical is the fin_venues.id integer, resolved on the
// mdapi side from mdapi_matches.field_id → fin_venue_fields →
// fin_venues.id, and on the schedule_master side from
// (city, venue_name) → fin_venues.id. fin_venue_fields is the
// source of truth for field_id → venue links (seeded in migration
// 0041). The previous string-canonicalization path via
// src/lib/venueAliases.ts is no longer used in this route — a
// new tournament or marketing variant in mdapi (e.g. "Premier
// Match at Soccer Central") needs a new fin_venue_fields row,
// not a code change. venueAliases.ts stays in the repo because
// other paths (manager pay, finance) still depend on it; it gets
// removed in PR-G of the migration.
//
// Auth: admin via authenticateCrm.

import { authenticateCrm } from "@/lib/crmAuth";
import { normalizeCityName } from "@/lib/cityNormalization";

export const runtime = "nodejs";
export const maxDuration = 15;

const WINDOW_DAYS = 7; // selected week only
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Read the mdapi city from raw.field.city.name first, then fall
// back to city_identifier. Both forms pass through
// normalizeCityName which accepts either and returns the canonical
// short code (or null for unknown cities).
function matchCity(m: MatchRow): string | null {
  const fromRaw = m.raw?.field?.city?.name;
  const fromCode = m.city_identifier;
  return normalizeCityName(fromRaw) ?? normalizeCityName(fromCode);
}

type ScheduleRow = {
  id: string;
  city: string;
  venue: string;
  mdapi_field_id: number | null;
  detail: string;
  match_date: string;
  match_time: string;
  max_spots: number;
};

type MatchRow = {
  api_id: number;
  city_identifier: string | null;
  field_id: number | null;
  field_title: string | null;
  start_date: string | null;
  is_cancelled: boolean | null;
  max_player_count: number | null;
  raw: { field?: { city?: { name?: string | null } | null } | null } | null;
};

// Deduped warning surfaces. Logged once per unmapped value per
// process so a missing fin_venue_fields link doesn't spam logs
// across requests.
const warnedFieldIds = new Set<number>();
const warnedScheduleVenues = new Set<string>();
const warnedBareTimes = new Set<string>();
function warnUnmappedFieldId(fieldId: number, title: string | null): void {
  if (warnedFieldIds.has(fieldId)) return;
  warnedFieldIds.add(fieldId);
  console.warn(
    `[schedule-master:discrepancies] mdapi field_id ${fieldId} ("${title ?? ""}") has no fin_venue_fields entry — add the link in supabase/migrations or via ops.`,
  );
}
function warnUnmappedScheduleVenue(city: string, venue: string): void {
  const key = `${city}|${venue}`;
  if (warnedScheduleVenues.has(key)) return;
  warnedScheduleVenues.add(key);
  console.warn(
    `[schedule-master:discrepancies] schedule_master row (city="${city}", venue="${venue}") has no matching fin_venues row — check fin_venues.venue_name + city.`,
  );
}
function warnBareScheduleTime(time: string): void {
  if (warnedBareTimes.has(time)) return;
  warnedBareTimes.add(time);
  console.warn(
    `[schedule-master:discrepancies] schedule_master match_time "${time}" has no AM/PM token; assuming PM. Fix the source row (e.g. "9:00" -> "9:00 PM").`,
  );
}

type Out = {
  week_start: string;
  week_end: string;
  total_schedule_master: number;
  total_mdapi_matches: number;
  missing_in_db: Array<{
    id: string;
    city: string;
    venue: string;
    detail: string;
    match_date: string;
    match_time: string;
    max_spots: number;
  }>;
  extra_in_db: Array<{
    mdapi_match_id: number;
    city: string;
    venue: string;
    match_date: string;
    match_time: string;
    max_spots: number | null;
  }>;
  mismatched: Array<{
    schedule_master_id: string;
    mdapi_match_id: number;
    city: string;
    venue: string;
    match_date: string;
    match_time: string;
    diffs: string[];
  }>;
  cancelled: Array<{
    schedule_master_id: string;
    mdapi_match_id: number;
    city: string;
    venue: string;
    detail: string;
    match_date: string;
    match_time: string;
    max_spots: number;
  }>;
};

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const url = new URL(req.url);
  const weekStartParam = url.searchParams.get("week_start");
  const weekStart = parseWeekStart(weekStartParam);
  if (!weekStart) {
    return Response.json(
      { error: "week_start must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  const weekEnd = addDays(weekStart, WINDOW_DAYS - 1);
  const currentWeekEndIso = isoDate(addDays(weekStart, 6));
  const startIso = isoDate(weekStart);
  const endIso = isoDate(weekEnd);

  const sRes = await supabase
    .from("schedule_master")
    .select("id, city, venue, mdapi_field_id, detail, match_date, match_time, max_spots")
    .gte("match_date", startIso)
    .lte("match_date", endIso);
  if (sRes.error) {
    console.error("[schedule-master:discrepancies] schedule_master query failed", sRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const scheduleRows = (sRes.data ?? []) as ScheduleRow[];

  const startTs = `${startIso}T00:00:00Z`;
  const endTs = `${endIso}T23:59:59Z`;
  const mRes = await supabase
    .from("mdapi_matches")
    .select(
      "api_id, city_identifier, field_id, field_title, start_date, is_cancelled, max_player_count, raw",
    )
    .gte("start_date", startTs)
    .lte("start_date", endTs);
  if (mRes.error) {
    console.error("[schedule-master:discrepancies] mdapi_matches query failed", mRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const matchRows = (mRes.data ?? []) as MatchRow[];
  const matchRowsAlive = matchRows.filter((m) => m.is_cancelled !== true);
  const matchRowsCancelled = matchRows.filter((m) => m.is_cancelled === true);

  // Fetch the venue lookup maps. Two small queries (~25 fin_venues
  // rows, ~35 fin_venue_fields rows today) — payload negligible.
  const vRes = await supabase
    .from("fin_venues")
    .select("id, venue_name, city");
  if (vRes.error) {
    console.error("[schedule-master:discrepancies] fin_venues query failed", vRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const venueRows = (vRes.data ?? []) as Array<{
    id: number;
    venue_name: string;
    city: string;
  }>;

  const vfRes = await supabase
    .from("fin_venue_fields")
    .select("fin_venue_id, mdapi_field_id");
  if (vfRes.error) {
    console.error("[schedule-master:discrepancies] fin_venue_fields query failed", vfRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const venueFieldRows = (vfRes.data ?? []) as Array<{
    fin_venue_id: number;
    mdapi_field_id: number;
  }>;

  // venueNameToVenueId keys on `${cityCode}|${nameLower}` to match
  // the fin_venues UNIQUE (city, venue_name) constraint. Both
  // sides of the lookup run the city through normalizeCityName so
  // schedule_master "Austin" and fin_venues "Austin" converge on
  // "ATX".
  const venueNameToVenueId = new Map<string, number>();
  for (const v of venueRows) {
    const cityCode = normalizeCityName(v.city);
    if (!cityCode) continue;
    venueNameToVenueId.set(
      `${cityCode}|${v.venue_name.trim().toLowerCase()}`,
      v.id,
    );
  }
  const fieldIdToVenueId = new Map<number, number>();
  for (const vf of venueFieldRows) {
    fieldIdToVenueId.set(vf.mdapi_field_id, vf.fin_venue_id);
  }

  type Indexed = {
    cityName: string;
    venueId: number;
    date: string;
    hhmm: string;
  };
  const sIndex: Array<Indexed & { row: ScheduleRow }> = [];
  for (const r of scheduleRows) {
    if (!r.city || !r.venue) continue;
    const cityName = normalizeCityName(r.city);
    if (!cityName) continue;
    // Prefer mdapi_field_id when present — mirrors the mdapi side
    // and avoids string-mismatch drops when schedule_master.venue
    // ("PRUMC") doesn't equal fin_venues.venue_name ("Peachtree
    // Road UMC"). Falls back to the legacy string lookup for any
    // pre-PR-D rows that still have NULL mdapi_field_id.
    let venueId =
      r.mdapi_field_id != null ? fieldIdToVenueId.get(r.mdapi_field_id) : undefined;
    if (venueId == null) {
      venueId = venueNameToVenueId.get(
        `${cityName}|${r.venue.trim().toLowerCase()}`,
      );
      if (venueId == null) {
        warnUnmappedScheduleVenue(r.city, r.venue);
        continue;
      }
    }
    sIndex.push({
      cityName,
      venueId,
      date: r.match_date,
      hhmm: parseStartHHMM(r.match_time),
      row: r,
    });
  }
  function indexMatch(m: MatchRow): (Indexed & { row: MatchRow }) | null {
    const cityName = matchCity(m);
    if (!cityName) return null;
    if (m.field_id == null) return null;
    const venueId = fieldIdToVenueId.get(m.field_id);
    if (venueId == null) {
      warnUnmappedFieldId(m.field_id, m.field_title);
      return null;
    }
    const start = matchStart(m);
    if (!start) return null;
    return {
      cityName,
      venueId,
      date: start.date,
      hhmm: start.hhmm,
      row: m,
    };
  }
  const mIndex: Array<Indexed & { row: MatchRow }> = [];
  for (const m of matchRowsAlive) {
    const i = indexMatch(m);
    if (i) mIndex.push(i);
  }
  // Cancelled mdapi rows are indexed into a parallel bucket. A
  // schedule_master entry whose only mdapi counterpart is cancelled
  // must be reported in the cancelled bucket, not as missing — the
  // match exists in mdapi, it's just been called off.
  const mIndexCancelled: Array<Indexed & { row: MatchRow }> = [];
  for (const m of matchRowsCancelled) {
    const i = indexMatch(m);
    if (i) mIndexCancelled.push(i);
  }

  function bucketize<T extends Indexed>(arr: T[]): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const x of arr) {
      const key = `${x.cityName}|${x.venueId}|${x.date}|${x.hhmm}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(x);
    }
    return map;
  }

  const sBuckets = bucketize(sIndex);
  const mBuckets = bucketize(mIndex);
  const mBucketsCancelled = bucketize(mIndexCancelled);
  const allKeys = new Set([
    ...sBuckets.keys(),
    ...mBuckets.keys(),
    ...mBucketsCancelled.keys(),
  ]);

  const missing_in_db: Out["missing_in_db"] = [];
  const extra_in_db: Out["extra_in_db"] = [];
  const mismatched: Out["mismatched"] = [];
  const cancelled: Out["cancelled"] = [];

  for (const key of allKeys) {
    const sBucket = sBuckets.get(key) ?? [];
    const mBucket = mBuckets.get(key) ?? [];
    const cBucket = mBucketsCancelled.get(key) ?? [];

    const pairedAlive = Math.min(sBucket.length, mBucket.length);
    for (let i = 0; i < pairedAlive; i++) {
      const s = sBucket[i];
      const m = mBucket[i];
      const diffs: string[] = [];
      if (diffs.length > 0) {
        mismatched.push({
          schedule_master_id: s.row.id,
          mdapi_match_id: m.row.api_id,
          city: s.row.city,
          venue: s.row.detail,
          match_date: s.row.match_date,
          match_time: s.row.match_time,
          diffs,
        });
      }
    }

    // Surplus schedule_master rows first pair against the cancelled
    // bucket. Those entries belong in `cancelled`, not in
    // missing_in_db — the template entry exists in mdapi, just
    // cancelled. Pair positionally to handle multi-entry keys.
    const pairedCancelled = Math.min(
      sBucket.length - pairedAlive,
      cBucket.length,
    );
    for (let i = 0; i < pairedCancelled; i++) {
      const sEntry = sBucket[pairedAlive + i];
      const m = cBucket[i].row;
      // Out-of-week cancelled-with-template silently dropped. The
      // displayed grid only spans the current week and operators
      // only act on current-week cancellations; the extra noise
      // would crowd the banner without changing anything
      // operationally. extra_in_db keeps its full 14-day window.
      if (sEntry.date > currentWeekEndIso) continue;
      const s = sEntry.row;
      cancelled.push({
        schedule_master_id: s.id,
        mdapi_match_id: m.api_id,
        city: s.city,
        venue: s.venue,
        detail: s.detail,
        match_date: s.match_date,
        match_time: s.match_time,
        max_spots: s.max_spots,
      });
    }

    // Remaining schedule_master rows are truly missing — no mdapi
    // counterpart, alive or cancelled.
    for (let i = pairedAlive + pairedCancelled; i < sBucket.length; i++) {
      const s = sBucket[i].row;
      missing_in_db.push({
        id: s.id,
        city: s.city,
        venue: s.venue,
        detail: s.detail,
        match_date: s.match_date,
        match_time: s.match_time,
        max_spots: s.max_spots,
      });
    }

    // Surplus alive mdapi rows → extra_in_db (real extras).
    for (let i = pairedAlive; i < mBucket.length; i++) {
      const m = mBucket[i].row;
      extra_in_db.push({
        mdapi_match_id: m.api_id,
        city: m.city_identifier ?? "?",
        venue: m.field_title ?? "?",
        match_date: mBucket[i].date,
        match_time: hhmmTo12h(mBucket[i].hhmm),
        max_spots: m.max_player_count,
      });
    }

    // Surplus cancelled mdapi rows (no template entry left to pair
    // against) are intentionally dropped — NOT reported.
    //
    // A cancelled mdapi row with no schedule_master counterpart
    // represents platform-side activity that was never owed by the
    // template: private rentals, one-off ad-hoc bookings, host-
    // created matches that didn't go in the template and then got
    // cancelled. There's no template entry to reconcile against and
    // the match isn't running, so this is operationally a non-event
    // — flagging it as `extra_in_db` ("missing on Clubhouse") just
    // creates false-positive noise. The actionable cancelled
    // signal — "template exists, platform cancelled the match" —
    // is fully covered by the pairedCancelled loop above which
    // populates the `cancelled` bucket.
    //
    // The surplus-alive loop just above (extra_in_db from mBucket)
    // still fires for active platform matches with no template
    // counterpart — those ARE meaningful (a manager booked a real
    // match outside the planned schedule).
  }

  const byDateThenCityThenTime = (a: { match_date: string; city: string; match_time: string }, b: { match_date: string; city: string; match_time: string }) =>
    a.match_date.localeCompare(b.match_date) ||
    a.city.localeCompare(b.city) ||
    a.match_time.localeCompare(b.match_time);
  missing_in_db.sort(byDateThenCityThenTime);
  extra_in_db.sort(byDateThenCityThenTime);
  mismatched.sort(byDateThenCityThenTime);
  cancelled.sort(byDateThenCityThenTime);

  const out: Out = {
    week_start: startIso,
    week_end: endIso,
    total_schedule_master: scheduleRows.length,
    total_mdapi_matches: matchRowsAlive.length,
    missing_in_db,
    extra_in_db,
    mismatched,
    cancelled,
  };
  return Response.json(out, { status: 200 });
}

// ============================================================
// Date / time helpers
// ============================================================

function parseWeekStart(input: string | null): Date | null {
  if (input) {
    if (!ISO_DATE.test(input)) return null;
    const d = new Date(`${input}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }
  const todayChicagoIso = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Chicago",
  });
  const today = new Date(`${todayChicagoIso}T00:00:00Z`);
  const dow = today.getUTCDay();
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  return addDays(today, -daysFromMonday);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseStartHHMM(time: string): string {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/.exec(time);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && h < 12) h += 12;
  else if (ampm === "AM" && h === 12) h = 0;
  else if (!ampm && h >= 5 && h <= 11) {
    // Bare evening hour with no AM/PM token. MatchDay runs no 5-11 AM
    // matches, so treat as PM. Warn so the source row can be cleaned up
    // (e.g. "9:00" -> "9:00 PM"); the parse self-heals either way.
    warnBareScheduleTime(time);
    h += 12;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function hhmmTo12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h24 = Number(hStr ?? 0);
  const min = Number(mStr ?? 0);
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return min === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

// Compute the venue-local calendar date + hh:mm for a single
// mdapi_matches row. mdapi.start_date stores venue-local wall
// clock encoded as a timestamptz at UTC offset (see
// src/lib/cityTimezones.ts header) — so reading its UTC parts
// directly gives the local calendar date and 24h time. No IANA
// timezone conversion needed. start_date_utc is the true UTC
// instant; comparing its UTC date for bucketing crosses the day
// boundary for evening matches in Central/Mountain/Eastern (a
// Sunday 7 PM San Antonio match has start_date_utc = Mon 00:00,
// which would false-positive as missing/extra).
function matchStart(m: MatchRow): { date: string; hhmm: string } | null {
  const raw = m.start_date;
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  return {
    date: d.toISOString().slice(0, 10),
    hhmm: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
  };
}