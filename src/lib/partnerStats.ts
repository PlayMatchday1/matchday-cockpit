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

// Manual revenue rows from fin_revenue (Venmo / Stripe / Manual entries
// — anything that isn't a PROJECTION bootstrap estimate). Used to add
// non-match revenue (private rentals, etc.) to weekly + monthly totals.
export type PartnerExtraRevRow = {
  date: string; // YYYY-MM-DD
  type: string;
  gross: number;
  source: string;
  notes: string | null;
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
      // DPP-only revenue + spot count, used for the avg-price-per-DPP
      // line. Excludes members, promo, and the non-match revenue
      // contributed by `extraRev`.
      dpRev: number;
      dpSpots: number;
      // Non-match revenue (fin_revenue rows) bucketed into this week.
      // Counted in totalRev but NOT in dpRev.
      extraRev: number;
      isLatest: boolean;
    };

export type PartnerMonthStat = {
  ym: string; // YYYY-MM
  label: string; // e.g. "April 2026"
  matches: number;
  revenue: number;
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
  byMonth: PartnerMonthStat[];
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

// Fetch venue + match registrations + non-match revenue rows. All
// scoped to one venue. Substring-match on `field` mirrors the static
// HTML's `r['Field'].toLowerCase().includes(<venue_name>)` exactly.
//
// Returned `extra` are fin_revenue rows (Venmo / Stripe / Manual —
// excluding PROJECTION bootstrap estimates) attributable to the venue;
// callers add them to weekly + monthly totals.
export async function fetchPartnerRows(
  supabase: SupabaseClient,
  venueId: number,
): Promise<{
  rows: PartnerRegRow[];
  extra: PartnerExtraRevRow[];
  venueName: string;
}> {
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
    return { rows: [], extra: [], venueName: venue.venue_name };
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

  // fin_revenue rows for this venue.
  //
  // Excluded by design:
  //   - source = 'PROJECTION'  → bootstrap forecast estimates, not
  //     actual partner-facing revenue.
  //   - type IN ('DPP','Membership')  → these rows in fin_revenue are
  //     aggregated bookkeeping of Stripe transactions that already
  //     exist row-by-row in match_registrations (which is the partner
  //     dashboard's primary revenue source). Including them here would
  //     double-count every match payment. Only non-match revenue types
  //     (Private Rental, Strike, etc.) should be added.
  const { data: rev, error: revErr } = await supabase
    .from("fin_revenue")
    .select("date, type, gross, source, notes")
    .ilike("venue", `%${venue.venue_name}%`)
    .neq("source", "PROJECTION")
    .not("type", "in", '("DPP","Membership")');
  if (revErr) throw new Error(`Revenue fetch failed: ${revErr.message}`);
  const extra: PartnerExtraRevRow[] = (rev ?? []).map((r) => ({
    date: String(r.date ?? "").slice(0, 10),
    type: String(r.type ?? ""),
    gross: Number(r.gross ?? 0),
    source: String(r.source ?? ""),
    notes: r.notes ?? null,
  }));

  return { rows: out, extra, venueName: venue.venue_name };
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

// Bucket extra (non-match) revenue by week-Monday and by year-month.
function bucketExtraRevenue(extra: PartnerExtraRevRow[]): {
  byWeek: Map<string, number>;
  byMonth: Map<string, number>;
} {
  const byWeek = new Map<string, number>();
  const byMonth = new Map<string, number>();
  for (const e of extra) {
    if (!e.date) continue;
    const wk = getWeekMonday(e.date);
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + e.gross);
    const ym = e.date.slice(0, 7); // YYYY-MM
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + e.gross);
  }
  return { byWeek, byMonth };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function ymLabel(ym: string): string {
  // ym is "YYYY-MM"
  const [y, m] = ym.split("-").map((s) => parseInt(s, 10));
  if (!y || !m || m < 1 || m > 12) return ym;
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

export function computePartnerStats(
  rows: PartnerRegRow[],
  extra: PartnerExtraRevRow[] = [],
): PartnerStats {
  const pacAll = rows.filter((r) => !isStaff(r));
  const pac = pacAll.filter((r) => !r.match_canceled);

  const { byWeek: extraByWeek, byMonth: extraByMonth } = bucketExtraRevenue(extra);

  if (pacAll.length === 0 && extra.length === 0) {
    return {
      totals: { spots: 0, md: 0, guests: 0, cancels: 0, rev: 0 },
      weeks: [],
      byMonth: [],
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
    const matchRev = wrows.reduce((s, r) => s + revenue(r), 0);
    const cancelRev = canceled.reduce((s, r) => s + revenue(r), 0);
    const extraRev = extraByWeek.get(wkMonday) ?? 0;
    const totalRev = matchRev + extraRev;

    // DPP-only slice (excludes Members, Promo, and any non-match
    // revenue from extraRev). Drives the "Avg price/match" line.
    const dpRows = wrows.filter((r) => r.payment_type === "DAILY PAID");
    const dpRev = dpRows.reduce((s, r) => s + revenue(r), 0);
    const dpSpots = dpRows.length;

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
      dpRev,
      dpSpots,
      extraRev,
      isLatest: wkMonday === lastWeekIso,
    });
  }

  // All-time totals: sum the active (non-voided) week stats. Note that
  // each week's totalRev already includes its share of extraRev, so we
  // don't add extras again here.
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

  // Catch any extraRev that lands in a week with no match data (no
  // weekMap[wk] entry → no week stat created → its extraRev was never
  // pulled in). Add those to the all-time total so nothing is dropped.
  const accountedWeeks = new Set(weeks.map((w) => w.wkMonday));
  for (const [wk, amt] of extraByWeek) {
    if (!accountedWeeks.has(wk)) totals.rev += amt;
  }

  // Monthly summary: distinct match_start per month + sum match revenue
  // + extra (fin_revenue) revenue. Skip months with zero data.
  const matchByMonth = new Map<string, { matches: Set<string>; rev: number }>();
  for (const r of pac) {
    const ym = r.match_start.slice(0, 7);
    let bucket = matchByMonth.get(ym);
    if (!bucket) {
      bucket = { matches: new Set(), rev: 0 };
      matchByMonth.set(ym, bucket);
    }
    bucket.matches.add(r.match_start);
    bucket.rev += revenue(r);
  }
  const monthsSeen = new Set<string>([
    ...matchByMonth.keys(),
    ...extraByMonth.keys(),
  ]);
  const byMonth: PartnerMonthStat[] = [];
  for (const ym of [...monthsSeen].sort()) {
    const m = matchByMonth.get(ym);
    const matchRev = m?.rev ?? 0;
    const matches = m?.matches.size ?? 0;
    const extraRev = extraByMonth.get(ym) ?? 0;
    const revenueTotal = matchRev + extraRev;
    if (matches === 0 && revenueTotal === 0) continue;
    byMonth.push({
      ym,
      label: ymLabel(ym),
      matches,
      revenue: revenueTotal,
    });
  }

  // Earliest / latest match dates across active rows for the subtitle.
  const allStarts = pac.map((r) => r.match_start).sort();
  const earliestMatchDate = allStarts[0]?.slice(0, 10) ?? null;
  const lastMatchDate =
    allStarts[allStarts.length - 1]?.slice(0, 10) ?? null;

  return { totals, weeks, byMonth, lastMatchDate, earliestMatchDate };
}
