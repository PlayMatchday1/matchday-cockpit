// GET /api/manager-pay/week?week=YYYY-MM-DD
//
// Computes Match Manager pay for the Mon–Sun Central-time work week
// starting on the given Monday. Reads mdapi_matches (synced from the
// MatchDay platform API) + mdapi_users (for second-manager email
// lookup) + manager_pay_adjustments (cockpit-managed Additional Pay
// rows). No external API calls.
//
// Pay rules (per user spec):
//   - maxPlayerCount > 22 → $30 per match per assigned manager
//   - maxPlayerCount ≤ 22 → $20 per match per assigned manager
//   - Both primary (manager_email) and secondary (lookup by
//     second_manager_id → mdapi_users.email) get the full amount.
//   - Cancelled matches are excluded.
//   - Pay date = Thursday after the work week ends (Sunday + 4 days).
//
// Auth: dual-mode bearer — session token via supabase.auth.getUser
// OR Bearer CRON_SECRET. Same pattern as /api/cities/users-lens.

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
const CENTRAL_TZ = "America/Chicago";

// Returns the YYYY-MM-DD wall-clock date in America/Chicago for a
// given UTC timestamp. Uses Intl rather than hardcoding -5/-6 so DST
// transitions are correct.
function centralDate(utcIso: string): string | null {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: CENTRAL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // en-CA → "YYYY-MM-DD"
}

// Weekday (0=Sun..6=Sat) for a YYYY-MM-DD interpreted as a UTC date.
function weekdayUtc(yyyyMmDd: string): number {
  return new Date(`${yyyyMmDd}T00:00:00.000Z`).getUTCDay();
}

// Add N calendar days to a YYYY-MM-DD string. Returns YYYY-MM-DD.
function addDays(yyyyMmDd: string, n: number): string {
  const d = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Pay date = Sunday (week_start + 6) + 4 calendar days = Thursday.
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

export type ManagerMatch = {
  matchId: number;
  cityIdentifier: string | null;
  fieldTitle: string | null;
  startDate: string; // ISO UTC
  centralDate: string; // YYYY-MM-DD in CT
  centralWeekday: string; // Mon, Tue, ...
  name: string | null;
  maxPlayerCount: number | null;
  payAmount: number;
  role: "primary" | "secondary";
};

export type ManagerRow = {
  managerEmail: string;
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
  matchCount: number;
  baseTotal: number;
  adjustment: number;
  total: number;
};

export type ManagerPayWeekPayload = {
  weekStart: string; // YYYY-MM-DD (Monday)
  weekEnd: string; // YYYY-MM-DD (Sunday)
  payDate: string; // YYYY-MM-DD (Thursday after Sunday)
  computedAt: string;
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

function payAmount(maxPlayerCount: number | null): number {
  if (maxPlayerCount != null && maxPlayerCount > 22) return 30;
  return 20;
}

function displayName(
  first: string | null | undefined,
  last: string | null | undefined,
  emailFallback: string,
): string {
  const parts = [first, last].filter((s): s is string => !!s && s.trim() !== "");
  if (parts.length > 0) return parts.join(" ");
  return emailFallback;
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return Response.json(
      { error: "Missing Authorization header" },
      { status: 401 },
    );
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    return Response.json({ error: "Empty bearer token" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !serviceKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !constantTimeMatch(token, cronSecret)) {
    const sessionClient = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sessionClient.auth.getUser(token);
    if (error || !data?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
  }

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

  // Pull matches in a generous UTC window around the CT week (±2 days
  // covers any DST edge). Filter precisely after by Central wall-clock.
  const queryFrom = `${addDays(weekStart, -1)}T00:00:00Z`;
  const queryTo = `${addDays(weekEnd, 2)}T00:00:00Z`;

  const matches = await selectAll<MatchRow>(() =>
    supabase
      .from("mdapi_matches")
      .select(
        "api_id, city_identifier, field_title, start_date, is_cancelled, manager_id, manager_email, manager_first_name, manager_last_name, second_manager_id, max_player_count, name, raw",
      )
      .gte("start_date", queryFrom)
      .lt("start_date", queryTo)
      .order("api_id"),
  );

  const inWeek = matches.filter((m) => {
    if (m.is_cancelled) return false;
    if (!m.start_date) return false;
    const ct = centralDate(m.start_date);
    if (!ct) return false;
    return ct >= weekStart && ct <= weekEnd;
  });

  // Collect second-manager IDs that need email lookup.
  const secondIds = new Set<number>();
  for (const m of inWeek) {
    if (m.second_manager_id) secondIds.add(m.second_manager_id);
  }

  const secondById = new Map<number, UserRow>();
  if (secondIds.size > 0) {
    const ids = Array.from(secondIds);
    // PostgREST `in` supports a few hundred values per request without
    // hitting URL-length limits; this is bounded by the number of
    // distinct second managers in a single week (small).
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

  // Load adjustments keyed by manager_email (case-insensitive).
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

  // Build per-manager rows. Key = lower(email) so primary/secondary
  // appearances of the same person merge cleanly.
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
      // Prefer a non-empty name + numeric id if we encounter them later.
      if (!acc.managerName || acc.managerName === acc.managerEmail) {
        acc.managerName = name;
      }
      if (acc.managerId == null && id != null) acc.managerId = id;
    }
    const ct = centralDate(m.start_date ?? "") ?? weekStart;
    const wd = WEEKDAY_NAMES[weekdayUtc(ct)];
    acc.matches.push({
      matchId: m.api_id,
      cityIdentifier: m.city_identifier,
      fieldTitle: m.field_title,
      startDate: m.start_date ?? "",
      centralDate: ct,
      centralWeekday: wd,
      name: m.name,
      maxPlayerCount: m.max_player_count,
      payAmount: payAmount(m.max_player_count),
      role,
    });
    const city = m.city_identifier ?? "Unknown";
    acc.cityCounts.set(city, (acc.cityCounts.get(city) ?? 0) + 1);
  }

  for (const m of inWeek) {
    if (m.manager_email) {
      addAssignment(
        m.manager_email,
        displayName(m.manager_first_name, m.manager_last_name, m.manager_email),
        m.manager_id,
        "primary",
        m,
      );
    }
    if (m.second_manager_id) {
      let email: string | null = null;
      let name: string | null = null;
      const userRow = secondById.get(m.second_manager_id);
      if (userRow) {
        email = userRow.email;
        name = displayName(userRow.first_name, userRow.last_name, userRow.email);
      } else {
        // Fallback to raw.secondManager if the sync stored it (older
        // rows may not have run through mdapi_users sync yet).
        const sm = m.raw?.secondManager;
        if (sm && typeof sm === "object" && sm.email) {
          email = sm.email;
          name = displayName(sm.firstName, sm.lastName, sm.email);
        }
      }
      if (email) {
        addAssignment(
          email,
          name ?? email,
          m.second_manager_id,
          "secondary",
          m,
        );
      }
    }
  }

  // Reduce to ManagerRow (dominant city = the city with the most
  // matches in the week; tie → first-seen).
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
      managerEmail: acc.managerEmail,
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

  // Group into cities (dominant city). Sort cities alphabetically;
  // managers within a city by name.
  const cityMap = new Map<string, ManagerRow[]>();
  for (const row of managerRows) {
    const key = row.cityIdentifier ?? "Unknown";
    const list = cityMap.get(key) ?? [];
    list.push(row);
    cityMap.set(key, list);
  }
  const cities: CitySection[] = Array.from(cityMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cityIdentifier, managers]) => {
      managers.sort((a, b) => a.managerName.localeCompare(b.managerName));
      const matchCount = managers.reduce((s, m) => s + m.matchCount, 0);
      const baseTotal = managers.reduce((s, m) => s + m.baseTotal, 0);
      const adjustment = managers.reduce((s, m) => s + m.adjustment, 0);
      return {
        cityIdentifier,
        managers,
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
    cities,
    network,
  };

  return Response.json(payload);
}
