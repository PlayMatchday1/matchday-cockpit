"use client";

/* FINANCE › REVENUE — THE TOP: title, month status, Gross collected and the calculation under it,
 * line items, and DPP / Membership / Avg daily DPP. The spec is scripts/mocks/finance-revenue-v2.html
 * and its assert file; structure, wording and data-testids follow it.
 *
 * EVERY FIGURE IS ONE totalsOf() CALL over fin_txn (src/lib/revenueTxn.ts), so the calculation,
 * the line items and the city table below cannot disagree: they are sums of the same integer
 * per-row amounts. The period controls are the Finance bar's, above this (the mock draws its own;
 * the app has one for every Finance page). */
import { useMemo, useState } from "react";
import type { FinancePeriod } from "@/lib/financePeriod";
import { projectMonthEnd } from "@/lib/financePeriod";
import { BUSINESS_TZ, zonedWallClockToUtcMs } from "@/lib/businessHours";
import {
  finalThreshold, money, monthStatus, totalsOf, isRevenueRow, taxCentsOf,
  type RollupRow, type Totals,
} from "@/lib/revenueTxn";
import { loadRollup, loadStatusInputs, useAsync, useReaderId } from "@/lib/useRevenueTxn";
import { InfoI } from "./RevenueInfo";

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const ymdOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const centralMidnight = (d: Date) => zonedWallClockToUtcMs(d.getFullYear(), d.getMonth() + 1, d.getDate(), 0, 0, BUSINESS_TZ);
const $c = (cents: number) => money(cents, true);
const dollars = (cents: number) => (cents / 100).toFixed(2);

export default function RevenueTop({ period, rows, error }: {
  period: FinancePeriod;
  /** The period's fin_txn rollup (month grain). Null while loading. */
  rows: RollupRow[] | null;
  error: string | null;
}) {
  const uid = useReaderId();
  const [open, setOpen] = useState(false);
  const t: Totals | null = useMemo(() => (rows ? totalsOf(rows) : null), [rows]);

  // ── STATUS: the period's last month decides it (a quarter is final when its last month is). ──
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

  // ── PACE TO MONTH END: the current month only, on net revenue, from the day rollup. ──
  const isCurMonth = period.grain === "month" && period.isCurrent;
  const day = useAsync(
    isCurMonth && uid ? `pace|${uid}|${ymdOf(period.start)}` : null,
    () => loadRollup(uid!, { from: ymdOf(period.start), to: ymdOf(period.end), grain: "day", byVenue: false }),
  );
  const pace = useMemo(() => {
    if (!isCurMonth || !day.data || !t) return null;
    const netOn = (pred: (d: number) => boolean) => day.data!
      .filter((r) => isRevenueRow(r) && pred(Number(r.period.slice(8, 10))))
      .reduce((a, r) => a + r.gross_cents - taxCentsOf(r), 0);
    const p = projectMonthEnd({
      soFar: t.net, excludedRevenue: netOn((d) => d <= 1), currentDayRevenue: netOn((d) => d === period.elapsedDays),
      daysElapsed: period.elapsedDays, daysInMonth: period.totalDays, excludedDays: 1, isCurrentMonth: true,
    });
    return p.ok ? p : null;
  }, [isCurMonth, day.data, t, period.elapsedDays, period.totalDays]);

  // AVG DAILY DPP: a closed period divides by its days; the period in progress by the days so far,
  // because dividing a partial month by its full length understates every day of it.
  const days = period.isCurrent ? Math.max(1, period.elapsedDays) : period.totalDays;

  const pct = (v: number) => (t && t.gross ? `${((Math.abs(v) / t.gross) * 100).toFixed(1)}%` : "");
  const items: [string, number, number | null, string, Parameters<typeof InfoI>[0]["pop"] | null, string][] = t ? [
    ["Card charges", t.charges, t.chargesN, "Stripe", "gross", ""],
    ["Venmo (manual)", t.venmo, t.venmoN, "Entered by hand", "venmo", ""],
    ["Refunds", t.refunds, t.refundsN, "Stripe", "rev", ""],
    ["Failed payments", t.failed, t.failedN, "Stripe", "failed", ""],
    ["Disputes", t.disputes, t.disputesN, "Stripe", "rev", ""],
    ["Sales tax", t.tax, null, "Calculated by city", "tax", ""],
    ["Net revenue", t.net, null, "", "net", "sub"],
    ["Stripe fees", t.fees, null, `${pct(t.fees)} of gross`, "fees", ""],
    ["Kept after fees", t.kept, null, "", null, "sub2"],
  ] : [];

  const statusText = !status ? "…"
    : status.k === "updating" ? `Updating · final by ${status.finalBy}`
    : status.k === "final" ? "Final"
    : `Adjusted after final · ${status.cents >= 0 ? "+" : ""}${$c(status.cents)} in ${status.n} ${status.n === 1 ? "row" : "rows"}`;

  return (
    <div className="rv2" data-testid="revenue-top" style={{ display: "grid", gap: 14 }}>
      <div className="rv2-head">
        <h2>Revenue <InfoI pop="how" large label="How we count revenue" testid="info-how" /></h2>
        <span className={`status ${status?.k ?? ""}`} data-testid="status" data-status={status?.k ?? ""}>{statusText}</span>
        <InfoI pop="status" label="What updating and final mean" testid="info-status" />
      </div>

      {error && <div className="warn" data-testid="revenue-error">Revenue did not load: {error}</div>}
      {t && t.missingRate.length > 0 && (
        <div className="warn" data-testid="revenue-missing-rate">
          No sales-tax rate on file for {t.missingRate.join(", ")}. Their sales tax is counted as $0 until a
          rate is added to salesTax.ts, so net revenue is overstated by that tax.
        </div>
      )}

      {/* THE HERO RENDERS ONLY WITH ITS FIGURES. Its testid is the mock's ready signal, and a hero
          full of "…" would be read as $0 by anything that waits for it. */}
      {!t ? (
        <section className="hero" data-testid="hero-loading" style={{ color: "#7b8b82" }}>{error ? "—" : "Loading revenue…"}</section>
      ) : (
      <section className="hero" data-testid="hero">
        <div className="hero-top">
          <div className="big">
            <div className="k">Gross collected <InfoI pop="gross" label="What gross collected is" testid="info-gross" /></div>
            <div className="v num" data-testid="gross-revenue">{t ? money(t.gross) : "…"}</div>
            <div className="calc" data-testid="bridge">
              <div className="cl neg"><span>Refunds &amp; failed payments</span><span className="num" data-b="ref">{t ? money(t.refunds + t.failed) : ""}</span></div>
              <div className="cl neg"><span>Disputes</span><span className="num" data-b="dis">{t ? money(t.disputes) : ""}</span></div>
              <div className="cl neg"><span>Sales tax</span><span className="num" data-b="tax">{t ? money(t.tax) : ""}</span></div>
              <div className="cl tot"><span>Net revenue <InfoI pop="net" label="What net revenue is" testid="info-net" /></span><span className="num" data-b="net" data-testid="net-revenue" data-cents={t?.net}>{t ? money(t.net) : ""}</span></div>
              <div className="cl fee"><span>Stripe fees</span><span className="num" data-b="fees">{t ? money(t.fees) : ""}</span></div>
              <div className="cl kept"><span>Kept after fees</span><span className="num" data-b="kept">{t ? money(t.kept) : ""}</span></div>
            </div>
            <button type="button" className="toggle" data-testid="toggle-items" aria-expanded={open}
              onClick={() => setOpen((o) => !o)}>{open ? "Hide line items" : "Show line items"}</button>
          </div>
          <div className="minis">
            <div className="mini"><div className="k">DPP <InfoI pop="dpp" label="What DPP is" /></div>
              <div className="v num" data-testid="mini-dpp" data-cents={t?.dpp}>{t ? money(t.dpp) : "…"}</div><div className="s">net</div></div>
            <div className="mini"><div className="k">Membership <InfoI pop="mem" label="What membership is" /></div>
              <div className="v num" data-testid="mini-mem" data-cents={t?.membership}>{t ? money(t.membership) : "…"}</div><div className="s">net</div></div>
            <div className="mini"><div className="k">Avg daily DPP <InfoI pop="avg" label="How average daily is calculated" /></div>
              <div className="v num" data-testid="mini-avg" data-days={days}>{t ? money(t.dpp / days) : "…"}</div>
              <div className="s">net · ÷ {days} {period.isCurrent ? "days so far" : "days"}</div></div>
            {isCurMonth && (
              <div className="mini" data-testid="mini-pace"><div className="k">Pace to month end <InfoI pop="pace" label="How pace to month end is calculated">
                {pace && (
                  <table><tbody>
                    <tr><td>Net so far, days 1–{period.elapsedDays}</td><td>{money(t!.net)}</td></tr>
                    <tr><td>Daily rate, {pace.rateDays} days</td><td>{money(pace.rate)}</td></tr>
                    <tr><td>{pace.remaining} {pace.remaining === 1 ? "day" : "days"} remaining</td><td>{money(Math.round(pace.projection) - t!.net)}</td></tr>
                    <tr><td><b>Projected</b></td><td><b>{money(pace.projection)}</b></td></tr>
                  </tbody></table>
                )}
              </InfoI></div>
                <div className="v num" data-testid="mini-pace-value">{pace ? money(pace.projection) : "—"}</div><div className="s">net, projected</div></div>
            )}
          </div>
        </div>

        <div hidden={!open} data-testid="line-items">
          <table className="items"><tbody>
            {items.map(([l, v, n, src, pop, cls]) => (
              <tr key={l} className={cls} data-testid={`item-${l.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
                <td><span className="lbl">{l}{pop && <> <InfoI pop={pop} label={`About ${l}`} /></>}</span></td>
                <td className="cnt num">{n != null ? n.toLocaleString("en-US") : ""}</td>
                <td className="src">{src}</td>
                <td className={`amt num ${v < 0 ? "neg" : ""}`} data-v={dollars(v)}>{$c(v)}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      </section>
      )}
    </div>
  );
}

/** Per-month totals for the four-month table, keyed by the rollup's period ("2026-09-01"). */
export function totalsByMonth(rows: RollupRow[]): Map<string, Totals> {
  const by = new Map<string, RollupRow[]>();
  for (const r of rows) { const a = by.get(r.period) ?? []; a.push(r); by.set(r.period, a); }
  return new Map([...by].map(([k, v]) => [k, totalsOf(v)]));
}

/** "Sep 2026" → "2026-09-01", the rollup's month key. */
export const monthKeyOf = (label: string): string => {
  const [mon, yr] = label.split(" ");
  const i = MONTH_SHORT.findIndex((x) => x === mon.slice(0, 3));
  return `${yr}-${String(i + 1).padStart(2, "0")}-01`;
};

