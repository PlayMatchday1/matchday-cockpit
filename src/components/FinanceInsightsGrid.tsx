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
  getCurrentQ2Month,
  membershipHealthAvailable,
  monthScopedTitle,
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
  HIGH_PROMO_MIN_SPOTS,
  HIGH_PROMO_THRESHOLD,
  MEMBER_HEAVY_MIN_SPOTS,
  MEMBER_HEAVY_THRESHOLD,
  highPromoUsageFromMatches,
  memberHeavyFieldsFromMatches,
  spotMixByCityFromMatches,
  topPromoCodesFromMatches,
  type HighPromoRow,
  type MemberHeavyRow,
  type SpotMixCityRow,
  type TopPromoCodeRow,
} from "@/lib/matchInsights";

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
      highPromo: highPromoUsageFromMatches(matchRows, data, month),
      topPromoCodes: topPromoCodesFromMatches(matchRows, month),
      newStruggling: newVenuesStruggling(venueRows),
      overheadBurden: overheadBurdenCities(cityRows),
      spotMix: spotMixByCityFromMatches(matchRows, month),
      mhAvailable: membershipHealthAvailable(data),
      mhRows: buildMembershipHealthRows(data, matchRows, month),
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
                  title={monthScopedTitle("Profitable Fields", month)}
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
                  title={monthScopedTitle("Profitable Cities", month)}
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
                  title={monthScopedTitle("Member-Heavy Fields", month)}
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
              </div>

              <CategoryLabel tone="attention">Needs Attention</CategoryLabel>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                <FinanceInsightCard
                  tone="attention"
                  title={monthScopedTitle("Unprofitable Fields", month)}
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
                  title={monthScopedTitle("Unprofitable Cities", month)}
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
                  title={monthScopedTitle("High Promo Usage", month)}
                  headline={
                    computed.highPromo.length === 0
                      ? "None flagged"
                      : `${computed.highPromo.length} field${computed.highPromo.length === 1 ? "" : "s"}`
                  }
                  subtitle={`≥${Math.round(HIGH_PROMO_THRESHOLD * 100)}% promo, ${HIGH_PROMO_MIN_SPOTS}+ spots`}
                  empty={computed.highPromo.length === 0}
                >
                  <HighPromoList rows={computed.highPromo.slice(0, 5)} />
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

                <FinanceInsightCard
                  tone="attention"
                  title={monthScopedTitle("Top Promo Codes", month)}
                  headline={
                    computed.topPromoCodes.distinctCount === 0
                      ? "No promo usage this month"
                      : `${computed.topPromoCodes.distinctCount} code${computed.topPromoCodes.distinctCount === 1 ? "" : "s"}`
                  }
                  subtitle="Most-used discount codes this month"
                  empty={computed.topPromoCodes.distinctCount === 0}
                >
                  <TopPromoCodesList
                    rows={computed.topPromoCodes.rows.slice(0, 5)}
                  />
                </FinanceInsightCard>
              </div>

              <CategoryLabel tone="watch">Watch</CategoryLabel>
              <div className="space-y-4">
                {/* Row 1 — full-width Membership Health */}
                <FinanceInsightCard
                  tone="watch"
                  title={monthScopedTitle("Membership Health", month)}
                  headline={
                    !computed.mhAvailable
                      ? "Data needed"
                      : computed.mhRows.length === 0
                        ? "No qualifying cities"
                        : `${computed.mhRows.length} ${computed.mhRows.length === 1 ? "city" : "cities"}`
                  }
                  subtitle={
                    computed.mhAvailable
                      ? "Average matches played per member this month vs. matches needed to cover their membership cost."
                      : undefined
                  }
                  empty={computed.mhAvailable && computed.mhRows.length === 0}
                >
                  {!computed.mhAvailable ? (
                    <div className="text-xs italic text-deep-green/55">
                      Membership Health requires fin_members + fin_venues
                      with member_price set + a current user_analysis
                      upload — re-import to enable.
                    </div>
                  ) : (
                    <MembershipHealthList rows={computed.mhRows} />
                  )}
                </FinanceInsightCard>

                {/* Row 2 — two equal-width cards (50/50 split) */}
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <FinanceInsightCard
                    tone="watch"
                    title={monthScopedTitle("Overhead Burden", month)}
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
                    title="New Venues Profitable"
                    headline={
                      computed.newProfit.length === 0
                        ? "None this month"
                        : `${computed.newProfit.length} new venue${computed.newProfit.length === 1 ? "" : "s"}`
                    }
                    subtitle="Launched 30–90 days ago"
                    empty={computed.newProfit.length === 0}
                  >
                    <VenueNetList
                      rows={computed.newProfit.slice(0, 5)}
                      sign
                    />
                  </FinanceInsightCard>
                </div>

                {/* Row 3 — full-width Spot Mix by City */}
                <FinanceInsightCard
                  tone="watch"
                  title={monthScopedTitle("Spot Mix by City", month)}
                  headline={
                    computed.spotMix.grandTotal === 0
                      ? "No spots logged"
                      : `${computed.spotMix.grandTotal.toLocaleString("en-US")} spots`
                  }
                  subtitle="Composition of spots played this month by city. Higher member % indicates stronger retention."
                  empty={computed.spotMix.rows.length === 0}
                >
                  <SpotMixByCityTable rows={computed.spotMix.rows} />
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

function TopPromoCodesList({ rows }: { rows: TopPromoCodeRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((r) => (
        <li
          key={r.code}
          className="flex items-baseline justify-between gap-2"
        >
          <span className="truncate font-mono text-deep-green/85">
            {r.code}
          </span>
          <span className="font-mono font-bold tabular-nums text-coral">
            {r.count.toLocaleString("en-US")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function HighPromoList({ rows }: { rows: HighPromoRow[] }) {
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
            className="font-mono font-bold tabular-nums text-coral"
            title={`${r.promoCount} promo / ${r.total} total`}
          >
            {fmtPct(r.promoPct)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MembershipHealthList({ rows }: { rows: MembershipHealthRow[] }) {
  if (rows.length === 0) return null;
  const verdictLabel: Record<MembershipHealthRow["verdict"], string> = {
    strong: "Strong",
    break_even_plus: "BE+",
    marginal: "Marginal",
    at_risk: "At Risk",
  };
  // Pill palette per spec — inline arbitrary hexes since these don't
  // map cleanly onto the existing brand tokens.
  const verdictCls: Record<MembershipHealthRow["verdict"], string> = {
    strong: "bg-[#C8F1DD] text-[#0F6E56]",
    break_even_plus: "bg-[#DCF5E8] text-[#1D9E75]",
    marginal: "bg-[#FCE8C7] text-[#854F0B]",
    at_risk: "bg-[#F7C1C1] text-[#A32D2D]",
  };
  return (
    <table className="w-full text-[11px]">
      <thead className="text-[10px] font-bold uppercase tracking-wider text-deep-green/50">
        <tr>
          <th className="py-1 pr-3 text-left">City</th>
          <th className="px-2.5 py-1 text-right">Members</th>
          <th className="px-2.5 py-1 text-right">Played</th>
          <th className="px-2.5 py-1 text-right">Need</th>
          <th className="px-2.5 py-1 text-right">Ratio</th>
          <th className="py-1 pl-3 text-right">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.city} className="border-t border-cream-line/40">
            <td className="py-1.5 pr-3 text-deep-green/85">{r.city}</td>
            <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-deep-green/75">
              {r.members}
            </td>
            <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-deep-green/85">
              {r.actualMatchesPerMember.toFixed(1)}
            </td>
            <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-deep-green/55">
              {r.breakEvenMatches.toFixed(1)}
            </td>
            <td
              className="px-2.5 py-1.5 text-right font-mono tabular-nums text-deep-green/85"
              title={`${r.actualMatchesPerMember.toFixed(1)} played / ${r.breakEvenMatches.toFixed(1)} need`}
            >
              {Number.isFinite(r.ratio) && r.ratio > 0
                ? `${r.ratio.toFixed(1)}x`
                : "—"}
            </td>
            <td className="py-1.5 pl-3 text-right">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${verdictCls[r.verdict]}`}
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

function SpotMixByCityTable({ rows }: { rows: SpotMixCityRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-3">
      {/* Legend — three colored swatches keyed to the bar segments */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[#2CDB87]" aria-hidden />
          Member
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[#003326]" aria-hidden />
          DPP
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[#FFD43B]" aria-hidden />
          Promo
        </span>
      </div>

      {rows.map((r) => (
        <SpotMixCityRowItem key={r.city} row={r} />
      ))}
    </div>
  );
}

function SpotMixCityRowItem({ row }: { row: SpotMixCityRow }) {
  const memberPct = Math.round(row.memberPct * 100);
  const dppPct = Math.round(row.dppPct * 100);
  // Force the three to sum to 100 for the rendered labels even when
  // the raw fractions round inconsistently — keeps the eye trusting
  // the row.
  const promoPct = Math.max(0, 100 - memberPct - dppPct);
  const memberHighlight = row.memberPct >= 0.35;
  const promoHighlight = row.promoPct >= 0.1;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-bold text-deep-green/85">{row.city}</span>
        <span className="font-mono tabular-nums text-deep-green/55">
          {row.total.toLocaleString("en-US")}
        </span>
      </div>
      <div
        className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-deep-green/10"
        title={`${row.member} member · ${row.dpp} dpp · ${row.promo} promo`}
      >
        <div className="h-full bg-[#2CDB87]" style={{ width: `${memberPct}%` }} />
        <div className="h-full bg-[#003326]" style={{ width: `${dppPct}%` }} />
        <div className="h-full bg-[#FFD43B]" style={{ width: `${promoPct}%` }} />
      </div>
      <div className="mt-1 flex gap-3 font-mono text-[10px] tabular-nums text-deep-green/55">
        <span className={memberHighlight ? "font-bold text-mint-hover" : ""}>
          {memberPct}% mbr
        </span>
        <span>{dppPct}% dpp</span>
        <span className={promoHighlight ? "font-bold text-coral" : ""}>
          {promoPct}% promo
        </span>
      </div>
    </div>
  );
}
