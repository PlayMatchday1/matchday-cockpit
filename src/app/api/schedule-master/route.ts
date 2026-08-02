// GET /api/schedule-master — one week of recurring match slots,
// grouped by city then by day. Backs the /cities Master Schedule
// tab. The underlying data is the snapshot of the legacy MatchDay
// master-schedule HTML seeded into schedule_master by migration
// 0038.
//
// Query params:
//   week_start  ISO date YYYY-MM-DD. Defaults to the Monday of the
//               current week in America/Chicago (the ops-team
//               working zone — most cities are Central, El Paso /
//               Atlanta drift by one hour but the master schedule
//               is planned on a Mon-Sun grid anyway).
//
// Auth: admin via src/lib/crmAuth. Same gate as the rest of /api/
// crm + /api/cities — cities/Master Schedule is a corp surface.

import { authenticateCrm } from "@/lib/crmAuth";
import { isCityHidden } from "@/lib/types";
import {
  validateScheduleMasterPayload,
  writeScheduleMasterAudit,
  type ScheduleMasterRow,
} from "@/lib/scheduleMaster";
import { CITY_CODE_TO_DISPLAY, matchLocalDateTime } from "@/lib/scheduleReconcile";

export const runtime = "nodejs";
export const maxDuration = 10;

// The canonical set of cities emitted for the Master Schedule tab.
// Listed alphabetically to match the rendered order; the response is
// also explicitly sorted by name below so the order is guaranteed by
// the sort, not by this literal.
const CITY_ORDER = [
  "Atlanta",
  "Austin",
  "Dallas",
  "El Paso",
  "Houston",
  "OKC",
  "San Antonio",
  "St. Louis",
] as const;
type DisplayCity = (typeof CITY_ORDER)[number];

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

type Row = {
  id: string;
  city: string;
  venue: string;
  detail: string;
  match_date: string;
  match_time: string;
  max_spots: number;
  mdapi_field_id: number | null;
  source: string;
};

type MatchOut = {
  id: string;
  venue: string;
  detail: string;
  time: string;
  max_spots: number;
  mdapi_field_id: number | null;
  source: string;
  // Future planning flag: is this planned slot already on MatchDay (present in
  // mdapi_matches)? false → the grid flags it "not on MatchDay yet".
  in_matchday: boolean;
};

// What actually happened, straight from mdapi_matches — rendered for COMPLETED
// (past) days, just like Manager Pay reads the synced actuals for closed weeks.
type ActualOut = {
  api_id: number;
  venue: string;
  detail: string;
  time: string;
  max_spots: number | null;
  player_count: number | null;
  is_cancelled: boolean;
};

type DayOut = {
  date: string; // YYYY-MM-DD
  day_of_week: (typeof DAY_LABELS)[number];
  is_past: boolean; // date < today (America/Chicago)
  matches: MatchOut[]; // the plan (schedule_master)
  actual_matches: ActualOut[]; // what mdapi recorded for this day
};

type CityOut = {
  name: DisplayCity;
  total: number;
  days: DayOut[];
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
      { error: "week_start must be a valid YYYY-MM-DD date" },
      { status: 400 },
    );
  }
  const weekEnd = addDays(weekStart, 6);

  // Exclude soft-deleted plan rows (migration 0091). Forward-compatible: if the
  // deleted_at column doesn't exist yet, retry without the filter so this route
  // (and every consumer, incl. Slate Review) keeps working pre-migration.
  const SM_COLS = "id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id, source";
  let rowsRes = await supabase
    .from("schedule_master")
    .select(SM_COLS)
    .is("deleted_at", null)
    .gte("match_date", isoDate(weekStart))
    .lte("match_date", isoDate(weekEnd));
  if (rowsRes.error && /deleted_at|column|42703/i.test(rowsRes.error.message || "")) {
    rowsRes = await supabase
      .from("schedule_master")
      .select(SM_COLS)
      .gte("match_date", isoDate(weekStart))
      .lte("match_date", isoDate(weekEnd));
  }
  if (rowsRes.error) {
    console.error("[schedule-master] db error", rowsRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const rows = (rowsRes.data ?? []) as Row[];

  // ── The actuals: what mdapi_matches recorded this week ──────────────────
  // start_date is venue-local wall clock stamped at +00:00, so a plain string
  // range on the calendar window is the right (benign) comparison — matching the
  // discrepancies route's convention. Cancelled matches are kept (a cancelled
  // match still HAPPENED-as-cancelled and is still "on MatchDay").
  const startTs = `${isoDate(weekStart)}T00:00:00+00:00`;
  const endTs = `${isoDate(weekEnd)}T23:59:59+00:00`;
  const mdRes = await supabase
    .from("mdapi_matches")
    .select("api_id, city_identifier, city_name, field_id, field_title, start_date, is_cancelled, max_player_count, player_count")
    .is("deleted_at", null)
    .gte("start_date", startTs)
    .lte("start_date", endTs);
  const mdRows = (mdRes.data ?? []) as Array<{
    api_id: number; city_identifier: string | null; city_name: string | null;
    field_id: number | null; field_title: string | null; start_date: string | null;
    is_cancelled: boolean | null; max_player_count: number | null; player_count: number | null;
  }>;

  // actuals[displayCity][date] = [ActualOut]; plus key sets for the in_matchday
  // flag. A planned slot is "on MatchDay" when a match exists at the same
  // field+date+time (or, for legacy field-less rows, same city+date+time).
  const actualsByCityDate = new Map<string, Map<string, ActualOut[]>>();
  const mdFieldKeys = new Set<string>(); // `${field_id}|${date}|${hhmm}`
  const mdCityKeys = new Set<string>(); // `${displayCity}|${date}|${hhmm}`
  for (const m of mdRows) {
    const ldt = matchLocalDateTime(m.start_date);
    if (!ldt) continue;
    const d = new Date(Date.parse(m.start_date!));
    const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const displayCity =
      (m.city_identifier && CITY_CODE_TO_DISPLAY[m.city_identifier]) ??
      m.city_name ?? m.city_identifier ?? "Unknown";
    if (m.field_id != null) mdFieldKeys.add(`${m.field_id}|${ldt.date}|${hhmm}`);
    mdCityKeys.add(`${displayCity}|${ldt.date}|${hhmm}`);
    let byDate = actualsByCityDate.get(displayCity);
    if (!byDate) { byDate = new Map(); actualsByCityDate.set(displayCity, byDate); }
    if (!byDate.has(ldt.date)) byDate.set(ldt.date, []);
    byDate.get(ldt.date)!.push({
      api_id: m.api_id,
      venue: m.field_title ?? "—",
      detail: m.field_title ?? "",
      time: ldt.timeLabel,
      max_spots: m.max_player_count,
      player_count: m.player_count,
      is_cancelled: m.is_cancelled === true,
    });
  }
  const inMatchday = (fieldId: number | null, city: string, date: string, timeStr: string): boolean => {
    const min = startMinutes(timeStr);
    if (min === Number.MAX_SAFE_INTEGER) return false;
    const hhmm = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    if (fieldId != null && mdFieldKeys.has(`${fieldId}|${date}|${hhmm}`)) return true;
    return mdCityKeys.has(`${city}|${date}|${hhmm}`);
  };

  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  // Bucket by city, then by date.
  const byCity = new Map<string, Map<string, Row[]>>();
  for (const r of rows) {
    if (!byCity.has(r.city)) byCity.set(r.city, new Map());
    const byDate = byCity.get(r.city)!;
    if (!byDate.has(r.match_date)) byDate.set(r.match_date, []);
    byDate.get(r.match_date)!.push(r);
  }

  // Build response in the canonical city order, emitting exactly
  // seven day slots per city (Mon..Sun) so the UI doesn't need to
  // guard for missing days.
  const cities: CityOut[] = [];
  for (const name of CITY_ORDER) {
    // Hidden cities (paused markets) are dropped from the forward-facing
    // Master Schedule response. Historical rows remain in the DB.
    if (isCityHidden(name)) continue;
    const byDate = byCity.get(name) ?? new Map<string, Row[]>();
    const days: DayOut[] = [];
    let total = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const key = isoDate(d);
      const dayRows = byDate.get(key) ?? [];
      dayRows.sort((a, b) => startMinutes(a.match_time) - startMinutes(b.match_time));
      total += dayRows.length;
      const actual_matches = actualsByCityDate.get(name)?.get(key) ?? [];
      actual_matches.sort((a, b) => startMinutes(a.time) - startMinutes(b.time));
      days.push({
        date: key,
        day_of_week: DAY_LABELS[i],
        is_past: key < todayIso,
        matches: dayRows.map((r) => ({
          id: r.id,
          venue: r.venue,
          detail: r.detail,
          time: r.match_time,
          max_spots: r.max_spots,
          mdapi_field_id: r.mdapi_field_id,
          source: r.source ?? "template",
          in_matchday: inMatchday(r.mdapi_field_id, name, key, r.match_time),
        })),
        actual_matches,
      });
    }
    cities.push({ name, total, days });
  }

  // Sort city sections alphabetically A->Z by name.
  cities.sort((a, b) => a.name.localeCompare(b.name));

  return Response.json(
    {
      week_start: isoDate(weekStart),
      week_end: isoDate(weekEnd),
      today: todayIso,
      cities,
    },
    { status: 200 },
  );
}

// ============================================================
// POST — create a schedule_master row
// ============================================================
//
// Admin-only via authenticateCrm. The cron-bearer path is rejected
// since CRUD operations need an attributable operator email for the
// audit log.

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.email) {
    return Response.json(
      { error: "Operator session required" },
      { status: 403 },
    );
  }
  const { supabase, email } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const v = validateScheduleMasterPayload(body, { isPartial: false });
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const payload = v.value;

  const ins = await supabase
    .from("schedule_master")
    .insert({
      city: payload.city!,
      venue: payload.venue!,
      detail: payload.detail!,
      match_date: payload.match_date!,
      match_time: payload.match_time!,
      max_spots: payload.max_spots!,
      mdapi_field_id: payload.mdapi_field_id ?? null,
    })
    .select(
      "id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id, source",
    )
    .single();
  if (ins.error || !ins.data) {
    console.error("[schedule-master:create] insert failed", ins.error);
    return Response.json({ error: "Insert failed" }, { status: 500 });
  }
  const row = ins.data as ScheduleMasterRow;

  await writeScheduleMasterAudit(supabase, {
    action: "create",
    userEmail: email,
    rowId: row.id,
    oldValues: null,
    newValues: row,
  });

  return Response.json({ row }, { status: 201 });
}

// ============================================================
// Date helpers
// ============================================================

// Always work in plain calendar dates (no timezone). The
// schedule_master.match_date column is `date` (no tz), and the
// Mon-Sun grid the ops team plans on is conceptually wall-clock.
function parseWeekStart(input: string | null): Date | null {
  if (input) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    if (!m) return null;
    const d = new Date(`${input}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }
  // Default: Monday of the current calendar week in America/Chicago,
  // since the ops team runs out of Central. We compute "today" in
  // Chicago by formatting Date.now() with that timezone, then parsing
  // back to a UTC-anchored date so all subsequent arithmetic uses
  // the same midnight-UTC reference frame.
  const todayChicagoIso = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Chicago",
  });
  const today = new Date(`${todayChicagoIso}T00:00:00Z`);
  const dow = today.getUTCDay(); // 0=Sun .. 6=Sat
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

// Parse "7:00 PM - 8:00 PM" or "9:00 PM" or "9 PM" to minutes-since-
// midnight for sortability. Unparseable strings sort to the end.
function startMinutes(time: string): number {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/.exec(time);
  if (!m) return Number.MAX_SAFE_INTEGER;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h * 60 + min;
}
