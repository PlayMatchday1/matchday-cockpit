// Manager year report — one manager, one year, DERIVED ENTIRELY from a single
// array of that manager's matches plus a single array of their adjustments. Every
// tile, every location row, every week total and the grand total fall out of
// those two arrays; nothing is stored twice or passed in pre-summed. That is why
// the report cannot contradict itself.
//
// The per-match pay rule is MIRRORED from managerPayCompute.ts (payAmount /
// orphan / co-managed). Verify assertion (d) cross-checks the year total against
// what /api/manager-pay/week reports for the same manager summed over the year —
// if the mirror ever drifts, (d) fails and the report does not ship.
//
// Boundaries that bite:
//   • Rows are keyed by MATCH DATE (venue-local), not pay date.
//   • The year boundary is CENTRAL TIME. mdapi_matches.start_date is the venue's
//     wall clock stored with a misleading Z, so its date component IS the Central
//     date — a 7pm Dec 31 Austin match reads 2026-12-31 and belongs to 2026, even
//     though start_date_utc is 2027-01-01T01:00Z. We key on start_date, never utc.

import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "@/lib/supabasePagination";
import { cityFromAbbr } from "@/lib/cityMap";
import { TOURNAMENT_THRESHOLD, addDays, weekdayUtc } from "@/lib/managerPayCompute";
import { payRunDate, estimatedArrival } from "@/lib/bankingDays";

const MATCH_COLS =
  "api_id, city_identifier, field_title, start_date, start_date_utc, is_cancelled, manager_id, manager_email, manager_first_name, manager_last_name, second_manager_id, max_player_count, player_count, fake_player_count, registration_price, name, raw";
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type ApiRaw = Record<string, unknown> & { secondManager?: { id?: number; email?: string | null; firstName?: string | null; lastName?: string | null } | null };
type MatchRow = {
  api_id: number; city_identifier: string | null; field_title: string | null;
  start_date: string | null; start_date_utc: string | null; is_cancelled: boolean | null;
  manager_id: number | null; manager_email: string | null; manager_first_name: string | null; manager_last_name: string | null;
  second_manager_id: number | null; max_player_count: number | null; player_count: number | null;
  fake_player_count: number | null; registration_price: number | null; name: string | null; raw: ApiRaw | null;
};
type UserRow = { id: number; email: string; first_name: string | null; last_name: string | null };

// ── pure helpers MIRRORED from managerPayCompute.ts (kept identical; (d) verifies) ──
function venueDate(localIso: string | null): string | null {
  if (!localIso) return null;
  const d = new Date(localIso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function venueTime(localIso: string | null): string {
  if (!localIso) return "";
  const d = new Date(localIso);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getUTCHours();
  return `${((h + 11) % 12) + 1}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
function displayName(first: string | null | undefined, last: string | null | undefined, fallback: string | null): string | null {
  const parts = [first, last].filter((s): s is string => !!s && s.trim() !== "");
  return parts.length ? parts.join(" ") : fallback;
}
function payAmount(maxPlayerCount: number | null, coManaged: boolean): number {
  if (coManaged) return 20;
  if (maxPlayerCount != null && maxPlayerCount >= TOURNAMENT_THRESHOLD) return 30;
  return 20;
}
function isCoManaged(m: MatchRow): boolean {
  if (m.second_manager_id != null) return true;
  const sm = m.raw?.secondManager;
  return !!(sm && typeof sm === "object" && (sm.id || sm.email));
}
function isOrphanedMatch(m: MatchRow, now: Date): boolean {
  if (m.is_cancelled) return false;
  const real = (m.player_count ?? 0) - (m.fake_player_count ?? 0);
  if (real > 0) return false;
  if (!m.start_date_utc) return false;
  const t = Date.parse(m.start_date_utc);
  return !Number.isNaN(t) && t < now.getTime();
}
function secondEmail(m: MatchRow, byId: Map<number, UserRow>): string | null {
  if (m.second_manager_id) { const u = byId.get(m.second_manager_id); if (u?.email) return u.email; }
  const sm = m.raw?.secondManager;
  return sm && typeof sm === "object" && sm.email ? sm.email : null;
}
function secondName(m: MatchRow, byId: Map<number, UserRow>): string | null {
  if (m.second_manager_id) { const u = byId.get(m.second_manager_id); if (u) return displayName(u.first_name, u.last_name, u.email ?? null); }
  const sm = m.raw?.secondManager;
  return sm && typeof sm === "object" && sm.email ? displayName(sm.firstName, sm.lastName, sm.email) : null;
}

// An event ("MatchDay Winter Tournament") that renders in the Field dimension —
// listed like a field but flagged so it can be reported separately.
function looksLikeEvent(field: string): boolean {
  return /\b(tournament|championship|cup|winter series|summer series|finals?)\b/i.test(field) && /matchday|series|championship/i.test(field);
}

const monday = (iso: string) => addDays(iso, weekdayUtc(iso) === 0 ? -6 : -(weekdayUtc(iso) - 1));

export type YearMatch = {
  matchDate: string; dateLabel: string; time: string; field: string; city: string;
  pay: number; twoManager: boolean; cancelled: boolean; weekStart: string; isEvent: boolean;
};
export type YearAdjustment = { date: string; weekStart: string; amount: number; reason: string };
export type YearWeek = {
  weekStart: string; weekEnd: string; rangeLabel: string; payRun: string | null; arrival: string | null;
  total: number; matches: YearMatch[]; adjustments: YearAdjustment[];
};
export type YearReport = {
  year: number; managerEmail: string; managerName: string;
  rawSpellings: string[]; collapsedCount: number; unresolved: string[];
  worked: number; cancelled: number; matchPay: number; adjustmentsTotal: number; grand: number;
  fieldCount: number; cityCount: number; weeksWorked: number; weeksElapsed: number;
  fields: { field: string; city: string; matches: number; pay: number; isEvent: boolean }[];
  cities: { city: string; matches: number; pay: number }[];
  weeks: YearWeek[]; rows: YearMatch[]; adjustments: YearAdjustment[]; events: string[];
  generatedAt: string;
};

export type ManagerOption = { email: string; name: string };

async function usersById(sb: SupabaseClient, ids: number[]): Promise<Map<number, UserRow>> {
  const map = new Map<number, UserRow>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data } = await sb.from("mdapi_users").select("id, email, first_name, last_name").in("id", chunk);
    for (const u of (data ?? []) as UserRow[]) map.set(u.id, u);
  }
  return map;
}

// The manager select — every distinct manager (primary or second) with matches in
// the year, resolved to one display name via the Gusto alias when present.
export async function listYearManagers(sb: SupabaseClient, year: number): Promise<ManagerOption[]> {
  const from = `${year}-01-01T00:00:00`, to = `${year + 1}-01-01T00:00:00`;
  const rows = await selectAll<MatchRow>(() =>
    sb.from("mdapi_matches").select(MATCH_COLS).is("deleted_at", null).gte("start_date", from).lt("start_date", to).order("api_id"),
  );
  const secondIds = [...new Set(rows.map((m) => m.second_manager_id).filter((x): x is number => x != null))];
  const byId = await usersById(sb, secondIds);
  const names = new Map<string, string>(); // lower(email) → best raw display name
  for (const m of rows) {
    if (m.manager_email) { const n = displayName(m.manager_first_name, m.manager_last_name, m.manager_email); if (n) names.set(m.manager_email.toLowerCase(), n); }
    const se = secondEmail(m, byId); if (se) { const sn = secondName(m, byId) ?? se; names.set(se.toLowerCase(), sn); }
  }
  const aliasName = await gustoNames(sb, [...names.keys()]);
  return [...names.entries()]
    .map(([email, raw]) => ({ email, name: aliasName.get(email) ?? raw }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function gustoNames(sb: SupabaseClient, emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!emails.length) return out;
  const { data } = await sb.from("manager_gusto_aliases").select("manager_email, gusto_first_name, gusto_last_name");
  for (const a of (data ?? []) as { manager_email: string; gusto_first_name: string; gusto_last_name: string }[])
    out.set(a.manager_email.toLowerCase(), `${a.gusto_first_name} ${a.gusto_last_name}`.trim());
  return out;
}

export async function buildYearReport(sb: SupabaseClient, managerEmail: string, year: number, now: Date): Promise<YearReport> {
  const email = managerEmail.toLowerCase();
  const from = `${year}-01-01T00:00:00`, to = `${year + 1}-01-01T00:00:00`;

  // The target's mdapi_users ids, so second-manager matches are found too.
  const { data: uData } = await sb.from("mdapi_users").select("id").ilike("email", email);
  const myIds = ((uData ?? []) as { id: number }[]).map((u) => u.id);

  const orParts = [`manager_email.ilike.${email}`];
  if (myIds.length) orParts.push(`second_manager_id.in.(${myIds.join(",")})`);
  const all = await selectAll<MatchRow>(() =>
    sb.from("mdapi_matches").select(MATCH_COLS).is("deleted_at", null).gte("start_date", from).lt("start_date", to).or(orParts.join(",")).order("start_date"),
  );
  const secondIds = [...new Set(all.map((m) => m.second_manager_id).filter((x): x is number => x != null))];
  const byId = await usersById(sb, secondIds);

  // Keep only matches this manager is actually on (primary email, or resolved second).
  const mine = all.filter((m) => (m.manager_email?.toLowerCase() === email) || (secondEmail(m, byId)?.toLowerCase() === email));

  const rawSpellings = [...new Set(mine.filter((m) => m.manager_email?.toLowerCase() === email).map((m) => displayName(m.manager_first_name, m.manager_last_name, null)).filter((x): x is string => !!x))];
  const aliasName = (await gustoNames(sb, [email])).get(email);
  const managerName = aliasName ?? rawSpellings[0] ?? email;
  const unresolved = mine.filter((m) => !m.manager_email && !secondEmail(m, byId)).map((m) => `${m.field_title ?? "?"} ${venueDate(m.start_date) ?? "?"}`);

  // ── derive the row list (worked + cancelled; orphans dropped) ──
  const rows: YearMatch[] = [];
  const events = new Set<string>();
  for (const m of mine) {
    const md = venueDate(m.start_date);
    if (!md) continue;
    const cancelled = !!m.is_cancelled;
    if (!cancelled && isOrphanedMatch(m, now)) continue; // never really ran
    const coManaged = isCoManaged(m);
    const field = m.field_title ?? "(no field)";
    const isEvent = looksLikeEvent(field);
    if (isEvent) events.add(field);
    rows.push({
      matchDate: md,
      dateLabel: `${WD[weekdayUtc(md)]} ${MO[+md.slice(5, 7) - 1]} ${+md.slice(8, 10)}`,
      time: venueTime(m.start_date), field, city: cityFromAbbr(m.city_identifier) ?? m.city_identifier ?? "Unknown",
      pay: cancelled ? 0 : payAmount(m.max_player_count, coManaged),
      twoManager: coManaged, cancelled, weekStart: monday(md), isEvent,
    });
  }
  rows.sort((a, b) => a.matchDate.localeCompare(b.matchDate) || a.time.localeCompare(b.time));

  // ── adjustments (money, no field) ──
  const { data: adjData } = await sb.from("manager_pay_adjustments").select("week_start, amount, notes").ilike("manager_email", email).gte("week_start", `${year}-01-01`).lt("week_start", `${year + 1}-01-01`);
  const adjustments: YearAdjustment[] = ((adjData ?? []) as { week_start: string; amount: number | string; notes: string | null }[])
    .map((a) => ({ date: a.week_start, weekStart: monday(a.week_start), amount: typeof a.amount === "number" ? a.amount : Number(a.amount) || 0, reason: a.notes ?? "Adjustment" }))
    .filter((a) => a.amount !== 0);

  const worked = rows.filter((r) => !r.cancelled);
  const cancelled = rows.filter((r) => r.cancelled);
  const matchPay = worked.reduce((s, r) => s + r.pay, 0);
  const adjustmentsTotal = adjustments.reduce((s, a) => s + a.amount, 0);
  const grand = matchPay + adjustmentsTotal;

  // ── per-field / per-city (worked only; adjustments carry no field) ──
  const fMap = new Map<string, { field: string; city: string; matches: number; pay: number; isEvent: boolean }>();
  for (const r of worked) {
    const g = fMap.get(r.field) ?? { field: r.field, city: r.city, matches: 0, pay: 0, isEvent: r.isEvent };
    g.matches++; g.pay += r.pay; fMap.set(r.field, g);
  }
  const fields = [...fMap.values()].sort((a, b) => b.matches - a.matches || b.pay - a.pay);
  const cMap = new Map<string, { city: string; matches: number; pay: number }>();
  for (const f of fields) { const g = cMap.get(f.city) ?? { city: f.city, matches: 0, pay: 0 }; g.matches += f.matches; g.pay += f.pay; cMap.set(f.city, g); }
  const cities = [...cMap.values()].sort((a, b) => b.matches - a.matches);

  // ── weeks (only weeks with a match or adjustment; newest first) ──
  const wMap = new Map<string, YearWeek>();
  const ensure = (ws: string): YearWeek => {
    let w = wMap.get(ws);
    if (!w) {
      const end = addDays(ws, 6);
      let payRun: string | null = null, arrival: string | null = null;
      try { payRun = payRunDate(addDays(ws, 6)); arrival = estimatedArrival(addDays(ws, 6)); } catch { /* uncovered year → show — */ }
      w = { weekStart: ws, weekEnd: end, rangeLabel: `${MO[+ws.slice(5, 7) - 1]} ${+ws.slice(8, 10)} – ${MO[+end.slice(5, 7) - 1]} ${+end.slice(8, 10)}, ${end.slice(0, 4)}`, payRun, arrival, total: 0, matches: [], adjustments: [] };
      wMap.set(ws, w);
    }
    return w;
  };
  for (const r of rows) ensure(r.weekStart).matches.push(r);
  for (const a of adjustments) ensure(a.weekStart).adjustments.push(a);
  for (const w of wMap.values()) w.total = w.matches.filter((m) => !m.cancelled).reduce((s, m) => s + m.pay, 0) + w.adjustments.reduce((s, a) => s + a.amount, 0);
  const weeks = [...wMap.values()].sort((a, b) => b.weekStart.localeCompare(a.weekStart));

  // weeks elapsed this year (first Monday on/after Jan 1 → today or year-end)
  let firstMon = `${year}-01-01`; firstMon = monday(firstMon) < `${year}-01-01` ? addDays(monday(firstMon), 7) : monday(firstMon);
  const thisYear = now.getUTCFullYear();
  const endRef = year < thisYear ? `${year}-12-31` : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  const weeksElapsed = year > thisYear ? 0 : Math.max(0, Math.floor((Date.parse(`${endRef}T12:00:00Z`) - Date.parse(`${firstMon}T12:00:00Z`)) / 6048e5) + 1);

  return {
    year, managerEmail: email, managerName, rawSpellings, collapsedCount: Math.max(0, rawSpellings.length - 1), unresolved,
    worked: worked.length, cancelled: cancelled.length, matchPay, adjustmentsTotal, grand,
    fieldCount: fields.length, cityCount: cities.length, weeksWorked: weeks.length, weeksElapsed,
    fields, cities, weeks, rows, adjustments, events: [...events],
    generatedAt: `${MO[now.getUTCMonth()]} ${now.getUTCDate()}, ${now.getUTCFullYear()}`,
  };
}
