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
    const n = parseFloat(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
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
    date: r.date as string,
    month: r.month as string,
    city: r.city as string,
    venue: (r.venue as string | null) ?? null,
    type: r.type as FinRevenue["type"],
    gross: asNumber(r.gross),
    fees: asNumber(r.fees),
    net: asNumber(r.net),
    source: r.source as FinRevenue["source"],
    notes: (r.notes as string | null) ?? null,
  }));

  const expenses: FinExpense[] = (expRes.data ?? []).map((r) => ({
    id: r.id as number,
    date: r.date as string,
    month: r.month as string,
    city: r.city as string,
    category: r.category as string,
    vendor: (r.vendor as string | null) ?? null,
    amount: asNumber(r.amount),
    notes: (r.notes as string | null) ?? null,
  }));

  const managerPay: FinManagerPay[] = (mpRes.data ?? []).map((r) => ({
    id: r.id as number,
    city: r.city as string,
    month: r.month as string,
    amount: asNumber(r.amount),
  }));

  const monthlyExpenses: FinMonthlyExpense[] = (meRes.data ?? []).map((r) => ({
    id: r.id as number,
    city: r.city as string,
    month: r.month as string,
    city_manager: asNumber(r.city_manager),
    marketing: asNumber(r.marketing),
    equipment: asNumber(r.equipment),
  }));

  const config: Record<string, string> = {};
  for (const r of cfgRes.data ?? []) {
    config[r.key as string] = r.value as string;
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
