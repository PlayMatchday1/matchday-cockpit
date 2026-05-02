// Weekly Projections — data layer for /admin/finance Projections tab.
//
// 5-column view per field: 4 historical Sun-Sat weeks (W-4 .. W-1) +
// next week. Stats per (venue, week): matches (distinct match_start),
// DPP rev (sum match_price_paid where payment_type='DAILY PAID'),
// avg = dppRev / matches.
//
// "Most recent week" rule: W-1 is the Sun-Sat window whose Saturday
// is on or before today. Today=Sat → W-1 ends today. Today=Sun
// (next day) → W-1 still ends previous Saturday. Stable across
// the week.
//
// Venue resolution: longest-prefix substring match between a
// match_registrations.field and fin_venues.venue_name. Handles
// "The Hattrick" → Hattrick, "ATH Katy Sunday" → "ATH Katy Sunday"
// (longer match wins over "ATH Katy"). Mirrors partnerStats.ts's
// substring approach but disambiguates multi-leg cities.

import type { SupabaseClient } from "@supabase/supabase-js";

const STAFF_EMAIL_DOMAIN = "matchday.com";

export type WeekWindow = {
  start: string; // YYYY-MM-DD (Sunday)
  end: string; // YYYY-MM-DD (Saturday)
  label: string; // e.g. "Apr 5-11" or "Apr 26-May 2"
};

export type FieldWeekStats = {
  matches: number;
  cancels: number; // distinct match_starts where the whole match was canceled
  dppSpots: number; // DAILY PAID registrations excluding match_canceled + player_canceled_at
  dppRev: number;
  avgPrice: number; // dppRev / matches; 0 when matches=0
  // Per-spot price: rev for non-canceled DPP spots ÷ those spots.
  // null = no DPP spots in window (renders as "—"); 0 = comp/promo
  // priced at $0 (renders as "$0.00").
  avgPricePerSpot: number | null;
};

export type FieldProjectionRow = {
  venueId: number;
  venueName: string;
  city: string;
  weeks: FieldWeekStats[]; // length 4: indices 0..3 = W-4..W-1
  defaults: {
    matches: number; // distinct match_start in next-week window (strict 0 if none)
    avgPrice: number; // = weeks[3].avgPrice (W-1)
  };
  saved: {
    matchesPlanned: number | null;
    avgPricePlanned: number | null;
  };
};

export type CityProjection = {
  city: string;
  fields: FieldProjectionRow[];
};

export type ProjectionsView = {
  windowsHistorical: WeekWindow[]; // length 4 (W-4 .. W-1)
  nextWindow: WeekWindow;
  cities: CityProjection[];
};

// =====================================================================
// Window math
// =====================================================================

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Most recent Saturday on or before today (UTC).
function mostRecentSaturday(now: Date): string {
  const today = now.toISOString().slice(0, 10);
  const d = new Date(`${today}T00:00:00Z`);
  const day = d.getUTCDay(); // Sun=0..Sat=6
  const diff = day === 6 ? 0 : (day + 1) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

const FMT_LABEL_MONTH = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});

function fmtRange(start: string, end: string): string {
  const s = new Date(`${start}T12:00:00Z`);
  const e = new Date(`${end}T12:00:00Z`);
  const sm = FMT_LABEL_MONTH.format(s);
  const em = FMT_LABEL_MONTH.format(e);
  const sd = s.getUTCDate();
  const ed = e.getUTCDate();
  return sm === em ? `${sm} ${sd}-${ed}` : `${sm} ${sd}-${em} ${ed}`;
}

export function computeProjectionWindows(now: Date = new Date()): {
  windowsHistorical: WeekWindow[];
  nextWindow: WeekWindow;
} {
  const w1End = mostRecentSaturday(now);
  const w1Start = addDays(w1End, -6);
  const nextStart = addDays(w1End, 1);
  const nextEnd = addDays(nextStart, 6);
  const make = (start: string, end: string): WeekWindow => ({
    start,
    end,
    label: fmtRange(start, end),
  });
  return {
    windowsHistorical: [
      make(addDays(w1Start, -21), addDays(w1End, -21)), // W-4
      make(addDays(w1Start, -14), addDays(w1End, -14)), // W-3
      make(addDays(w1Start, -7), addDays(w1End, -7)), // W-2
      make(w1Start, w1End), // W-1
    ],
    nextWindow: make(nextStart, nextEnd),
  };
}

// =====================================================================
// Venue resolver — longest-prefix substring match
// =====================================================================

function buildFieldToVenueMap(
  fields: Set<string>,
  venues: { id: number; venue_name: string }[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const field of fields) {
    const lf = field.toLowerCase();
    let best: { id: number; nameLen: number; name: string } | null = null;
    for (const v of venues) {
      const ln = v.venue_name.toLowerCase();
      if (!ln || !lf.includes(ln)) continue;
      // Longer match wins. Tie-break alphabetically on venue_name
      // for determinism.
      if (
        !best ||
        ln.length > best.nameLen ||
        (ln.length === best.nameLen && v.venue_name < best.name)
      ) {
        best = { id: v.id, nameLen: ln.length, name: v.venue_name };
      }
    }
    if (best) map.set(field, best.id);
  }
  return map;
}

// =====================================================================
// Compute view
// =====================================================================

export type RegistrationRow = {
  field: string | null;
  match_start: string;
  match_canceled: boolean;
  player_canceled_at: string | null;
  payment_type: string | null;
  match_price_paid: number | null;
  email: string | null;
};

type SavedProjection = {
  matches_planned: number | null;
  avg_price_planned: number | null;
};

export function computeProjections(
  registrations: RegistrationRow[],
  venues: { id: number; venue_name: string; city: string | null }[],
  saved: Map<string, SavedProjection>,
  windows: { windowsHistorical: WeekWindow[]; nextWindow: WeekWindow } = computeProjectionWindows(),
): ProjectionsView {
  // 1. Drop staff. Keep canceled rows so we can count canceled matches
  //    alongside played ones — they're a separate signal.
  const regsExStaff = registrations.filter(
    (r) =>
      !!r.field &&
      !(r.email && r.email.toLowerCase().includes(STAFF_EMAIL_DOMAIN)),
  );
  const active = regsExStaff.filter((r) => !r.match_canceled);
  const cancelled = regsExStaff.filter((r) => r.match_canceled);

  // 2. Field → venue map. Built from BOTH active and canceled rows so a
  //    venue that only has cancellations in a window still resolves.
  const fields = new Set<string>();
  for (const r of regsExStaff) if (r.field) fields.add(r.field);
  const fieldToVenue = buildFieldToVenueMap(fields, venues);

  // 3. Stats helper.
  function statsForVenueWindow(venueId: number, w: WeekWindow): FieldWeekStats {
    const matchSet = new Set<string>();
    let dppRev = 0;
    let dppSpots = 0;
    let dppRevForSpots = 0; // sub-sum used as the per-spot numerator
    for (const r of active) {
      if (fieldToVenue.get(r.field as string) !== venueId) continue;
      const ymd = r.match_start.slice(0, 10);
      if (ymd < w.start || ymd > w.end) continue;
      matchSet.add(r.match_start);
      if (r.payment_type === "DAILY PAID") {
        const price = Number(r.match_price_paid ?? 0) || 0;
        dppRev += price;
        // Per-spot calc drops player-canceled rows on top of
        // match_canceled (already filtered by `active`). Numerator and
        // denominator stay consistent — both exclude the same rows.
        const playerCancel =
          !!r.player_canceled_at && r.player_canceled_at.trim() !== "";
        if (!playerCancel) {
          dppSpots += 1;
          dppRevForSpots += price;
        }
      }
    }
    // Canceled-match count is distinct match_starts where the whole
    // match was canceled — not registration count. A canceled match
    // with 12 paid spots = 1 cancel, not 12.
    const cancelSet = new Set<string>();
    for (const r of cancelled) {
      if (fieldToVenue.get(r.field as string) !== venueId) continue;
      const ymd = r.match_start.slice(0, 10);
      if (ymd < w.start || ymd > w.end) continue;
      cancelSet.add(r.match_start);
    }
    const matches = matchSet.size;
    return {
      matches,
      cancels: cancelSet.size,
      dppSpots,
      dppRev,
      avgPrice: matches > 0 ? dppRev / matches : 0,
      avgPricePerSpot: dppSpots > 0 ? dppRevForSpots / dppSpots : null,
    };
  }

  // 4. Per-venue rows.
  const allRows: FieldProjectionRow[] = venues.map((v) => {
    const weeks = windows.windowsHistorical.map((w) =>
      statsForVenueWindow(v.id, w),
    );
    const w1 = weeks[3];
    // Next-week defaults: distinct match_starts already scheduled.
    // Strict zero if none — no historical fallback.
    const nextSet = new Set<string>();
    for (const r of active) {
      if (fieldToVenue.get(r.field as string) !== v.id) continue;
      const ymd = r.match_start.slice(0, 10);
      if (ymd < windows.nextWindow.start || ymd > windows.nextWindow.end) continue;
      nextSet.add(r.match_start);
    }
    const savedKey = `${v.id}|${windows.nextWindow.start}`;
    const savedRow = saved.get(savedKey) ?? {
      matches_planned: null,
      avg_price_planned: null,
    };
    return {
      venueId: v.id,
      venueName: v.venue_name,
      city: v.city ?? "—",
      weeks,
      defaults: { matches: nextSet.size, avgPrice: w1.avgPrice },
      saved: {
        matchesPlanned: savedRow.matches_planned,
        avgPricePlanned: savedRow.avg_price_planned,
      },
    };
  });

  // 5. Drop venues with zero activity in any window AND zero saved
  // projection. Keeps the planning view focused on live venues. If
  // an admin wants to plan for a dormant venue, posting the first
  // match in match_registrations (or saving a projection row) will
  // surface it.
  const visible = allRows.filter((r) => {
    const anyHistorical = r.weeks.some((w) => w.matches > 0);
    const anyNext = r.defaults.matches > 0;
    const hasSaved =
      r.saved.matchesPlanned !== null || r.saved.avgPricePlanned !== null;
    return anyHistorical || anyNext || hasSaved;
  });

  // 6. Group by city.
  const cityMap = new Map<string, FieldProjectionRow[]>();
  for (const r of visible) {
    const arr = cityMap.get(r.city) ?? [];
    arr.push(r);
    cityMap.set(r.city, arr);
  }
  const cities: CityProjection[] = [...cityMap.entries()]
    .map(([city, fields]) => ({
      city,
      fields: fields.sort((a, b) => a.venueName.localeCompare(b.venueName)),
    }))
    .sort((a, b) => a.city.localeCompare(b.city));

  return {
    windowsHistorical: windows.windowsHistorical,
    nextWindow: windows.nextWindow,
    cities,
  };
}

// =====================================================================
// Fetch + persistence
// =====================================================================

export async function fetchProjectionsData(
  supabase: SupabaseClient,
): Promise<{
  registrations: RegistrationRow[];
  venues: { id: number; venue_name: string; city: string | null }[];
}> {
  const { data: upload } = await supabase
    .from("data_uploads")
    .select("id")
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!upload) {
    return { registrations: [], venues: [] };
  }

  const { windowsHistorical, nextWindow } = computeProjectionWindows();
  const earliest = windowsHistorical[0].start;
  const latest = nextWindow.end;

  const registrations: RegistrationRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("match_registrations")
      .select(
        "field, match_start, match_canceled, player_canceled_at, payment_type, match_price_paid, email",
      )
      .eq("upload_id", upload.id)
      .gte("match_start", `${earliest}T00:00:00Z`)
      .lte("match_start", `${latest}T23:59:59Z`)
      .range(from, from + 999);
    if (error) throw new Error(`Registrations fetch: ${error.message}`);
    if (!data || data.length === 0) break;
    registrations.push(...(data as RegistrationRow[]));
    if (data.length < 1000) break;
  }

  const { data: venues, error: vErr } = await supabase
    .from("fin_venues")
    .select("id, venue_name, city")
    .order("city")
    .order("venue_name");
  if (vErr) throw new Error(`Venues fetch: ${vErr.message}`);

  return {
    registrations,
    venues: (venues ?? []) as { id: number; venue_name: string; city: string | null }[],
  };
}

export async function fetchSavedProjections(
  supabase: SupabaseClient,
  weekStartDate: string,
): Promise<Map<string, SavedProjection>> {
  const { data, error } = await supabase
    .from("field_week_projections")
    .select("venue_id, week_start_date, matches_planned, avg_price_planned")
    .eq("week_start_date", weekStartDate);
  if (error) throw new Error(`Saved projections fetch: ${error.message}`);
  const map = new Map<string, SavedProjection>();
  for (const r of data ?? []) {
    map.set(`${r.venue_id}|${r.week_start_date}`, {
      matches_planned: r.matches_planned == null ? null : Number(r.matches_planned),
      avg_price_planned:
        r.avg_price_planned == null ? null : Number(r.avg_price_planned),
    });
  }
  return map;
}

export async function saveProjection(
  supabase: SupabaseClient,
  args: {
    venueId: number;
    weekStartDate: string;
    matchesPlanned: number | null;
    avgPricePlanned: number | null;
  },
): Promise<void> {
  const { error } = await supabase.from("field_week_projections").upsert(
    {
      venue_id: args.venueId,
      week_start_date: args.weekStartDate,
      matches_planned: args.matchesPlanned,
      avg_price_planned: args.avgPricePlanned,
    },
    { onConflict: "venue_id,week_start_date" },
  );
  if (error) throw new Error(`Save projection: ${error.message}`);
}

export async function deleteProjection(
  supabase: SupabaseClient,
  args: { venueId: number; weekStartDate: string },
): Promise<void> {
  const { error } = await supabase
    .from("field_week_projections")
    .delete()
    .eq("venue_id", args.venueId)
    .eq("week_start_date", args.weekStartDate);
  if (error) throw new Error(`Delete projection: ${error.message}`);
}
