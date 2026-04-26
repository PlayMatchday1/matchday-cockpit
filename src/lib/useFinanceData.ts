"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";

export type FinRevenue = {
  id: number;
  date: string;
  month: string;
  city: string;
  venue: string | null;
  type: "DPP" | "Membership" | "Private Rental";
  gross: number;
  fees: number;
  net: number;
  source: "Stripe" | "Venmo" | "PROJECTION" | "Manual";
  notes: string | null;
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

export type FinanceData = {
  revenue: FinRevenue[];
  expenses: FinExpense[];
  managerPay: FinManagerPay[];
  monthlyExpenses: FinMonthlyExpense[];
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

  const [revRes, expRes, mpRes, meRes, cfgRes] = await Promise.all([
    supabase.from("fin_revenue").select("*"),
    supabase.from("fin_expenses").select("*"),
    supabase.from("fin_manager_pay").select("*"),
    supabase.from("fin_monthly_expenses").select("*"),
    supabase.from("fin_config").select("*"),
  ]);

  for (const r of [revRes, expRes, mpRes, meRes, cfgRes]) {
    if (r.error) {
      publish({ data: null, loading: false, error: r.error.message });
      return;
    }
  }

  const revenue: FinRevenue[] = (revRes.data ?? []).map((r) => ({
    id: r.id as number,
    date: cleanText(r.date),
    month: normalizeMonth(cleanText(r.month)),
    city: cleanText(r.city),
    venue: cleanTextNullable(r.venue),
    type: cleanText(r.type) as FinRevenue["type"],
    gross: asNumber(r.gross),
    fees: asNumber(r.fees),
    net: asNumber(r.net),
    source: cleanText(r.source) as FinRevenue["source"],
    notes: cleanTextNullable(r.notes),
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

  const config: Record<string, string> = {};
  for (const r of cfgRes.data ?? []) {
    config[cleanText(r.key)] = cleanText(r.value);
  }

  publish({
    data: { revenue, expenses, managerPay, monthlyExpenses, config },
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
