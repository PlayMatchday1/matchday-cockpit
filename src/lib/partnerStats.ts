// Partner dashboard stats. Server-side fetch (anon key) + pure compute.
// Mirrors the legacy CSV-driven static HTML's bucket logic exactly so
// numbers reconcile between the old export-to-HTML flow and the live
// partner page.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const STAFF_EMAIL_DOMAIN = "matchday.com";

export type PartnerRegRow = {
  user_id: string;
  email: string | null;
  field: string;
  match_start: string;
  match_canceled: boolean;
  player_canceled_at: string | null;
  payment_type: string | null;
  promocode: string | null;
  match_price_paid: number | null;
};

export type PartnerWeekStat =
  | {
      wkMonday: string;
      label: string;
      voided: true;
      noData?: boolean;
    }
  | {
      wkMonday: string;
      label: string;
      voided: false;
      totalPlayers: number;
      mdPlayers: number;
      guests: number;
      newP: number;
      retP: number;
      dp: number;
      mem: number;
      promo: number;
      promoCodes: string[];
      matches: number;
      totalRev: number;
      cancelRev: number;
      cancelCount: number;
      isLatest: boolean;
    };

export type PartnerStats = {
  totals: {
    spots: number;
    md: number;
    guests: number;
    cancels: number;
    rev: number;
  };
  weeks: PartnerWeekStat[];
  lastMatchDate: string | null;
  earliestMatchDate: string | null;
};

export function makeAnonServerClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase env vars missing");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Fetch the partner_dashboards row by slug. Returns null on miss or
// when disabled — caller renders 404 either way (don't leak which).
export async function fetchPartnerBySlug(
  supabase: SupabaseClient,
  slug: string,
): Promise<{ venueId: number; partnerName: string } | null> {
  const { data, error } = await supabase
    .from("partner_dashboards")
    .select("venue_id, partner_name, enabled")
    .eq("slug", slug)
    .maybeSingle();
  if (error || !data) return null;
  if (!data.enabled) return null;
  return { venueId: data.venue_id, partnerName: data.partner_name };
}

// Fetch venue + match registrations for the active data upload, scoped
// to the venue. The substring-match on `field` mirrors the static HTML's
// `r['Field'].toLowerCase().includes(<venue_name>)` exactly.
export async function fetchPartnerRows(
  supabase: SupabaseClient,
  venueId: number,
): Promise<{ rows: PartnerRegRow[]; venueName: string }> {
  const { data: venue, error: venueErr } = await supabase
    .from("fin_venues")
    .select("venue_name")
    .eq("id", venueId)
    .maybeSingle();
  if (venueErr || !venue) {
    throw new Error("Venue lookup failed");
  }

  const { data: upload, error: uploadErr } = await supabase
    .from("data_uploads")
    .select("id")
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (uploadErr || !upload) {
    return { rows: [], venueName: venue.venue_name };
  }

  // Paginate. Single venue's PAC-Global-style dataset is small (~few
  // hundred rows) but page anyway in case a high-volume partner is
  // onboarded later.
  const PAGE = 1000;
  const out: PartnerRegRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("match_registrations")
      .select(
        "user_id, email, field, match_start, match_canceled, player_canceled_at, payment_type, promocode, match_price_paid",
      )
      .eq("upload_id", upload.id)
      .ilike("field", `%${venue.venue_name}%`)
      .order("match_start")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Registration fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as PartnerRegRow[]));
    if (data.length < PAGE) break;
  }

  return { rows: out, venueName: venue.venue_name };
}

// ----- pure compute (mirrors pac_global_dashboard.html buildDashboard) -----

function isStaff(r: PartnerRegRow): boolean {
  return !!r.email && r.email.toLowerCase().includes(STAFF_EMAIL_DOMAIN);
}
function isCanceled(r: PartnerRegRow): boolean {
  return !!r.player_canceled_at && r.player_canceled_at.trim() !== "";
}
function revenue(r: PartnerRegRow): number {
  return Number(r.match_price_paid ?? 0) || 0;
}

// Monday-anchored week (1=Mon..0=Sun). Returns YYYY-MM-DD.
function getWeekMonday(matchStartIso: string): string {
  const d = new Date(matchStartIso);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diff);
  return monday.toISOString().slice(0, 10);
}

function fmtWeekLabel(firstYmd: string, lastYmd: string): string {
  const d1 = new Date(firstYmd + "T12:00:00Z");
  const d2 = new Date(lastYmd + "T12:00:00Z");
  const m1 = d1.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const m2 = d2.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const day1 = d1.getUTCDate();
  const day2 = d2.getUTCDate();
  if (firstYmd === lastYmd) return `${m1} ${day1}`;
  return `${m1} ${day1}–${m1 === m2 ? day2 : `${m2} ${day2}`}`;
}

export function computePartnerStats(rows: PartnerRegRow[]): PartnerStats {
  const pacAll = rows.filter((r) => !isStaff(r));
  const pac = pacAll.filter((r) => !r.match_canceled);

  if (pacAll.length === 0) {
    return {
      totals: { spots: 0, md: 0, guests: 0, cancels: 0, rev: 0 },
      weeks: [],
      lastMatchDate: null,
      earliestMatchDate: null,
    };
  }

  // Bucket active rows by week-Monday.
  const weekMap = new Map<string, PartnerRegRow[]>();
  for (const r of pac) {
    const wk = getWeekMonday(r.match_start);
    const arr = weekMap.get(wk) ?? [];
    arr.push(r);
    weekMap.set(wk, arr);
  }

  // Detect every week that ever existed (using ALL rows, including
  // match_canceled) so voided weeks render as a tile.
  const weekMapAll = new Set<string>();
  for (const r of pacAll) weekMapAll.add(getWeekMonday(r.match_start));
  const sortedWeeksAll = [...weekMapAll].sort();

  // Fill gaps between first and last week so missing weeks still render.
  const allWeeks: string[] = [];
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  let cursor = new Date(`${sortedWeeksAll[0]}T12:00:00Z`).getTime();
  const lastWeek = new Date(
    `${sortedWeeksAll[sortedWeeksAll.length - 1]}T12:00:00Z`,
  ).getTime();
  while (cursor <= lastWeek) {
    allWeeks.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += msPerWeek;
  }

  const lastWeekIso = sortedWeeksAll[sortedWeeksAll.length - 1];

  // Track seen player IDs across weeks for new-vs-returning.
  const seenPlayers = new Set<string>();
  const weeks: PartnerWeekStat[] = [];

  for (const wkMonday of allWeeks) {
    const wrows = weekMap.get(wkMonday);
    if (!wrows) {
      // No active rows in this week — either skipped entirely or
      // all-match-cancelled. Use pacAll to derive a label.
      const voidRows = pacAll.filter((r) => getWeekMonday(r.match_start) === wkMonday);
      const voidDates = voidRows
        .map((r) => r.match_start.slice(0, 10))
        .sort();
      const label =
        voidDates.length > 0
          ? fmtWeekLabel(voidDates[0], voidDates[voidDates.length - 1])
          : fmtWeekLabel(wkMonday, wkMonday);
      weeks.push({ wkMonday, label, voided: true, noData: true });
      continue;
    }

    const showed = wrows.filter((r) => !isCanceled(r));
    const canceled = wrows.filter((r) => isCanceled(r));

    if (showed.length === 0) {
      // All user-cancelled this week.
      const dates = wrows.map((r) => r.match_start.slice(0, 10)).sort();
      const label = fmtWeekLabel(dates[0], dates[dates.length - 1]);
      weeks.push({ wkMonday, label, voided: true });
      continue;
    }

    // Group by user+match_start so duplicate rows = guests.
    const userMatch = new Map<string, PartnerRegRow[]>();
    for (const r of showed) {
      const key = `${r.user_id}|${r.match_start}`;
      const arr = userMatch.get(key) ?? [];
      arr.push(r);
      userMatch.set(key, arr);
    }

    let guests = 0;
    for (const v of userMatch.values()) guests += v.length - 1;
    const mdPlayers = userMatch.size;
    const totalPlayers = mdPlayers + guests;

    // New-vs-returning by user_id.
    const weekPlayerIds = new Set(showed.map((r) => r.user_id));
    let newP = 0;
    let retP = 0;
    for (const id of weekPlayerIds) {
      if (seenPlayers.has(id)) retP += 1;
      else newP += 1;
    }
    for (const id of weekPlayerIds) seenPlayers.add(id);

    // Payment-type counts use the FIRST row of each user+match group
    // (mirrors the static HTML's `v[0]['Type Of Payment']`).
    const groupVals = [...userMatch.values()];
    const dp = groupVals.filter((v) => v[0].payment_type === "DAILY PAID").length;
    const mem = groupVals.filter((v) => v[0].payment_type === "MEMBER").length;
    const promo = groupVals.filter((v) => v[0].payment_type === "PROMOCODE").length;

    const promoCodes = [
      ...new Set(
        wrows.map((r) => r.promocode).filter((c): c is string => !!c && c.trim() !== ""),
      ),
    ];

    const matches = new Set(wrows.map((r) => r.match_start)).size;
    const totalRev = wrows.reduce((s, r) => s + revenue(r), 0);
    const cancelRev = canceled.reduce((s, r) => s + revenue(r), 0);

    const showedDates = showed.map((r) => r.match_start.slice(0, 10)).sort();

    weeks.push({
      wkMonday,
      label: fmtWeekLabel(showedDates[0], showedDates[showedDates.length - 1]),
      voided: false,
      totalPlayers,
      mdPlayers,
      guests,
      newP,
      retP,
      dp,
      mem,
      promo,
      promoCodes,
      matches,
      totalRev,
      cancelRev,
      cancelCount: canceled.length,
      isLatest: wkMonday === lastWeekIso,
    });
  }

  // All-time totals: sum the active (non-voided) week stats.
  const totals = weeks.reduce(
    (acc, w) => {
      if (w.voided) return acc;
      acc.spots += w.totalPlayers;
      acc.md += w.mdPlayers;
      acc.guests += w.guests;
      acc.cancels += w.cancelCount;
      acc.rev += w.totalRev;
      return acc;
    },
    { spots: 0, md: 0, guests: 0, cancels: 0, rev: 0 },
  );

  // Earliest / latest match dates across active rows for the subtitle.
  const allStarts = pac.map((r) => r.match_start).sort();
  const earliestMatchDate = allStarts[0]?.slice(0, 10) ?? null;
  const lastMatchDate =
    allStarts[allStarts.length - 1]?.slice(0, 10) ?? null;

  return { totals, weeks, lastMatchDate, earliestMatchDate };
}
