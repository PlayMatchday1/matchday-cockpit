"use client";

import { useMemo, useState } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import {
  cityGrossRevenueFor,
  cityMembershipRevenueFor,
  cityOverheadFor,
  tabToMonths,
  venueDppRevenueFor,
  venueMatchCountFor,
  type Q2Month,
} from "@/lib/financeStats";
import { canonicalVenueCost } from "@/lib/financeCosts";
import { groupVenues } from "@/lib/venueGroups";

type Tab = "Q2" | "Apr" | "May" | "Jun";

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

export default function CityPLCard({ city }: { city: string }) {
  const { data } = useFinanceData();
  const [tab, setTab] = useState<Tab>("Apr");

  const result = useMemo(() => {
    if (!data) return null;
    const months: Q2Month[] = tabToMonths(tab);

    // Iterate venue GROUPS rather than venue names so split-rate venues
    // like ATH Katy / ATH Katy Sunday show as one combined row.
    const cityGroups = groupVenues(data.venues).filter(
      (g) => g.city === city,
    );

    const fieldLevel = cityGroups
      .map((g) => {
        const legNames = new Set(g.legs.map((l) => l.venue_name));
        const sameNameLegs = legNames.size !== g.legs.length;
        let dppRev = 0;
        let cost = 0;
        let matchCount = 0;
        for (const m of months) {
          for (const leg of g.legs) {
            cost += canonicalVenueCost(data, leg.id, m).amount;
          }
          if (sameNameLegs) {
            // One query covers all legs (alias-collapsed canonical name).
            dppRev += venueDppRevenueFor(data, city, g.displayName, m);
            matchCount += venueMatchCountFor(data, city, g.displayName, m);
          } else {
            for (const leg of g.legs) {
              dppRev += venueDppRevenueFor(data, city, leg.venue_name, m);
              matchCount += venueMatchCountFor(data, city, leg.venue_name, m);
            }
          }
        }
        return {
          venue: g.displayName,
          dppRev,
          cost,
          matchCount,
          net: dppRev - cost,
          billingType: g.legs[0].billing_type ?? null,
          perMatchRate: g.legs[0].per_match_rate ?? null,
          monthlyFlat: g.legs[0].monthly_flat ?? null,
          isCombined: g.isCombined,
        };
      })
      .filter((r) => r.dppRev !== 0 || r.cost !== 0)
      .sort((a, b) => b.dppRev - a.dppRev);

    const fieldNetTotal = fieldLevel.reduce((s, r) => s + r.net, 0);

    let membershipRev = 0;
    let grossRev = 0;
    const overhead = {
      matchManagerPay: 0,
      cityManager: 0,
      marketing: 0,
      equipment: 0,
    };
    for (const m of months) {
      membershipRev += cityMembershipRevenueFor(data, city, m);
      grossRev += cityGrossRevenueFor(data, city, m);
      const o = cityOverheadFor(data, city, m);
      overhead.matchManagerPay += o.matchManagerPay;
      overhead.cityManager += o.cityManager;
      overhead.marketing += o.marketing;
      overhead.equipment += o.equipment;
    }
    const overheadTotal =
      overhead.matchManagerPay +
      overhead.cityManager +
      overhead.marketing +
      overhead.equipment;

    const netPL = fieldNetTotal + membershipRev - overheadTotal;
    const margin = grossRev > 0 ? netPL / grossRev : 0;

    return {
      fieldLevel,
      fieldNetTotal,
      membershipRev,
      overhead,
      overheadTotal,
      netPL,
      margin,
    };
  }, [data, city, tab]);

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
        {(["Q2", "Apr", "May", "Jun"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex-1 rounded-full px-3 py-1 text-xs font-bold transition ${
              tab === t
                ? "bg-mint text-deep-green shadow-sm"
                : "text-deep-green/60 hover:text-deep-green"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-5">
        <section>
          <SectionHead>
            Field-level{" "}
            <span className="normal-case text-deep-green/45">(DPP only)</span>
          </SectionHead>
          {result.fieldLevel.length === 0 ? (
            <div className="text-xs italic text-deep-green/45">
              No DPP activity
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
                      <div className="text-deep-green">
                        {f.venue}
                        {f.isCombined && (
                          <span className="ml-1 text-[9px] font-normal lowercase tracking-normal text-deep-green/45">
                            (combined)
                          </span>
                        )}
                      </div>
                      {f.billingType === "per_match" &&
                        f.matchCount > 0 &&
                        (f.isCombined ? (
                          <div className="text-[10px] text-deep-green/45">
                            {f.matchCount} matches across legs
                          </div>
                        ) : (
                          f.perMatchRate && (
                            <div className="text-[10px] text-deep-green/45">
                              {f.matchCount} × ${Math.round(f.perMatchRate)}
                            </div>
                          )
                        ))}
                      {f.billingType === "monthly_flat" && (
                        <div className="text-[10px] text-deep-green/45">
                          monthly
                        </div>
                      )}
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
              </tbody>
            </table>
          )}
        </section>

        <section>
          <SectionHead>Membership revenue</SectionHead>
          <div className="font-mono text-sm font-bold tabular-nums text-mint-hover">
            {result.membershipRev > 0 ? fmtMoney(result.membershipRev) : "—"}
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
            {result.overheadTotal === 0 && (
              <div className="text-xs italic text-deep-green/45">
                No overhead
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
