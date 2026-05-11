// GET /api/manager-pay/week?week=YYYY-MM-DD[&city=ATX]
//
// Computes Match Manager pay AND returns the per-match schedule for
// the Mon–Sun Central-time work week starting on the given Monday.
//
// Reads mdapi_matches (synced from the MatchDay platform API) +
// mdapi_users (for second-manager name/email lookup) +
// manager_pay_adjustments (cockpit-managed Additional Pay rows). No
// external API calls.
//
// Pay rules (revised 2026-05-11):
//   - Solo match, maxPlayerCount < 25 → primary earns $20
//   - Solo tournament, maxPlayerCount ≥ 25 → primary earns $30
//   - Co-managed (any maxPlayerCount, two managers assigned) →
//     primary earns $20, secondary earns $20. Tournament premium
//     does NOT apply when co-managed — the workload is split.
//   - Cancelled matches do NOT pay (excluded from totals) but are
//     still returned in the schedule with isCancelled=true so the
//     calendar can render them struck through.
//   - Pay date = Thursday after the work week ends (Sunday + 4 days).
//
// Auth: dual-mode bearer + anonymous.
//   - Valid bearer (session or CRON_SECRET) → admin response, emails
//     included.
//   - No bearer (or invalid) → public response, emails stripped
//     server-side. Page is genuinely public so city managers and the
//     ops team can share/bookmark week URLs.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { selectAll } from "@/lib/supabasePagination";

export const runtime = "nodejs";
export const maxDuration = 30;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

// mdapi_matches.start_date is the VENUE'S local wall-clock time
// stored with a misleading "+00:00" / "Z" suffix (the upstream API
// packages localDate as if it were UTC). Running it through a real
// timezone converter would subtract the offset and produce wrong
// numbers (e.g. an 18:00 CT match → 13:00 CT after a CT conversion).
// We just read the wall-clock components directly — works for every
// venue regardless of physical timezone, including ELP (Mountain),
// because each row's stored clock-face already matches the venue.
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

function weekdayUtc(yyyyMmDd: string): number {
  return new Date(`${yyyyMmDd}T00:00:00.000Z`).getUTCDay();
}

function addDays(yyyyMmDd: string, n: number): string {
  const d = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function payDateForWeek(weekStart: string): string {
  return addDays(weekStart, 10);
}

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
  is_cancelled: boolean | null;
  manager_id: number | null;
  manager_email: string | null;
  manager_first_name: string | null;
  manager_last_name: string | null;
  second_manager_id: number | null;
  max_player_count: number | null;
  player_count: number | null;
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

// Per-match summary used by the calendar view (one row per match,
// regardless of how many managers are assigned). Includes cancelled
// matches.
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

// Per-manager match assignment (used inside the expandable per-manager
// detail row on the pay table).
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

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Returns the per-manager pay for one match under the 2026-05-11
// rules. Tournament premium ($30) only applies when a single manager
// runs the match alone.
const TOURNAMENT_THRESHOLD = 25;

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

// Check whether the request has a valid admin bearer token. Returns
// true for CRON_SECRET matches or any logged-in Supabase session.
async function checkAdmin(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return false;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) return false;

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && constantTimeMatch(token, cronSecret)) return true;

  const sessionClient = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sessionClient.auth.getUser(token);
  return !error && !!data?.user;
}

export async function GET(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }

  const isAdmin = await checkAdmin(req);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const url = new URL(req.url);
  const weekParam = url.searchParams.get("week");
  if (!weekParam || !ISO_DATE_RX.test(weekParam)) {
    return Response.json(
      { error: "Missing or malformed ?week=YYYY-MM-DD" },
      { status: 400 },
    );
  }
  if (weekdayUtc(weekParam) !== 1) {
    return Response.json(
      { error: "?week must be a Monday (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  const weekStart = weekParam;
  const weekEnd = addDays(weekStart, 6);
  const payDate = payDateForWeek(weekStart);

  const queryFrom = `${addDays(weekStart, -1)}T00:00:00Z`;
  const queryTo = `${addDays(weekEnd, 2)}T00:00:00Z`;

  const matches = await selectAll<MatchRow>(() =>
    supabase
      .from("mdapi_matches")
      .select(
        "api_id, city_identifier, field_title, start_date, is_cancelled, manager_id, manager_email, manager_first_name, manager_last_name, second_manager_id, max_player_count, player_count, registration_price, name, raw",
      )
      .gte("start_date", queryFrom)
      .lt("start_date", queryTo)
      .order("api_id"),
  );

  // All matches in the CT week — include cancelled so the calendar
  // can render them. Pay/manager-roll-up below filters them out.
  const inWeek = matches.filter((m) => {
    if (!m.start_date) return false;
    const ct = venueDate(m.start_date);
    if (!ct) return false;
    return ct >= weekStart && ct <= weekEnd;
  });

  // Collect second-manager IDs across all in-week matches (incl
  // cancelled — we still want names for the calendar).
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
      return Response.json(
        { error: `mdapi_users lookup failed: ${error.message}` },
        { status: 500 },
      );
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
    return Response.json(
      { error: `manager_pay_adjustments read failed: ${adjErr.message}` },
      { status: 500 },
    );
  }
  const adjByEmail = new Map<string, { amount: number; notes: string | null }>();
  for (const row of (adjData ?? []) as AdjustmentRow[]) {
    const key = row.manager_email.toLowerCase();
    const amt =
      typeof row.amount === "number" ? row.amount : Number(row.amount) || 0;
    adjByEmail.set(key, { amount: amt, notes: row.notes });
  }

  // --- Build per-match summaries (calendar view, all matches incl cancelled)
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

  // A match is "co-managed" if it has a secondManager intent on the
  // upstream row, regardless of whether we could resolve the email.
  // Drives the pay rule (both $20) and the calendar/role labels.
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

  // --- Per-manager roll-up (only non-cancelled matches pay)
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

  // Group both managers and matches by city. A city is included if
  // it has any matches in the week (so the calendar shows empty days)
  // or any pay roll-up.
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

  const payload: ManagerPayWeekPayload = {
    weekStart,
    weekEnd,
    payDate,
    computedAt: new Date().toISOString(),
    isAdmin,
    cities,
    network,
  };

  return Response.json(payload);
}
