"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";

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
  venue: string;
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
  venue_name: string;
  city: string;
  billing_type: "per_hour" | "per_match" | "monthly_flat";
  hourly_rate: number | null;
  monthly_flat: number | null;
  per_match_rate: number | null;
  max_spots: number | null;
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

  const [
    revRes,
    expRes,
    mpRes,
    meRes,
    cfgRes,
    schRes,
    vnRes,
    msRes,
    alRes,
    mbrRes,
    prcRes,
    cmtRes,
    ovRes,
  ] = await Promise.all([
    supabase.from("fin_revenue").select("*"),
    supabase.from("fin_expenses").select("*"),
    supabase.from("fin_manager_pay").select("*"),
    supabase.from("fin_monthly_expenses").select("*"),
    supabase.from("fin_config").select("*"),
    supabase.from("fin_schedule").select("*"),
    supabase.from("fin_venues").select("*"),
    supabase.from("fin_member_spots").select("*"),
    supabase.from("fin_venue_aliases").select("*"),
    supabase.from("fin_members").select("*"),
    supabase.from("fin_pricing").select("*"),
    supabase
      .from("fin_commentary")
      .select("*")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase.from("fin_venue_cost_overrides").select("*"),
  ]);

  for (const r of [
    revRes,
    expRes,
    mpRes,
    meRes,
    cfgRes,
    schRes,
    vnRes,
    msRes,
    alRes,
    mbrRes,
    prcRes,
    cmtRes,
    ovRes,
  ]) {
    if (r.error) {
      publish({ data: null, loading: false, error: r.error.message });
      return;
    }
  }

  const venueAliases = new Map<string, string>();
  for (const a of alRes.data ?? []) {
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

  const revenue: FinRevenue[] = (revRes.data ?? []).map((r) => ({
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

  const expenses: FinExpense[] = (expRes.data ?? []).map((r) => ({
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

  const managerPay: FinManagerPay[] = (mpRes.data ?? []).map((r) => ({
    id: r.id as number,
    city: cleanText(r.city),
    month: normalizeMonth(cleanText(r.month)),
    amount: asNumber(r.amount),
  }));

  const monthlyExpenses: FinMonthlyExpense[] = (meRes.data ?? []).map((r) => ({
    id: r.id as number,
    city: cleanText(r.city),
    month: normalizeMonth(cleanText(r.month)),
    city_manager: asNumber(r.city_manager),
    marketing: asNumber(r.marketing),
    equipment: asNumber(r.equipment),
  }));

  const schedule: FinSchedule[] = (schRes.data ?? []).map((r) => ({
    id: r.id as number,
    date: cleanText(r.date),
    month: normalizeMonth(cleanText(r.month)),
    city: cleanText(r.city),
    venue: canonVenue(r.venue),
    match_count: Math.round(asNumber(r.match_count) || 0),
    total_hours: r.total_hours === null ? null : asNumber(r.total_hours),
    venue_cost: r.venue_cost === null ? null : asNumber(r.venue_cost),
    notes: cleanTextNullable(r.notes),
    manual_entry: Boolean(r.manual_entry ?? false),
    created_at: cleanTextNullable(r.created_at),
    created_by: cleanTextNullable(r.created_by),
  }));

  const venues: FinVenue[] = (vnRes.data ?? []).map((r) => ({
    id: r.id as number,
    venue_name: canonVenue(r.venue_name),
    city: cleanText(r.city),
    billing_type: cleanText(r.billing_type) as FinVenue["billing_type"],
    hourly_rate: r.hourly_rate === null ? null : asNumber(r.hourly_rate),
    monthly_flat: r.monthly_flat === null ? null : asNumber(r.monthly_flat),
    per_match_rate:
      r.per_match_rate === null ? null : asNumber(r.per_match_rate),
    max_spots: r.max_spots === null ? null : Math.round(asNumber(r.max_spots)),
    notes: cleanTextNullable(r.notes),
    launch_date: cleanTextNullable(r.launch_date),
    is_active:
      r.is_active === null || r.is_active === undefined
        ? true
        : Boolean(r.is_active),
  }));

  const memberSpots: FinMemberSpotsRow[] = (msRes.data ?? []).map((r) => ({
    id: r.id as number,
    venue: canonVenue(r.venue),
    city: cleanText(r.city),
    month: normalizeMonth(cleanText(r.month)),
    member_spots: Math.round(asNumber(r.member_spots) || 0),
    dpp_spots: Math.round(asNumber(r.dpp_spots) || 0),
    other_spots: Math.round(asNumber(r.other_spots) || 0),
  }));

  const config: Record<string, string> = {};
  for (const r of cfgRes.data ?? []) {
    config[cleanText(r.key)] = cleanText(r.value);
  }

  const members: FinMember[] = (mbrRes.data ?? []).map((r) => ({
    id: r.id as number,
    member_id: cleanText(r.member_id),
    status: cleanText(r.status),
    price_cents: Math.round(asNumber(r.price_cents) || 0),
    city: cleanText(r.city),
    email: cleanTextNullable(r.email),
  }));

  const pricing: FinPricing[] = (prcRes.data ?? []).map((r) => ({
    id: r.id as number,
    venue_name: canonVenue(r.venue_name),
    city: cleanText(r.city),
    dpp_price: asNumber(r.dpp_price),
    member_price: asNumber(r.member_price),
    notes: cleanTextNullable(r.notes),
  }));

  const commentaryRow = cmtRes.data as
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

  const overrides: FinVenueCostOverride[] = (ovRes.data ?? []).map((r) => ({
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
