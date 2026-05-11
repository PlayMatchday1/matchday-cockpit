"use client";

// Public Match Manager Schedule & Pay view at /managers.
//
// Renders the per-city weekly calendar + per-city pay tables for any
// Mon–Sun work week. Anonymous viewers see the schedule and pay
// numbers but no contractor emails or edit controls. Admins (any
// authenticated cockpit session) additionally see emails, can edit
// Additional Pay, and can download the Gusto CSV.

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ---------------------------------------------------------------
// Types — mirror /api/manager-pay/week response.
// ---------------------------------------------------------------

type MatchSummary = {
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
  primaryManagerEmail: string | null;
  secondManagerName: string | null;
  secondManagerEmail: string | null;
  payPerManager: number;
};

type ManagerMatch = {
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
};

type ManagerRow = {
  managerEmail: string | null;
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

type CitySection = {
  cityIdentifier: string;
  managers: ManagerRow[];
  matches: MatchSummary[];
  matchCount: number;
  baseTotal: number;
  adjustment: number;
  total: number;
};

type Payload = {
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

type ViewMode = "calendar" | "table";
type CityFilter = "ALL" | string;

// Order shown in the pill row and (for All view) the stacked calendars.
const CITY_ORDER = ["ATL", "ATX", "DFW", "ELP", "HOU", "OKC", "SATX", "STL"];

// --- Date helpers (Central-time aware via Intl) ---

const CENTRAL_TZ = "America/Chicago";

function todayInCT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CENTRAL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(yyyyMmDd: string, n: number): string {
  const d = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayUtc(yyyyMmDd: string): number {
  return new Date(`${yyyyMmDd}T00:00:00.000Z`).getUTCDay();
}

function snapToMonday(yyyyMmDd: string): string {
  const wd = weekdayUtc(yyyyMmDd);
  const offset = wd === 0 ? -6 : -(wd - 1);
  return addDays(yyyyMmDd, offset);
}

function defaultWeekStart(): string {
  const today = todayInCT();
  return addDays(snapToMonday(today), -7);
}

function fmtMonthDay(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtMonthDayYear(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function csvCell(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildGustoCsv(payload: Payload, cityFilter: CityFilter): string {
  const header = [
    "First Name",
    "Last Name",
    "Email",
    "Earnings Type",
    "Amount",
    "Pay Date",
    "Memo",
  ];
  const lines: string[] = [header.map(csvCell).join(",")];
  for (const city of payload.cities) {
    if (cityFilter !== "ALL" && city.cityIdentifier !== cityFilter) continue;
    for (const m of city.managers) {
      if (m.total === 0) continue;
      const [first, ...rest] = m.managerName.split(" ");
      const last = rest.join(" ");
      const memo = `${m.matchCount} match${m.matchCount === 1 ? "" : "es"} · ${city.cityIdentifier} · week of ${payload.weekStart}`;
      lines.push(
        [
          csvCell(first ?? ""),
          csvCell(last ?? ""),
          csvCell(m.managerEmail ?? ""),
          csvCell("Bonus"),
          csvCell(m.total.toFixed(2)),
          csvCell(payload.payDate),
          csvCell(memo),
        ].join(","),
      );
    }
  }
  return lines.join("\r\n") + "\r\n";
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------
// Page component
// ---------------------------------------------------------------

export default function ManagersView() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const urlWeek = searchParams?.get("week") ?? null;
  const urlView = searchParams?.get("view") ?? null;
  const urlCity = searchParams?.get("city") ?? null;

  const weekStart = useMemo(() => {
    if (urlWeek && /^\d{4}-\d{2}-\d{2}$/.test(urlWeek)) {
      return snapToMonday(urlWeek);
    }
    return defaultWeekStart();
  }, [urlWeek]);

  const view: ViewMode = urlView === "table" ? "table" : "calendar";
  const cityFilter: CityFilter =
    urlCity && CITY_ORDER.includes(urlCity) ? urlCity : "ALL";

  const setUrl = useCallback(
    (next: { week?: string; view?: ViewMode; city?: CityFilter }) => {
      const qs = new URLSearchParams(searchParams?.toString() ?? "");
      if (next.week !== undefined) qs.set("week", next.week);
      if (next.view !== undefined) {
        if (next.view === "calendar") qs.delete("view");
        else qs.set("view", next.view);
      }
      if (next.city !== undefined) {
        if (next.city === "ALL") qs.delete("city");
        else qs.set("city", next.city);
      }
      const s = qs.toString();
      router.push(s ? `?${s}` : "?");
    },
    [router, searchParams],
  );

  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch(
          `/api/manager-pay/week?week=${encodeURIComponent(weekStart)}`,
          { headers, cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
        if (!cancelled) setPayload(json as Payload);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [weekStart, refreshKey]);

  const isAdmin = payload?.isAdmin ?? false;
  const onPrevWeek = () => setUrl({ week: addDays(weekStart, -7) });
  const onNextWeek = () => setUrl({ week: addDays(weekStart, 7) });
  const onLastCompleted = () => setUrl({ week: defaultWeekStart() });

  const onSaveAdjustment = useCallback(
    async (
      managerEmail: string,
      managerId: number | null,
      amount: number,
      notes: string | null,
    ) => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        alert("No active session. Sign in to edit Additional Pay.");
        return;
      }
      const res = await fetch(`/api/manager-pay/adjustments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          managerEmail,
          managerId,
          weekStart,
          amount,
          notes,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(`Save failed: ${json?.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setRefreshKey((k) => k + 1);
    },
    [weekStart],
  );

  const downloadGusto = () => {
    if (!payload) return;
    const csv = buildGustoCsv(payload, cityFilter);
    const suffix = cityFilter === "ALL" ? "" : `-${cityFilter}`;
    downloadCsv(`match-manager-pay-${payload.weekStart}${suffix}.csv`, csv);
  };

  // Filtered cities + network totals based on cityFilter.
  const visibleCities: CitySection[] = useMemo(() => {
    if (!payload) return [];
    if (cityFilter === "ALL") {
      return [...payload.cities].sort((a, b) => {
        const ai = CITY_ORDER.indexOf(a.cityIdentifier);
        const bi = CITY_ORDER.indexOf(b.cityIdentifier);
        const an = ai === -1 ? 999 : ai;
        const bn = bi === -1 ? 999 : bi;
        if (an !== bn) return an - bn;
        return a.cityIdentifier.localeCompare(b.cityIdentifier);
      });
    }
    return payload.cities.filter((c) => c.cityIdentifier === cityFilter);
  }, [payload, cityFilter]);

  const visibleTotals = useMemo(() => {
    return visibleCities.reduce(
      (acc, c) => ({
        matchCount: acc.matchCount + c.matchCount,
        managerCount: acc.managerCount + c.managers.length,
        baseTotal: acc.baseTotal + c.baseTotal,
        adjustment: acc.adjustment + c.adjustment,
        total: acc.total + c.total,
      }),
      { matchCount: 0, managerCount: 0, baseTotal: 0, adjustment: 0, total: 0 },
    );
  }, [visibleCities]);

  const isDefaultWeek = weekStart === defaultWeekStart();

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
            Match Manager Schedule &amp; Pay
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
            Weekly schedule of matches, assigned managers, and pay. Updated daily.
          </p>
        </div>
      </div>

      {/* City pills */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em]">
        <CityPill
          label="All Cities"
          active={cityFilter === "ALL"}
          onClick={() => setUrl({ city: "ALL" })}
        />
        {CITY_ORDER.map((c) => (
          <CityPill
            key={c}
            label={c}
            active={cityFilter === c}
            onClick={() => setUrl({ city: c })}
          />
        ))}
      </div>

      {/* Week selector + view toggle + (admin) Gusto CSV */}
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border-[1.5px] border-cream-line bg-white px-4 py-3 shadow-md shadow-deep-green/10">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPrevWeek}
            className="rounded-full border border-cream-line bg-white px-2.5 py-1 text-xs font-bold text-deep-green transition hover:bg-cream-soft"
            aria-label="Previous week"
          >
            ←
          </button>
          <div className="px-3 text-sm font-bold tracking-tight text-deep-green">
            {fmtMonthDay(weekStart)} – {fmtMonthDayYear(addDays(weekStart, 6))}
          </div>
          <button
            type="button"
            onClick={onNextWeek}
            className="rounded-full border border-cream-line bg-white px-2.5 py-1 text-xs font-bold text-deep-green transition hover:bg-cream-soft"
            aria-label="Next week"
          >
            →
          </button>
          {isDefaultWeek ? (
            <span className="ml-2 rounded-full bg-mint/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-deep-green">
              Last completed
            </span>
          ) : (
            <button
              type="button"
              onClick={onLastCompleted}
              className="ml-2 rounded-full border border-cream-line bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
            >
              Jump to last completed
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {payload && (
            <div className="text-[11px] font-medium text-deep-green/55">
              Pay date{" "}
              <span className="font-bold text-deep-green">
                {fmtMonthDayYear(payload.payDate)}
              </span>
            </div>
          )}
          <div className="flex items-center rounded-full border border-cream-line bg-white p-0.5 text-[11px] font-bold uppercase tracking-[0.1em]">
            <button
              type="button"
              onClick={() => setUrl({ view: "calendar" })}
              className={`rounded-full px-3 py-1 transition ${
                view === "calendar"
                  ? "bg-mint text-deep-green"
                  : "text-deep-green/55 hover:text-deep-green"
              }`}
            >
              Calendar
            </button>
            <button
              type="button"
              onClick={() => setUrl({ view: "table" })}
              className={`rounded-full px-3 py-1 transition ${
                view === "table"
                  ? "bg-mint text-deep-green"
                  : "text-deep-green/55 hover:text-deep-green"
              }`}
            >
              Table
            </button>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={downloadGusto}
              disabled={!payload || visibleTotals.total === 0}
              className="rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
            >
              ↓ Gusto CSV
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-2xl border-[1.5px] border-coral/40 bg-coral/5 p-4 text-sm text-coral">
          {error}
        </div>
      )}

      {loading && !payload && (
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
          Loading week…
        </div>
      )}

      {payload && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Matches" value={String(visibleTotals.matchCount)} />
            <Tile
              label="Managers paid"
              value={String(visibleTotals.managerCount)}
            />
            <Tile
              label="Base pay"
              value={formatMoney(visibleTotals.baseTotal)}
            />
            <Tile
              label="Total payout"
              value={formatMoney(visibleTotals.total)}
              accent
            />
          </div>

          {visibleCities.length === 0 ? (
            <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
              No matches this week
              {cityFilter === "ALL" ? "." : ` in ${cityFilter}.`}
            </div>
          ) : view === "calendar" ? (
            <CalendarView
              cities={visibleCities}
              weekStart={weekStart}
              isAdmin={isAdmin}
              onSaveAdjustment={onSaveAdjustment}
            />
          ) : (
            <TableView
              cities={visibleCities}
              cityFilter={cityFilter}
              network={visibleTotals}
              isAdmin={isAdmin}
              onSaveAdjustment={onSaveAdjustment}
            />
          )}
        </>
      )}
    </>
  );
}

function CityPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 transition ${
        active
          ? "border-deep-green bg-deep-green text-cream"
          : "border-cream-line bg-white text-deep-green/65 hover:border-deep-green/40 hover:text-deep-green"
      }`}
    >
      {label}
    </button>
  );
}

function Tile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border-[1.5px] p-4 shadow-md shadow-deep-green/10 ${
        accent ? "border-mint bg-mint/15" : "border-cream-line bg-white"
      }`}
    >
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-deep-green/55">
        {label}
      </div>
      <div className="mt-1 font-display text-2xl text-deep-green">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------
// Calendar View — stacked per-city calendar grids.
// ---------------------------------------------------------------

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function CalendarView({
  cities,
  weekStart,
  isAdmin,
  onSaveAdjustment,
}: {
  cities: CitySection[];
  weekStart: string;
  isAdmin: boolean;
  onSaveAdjustment: (
    managerEmail: string,
    managerId: number | null,
    amount: number,
    notes: string | null,
  ) => Promise<void>;
}) {
  const weekDays = useMemo(
    () => DAY_LABELS.map((_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  return (
    <div className="space-y-8">
      {cities.map((city) => (
        <section key={city.cityIdentifier}>
          <div className="mb-3 flex items-stretch gap-3">
            <span aria-hidden className="w-1 rounded-full bg-mint" />
            <div className="flex-1 py-0.5">
              <h2 className="font-display text-3xl uppercase leading-none tracking-tight text-deep-green md:text-4xl">
                {city.cityIdentifier}
              </h2>
              <p className="mt-1 text-sm text-deep-green/60">
                {city.matchCount} paid match
                {city.matchCount === 1 ? "" : "es"} · {city.managers.length}{" "}
                manager{city.managers.length === 1 ? "" : "s"} ·{" "}
                {formatMoney(city.total)} total
              </p>
            </div>
          </div>

          {/* Calendar grid */}
          <div className="mb-4 overflow-x-auto">
            <div className="grid min-w-[840px] grid-cols-7 gap-2">
              {weekDays.map((dayIso, i) => {
                const dayMatches = city.matches.filter(
                  (m) => m.centralDate === dayIso,
                );
                return (
                  <div
                    key={dayIso}
                    className="rounded-2xl border-[1.5px] border-cream-line bg-white p-2 shadow-md shadow-deep-green/10"
                  >
                    <div className="mb-2 border-b border-cream-line pb-1 text-center">
                      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-deep-green/55">
                        {DAY_LABELS[i]}
                      </div>
                      <div className="text-xs font-bold text-deep-green">
                        {fmtMonthDay(dayIso)}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {dayMatches.length === 0 ? (
                        <div className="py-2 text-center text-[10px] uppercase tracking-[0.1em] text-deep-green/30">
                          —
                        </div>
                      ) : (
                        dayMatches.map((m) => (
                          <MatchCard key={m.matchId} match={m} />
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pay table for this city */}
          <PayTable
            city={city}
            isAdmin={isAdmin}
            onSaveAdjustment={onSaveAdjustment}
          />
        </section>
      ))}
    </div>
  );
}

function MatchCard({ match }: { match: MatchSummary }) {
  const cancelled = match.isCancelled;
  return (
    <div
      className={`rounded-md border px-2 py-1.5 text-[11px] leading-tight ${
        cancelled
          ? "border-coral/40 bg-coral/5 text-coral"
          : "border-cream-line bg-cream-soft/40 text-deep-green"
      }`}
    >
      <div
        className={`text-[11px] font-bold ${cancelled ? "line-through" : ""}`}
      >
        {match.centralTime || "—"}
      </div>
      <div className={`text-[10px] ${cancelled ? "line-through" : ""}`}>
        {match.fieldTitle ?? match.name ?? `Match ${match.matchId}`}
      </div>
      {(match.primaryManagerName || match.secondManagerName) && (
        <div className="mt-0.5 text-[10px] text-deep-green/70">
          (
          <span className="font-bold text-deep-green">
            {match.primaryManagerName ?? "—"}
          </span>
          {match.secondManagerName ? (
            <>
              {" "}· 2nd:{" "}
              <span className="text-deep-green/85">
                {match.secondManagerName}
              </span>
            </>
          ) : null}
          )
        </div>
      )}
      <div className="mt-0.5 text-[10px] text-deep-green/60">
        {match.playerCount ?? 0}/{match.maxPlayerCount ?? "?"} players
        {match.registrationPrice != null
          ? ` · ${formatMoney(match.registrationPrice)}`
          : ""}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// Pay table — shared between Calendar (per-city) and Table view.
// ---------------------------------------------------------------

function PayTable({
  city,
  isAdmin,
  onSaveAdjustment,
}: {
  city: CitySection;
  isAdmin: boolean;
  onSaveAdjustment: (
    managerEmail: string,
    managerId: number | null,
    amount: number,
    notes: string | null,
  ) => Promise<void>;
}) {
  if (city.managers.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <table className="w-full text-sm">
        <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-[0.12em] text-deep-green/65">
          <tr>
            <th className="px-4 py-2 text-left">Manager</th>
            <th className="px-4 py-2 text-right">Matches</th>
            <th className="px-4 py-2 text-right">Base</th>
            <th className="px-4 py-2 text-right">Additional</th>
            <th className="px-4 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {city.managers.map((m, idx) => (
            <ManagerRowExpandable
              key={m.managerName + (m.managerEmail ?? idx)}
              manager={m}
              isLast={idx === city.managers.length - 1}
              isAdmin={isAdmin}
              onSaveAdjustment={onSaveAdjustment}
            />
          ))}
          <tr className="border-t-2 border-cream-line bg-cream-soft/50 font-bold text-deep-green">
            <td className="px-4 py-2 text-right">
              {city.cityIdentifier} total
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {city.matchCount}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {formatMoney(city.baseTotal)}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {formatMoney(city.adjustment)}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {formatMoney(city.total)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ManagerRowExpandable({
  manager,
  isLast,
  isAdmin,
  onSaveAdjustment,
}: {
  manager: ManagerRow;
  isLast: boolean;
  isAdmin: boolean;
  onSaveAdjustment: (
    managerEmail: string,
    managerId: number | null,
    amount: number,
    notes: string | null,
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className={`cursor-pointer transition hover:bg-cream-soft/40 ${
          isLast ? "" : "border-b border-cream-line/60"
        }`}
        onClick={() => setOpen((o) => !o)}
      >
        <td className="px-4 py-2 align-top">
          <div className="font-bold text-deep-green">
            <span
              aria-hidden
              className="mr-1 inline-block w-3 text-deep-green/40"
            >
              {open ? "▾" : "▸"}
            </span>
            {manager.managerName}
          </div>
          {isAdmin && manager.managerEmail && (
            <div className="text-[11px] text-deep-green/55">
              {manager.managerEmail}
            </div>
          )}
        </td>
        <td className="px-4 py-2 text-right align-top tabular-nums">
          {manager.matchCount}
        </td>
        <td className="px-4 py-2 text-right align-top tabular-nums">
          {formatMoney(manager.baseTotal)}
        </td>
        <td
          className="px-4 py-2 text-right align-top"
          onClick={(e) => e.stopPropagation()}
        >
          {isAdmin && manager.managerEmail ? (
            <AdjustmentInput
              initialAmount={manager.adjustment}
              initialNotes={manager.adjustmentNotes}
              onSave={(amount, notes) =>
                onSaveAdjustment(
                  manager.managerEmail!,
                  manager.managerId,
                  amount,
                  notes,
                )
              }
            />
          ) : (
            <span className="tabular-nums text-deep-green/75">
              {formatMoney(manager.adjustment)}
            </span>
          )}
        </td>
        <td className="px-4 py-2 text-right align-top font-bold tabular-nums text-deep-green">
          {formatMoney(manager.total)}
        </td>
      </tr>
      {open && (
        <tr
          className={`bg-cream-soft/30 ${
            isLast ? "" : "border-b border-cream-line/60"
          }`}
        >
          <td colSpan={5} className="px-4 py-3">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[10px] font-bold uppercase tracking-[0.12em] text-deep-green/55">
                  <tr>
                    <th className="px-2 py-1 text-left">Day</th>
                    <th className="px-2 py-1 text-left">Time</th>
                    <th className="px-2 py-1 text-left">Match</th>
                    <th className="px-2 py-1 text-left">Field</th>
                    <th className="px-2 py-1 text-right">Max</th>
                    <th className="px-2 py-1 text-left">Role</th>
                    <th className="px-2 py-1 text-right">Pay</th>
                  </tr>
                </thead>
                <tbody>
                  {manager.matches.map((mm) => (
                    <tr key={mm.matchId} className="border-t border-cream-line/40">
                      <td className="px-2 py-1 align-top">
                        <span className="font-bold text-deep-green">
                          {mm.centralWeekday}
                        </span>{" "}
                        <span className="text-deep-green/55">
                          {fmtMonthDay(mm.centralDate)}
                        </span>
                      </td>
                      <td className="px-2 py-1 align-top text-deep-green/80">
                        {mm.centralTime ?? "—"}
                      </td>
                      <td className="px-2 py-1 align-top text-deep-green/80">
                        {mm.name ?? `Match ${mm.matchId}`}
                      </td>
                      <td className="px-2 py-1 align-top text-deep-green/70">
                        {mm.fieldTitle ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-right align-top tabular-nums text-deep-green/70">
                        {mm.maxPlayerCount ?? "—"}
                      </td>
                      <td className="px-2 py-1 align-top">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] ${
                            mm.role === "primary"
                              ? "bg-mint/30 text-deep-green"
                              : "bg-blue-info/15 text-blue-info"
                          }`}
                        >
                          {mm.role}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right align-top tabular-nums">
                        {formatMoney(mm.payAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AdjustmentInput({
  initialAmount,
  initialNotes,
  onSave,
}: {
  initialAmount: number;
  initialNotes: string | null;
  onSave: (amount: number, notes: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState<string>(
    initialAmount === 0 ? "" : String(initialAmount),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(initialAmount === 0 ? "" : String(initialAmount));
  }, [initialAmount]);

  const dirty =
    (value === "" ? 0 : Number(value)) !== initialAmount &&
    !Number.isNaN(Number(value));

  const commit = async () => {
    if (!dirty) return;
    const num = value === "" ? 0 : Number(value);
    if (Number.isNaN(num)) return;
    setSaving(true);
    try {
      await onSave(num, initialNotes);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center justify-end gap-1">
      <span className="text-xs text-deep-green/40">$</span>
      <input
        type="number"
        step="0.01"
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setValue(initialAmount === 0 ? "" : String(initialAmount));
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="0"
        className={`w-20 rounded border bg-white px-2 py-1 text-right text-sm tabular-nums text-deep-green outline-none transition focus:border-mint ${
          dirty ? "border-mint" : "border-cream-line"
        } ${saving ? "opacity-60" : ""}`}
      />
    </div>
  );
}

// ---------------------------------------------------------------
// Table view — flat network-wide list of managers.
// ---------------------------------------------------------------

type SortKey =
  | "name"
  | "city"
  | "matchCount"
  | "baseTotal"
  | "adjustment"
  | "total";

function TableView({
  cities,
  cityFilter,
  network,
  isAdmin,
  onSaveAdjustment,
}: {
  cities: CitySection[];
  cityFilter: CityFilter;
  network: {
    matchCount: number;
    managerCount: number;
    baseTotal: number;
    adjustment: number;
    total: number;
  };
  isAdmin: boolean;
  onSaveAdjustment: (
    managerEmail: string,
    managerId: number | null,
    amount: number,
    notes: string | null,
  ) => Promise<void>;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const allManagers = useMemo(
    () => cities.flatMap((c) => c.managers),
    [cities],
  );

  const sorted = useMemo(() => {
    const arr = [...allManagers];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.managerName.localeCompare(b.managerName);
          break;
        case "city":
          cmp = (a.cityIdentifier ?? "").localeCompare(b.cityIdentifier ?? "");
          break;
        case "matchCount":
          cmp = a.matchCount - b.matchCount;
          break;
        case "baseTotal":
          cmp = a.baseTotal - b.baseTotal;
          break;
        case "adjustment":
          cmp = a.adjustment - b.adjustment;
          break;
        case "total":
          cmp = a.total - b.total;
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [allManagers, sortKey, sortDir]);

  const onHeader = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" || key === "city" ? "asc" : "desc");
    }
  };

  const arrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  const showCityCol = cityFilter === "ALL";

  return (
    <div className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <table className="w-full text-sm">
        <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-[0.12em] text-deep-green/65">
          <tr>
            <SortHeader
              label="Manager"
              active={sortKey === "name"}
              onClick={() => onHeader("name")}
              align="left"
              arrow={arrow("name")}
            />
            {showCityCol && (
              <SortHeader
                label="City"
                active={sortKey === "city"}
                onClick={() => onHeader("city")}
                align="left"
                arrow={arrow("city")}
              />
            )}
            <SortHeader
              label="Matches"
              active={sortKey === "matchCount"}
              onClick={() => onHeader("matchCount")}
              align="right"
              arrow={arrow("matchCount")}
            />
            <SortHeader
              label="Base"
              active={sortKey === "baseTotal"}
              onClick={() => onHeader("baseTotal")}
              align="right"
              arrow={arrow("baseTotal")}
            />
            <SortHeader
              label="Additional"
              active={sortKey === "adjustment"}
              onClick={() => onHeader("adjustment")}
              align="right"
              arrow={arrow("adjustment")}
            />
            <SortHeader
              label="Total"
              active={sortKey === "total"}
              onClick={() => onHeader("total")}
              align="right"
              arrow={arrow("total")}
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((m, i) => (
            <tr
              key={m.managerName + (m.managerEmail ?? i)}
              className={
                i === sorted.length - 1
                  ? ""
                  : "border-b border-cream-line/60"
              }
            >
              <td className="px-4 py-2 align-top">
                <div className="font-bold text-deep-green">{m.managerName}</div>
                {isAdmin && m.managerEmail && (
                  <div className="text-[11px] text-deep-green/55">
                    {m.managerEmail}
                  </div>
                )}
              </td>
              {showCityCol && (
                <td className="px-4 py-2 align-top text-deep-green/80">
                  {m.cityIdentifier ?? "—"}
                </td>
              )}
              <td className="px-4 py-2 text-right align-top tabular-nums">
                {m.matchCount}
              </td>
              <td className="px-4 py-2 text-right align-top tabular-nums">
                {formatMoney(m.baseTotal)}
              </td>
              <td
                className="px-4 py-2 text-right align-top"
                onClick={(e) => e.stopPropagation()}
              >
                {isAdmin && m.managerEmail ? (
                  <AdjustmentInput
                    initialAmount={m.adjustment}
                    initialNotes={m.adjustmentNotes}
                    onSave={(amount, notes) =>
                      onSaveAdjustment(
                        m.managerEmail!,
                        m.managerId,
                        amount,
                        notes,
                      )
                    }
                  />
                ) : (
                  <span className="tabular-nums text-deep-green/75">
                    {formatMoney(m.adjustment)}
                  </span>
                )}
              </td>
              <td className="px-4 py-2 text-right align-top font-bold tabular-nums text-deep-green">
                {formatMoney(m.total)}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-cream-line bg-cream-soft/50 font-bold text-deep-green">
            <td className="px-4 py-2 text-right" colSpan={showCityCol ? 2 : 1}>
              {cityFilter === "ALL" ? "Network total" : `${cityFilter} total`}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {network.matchCount}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {formatMoney(network.baseTotal)}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {formatMoney(network.adjustment)}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {formatMoney(network.total)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({
  label,
  active,
  onClick,
  align,
  arrow,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  align: "left" | "right";
  arrow: string;
}) {
  return (
    <th
      className={`px-4 py-2 ${align === "left" ? "text-left" : "text-right"}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`transition hover:text-deep-green ${
          active ? "text-deep-green" : ""
        }`}
      >
        {label}
        {arrow}
      </button>
    </th>
  );
}
