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
/* THE OTHER END OF THE MONTH, EXPLICIT. start_date is a TIMESTAMP; bounding it with a bare
 * "2026-08-28" drops every match after midnight on the final day — that is the exact off-by-one
 * mdapiMatchesRead carried, where the label named a day the arithmetic excluded. */
function todayEndISO(now = new Date()): string {
  const { y, m0 } = centralParts(now);
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", day: "2-digit" }).format(now);
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${d}T23:59:59.999`;
}

export type Snapshot = {
  revenueGross: number | null;
  monthlyPlayers: number | null;
  activeMembers: number | null;
  activeFields: number | null;
  /* Fields with matches this month that have no fin_venue_fields row. Reported, never folded into
   * the count and never dropped. */
  activeFieldsUnmapped: number | null;
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

/* ACTIVE FIELDS — distinct MAPPED field ids with a match this calendar month.
 *
 * IT USED TO BE A ROLLING 30 DAYS while sitting under a header reading "Aug 2026 · month to date",
 * beside three tiles that are all month-to-date. One tile answering a different question than its
 * own header is the kind of thing nobody notices and everybody half-remembers wrong.
 *
 * FOUR DECISIONS, all deliberate:
 *   · CALENDAR MONTH, 1st to today — the same window as its neighbours.
 *   · ANY non-cancelled match, SCHEDULED OR RAN. This is "fields we are using", not "fields we
 *     billed", so tonight's fixture counts.
 *   · DISTINCT MAPPED FIELD IDS, not venues. Soccer Central's 102 / 199 / 1354 are three pitches
 *     under one venue and count as three — the presentation merge on Slate Review is a display
 *     rule for that page and has no business in a network count.
 *   · EXPLICIT T00:00:00 / T23:59:59.999 BOUNDS. See todayEndISO.
 *
 * UNMAPPED FIELDS ARE COUNTED SEPARATELY, NEVER SILENTLY DROPPED. A field with matches and no
 * fin_venue_fields row is a data gap, and quietly excluding one is how 40 Soccer Central matches
 * stayed invisible for months. The tile shows the mapped count and its tooltip names the gap.
 *
 * PAGED. The old query read one un-paged page: 992 rows this month, eight short of the 1000-row cap
 * silently truncating it. It has not bitten yet; it is one busy month from doing so. */
async function fetchActiveFields(): Promise<{ mapped: number; unmapped: number } | null> {
  try {
    const [rows, links] = await Promise.all([
      pageAll<{ field_id: number | null }>((from, to) =>
        supabase
          .from("mdapi_matches")
          .select("field_id")
          .eq("is_cancelled", false)
          .is("deleted_at", null)
          .gte("start_date", monthStartISO())
          .lte("start_date", todayEndISO())
          .range(from, to),
      ),
      pageAll<{ mdapi_field_id: number | null }>((from, to) =>
        supabase.from("fin_venue_fields").select("mdapi_field_id").range(from, to),
      ),
    ]);
    const linked = new Set<number>();
    for (const r of links) if (r.mdapi_field_id != null) linked.add(Number(r.mdapi_field_id));
    const mapped = new Set<number>();
    const unmapped = new Set<number>();
    for (const r of rows) {
      if (r.field_id == null) continue;
      const f = Number(r.field_id);
      (linked.has(f) ? mapped : unmapped).add(f);
    }
    return { mapped: mapped.size, unmapped: unmapped.size };
  } catch {
    return null;
  }
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
  return {
    revenueGross, monthlyPlayers, activeMembers,
    activeFields: activeFields?.mapped ?? null,
    activeFieldsUnmapped: activeFields?.unmapped ?? null,
    monthLabel: currentMonthLabel(),
  };
}
