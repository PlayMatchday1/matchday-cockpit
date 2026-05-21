"use client";

import { useEffect, useMemo, useState } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import {
  cityMembershipRevenueFor,
  cityOverheadFor,
  groupPerMatchCostFor,
  quarterTabToMonths,
  venueChargedCancelCountFor,
  venueMatchCountFor,
  venuePartnerRevenueFor,
  type Q2Month,
} from "@/lib/financeStats";
import { canonicalVenueCost } from "@/lib/financeCosts";
import { groupVenues } from "@/lib/venueGroups";
import { isCurrentMonth, type QuarterInfo } from "@/lib/quarters";

// Tab key is either the quarter key (whole quarter) or a month's
// shortName (e.g. "Apr"). Stored as string so it can hold any
// quarter's identifier — Q3 2026's tab would be "2026Q3" / "Jul" /
// "Aug" / "Sep".
type Tab = string;

function fmt(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "—";
  return r.toLocaleString("en-US");
}

function fmtMoney(n: number): string {
  const r = Math.round(n);
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : ""}$${abs.toLocaleString("en-US")}`;
}

// Default tab: the current calendar month within the active quarter
// when today falls inside it, otherwise the quarter's last month
// (operator reads "the latest available data" for past quarters).
function defaultTab(quarter: QuarterInfo, now: Date = new Date()): Tab {
  const cur = quarter.months.find((m) => isCurrentMonth(m, now));
  if (cur) return cur.shortName;
  return quarter.months[quarter.months.length - 1].shortName;
}

// costMode is page-level state owned by the Cities tab. Per-card local
// state would let the cards drift out of sync. "as_billed" = current
// behavior (canonicalVenueCost: per_match × rate + overrides). "per_match"
// = groupPerMatchCostFor (cost_per_match × matches), the same calc the
// Field Ranking Per-Match toggle uses.
export type CityCostMode = "as_billed" | "per_match";

export default function CityPLCard({
  city,
  costMode,
}: {
  city: string;
  costMode: CityCostMode;
}) {
  const { data } = useFinanceData();
  const { rows: matchRegistrations } = useMatchData();
  const quarter = useFinanceQuarter();
  const [tab, setTab] = useState<Tab>(() => defaultTab(quarter));
  // Reset tab when quarter switches so we never render a stale
  // shortName from the previous quarter.
  useEffect(() => {
    setTab(defaultTab(quarter));
  }, [quarter]);

  const result = useMemo(() => {
    if (!data) return null;
    const months: Q2Month[] = quarterTabToMonths(quarter, tab);

    // Iterate venue GROUPS rather than venue names so split-rate venues
    // like ATH Katy / ATH Katy Sunday show as one combined row.
    const cityGroups = groupVenues(data.venues).filter(
      (g) => g.city === city,
    );

    // Map every leg's canonical venue_name back to its group, so a DPP
    // revenue row's `venue` (post-alias canonical) lands in the right
    // group. Combined groups (ATH Katy + ATH Katy Sunday) share one entry.
    const venueToGroupKey = new Map<string, string>();
    for (const g of cityGroups) {
      for (const leg of g.legs) {
        venueToGroupKey.set(leg.venue_name, g.key);
      }
    }

    // Strike revenue (type='Strike') and untagged DPP (venue=null) are
    // still walked from fin_revenue for the gross-rev tile — they don't
    // attach to any venue group, so partner formula doesn't see them.
    // Per-venue DPP+PR revenue now flows from venuePartnerRevenueFor
    // (match-reg DAILY-PAID + fin_revenue Private Rental), matching
    // Field Ranking exactly. Private Rentals fold INTO the venue's
    // revenue rather than rendering as a separate row.
    let untaggedDppRev = 0;
    let strikeRev = 0;
    let membershipRev = 0;
    const overhead = {
      matchManagerPay: 0,
      cityManager: 0,
      marketing: 0,
      equipment: 0,
      misc: 0,
    };
    for (const m of months) {
      for (const r of data.revenue) {
        if (r.city !== city || r.month !== m) continue;
        if (r.type === "Strike") {
          strikeRev += r.net;
          continue;
        }
        // DPP with no venue → bucket as untagged so the gross-rev tile
        // still includes it. Tagged DPP is folded into the per-venue
        // partner-formula revenue below, so we skip it here.
        if (r.type === "DPP" && !r.venue) {
          untaggedDppRev += r.net;
        }
      }
      membershipRev += cityMembershipRevenueFor(data, city, m);
      const o = cityOverheadFor(data, city, m);
      overhead.matchManagerPay += o.matchManagerPay;
      overhead.cityManager += o.cityManager;
      overhead.marketing += o.marketing;
      overhead.equipment += o.equipment;
      overhead.misc += o.misc;
    }

    // Per-venue rows: compute cost + match count via existing helpers
    // and revenue via venuePartnerRevenueFor (match-reg DAILY-PAID +
    // fin_revenue Private Rental, summed over the months and the
    // group's legs). Private Rentals are folded into the venue's
    // revenue here — there is no separate "Private Rentals" row.
    type FieldRow = {
      venue: string;
      subLabel: string | null;
      dppRev: number;
      cost: number;
      // Alive matches that actually ran ("honest" count for the
      // descriptive "N matches across legs" subtitle). Cancelled
      // matches the venue charges for appear separately as
      // chargedCancelCount.
      matchCount: number;
      chargedCancelCount: number;
      net: number;
      billingType: typeof cityGroups[number]["legs"][number]["billing_type"] | null;
      perMatchRate: number | null;
      monthlyFlat: number | null;
      isCombined: boolean;
      isUntagged: boolean;
      isPrivateRental: boolean;
      // Per-leg (charged matches × cost_per_match) breakdown for the
      // uniform "N × $cpm" subtitle in Per-Match mode. cpm falls back
      // from a null secondary leg to the primary's value. matchCount
      // here is the CHARGED count (alive + cxl when charge_on_cancel)
      // so subtitle math reconciles to cost.
      perMatchLegs: Array<{ matchCount: number; cpm: number }>;
    };
    const fieldLevel: FieldRow[] = cityGroups
      .map((g) => {
        // PR-E: id-keyed leg set. Per-leg iteration replaces the
        // prior same-name special case — venueMatchCountFor reads
        // through fin_venues.id now, so each leg's count is
        // independent regardless of name collision.
        const legVenueIds = new Set(g.legs.map((l) => l.id));
        let cost = 0;
        let matchCount = 0;
        let chargedCancelCount = 0;
        let dppRev = 0;
        // Track alive and cancelled-charged per leg separately so the
        // Per-Match subtitle ("N × $cpm" per leg) sums to cost while
        // the As-Billed "N matches across legs" subtitle stays honest
        // about how many matches actually ran (with a +cxl badge).
        const aliveLegCounts: number[] = g.legs.map(() => 0);
        const cxlLegCounts: number[] = g.legs.map(() => 0);
        for (const m of months) {
          // Cost source toggles with the page-level mode. as_billed:
          // canonicalVenueCost (override-aware billing — monthly_flat
          // / profit_share lumps, per_match × rate). per_match: shared
          // groupPerMatchCostFor helper so Cities + Field Ranking stay
          // in lockstep. Both branches already include the
          // charge_on_cancel surcharge under the hood.
          if (costMode === "per_match") {
            cost += groupPerMatchCostFor(data, g, m);
          } else {
            for (const leg of g.legs) {
              cost += canonicalVenueCost(data, leg.id, m).amount;
            }
          }
          for (let i = 0; i < g.legs.length; i++) {
            const alive = venueMatchCountFor(data, g.legs[i].id, m);
            const cxl = venueChargedCancelCountFor(
              data,
              g.legs[i].id,
              m,
            );
            aliveLegCounts[i] += alive;
            cxlLegCounts[i] += cxl;
            matchCount += alive;
            chargedCancelCount += cxl;
          }
          dppRev += venuePartnerRevenueFor(
            data,
            matchRegistrations,
            legVenueIds,
            m,
          );
        }
        const primaryCpm = g.legs[0].cost_per_match;
        // Subtitle ("N × $cpm") uses CHARGED counts so its arithmetic
        // matches the cost cell. The Matches-display side keeps alive
        // + cxl badge separately via FieldRow.matchCount /
        // .chargedCancelCount.
        const perMatchLegs = g.legs.map((leg, idx) => ({
          matchCount: aliveLegCounts[idx] + cxlLegCounts[idx],
          cpm: leg.cost_per_match ?? primaryCpm ?? 0,
        }));
        return {
          venue: g.displayName,
          subLabel: null,
          dppRev,
          cost,
          matchCount,
          net: dppRev - cost,
          billingType: g.legs[0].billing_type ?? null,
          perMatchRate: g.legs[0].per_match_rate ?? null,
          monthlyFlat: g.legs[0].monthly_flat ?? null,
          isCombined: g.isCombined,
          isUntagged: false,
          isPrivateRental: false,
          chargedCancelCount,
          perMatchLegs,
        };
      })
      .filter((r) => r.dppRev > 0 || r.cost > 0 || r.matchCount > 0)
      .sort((a, b) => b.dppRev - a.dppRev || b.cost - a.cost);

    const fieldDppTotal = fieldLevel.reduce((s, r) => s + r.dppRev, 0);
    const fieldCostTotal = fieldLevel.reduce((s, r) => s + r.cost, 0);
    const fieldNetTotal = fieldDppTotal - fieldCostTotal;
    const privateRentalTotal = fieldLevel
      .filter((r) => r.isPrivateRental)
      .reduce((s, r) => s + r.dppRev, 0);
    const venueDppTotal = fieldDppTotal - privateRentalTotal;

    const overheadTotal =
      overhead.matchManagerPay +
      overhead.cityManager +
      overhead.marketing +
      overhead.equipment +
      overhead.misc;

    const grossRev =
      fieldDppTotal + strikeRev + untaggedDppRev + membershipRev;
    const netPL = grossRev - fieldCostTotal - overheadTotal;
    const margin = grossRev > 0 ? netPL / grossRev : 0;

    return {
      fieldLevel,
      fieldDppTotal,
      fieldCostTotal,
      fieldNetTotal,
      venueDppTotal,
      privateRentalTotal,
      strikeRev,
      untaggedDppRev,
      membershipRev,
      grossRev,
      overhead,
      overheadTotal,
      netPL,
      margin,
    };
  }, [data, matchRegistrations, city, tab, quarter, costMode]);

  if (!data || !result) return null;

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-deep-green/20">
      <div className="min-w-0">
        <h3 className="font-display text-3xl uppercase leading-none tracking-tight text-deep-green">
          {city}
        </h3>
        <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
          Field-level DPP + city memberships + overhead
        </p>
      </div>

      <div className="mt-4 inline-flex w-full rounded-full bg-cream-soft p-1 ring-1 ring-cream-line">
        {(() => {
          const tabs: { key: string; label: string }[] = [
            { key: `Q${quarter.quarter}`, label: `Q${quarter.quarter}` },
            ...quarter.months.map((m) => ({ key: m.shortName, label: m.shortName })),
          ];
          return tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex-1 rounded-full px-3 py-1 text-xs font-bold transition ${
                tab === t.key
                  ? "bg-mint text-deep-green shadow-sm"
                  : "text-deep-green/60 hover:text-deep-green"
              }`}
            >
              {t.label}
            </button>
          ));
        })()}
      </div>

      <div className="mt-5 space-y-5">
        <section>
          <SectionHead>
            Field-level{" "}
            <span className="normal-case text-deep-green/45">
              (DPP revenue, cost, net per venue)
            </span>
          </SectionHead>
          {result.fieldLevel.length === 0 ? (
            <div className="text-xs italic text-deep-green/45">
              No field activity this period
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
                  <th className="py-1 text-left">Venue</th>
                  <th className="py-1 pl-2 text-right">DPP Rev</th>
                  <th className="py-1 pl-2 text-right">Cost</th>
                  <th className="py-1 pl-2 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {result.fieldLevel.map((f) => (
                  <tr key={f.venue} className="border-t border-cream-line/40">
                    <td className="py-1.5 pr-2">
                      <div
                        className={
                          f.isUntagged
                            ? "italic text-deep-green/55"
                            : "text-deep-green"
                        }
                      >
                        {f.venue}
                        {f.isCombined && (
                          <span className="ml-1 text-[9px] font-normal lowercase tracking-normal text-deep-green/45">
                            (combined)
                          </span>
                        )}
                      </div>
                      {(() => {
                        // Subtitle. In Per-Match mode, render a uniform
                        // "N × $cpm" for every venue (joined by " + " for
                        // split-rate legs), keyed off the same numbers
                        // that drive the Per-Match cost so the row
                        // arithmetic is self-checking. In As Billed mode,
                        // keep the legacy mix: per_match rows show
                        // "N × $rate", combined per_match shows "N
                        // matches across legs", monthly_flat shows
                        // "monthly", others render nothing. Private
                        // rental subLabel renders in both modes.
                        if (f.isUntagged) return null;
                        if (f.isPrivateRental) {
                          return f.subLabel ? (
                            <div className="text-[10px] text-deep-green/45">
                              {f.subLabel}
                            </div>
                          ) : null;
                        }
                        if (costMode === "per_match") {
                          const visible = f.perMatchLegs.filter(
                            (l) => l.matchCount > 0,
                          );
                          if (visible.length === 0) return null;
                          return (
                            <div className="text-[10px] text-deep-green/45">
                              {visible
                                .map(
                                  (l) =>
                                    `${l.matchCount} × $${Math.round(l.cpm)}`,
                                )
                                .join(" + ")}
                            </div>
                          );
                        }
                        if (
                          f.billingType === "per_match" &&
                          f.matchCount > 0
                        ) {
                          if (f.isCombined) {
                            return (
                              <div className="text-[10px] text-deep-green/45">
                                {f.matchCount}
                                {f.chargedCancelCount > 0 &&
                                  ` +${f.chargedCancelCount} cxl`}
                                {" "}matches across legs
                              </div>
                            );
                          }
                          if (f.perMatchRate) {
                            // Charged total × rate so the subtitle math
                            // reconciles to the cost cell when
                            // charge_on_cancel adds to the count.
                            const charged =
                              f.matchCount + f.chargedCancelCount;
                            return (
                              <div className="text-[10px] text-deep-green/45">
                                {charged} × $
                                {Math.round(f.perMatchRate)}
                              </div>
                            );
                          }
                        }
                        if (f.billingType === "monthly_flat") {
                          return (
                            <div className="text-[10px] text-deep-green/45">
                              monthly
                            </div>
                          );
                        }
                        return null;
                      })()}
                    </td>
                    <td className="py-1.5 pl-2 text-right font-mono tabular-nums text-mint-hover">
                      {fmt(f.dppRev)}
                    </td>
                    <td className="py-1.5 pl-2 text-right font-mono tabular-nums text-coral">
                      {fmt(f.cost)}
                    </td>
                    <td
                      className={`py-1.5 pl-2 text-right font-mono font-bold tabular-nums ${
                        f.net >= 0 ? "text-mint-hover" : "text-coral"
                      }`}
                    >
                      {fmt(f.net)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-deep-green/15">
                  <td className="py-1.5 pr-2 text-[10px] font-bold uppercase tracking-wider text-deep-green/65">
                    Total field
                  </td>
                  <td className="py-1.5 pl-2 text-right font-mono font-bold tabular-nums text-mint-hover">
                    {fmt(result.fieldDppTotal)}
                  </td>
                  <td className="py-1.5 pl-2 text-right font-mono font-bold tabular-nums text-coral">
                    {fmt(result.fieldCostTotal)}
                  </td>
                  <td
                    className={`py-1.5 pl-2 text-right font-mono font-bold tabular-nums ${
                      result.fieldNetTotal >= 0
                        ? "text-mint-hover"
                        : "text-coral"
                    }`}
                  >
                    {fmt(result.fieldNetTotal)}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </section>

        {result.strikeRev > 0 && (
          <section>
            <SectionHead>Strikes</SectionHead>
            <div className="font-mono text-sm font-bold tabular-nums text-mint-hover">
              {fmtMoney(result.strikeRev)}
            </div>
          </section>
        )}

        {Math.abs(result.untaggedDppRev) > 0.5 && (
          <section>
            <SectionHead>Other field DPP</SectionHead>
            <div className="font-mono text-sm italic tabular-nums text-deep-green/65">
              {fmtMoney(result.untaggedDppRev)}
            </div>
            <div className="mt-0.5 text-[10px] italic text-deep-green/45">
              DPP rows with no venue tag — investigate if non-zero post Wave 6.5
            </div>
          </section>
        )}

        <section>
          <SectionHead>Membership revenue</SectionHead>
          <div className="font-mono text-sm font-bold tabular-nums text-mint-hover">
            {result.membershipRev > 0 ? fmtMoney(result.membershipRev) : "—"}
          </div>
        </section>

        <section>
          <SectionHead>Gross revenue</SectionHead>
          <div className="font-mono text-base font-bold tabular-nums text-deep-green">
            {fmtMoney(result.grossRev)}
          </div>
          <div className="mt-0.5 text-[10px] text-deep-green/45">
            DPP {fmt(result.venueDppTotal)}
            {result.privateRentalTotal > 0
              ? ` + Private Rentals ${fmt(result.privateRentalTotal)}`
              : ""}
            {result.strikeRev > 0
              ? ` + Strikes ${fmt(result.strikeRev)}`
              : ""}
            {Math.abs(result.untaggedDppRev) > 0.5
              ? ` + Other ${fmt(result.untaggedDppRev)}`
              : ""}
            {" "}+ Membership {fmt(result.membershipRev)}
          </div>
        </section>

        <section>
          <SectionHead>Overhead</SectionHead>
          <div className="space-y-1">
            {result.overhead.matchManagerPay > 0 && (
              <OverheadRow
                label="Match Manager Pay"
                value={result.overhead.matchManagerPay}
              />
            )}
            {result.overhead.cityManager > 0 && (
              <OverheadRow
                label="City Manager"
                value={result.overhead.cityManager}
              />
            )}
            {result.overhead.marketing > 0 && (
              <OverheadRow
                label="Marketing"
                value={result.overhead.marketing}
              />
            )}
            {result.overhead.equipment > 0 && (
              <OverheadRow
                label="Equipment"
                value={result.overhead.equipment}
              />
            )}
            {result.overhead.misc > 0 && (
              <OverheadRow label="Misc" value={result.overhead.misc} />
            )}
            {result.overheadTotal === 0 && (
              <div className="text-xs italic text-deep-green/45">
                No overhead
              </div>
            )}
            {result.overheadTotal > 0 && (
              <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-deep-green/15 pt-1.5 text-xs">
                <span className="text-[10px] font-bold uppercase tracking-wider text-deep-green/65">
                  Total overhead
                </span>
                <span className="font-mono font-bold tabular-nums text-coral">
                  {fmt(result.overheadTotal)}
                </span>
              </div>
            )}
          </div>
        </section>

        <section className="border-t-2 border-deep-green/15 pt-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="text-sm font-bold uppercase tracking-wider text-deep-green">
              Net P&L
            </div>
            <div className="flex flex-col items-end gap-1">
              <div
                className={`font-mono text-2xl font-bold tabular-nums ${
                  result.netPL >= 0 ? "text-mint-hover" : "text-coral"
                }`}
              >
                {fmtMoney(result.netPL)}
              </div>
              <MarginBadge margin={result.margin} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
      {children}
    </div>
  );
}

function OverheadRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-deep-green/85">{label}</span>
      <span className="font-mono font-bold tabular-nums text-coral">
        {fmt(value)}
      </span>
    </div>
  );
}

function MarginBadge({ margin }: { margin: number }) {
  const pct = Math.round(margin * 100);
  const cls =
    margin >= 0.2
      ? "bg-mint text-deep-green ring-mint/60"
      : margin >= 0
        ? "bg-mint-soft text-deep-green ring-mint/40"
        : "bg-coral-soft text-coral ring-coral/40";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset ${cls}`}
    >
      {pct}% margin
    </span>
  );
}
