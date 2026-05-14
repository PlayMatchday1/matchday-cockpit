"use client";

// Field Ranking → Period Compare table. Cross-quarter view: ignores
// the FinanceQuarterProvider value entirely. Reads venues + DPP
// revenue + member-booking registrations and builds a per-venue ×
// per-period grid with TWO sub-columns each (DPP $ and Member
// Bookings count), plus MoM/WoW deltas.
//
// Sticky venue column on horizontal scroll: position: sticky;
// left: 0; bg-white; z-index: 5 on every td in the venue column.
// Same trick in the header cell. Works in every modern browser
// without a JS scroll listener.
//
// Sort: clicking any column header (period-DPP, period-Bookings, or
// the venue/city columns) re-sorts the rows. Default sort is the
// current/most-recent period's DPP column, desc.

import { useMemo, useState } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import { buildFieldToVenueIdMap } from "@/lib/venueNormalization";
import {
  aggregateDppByVenue,
  aggregateMemberBookingsByVenue,
  computeDelta,
  generateMonthlyPeriods,
  generateWeeklyPeriods,
  periodColumnTotal,
  type Period,
  type VenuePeriodTable,
} from "@/lib/periodCompare";

export type PeriodMode = "monthly" | "weekly";

function fmtMoney(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "—";
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : ""}$${abs.toLocaleString("en-US")}`;
}

function fmtCount(n: number): string {
  if (n === 0) return "—";
  return n.toLocaleString("en-US");
}

function fmtDeltaPct(pct: number | null): {
  text: string;
  className: string;
} {
  if (pct === null) {
    return { text: "", className: "text-deep-green/40" };
  }
  if (pct === 0) {
    return { text: "0%", className: "text-deep-green/40" };
  }
  const sign = pct > 0 ? "+" : "";
  return {
    text: `${sign}${pct}%`,
    className: pct > 0 ? "text-mint-hover" : "text-coral",
  };
}

type RowKey = "venue" | string; // "venue" or period-key prefixed with "dpp:" or "mbr:"
type SortDir = "asc" | "desc";

export default function PeriodComparePanel({
  mode,
  onModeChange,
}: {
  mode: PeriodMode;
  onModeChange: (next: PeriodMode) => void;
}) {
  const { data } = useFinanceData();
  const { rows: matchRegistrations } = useMatchData();

  // Periods + aggregations recompute when the mode flips. `new Date()`
  // is evaluated once per mount; an explicit re-render is required to
  // pick up a new "today" — fine, the page reloads daily anyway, and
  // the wall-clock-stable date math doesn't drift mid-session.
  const periods = useMemo<Period[]>(
    () => (mode === "monthly" ? generateMonthlyPeriods() : generateWeeklyPeriods()),
    [mode],
  );

  const venueCanonicalByField = useMemo(() => {
    if (!data) return new Map<string, string>();
    const fields = new Set<string>();
    for (const r of matchRegistrations) if (r.field) fields.add(r.field);
    const fieldToVenueId = buildFieldToVenueIdMap(
      fields,
      data.venues,
      data.venueAliases,
    );
    const venueNameById = new Map(data.venues.map((v) => [v.id, v.venue_name]));
    const out = new Map<string, string>();
    for (const [field, vid] of fieldToVenueId.entries()) {
      const name = venueNameById.get(vid);
      if (name) out.set(field, name);
    }
    return out;
  }, [data, matchRegistrations]);

  const dppTable: VenuePeriodTable = useMemo(() => {
    if (!data) return { byVenue: new Map(), venues: new Set() };
    return aggregateDppByVenue(data.revenue, periods);
  }, [data, periods]);

  const mbrTable: VenuePeriodTable = useMemo(
    () =>
      aggregateMemberBookingsByVenue(
        matchRegistrations,
        periods,
        venueCanonicalByField,
      ),
    [matchRegistrations, periods, venueCanonicalByField],
  );

  // City lookup so each row can show the venue's city. Per-venue
  // city comes from data.venues; for venues that appear only in
  // matchRegistrations (i.e., not yet in fin_venues), city is "—".
  const cityByVenue = useMemo(() => {
    if (!data) return new Map<string, string>();
    return new Map(data.venues.map((v) => [v.venue_name, v.city]));
  }, [data]);

  // Default sort: current-period DPP descending. Sort key is either
  // "venue", "city", or "dpp:<periodKey>" / "mbr:<periodKey>".
  const currentPeriod = periods[periods.length - 1];
  const [sortKey, setSortKey] = useState<RowKey>(`dpp:${currentPeriod.key}`);
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function toggleSort(key: RowKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      // Numeric columns default to desc on first click (high → low
      // is the more useful default for revenue/bookings); text
      // columns default to asc.
      setSortDir(key === "venue" || key === "city" ? "asc" : "desc");
    }
  }

  // Build the row set: union of venues across both tables.
  const allVenues = useMemo(() => {
    const s = new Set<string>();
    for (const v of dppTable.venues) s.add(v);
    for (const v of mbrTable.venues) s.add(v);
    return [...s];
  }, [dppTable, mbrTable]);

  const sortedVenues = useMemo(() => {
    const arr = [...allVenues];
    arr.sort((a, b) => {
      if (sortKey === "venue") {
        return sortDir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
      }
      if (sortKey === "city") {
        const ac = cityByVenue.get(a) ?? "";
        const bc = cityByVenue.get(b) ?? "";
        return sortDir === "asc" ? ac.localeCompare(bc) : bc.localeCompare(ac);
      }
      const [metric, periodKey] = sortKey.split(":") as ["dpp" | "mbr", string];
      const table = metric === "dpp" ? dppTable : mbrTable;
      const av = table.byVenue.get(a)?.get(periodKey) ?? 0;
      const bv = table.byVenue.get(b)?.get(periodKey) ?? 0;
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return arr;
  }, [allVenues, sortKey, sortDir, dppTable, mbrTable, cityByVenue]);

  if (!data) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading…
      </div>
    );
  }

  if (allVenues.length === 0) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        No venues with revenue or member bookings in the selected
        period set.
      </div>
    );
  }

  const deltaLabel = mode === "monthly" ? "MoM" : "WoW";

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="font-display text-3xl uppercase tracking-tight text-deep-green md:text-4xl">
            Period Compare
          </h2>
          <p className="text-xs text-deep-green/60">
            Per-venue DPP $ and member bookings, side-by-side across
            {" "}{mode === "monthly" ? "5 same-day-of-month windows" : "the last 8 ISO weeks"}.
            Quarter selector is ignored.
          </p>
        </div>
        <div className="inline-flex rounded-full border border-cream-line bg-cream-soft p-0.5 text-xs font-bold">
          {(["monthly", "weekly"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => onModeChange(opt)}
              className={`rounded-full px-4 py-1.5 transition ${
                mode === opt
                  ? "bg-mint text-deep-green"
                  : "text-deep-green/65 hover:text-deep-green"
              }`}
              aria-pressed={mode === opt}
            >
              {opt === "monthly" ? "Monthly" : "Weekly"}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
            {/* Top row: period labels, each spanning 2 sub-columns */}
            <tr className="border-y border-cream-line">
              <th
                className="sticky left-0 z-20 bg-cream-soft px-3 py-2 text-left"
                rowSpan={2}
              >
                <button
                  type="button"
                  onClick={() => toggleSort("venue")}
                  className={`cursor-pointer select-none hover:text-deep-green ${
                    sortKey === "venue" ? "text-deep-green" : ""
                  }`}
                >
                  Venue {sortKey === "venue" ? (sortDir === "desc" ? "↓" : "↑") : ""}
                </button>
              </th>
              <th className="px-3 py-2 text-left" rowSpan={2}>
                <button
                  type="button"
                  onClick={() => toggleSort("city")}
                  className={`cursor-pointer select-none hover:text-deep-green ${
                    sortKey === "city" ? "text-deep-green" : ""
                  }`}
                >
                  City {sortKey === "city" ? (sortDir === "desc" ? "↓" : "↑") : ""}
                </button>
              </th>
              {periods.map((p) => (
                <th
                  key={p.key}
                  colSpan={2}
                  className={`border-l border-cream-line px-3 py-2 text-center ${
                    p.inProgress ? "bg-mint-soft/40" : ""
                  }`}
                >
                  <div className="text-[11px] text-deep-green">{p.label}</div>
                  {p.inProgress && (
                    <div className="text-[9px] font-normal normal-case text-deep-green/55">
                      {mode === "weekly" && p.daysElapsed
                        ? `in progress, ${p.daysElapsed} of 7 days`
                        : "in progress"}
                    </div>
                  )}
                </th>
              ))}
            </tr>
            {/* Sub-header row: DPP $ / Members under each period */}
            <tr className="border-b border-cream-line">
              {periods.map((p) => {
                const dppKey: RowKey = `dpp:${p.key}`;
                const mbrKey: RowKey = `mbr:${p.key}`;
                return (
                  <Sub key={p.key}>
                    <th
                      className={`border-l border-cream-line px-3 py-1.5 text-right ${
                        sortKey === dppKey
                          ? "bg-cream text-deep-green"
                          : "cursor-pointer hover:bg-cream"
                      }`}
                      onClick={() => toggleSort(dppKey)}
                    >
                      DPP $ {sortKey === dppKey ? (sortDir === "desc" ? "↓" : "↑") : ""}
                    </th>
                    <th
                      className={`px-3 py-1.5 text-right ${
                        sortKey === mbrKey
                          ? "bg-cream text-deep-green"
                          : "cursor-pointer hover:bg-cream"
                      }`}
                      onClick={() => toggleSort(mbrKey)}
                    >
                      Mbr Bookings {sortKey === mbrKey ? (sortDir === "desc" ? "↓" : "↑") : ""}
                    </th>
                  </Sub>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedVenues.map((venue) => (
              <VenueRow
                key={venue}
                venue={venue}
                city={cityByVenue.get(venue) ?? "—"}
                periods={periods}
                dppTable={dppTable}
                mbrTable={mbrTable}
                deltaLabel={deltaLabel}
              />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-[1.5px] border-cream-line bg-cream-soft/60 text-xs font-bold text-deep-green">
              <td className="sticky left-0 z-20 bg-cream-soft/60 px-3 py-2.5">
                Total ({sortedVenues.length} venues)
              </td>
              <td className="px-3 py-2.5"></td>
              {periods.map((p) => {
                const dppTot = periodColumnTotal(dppTable, p.key);
                const mbrTot = periodColumnTotal(mbrTable, p.key);
                return (
                  <Sub key={p.key}>
                    <td className="border-l border-cream-line px-3 py-2.5 text-right font-mono tabular-nums">
                      {fmtMoney(dppTot)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      {fmtCount(mbrTot)}
                    </td>
                  </Sub>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

// Render a fragment of <td>/<th> children. Used to group the
// DPP/Members pair under each period without introducing a wrapper
// element (would break table structure).
function Sub({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function VenueRow({
  venue,
  city,
  periods,
  dppTable,
  mbrTable,
  deltaLabel,
}: {
  venue: string;
  city: string;
  periods: Period[];
  dppTable: VenuePeriodTable;
  mbrTable: VenuePeriodTable;
  deltaLabel: string;
}) {
  return (
    <tr className="border-t border-cream-line/40 text-deep-green hover:bg-cream-soft/40">
      <td className="sticky left-0 z-10 bg-white px-3 py-2.5 font-bold">
        {venue}
      </td>
      <td className="px-3 py-2.5 text-deep-green/75">{city}</td>
      {periods.map((p, i) => {
        const prior = i === 0 ? null : periods[i - 1];
        const dpp = dppTable.byVenue.get(venue)?.get(p.key) ?? 0;
        const dppPrior = prior
          ? (dppTable.byVenue.get(venue)?.get(prior.key) ?? 0)
          : null;
        const dppDelta = computeDelta(dpp, dppPrior);
        const dppLabel = fmtDeltaPct(dppDelta.pct);

        const mbr = mbrTable.byVenue.get(venue)?.get(p.key) ?? 0;
        const mbrPrior = prior
          ? (mbrTable.byVenue.get(venue)?.get(prior.key) ?? 0)
          : null;
        const mbrDelta = computeDelta(mbr, mbrPrior);
        const mbrLabel = fmtDeltaPct(mbrDelta.pct);

        return (
          <Sub key={p.key}>
            <td
              className={`border-l border-cream-line px-3 py-2.5 text-right font-mono tabular-nums ${
                p.inProgress ? "bg-mint-soft/20" : ""
              }`}
              title={prior ? `${deltaLabel} vs ${prior.label}` : undefined}
            >
              {fmtMoney(dpp)}
              {dppLabel.text && (
                <span className={`ml-1.5 text-[10px] font-bold ${dppLabel.className}`}>
                  {dppLabel.text}
                </span>
              )}
            </td>
            <td
              className={`px-3 py-2.5 text-right font-mono tabular-nums ${
                p.inProgress ? "bg-mint-soft/20" : ""
              }`}
              title={prior ? `${deltaLabel} vs ${prior.label}` : undefined}
            >
              {fmtCount(mbr)}
              {mbrLabel.text && (
                <span className={`ml-1.5 text-[10px] font-bold ${mbrLabel.className}`}>
                  {mbrLabel.text}
                </span>
              )}
            </td>
          </Sub>
        );
      })}
    </tr>
  );
}
