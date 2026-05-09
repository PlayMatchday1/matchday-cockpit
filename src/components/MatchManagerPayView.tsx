"use client";

// Match Manager Pay — replaces the Heroku weekly-reports dashboard.
// Shows assigned matches per manager for a Mon–Sun work week, with
// inline-editable Additional Pay column and Gusto CSV export.
//
// Data source: /api/manager-pay/week (computed live from mdapi_matches
// + manager_pay_adjustments). No external API call required.
//
// Pay rules:
//   - maxPlayerCount > 22 → $30 per match
//   - maxPlayerCount ≤ 22 → $20 per match
//   - Both primary + secondary managers paid the full amount.
// Pay date = Thursday after the work week ends (Sunday + 4 days).

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type ManagerMatch = {
  matchId: number;
  cityIdentifier: string | null;
  fieldTitle: string | null;
  startDate: string;
  centralDate: string;
  centralWeekday: string;
  name: string | null;
  maxPlayerCount: number | null;
  payAmount: number;
  role: "primary" | "secondary";
};
type ManagerRow = {
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
type CitySection = {
  cityIdentifier: string;
  managers: ManagerRow[];
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
  // 0=Sun, 1=Mon, ..., 6=Sat
  return new Date(`${yyyyMmDd}T00:00:00.000Z`).getUTCDay();
}

// Snap any YYYY-MM-DD to the Monday of the same Mon–Sun week.
// Mon → unchanged; Sun → Mon 6 days earlier (treats Sun as week-end).
function snapToMonday(yyyyMmDd: string): string {
  const wd = weekdayUtc(yyyyMmDd);
  // If Sunday (0), back up 6 days. Else back up (wd - 1) days.
  const offset = wd === 0 ? -6 : -(wd - 1);
  return addDays(yyyyMmDd, offset);
}

// Default week = the Monday of last week (the most recently completed
// Mon–Sun in Central time). On any day Mon–Sun, returns the prior
// Monday.
function defaultWeekStart(): string {
  const today = todayInCT();
  const thisMonday = snapToMonday(today);
  return addDays(thisMonday, -7);
}

function fmtMonthDay(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
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

// CSV — quote any field containing a comma, quote, or newline.
function csvCell(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildGustoCsv(payload: Payload): string {
  // Gusto bonus / off-cycle import — common columns:
  //   First Name, Last Name, Email, Earnings Type, Amount, Pay Date, Memo
  // Memo encodes match count + city for traceability when reconciling.
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
    for (const m of city.managers) {
      if (m.total === 0) continue;
      const [first, ...rest] = m.managerName.split(" ");
      const last = rest.join(" ");
      const memo = `${m.matchCount} match${m.matchCount === 1 ? "" : "es"} · ${city.cityIdentifier} · week of ${payload.weekStart}`;
      lines.push(
        [
          csvCell(first ?? ""),
          csvCell(last ?? ""),
          csvCell(m.managerEmail),
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
// View
// ---------------------------------------------------------------

export default function MatchManagerPayView() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const urlWeek = searchParams?.get("week") ?? null;
  const urlView = searchParams?.get("view") ?? null;

  const weekStart = useMemo(() => {
    if (urlWeek && /^\d{4}-\d{2}-\d{2}$/.test(urlWeek)) {
      // Snap to Monday in case a non-Monday slips into the URL.
      return snapToMonday(urlWeek);
    }
    return defaultWeekStart();
  }, [urlWeek]);

  const view: ViewMode = urlView === "table" ? "table" : "calendar";

  const setUrl = useCallback(
    (next: { week?: string; view?: ViewMode }) => {
      const qs = new URLSearchParams(searchParams?.toString() ?? "");
      if (next.week) qs.set("week", next.week);
      if (next.view) {
        if (next.view === "calendar") qs.delete("view");
        else qs.set("view", next.view);
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
        if (!token) throw new Error("No active session — please sign in again.");
        const res = await fetch(
          `/api/manager-pay/week?week=${encodeURIComponent(weekStart)}`,
          { headers: { Authorization: `Bearer ${token}` } },
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

  const onPrevWeek = () => setUrl({ week: addDays(weekStart, -7) });
  const onNextWeek = () => setUrl({ week: addDays(weekStart, 7) });
  const onThisWeek = () => setUrl({ week: defaultWeekStart() });

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
        alert("No active session. Sign in again.");
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
      // Re-fetch so totals reflect the new adjustment.
      setRefreshKey((k) => k + 1);
    },
    [weekStart],
  );

  const downloadGusto = () => {
    if (!payload) return;
    const csv = buildGustoCsv(payload);
    downloadCsv(`match-manager-pay-${payload.weekStart}.csv`, csv);
  };

  return (
    <>
      <div className="mb-6 text-sm">
        <Link
          href="/admin/finance"
          className="text-deep-green/60 transition hover:text-deep-green"
        >
          ← Back to Finance
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
            Match Manager Pay
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
            Computed from assigned matches · ≤22 max → $20, &gt;22 max → $30 ·
            both primary and secondary paid · Sunday + 4 = Thursday pay date.
          </p>
        </div>
      </div>

      {/* Controls row: week selector + view toggle + CSV download */}
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
          <button
            type="button"
            onClick={onThisWeek}
            className="ml-2 rounded-full border border-cream-line bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
          >
            Last completed
          </button>
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
          <button
            type="button"
            onClick={downloadGusto}
            disabled={!payload || payload.network.total === 0}
            className="rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
          >
            ↓ Gusto CSV
          </button>
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
          {/* Network summary tiles */}
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Matches" value={String(payload.network.matchCount)} />
            <Tile
              label="Managers paid"
              value={String(payload.network.managerCount)}
            />
            <Tile
              label="Base pay"
              value={formatMoney(payload.network.baseTotal)}
            />
            <Tile
              label="Total payout"
              value={formatMoney(payload.network.total)}
              accent
            />
          </div>

          {payload.cities.length === 0 ? (
            <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
              No matches assigned this week.
            </div>
          ) : view === "calendar" ? (
            <CalendarView payload={payload} onSaveAdjustment={onSaveAdjustment} />
          ) : (
            <TableView payload={payload} onSaveAdjustment={onSaveAdjustment} />
          )}
        </>
      )}
    </>
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
        accent
          ? "border-mint bg-mint/15"
          : "border-cream-line bg-white"
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
// Calendar view — per-city sections, manager rows expand to show
// their assigned matches.
// ---------------------------------------------------------------

function CalendarView({
  payload,
  onSaveAdjustment,
}: {
  payload: Payload;
  onSaveAdjustment: (
    managerEmail: string,
    managerId: number | null,
    amount: number,
    notes: string | null,
  ) => Promise<void>;
}) {
  return (
    <div className="space-y-8">
      {payload.cities.map((city) => (
        <section key={city.cityIdentifier}>
          <div className="mb-3 flex items-stretch gap-3">
            <span aria-hidden className="w-1 rounded-full bg-mint" />
            <div className="flex-1 py-0.5">
              <h2 className="text-2xl font-bold tracking-tight text-deep-green">
                {city.cityIdentifier}
              </h2>
              <p className="mt-0.5 text-sm text-deep-green/60">
                {city.managers.length} manager{city.managers.length === 1 ? "" : "s"}
                {" · "}
                {city.matchCount} match{city.matchCount === 1 ? "" : "es"}
                {" · "}
                {formatMoney(city.total)} total
              </p>
            </div>
          </div>

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
                    key={m.managerEmail}
                    manager={m}
                    isLast={idx === city.managers.length - 1}
                    onSaveAdjustment={onSaveAdjustment}
                  />
                ))}
                <tr className="border-t-2 border-cream-line bg-cream-soft/50 font-bold text-deep-green">
                  <td className="px-4 py-2 text-right">{city.cityIdentifier} total</td>
                  <td className="px-4 py-2 text-right">{city.matchCount}</td>
                  <td className="px-4 py-2 text-right">{formatMoney(city.baseTotal)}</td>
                  <td className="px-4 py-2 text-right">{formatMoney(city.adjustment)}</td>
                  <td className="px-4 py-2 text-right">{formatMoney(city.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function ManagerRowExpandable({
  manager,
  isLast,
  onSaveAdjustment,
}: {
  manager: ManagerRow;
  isLast: boolean;
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
            <span aria-hidden className="mr-1 inline-block w-3 text-deep-green/40">
              {open ? "▾" : "▸"}
            </span>
            {manager.managerName}
          </div>
          <div className="text-[11px] text-deep-green/55">
            {manager.managerEmail}
          </div>
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
          <AdjustmentInput
            initialAmount={manager.adjustment}
            initialNotes={manager.adjustmentNotes}
            onSave={(amount, notes) =>
              onSaveAdjustment(
                manager.managerEmail,
                manager.managerId,
                amount,
                notes,
              )
            }
          />
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
  // Sync external changes (e.g. after refetch) back into the input.
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
// Table view — flat sortable network-wide list.
// ---------------------------------------------------------------

type SortKey =
  | "name"
  | "city"
  | "matchCount"
  | "baseTotal"
  | "adjustment"
  | "total";

function TableView({
  payload,
  onSaveAdjustment,
}: {
  payload: Payload;
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
    () => payload.cities.flatMap((c) => c.managers),
    [payload],
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
            <SortHeader
              label="City"
              active={sortKey === "city"}
              onClick={() => onHeader("city")}
              align="left"
              arrow={arrow("city")}
            />
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
              key={m.managerEmail}
              className={
                i === sorted.length - 1
                  ? ""
                  : "border-b border-cream-line/60"
              }
            >
              <td className="px-4 py-2 align-top">
                <div className="font-bold text-deep-green">
                  {m.managerName}
                </div>
                <div className="text-[11px] text-deep-green/55">
                  {m.managerEmail}
                </div>
              </td>
              <td className="px-4 py-2 align-top text-deep-green/80">
                {m.cityIdentifier ?? "—"}
              </td>
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
                <AdjustmentInput
                  initialAmount={m.adjustment}
                  initialNotes={m.adjustmentNotes}
                  onSave={(amount, notes) =>
                    onSaveAdjustment(
                      m.managerEmail,
                      m.managerId,
                      amount,
                      notes,
                    )
                  }
                />
              </td>
              <td className="px-4 py-2 text-right align-top font-bold tabular-nums text-deep-green">
                {formatMoney(m.total)}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-cream-line bg-cream-soft/50 font-bold text-deep-green">
            <td className="px-4 py-2 text-right" colSpan={2}>
              Network total
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {payload.network.matchCount}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {formatMoney(payload.network.baseTotal)}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {formatMoney(payload.network.adjustment)}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">
              {formatMoney(payload.network.total)}
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
