"use client";

/* THE FINANCE PAGE HEADER — the page name, then the ONE pinned filter bar: Month / Quarter / Year,
 * the arrows and label, the status tag, This month, and the page's selects (2026-10-10: Revenue,
 * Cost and Cities share it, so the three pages read the same way).
 *
 * The caller renders it as a child of its page-long column (a sticky element only sticks inside its
 * parent) and inside an `rv2` scope with RV2_CSS, which styles the title, the tag and the info icons.
 * The status tag is the Revenue page's: fin_txn's sync state for the period's last month. */
import { useMemo } from "react";
import type { FinancePeriod } from "@/lib/financePeriod";
import { changeGrain, currentPeriod, stepPeriod } from "@/lib/financePeriod";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import { BUSINESS_TZ, zonedWallClockToUtcMs } from "@/lib/businessHours";
import { finalThreshold, money, monthStatus, type MonthStatus } from "@/lib/revenueTxn";
import { loadStatusInputs, useAsync, type StatusInputs } from "@/lib/useRevenueTxn";
import FinancePeriodBar from "./FinancePeriodBar";
import { InfoI } from "./RevenueInfo";

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const centralMidnight = (d: Date) => zonedWallClockToUtcMs(d.getFullYear(), d.getMonth() + 1, d.getDate(), 0, 0, BUSINESS_TZ);

/** The period's status: Updating / Final / Adjusted after final. `st` is the raw inputs (Revenue's
 *  pace reads the last sync from it). */
export function usePeriodStatus(period: FinancePeriod): { st: { data: StatusInputs | null; error: string | null }; status: MonthStatus | null } {
  const end = period.end;
  const y = end.getFullYear(), m1 = end.getMonth() + 1;
  const threshold = useMemo(
    () => finalThreshold(y, m1, (yy, mm, dd) => zonedWallClockToUtcMs(yy, mm, dd, 0, 0, BUSINESS_TZ)),
    [y, m1],
  );
  const finalBy = `${MONTH_SHORT[m1 === 12 ? 0 : m1]} 2`;
  const fromIso = new Date(centralMidnight(period.start)).toISOString();
  const toIso = new Date(centralMidnight(new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1))).toISOString();
  const st = useAsync(`${fromIso}|${toIso}`, () => loadStatusInputs(fromIso, toIso));
  const status = st.data ? monthStatus(threshold, st.data.lastSyncMs, st.data.adjustments, finalBy) : null;
  return { st, status };
}

export function statusTextOf(status: MonthStatus | null, period: FinancePeriod): string {
  return !status ? "…"
    : status.k === "updating" ? `Updating · ${period.isCurrent ? `${period.elapsedDays} of ${period.totalDays} days · ` : ""}final by ${status.finalBy}`
    : status.k === "final" ? "Final"
    : `Adjusted after final · ${status.cents >= 0 ? "+" : ""}${money(status.cents, true)} in ${status.n} ${status.n === 1 ? "row" : "rows"}`;
}

export default function FinancePageBar({ title, info, filters, testid }: {
  title: string;
  /** An info icon beside the title (Revenue's "How we count revenue"). */
  info?: React.ReactNode;
  /** The page's City / Field selects, drawn at the bar's right. */
  filters?: React.ReactNode;
  testid?: string;
}) {
  const { period, now, setPeriod } = useFinancePeriod();
  const { status } = usePeriodStatus(period);
  return (
    <>
      <h1 className="rv2-title" style={{ margin: 0 }} data-testid={testid ?? "finance-page-title"}>{title}{info ? <> {info}</> : null}</h1>
      <FinancePeriodBar
        period={period} now={now} supportedGrains={["month", "quarter", "year"]} unsupportedReason="" links={filters ?? null}
        onChangeGrain={(g) => setPeriod(changeGrain(period, g, now))}
        onStep={(dir) => setPeriod(stepPeriod(period, dir, now))}
        onJumpToNow={() => setPeriod(currentPeriod(period.grain, now))}
        pinned
        status={<span className="rv2-status">
          <span className={`status ${status?.k ?? ""}`} data-testid="status" data-status={status?.k ?? ""}>{statusTextOf(status, period)}</span>
          <InfoI pop="status" label="What updating and final mean" testid="info-status" />
        </span>}
      />
    </>
  );
}
