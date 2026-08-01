// Operating snapshot for the Home hero. Real numbers only — every function
// returns null on error so the cell is omitted rather than guessed. Each metric
// labels its own window (Home has no month picker). Ran against prod before
// shipping; see the ship report for query text + output.

import { supabase } from "@/lib/supabase";

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Current month + windows in America/Chicago (the app's business tz).
function centralParts(now = new Date()): { y: number; m0: number } {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
  }).format(now); // YYYY-MM
  const [y, m] = s.split("-").map(Number);
  return { y, m0: m - 1 };
}
export function currentMonthLabel(now = new Date()): string {
  const { y, m0 } = centralParts(now);
  return `${SHORT[m0]} ${y}`; // "Jul 2026" — matches fin_revenue.month text
}
function monthStartISO(now = new Date()): string {
  const { y, m0 } = centralParts(now);
  return `${y}-${String(m0 + 1).padStart(2, "0")}-01T00:00:00`;
}

export type Snapshot = {
  revenueGross: number | null;
  monthlyPlayers: number | null;
  activeMembers: number | null;
  activeFields: number | null;
  monthLabel: string;
};

async function pageAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await build(from, from + 999);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// Revenue — SUM(fin_revenue.gross) for the current month bucket. Basis = PAYMENT
// DATE (fin_revenue is the Stripe-charge ledger; .month is the charge month), so
// it is month-to-date as charges land. Gross (before processing fees). Not the
// match-date basis.
async function fetchRevenueGross(): Promise<number | null> {
  const { data, error } = await supabase
    .from("fin_revenue")
    .select("gross")
    .eq("month", currentMonthLabel());
  if (error) return null;
  return (data ?? []).reduce((s, r) => s + Number((r as { gross: number }).gross || 0), 0);
}

// Active members — COUNT(mdapi_subscriptions WHERE status='ACTIVE' AND price>0).
// States counted active: ACTIVE only (paid: price>0). Point-in-time (now).
async function fetchActiveMembers(): Promise<number | null> {
  const { count, error } = await supabase
    .from("mdapi_subscriptions")
    .select("membership_id", { count: "exact", head: true })
    .eq("status", "ACTIVE")
    .gt("price", 0);
  if (error) return null;
  return count ?? null;
}

// Active fields — COUNT(DISTINCT mdapi_matches.field_id) with a non-cancelled
// match in the last 30 days (start_date >= now-30d).
async function fetchActiveFields(): Promise<number | null> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("mdapi_matches")
    .select("field_id")
    .eq("is_cancelled", false)
    .gte("start_date", since);
  if (error) return null;
  const s = new Set<number>();
  for (const r of data ?? []) {
    const f = (r as { field_id: number | null }).field_id;
    if (f != null) s.add(f);
  }
  return s.size;
}

// Monthly players — COUNT(DISTINCT real player) who participated in a
// non-cancelled match this month. user_is_fake_player=false is NON-NEGOTIABLE
// (fake users carry total_amount and would inflate the count ~1/7). Month-to-
// date. Two-step (this-month match ids → their player rows) because PostgREST
// can't distinct-count across the embed.
async function fetchMonthlyPlayers(): Promise<number | null> {
  const start = monthStartISO();
  const { data: idRows, error: e1 } = await supabase
    .from("mdapi_matches")
    .select("api_id")
    .eq("is_cancelled", false)
    .gte("start_date", start);
  if (e1) return null;
  const ids = (idRows ?? []).map((r) => (r as { api_id: number }).api_id);
  if (ids.length === 0) return 0;
  try {
    const rows = await pageAll<{ user_id: number | null }>((from, to) =>
      supabase
        .from("mdapi_match_players")
        .select("user_id")
        .eq("user_is_fake_player", false)
        .eq("is_cancelled", false)
        .in("match_api_id", ids)
        .range(from, to),
    );
    const s = new Set<number>();
    for (const r of rows) if (r.user_id != null) s.add(r.user_id);
    return s.size;
  } catch {
    return null;
  }
}

export async function fetchSnapshot(): Promise<Snapshot> {
  const [revenueGross, monthlyPlayers, activeMembers, activeFields] = await Promise.all([
    fetchRevenueGross(),
    fetchMonthlyPlayers(),
    fetchActiveMembers(),
    fetchActiveFields(),
  ]);
  return { revenueGross, monthlyPlayers, activeMembers, activeFields, monthLabel: currentMonthLabel() };
}
