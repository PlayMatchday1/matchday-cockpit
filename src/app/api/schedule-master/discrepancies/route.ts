// GET /api/schedule-master/discrepancies — compare the curated
// schedule_master template against actual mdapi_matches in a
// two-week window starting at week_start.
//
// Three buckets are reported:
//   missing_in_db — schedule_master rows with no matching
//                   mdapi_matches row on (city, venue, date, start time).
//   extra_in_db   — mdapi_matches rows with no schedule_master row.
//   mismatched    — same key, but max_spots or detail differ.
//
// Matching key: (city_code, venue_normalized, match_date, hh:mm).
// City code is the short cockpit form (ATX / HOU / ...) derived
// from schedule_master.city via normalizeCityName; mdapi_matches
// stores it directly on city_identifier.
// Venue normalized: lowercase, parens stripped, "field" dropped,
// non-alphanumerics collapsed to single spaces. Same algorithm
// applied to both sides so the comparison is on the same shape.
//
// Auth: admin via authenticateCrm.

import { authenticateCrm } from "@/lib/crmAuth";
import { normalizeCityName } from "@/lib/cityNormalization";
import { timezoneFor } from "@/lib/cityTimezones";

export const runtime = "nodejs";
export const maxDuration = 15;

const WINDOW_DAYS = 14; // current week + next week
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  start_date_utc: string | null;
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
  const startIso = isoDate(weekStart);
  const endIso = isoDate(weekEnd);

  // schedule_master is keyed on a plain `date`, so range is direct.
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

  // mdapi_matches.start_date is a timestamptz. Convert window to
  // UTC-anchored ISO strings padded out to the end of the day so a
  // venue-local 11:30 PM start on the last day still gets included.
  const startTs = `${startIso}T00:00:00Z`;
  const endTs = `${endIso}T23:59:59Z`;
  const mRes = await supabase
    .from("mdapi_matches")
    .select(
      "api_id, city_identifier, field_title, start_date_utc, start_date, is_cancelled, max_player_count",
    )
    .gte("start_date", startTs)
    .lte("start_date", endTs);
  if (mRes.error) {
    console.error("[schedule-master:discrepancies] mdapi_matches query failed", mRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const matchRows = (mRes.data ?? []) as MatchRow[];
  const matchRowsAlive = matchRows.filter((m) => m.is_cancelled !== true);

  // Build the comparison index off both sides.
  type Indexed = {
    cityCode: string;
    venueNorm: string;
    date: string;
    hhmm: string;
  };
  const sIndex: Array<Indexed & { row: ScheduleRow }> = [];
  for (const r of scheduleRows) {
    const cityCode = normalizeCityName(r.city);
    if (!cityCode) continue;
    sIndex.push({
      cityCode,
      venueNorm: normalizeVenue(r.detail),
      date: r.match_date,
      hhmm: parseStartHHMM(r.match_time),
      row: r,
    });
  }
  const mIndex: Array<Indexed & { row: MatchRow }> = [];
  for (const m of matchRowsAlive) {
    const cityCode = m.city_identifier ?? null;
    if (!cityCode) continue;
    const venueNorm = m.field_title ? normalizeVenue(m.field_title) : "";
    if (!venueNorm) continue;
    const tz = timezoneFor(cityCode);
    const startTz = matchStartInZone(m, tz);
    if (!startTz) continue;
    mIndex.push({
      cityCode,
      venueNorm,
      date: startTz.date,
      hhmm: startTz.hhmm,
      row: m,
    });
  }

  // Key: cityCode|venueNorm|date|hhmm. Multiple entries on either
  // side with the same key are unusual but possible — pair them
  // positionally, with surplus on either side counted as missing /
  // extra.
  function bucketize<T extends Indexed>(arr: T[]): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const x of arr) {
      const key = `${x.cityCode}|${x.venueNorm}|${x.date}|${x.hhmm}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(x);
    }
    return map;
  }

  const sBuckets = bucketize(sIndex);
  const mBuckets = bucketize(mIndex);
  const allKeys = new Set([...sBuckets.keys(), ...mBuckets.keys()]);

  const missing_in_db: Out["missing_in_db"] = [];
  const extra_in_db: Out["extra_in_db"] = [];
  const mismatched: Out["mismatched"] = [];

  for (const key of allKeys) {
    const sBucket = sBuckets.get(key) ?? [];
    const mBucket = mBuckets.get(key) ?? [];
    const paired = Math.min(sBucket.length, mBucket.length);
    for (let i = 0; i < paired; i++) {
      const s = sBucket[i];
      const m = mBucket[i];
      const diffs: string[] = [];
      if (
        m.row.max_player_count != null &&
        m.row.max_player_count !== s.row.max_spots
      ) {
        diffs.push(`max_spots ${s.row.max_spots} vs db ${m.row.max_player_count}`);
      }
      // Detail comparison is intentionally loose. If the normalized
      // venue matches but the literal strings differ, that's expected
      // (e.g. "NEMP Field 12" vs whatever exact label the API uses).
      // We only flag a hard mismatch when both sides parse cleanly but
      // disagree on max_spots.
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
    for (let i = paired; i < sBucket.length; i++) {
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
    for (let i = paired; i < mBucket.length; i++) {
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
  }

  // Stable ordering — date, then city, then time. Makes inspection
  // in the UI deterministic across requests.
  const byDateThenCityThenTime = (a: { match_date: string; city: string; match_time: string }, b: { match_date: string; city: string; match_time: string }) =>
    a.match_date.localeCompare(b.match_date) ||
    a.city.localeCompare(b.city) ||
    a.match_time.localeCompare(b.match_time);
  missing_in_db.sort(byDateThenCityThenTime);
  extra_in_db.sort(byDateThenCityThenTime);
  mismatched.sort(byDateThenCityThenTime);

  const out: Out = {
    week_start: startIso,
    week_end: endIso,
    total_schedule_master: scheduleRows.length,
    total_mdapi_matches: matchRowsAlive.length,
    missing_in_db,
    extra_in_db,
    mismatched,
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

// Strip parens, drop "field", collapse non-alphanumerics. Same
// rule on both sides of the comparison so "NEMP Field 12" and
// "NEMP Field 12 (Syn)" both normalize to "nemp 12".
function normalizeVenue(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\bfield\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// "7:00 PM - 8:00 PM" → "19:00", "9:00 PM" → "21:00". Returns ""
// for unparseable so the bucket key is stable but the entry will
// only ever match another unparseable side.
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

// Convert hh:mm 24h back to a display-friendly "H:MM PM" form for
// surfacing extra_in_db rows in the UI.
function hhmmTo12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h24 = Number(hStr ?? 0);
  const min = Number(mStr ?? 0);
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return min === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

// Compute the venue-local calendar date + hh:mm for a single
// mdapi_matches row. Uses start_date_utc when available (it's the
// canonical UTC value) and falls back to start_date otherwise.
// Returns null if neither value parses.
function matchStartInZone(
  m: MatchRow,
  tz: string | null,
): { date: string; hhmm: string } | null {
  const raw = m.start_date_utc ?? m.start_date;
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  if (!tz) {
    // No known zone — fall back to UTC. Won't match Central rows
    // cleanly but at least won't crash. Logged at warn level by
    // the cityTimezones helper already.
    return {
      date: d.toISOString().slice(0, 10),
      hhmm: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
    };
  }
  // Intl-format the date in the venue's local zone then re-split.
  // en-CA gives YYYY-MM-DD; en-GB gives HH:MM in 24h.
  const date = d.toLocaleDateString("en-CA", { timeZone: tz });
  const time = d.toLocaleTimeString("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return { date, hhmm: time };
}
