"use client";

import { useEffect, useMemo, useRef } from "react";
import { Pin } from "lucide-react";
import type {
  FinSchedule,
  FinVenue,
  FinVenueCostOverride,
} from "@/lib/useFinanceData";
import type { Q2Month } from "@/lib/financeStats";

type MonthFilter = Q2Month | "ALL" | "RANGE";

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const DAY_OF_WEEK_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const ATH_KATY_PRIMARY = "ATH Katy";
const ATH_KATY_SUNDAY = "ATH Katy Sunday";

type VenueRow = {
  key: string;
  displayName: string;
  city: string;
  primaryVenue: FinVenue;
  sundayVenue: FinVenue | null;
  // venue_name strings used to look up rows in fin_schedule (which keys by string)
  scheduleNames: string[];
  // venue_ids used for override lookup
  venueIds: number[];
};

type CellRows = {
  rows: FinSchedule[];
  matchCount: number;
  hasManual: boolean;
};

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function monthFromDate(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-/);
  if (!m) return "";
  const idx = parseInt(m[2], 10) - 1;
  if (idx < 0 || idx > 11) return "";
  return `${MONTH_LABELS[idx]} ${m[1]}`;
}

function generateDates(
  monthFilter: MonthFilter,
  rangeFrom: string,
  rangeTo: string,
): string[] {
  if (monthFilter === "RANGE") {
    return generateDateRange(rangeFrom, rangeTo);
  }
  if (monthFilter === "ALL") {
    return generateDateRange("2026-04-01", "2026-06-30");
  }
  const m = monthFilter.match(/^(\w+)\s+(\d{4})$/);
  if (!m) return [];
  const monthIdx = MONTH_LABELS.indexOf(m[1]);
  if (monthIdx < 0) return [];
  const year = parseInt(m[2], 10);
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  const out: string[] = [];
  for (let d = 1; d <= lastDay; d++) {
    out.push(
      `${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    );
  }
  return out;
}

function generateDateRange(from: string, to: string): string[] {
  if (!from || !to) return [];
  const fromD = new Date(from + "T00:00:00");
  const toD = new Date(to + "T00:00:00");
  if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) return [];
  if (fromD > toD) return [];
  const out: string[] = [];
  const cur = new Date(fromD);
  while (cur <= toD) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const d = String(cur.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function getDayOfWeek(date: string): number {
  return new Date(date + "T00:00:00").getDay();
}

function isWeekend(date: string): boolean {
  const day = getDayOfWeek(date);
  return day === 0 || day === 6;
}

function shortMonthDay(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  const idx = parseInt(m[2], 10) - 1;
  return `${MONTH_LABELS[idx]} ${parseInt(m[3], 10)}`;
}

function buildVenueRows(venues: FinVenue[]): VenueRow[] {
  const out: VenueRow[] = [];
  const skip = new Set<number>();
  const primary = venues.find((v) => v.venue_name === ATH_KATY_PRIMARY);
  const sunday = venues.find((v) => v.venue_name === ATH_KATY_SUNDAY);
  const sortedVenues = [...venues].sort((a, b) =>
    a.city === b.city
      ? a.venue_name.localeCompare(b.venue_name)
      : a.city.localeCompare(b.city),
  );

  for (const v of sortedVenues) {
    if (skip.has(v.id)) continue;
    if (primary && sunday && v.id === primary.id) {
      skip.add(sunday.id);
      out.push({
        key: `combined-${primary.id}`,
        displayName: ATH_KATY_PRIMARY,
        city: primary.city,
        primaryVenue: primary,
        sundayVenue: sunday,
        scheduleNames: [primary.venue_name, sunday.venue_name],
        venueIds: [primary.id, sunday.id],
      });
      continue;
    }
    if (sunday && v.id === sunday.id) {
      // Already absorbed into primary if both exist; keep solo if primary missing
      if (primary) continue;
    }
    out.push({
      key: `single-${v.id}`,
      displayName: v.venue_name,
      city: v.city,
      primaryVenue: v,
      sundayVenue: null,
      scheduleNames: [v.venue_name],
      venueIds: [v.id],
    });
  }
  return out;
}

export default function BillingScheduleCalendar({
  rows,
  venues,
  overrides,
  monthFilter,
  rangeFrom,
  rangeTo,
  cityFilter,
  venueFilter,
  hideEmptyVenues,
  onEditRow,
  onAddCell,
}: {
  rows: FinSchedule[];
  venues: FinVenue[];
  overrides: FinVenueCostOverride[];
  monthFilter: MonthFilter;
  rangeFrom: string;
  rangeTo: string;
  cityFilter: string;
  venueFilter: string;
  hideEmptyVenues: boolean;
  onEditRow: (row: FinSchedule) => void;
  onAddCell: (venue: FinVenue, date: string) => void;
}) {
  const dates = useMemo(
    () => generateDates(monthFilter, rangeFrom, rangeTo),
    [monthFilter, rangeFrom, rangeTo],
  );

  const venueRows = useMemo(() => {
    let vs = buildVenueRows(venues);
    if (cityFilter !== "All") vs = vs.filter((r) => r.city === cityFilter);
    if (venueFilter !== "All")
      vs = vs.filter(
        (r) => r.scheduleNames.includes(venueFilter) || r.displayName === venueFilter,
      );
    return vs;
  }, [venues, cityFilter, venueFilter]);

  // Index rows by (venue_name, date) for O(1) cell lookup.
  const byKey = useMemo(() => {
    const map = new Map<string, FinSchedule[]>();
    for (const r of rows) {
      const k = `${r.venue}|${r.date}`;
      const arr = map.get(k);
      if (arr) arr.push(r);
      else map.set(k, [r]);
    }
    return map;
  }, [rows]);

  // Index overrides by venue_id for the gold-dot indicator. Only the months
  // we render are relevant.
  const overrideMonthSet = useMemo(() => {
    const months = new Set<string>();
    for (const d of dates) months.add(monthFromDate(d));
    return months;
  }, [dates]);
  const overrideByVenue = useMemo(() => {
    const map = new Map<number, Set<string>>();
    for (const o of overrides) {
      if (!overrideMonthSet.has(o.month)) continue;
      let set = map.get(o.venue_id);
      if (!set) {
        set = new Set();
        map.set(o.venue_id, set);
      }
      set.add(o.month);
    }
    return map;
  }, [overrides, overrideMonthSet]);

  const cellLookup = (venueRow: VenueRow, date: string): CellRows => {
    let matchCount = 0;
    const rowList: FinSchedule[] = [];
    let hasManual = false;
    for (const name of venueRow.scheduleNames) {
      const k = `${name}|${date}`;
      const found = byKey.get(k);
      if (!found) continue;
      for (const f of found) {
        matchCount += f.match_count ?? 0;
        rowList.push(f);
        if (f.manual_entry) hasManual = true;
      }
    }
    return { rows: rowList, matchCount, hasManual };
  };

  const visibleRows = useMemo(() => {
    if (!hideEmptyVenues) return venueRows;
    return venueRows.filter((vr) =>
      dates.some((d) => cellLookup(vr, d).matchCount > 0),
    );
  }, [venueRows, dates, hideEmptyVenues, byKey]);

  const dailyTotals = useMemo(() => {
    return dates.map((date) =>
      visibleRows.reduce((sum, vr) => sum + cellLookup(vr, date).matchCount, 0),
    );
  }, [dates, visibleRows, byKey]);

  function clickCell(venueRow: VenueRow, date: string) {
    const cell = cellLookup(venueRow, date);
    if (cell.rows.length > 0) {
      onEditRow(cell.rows[0]);
      return;
    }
    // Empty cell → Add modal. For combined rows, route to leg by day-of-week.
    let target = venueRow.primaryVenue;
    if (venueRow.sundayVenue && getDayOfWeek(date) === 0) {
      target = venueRow.sundayVenue;
    }
    onAddCell(target, date);
  }

  // "Today" button — scroll to current date's column.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const today = todayIso();
  const todayIdx = dates.indexOf(today);

  useEffect(() => {
    if (todayIdx < 0 || !scrollerRef.current) return;
    const target = scrollerRef.current.querySelector<HTMLElement>(
      `[data-date="${today}"]`,
    );
    if (target) {
      target.scrollIntoView({
        behavior: "auto",
        block: "nearest",
        inline: "center",
      });
    }
  }, [todayIdx, today]);

  if (dates.length === 0) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-center text-sm text-deep-green/55 shadow-md shadow-deep-green/10">
        Pick a month or a custom range to see the calendar.
      </div>
    );
  }

  if (visibleRows.length === 0) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-center text-sm text-deep-green/55 shadow-md shadow-deep-green/10">
        No venues match these filters.
      </div>
    );
  }

  // Layout via CSS grid: 200px label column + N×60px date columns.
  const colTemplate = `200px repeat(${dates.length}, 60px)`;

  return (
    <div className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div className="flex items-center justify-between gap-2 border-b border-cream-line bg-cream-soft px-4 py-2 text-[11px] text-deep-green/65">
        <div>
          <span className="font-mono font-bold tabular-nums">
            {visibleRows.length}
          </span>{" "}
          venue{visibleRows.length === 1 ? "" : "s"} ·{" "}
          <span className="font-mono font-bold tabular-nums">
            {dates.length}
          </span>{" "}
          day{dates.length === 1 ? "" : "s"}
        </div>
        {todayIdx >= 0 && (
          <button
            type="button"
            onClick={() => {
              const target = scrollerRef.current?.querySelector<HTMLElement>(
                `[data-date="${today}"]`,
              );
              target?.scrollIntoView({
                behavior: "smooth",
                block: "nearest",
                inline: "center",
              });
            }}
            className="rounded-full border border-cream-line bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-deep-green hover:bg-cream"
          >
            Today
          </button>
        )}
      </div>
      <div ref={scrollerRef} className="overflow-x-auto overflow-y-clip">
        {/* Header row */}
        <div
          className="sticky top-0 z-30 grid"
          style={{ gridTemplateColumns: colTemplate }}
        >
          <div className="sticky left-0 z-40 border-b border-r border-cream-line bg-cream-soft px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-deep-green/65">
            Venue
          </div>
          {dates.map((date) => {
            const dow = getDayOfWeek(date);
            const isWeekendDay = isWeekend(date);
            const isToday = date === today;
            return (
              <div
                key={date}
                data-date={date}
                className={`border-b border-cream-line px-1 py-1.5 text-center ${
                  isWeekendDay ? "bg-gold-soft/40" : "bg-cream-soft"
                } ${isToday ? "ring-2 ring-mint/60 ring-inset" : ""}`}
              >
                <div className="text-[9px] font-bold uppercase tracking-wider text-deep-green/55">
                  {DAY_OF_WEEK_LABELS[dow]}
                </div>
                <div
                  className={`text-[10px] font-bold tabular-nums ${
                    isToday ? "text-mint-hover" : "text-deep-green"
                  }`}
                >
                  {shortMonthDay(date)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Body rows */}
        {visibleRows.map((vr) => {
          const venueOverrideMonths = overrideByVenue.get(vr.primaryVenue.id);
          return (
            <div
              key={vr.key}
              className="grid border-b border-cream-line/40"
              style={{ gridTemplateColumns: colTemplate }}
            >
              <div className="sticky left-0 z-20 border-r border-cream-line bg-white px-4 py-2">
                <div className="font-display text-base uppercase leading-tight tracking-tight text-deep-green">
                  {vr.displayName}
                  {vr.sundayVenue && (
                    <span className="ml-1 text-[9px] font-normal lowercase tracking-normal text-deep-green/45">
                      (combined)
                    </span>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-deep-green/55">
                  {vr.city}
                </div>
              </div>
              {dates.map((date) => {
                const cell = cellLookup(vr, date);
                const isToday = date === today;
                const isWeekendDay = isWeekend(date);
                const month = monthFromDate(date);
                const hasOverride = venueOverrideMonths?.has(month) ?? false;
                return (
                  <CalendarCell
                    key={date}
                    matchCount={cell.matchCount}
                    hasManual={cell.hasManual}
                    hasOverride={hasOverride}
                    isToday={isToday}
                    isWeekend={isWeekendDay}
                    venueName={vr.displayName}
                    date={date}
                    onClick={() => clickCell(vr, date)}
                  />
                );
              })}
            </div>
          );
        })}

        {/* Daily totals (sticky bottom) */}
        <div
          className="sticky bottom-0 z-30 grid border-t-2 border-deep-green/20 bg-cream-soft"
          style={{ gridTemplateColumns: colTemplate }}
        >
          <div className="sticky left-0 z-40 border-r border-cream-line bg-cream-soft px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-deep-green/65">
            Daily Total
          </div>
          {dates.map((date, i) => {
            const total = dailyTotals[i];
            const isToday = date === today;
            return (
              <div
                key={date}
                className={`flex items-center justify-center px-1 py-2 text-xs font-bold tabular-nums ${
                  isToday ? "text-mint-hover" : "text-deep-green"
                } ${total === 0 ? "text-deep-green/30" : ""}`}
              >
                {total === 0 ? "—" : total}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CalendarCell({
  matchCount,
  hasManual,
  hasOverride,
  isToday,
  isWeekend,
  venueName,
  date,
  onClick,
}: {
  matchCount: number;
  hasManual: boolean;
  hasOverride: boolean;
  isToday: boolean;
  isWeekend: boolean;
  venueName: string;
  date: string;
  onClick: () => void;
}) {
  // Cell color intensity by match count.
  const pillCls =
    matchCount === 0
      ? ""
      : matchCount === 1
        ? "bg-mint-soft text-deep-green"
        : matchCount === 2
          ? "bg-mint/60 text-deep-green"
          : matchCount === 3
            ? "bg-mint text-deep-green font-bold"
            : "bg-deep-green text-mint font-bold";
  const display =
    matchCount === 0
      ? "—"
      : matchCount > 5
        ? `${matchCount}`
        : `${matchCount}`;
  const titleParts = [venueName, shortMonthDay(date)];
  if (matchCount > 0) {
    titleParts.push(
      `${matchCount} match${matchCount === 1 ? "" : "es"}`,
    );
    if (hasManual) titleParts.push("manual");
    if (hasOverride) titleParts.push("override active this month");
    titleParts.push("click to edit");
  } else {
    titleParts.push("click to add a match");
  }
  const title = titleParts.join(" · ");

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`relative flex h-12 items-center justify-center border-r border-cream-line/30 px-1 text-xs transition-all hover:bg-cream-soft/80 hover:shadow-inner ${
        isWeekend ? "bg-gold-soft/15" : "bg-white"
      } ${isToday ? "ring-1 ring-mint/40 ring-inset" : ""}`}
    >
      {matchCount === 0 ? (
        <span className="text-deep-green/30">{display}</span>
      ) : (
        <span
          className={`inline-flex min-w-[28px] items-center justify-center rounded-md px-1.5 py-0.5 text-xs tabular-nums ${pillCls}`}
        >
          {display}
        </span>
      )}
      {hasManual && (
        <Pin
          size={9}
          aria-hidden
          className="absolute right-0.5 top-0.5 text-mint-hover"
        />
      )}
      {hasOverride && (
        <span
          aria-hidden
          className="absolute left-1 top-1 inline-block h-1.5 w-1.5 rounded-full bg-gold"
        />
      )}
    </button>
  );
}
