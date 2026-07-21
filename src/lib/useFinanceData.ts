"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { selectAll } from "./supabasePagination";
import { cityFromAbbr } from "./cityMap";
import {
  buildMdapiMemberSpotIndex,
  emptyMdapiMemberSpotIndex,
  findStaleProjectionRevenue,
  isoToMonthKey,
  type MdapiMemberSpotIndex,
} from "./financeStats";
import {
  buildPartnerPayoutsByVenueMonth,
  fetchAllEnabledPartnerDashboards,
  type PartnerConfig,
} from "./partnerStats";
import {
  fetchLegacyMatchRegistrations,
  loadMembershipWindowsByUserId,
} from "./mdapiMatchesRead";
import { useFinanceQuarter } from "./financeQuarter";
import {
  benchmarkMonthFetchBounds,
  coversBenchmarkMonth,
  getCurrentQuarter,
  getQuarterByKey,
  mostRecentCompletedMonth,
  type QuarterInfo,
} from "./quarters";
import { resolveSplitRateVenueId } from "./venueGroups";

// Pad the quarter window by 14d on each side so MTD-vs-prior-month
// math (priorMonthSameDayMtdGross) and the +14d forward window for
// matches that bleed into the next quarter both resolve cleanly.
const QUARTER_FETCH_BUFFER_DAYS = 14;
function quarterFetchBounds(quarter: QuarterInfo): {
  fromDate: string;
  toDate: string;
} {
  const fromMs = quarter.start.getTime() - QUARTER_FETCH_BUFFER_DAYS * 86400_000;
  const toMs = quarter.end.getTime() + QUARTER_FETCH_BUFFER_DAYS * 86400_000;
  return {
    fromDate: new Date(fromMs).toISOString().slice(0, 10),
    toDate: new Date(toMs).toISOString().slice(0, 10),
  };
}

export type FinRevenue = {
  id: number;
  date: string;
  month: string;
  city: string;
  venue: string | null;
  type: string;
  gross: number;
  fees: number;
  net: number;
  source: string;
  notes: string | null;
  manual_entry: boolean;
};

export type FinExpense = {
  id: number;
  date: string;
  month: string;
  city: string;
  category: string;
  vendor: string | null;
  amount: number;
  notes: string | null;
  manual_entry: boolean;
};

export type FinManagerPay = {
  id: number;
  city: string;
  month: string;
  amount: number;
};

// One row per actual match, sourced from mdapi_matches. This is the
// cost-calc source; the operator-curated fin_schedule "Billing Schedule"
// table it replaced (2026-06-01) drifted stale and its UI has since been
// removed. schedule_master remains a separate table for the Master Schedule
// editor + discrepancy tooling, not billing.
//
// `venue_id` is resolved at load time via mdapi_field_id → venueFields,
// with a (city, venue_name) string fallback for legacy rows whose
// mdapi_field_id is null. Split-rate venues (ATH Katy) re-route by
// day-of-week through resolveSplitRateVenueId — Sunday matches go to
// the Sunday leg id even though their mdapi_field_id points at the
// weekday leg.
//
// `duration_hours` is parsed from the match_time range ("7:00 PM -
// 8:00 PM" → 1). Falls back to 1 when the time string isn't a parseable
// range. Only consumed by per_hour cost paths; per_match cost is
// row-count × rate.
export type FinMasterSchedule = {
  id: string;
  city: string;
  venue: string;
  match_date: string;
  match_time: string;
  month: string;
  max_spots: number;
  mdapi_field_id: number | null;
  venue_id: number | null;
  duration_hours: number;
};

export type FinVenue = {
  id: number;
  venue_name: string;       // canonical (post-alias)
  raw_venue_name: string;   // pre-alias — used for per-leg accounting on
                            // split-rate venues (ATH Katy / Sunday) where
                            // aliases collapse the canonical name.
  city: string;
  // Billing classification (narrowed to live values only — the
  // per_hour / lump_sum / no_charge options were retired after every
  // venue migrated off them).
  // - per_match: cost auto-computed from schedule × per_match_rate.
  // - monthly_flat / profit_share: cost lives in fin_venue_cost_overrides
  //   per (venue, month). Profit_share currently behaves the same as
  //   monthly_flat (override-driven); real profit-share logic TBD.
  billing_type: "per_match" | "monthly_flat" | "profit_share";
  // Inert column. Kept on the type for DB-row compatibility with venues
  // created during the per_hour era. No UI writes it now and no cost
  // path reads it. Safe to remove from the DB schema once those legacy
  // rows are migrated forward and you're sure no historical view needs
  // the value.
  hourly_rate: number | null;
  monthly_flat: number | null;
  per_match_rate: number | null;
  max_spots: number | null;
  // Per-spot retail pricing. Edited inline on /admin/finance/field-costs;
  // feeds the projection algorithm (scheduled_matches × dpp_price ×
  // historical_fill_rate). Nullable so newly-added venues can be filled
  // in lazily.
  dpp_price: number | null;
  member_price: number | null;
  // Per-match unit cost for P&L analysis. Independent of
  // per_match_rate (which drives cash-flow billing). Manually set
  // per venue via the Field Costs config table; nullable until set.
  // Migration 0010 added the column.
  cost_per_match: number | null;
  notes: string | null;
  launch_date: string | null;
  is_active: boolean;
  // True when the venue charges us for cancelled matches (most
  // contracts). false for venues that waive the cancellation fee.
  // Drives the count delta on venueChargedMatchCountFor — when true,
  // cancelled mdapi rows are added to the schedule_master alive count
  // for cost purposes. Migration column NOT NULL DEFAULT true so reads
  // never see null; mapper still defaults defensively for cached rows.
  charge_on_cancel: boolean;
  // Per-venue billing TIMING for the OpEx calendar (migration 0069).
  // Only used to place a flat/quarterly venue's monthly amount on a real
  // day; per_match venues date off their schedule instead. billing_day
  // null = timing not captured (shown as an undated remainder, never
  // defaulted to day 1). Defaults applied in the mapper so pre-migration
  // cached rows read cleanly.
  billing_cadence: "monthly" | "quarterly" | "annual" | "weekly" | "custom";
  billing_day: number | null;
  billing_anchor_month: number | null;
  // WEEKLY cadence (migration 0070): day of week (0=Sun..6=Sat) the bill
  // hits. NULL = timing not captured (undated remainder, never day 1).
  billing_weekday: number | null;
  // CUSTOM cadence (migration 0070): per-MONTH day-of-month map keyed by
  // ISO year-month, e.g. {"2026-08":[20],"2026-11":[15]}. NEMP's 4
  // irregular payments a year live here (not a repeating pattern). Carries
  // only the day(s); a flat venue's per-month AMOUNT stays in
  // fin_venue_cost_overrides. Pre-migration cached rows → {}.
  billing_custom_days: Record<string, number[]>;
};

export type FinMemberSpotsRow = {
  id: number;
  venue: string;
  city: string;
  month: string;
  member_spots: number;
  dpp_spots: number;
  other_spots: number;
};

export type FinMember = {
  id: number;
  member_id: string;
  status: string;
  price_cents: number;
  city: string;
  email: string | null;
  activation_date: string | null;
  canceled_at: string | null;
};

export type FinPricing = {
  id: number;
  venue_name: string;
  city: string;
  dpp_price: number;
  member_price: number;
  notes: string | null;
};

export type FinVenueCostOverride = {
  id: number;
  venue_id: number;
  month: string;
  override_amount: number;
  reason: string | null;
  created_at: string;
  created_by: string;
};

export type FinanceData = {
  revenue: FinRevenue[];
  expenses: FinExpense[];
  managerPay: FinManagerPay[];
  // Reconciled mdapi_matches rows (one per match) with venue_id resolved
  // and duration parsed. Source for every cost-calc helper.
  masterSchedule: FinMasterSchedule[];
  // Cancelled mdapi_matches in the active quarter window, resolved
  // to venue_id the same way. Surfaced separately from masterSchedule
  // (which stays alive-only by design — see the backfill script) so
  // each row can be conditionally counted at cost time based on the
  // venue's charge_on_cancel flag. The Matches column also reads the
  // cancelled-charged count from here to render its "+N cxl" badge.
  cancelledSchedule: FinMasterSchedule[];
  venues: FinVenue[];
  memberSpots: FinMemberSpotsRow[];
  members: FinMember[];
  pricing: FinPricing[];
  overrides: FinVenueCostOverride[];
  venueAliases: Map<string, string>;
  // PR-E: mdapi field_id → fin_venues.id. Source of truth for the
  // venue-side internal join now that Finance read paths key on
  // field_id instead of name canonicalization. Seeded from
  // fin_venue_fields (migration 0041). venueAliases stays for the
  // Stripe boundary (fin_revenue.venue is a normalized name string).
  venueFields: Map<number, number>;
  config: Record<string, string>;
  // Member-spot counts derived from mdapi_match_players, used as the
  // denominator for the member-revenue allocation helpers in
  // financeStats.ts. Replaces fin_member_spots in active read paths;
  // see buildMdapiMemberSpotIndex for shape.
  mdapiMemberSpots: MdapiMemberSpotIndex;
  // Enabled partner_dashboards rows (1-to-1 with fin_venues via
  // partner_dashboards.venue_id). Drives the profit_share cost calc
  // branch — autoCost looks up the dashboard by venueId to know
  // whether to compute a payout (dashboard present) or signal
  // "needs override" (no dashboard).
  partnerDashboards: PartnerConfig[];
  // Pre-computed partner payout per (venue, month), keyed
  // `${venueId}|${monthLabel}` (e.g. "10|Apr 2026"). Built once at
  // data-load via buildPartnerPayoutsByVenueMonth. Profit_share
  // venues read from here through partnerPaymentOwedForMonth().
  // A null lookup means no dashboard; a 0 lookup means dashboard
  // exists but no qualifying revenue in that month yet.
  partnerPayoutsByVenueMonth: Map<string, number>;
};

type State = {
  data: FinanceData | null;
  loading: boolean;
  error: string | null;
};

const INITIAL: State = { data: null, loading: true, error: null };

// Wave 3j: cache keyed by QuarterInfo.key. Each quarter gets its own
// State entry so navigating Q2 → Q3 → Q2 reuses the earlier fetch
// without a re-pull. Mirrors the per-city cache pattern in
// useMatchData. Same pattern → same subscriber + pending tracking.
const cachedByQuarter = new Map<string, State>();
const pendingByQuarter = new Map<string, Promise<void>>();
const subscribersByQuarter = new Map<string, Set<(s: State) => void>>();

function publish(quarterKey: string, s: State) {
  cachedByQuarter.set(quarterKey, s);
  subscribersByQuarter.get(quarterKey)?.forEach((fn) => fn(s));
}

function getCachedFor(quarterKey: string): State {
  return cachedByQuarter.get(quarterKey) ?? INITIAL;
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/^"+|"+$/g, "").trim();
    const n = parseFloat(cleaned);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function cleanText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/^"+|"+$/g, "").trim();
}

// Coerce the fin_venues.billing_custom_days jsonb into a clean
// { "YYYY-MM": number[] } map. supabase-js returns jsonb already parsed,
// but tolerate a raw JSON string too. Drops any malformed entry so a bad
// value never crashes the calendar; pre-migration rows (undefined) → {}.
function parseCustomDays(v: unknown): Record<string, number[]> {
  let obj: unknown = v;
  if (typeof v === "string") {
    try {
      obj = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, number[]> = {};
  for (const [key, raw] of Object.entries(obj as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}$/.test(key) || !Array.isArray(raw)) continue;
    const days = [
      ...new Set(
        raw
          .map((n) => Math.round(asNumber(n)))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31),
      ),
    ].sort((a, b) => a - b);
    if (days.length > 0) out[key] = days;
  }
  return out;
}

function cleanTextNullable(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const cleaned = String(v).replace(/^"+|"+$/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

const MONTH_NORMALIZERS: { full: string; short: string; label: string }[] = [
  { full: "january", short: "jan", label: "Jan" },
  { full: "february", short: "feb", label: "Feb" },
  { full: "march", short: "mar", label: "Mar" },
  { full: "april", short: "apr", label: "Apr" },
  { full: "may", short: "may", label: "May" },
  { full: "june", short: "jun", label: "Jun" },
  { full: "july", short: "jul", label: "Jul" },
  { full: "august", short: "aug", label: "Aug" },
  { full: "september", short: "sep", label: "Sep" },
  { full: "october", short: "oct", label: "Oct" },
  { full: "november", short: "nov", label: "Nov" },
  { full: "december", short: "dec", label: "Dec" },
];

// Derive "Mon YYYY" from a YYYY-MM-DD calendar date. UTC math is safe
// because match_date is a calendar date with no timezone.
function monthFromMatchDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  const label = MONTH_NORMALIZERS[d.getUTCMonth()]?.label ?? "";
  return label ? `${label} ${d.getUTCFullYear()}` : "";
}

// Map a raw mdapi_matches row to the FinMasterSchedule shape the cost
// calc consumes. Resolves field_id → fin_venue_id via fin_venue_fields,
// then split-rate routing (ATH Katy by day-of-week, Soccer Central by
// capacity). Both masterSchedule (is_cancelled=false) and
// cancelledSchedule (is_cancelled=true) go through this, so they resolve
// identically and form disjoint halves of mdapi_matches — no overlap,
// no double-count. Replaces schedule_master as the billing source on
// 2026-06-01 (schedule_master was a stale manual snapshot that diverged
// from the live platform; it stays for the Master Schedule admin only).
function mapMdapiRowToSchedule(
  r: Record<string, unknown>,
  venueFields: Map<number, number>,
  venues: FinVenue[],
  counters: { unresolved: number; specialEvent: number },
): FinMasterSchedule {
  const startDate = cleanText(r.start_date);
  const matchDate = startDate
    ? new Date(startDate).toISOString().slice(0, 10)
    : "";
  const rawFieldId = r.field_id;
  const mdapiFieldId =
    rawFieldId === null || rawFieldId === undefined ? null : Number(rawFieldId);
  // max_player_count drives the Soccer Central capacity split (and 0/null
  // = special event → resolver returns null → row drops from cost).
  const rawMaxPlayerCount = r.max_player_count;
  const maxPlayerCount =
    rawMaxPlayerCount == null ? null : Math.round(Number(rawMaxPlayerCount) || 0);
  const initialVenueId =
    mdapiFieldId != null ? (venueFields.get(mdapiFieldId) ?? null) : null;
  let resolvedVenueId: number | null = initialVenueId;
  if (resolvedVenueId != null && matchDate) {
    const beforeSplit = resolvedVenueId;
    resolvedVenueId = resolveSplitRateVenueId(
      resolvedVenueId,
      matchDate,
      venues,
      maxPlayerCount,
    );
    if (resolvedVenueId == null && beforeSplit != null) counters.specialEvent += 1;
  }
  if (resolvedVenueId == null && initialVenueId == null) counters.unresolved += 1;
  const v =
    resolvedVenueId != null
      ? venues.find((x) => x.id === resolvedVenueId)
      : null;
  let matchTime = "";
  if (startDate) {
    const d = new Date(startDate);
    if (!Number.isNaN(d.getTime())) {
      const fmt = (h: number, m: number) => {
        const ampm = h >= 12 ? "PM" : "AM";
        const h12 = h % 12 === 0 ? 12 : h % 12;
        return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
      };
      const h = d.getUTCHours();
      const min = d.getUTCMinutes();
      matchTime = `${fmt(h, min)} - ${fmt((h + 1) % 24, min)}`;
    }
  }
  return {
    id: String(r.api_id ?? ""),
    city: v?.city ?? "",
    venue: v?.venue_name ?? "",
    match_date: matchDate,
    match_time: matchTime,
    month: monthFromMatchDate(matchDate),
    max_spots: Math.round(asNumber(r.max_player_count) || 0),
    mdapi_field_id: mdapiFieldId,
    venue_id: resolvedVenueId,
    duration_hours: 1,
  };
}

function normalizeMonth(v: unknown): string {
  if (v === null || v === undefined) return "";
  const raw = String(v).trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  for (const m of MONTH_NORMALIZERS) {
    const reFull = new RegExp(`(?:^|[^a-z])${m.full}(?:[^a-z]|$)`);
    const reShort = new RegExp(`(?:^|[^a-z])${m.short}(?:[^a-z]|$)`);
    if (reFull.test(lower) || reShort.test(lower)) {
      const yearMatch = lower.match(/(20\d{2})/);
      const year = yearMatch ? yearMatch[1] : "2026";
      return `${m.label} ${year}`;
    }
  }
  return raw;
}

async function load(quarter: QuarterInfo): Promise<void> {
  const key = quarter.key;
  const prior = cachedByQuarter.get(key);
  publish(key, { data: prior?.data ?? null, loading: true, error: null });

  // Multi-row reads go through selectAll() so they're not silently capped
  // at PostgREST's 1000-row max. fin_venues / fin_venue_aliases /
  // fin_pricing / fin_config / fin_venue_cost_overrides are bounded by
  // venue count and would never approach 1000, but we still paginate them
  // for uniform error handling — selectAll exits after one round-trip
  // when the table fits in a single page.
  let revenueRows: Array<Record<string, unknown>>;
  let expenseRows: Array<Record<string, unknown>>;
  let mpRows: Array<Record<string, unknown>>;
  let cfgRows: Array<Record<string, unknown>>;
  let smsRows: Array<Record<string, unknown>>;
  let cmsRows: Array<Record<string, unknown>>;
  let vnRows: Array<Record<string, unknown>>;
  let msRows: Array<Record<string, unknown>>;
  let alRows: Array<Record<string, unknown>>;
  let vfRows: Array<Record<string, unknown>>;
  let mbrRows: Array<Record<string, unknown>>;
  let prcRows: Array<Record<string, unknown>>;
  let ovRows: Array<Record<string, unknown>>;
  let mdapiRegRows: Awaited<
    ReturnType<typeof fetchLegacyMatchRegistrations>
  >;
  const smBounds = quarterFetchBounds(quarter);
  try {
    [
      revenueRows,
      expenseRows,
      mpRows,
      cfgRows,
      smsRows,
      cmsRows,
      vnRows,
      msRows,
      alRows,
      vfRows,
      mbrRows,
      prcRows,
      ovRows,
      mdapiRegRows,
    ] = await Promise.all([
      selectAll<Record<string, unknown>>(() =>
        supabase.from("fin_revenue").select("*").order("id"),
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase.from("fin_expenses").select("*").order("id"),
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase.from("fin_manager_pay").select("*").order("id"),
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase.from("fin_config").select("*").order("key"),
      ),
      // ALIVE mdapi_matches in the quarter ±14d window — the billing
      // source of truth (2026-06-01). Was schedule_master, a stale
      // manual snapshot that double-counted now-cancelled matches and
      // diverged from the live platform; mdapi is auto-synced. Resolved
      // to venue_id the same way as cancelledSchedule below (field_id →
      // venueFields → split-rate), so the two are disjoint halves of
      // mdapi_matches. schedule_master stays for the Master Schedule
      // admin editor + discrepancy tooling, just not for billing.
      selectAll<Record<string, unknown>>(() =>
        supabase
          .from("mdapi_matches")
          .select(
            "api_id, field_id, field_title, start_date, max_player_count",
          )
          .eq("is_cancelled", false)
          // Exclude soft-deleted phantoms (deleted upstream in MatchDay)
          // so existence-based field costs don't bill matches that no
          // longer exist. See mdapiMatchesSync tombstone pass.
          .is("deleted_at", null)
          .gte("start_date", `${smBounds.fromDate}T00:00:00Z`)
          .lte("start_date", `${smBounds.toDate}T23:59:59Z`)
          .order("start_date"),
      ),
      // Cancelled mdapi_matches in the same window — counted at cost
      // time only when the resolved venue's charge_on_cancel is true.
      // start_date is a timestamptz at UTC offset; same date window as
      // schedule_master's match_date column, just expressed as ISO
      // timestamps for the .gte/.lte. mdapi_matches.api_id is numeric,
      // not a uuid, so id stringifies in the mapper.
      selectAll<Record<string, unknown>>(() =>
        supabase
          .from("mdapi_matches")
          .select(
            "api_id, field_id, field_title, start_date, max_player_count",
          )
          .eq("is_cancelled", true)
          // Exclude soft-deleted phantoms here too: a cancelled match
          // that was later deleted upstream should not bill at
          // charge_on_cancel venues.
          .is("deleted_at", null)
          .gte("start_date", `${smBounds.fromDate}T00:00:00Z`)
          .lte("start_date", `${smBounds.toDate}T23:59:59Z`)
          .order("start_date"),
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase.from("fin_venues").select("*").order("id"),
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase.from("fin_member_spots").select("*").order("id"),
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase.from("fin_venue_aliases").select("*").order("alias"),
      ),
      // PR-E: fin_venue_fields is the canonical join table between
      // mdapi field_id and fin_venues.id. Loaded once per quarter
      // (~35 rows today) and surfaced as data.venueFields below.
      selectAll<Record<string, unknown>>(() =>
        supabase
          .from("fin_venue_fields")
          .select("fin_venue_id, mdapi_field_id")
          .order("mdapi_field_id"),
      ),
      // Phase 3b: switched from fin_members to mdapi_subscriptions.
      // Column rename + price (dollars) → price_cents shim happens in
      // the mapper below. CSV uploader still writes fin_members but
      // those rows are no longer read; deprecates in Phase 4.
      selectAll<Record<string, unknown>>(() =>
        supabase
          .from("mdapi_subscriptions")
          .select(
            "membership_id, city_member_slug, member_email, status, price, city_identifier, activation_date, canceled_at",
          )
          .order("membership_id"),
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase.from("fin_pricing").select("*").order("id"),
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase.from("fin_venue_cost_overrides").select("*").order("id"),
      ),
      // Quarter-wide mdapi pull. Feeds mdapiMemberSpots index used
      // as the denominator in the member-rev allocation helpers
      // (replaces the fin_member_spots manual aggregate). Bounds
      // come from the active quarter ± 14d buffer so cross-month
      // MTD-vs-prior comparisons resolve.
      //
      // Subs map is loaded in parallel with the other fetches and
      // chained into fetchLegacyMatchRegistrations so the join-based
      // payment-type classifier sees real-member status for every
      // FREE row before bucketing. Chaining (not awaiting separately
      // before Promise.all) preserves parallelism: the registrations
      // fetch is the longest leg, and subs adds only ~300ms on top.
      //
      // Second, targeted fetch covers the benchmark month in full
      // whenever the quarter window would clip it (see
      // benchmarkMonthFetchBounds). Rows for that month then come
      // exclusively from the targeted pull — the quarter rows are
      // partitioned out by month key first, so the overlap can't
      // double-count.
      loadMembershipWindowsByUserId(supabase).then(async (subs) => {
        const needsBenchmarkFetch = !coversBenchmarkMonth(smBounds);
        const [quarterRows, benchmarkRows] = await Promise.all([
          fetchLegacyMatchRegistrations(supabase, smBounds, subs),
          needsBenchmarkFetch
            ? fetchLegacyMatchRegistrations(
                supabase,
                benchmarkMonthFetchBounds(),
                subs,
              )
            : Promise.resolve([]),
        ]);
        if (!needsBenchmarkFetch) return quarterRows;
        const benchKey = mostRecentCompletedMonth().key;
        return [
          ...quarterRows.filter(
            (r) => isoToMonthKey(r.match_start) !== benchKey,
          ),
          ...benchmarkRows,
        ];
      }),
    ]);
  } catch (e) {
    publish(key, {
      data: null,
      loading: false,
      error: e instanceof Error ? e.message : "Failed to load finance data.",
    });
    return;
  }

  const venueAliases = new Map<string, string>();
  for (const a of alRows) {
    const alias = cleanText(a.alias);
    const canonical = cleanText(a.canonical_venue);
    if (alias && canonical) venueAliases.set(alias, canonical);
  }
  const venueFields = new Map<number, number>();
  for (const f of vfRows) {
    const fieldId = Number(f.mdapi_field_id);
    const venueId = Number(f.fin_venue_id);
    if (Number.isFinite(fieldId) && Number.isFinite(venueId)) {
      venueFields.set(fieldId, venueId);
    }
  }
  function canonVenue(v: unknown): string {
    const c = cleanText(v);
    return venueAliases.get(c) ?? c;
  }
  function canonVenueNullable(v: unknown): string | null {
    const c = cleanTextNullable(v);
    if (c === null) return null;
    return venueAliases.get(c) ?? c;
  }

  const revenue: FinRevenue[] = revenueRows.map((r) => ({
    id: r.id as number,
    date: cleanText(r.date),
    month: normalizeMonth(cleanText(r.month)),
    city: cleanText(r.city),
    venue: canonVenueNullable(r.venue),
    type: cleanText(r.type),
    gross: asNumber(r.gross),
    fees: asNumber(r.fees),
    net: asNumber(r.net),
    source: cleanText(r.source),
    notes: cleanTextNullable(r.notes),
    manual_entry: Boolean(r.manual_entry ?? false),
  }));

  // Stale PROJECTION placeholders in completed months. Harmless while
  // they sit on the "Deleted Account Revenue" pseudo-city, but
  // cityMembershipRevenueFor (the Match P&L benchmark numerator) does
  // not filter by source, so one tagged to a real city would silently
  // inflate that city's $/spot rate. Warn loudly rather than let a
  // placeholder masquerade as money.
  const staleProjections = findStaleProjectionRevenue(revenue);
  if (staleProjections.length > 0 && typeof console !== "undefined") {
    const total = staleProjections.reduce((s, r) => s + r.net, 0);
    const months = [...new Set(staleProjections.map((r) => r.month))].join(", ");
    const realCityRows = staleProjections.filter(
      (r) => r.city !== "Deleted Account Revenue",
    );
    console.warn(
      `[useFinanceData] ${staleProjections.length} PROJECTION revenue row(s) still present in completed month(s) ${months}, totalling $${total.toFixed(2)}. These are "replace with actuals" placeholders. ${
        realCityRows.length > 0
          ? `${realCityRows.length} is/are tagged to a REAL city (${[...new Set(realCityRows.map((r) => r.city))].join(", ")}) and WILL distort that city's member-spot benchmark rate.`
          : `All are on the "Deleted Account Revenue" pseudo-city, so no city benchmark is affected yet.`
      }`,
    );
  }

  const expenses: FinExpense[] = expenseRows.map((r) => ({
    id: r.id as number,
    date: cleanText(r.date),
    month: normalizeMonth(cleanText(r.month)),
    city: cleanText(r.city),
    category: cleanText(r.category),
    vendor: cleanTextNullable(r.vendor),
    amount: asNumber(r.amount),
    notes: cleanTextNullable(r.notes),
    manual_entry: Boolean(r.manual_entry ?? false),
  }));

  const managerPay: FinManagerPay[] = mpRows.map((r) => ({
    id: r.id as number,
    city: cleanText(r.city),
    month: normalizeMonth(cleanText(r.month)),
    amount: asNumber(r.amount),
  }));

  const venues: FinVenue[] = vnRows.map((r) => {
    const rawName = cleanText(r.venue_name);
    return {
      id: r.id as number,
      venue_name: venueAliases.get(rawName) ?? rawName,
      raw_venue_name: rawName,
      city: cleanText(r.city),
      billing_type: cleanText(r.billing_type) as FinVenue["billing_type"],
      hourly_rate: r.hourly_rate === null ? null : asNumber(r.hourly_rate),
      monthly_flat: r.monthly_flat === null ? null : asNumber(r.monthly_flat),
      per_match_rate:
        r.per_match_rate === null ? null : asNumber(r.per_match_rate),
      max_spots:
        r.max_spots === null ? null : Math.round(asNumber(r.max_spots)),
      dpp_price:
        r.dpp_price === null || r.dpp_price === undefined
          ? null
          : asNumber(r.dpp_price),
      member_price:
        r.member_price === null || r.member_price === undefined
          ? null
          : asNumber(r.member_price),
      cost_per_match:
        r.cost_per_match === null || r.cost_per_match === undefined
          ? null
          : asNumber(r.cost_per_match),
      notes: cleanTextNullable(r.notes),
      launch_date: cleanTextNullable(r.launch_date),
      is_active:
        r.is_active === null || r.is_active === undefined
          ? true
          : Boolean(r.is_active),
      // Default true — matches DB DEFAULT and the spec that most
      // venues bill on cancel. Explicit `false` is the only way to
      // opt out.
      charge_on_cancel:
        r.charge_on_cancel === false ? false : true,
      // Billing timing (migration 0069). Pre-migration cached rows lack
      // these keys → default to monthly / undated so nothing breaks
      // before the columns land in prod.
      billing_cadence:
        r.billing_cadence === "quarterly" ||
        r.billing_cadence === "annual" ||
        r.billing_cadence === "weekly" ||
        r.billing_cadence === "custom"
          ? r.billing_cadence
          : "monthly",
      billing_day:
        r.billing_day === null || r.billing_day === undefined
          ? null
          : Math.round(asNumber(r.billing_day)),
      billing_anchor_month:
        r.billing_anchor_month === null || r.billing_anchor_month === undefined
          ? null
          : Math.round(asNumber(r.billing_anchor_month)),
      billing_weekday:
        r.billing_weekday === null || r.billing_weekday === undefined
          ? null
          : Math.round(asNumber(r.billing_weekday)),
      billing_custom_days: parseCustomDays(r.billing_custom_days),
    };
  });

  // Alive matches (is_cancelled=false) → FinMasterSchedule via the
  // shared mdapi mapper. Same resolver as cancelledSchedule below, so
  // the two are disjoint halves of mdapi_matches.
  const smCounters = { unresolved: 0, specialEvent: 0 };
  const masterSchedule: FinMasterSchedule[] = smsRows.map((r) =>
    mapMdapiRowToSchedule(r, venueFields, venues, smCounters),
  );
  if (smCounters.unresolved > 0 && typeof console !== "undefined") {
    console.warn(
      `[useFinanceData] ${smCounters.unresolved} alive mdapi_matches row(s) in the quarter window have no resolvable venue_id — excluded from cost calc. Check fin_venue_fields links.`,
    );
  }
  if (smCounters.specialEvent > 0 && typeof console !== "undefined") {
    console.info(
      `[useFinanceData] ${smCounters.specialEvent} alive mdapi_matches row(s) excluded from cost as Soccer Central special events (max_player_count null/0).`,
    );
  }

  // Cancelled matches (is_cancelled=true) → FinMasterSchedule via the
  // shared mdapi mapper. Counted at cost time only when the resolved
  // venue's charge_on_cancel is true. Disjoint from masterSchedule
  // (alive) by construction, so no match is counted twice.
  const cmsCounters = { unresolved: 0, specialEvent: 0 };
  const cancelledSchedule: FinMasterSchedule[] = cmsRows.map((r) =>
    mapMdapiRowToSchedule(r, venueFields, venues, cmsCounters),
  );
  if (cmsCounters.unresolved > 0 && typeof console !== "undefined") {
    console.warn(
      `[useFinanceData] ${cmsCounters.unresolved} cancelled mdapi_matches row(s) in the quarter window have no resolvable venue_id — excluded from charge-on-cancel cost. Check fin_venue_fields links.`,
    );
  }
  if (cmsCounters.specialEvent > 0 && typeof console !== "undefined") {
    console.info(
      `[useFinanceData] ${cmsCounters.specialEvent} cancelled mdapi_matches row(s) excluded as Soccer Central special events (max_player_count null/0).`,
    );
  }

  const memberSpots: FinMemberSpotsRow[] = msRows.map((r) => ({
    id: r.id as number,
    venue: canonVenue(r.venue),
    city: cleanText(r.city),
    month: normalizeMonth(cleanText(r.month)),
    member_spots: Math.round(asNumber(r.member_spots) || 0),
    dpp_spots: Math.round(asNumber(r.dpp_spots) || 0),
    other_spots: Math.round(asNumber(r.other_spots) || 0),
  }));

  // Build the mdapi-derived spot index from the Q2-wide registrations
  // pull. Drives venueAllocatedMemberRevenueFor / matchAllocatedMemberRevenueFor.
  // PR-E: bucket key is fin_venues.id, resolved via field_id →
  // fin_venue_fields. Replaces the name-canonicalization path (which
  // dropped rows whose field_title didn't match any fin_venues row).
  const mdapiMemberSpots = mdapiRegRows
    ? buildMdapiMemberSpotIndex(mdapiRegRows, venues, venueFields)
    : emptyMdapiMemberSpotIndex();

  const config: Record<string, string> = {};
  for (const r of cfgRows) {
    config[cleanText(r.key)] = cleanText(r.value);
  }

  // Phase 3b mapper: mdapi_subscriptions → FinMember shape.
  //   - city_identifier (abbr) → cockpit city via cityFromAbbr; rows
  //     in unmapped cities (e.g., NYC) are skipped silently — same
  //     behavior as the reviews migration.
  //   - price (dollars) → price_cents (integer cents). Single
  //     conversion site; downstream calcs (incl. financeStats.ts:2247
  //     /100 division) keep working unchanged.
  //   - city_member_slug ("ATX13") populates member_id since the
  //     CSV-era format used the same slug shape.
  const members: FinMember[] = [];
  for (const r of mbrRows) {
    const city = cityFromAbbr(cleanTextNullable(r.city_identifier));
    if (!city) continue;
    members.push({
      id: r.membership_id as number,
      member_id: cleanText(r.city_member_slug),
      status: cleanText(r.status),
      price_cents: Math.round((asNumber(r.price) || 0) * 100),
      city,
      email: cleanTextNullable(r.member_email),
      activation_date: cleanTextNullable(r.activation_date),
      canceled_at: cleanTextNullable(r.canceled_at),
    });
  }

  const pricing: FinPricing[] = prcRows.map((r) => ({
    id: r.id as number,
    venue_name: canonVenue(r.venue_name),
    city: cleanText(r.city),
    dpp_price: asNumber(r.dpp_price),
    member_price: asNumber(r.member_price),
    notes: cleanTextNullable(r.notes),
  }));

  const overrides: FinVenueCostOverride[] = ovRows.map((r) => ({
    id: r.id as number,
    venue_id: r.venue_id as number,
    month: normalizeMonth(cleanText(r.month)),
    override_amount: asNumber(r.override_amount),
    reason: cleanTextNullable(r.reason),
    created_at: cleanText(r.created_at),
    created_by: cleanText(r.created_by),
  }));

  // Partner dashboards + pre-computed per-(venue, month) payouts.
  // Drives the profit_share branch in autoCost / venueRealizedCostFor
  // — cost for a profit_share venue/month comes from the same
  // computeWeeklyPayments calc the partner dashboard page renders,
  // so there's one source of truth instead of double-entry via
  // fin_venue_cost_overrides. Quiet failure: if the fetch errors,
  // dashboards array is empty and every profit_share venue falls
  // back to the "needs override" hint — no crash.
  let partnerDashboards: PartnerConfig[] = [];
  let partnerPayoutsByVenueMonth = new Map<string, number>();
  try {
    partnerDashboards = await fetchAllEnabledPartnerDashboards(supabase);
    if (partnerDashboards.length > 0) {
      partnerPayoutsByVenueMonth = buildPartnerPayoutsByVenueMonth(
        partnerDashboards,
        venues,
        venueFields,
        mdapiRegRows,
        revenueRows.map((r) => ({
          date: cleanText(r.date),
          type: cleanText(r.type),
          gross: asNumber(r.gross),
          source: cleanText(r.source),
          venue: cleanTextNullable(r.venue),
          notes: cleanTextNullable(r.notes),
        })),
      );
    }
  } catch (e) {
    if (typeof console !== "undefined") {
      console.warn(
        `[useFinanceData] partner-payout pre-compute failed (profit_share venues will fall back to needs-override):`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  publish(key, {
    data: {
      revenue,
      expenses,
      managerPay,
      masterSchedule,
      cancelledSchedule,
      venues,
      memberSpots,
      members,
      pricing,
      overrides,
      venueAliases,
      venueFields,
      config,
      mdapiMemberSpots,
      partnerDashboards,
      partnerPayoutsByVenueMonth,
    },
    loading: false,
    error: null,
  });
}

export function useFinanceData(): State {
  const quarter = useFinanceQuarter();
  const key = quarter.key;
  const [s, setS] = useState<State>(getCachedFor(key));

  useEffect(() => {
    let subs = subscribersByQuarter.get(key);
    if (!subs) {
      subs = new Set();
      subscribersByQuarter.set(key, subs);
    }
    subs.add(setS);

    const entry = cachedByQuarter.get(key);
    if (entry?.data) {
      setS(entry);
    } else if (!pendingByQuarter.has(key)) {
      const p = load(quarter).finally(() => {
        pendingByQuarter.delete(key);
      });
      pendingByQuarter.set(key, p);
    }

    return () => {
      subs?.delete(setS);
    };
  }, [key, quarter]);

  return s;
}

// Optimistic in-place update of one venue row across every cached quarter
// (venues aren't quarter-scoped, so the same row lives in each quarter's
// data). Unlike refetchFinanceData this never clears the cache or sets
// loading:true — it republishes the existing data with just the one row
// swapped, so subscribers re-render the touched row WITHOUT unmounting the
// table (which is what loses scroll on every inline edit). Field Costs and
// its warnings are derived downstream of data.venues, so patching here
// revalidates them in place. Callers keep the prior field value and call
// again with it to roll a failed save back. `patch` values must already be
// in hydrated form (the shape load() would produce) — for the inline-edit
// fields (prices, billing_type, charge_on_cancel, billing cadence/day/
// anchor) the raw and hydrated values are identical, so passing the value
// sent to the DB is correct.
export function patchVenueOptimistic(
  venueId: number,
  patch: Partial<FinVenue>,
): void {
  for (const [key, state] of cachedByQuarter.entries()) {
    if (!state.data) continue;
    let changed = false;
    const venues = state.data.venues.map((v) => {
      if (v.id !== venueId) return v;
      changed = true;
      return { ...v, ...patch };
    });
    if (!changed) continue;
    publish(key, { ...state, data: { ...state.data, venues }, loading: false });
  }
}

// In-place upsert/remove of one fin_venue_cost_overrides row across every
// cached quarter, so the CUSTOM cadence's inline amount edit updates the
// row (and its derived cost) without a full refetch. Overrides are keyed
// by (venue_id, month); a quarter whose window doesn't include that month
// simply won't hold the row. Publishes with data intact / loading:false
// (same scroll-preserving contract as patchVenueOptimistic).
export function patchOverrideOptimistic(
  op:
    | { type: "upsert"; row: FinVenueCostOverride }
    | { type: "remove"; venueId: number; month: string },
): void {
  for (const [key, state] of cachedByQuarter.entries()) {
    if (!state.data) continue;
    const cur = state.data.overrides;
    let next: FinVenueCostOverride[];
    if (op.type === "remove") {
      next = cur.filter(
        (o) => !(o.venue_id === op.venueId && o.month === op.month),
      );
      if (next.length === cur.length) continue;
    } else {
      const idx = cur.findIndex(
        (o) => o.venue_id === op.row.venue_id && o.month === op.row.month,
      );
      if (idx >= 0) {
        next = cur.slice();
        next[idx] = op.row;
      } else {
        next = [...cur, op.row];
      }
    }
    publish(key, { ...state, data: { ...state.data, overrides: next }, loading: false });
  }
}

// Invalidates every quarter's cache and refetches every quarter
// that currently has at least one live subscriber. Venue / config /
// commentary rows aren't quarter-scoped — a save in any view can
// change data the user is looking at in another view — so every
// open consumer needs a fresh load(), not just the calendar's
// current quarter. (Pre-Wave-4 only Q2 was selectable so this
// distinction didn't matter; with Q3 planning now in the selector
// a user editing on Q3 was getting their save persisted but their
// React state never refreshed because load(getCurrentQuarter())
// only published to Q2 subscribers.)
//
// Snapshot the active keys BEFORE clearing caches so we don't race
// with a concurrent useFinanceData useEffect-mount that might pick
// up an empty cache between clear() and load().
export async function refetchFinanceData(): Promise<void> {
  const activeKeys = [...subscribersByQuarter.entries()]
    .filter(([, subs]) => subs.size > 0)
    .map(([key]) => key);
  cachedByQuarter.clear();
  pendingByQuarter.clear();
  if (activeKeys.length === 0) {
    // No consumers mounted yet — warm the current-quarter cache so
    // the next mount has a head start.
    await load(getCurrentQuarter());
    return;
  }
  await Promise.all(
    activeKeys.map((key) => {
      const q = getQuarterByKey(key);
      return q ? load(q) : Promise.resolve();
    }),
  );
}
