// Weekly Projections — data layer for /admin/finance Projections tab.
//
// Planning unit: a "slot" = unique (venue, day-of-week, match_start_time).
// Examples: "NEMP Mon 7:30pm", "PRUMC Tue 7:00pm", "San Juan Diego Sat
// 9:05am". Slots are auto-detected from match_registrations over the
// last 4 weeks + next-week — anything that ran in any of those windows
// shows up.
//
// 5-column view per slot: 4 historical Sun-Sat weeks (W-4 .. W-1) +
// next week. Stats per (slot, week): matches (distinct match_start),
// DPP rev (sum match_price_paid where payment_type='DAILY PAID'),
// per-spot price (rev for non-canceled DPP spots ÷ those spots),
// avg/match (= dppRev / matches).
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
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export type WeekWindow = {
  start: string; // YYYY-MM-DD (Sunday)
  end: string; // YYYY-MM-DD (Saturday)
  label: string; // e.g. "Apr 5-11" or "Apr 26-May 2"
};

export type SlotWeekStats = {
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

export type SlotProjectionRow = {
  // Identity
  venueId: number;
  venueName: string;
  city: string;
  dow: number; // 0=Sun .. 6=Sat
  slotTime: string; // "HH:MM" 24-hour, e.g. "19:30"
  slotLabel: string; // "Mon 7:30pm" — for display

  weeks: SlotWeekStats[]; // length 4: indices 0..3 = W-4..W-1
  // Count of weeks where matches > 0 — drives the (N/4) thin-data
  // badge. dppSpots default uses this denominator (rule B: mean over
  // weeks where the slot actually ran, not over all 4).
  weeksWithData: number;

  defaults: {
    matches: number; // strict count of next-week scheduled match_starts (no historical fallback)
    // Mean of dppSpots over weeks where matches > 0, rounded. If
    // weeksWithData === 0 (only-next-week slot), falls to 0.
    dppSpots: number;
    // W-1 slot's per-spot price. null when W-1 had no DPP — input
    // renders empty until operator types a price.
    avgPricePerSpot: number | null;
  };
  saved: {
    matchesPlanned: number | null;
    dppSpotsPlanned: number | null;
    avgPricePerSpotPlanned: number | null;
  };
};

export type VenueProjectionGroup = {
  venueId: number;
  venueName: string;
  city: string;
  slots: SlotProjectionRow[];
};

export type CityProjection = {
  city: string;
  venues: VenueProjectionGroup[];
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
// Slot identity helpers
// =====================================================================

// match_start values look like "2026-04-28T19:00:00" — local match time
// stored without TZ. Slice to get the parts we need.
function dowFromYmd(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}
function hhmmFromMatchStart(ms: string): string {
  // chars 11-16 of "YYYY-MM-DDTHH:MM:SS"
  return ms.slice(11, 16);
}
function fmtSlotLabel(dow: number, hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${DOW_LABELS[dow]} ${h12}:${String(m).padStart(2, "0")}${ampm}`;
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
  dpp_spots_planned: number | null;
  avg_price_per_spot_planned: number | null;
};

// Saved-projection key: `${venueId}|${weekStart}|${dow}|${hhmm}`. Matches
// the table's UNIQUE constraint after migration 0008.
export function savedProjectionKey(
  venueId: number,
  weekStart: string,
  dow: number,
  slotTime: string,
): string {
  return `${venueId}|${weekStart}|${dow}|${slotTime}`;
}

// Per-slot accumulator. We collect across both historical and next-week
// rows in one pass; finalize() splits out the stats.
type SlotAccum = {
  venueId: number;
  dow: number;
  hhmm: string;
  weeks: {
    matchSet: Set<string>;
    cancelSet: Set<string>;
    dppRev: number;
    dppSpots: number;
    dppRevForSpots: number;
  }[];
  nextMatchSet: Set<string>;
};

function emptyWeekAccum() {
  return {
    matchSet: new Set<string>(),
    cancelSet: new Set<string>(),
    dppRev: 0,
    dppSpots: 0,
    dppRevForSpots: 0,
  };
}

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

  // 2. Field → venue map. Built from all rows so a venue that only has
  //    cancellations or only next-week matches still resolves.
  const fields = new Set<string>();
  for (const r of regsExStaff) if (r.field) fields.add(r.field);
  const fieldToVenue = buildFieldToVenueMap(fields, venues);
  const venueById = new Map(venues.map((v) => [v.id, v]));

  // 3. Single pass: bucket every reg into a slot accumulator.
  const slotMap = new Map<string, SlotAccum>();
  function ensureSlot(venueId: number, dow: number, hhmm: string): SlotAccum {
    const key = `${venueId}|${dow}|${hhmm}`;
    let s = slotMap.get(key);
    if (!s) {
      s = {
        venueId,
        dow,
        hhmm,
        weeks: [emptyWeekAccum(), emptyWeekAccum(), emptyWeekAccum(), emptyWeekAccum()],
        nextMatchSet: new Set<string>(),
      };
      slotMap.set(key, s);
    }
    return s;
  }
  function windowIndexFor(ymd: string): number {
    for (let i = 0; i < 4; i++) {
      const w = windows.windowsHistorical[i];
      if (ymd >= w.start && ymd <= w.end) return i;
    }
    return -1;
  }
  for (const r of regsExStaff) {
    const venueId = fieldToVenue.get(r.field as string);
    if (venueId === undefined) continue;
    const ymd = r.match_start.slice(0, 10);
    const hhmm = hhmmFromMatchStart(r.match_start);
    const dow = dowFromYmd(ymd);
    const inNext =
      ymd >= windows.nextWindow.start && ymd <= windows.nextWindow.end;
    const wIdx = windowIndexFor(ymd);
    if (wIdx === -1 && !inNext) continue;
    const slot = ensureSlot(venueId, dow, hhmm);
    if (inNext) {
      // Next-window: only count non-canceled matches toward the
      // matches default. Canceled next-week matches are in the data
      // but don't seed the planning input.
      if (!r.match_canceled) slot.nextMatchSet.add(r.match_start);
    } else {
      const w = slot.weeks[wIdx];
      if (r.match_canceled) {
        w.cancelSet.add(r.match_start);
      } else {
        w.matchSet.add(r.match_start);
        if (r.payment_type === "DAILY PAID") {
          const price = Number(r.match_price_paid ?? 0) || 0;
          w.dppRev += price;
          // Per-spot calc drops player-canceled rows. Numerator and
          // denominator stay consistent — both exclude the same rows.
          const playerCancel =
            !!r.player_canceled_at && r.player_canceled_at.trim() !== "";
          if (!playerCancel) {
            w.dppSpots += 1;
            w.dppRevForSpots += price;
          }
        }
      }
    }
  }

  // 4. Finalize each slot into a projection row.
  const allSlots: SlotProjectionRow[] = [];
  for (const acc of slotMap.values()) {
    const venue = venueById.get(acc.venueId);
    if (!venue) continue;
    const weeks: SlotWeekStats[] = acc.weeks.map((w) => {
      const matches = w.matchSet.size;
      return {
        matches,
        cancels: w.cancelSet.size,
        dppSpots: w.dppSpots,
        dppRev: w.dppRev,
        avgPrice: matches > 0 ? w.dppRev / matches : 0,
        avgPricePerSpot:
          w.dppSpots > 0 ? w.dppRevForSpots / w.dppSpots : null,
      };
    });
    const weeksWithData = weeks.filter((w) => w.matches > 0).length;
    // Rule (B): mean of dppSpots over weeks where the slot actually
    // ran. Avoids under-defaulting thin slots — a slot that ran once
    // with 9 spots gets 9 as the default, not 2. The (N/4) badge in
    // the UI carries the visibility burden for thin data.
    const dppSpotsDefault =
      weeksWithData > 0
        ? Math.round(
            weeks
              .filter((w) => w.matches > 0)
              .reduce((s, w) => s + w.dppSpots, 0) / weeksWithData,
          )
        : 0;
    const w1 = weeks[3];
    const savedKey = savedProjectionKey(
      acc.venueId,
      windows.nextWindow.start,
      acc.dow,
      acc.hhmm,
    );
    const savedRow = saved.get(savedKey) ?? {
      matches_planned: null,
      dpp_spots_planned: null,
      avg_price_per_spot_planned: null,
    };
    allSlots.push({
      venueId: acc.venueId,
      venueName: venue.venue_name,
      city: venue.city ?? "—",
      dow: acc.dow,
      slotTime: acc.hhmm,
      slotLabel: fmtSlotLabel(acc.dow, acc.hhmm),
      weeks,
      weeksWithData,
      defaults: {
        matches: acc.nextMatchSet.size,
        dppSpots: dppSpotsDefault,
        avgPricePerSpot: w1.avgPricePerSpot,
      },
      saved: {
        matchesPlanned: savedRow.matches_planned,
        dppSpotsPlanned: savedRow.dpp_spots_planned,
        avgPricePerSpotPlanned: savedRow.avg_price_per_spot_planned,
      },
    });
  }

  // 5. Drop slots with zero activity AND zero saved projection. A slot
  // gets here only if it appeared in some registration row, so this
  // mostly filters slots that exist in the data but had matches
  // canceled and no saved planning yet — typically empty noise.
  const visible = allSlots.filter((s) => {
    const anyHistorical = s.weeksWithData > 0 || s.weeks.some((w) => w.cancels > 0);
    const anyNext = s.defaults.matches > 0;
    const hasSaved =
      s.saved.matchesPlanned !== null ||
      s.saved.dppSpotsPlanned !== null ||
      s.saved.avgPricePerSpotPlanned !== null;
    return anyHistorical || anyNext || hasSaved;
  });

  // 6. Group: slots → venues → cities.
  const venueMap = new Map<number, VenueProjectionGroup>();
  for (const s of visible) {
    let g = venueMap.get(s.venueId);
    if (!g) {
      g = {
        venueId: s.venueId,
        venueName: s.venueName,
        city: s.city,
        slots: [],
      };
      venueMap.set(s.venueId, g);
    }
    g.slots.push(s);
  }
  for (const g of venueMap.values()) {
    g.slots.sort((a, b) =>
      a.dow !== b.dow ? a.dow - b.dow : a.slotTime.localeCompare(b.slotTime),
    );
  }
  const cityMap = new Map<string, VenueProjectionGroup[]>();
  for (const g of venueMap.values()) {
    const arr = cityMap.get(g.city) ?? [];
    arr.push(g);
    cityMap.set(g.city, arr);
  }
  const cities: CityProjection[] = [...cityMap.entries()]
    .map(([city, vs]) => ({
      city,
      venues: vs.sort((a, b) => a.venueName.localeCompare(b.venueName)),
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
    .select(
      "venue_id, week_start_date, slot_day_of_week, slot_time, matches_planned, dpp_spots_planned, avg_price_per_spot_planned",
    )
    .eq("week_start_date", weekStartDate);
  if (error) throw new Error(`Saved projections fetch: ${error.message}`);
  const map = new Map<string, SavedProjection>();
  for (const r of data ?? []) {
    const key = savedProjectionKey(
      Number(r.venue_id),
      r.week_start_date,
      Number(r.slot_day_of_week),
      String(r.slot_time),
    );
    map.set(key, {
      matches_planned:
        r.matches_planned == null ? null : Number(r.matches_planned),
      dpp_spots_planned:
        r.dpp_spots_planned == null ? null : Number(r.dpp_spots_planned),
      avg_price_per_spot_planned:
        r.avg_price_per_spot_planned == null
          ? null
          : Number(r.avg_price_per_spot_planned),
    });
  }
  return map;
}

export async function saveProjection(
  supabase: SupabaseClient,
  args: {
    venueId: number;
    weekStartDate: string;
    slotDayOfWeek: number;
    slotTime: string;
    matchesPlanned: number | null;
    dppSpotsPlanned: number | null;
    avgPricePerSpotPlanned: number | null;
  },
): Promise<void> {
  const { error } = await supabase.from("field_week_projections").upsert(
    {
      venue_id: args.venueId,
      week_start_date: args.weekStartDate,
      slot_day_of_week: args.slotDayOfWeek,
      slot_time: args.slotTime,
      matches_planned: args.matchesPlanned,
      dpp_spots_planned: args.dppSpotsPlanned,
      avg_price_per_spot_planned: args.avgPricePerSpotPlanned,
    },
    { onConflict: "venue_id,week_start_date,slot_day_of_week,slot_time" },
  );
  if (error) throw new Error(`Save projection: ${error.message}`);
}

export async function deleteProjection(
  supabase: SupabaseClient,
  args: {
    venueId: number;
    weekStartDate: string;
    slotDayOfWeek: number;
    slotTime: string;
  },
): Promise<void> {
  const { error } = await supabase
    .from("field_week_projections")
    .delete()
    .eq("venue_id", args.venueId)
    .eq("week_start_date", args.weekStartDate)
    .eq("slot_day_of_week", args.slotDayOfWeek)
    .eq("slot_time", args.slotTime);
  if (error) throw new Error(`Delete projection: ${error.message}`);
}
