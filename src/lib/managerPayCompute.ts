// Shared compute helper for Match Manager Pay.
//
// Reads mdapi_matches (synced from the MatchDay platform API) +
// mdapi_users (for second-manager name/email lookup) +
// manager_pay_adjustments (cockpit-managed Additional Pay rows). No
// external API calls.
//
// Pay rules (revised 2026-05-11):
//   - Solo match, maxPlayerCount < 25 → primary earns $20
//   - Solo tournament, maxPlayerCount ≥ 25 → primary earns $30
//   - Co-managed (two managers assigned) → primary $20, secondary $20.
//     Tournament premium does NOT apply when co-managed.
//   - Cancelled matches do NOT pay (excluded from totals) but are
//     still returned in the schedule with isCancelled=true so the
//     calendar can render them struck through.
//   - Orphan matches (past-start, not cancelled, 0 real + 0 fake
//     players) are dropped entirely — see isOrphanedMatch().
//   - Pay date = Thursday after the work week ends (Sunday + 4 days).
//
// Two callers:
//   - GET /api/manager-pay/week — admin/public view of one week.
//   - The /api/sync/cron recompute step — rolls per-(city, payDate)
//     totals into fin_expenses for the Finance Manager Pay grid.
//
// `isAdmin` only affects whether manager emails are populated in the
// returned payload. The cron path passes isAdmin=true since it's
// recording server-side; it then reads city.total (a number) and
// discards the email fields.

import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "@/lib/supabasePagination";
import { cityFromAbbr } from "@/lib/cityMap";

// ============================================================
// Types — wire-compatible with the legacy route response.
// ============================================================

export type MatchSummary = {
  matchId: number;
  cityIdentifier: string | null;
  fieldTitle: string | null;
  startDate: string;
  centralDate: string;
  centralWeekday: string;
  centralTime: string;
  name: string | null;
  maxPlayerCount: number | null;
  playerCount: number | null;
  registrationPrice: number | null;
  isCancelled: boolean;
  primaryManagerName: string | null;
  primaryManagerEmail: string | null; // null in public response
  secondManagerName: string | null;
  secondManagerEmail: string | null; // null in public response
  payPerManager: number; // 0 if cancelled
};

export type ManagerMatch = {
  matchId: number;
  cityIdentifier: string | null;
  fieldTitle: string | null;
  startDate: string;
  centralDate: string;
  centralWeekday: string;
  centralTime: string;
  name: string | null;
  maxPlayerCount: number | null;
  payAmount: number;
  role: "primary" | "secondary";
  coManaged: boolean;
};

export type ManagerRow = {
  managerEmail: string | null; // null in public response
  managerName: string;
  managerId: number | null;
  cityIdentifier: string | null;
  matches: ManagerMatch[];
  matchCount: number;
  baseTotal: number;
  adjustment: number;
  adjustmentNotes: string | null;
  total: number;
};

export type CitySection = {
  cityIdentifier: string;
  managers: ManagerRow[];
  matches: MatchSummary[];
  matchCount: number;
  baseTotal: number;
  adjustment: number;
  total: number;
};

export type ManagerPayWeekPayload = {
  weekStart: string;
  weekEnd: string;
  payDate: string;
  computedAt: string;
  isAdmin: boolean;
  cities: CitySection[];
  network: {
    matchCount: number;
    managerCount: number;
    baseTotal: number;
    adjustment: number;
    total: number;
  };
};

// ============================================================
// Pure helpers + constants.
// ============================================================

export const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
export const TOURNAMENT_THRESHOLD = 25;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// mdapi_matches.start_date is the VENUE'S local wall-clock time
// stored with a misleading "+00:00" / "Z" suffix (the upstream API
// packages localDate as if it were UTC). Running it through a real
// timezone converter would subtract the offset and produce wrong
// numbers (e.g. an 18:00 CT match → 13:00 CT after a CT conversion).
// We just read the wall-clock components directly.
function venueDate(localIso: string): string | null {
  const d = new Date(localIso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function venueTime(localIso: string): string | null {
  const d = new Date(localIso);
  if (Number.isNaN(d.getTime())) return null;
  const h24 = d.getUTCHours();
  const min = d.getUTCMinutes();
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

export function weekdayUtc(yyyyMmDd: string): number {
  return new Date(`${yyyyMmDd}T00:00:00.000Z`).getUTCDay();
}

export function addDays(yyyyMmDd: string, n: number): string {
  const d = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function payDateForWeek(weekStart: string): string {
  return addDays(weekStart, 10);
}

// Returns the Monday work-week start for a given pay-date Thursday.
// Inverse of payDateForWeek — used by the recompute cron which walks
// pay-date Thursdays and needs the corresponding work week.
export function workWeekStartForPayDate(payDate: string): string {
  return addDays(payDate, -10);
}

function payAmount(
  maxPlayerCount: number | null,
  coManaged: boolean,
): number {
  if (coManaged) return 20;
  if (maxPlayerCount != null && maxPlayerCount >= TOURNAMENT_THRESHOLD)
    return 30;
  return 20;
}

function displayName(
  first: string | null | undefined,
  last: string | null | undefined,
  emailFallback: string | null,
): string | null {
  const parts = [first, last].filter((s): s is string => !!s && s.trim() !== "");
  if (parts.length > 0) return parts.join(" ");
  return emailFallback;
}

// ============================================================
// DB row shapes (private)
// ============================================================

type ApiMatchRaw = Record<string, unknown> & {
  secondManager?: {
    id?: number;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  } | null;
};

type MatchRow = {
  api_id: number;
  city_identifier: string | null;
  field_title: string | null;
  start_date: string | null;
  start_date_utc: string | null;
  is_cancelled: boolean | null;
  manager_id: number | null;
  manager_email: string | null;
  manager_first_name: string | null;
  manager_last_name: string | null;
  second_manager_id: number | null;
  max_player_count: number | null;
  player_count: number | null;
  fake_player_count: number | null;
  registration_price: number | null;
  name: string | null;
  raw: ApiMatchRaw | null;
};

type UserRow = {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
};

type AdjustmentRow = {
  manager_email: string;
  amount: number | string;
  notes: string | null;
};

// Orphan: a past-start match with zero REAL attendance. mdapi
// keeps these rows with is_cancelled=false (host created the slot,
// no one showed up, host either deleted the player list or it
// auto-filled with synthetic placeholders), so the pay calc would
// otherwise credit the manager for a match that didn't really run.
//
// Real-player gate: a match counts as "ran" iff
//   real_player_count = player_count − fake_player_count > 0
// Mixed (some real + some fake) still pays — real players showed
// up, the manager ran a real match, the fake fills don't dock it.
// Only zero-real (whether 0/0 or 0/N) triggers the orphan skip.
//
// Future matches with 0 real are kept (the past-start check below
// short-circuits) — they may still fill before kickoff. Cancelled
// matches fall through a separate branch with payPerManager=0.
function isOrphanedMatch(m: MatchRow, now: Date): boolean {
  if (m.is_cancelled) return false;
  const realPlayerCount =
    (m.player_count ?? 0) - (m.fake_player_count ?? 0);
  if (realPlayerCount > 0) return false;
  if (!m.start_date_utc) return false;
  const startMs = Date.parse(m.start_date_utc);
  if (Number.isNaN(startMs)) return false;
  return startMs < now.getTime();
}

// ============================================================
// Main compute — accepts a supabase client (service role or session)
// and a Monday work-week start.
// ============================================================

export type ComputeOpts = {
  isAdmin?: boolean;
};

export async function computeManagerPayForWeek(
  supabase: SupabaseClient,
  weekStart: string,
  opts: ComputeOpts = {},
): Promise<ManagerPayWeekPayload> {
  if (!ISO_DATE_RX.test(weekStart)) {
    throw new Error(`computeManagerPayForWeek: weekStart must be YYYY-MM-DD, got ${weekStart}`);
  }
  if (weekdayUtc(weekStart) !== 1) {
    throw new Error(`computeManagerPayForWeek: weekStart must be a Monday, got ${weekStart}`);
  }

  const isAdmin = opts.isAdmin ?? false;
  const weekEnd = addDays(weekStart, 6);
  const payDate = payDateForWeek(weekStart);

  const queryFrom = `${addDays(weekStart, -1)}T00:00:00Z`;
  const queryTo = `${addDays(weekEnd, 2)}T00:00:00Z`;

  const rawMatches = await selectAll<MatchRow>(() =>
    supabase
      .from("mdapi_matches")
      .select(
        "api_id, city_identifier, field_title, start_date, start_date_utc, is_cancelled, manager_id, manager_email, manager_first_name, manager_last_name, second_manager_id, max_player_count, player_count, fake_player_count, registration_price, name, raw",
      )
      .gte("start_date", queryFrom)
      .lt("start_date", queryTo)
      .order("api_id"),
  );

  const now = new Date();
  const matches = rawMatches.filter((m) => !isOrphanedMatch(m, now));

  const inWeek = matches.filter((m) => {
    if (!m.start_date) return false;
    const ct = venueDate(m.start_date);
    if (!ct) return false;
    return ct >= weekStart && ct <= weekEnd;
  });

  const secondIds = new Set<number>();
  for (const m of inWeek) {
    if (m.second_manager_id) secondIds.add(m.second_manager_id);
  }

  const secondById = new Map<number, UserRow>();
  if (secondIds.size > 0) {
    const ids = Array.from(secondIds);
    const { data, error } = await supabase
      .from("mdapi_users")
      .select("id, email, first_name, last_name")
      .in("id", ids);
    if (error) {
      throw new Error(`mdapi_users lookup failed: ${error.message}`);
    }
    for (const row of (data ?? []) as UserRow[]) {
      secondById.set(row.id, row);
    }
  }

  const { data: adjData, error: adjErr } = await supabase
    .from("manager_pay_adjustments")
    .select("manager_email, amount, notes")
    .eq("week_start", weekStart);
  if (adjErr) {
    throw new Error(`manager_pay_adjustments read failed: ${adjErr.message}`);
  }
  const adjByEmail = new Map<string, { amount: number; notes: string | null }>();
  for (const row of (adjData ?? []) as AdjustmentRow[]) {
    const key = row.manager_email.toLowerCase();
    const amt =
      typeof row.amount === "number" ? row.amount : Number(row.amount) || 0;
    adjByEmail.set(key, { amount: amt, notes: row.notes });
  }

  function resolveSecond(m: MatchRow): { email: string | null; name: string | null } {
    if (!m.second_manager_id) return { email: null, name: null };
    const u = secondById.get(m.second_manager_id);
    if (u) {
      return {
        email: u.email ?? null,
        name: displayName(u.first_name, u.last_name, u.email ?? null),
      };
    }
    const sm = m.raw?.secondManager;
    if (sm && typeof sm === "object" && sm.email) {
      return {
        email: sm.email,
        name: displayName(sm.firstName, sm.lastName, sm.email),
      };
    }
    return { email: null, name: null };
  }

  function isCoManaged(m: MatchRow): boolean {
    if (m.second_manager_id != null) return true;
    const sm = m.raw?.secondManager;
    return !!(sm && typeof sm === "object" && (sm.id || sm.email));
  }

  const matchSummaries: MatchSummary[] = inWeek.map((m) => {
    const ct = venueDate(m.start_date ?? "") ?? weekStart;
    const cTime = m.start_date ? venueTime(m.start_date) ?? "" : "";
    const second = resolveSecond(m);
    const primaryName = displayName(
      m.manager_first_name,
      m.manager_last_name,
      m.manager_email ?? null,
    );
    const coManaged = isCoManaged(m);
    return {
      matchId: m.api_id,
      cityIdentifier: m.city_identifier,
      fieldTitle: m.field_title,
      startDate: m.start_date ?? "",
      centralDate: ct,
      centralWeekday: WEEKDAY_NAMES[weekdayUtc(ct)],
      centralTime: cTime,
      name: m.name,
      maxPlayerCount: m.max_player_count,
      playerCount: m.player_count,
      registrationPrice: m.registration_price,
      isCancelled: !!m.is_cancelled,
      primaryManagerName: primaryName,
      primaryManagerEmail: isAdmin ? (m.manager_email ?? null) : null,
      secondManagerName: second.name,
      secondManagerEmail: isAdmin ? second.email : null,
      payPerManager: m.is_cancelled
        ? 0
        : payAmount(m.max_player_count, coManaged),
    };
  });

  type ManagerAcc = {
    managerEmail: string;
    managerName: string;
    managerId: number | null;
    cityCounts: Map<string, number>;
    matches: ManagerMatch[];
  };
  const accByEmail = new Map<string, ManagerAcc>();

  function addAssignment(
    email: string | null | undefined,
    name: string,
    id: number | null,
    role: "primary" | "secondary",
    m: MatchRow,
    coManaged: boolean,
  ) {
    if (!email) return;
    const key = email.toLowerCase();
    let acc = accByEmail.get(key);
    if (!acc) {
      acc = {
        managerEmail: email,
        managerName: name,
        managerId: id,
        cityCounts: new Map(),
        matches: [],
      };
      accByEmail.set(key, acc);
    } else {
      if (!acc.managerName || acc.managerName === acc.managerEmail) {
        acc.managerName = name;
      }
      if (acc.managerId == null && id != null) acc.managerId = id;
    }
    const ct = venueDate(m.start_date ?? "") ?? weekStart;
    const cTime = m.start_date ? venueTime(m.start_date) ?? "" : "";
    acc.matches.push({
      matchId: m.api_id,
      cityIdentifier: m.city_identifier,
      fieldTitle: m.field_title,
      startDate: m.start_date ?? "",
      centralDate: ct,
      centralWeekday: WEEKDAY_NAMES[weekdayUtc(ct)],
      centralTime: cTime,
      name: m.name,
      maxPlayerCount: m.max_player_count,
      payAmount: payAmount(m.max_player_count, coManaged),
      role,
      coManaged,
    });
    const city = m.city_identifier ?? "Unknown";
    acc.cityCounts.set(city, (acc.cityCounts.get(city) ?? 0) + 1);
  }

  for (const m of inWeek) {
    if (m.is_cancelled) continue;
    const coManaged = isCoManaged(m);
    if (m.manager_email) {
      addAssignment(
        m.manager_email,
        displayName(m.manager_first_name, m.manager_last_name, m.manager_email) ??
          m.manager_email,
        m.manager_id,
        "primary",
        m,
        coManaged,
      );
    }
    if (m.second_manager_id) {
      const second = resolveSecond(m);
      if (second.email) {
        addAssignment(
          second.email,
          second.name ?? second.email,
          m.second_manager_id,
          "secondary",
          m,
          coManaged,
        );
      }
    }
  }

  const managerRows: ManagerRow[] = [];
  for (const acc of accByEmail.values()) {
    let dominantCity: string | null = null;
    let dominantCount = -1;
    for (const [city, count] of acc.cityCounts) {
      if (count > dominantCount) {
        dominantCity = city;
        dominantCount = count;
      }
    }
    const baseTotal = acc.matches.reduce((s, m) => s + m.payAmount, 0);
    const adj = adjByEmail.get(acc.managerEmail.toLowerCase());
    managerRows.push({
      managerEmail: isAdmin ? acc.managerEmail : null,
      managerName: acc.managerName,
      managerId: acc.managerId,
      cityIdentifier: dominantCity,
      matches: acc.matches.sort((a, b) =>
        a.startDate.localeCompare(b.startDate),
      ),
      matchCount: acc.matches.length,
      baseTotal,
      adjustment: adj?.amount ?? 0,
      adjustmentNotes: adj?.notes ?? null,
      total: baseTotal + (adj?.amount ?? 0),
    });
  }

  const allCityKeys = new Set<string>();
  for (const m of matchSummaries) allCityKeys.add(m.cityIdentifier ?? "Unknown");
  for (const r of managerRows) allCityKeys.add(r.cityIdentifier ?? "Unknown");

  const cities: CitySection[] = Array.from(allCityKeys)
    .sort((a, b) => a.localeCompare(b))
    .map((cityKey) => {
      const managers = managerRows
        .filter((r) => (r.cityIdentifier ?? "Unknown") === cityKey)
        .sort((a, b) => a.managerName.localeCompare(b.managerName));
      const cityMatches = matchSummaries
        .filter((m) => (m.cityIdentifier ?? "Unknown") === cityKey)
        .sort((a, b) => a.startDate.localeCompare(b.startDate));
      const matchCount = managers.reduce((s, m) => s + m.matchCount, 0);
      const baseTotal = managers.reduce((s, m) => s + m.baseTotal, 0);
      const adjustment = managers.reduce((s, m) => s + m.adjustment, 0);
      return {
        cityIdentifier: cityKey,
        managers,
        matches: cityMatches,
        matchCount,
        baseTotal,
        adjustment,
        total: baseTotal + adjustment,
      };
    });

  const network = {
    matchCount: cities.reduce((s, c) => s + c.matchCount, 0),
    managerCount: managerRows.length,
    baseTotal: cities.reduce((s, c) => s + c.baseTotal, 0),
    adjustment: cities.reduce((s, c) => s + c.adjustment, 0),
    total: cities.reduce((s, c) => s + c.total, 0),
  };

  return {
    weekStart,
    weekEnd,
    payDate,
    computedAt: new Date().toISOString(),
    isAdmin,
    cities,
    network,
  };
}

// ============================================================
// Recompute → fin_expenses (cron entry point)
// ============================================================
//
// Hard cutover floor. Pay-date Thursdays before this date stay
// frozen as the existing manual fin_expenses rows — the recompute
// never touches them. Cutover chosen because the manager_pay_adjust-
// ments (Additional Pay) data is only correct from this week
// forward; earlier weeks were tracked in a different system that
// doesn't round-trip through manager_pay_adjustments.
export const MANAGER_PAY_CUTOVER_PAY_DATE = "2026-05-21";

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// "Apr 2026" — matches the format ManagerPayGrid wrote on manual
// inserts and that financeStats reads via `r.month === month`.
function monthLabelForDate(yyyyMmDd: string): string {
  const [y, m] = yyyyMmDd.split("-").map(Number);
  return `${MONTH_LABELS[m - 1]} ${y}`;
}

// The Monday of the work week containing `now` (UTC-anchored to
// match weekdayUtc/addDays). Used to walk the recompute window from
// cutover forward to the current in-flight week.
function currentWorkWeekMondayUtc(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const todayIso = `${y}-${m}-${d}`;
  const dow = weekdayUtc(todayIso); // 0=Sun..6=Sat
  const daysToMon = dow === 0 ? 6 : dow - 1;
  return addDays(todayIso, -daysToMon);
}

export type RecomputeResult = {
  weeksProcessed: number;
  rowsWritten: number;
  rowsSkippedUnmappedCity: number;
};

// Recompute Match Manager Pay rows in fin_expenses for every
// pay-date Thursday from MANAGER_PAY_CUTOVER_PAY_DATE forward to the
// current in-flight work week's pay date. Pre-cutover Thursdays are
// guaranteed untouched via the `.gte("date", cutover)` filter on the
// delete.
//
// Strategy: bulk DELETE the recompute window, then bulk INSERT all
// computed rows. Two queries total per run. There's a brief window
// (~tens of ms) between the two where readers see no rows for the
// affected weeks — acceptable for a daily cron. A future hardening
// pass could wrap this in an RPC for transactional atomicity.
//
// The partial unique index `fin_expenses_manager_pay_uniq` (city,
// date) WHERE category='Match Manager Pay' is defense-in-depth — it
// blocks an accidental second insert but isn't load-bearing here
// because the explicit delete handles it.
export async function recomputeManagerPayIntoFinExpenses(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<RecomputeResult> {
  const cutoverPayDate = MANAGER_PAY_CUTOVER_PAY_DATE;
  const cutoverMonday = workWeekStartForPayDate(cutoverPayDate); // 2026-05-11
  const currentMonday = currentWorkWeekMondayUtc(now);

  // If somehow current is before cutover (won't happen in practice
  // post-launch, but be defensive), there's nothing to recompute.
  if (currentMonday < cutoverMonday) {
    return { weeksProcessed: 0, rowsWritten: 0, rowsSkippedUnmappedCity: 0 };
  }

  // Walk Mondays from cutoverMonday → currentMonday inclusive.
  const mondays: string[] = [];
  for (let m = cutoverMonday; m <= currentMonday; m = addDays(m, 7)) {
    mondays.push(m);
  }

  type Row = {
    date: string;
    month: string;
    city: string;
    category: "Match Manager Pay";
    vendor: "Weekly payroll";
    amount: number;
    notes: string;
    manual_entry: false;
  };
  const rows: Row[] = [];
  let skippedUnmapped = 0;

  for (const monday of mondays) {
    const payload = await computeManagerPayForWeek(supabase, monday, {
      isAdmin: true,
    });
    for (const city of payload.cities) {
      // city.cityIdentifier is the mdapi abbr ("ATX") or "Unknown"
      // for matches with null city_identifier. fin_expenses uses the
      // cockpit display name ("Austin"). Translate; skip rows that
      // don't map (won't render in ManagerPayGrid anyway).
      const cockpitCity = cityFromAbbr(city.cityIdentifier);
      if (!cockpitCity) {
        skippedUnmapped++;
        continue;
      }
      // Skip zero-total cities — no need to write empty rows; the
      // grid's `getStored` falls back to 0 for missing rows.
      if (city.total === 0) continue;
      rows.push({
        date: payload.payDate,
        month: monthLabelForDate(payload.payDate),
        city: cockpitCity,
        category: "Match Manager Pay",
        vendor: "Weekly payroll",
        amount: city.total,
        notes: `Computed from /managers · week of ${payload.weekStart}`,
        manual_entry: false,
      });
    }
  }

  // Bulk-delete the recompute window. The cutover floor is enforced
  // here so no pre-cutover row can be touched regardless of upstream
  // bugs that might bleed earlier dates into the rows array.
  const { error: deleteErr } = await supabase
    .from("fin_expenses")
    .delete()
    .eq("category", "Match Manager Pay")
    .gte("date", cutoverPayDate);
  if (deleteErr) {
    throw new Error(
      `fin_expenses recompute delete failed: ${deleteErr.message}`,
    );
  }

  if (rows.length > 0) {
    const { error: insertErr } = await supabase
      .from("fin_expenses")
      .insert(rows);
    if (insertErr) {
      throw new Error(
        `fin_expenses recompute insert failed: ${insertErr.message}`,
      );
    }
  }

  return {
    weeksProcessed: mondays.length,
    rowsWritten: rows.length,
    rowsSkippedUnmappedCity: skippedUnmapped,
  };
}
