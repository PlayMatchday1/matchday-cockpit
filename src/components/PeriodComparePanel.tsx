"use client";

// Field Ranking → Period Compare table. Cross-quarter view: ignores
// the FinanceQuarterProvider value entirely. One column per period
// (5 monthly or 8 weekly). Each cell stacks DPP $ (hero) over the
// member-bookings count with an explicit " mbr" unit suffix so the
// count can't be misread as dollars. Inline MoM/WoW % deltas live
// next to their value on the same line.
//
// Sticky venue column on horizontal scroll: position: sticky;
// left: 0; bg-white; z-index: 5 on every td in the venue column.
// Same trick in the header cell. Works in every modern browser
// without a JS scroll listener.
//
// Sort: clicking a period header sorts by that period's DPP $.
// Clicking the Venue header sorts alpha by venue. Default is the
// current/most-recent period's DPP, desc.
//
// "Inactive" venues (no DPP $ and no member bookings in any period
// in the visible window) are hidden by default; a toggle above the
// table reveals them. Anchors the table on venues that actually
// moved so the eye doesn't have to skip past dead rows.

import { useMemo, useState } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import { CITIES } from "@/lib/types";
import { buildFieldIdToVenueIdMap } from "@/lib/venueNormalization";
import {
  aggregateDppByVenue,
  aggregateMemberBookingsByVenue,
  aggregateMembershipByCity,
  computeDelta,
  generateMonthlyPeriods,
  generateWeeklyPeriods,
  membershipCityColumnTotal,
  periodColumnTotal,
  type MembershipByCity,
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

// Always include the " mbr" suffix — it's the labeled unit that
// prevents the count from being read as dollars.
function fmtMbr(n: number): string {
  if (n === 0) return "— mbr";
  return `${n.toLocaleString("en-US")} mbr`;
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

type VenueSortKey = "venue" | string; // "venue" or "dpp:<periodKey>"
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

  // PR-E: build the field-title → canonical-venue-name display map
  // by going field_id → fin_venue_id → fin_venues.venue_name. Output
  // shape (Map<field_title, venue_name>) is preserved so downstream
  // string-keyed aggregations are unchanged; only the resolution
  // path moves from name canonicalization to fin_venue_fields.
  const venueCanonicalByField = useMemo(() => {
    if (!data) return new Map<string, string>();
    const fieldIds = new Set<number>();
    for (const r of matchRegistrations) {
      if (r.fieldId != null) fieldIds.add(r.fieldId);
    }
    const fieldIdToVenueId = buildFieldIdToVenueIdMap(fieldIds, data.venueFields);
    const venueNameById = new Map(data.venues.map((v) => [v.id, v.venue_name]));
    const out = new Map<string, string>();
    for (const r of matchRegistrations) {
      if (r.fieldId == null || !r.field) continue;
      const vid = fieldIdToVenueId.get(r.fieldId);
      if (vid == null) continue;
      const name = venueNameById.get(vid);
      if (name) out.set(r.field, name);
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

  // City lookup so each row can show the venue's city under the
  // venue name. For venues that appear only in matchRegistrations
  // (not yet in fin_venues), city is "—".
  const cityByVenue = useMemo(() => {
    if (!data) return new Map<string, string>();
    return new Map(data.venues.map((v) => [v.venue_name, v.city]));
  }, [data]);

  // Default sort: current-period DPP descending. Sort key is either
  // "venue" or "dpp:<periodKey>".
  const currentPeriod = periods[periods.length - 1];
  const [sortKey, setSortKey] = useState<VenueSortKey>(`dpp:${currentPeriod.key}`);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showInactive, setShowInactive] = useState(false);

  function toggleSort(key: VenueSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      // Numeric defaults desc on first click; venue (text) defaults asc.
      setSortDir(key === "venue" ? "asc" : "desc");
    }
  }

  // Row set: union of venues across both tables.
  const allVenues = useMemo(() => {
    const s = new Set<string>();
    for (const v of dppTable.venues) s.add(v);
    for (const v of mbrTable.venues) s.add(v);
    return [...s];
  }, [dppTable, mbrTable]);

  // Active = at least one period has DPP $ > 0 or member bookings > 0.
  // Inactives are hidden by default so the table anchors on venues
  // with movement.
  const activeVenues = useMemo(() => {
    return allVenues.filter((v) => {
      for (const p of periods) {
        const dpp = dppTable.byVenue.get(v)?.get(p.key) ?? 0;
        const mbr = mbrTable.byVenue.get(v)?.get(p.key) ?? 0;
        if (dpp > 0 || mbr > 0) return true;
      }
      return false;
    });
  }, [allVenues, dppTable, mbrTable, periods]);

  const inactiveCount = allVenues.length - activeVenues.length;

  const sortedVenues = useMemo(() => {
    const base = showInactive ? allVenues : activeVenues;
    const arr = [...base];
    arr.sort((a, b) => {
      if (sortKey === "venue") {
        return sortDir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
      }
      const periodKey = sortKey.slice("dpp:".length);
      const av = dppTable.byVenue.get(a)?.get(periodKey) ?? 0;
      const bv = dppTable.byVenue.get(b)?.get(periodKey) ?? 0;
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return arr;
  }, [showInactive, allVenues, activeVenues, sortKey, sortDir, dppTable]);

  // === Membership by City ===
  const membership: MembershipByCity = useMemo(() => {
    if (!data) return { byCity: new Map(), deletedAccount: new Map(), citiesPresent: new Set() };
    return aggregateMembershipByCity(data.revenue, periods);
  }, [data, periods]);

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
    <div className="space-y-6">
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="font-display text-3xl uppercase tracking-tight text-deep-green md:text-4xl">
            Period Compare
          </h2>
          <p className="text-xs text-deep-green/60">
            Per-venue DPP $ with member bookings as supporting context,
            across {mode === "monthly" ? "5 same-day-of-month windows" : "the last 8 ISO weeks"}.
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

      {inactiveCount > 0 && (
        <div className="flex items-center gap-2 border-t border-cream-line/60 bg-cream-soft/30 px-5 py-2 text-[11px] text-deep-green/65">
          <label className="flex cursor-pointer items-center gap-1.5 select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-3.5 w-3.5 accent-mint-hover"
            />
            <span className="font-bold">Show inactive venues</span>
            <span className="text-deep-green/55">
              ({inactiveCount} hidden — no $ or bookings in this window)
            </span>
          </label>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
            <tr className="border-y border-cream-line">
              <th className="sticky left-0 z-20 bg-cream-soft px-3 py-2 text-left">
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
              {periods.map((p) => {
                const key: VenueSortKey = `dpp:${p.key}`;
                const isActive = sortKey === key;
                return (
                  <th
                    key={p.key}
                    onClick={() => toggleSort(key)}
                    className={`border-l border-cream-line px-3 py-2 text-right ${
                      p.inProgress ? "bg-blue-soft/40" : ""
                    } ${isActive ? "text-deep-green" : "cursor-pointer hover:bg-cream"}`}
                  >
                    <div className="text-[11px]">{p.label}</div>
                    {p.inProgress && (
                      <div className="text-[9px] font-normal normal-case text-deep-green/55">
                        {mode === "weekly" && p.daysElapsed
                          ? `in progress, ${p.daysElapsed} of 7 days`
                          : "in progress"}
                      </div>
                    )}
                    <div className="mt-0.5 text-[9px] text-deep-green/50">
                      {isActive ? (sortDir === "desc" ? "↓ DPP $" : "↑ DPP $") : "DPP $"}
                    </div>
                  </th>
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
            <tr className="border-t-[1.5px] border-cream-line bg-cream-soft/60 text-deep-green">
              <td className="sticky left-0 z-20 bg-cream-soft/60 px-3 py-2.5 font-bold">
                Total ({sortedVenues.length} venues)
              </td>
              {periods.map((p) => {
                const dppTot = periodColumnTotal(dppTable, p.key);
                const mbrTot = periodColumnTotal(mbrTable, p.key);
                return (
                  <td
                    key={p.key}
                    className={`border-l border-cream-line px-3 py-2.5 text-right font-mono tabular-nums ${
                      p.inProgress ? "bg-blue-soft/20" : ""
                    }`}
                  >
                    <div className="font-medium text-deep-green">{fmtMoney(dppTot)}</div>
                    <div className="mt-0.5 text-[11px] font-normal text-deep-green/55">
                      {fmtMbr(mbrTot)}
                    </div>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>

    <MembershipByCitySection
      periods={periods}
      membership={membership}
      deltaLabel={deltaLabel}
    />
    </div>
  );
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
      <td className="sticky left-0 z-10 bg-white px-3 py-2.5">
        <div className="font-bold text-deep-green">{venue}</div>
        <div className="text-[11px] font-normal text-deep-green/55">{city}</div>
      </td>
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
          <td
            key={p.key}
            className={`border-l border-cream-line px-3 py-2.5 text-right font-mono tabular-nums ${
              p.inProgress ? "bg-blue-soft/20" : ""
            }`}
            title={prior ? `${deltaLabel} vs ${prior.label}` : undefined}
          >
            <div className="font-medium text-deep-green">
              {fmtMoney(dpp)}
              {dppLabel.text && (
                <span className={`ml-1.5 text-[11px] font-bold ${dppLabel.className}`}>
                  {dppLabel.text}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[11px] font-normal text-deep-green/55">
              {fmtMbr(mbr)}
              {mbrLabel.text && (
                <span className={`ml-1.5 text-[11px] font-bold ${mbrLabel.className}`}>
                  {mbrLabel.text}
                </span>
              )}
            </div>
          </td>
        );
      })}
    </tr>
  );
}

// === Membership by City ===
//
// Same column shape as the venue table but simpler — one $ metric
// per period (no booking sub-column). Row set is the canonical 8
// cities from src/lib/types.ts (always rendered, even when zero, so
// the layout is stable across periods) + any extra non-sentinel
// city that appears in fin_revenue + a single "Deleted accounts"
// row beneath the city block for transparency. Total row sums only
// the real cities — the sentinel is intentionally excluded.

type CitySortKey = "city" | string; // "city" or "p:<periodKey>"

function MembershipByCitySection({
  periods,
  membership,
  deltaLabel,
}: {
  periods: Period[];
  membership: MembershipByCity;
  deltaLabel: string;
}) {
  const currentPeriod = periods[periods.length - 1];
  const [sortKey, setSortKey] = useState<CitySortKey>(`p:${currentPeriod.key}`);
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function toggleSort(key: CitySortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir(key === "city" ? "asc" : "desc");
    }
  }

  // Row set: canonical CITIES always + any extra cities the data
  // contains that aren't already covered. Stable so the operator
  // sees zero-rows for known cities instead of "where did Atlanta
  // go this period."
  const rowCities = useMemo(() => {
    const set = new Set<string>(CITIES);
    for (const c of membership.citiesPresent) set.add(c);
    return [...set];
  }, [membership.citiesPresent]);

  const sortedCities = useMemo(() => {
    const arr = [...rowCities];
    arr.sort((a, b) => {
      if (sortKey === "city") {
        return sortDir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
      }
      const periodKey = sortKey.slice(2); // strip "p:"
      const av = membership.byCity.get(a)?.get(periodKey) ?? 0;
      const bv = membership.byCity.get(b)?.get(periodKey) ?? 0;
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return arr;
  }, [rowCities, sortKey, sortDir, membership]);

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div className="border-b border-cream-line/60 px-5 py-4">
        <h2 className="font-display text-2xl uppercase tracking-tight text-deep-green md:text-3xl">
          Membership Revenue by City
        </h2>
        <p className="mt-1 text-xs text-deep-green/60">
          Stripe-tracked membership $, same period windows as above.
          Membership revenue, not member-bookings count — for booking
          activity see the Mbr Bookings column in the venue table.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
            <tr className="border-b border-cream-line">
              <th className="sticky left-0 z-20 bg-cream-soft px-3 py-2 text-left">
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
              {periods.map((p) => {
                const key: CitySortKey = `p:${p.key}`;
                const isActive = sortKey === key;
                return (
                  <th
                    key={p.key}
                    className={`border-l border-cream-line px-3 py-2 text-right ${
                      p.inProgress ? "bg-mint-soft/40" : ""
                    } ${isActive ? "text-deep-green" : "cursor-pointer hover:bg-cream"}`}
                    onClick={() => toggleSort(key)}
                  >
                    <div className="text-[11px]">{p.label}</div>
                    {p.inProgress && (
                      <div className="text-[9px] font-normal normal-case text-deep-green/55">
                        {p.daysElapsed != null
                          ? `in progress, ${p.daysElapsed} of 7 days`
                          : "in progress"}
                      </div>
                    )}
                    <div className="mt-0.5 text-[9px] text-deep-green/50">
                      {isActive ? (sortDir === "desc" ? "↓ Mbr $" : "↑ Mbr $") : "Mbr $"}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedCities.map((city) => (
              <CityRow
                key={city}
                city={city}
                periods={periods}
                membership={membership}
                deltaLabel={deltaLabel}
              />
            ))}
            {/* Deleted Accounts row — labeled, separated by a soft top
                border, intentionally excluded from the Total below. */}
            <tr className="border-t-2 border-cream-line text-deep-green/65 hover:bg-cream-soft/40">
              <td className="sticky left-0 z-10 bg-white px-3 py-2.5 italic">
                Deleted accounts{" "}
                <span className="text-[10px] font-normal not-italic text-deep-green/50">
                  (excluded from city totals)
                </span>
              </td>
              {periods.map((p, i) => {
                const prior = i === 0 ? null : periods[i - 1];
                const curr = membership.deletedAccount.get(p.key) ?? 0;
                const priorV = prior
                  ? (membership.deletedAccount.get(prior.key) ?? 0)
                  : null;
                const delta = computeDelta(curr, priorV);
                const label = fmtDeltaPct(delta.pct);
                return (
                  <td
                    key={p.key}
                    className={`border-l border-cream-line px-3 py-2.5 text-right font-mono tabular-nums ${
                      p.inProgress ? "bg-mint-soft/20" : ""
                    }`}
                    title={prior ? `${deltaLabel} vs ${prior.label}` : undefined}
                  >
                    {fmtMoney(curr)}
                    {label.text && (
                      <span className={`ml-1.5 text-[10px] font-bold ${label.className}`}>
                        {label.text}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          </tbody>
          <tfoot>
            <tr className="border-t-[1.5px] border-cream-line bg-cream-soft/60 text-xs font-bold text-deep-green">
              <td className="sticky left-0 z-20 bg-cream-soft/60 px-3 py-2.5">
                Total ({sortedCities.length} cities)
              </td>
              {periods.map((p, i) => {
                const prior = i === 0 ? null : periods[i - 1];
                const curr = membershipCityColumnTotal(membership, p.key);
                const priorV = prior
                  ? membershipCityColumnTotal(membership, prior.key)
                  : null;
                const delta = computeDelta(curr, priorV);
                const label = fmtDeltaPct(delta.pct);
                return (
                  <td
                    key={p.key}
                    className={`border-l border-cream-line px-3 py-2.5 text-right font-mono tabular-nums ${
                      p.inProgress ? "bg-mint-soft/20" : ""
                    }`}
                  >
                    {fmtMoney(curr)}
                    {label.text && (
                      <span className={`ml-1.5 text-[10px] font-bold ${label.className}`}>
                        {label.text}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function CityRow({
  city,
  periods,
  membership,
  deltaLabel,
}: {
  city: string;
  periods: Period[];
  membership: MembershipByCity;
  deltaLabel: string;
}) {
  return (
    <tr className="border-t border-cream-line/40 text-deep-green hover:bg-cream-soft/40">
      <td className="sticky left-0 z-10 bg-white px-3 py-2.5 font-bold">{city}</td>
      {periods.map((p, i) => {
        const prior = i === 0 ? null : periods[i - 1];
        const curr = membership.byCity.get(city)?.get(p.key) ?? 0;
        const priorV = prior
          ? (membership.byCity.get(city)?.get(prior.key) ?? 0)
          : null;
        const delta = computeDelta(curr, priorV);
        const label = fmtDeltaPct(delta.pct);
        return (
          <td
            key={p.key}
            className={`border-l border-cream-line px-3 py-2.5 text-right font-mono tabular-nums ${
              p.inProgress ? "bg-mint-soft/20" : ""
            }`}
            title={prior ? `${deltaLabel} vs ${prior.label}` : undefined}
          >
            {fmtMoney(curr)}
            {label.text && (
              <span className={`ml-1.5 text-[10px] font-bold ${label.className}`}>
                {label.text}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}
