// Partner dashboard stats. Server-side fetch (anon key) + pure compute.
// Mirrors the legacy CSV-driven static HTML's bucket logic exactly so
// numbers reconcile between the old export-to-HTML flow and the live
// partner page.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  fetchLegacyMatchRegistrations,
  loadActiveSubscriptionsByEmail,
} from "./mdapiMatchesRead";

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
  user_type: string | null;
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
      // Non-match revenue (fin_revenue rows) bucketed into this week,
      // broken out per type so the UI can render one line item each
      // (e.g., "Private Rental $100"). Sorted by amount desc. Empty
      // when the week has no extras. Sum equals `extraRev`.
      extras: Array<{ type: string; amount: number }>;
      // Sum of `extras`. Counted in totalRev but NOT in dpRev.
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
    // Distinct user_ids across non-staff, non-match-canceled,
    // non-player-canceled rows. Counts people, not registrations
    // (so always ≤ md). Guests don't have user_ids in mdapi rows,
    // so they're not counted here.
    uniquePlayers: number;
  };
  weeks: PartnerWeekStat[];
  byMonth: PartnerMonthStat[];
  lastMatchDate: string | null;
  earliestMatchDate: string | null;
};

// Display-only label translation for partner-facing UI. The canonical
// type column stays "Private Rental" everywhere — in the database,
// fin_revenue importer, admin pages, and internal stats. Partners
// just see the renamed copy ("Morning Match" reads better than
// "Private Rental" for the Saturday-morning Hattrick rentals).
//
// New mappings should live here so every partner-facing surface picks
// them up uniformly. Internal admin pages do NOT call this helper.
export function partnerLabelForType(type: string): string {
  if (type === "Private Rental") return "Morning Match";
  return type;
}

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

// Full partner_dashboards configuration, returned by fetchPartnerBySlug.
// All payment fields are optional — only revenueSharePct has a default
// (50%). paymentStartDate=null means the payment-tracking feature is
// off for this partner; UI hides the Weekly Payments section entirely.
export type PartnerPaymentCadence = "weekly" | "monthly";

export type PartnerConfig = {
  id: string; // uuid
  venueId: number;
  partnerName: string;
  revenueSharePct: number;
  paymentStartDate: string | null; // YYYY-MM-DD
  paymentDayOfWeek: number; // 0=Sun..6=Sat (legacy; weekly partners only)
  paymentCadence: PartnerPaymentCadence;
};

// Fetch the partner_dashboards row by slug. Returns null on miss or
// when disabled — caller renders 404 either way (don't leak which).
//
// `enabled = true` is enforced both in SQL and again in JS below.
// Belt-and-suspenders: callers that pass a service-role client (the
// public /partners/[slug] page) bypass RLS, so the SQL filter is the
// only DB-level gate; the JS check covers the (legacy) anon-client
// path where RLS already filters but doesn't hurt to double-check.
//
// Resilient to the Phase C schema not yet being applied: if the new
// payment_* columns don't exist, fall back to the legacy shape with
// defaults. This keeps the partner-facing URL working through the
// gap between deploying the code and applying migration 0003.
export async function fetchPartnerBySlug(
  supabase: SupabaseClient,
  slug: string,
): Promise<PartnerConfig | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let error: any = null;
  const primary = await supabase
    .from("partner_dashboards")
    .select(
      "id, venue_id, partner_name, enabled, revenue_share_pct, payment_start_date, payment_day_of_week, payment_cadence",
    )
    .eq("slug", slug)
    .eq("enabled", true)
    .maybeSingle();
  data = primary.data;
  error = primary.error;
  if (error && error.code === "42703") {
    // undefined_column → migration 0005 (or earlier) not yet applied.
    // Re-query without payment_cadence first, then drop the rest of
    // the payment columns if that still fails (pre-0003 schema).
    const noCadence = await supabase
      .from("partner_dashboards")
      .select(
        "id, venue_id, partner_name, enabled, revenue_share_pct, payment_start_date, payment_day_of_week",
      )
      .eq("slug", slug)
      .eq("enabled", true)
      .maybeSingle();
    if (noCadence.error && noCadence.error.code === "42703") {
      const legacy = await supabase
        .from("partner_dashboards")
        .select("id, venue_id, partner_name, enabled")
        .eq("slug", slug)
        .eq("enabled", true)
        .maybeSingle();
      data = legacy.data;
      error = legacy.error;
    } else {
      data = noCadence.data;
      error = noCadence.error;
    }
  }
  if (error || !data) return null;
  if (!data.enabled) return null;
  const rawCadence = (data.payment_cadence ?? "weekly") as string;
  const cadence: PartnerPaymentCadence =
    rawCadence === "monthly" ? "monthly" : "weekly";
  return {
    id: data.id as string,
    venueId: data.venue_id as number,
    partnerName: data.partner_name as string,
    revenueSharePct: Number(data.revenue_share_pct ?? 50),
    paymentStartDate: data.payment_start_date ?? null,
    paymentDayOfWeek: Number(data.payment_day_of_week ?? 0),
    paymentCadence: cadence,
  };
}

// Persisted partner_weekly_payments row (verbatim from the table).
// computeWeeklyPayments LEFT JOINs computed amounts against these to
// produce the merged display rows.
//
// is_pre_system_settlement = true marks lump-sum historical payments
// that predate the weekly payment system. These rows are emitted
// directly into the dashboard table (not generated from match data)
// with a "Through <date>" label instead of a Sunday-anchored week.
export type PartnerWeeklyPaymentRecord = {
  id: string;
  partner_dashboard_id: string;
  week_start_date: string; // YYYY-MM-DD (Sunday for normal rows, through-date for pre-system)
  calculated_amount: number;
  status: "pending" | "paid" | "disputed";
  paid_at: string | null;
  paid_notes: string | null;
  dispute_note: string | null;
  disputed_at: string | null;
  is_pre_system_settlement: boolean;
};

// Fetch all persisted weekly payment records for one partner_dashboard.
// Returns [] when the table doesn't exist yet (pre-migration), so the
// partner page still renders. Resilient to migration 0004 not yet
// applied: if is_pre_system_settlement column is missing, falls back
// to the legacy column set with the flag defaulted to false.
export async function fetchPartnerWeeklyPayments(
  supabase: SupabaseClient,
  partnerDashboardId: string,
): Promise<PartnerWeeklyPaymentRecord[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any[] | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let error: any = null;
  const primary = await supabase
    .from("partner_weekly_payments")
    .select(
      "id, partner_dashboard_id, week_start_date, calculated_amount, status, paid_at, paid_notes, dispute_note, disputed_at, is_pre_system_settlement",
    )
    .eq("partner_dashboard_id", partnerDashboardId)
    .order("week_start_date", { ascending: true });
  data = primary.data;
  error = primary.error;
  if (error && error.code === "42703") {
    // is_pre_system_settlement column missing — pre-0004 schema.
    const fallback = await supabase
      .from("partner_weekly_payments")
      .select(
        "id, partner_dashboard_id, week_start_date, calculated_amount, status, paid_at, paid_notes, dispute_note, disputed_at",
      )
      .eq("partner_dashboard_id", partnerDashboardId)
      .order("week_start_date", { ascending: true });
    data = fallback.data;
    error = fallback.error;
  }
  if (error) {
    // 42P01 = undefined_table, PGRST205 = table not in schema cache
    // (PostgREST equivalent). Both mean the table itself is missing.
    if (error.code === "42P01" || error.code === "PGRST205") return [];
    throw new Error(`Weekly payments fetch failed: ${error.message}`);
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    partner_dashboard_id: r.partner_dashboard_id,
    week_start_date: String(r.week_start_date).slice(0, 10),
    calculated_amount: Number(r.calculated_amount ?? 0),
    status: r.status as "pending" | "paid" | "disputed",
    paid_at: r.paid_at ?? null,
    paid_notes: r.paid_notes ?? null,
    dispute_note: r.dispute_note ?? null,
    disputed_at: r.disputed_at ?? null,
    is_pre_system_settlement: Boolean(r.is_pre_system_settlement ?? false),
  }));
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

  // Read this venue's matches+players from mdapi_matches /
  // mdapi_match_players via the shared lib. ILIKE filter on
  // mdapi_matches.field_title mirrors the CSV-era venue match.
  //
  // Subs map is passed so paid_status=FREE rows split into real
  // MEMBER vs FREE_NON_MEMBER (first-match-free, guest passes,
  // manager-added fills). Without it, partner MEMBER counts would
  // diverge from /admin/finance Match P&L numbers post-2026-05-20.
  const subscriptionsByEmail = await loadActiveSubscriptionsByEmail(supabase);
  const out: PartnerRegRow[] = await fetchLegacyMatchRegistrations(
    supabase,
    { fieldLike: `%${venue.venue_name}%` },
    subscriptionsByEmail,
  );

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

// Bucket extra (non-match) revenue. Per-week is keyed (week → type →
// amount) so the UI can render one line item per revenue type. Per-
// month stays scalar (the monthly summary table only shows a single
// total column).
function bucketExtraRevenue(extra: PartnerExtraRevRow[]): {
  byWeek: Map<string, Map<string, number>>;
  byMonth: Map<string, number>;
} {
  const byWeek = new Map<string, Map<string, number>>();
  const byMonth = new Map<string, number>();
  for (const e of extra) {
    if (!e.date) continue;
    const wk = getWeekMonday(e.date);
    const typeMap = byWeek.get(wk) ?? new Map<string, number>();
    typeMap.set(e.type, (typeMap.get(e.type) ?? 0) + e.gross);
    byWeek.set(wk, typeMap);
    const ym = e.date.slice(0, 7); // YYYY-MM
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + e.gross);
  }
  return { byWeek, byMonth };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Convert a (type → amount) map into the sorted extras array shape
// the UI expects. Empty types and zero-amount entries are dropped.
function sortedExtrasFor(
  typeMap: Map<string, number> | undefined,
): Array<{ type: string; amount: number }> {
  if (!typeMap || typeMap.size === 0) return [];
  const out: Array<{ type: string; amount: number }> = [];
  for (const [type, amount] of typeMap) {
    if (!type || Math.abs(amount) < 0.005) continue;
    out.push({ type, amount });
  }
  out.sort((a, b) => b.amount - a.amount);
  return out;
}

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
      totals: {
        spots: 0,
        md: 0,
        guests: 0,
        cancels: 0,
        rev: 0,
        uniquePlayers: 0,
      },
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

    // Group by user+match_start. Used below for payment-type host
    // detection (dp/mem/promo per host bucket). NOT used for guest
    // counting anymore — that switched to direct user_type tags from
    // mdapi_match_players, the source-of-truth field. The old
    // group-size heuristic over-counted guests when a player had
    // multiple registrations on the same match (e.g. data anomalies)
    // and under-counted when guest rows didn't share the host's
    // user_id.
    const userMatch = new Map<string, PartnerRegRow[]>();
    for (const r of showed) {
      const key = `${r.user_id}|${r.match_start}`;
      const arr = userMatch.get(key) ?? [];
      arr.push(r);
      userMatch.set(key, arr);
    }

    const mdPlayers = showed.filter((r) => r.user_type === "PLAYER").length;
    const guests = showed.filter((r) => r.user_type === "GUEST").length;
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
    const extras = sortedExtrasFor(extraByWeek.get(wkMonday));
    const extraRev = extras.reduce((s, x) => s + x.amount, 0);
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
      extras,
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
    { spots: 0, md: 0, guests: 0, cancels: 0, rev: 0, uniquePlayers: 0 },
  );

  // Cross-week distinct user_id count. Computed separately because the
  // per-week aggregates can't dedup someone who showed up across
  // multiple weeks. Excludes player-cancelled rows (those didn't show)
  // and match_canceled (already excluded from `pac`).
  const uniqueIds = new Set<string>();
  for (const r of pac) {
    if (isCanceled(r)) continue;
    uniqueIds.add(r.user_id);
  }
  totals.uniquePlayers = uniqueIds.size;

  // Catch any extraRev that lands in a week with no match data (no
  // weekMap[wk] entry → no week stat created → its extraRev was never
  // pulled in). Add those to the all-time total so nothing is dropped.
  const accountedWeeks = new Set(weeks.map((w) => w.wkMonday));
  for (const [wk, typeMap] of extraByWeek) {
    if (accountedWeeks.has(wk)) continue;
    for (const amt of typeMap.values()) totals.rev += amt;
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

// =====================================================================
// Phase C — weekly payment tracking
// =====================================================================
//
// First-week rule (single source of truth — the admin "Start date"
// tooltip and the partner-facing empty-state copy both reference this):
//
//   The first qualifying week is the first Sunday on or after the
//   partner's payment_start_date. Weeks whose Sunday falls before
//   payment_start_date are excluded entirely. This avoids partial-week
//   math — every counted week is a complete Sun→Sat window.
//
// Past + current weeks only:
//
//   For each Sunday `S` from firstQualifyingSunday forward, include S
//   only if S ≤ today (UTC date). The current week's row appears even
//   if its Saturday is in the future — qualifying revenue accrues in
//   real time. Future weeks not yet started don't appear.
//
// Qualifying revenue:
//
//   - DPP: sum of match_price_paid from match_registrations rows where
//     payment_type='DAILY PAID' AND match_start ∈ [Sun, Sat] AND not
//     staff AND not match_canceled. Mirrors the existing `dpRev` calc
//     in computePartnerStats — same source rows, same filter.
//   - Private Rental: sum of fin_revenue.gross where type='Private
//     Rental' AND date ∈ [Sun, Sat]. Note: fin_revenue extras already
//     exclude DPP/Membership at the fetch layer; here we tighten
//     further to *just* Private Rental (Strike etc. don't count toward
//     payment, only toward total revenue display).
//
// Owed = qualifyingRevenue × revenue_share_pct / 100. Persisted rows
// (partner_weekly_payments) override the displayed status/paid_at —
// computeWeeklyPayments does the LEFT-OUTER merge here.

export type PartnerWeeklyPayment = {
  weekStartDate: string; // YYYY-MM-DD (Sunday for normal rows, through-date for pre-system)
  weekEndDate: string; // YYYY-MM-DD (Saturday for normal rows, same as weekStartDate for pre-system)
  qualifyingRevenue: number; // 0 for pre-system rows (UI renders "—")
  owedAmount: number; // qualifyingRevenue × pct/100 for normal rows; calculated_amount for pre-system
  status: "pending" | "paid" | "disputed";
  // When a partner_weekly_payments row exists for this week, these
  // mirror the persisted row. When no row exists, status='pending'
  // and the rest are null.
  recordId: string | null;
  calculatedAmount: number | null; // snapshot at time of marking paid
  paidAt: string | null;
  paidNotes: string | null;
  disputeNote: string | null;
  disputedAt: string | null;
  // True for lump-sum historical settlements that predate the
  // weekly payment system. UI renders "Through <date>" instead of
  // "Week of <date>" and shows the qualifying-revenue cell as "—".
  isPreSystem: boolean;
};

export type PartnerPaymentInfo = {
  enabled: boolean; // payment_start_date is not null OR pre-system rows exist
  cadence: PartnerPaymentCadence;
  revenueSharePct: number;
  paymentStartDate: string | null;
  paymentDayOfWeek: number;
  // First period boundary on or after payment_start_date. For weekly
  // cadence: YYYY-MM-DD of the first Sunday. For monthly cadence:
  // YYYY-MM-DD of the first day of the first qualifying calendar
  // month. Null when paymentStartDate is null.
  firstQualifyingPeriod: string | null;
  // Legacy alias kept so existing callers don't break — same value as
  // firstQualifyingPeriod for weekly partners.
  firstQualifyingSunday: string | null;
  weeklyPayments: PartnerWeeklyPayment[];
};

// Today as a UTC YYYY-MM-DD string. Uses UTC to match the Sunday-
// anchor logic, which also operates in UTC to avoid timezone drift
// across date boundaries.
function todayUtcYmd(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Ceil a YYYY-MM-DD date to the next Sunday (or itself if already
// Sunday). Returns YYYY-MM-DD.
function ceilToSunday(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  if (dow === 0) return ymd;
  const daysToAdd = 7 - dow;
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return d.toISOString().slice(0, 10);
}

// Add N days to a YYYY-MM-DD date (UTC). Returns YYYY-MM-DD.
function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Ceil a YYYY-MM-DD to the next first-of-month (or itself if already
// the 1st). Used by the monthly-cadence first-period rule.
function ceilToMonthStart(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = d.getUTCDate();
  if (day === 1) return ymd;
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}

// Last day of the month for a given first-of-month YYYY-MM-DD.
function lastDayOfMonth(monthStart: string): string {
  const d = new Date(`${monthStart}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0); // day 0 of next month = last day of current month
  return d.toISOString().slice(0, 10);
}

// First-of-next-month for monthly iteration.
function nextMonthStart(monthStart: string): string {
  const d = new Date(`${monthStart}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}

// Generates partner payment rows for both weekly and monthly cadences.
// (Function name kept as-is to avoid touching every caller — name was
// already a misnomer once pre-system rows were added.)
//
// MONTHLY CADENCE
// ───────────────
// For monthly partners, partner_weekly_payments.week_start_date stores
// the FIRST DAY of the calendar month (e.g. 2026-04-01 for April
// 2026). Period = the full calendar month (1st → last day inclusive).
// Payments are sent on the 5th of the following month — so April's
// payment goes out May 5.
//
// First qualifying month = the first calendar month that *starts* on
// or after payment_start_date. payment_start_date='2026-05-05' means
// May 2026 doesn't qualify (May 1 < May 5); first qualifying = June.
// payment_start_date='2026-05-01' means May qualifies (May 1 = May 1).
//
// Past + current month only: rows for months whose first day is ≤
// today. Future months don't appear.
export function computeWeeklyPayments(
  matchRows: PartnerRegRow[],
  finRevRows: PartnerExtraRevRow[],
  config: {
    revenueSharePct: number;
    paymentStartDate: string | null;
    paymentDayOfWeek: number;
    paymentCadence?: PartnerPaymentCadence;
  },
  records: PartnerWeeklyPaymentRecord[] = [],
  now: Date = new Date(),
): PartnerPaymentInfo {
  const cadence: PartnerPaymentCadence = config.paymentCadence ?? "weekly";

  // Pre-system rows are cadence-agnostic — they represent historical
  // lump sums regardless of how the partner is currently paid.
  const preSystemRecords = records.filter((r) => r.is_pre_system_settlement);
  const preSystemRows: PartnerWeeklyPayment[] = preSystemRecords
    .slice()
    .sort((a, b) => a.week_start_date.localeCompare(b.week_start_date))
    .map((r) => ({
      weekStartDate: r.week_start_date,
      weekEndDate: r.week_start_date,
      qualifyingRevenue: 0,
      owedAmount: r.calculated_amount,
      status: r.status,
      recordId: r.id,
      calculatedAmount: r.calculated_amount,
      paidAt: r.paid_at,
      paidNotes: r.paid_notes,
      disputeNote: r.dispute_note,
      disputedAt: r.disputed_at,
      isPreSystem: true,
    }));

  if (!config.paymentStartDate) {
    return {
      enabled: preSystemRows.length > 0,
      cadence,
      revenueSharePct: config.revenueSharePct,
      paymentStartDate: null,
      paymentDayOfWeek: config.paymentDayOfWeek,
      firstQualifyingPeriod: null,
      firstQualifyingSunday: null,
      weeklyPayments: preSystemRows,
    };
  }

  const today = todayUtcYmd(now);
  const matchActive = matchRows.filter(
    (r) =>
      !(r.email && r.email.toLowerCase().includes(STAFF_EMAIL_DOMAIN)) &&
      !r.match_canceled,
  );
  const generatedRecords = records.filter((r) => !r.is_pre_system_settlement);
  const recordByPeriod = new Map<string, PartnerWeeklyPaymentRecord>();
  for (const rec of generatedRecords) recordByPeriod.set(rec.week_start_date, rec);

  const generatedRows: PartnerWeeklyPayment[] = [];
  let firstQualifyingPeriod: string;

  if (cadence === "monthly") {
    firstQualifyingPeriod = ceilToMonthStart(config.paymentStartDate);
    let cursor = firstQualifyingPeriod;
    while (cursor <= today) {
      const monthEnd = lastDayOfMonth(cursor);
      let dpRev = 0;
      for (const r of matchActive) {
        if (r.payment_type !== "DAILY PAID") continue;
        const matchYmd = r.match_start.slice(0, 10);
        if (matchYmd < cursor || matchYmd > monthEnd) continue;
        dpRev += Number(r.match_price_paid ?? 0) || 0;
      }
      let prRev = 0;
      for (const e of finRevRows) {
        if (e.type !== "Private Rental") continue;
        if (!e.date || e.date < cursor || e.date > monthEnd) continue;
        prRev += Number(e.gross ?? 0) || 0;
      }
      const qualifyingRevenue = dpRev + prRev;
      const owedAmount =
        Math.round(qualifyingRevenue * config.revenueSharePct) / 100;
      const rec = recordByPeriod.get(cursor);
      generatedRows.push({
        weekStartDate: cursor,
        weekEndDate: monthEnd,
        qualifyingRevenue,
        owedAmount,
        status: rec?.status ?? "pending",
        recordId: rec?.id ?? null,
        calculatedAmount: rec?.calculated_amount ?? null,
        paidAt: rec?.paid_at ?? null,
        paidNotes: rec?.paid_notes ?? null,
        disputeNote: rec?.dispute_note ?? null,
        disputedAt: rec?.disputed_at ?? null,
        isPreSystem: false,
      });
      cursor = nextMonthStart(cursor);
    }
  } else {
    firstQualifyingPeriod = ceilToSunday(config.paymentStartDate);
    let cursor = firstQualifyingPeriod;
    while (cursor <= today) {
      const weekEnd = addDays(cursor, 6);
      let dpRev = 0;
      for (const r of matchActive) {
        if (r.payment_type !== "DAILY PAID") continue;
        const matchYmd = r.match_start.slice(0, 10);
        if (matchYmd < cursor || matchYmd > weekEnd) continue;
        dpRev += Number(r.match_price_paid ?? 0) || 0;
      }
      let prRev = 0;
      for (const e of finRevRows) {
        if (e.type !== "Private Rental") continue;
        if (!e.date || e.date < cursor || e.date > weekEnd) continue;
        prRev += Number(e.gross ?? 0) || 0;
      }
      const qualifyingRevenue = dpRev + prRev;
      const owedAmount =
        Math.round(qualifyingRevenue * config.revenueSharePct) / 100;
      const rec = recordByPeriod.get(cursor);
      generatedRows.push({
        weekStartDate: cursor,
        weekEndDate: weekEnd,
        qualifyingRevenue,
        owedAmount,
        status: rec?.status ?? "pending",
        recordId: rec?.id ?? null,
        calculatedAmount: rec?.calculated_amount ?? null,
        paidAt: rec?.paid_at ?? null,
        paidNotes: rec?.paid_notes ?? null,
        disputeNote: rec?.dispute_note ?? null,
        disputedAt: rec?.disputed_at ?? null,
        isPreSystem: false,
      });
      cursor = addDays(cursor, 7);
    }
  }

  return {
    enabled: true,
    cadence,
    revenueSharePct: config.revenueSharePct,
    paymentStartDate: config.paymentStartDate,
    paymentDayOfWeek: config.paymentDayOfWeek,
    firstQualifyingPeriod,
    firstQualifyingSunday: firstQualifyingPeriod, // legacy alias
    weeklyPayments: [...preSystemRows, ...generatedRows],
  };
}

// Forward-looking alias. New callers should prefer this name; existing
// callers continue to use computeWeeklyPayments for now.
export const computePartnerPayments = computeWeeklyPayments;
