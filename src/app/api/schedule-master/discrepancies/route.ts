// GET /api/schedule-master/discrepancies — compare the curated
// schedule_master template against actual mdapi_matches in a
// two-week window starting at week_start.
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
// City canonical is the full display name ("Austin", "San
// Antonio", etc). schedule_master.city stores the display form
// directly; mdapi_matches.city_identifier stores 3-letter codes
// (ATX, SAT, ...) which CITY_IDENTIFIER_MAP normalizes to the
// same display form. Codes differ between the two systems (e.g.
// SATX/SAT, OKC/OKC, ELP/ELP), so a shared display-name
// canonicalization is the safer key.
//
// Venue canonical comes from src/lib/venueAliases.ts. Each
// physical field has a canonical key plus a list of known
// aliases (marketing variants, parenthetical field numbers,
// long-form names). The previous "strip parens + drop field +
// collapse non-alphanumerics" heuristic produced large false-
// positive volumes whenever either side carried a surface form
// the other didn't anticipate (e.g. "The Hattrick L." vs "The
// Hattrick"). The explicit alias list is maintained by ops as
// new venues appear.
//
// Auth: admin via authenticateCrm.

import { authenticateCrm } from "@/lib/crmAuth";
import { canonicalizeVenue } from "@/lib/venueAliases";

export const runtime = "nodejs";
export const maxDuration = 15;

const WINDOW_DAYS = 14; // current week + next week
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// mdapi_matches.city_identifier code → schedule_master.city display
// name. Codes are not all 3 letters: Dallas is DFW (not DAL) and
// San Antonio is SATX (not SAT) per the real mdapi values, which
// matches what the rest of the cockpit already uses via
// src/lib/cityNormalization.
const CITY_IDENTIFIER_MAP: Record<string, string> = {
  ATX: "Austin",
  ATL: "Atlanta",
  HOU: "Houston",
  DFW: "Dallas",
  SATX: "San Antonio",
  STL: "St. Louis",
  OKC: "OKC",
  ELP: "El Paso",
};

function mapCityIdentifier(code: string | null | undefined): string | null {
  if (!code) return null;
  return CITY_IDENTIFIER_MAP[code.toUpperCase()] ?? null;
}

type ScheduleRow = {
  id: string;
  city: string;
  venue: string;
  detail: string;
  match_date: string;
  match_time: string;
  max_spots: number;
};

type MatchRow = {
  api_id: number;
  city_identifier: string | null;
  field_title: string | null;
  start_date: string | null;
  is_cancelled: boolean | null;
  max_player_count: number | null;
};

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
    .select("id, city, venue, detail, match_date, match_time, max_spots")
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
      "api_id, city_identifier, field_title, start_date, is_cancelled, max_player_count",
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

  type Indexed = {
    cityName: string;
    venueKey: string;
    date: string;
    hhmm: string;
  };
  function venueKeyFor(raw: string | null | undefined): string {
    const canonical = canonicalizeVenue(raw);
    if (canonical) return canonical;
    return (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  const sIndex: Array<Indexed & { row: ScheduleRow }> = [];
  for (const r of scheduleRows) {
    if (!r.city) continue;
    sIndex.push({
      cityName: r.city,
      venueKey: venueKeyFor(r.venue),
      date: r.match_date,
      hhmm: parseStartHHMM(r.match_time),
      row: r,
    });
  }
  function indexMatch(m: MatchRow): (Indexed & { row: MatchRow }) | null {
    const cityName = mapCityIdentifier(m.city_identifier);
    if (!cityName) return null;
    const venueKey = venueKeyFor(m.field_title);
    if (!venueKey) return null;
    const start = matchStart(m);
    if (!start) return null;
    return {
      cityName,
      venueKey,
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
      const key = `${x.cityName}|${x.venueKey}|${x.date}|${x.hhmm}`;
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
    // against) → extra_in_db. A cancelled mdapi row with no
    // schedule_master counterpart is still "extra" relative to the
    // template.
    for (let i = pairedCancelled; i < cBucket.length; i++) {
      const m = cBucket[i].row;
      extra_in_db.push({
        mdapi_match_id: m.api_id,
        city: m.city_identifier ?? "?",
        venue: m.field_title ?? "?",
        match_date: cBucket[i].date,
        match_time: hhmmTo12h(cBucket[i].hhmm),
        max_spots: m.max_player_count,
      });
    }
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
  if (ampm === "AM" && h === 12) h = 0;
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