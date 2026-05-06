"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { selectAll } from "./supabasePagination";
import { cityFromAbbr } from "./cityMap";
import {
  buildMdapiMemberSpotIndex,
  emptyMdapiMemberSpotIndex,
  type MdapiMemberSpotIndex,
} from "./financeStats";
import { fetchLegacyMatchRegistrations } from "./mdapiMatchesRead";

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

export type FinMonthlyExpense = {
  id: number;
  city: string;
  month: string;
  city_manager: number;
  marketing: number;
  equipment: number;
};

export type FinSchedule = {
  id: number;
  date: string;
  month: string;
  city: string;
  venue: string;       // canonical (post-alias)
  venue_raw: string;   // pre-alias — needed for per-leg accounting on
                       // split-rate venues like ATH Katy / ATH Katy Sunday
                       // where aliases collapse the canonical name.
  match_count: number;
  total_hours: number | null;
  venue_cost: number | null;
  notes: string | null;
  manual_entry: boolean;
  created_at: string | null;
  created_by: string | null;
};

export type FinVenue = {
  id: number;
  venue_name: string;       // canonical (post-alias)
  raw_venue_name: string;   // pre-alias — see FinSchedule.venue_raw note.
  city: string;
  // Billing classification.
  // - per_match / per_hour: cost auto-computed from schedule × rate.
  // - monthly_flat / lump_sum / profit_share: cost lives in
  //   fin_venue_cost_overrides per (venue, month) — no auto computation.
  // - no_charge: always $0.
  billing_type:
    | "per_hour"
    | "per_match"
    | "monthly_flat"
    | "lump_sum"
    | "profit_share"
    | "no_charge";
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

export type FinCommentary = {
  id: number;
  eyebrow: string | null;
  body: string | null;
  updated_at: string | null;
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
  monthlyExpenses: FinMonthlyExpense[];
  schedule: FinSchedule[];
  venues: FinVenue[];
  memberSpots: FinMemberSpotsRow[];
  members: FinMember[];
  pricing: FinPricing[];
  commentary: FinCommentary | null;
  overrides: FinVenueCostOverride[];
  venueAliases: Map<string, string>;
  config: Record<string, string>;
  // Member-spot counts derived from mdapi_match_players, used as the
  // denominator for the member-revenue allocation helpers in
  // financeStats.ts. Replaces fin_member_spots in active read paths;
  // see buildMdapiMemberSpotIndex for shape.
  mdapiMemberSpots: MdapiMemberSpotIndex;
};

type State = {
  data: FinanceData | null;
  loading: boolean;
  error: string | null;
};

const INITIAL: State = { data: null, loading: true, error: null };

let cached: State = INITIAL;
let pending: Promise<void> | null = null;
const subscribers = new Set<(s: State) => void>();

function publish(s: State) {
  cached = s;
  subscribers.forEach((fn) => fn(s));
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

async function load(): Promise<void> {
  publish({ data: cached.data, loading: true, error: null });

  // Multi-row reads go through selectAll() so they're not silently capped
  // at PostgREST's 1000-row max. fin_commentary is intentionally a single-
  // row read (`.limit(1).maybeSingle()`); fin_venues / fin_venue_aliases /
  // fin_pricing / fin_config / fin_venue_cost_overrides are bounded by
  // venue count and would never approach 1000, but we still paginate them
  // for uniform error handling — selectAll exits after one round-trip
  // when the table fits in a single page.
  let revenueRows: Array<Record<string, unknown>>;
  let expenseRows: Array<Record<string, unknown>>;
  let mpRows: Array<Record<string, unknown>>;
  let meRows: Array<Record<string, unknown>>;
  let cfgRows: Array<Record<string, unknown>>;
  let schRows: Array<Record<string, unknown>>;
  let vnRows: Array<Record<string, unknown>>;
  let msRows: Array<Record<string, unknown>>;
  let alRows: Array<Record<string, unknown>>;
  let mbrRows: Array<Record<string, unknown>>;
  let prcRows: Array<Record<string, unknown>>;
  let ovRows: Array<Record<string, unknown>>;
  let mdapiRegRows: Awaited<
    ReturnType<typeof fetchLegacyMatchRegistrations>
  >;
  let cmtRow: Record<string, unknown> | null;
  try {
    [
      revenueRows,
      expenseRows,
      mpRows,
      meRows,
      cfgRows,
      schRows,
      vnRows,
      msRows,
      alRows,
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
        supabase.from("fin_monthly_expenses").select("*").order("id"),
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase.from("fin_config").select("*").order("key"),
      ),
      selectAll<Record<string, unknown>>(() =>
        supabase.from("fin_schedule").select("*").order("id"),
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
      // Q2-wide mdapi pull. Feeds mdapiMemberSpots index used as the
      // denominator in the member-rev allocation helpers (replaces
      // the fin_member_spots manual aggregate). Bounds match Q2_MONTHS;
      // when the quarter rolls, update both Q2_MONTHS and these bounds.
      fetchLegacyMatchRegistrations(supabase, {
        fromDate: "2026-04-01",
        toDate: "2026-06-30",
      }),
    ]);
    const cmtRes = await supabase
      .from("fin_commentary")
      .select("*")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (cmtRes.error) throw new Error(cmtRes.error.message);
    cmtRow = (cmtRes.data ?? null) as Record<string, unknown> | null;
  } catch (e) {
    publish({
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

  const monthlyExpenses: FinMonthlyExpense[] = meRows.map((r) => ({
    id: r.id as number,
    city: cleanText(r.city),
    month: normalizeMonth(cleanText(r.month)),
    city_manager: asNumber(r.city_manager),
    marketing: asNumber(r.marketing),
    equipment: asNumber(r.equipment),
  }));

  const schedule: FinSchedule[] = schRows.map((r) => {
    const rawVenue = cleanText(r.venue);
    return {
      id: r.id as number,
      date: cleanText(r.date),
      month: normalizeMonth(cleanText(r.month)),
      city: cleanText(r.city),
      venue: venueAliases.get(rawVenue) ?? rawVenue,
      venue_raw: rawVenue,
      match_count: Math.round(asNumber(r.match_count) || 0),
      total_hours: r.total_hours === null ? null : asNumber(r.total_hours),
      venue_cost: r.venue_cost === null ? null : asNumber(r.venue_cost),
      notes: cleanTextNullable(r.notes),
      manual_entry: Boolean(r.manual_entry ?? false),
      created_at: cleanTextNullable(r.created_at),
      created_by: cleanTextNullable(r.created_by),
    };
  });

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
    };
  });

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
  const mdapiMemberSpots = mdapiRegRows
    ? buildMdapiMemberSpotIndex(mdapiRegRows, venues)
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

  const commentaryRow = cmtRow as
    | { id: number; eyebrow?: string | null; body?: string | null; updated_at?: string | null }
    | null;
  const commentary: FinCommentary | null = commentaryRow
    ? {
        id: commentaryRow.id,
        eyebrow: cleanTextNullable(commentaryRow.eyebrow),
        body: commentaryRow.body == null ? null : String(commentaryRow.body),
        updated_at: cleanTextNullable(commentaryRow.updated_at),
      }
    : null;

  const overrides: FinVenueCostOverride[] = ovRows.map((r) => ({
    id: r.id as number,
    venue_id: r.venue_id as number,
    month: normalizeMonth(cleanText(r.month)),
    override_amount: asNumber(r.override_amount),
    reason: cleanTextNullable(r.reason),
    created_at: cleanText(r.created_at),
    created_by: cleanText(r.created_by),
  }));

  publish({
    data: {
      revenue,
      expenses,
      managerPay,
      monthlyExpenses,
      schedule,
      venues,
      memberSpots,
      members,
      pricing,
      commentary,
      overrides,
      venueAliases,
      config,
      mdapiMemberSpots,
    },
    loading: false,
    error: null,
  });
}

export function useFinanceData(): State {
  const [s, setS] = useState<State>(cached);

  useEffect(() => {
    subscribers.add(setS);
    if (cached.data) {
      setS(cached);
    } else if (!pending) {
      pending = load().finally(() => {
        pending = null;
      });
    }
    return () => {
      subscribers.delete(setS);
    };
  }, []);

  return s;
}

export async function refetchFinanceData(): Promise<void> {
  await load();
}
