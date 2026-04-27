"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import FinanceInsightCard from "./FinanceInsightCard";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import {
  Q2_MONTHS,
  buildCityInsightRows,
  buildMembershipHealthRows,
  buildVenueInsightRows,
  cashRunway,
  companySpotMix,
  getCurrentQ2Month,
  highPromoUsageFields,
  membershipHealthAvailable,
  newVenuesProfitable,
  newVenuesStruggling,
  overheadBurdenCities,
  profitableCities,
  profitableFields,
  unprofitableCities,
  unprofitableFields,
  type MembershipHealthRow,
  type Q2Month,
  type VenueInsightRow,
} from "@/lib/financeStats";
import {
  MEMBER_HEAVY_MIN_SPOTS,
  MEMBER_HEAVY_THRESHOLD,
  memberHeavyFieldsFromMatches,
  type MemberHeavyRow,
} from "@/lib/memberHeavyInsight";

function fmtMoney(n: number, sign = false): string {
  const r = Math.round(n);
  if (r === 0) return "$0";
  const abs = Math.abs(r);
  const prefix = sign && r > 0 ? "+" : r < 0 ? "-" : "";
  return `${prefix}$${abs.toLocaleString("en-US")}`;
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

export default function FinanceInsightsGrid({
  collapsed = false,
  onToggle,
}: {
  collapsed?: boolean;
  onToggle?: () => void;
} = {}) {
  const { data, loading } = useFinanceData();
  const { rows: matchRows } = useMatchData();
  const [month, setMonth] = useState<Q2Month>(
    () => getCurrentQ2Month(new Date()) ?? "Apr 2026",
  );

  const computed = useMemo(() => {
    if (!data) return null;
    const venueRows = buildVenueInsightRows(data, month);
    const cityRows = buildCityInsightRows(data, month, venueRows);
    return {
      venueRows,
      cityRows,
      profitableF: profitableFields(venueRows),
      profitableC: profitableCities(cityRows),
      memberHeavy: memberHeavyFieldsFromMatches(matchRows, data, month),
      newProfit: newVenuesProfitable(venueRows),
      unprofitableF: unprofitableFields(venueRows),
      unprofitableC: unprofitableCities(cityRows),
      highPromo: highPromoUsageFields(venueRows),
      newStruggling: newVenuesStruggling(venueRows),
      overheadBurden: overheadBurdenCities(cityRows),
      runway: cashRunway(data),
      mix: companySpotMix(data, month),
      mhAvailable: membershipHealthAvailable(data),
      mhRows: buildMembershipHealthRows(data, month),
    };
  }, [data, matchRows, month]);

  const headerInteractive = Boolean(onToggle);

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-cream-soft/40 shadow-md shadow-deep-green/10">
      <div
        className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${
          headerInteractive
            ? "cursor-pointer rounded-t-2xl hover:bg-cream-soft/70"
            : ""
        }`}
        onClick={headerInteractive ? onToggle : undefined}
        role={headerInteractive ? "button" : undefined}
        aria-expanded={headerInteractive ? !collapsed : undefined}
      >
        <div className="flex items-start gap-2">
          {headerInteractive &&
            (collapsed ? (
              <ChevronRight
                size={20}
                aria-hidden
                className="mt-1.5 shrink-0 text-deep-green/55"
              />
            ) : (
              <ChevronDown
                size={20}
                aria-hidden
                className="mt-1.5 shrink-0 text-deep-green/55"
              />
            ))}
          <div>
            <h2 className="font-display text-3xl uppercase tracking-tight text-deep-green md:text-4xl">
              Insights
            </h2>
            <p className="text-xs text-deep-green/60">
              Auto-computed signals for the active month.
            </p>
          </div>
        </div>
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value as Q2Month)}
          onClick={(e) => e.stopPropagation()}
          className="rounded-full border border-cream-line bg-white px-4 py-1.5 text-xs font-bold text-deep-green focus:border-deep-green focus:outline-none"
          aria-label="Insights month"
        >
          {Q2_MONTHS.map((m) => (
            <option key={m} value={m}>
              {m.replace(" 2026", "")}
            </option>
          ))}
        </select>
      </div>

      {!collapsed && (
        <div className="px-5 pb-5">
          {loading || !computed ? (
            <div className="rounded-xl bg-white p-6 text-sm text-deep-green/60">
              Loading insights…
            </div>
          ) : (
            <>
              <CategoryLabel tone="working">What's Working</CategoryLabel>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                <FinanceInsightCard
                  tone="working"
                  title="Profitable Fields"
                  headline={`${computed.profitableF.length} ${computed.profitableF.length === 1 ? "field" : "fields"} profitable`}
                  subtitle={
                    computed.profitableF.length > 0
                      ? `Total gain: ${fmtMoney(
                          computed.profitableF.reduce((s, r) => s + r.net, 0),
                        )}`
                      : undefined
                  }
                  empty={computed.profitableF.length === 0}
                >
                  <VenueNetList rows={computed.profitableF.slice(0, 5)} sign />
                </FinanceInsightCard>

                <FinanceInsightCard
                  tone="working"
                  title="Profitable Cities"
                  headline={`${computed.profitableC.length} ${computed.profitableC.length === 1 ? "city" : "cities"} profitable`}
                  empty={computed.profitableC.length === 0}
                >
                  <ul className="space-y-1 text-xs">
                    {computed.profitableC.map((r) => (
                      <li
                        key={r.city}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <span className="text-deep-green/85">{r.city}</span>
                        <span className="font-mono font-bold tabular-nums text-mint-hover">
                          {fmtMoney(r.net, true)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </FinanceInsightCard>

                <FinanceInsightCard
                  tone="working"
                  title="Member-Heavy Fields"
                  headline={
                    computed.memberHeavy.length === 0
                      ? "None this month"
                      : `${computed.memberHeavy.length} field${computed.memberHeavy.length === 1 ? "" : "s"}`
                  }
                  subtitle={`≥${Math.round(MEMBER_HEAVY_THRESHOLD * 100)}% members, ${MEMBER_HEAVY_MIN_SPOTS}+ spots`}
                  empty={computed.memberHeavy.length === 0}
                >
                  <MemberHeavyList rows={computed.memberHeavy.slice(0, 5)} />
                </FinanceInsightCard>

                <FinanceInsightCard
                  tone="working"
                  title="New Venues Profitable"
                  headline={
                    computed.newProfit.length === 0
                      ? "None this month"
                      : `${computed.newProfit.length} new venue${computed.newProfit.length === 1 ? "" : "s"}`
                  }
                  subtitle="Launched 30–90 days ago"
                  empty={computed.newProfit.length === 0}
                >
                  <VenueNetList rows={computed.newProfit.slice(0, 5)} sign />
                </FinanceInsightCard>
              </div>

              <CategoryLabel tone="attention">Needs Attention</CategoryLabel>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                <FinanceInsightCard
                  tone="attention"
                  title="Unprofitable Fields"
                  headline={`${computed.unprofitableF.length} ${computed.unprofitableF.length === 1 ? "field" : "fields"} losing`}
                  subtitle={
                    computed.unprofitableF.length > 0
                      ? `Total loss: ${fmtMoney(
                          Math.abs(
                            computed.unprofitableF.reduce(
                              (s, r) => s + r.net,
                              0,
                            ),
                          ),
                        )}`
                      : undefined
                  }
                  empty={computed.unprofitableF.length === 0}
                >
                  <VenueNetList
                    rows={computed.unprofitableF.slice(0, 5)}
                    sign
                  />
                </FinanceInsightCard>

                <FinanceInsightCard
                  tone="attention"
                  title="Unprofitable Cities"
                  headline={`${computed.unprofitableC.length} ${computed.unprofitableC.length === 1 ? "city" : "cities"} losing`}
                  empty={computed.unprofitableC.length === 0}
                >
                  <ul className="space-y-1 text-xs">
                    {computed.unprofitableC.map((r) => (
                      <li
                        key={r.city}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <span className="text-deep-green/85">{r.city}</span>
                        <span className="font-mono font-bold tabular-nums text-coral">
                          {fmtMoney(r.net, true)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </FinanceInsightCard>

                <FinanceInsightCard
                  tone="attention"
                  title="High Promo Usage"
                  headline={
                    computed.highPromo.length === 0
                      ? "None flagged"
                      : `${computed.highPromo.length} field${computed.highPromo.length === 1 ? "" : "s"}`
                  }
                  subtitle=">20% promo, 30+ spots"
                  empty={computed.highPromo.length === 0}
                >
                  <VenueMixList
                    rows={computed.highPromo.slice(0, 5)}
                    metric="other"
                  />
                </FinanceInsightCard>

                <FinanceInsightCard
                  tone="attention"
                  title="New Venues Struggling"
                  headline={
                    computed.newStruggling.length === 0
                      ? "None struggling"
                      : `${computed.newStruggling.length} new venue${computed.newStruggling.length === 1 ? "" : "s"}`
                  }
                  subtitle="Launched 30–90 days ago, net negative"
                  empty={computed.newStruggling.length === 0}
                >
                  <VenueNetList
                    rows={computed.newStruggling.slice(0, 5)}
                    sign
                  />
                </FinanceInsightCard>
              </div>

              <CategoryLabel tone="watch">Watch</CategoryLabel>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                <FinanceInsightCard
                  tone="watch"
                  title="Membership Health"
                  headline={
                    !computed.mhAvailable
                      ? "Data needed"
                      : computed.mhRows.length === 0
                        ? "No qualifying cities"
                        : `${computed.mhRows.length} ${computed.mhRows.length === 1 ? "city" : "cities"}`
                  }
                  subtitle={
                    computed.mhAvailable
                      ? "Min 5 active paying members per city"
                      : undefined
                  }
                  empty={computed.mhAvailable && computed.mhRows.length === 0}
                >
                  {!computed.mhAvailable ? (
                    <div className="text-xs italic text-deep-green/55">
                      Membership Health requires Members + Member Spots +
                      Pricing data — re-import to enable.
                    </div>
                  ) : (
                    <MembershipHealthList rows={computed.mhRows} />
                  )}
                </FinanceInsightCard>

                <FinanceInsightCard
                  tone="watch"
                  title="Overhead Burden"
                  headline={
                    computed.overheadBurden.length === 0
                      ? "All cities under 50%"
                      : `${computed.overheadBurden.length} cit${computed.overheadBurden.length === 1 ? "y" : "ies"}`
                  }
                  subtitle="Overhead > 50% of revenue"
                  empty={computed.overheadBurden.length === 0}
                >
                  <ul className="space-y-1 text-xs">
                    {computed.overheadBurden.map((r) => (
                      <li
                        key={r.city}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <span className="text-deep-green/85">{r.city}</span>
                        <span className="font-mono font-bold tabular-nums text-coral">
                          {fmtPct(r.burdenPct)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </FinanceInsightCard>

                <FinanceInsightCard
                  tone="watch"
                  title="Cash Runway"
                  headline={
                    computed.runway.state === "near_breakeven"
                      ? "Near breakeven"
                      : computed.runway.state === "profitable"
                        ? "Profitable — building cash"
                        : `${computed.runway.runwayMonths !== null ? computed.runway.runwayMonths.toFixed(1) : "—"} mo runway`
                  }
                  subtitle={
                    computed.runway.state === "burning"
                      ? `${fmtMoney(computed.runway.currentCash)} cash · ${fmtMoney(computed.runway.monthlyNet, true)}/mo avg`
                      : `${fmtMoney(computed.runway.currentCash)} cash · ${fmtMoney(computed.runway.monthlyNet, true)}/mo avg`
                  }
                />

                <FinanceInsightCard
                  tone="watch"
                  title="Spot Mix (Company-wide)"
                  headline={
                    computed.mix.total === 0
                      ? "No spots logged"
                      : `${computed.mix.total.toLocaleString("en-US")} spots`
                  }
                  empty={computed.mix.total === 0}
                >
                  <SpotMixBar mix={computed.mix} />
                </FinanceInsightCard>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function CategoryLabel({
  tone,
  children,
}: {
  tone: "working" | "attention" | "watch";
  children: React.ReactNode;
}) {
  const dot =
    tone === "working"
      ? "bg-mint"
      : tone === "attention"
        ? "bg-coral"
        : "bg-gold";
  const sym = tone === "working" ? "↑" : tone === "attention" ? "↓" : "◆";
  return (
    <div className="mt-5 mb-3 flex items-center gap-2 first:mt-0">
      <span
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-deep-green ${dot}`}
        aria-hidden
      >
        {sym}
      </span>
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-deep-green/70">
        {children}
      </h3>
    </div>
  );
}

function VenueNetList({
  rows,
  sign,
}: {
  rows: VenueInsightRow[];
  sign?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((r) => (
        <li
          key={`${r.city}|${r.venue}`}
          className="flex items-baseline justify-between gap-2"
        >
          <span className="truncate text-deep-green/85">
            {r.venue}
            <span className="ml-1 text-deep-green/45">· {r.city}</span>
          </span>
          <span
            className={`font-mono font-bold tabular-nums ${r.net >= 0 ? "text-mint-hover" : "text-coral"}`}
          >
            {fmtMoney(r.net, sign)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MemberHeavyList({ rows }: { rows: MemberHeavyRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((r) => (
        <li
          key={`${r.city}|${r.venue}`}
          className="flex items-baseline justify-between gap-2"
        >
          <span className="truncate text-deep-green/85">
            {r.venue}
            <span className="ml-1 text-deep-green/45">· {r.city}</span>
          </span>
          <span
            className="font-mono font-bold tabular-nums text-mint-hover"
            title={`${r.memberCount} member · ${r.dailyCount} daily · ${r.total} total`}
          >
            {fmtPct(r.memberPct)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function VenueMixList({
  rows,
  metric,
}: {
  rows: VenueInsightRow[];
  metric: "member" | "other";
}) {
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((r) => {
        const value = metric === "member" ? r.spots.member : r.spots.other;
        const pct = r.spots.total > 0 ? value / r.spots.total : 0;
        return (
          <li
            key={`${r.city}|${r.venue}`}
            className="flex items-baseline justify-between gap-2"
          >
            <span className="truncate text-deep-green/85">
              {r.venue}
              <span className="ml-1 text-deep-green/45">· {r.city}</span>
            </span>
            <span className="font-mono font-bold tabular-nums text-deep-green/75">
              {fmtPct(pct)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function MembershipHealthList({ rows }: { rows: MembershipHealthRow[] }) {
  if (rows.length === 0) return null;
  const verdictLabel: Record<MembershipHealthRow["verdict"], string> = {
    strong: "Strong",
    break_even_plus: "BE+",
    marginal: "Marginal",
    overpaying: "Overpaying",
  };
  const verdictCls: Record<MembershipHealthRow["verdict"], string> = {
    strong: "bg-mint text-deep-green ring-mint/60",
    break_even_plus: "bg-mint-soft text-deep-green ring-mint/40",
    marginal: "bg-gold-soft text-deep-green ring-gold/60",
    overpaying: "bg-coral-soft text-coral ring-coral/40",
  };
  return (
    <table className="w-full text-[11px]">
      <thead className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
        <tr>
          <th className="py-1 text-left">City</th>
          <th className="py-1 text-right">Mbrs</th>
          <th className="py-1 text-right">Actual</th>
          <th className="py-1 text-right">BE</th>
          <th className="py-1 text-right">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.city} className="border-t border-cream-line/40">
            <td className="py-1.5 text-deep-green/85">{r.city}</td>
            <td className="py-1.5 text-right font-mono tabular-nums text-deep-green/75">
              {r.members}
            </td>
            <td className="py-1.5 text-right font-mono tabular-nums text-deep-green/75">
              {r.actualMatchesPerMember.toFixed(1)}
            </td>
            <td className="py-1.5 text-right font-mono tabular-nums text-deep-green/55">
              {r.breakEvenMatches.toFixed(1)}
            </td>
            <td className="py-1.5 text-right">
              <span
                className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 ring-inset ${verdictCls[r.verdict]}`}
              >
                {verdictLabel[r.verdict]}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SpotMixBar({
  mix,
}: {
  mix: { memberPct: number; dppPct: number; otherPct: number; total: number };
}) {
  if (mix.total === 0) return null;
  const memberPct = Math.round(mix.memberPct * 100);
  const dppPct = Math.round(mix.dppPct * 100);
  const otherPct = 100 - memberPct - dppPct;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full ring-1 ring-cream-line">
        <div
          className="h-full bg-mint"
          style={{ width: `${memberPct}%` }}
          aria-label={`Members ${memberPct}%`}
        />
        <div
          className="h-full bg-deep-green"
          style={{ width: `${dppPct}%` }}
          aria-label={`DPP ${dppPct}%`}
        />
        <div
          className="h-full bg-gold"
          style={{ width: `${otherPct}%` }}
          aria-label={`Promo ${otherPct}%`}
        />
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] font-bold uppercase tracking-wider">
        <span className="text-mint-hover">Members {memberPct}%</span>
        <span className="text-deep-green/85">DPP {dppPct}%</span>
        <span className="text-deep-green/65">Promo {otherPct}%</span>
      </div>
    </div>
  );
}
