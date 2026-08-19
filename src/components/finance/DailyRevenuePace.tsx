"use client";

// DAILY REVENUE PACE — the selected month day by day, against a comparison series.
//
// Built to mockups/MD_clubhouse_build_vMKTG.html. Clubhouse had no daily view: the Revenue page
// drew one bar per period, so "are we ahead of last month?" could only be answered at month end,
// which is the wrong end of the month to ask it.
//
// IT READS fin_revenue DIRECTLY, and that is deliberate. useFinanceDataForQuarter loads the
// SELECTED quarter and aggregates by month — the right shape for the rest of the page and the wrong
// one here, where a "previous year avg" needs twelve months of DAILY rows. One bounded query over
// the union of the two windows is cheaper and clearer than widening the shared loader for one card.
//
// THE PARTIAL-MONTH RULE. The current month is usually incomplete. Drawing the comparison across
// all 31 days while the current line stops on the 18th makes the current period look like a
// collapse in revenue. So the comparison is truncated to the last day the current period actually
// has. This is the single most important line in the file.
//
// BOTH SERIES SHARE THE FILTERS. A city or field filter that moved one line and not the other would
// be worse than no filter at all — it would invite a comparison between two different businesses.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import { fmtMoney } from "@/components/growth/format";
import s from "./financeSection.module.css";

type Row = { date: string; city: string; venue: string | null; type: string; gross: number };
type Compare = "month" | "quarter" | "year";

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const iso = (y: number, m0: number) => `${y}-${String(m0 + 1).padStart(2, "0")}`;
const label = (y: number, m0: number) => `${MONTH_SHORT[m0]} ${y}`;
const daysIn = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate();

// MEMBERSHIP vs DPP is a `type` on the row. Anything not obviously a membership is direct play.
const isMembership = (t: string) => /member/i.test(t ?? "");

/** Sum gross per day-of-month for one calendar month, after the View filters. */
function dailySeries(rows: Row[], y: number, m0: number, city: string, field: string, kind: string): number[] {
  const prefix = iso(y, m0);
  const out = new Array<number>(daysIn(y, m0)).fill(0);
  for (const r of rows) {
    if (!r.date?.startsWith(prefix)) continue;
    if (city !== "All cities" && r.city !== city) continue;
    if (field !== "All fields" && (r.venue ?? "") !== field) continue;
    if (kind === "dpp" && isMembership(r.type)) continue;
    if (kind === "member" && !isMembership(r.type)) continue;
    const d = Number(r.date.slice(8, 10));
    if (d >= 1 && d <= out.length) out[d - 1] += Number(r.gross ?? 0);
  }
  return out;
}

/** The months a comparison averages over, and what to call it. */
function comparisonMonths(y: number, m0: number, mode: Compare): { months: [number, number][]; label: string } {
  if (mode === "month") {
    const py = m0 === 0 ? y - 1 : y, pm = m0 === 0 ? 11 : m0 - 1;
    return { months: [[py, pm]], label: label(py, pm) };
  }
  if (mode === "quarter") {
    // The quarter BEFORE the one this month sits in.
    const q = Math.floor(m0 / 3) - 1;
    const qy = q < 0 ? y - 1 : y, qq = q < 0 ? 3 : q;
    const months = [0, 1, 2].map((k) => [qy, qq * 3 + k] as [number, number]);
    return { months, label: `${MONTH_SHORT[qq * 3]}–${MONTH_SHORT[qq * 3 + 2]} ${qy} avg` };
  }
  const py = y - 1;
  return { months: Array.from({ length: 12 }, (_, k) => [py, k] as [number, number]), label: `${py} monthly avg` };
}

export default function DailyRevenuePace() {
  const { period } = useFinancePeriod();
  // The month this card charts: the period's last in-range month, so a quarter or year selection
  // lands on its most recent month rather than silently charting nothing.
  const anchor = period.months[period.months.length - 1] ?? "";
  const [mLab, yStr] = anchor.split(" ");
  const year = Number(yStr);
  const m0 = MONTH_SHORT.indexOf(mLab);

  const [compare, setCompare] = useState<Compare>("month");
  const [city, setCity] = useState("All cities");
  const [field, setField] = useState("All fields");
  const [kind, setKind] = useState("total");
  const [rows, setRows] = useState<Row[] | null>(null);

  // ONE QUERY over the union of both windows. The earliest month any comparison needs is the
  // previous January (the year-average case), so the lower bound is derived, never guessed.
  useEffect(() => {
    if (!Number.isFinite(year) || m0 < 0) return;
    let live = true;
    const lo = `${year - 1}-01-01`;
    const hi = `${year}-${String(m0 + 1).padStart(2, "0")}-${String(daysIn(year, m0)).padStart(2, "0")}`;
    void (async () => {
      // PAGED. PostgREST caps a response at 1,000 rows, and this window is up to 20 months of a
      // 7,800-row table — an unpaged read silently returned the OLDEST 1,000 and nothing since,
      // so the current month charted empty and both nearer comparisons reported "no revenue on
      // record" for months holding tens of thousands of dollars. A truncated read that looks like
      // an answer is the failure mode this whole page keeps producing.
      const page = 1000;
      const acc: Row[] = [];
      for (let from = 0; ; from += page) {
        const { data, error } = await supabase
          .from("fin_revenue").select("date, city, venue, type, gross")
          .gte("date", lo).lte("date", hi).order("date").range(from, from + page - 1);
        if (error || !data) break;
        acc.push(...(data as Row[]));
        if (data.length < page) break;
      }
      if (live) setRows(acc);
    })();
    return () => { live = false; };
  }, [year, m0]);

  const cities = useMemo(
    () => ["All cities", ...[...new Set((rows ?? []).map((r) => r.city).filter(Boolean))].sort()],
    [rows],
  );
  const fields = useMemo(
    () => ["All fields", ...[...new Set((rows ?? []).map((r) => r.venue ?? "").filter(Boolean))].sort()],
    [rows],
  );

  const current = useMemo(
    () => (rows ? dailySeries(rows, year, m0, city, field, kind) : []),
    [rows, year, m0, city, field, kind],
  );

  // THE LAST DAY THE CURRENT PERIOD ACTUALLY HAS. Past the final non-zero day there is no current
  // line, so the comparison must stop too.
  const lastDay = useMemo(() => {
    for (let i = current.length - 1; i >= 0; i--) if (current[i] > 0) return i + 1;
    return 0;
  }, [current]);

  const comparisons = useMemo(() => {
    if (!rows) return null;
    const out: Record<Compare, { label: string; data: number[]; has: boolean }> = {} as never;
    for (const mode of ["month", "quarter", "year"] as Compare[]) {
      const { months, label: lab } = comparisonMonths(year, m0, mode);
      const series = months.map(([yy, mm]) => dailySeries(rows, yy, mm, city, field, kind));
      const width = Math.max(...series.map((x) => x.length), 0);
      const avg = Array.from({ length: width }, (_, d) =>
        Math.round(series.reduce((sum, x) => sum + (x[d] ?? 0), 0) / series.length));
      // A comparison is LIVE only if the months behind it carry revenue. An early-2023 month has no
      // prior year, and an empty average drawn as a flat $0 line reads as a real collapse.
      out[mode] = { label: lab, data: avg, has: series.some((x) => x.some((v) => v > 0)) };
    }
    return out;
  }, [rows, year, m0, city, field, kind]);

  const comp = comparisons?.[compare] ?? null;
  const compData = comp && comp.has ? comp.data.slice(0, Math.max(lastDay, 1)) : [];

  // ── the plot ────────────────────────────────────────────────────────────────────────────────
  const W = 980, H = 260, ML = 68, MR = 24, MT = 18, MB = 34;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const nDays = current.length || 31;
  const peak = Math.max(1, ...current, ...compData);
  // A rounded ceiling, so the axis reads in round money rather than the exact maximum.
  const step = Math.pow(10, Math.max(0, String(Math.round(peak)).length - 2));
  const maxY = Math.max(step, Math.ceil((peak * 1.12) / step) * step);
  const x = (i: number) => ML + (nDays === 1 ? plotW / 2 : (i * plotW) / (nDays - 1));
  const y = (v: number) => MT + plotH - (v / maxY) * plotH;
  const path = (d: number[]) => d.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");

  const scope = field !== "All fields" ? field : city !== "All cities" ? city : "All Matchday";
  const kindLab = kind === "dpp" ? "DPP only" : kind === "member" ? "Membership only" : "DPP + Membership";

  return (
    <div className={s.card} data-testid="pace-card">
      <div className={s.cardHead}>
        <div>
          <div className={s.cardTitle} data-testid="pace-title">Daily revenue pace</div>
          <div className={s.cardSub} data-testid="pace-sub">
            {scope} · {anchor} by day compared with {comp?.has ? comp.label : "—"}
          </div>
        </div>
        <div className={s.ctrlStack}>
          <div className={s.ctrlGroup}>
            <span className={s.ctrlLab}>Compare with</span>
            <div className={s.seg} role="group" aria-label="Comparison series">
              {([["month", "Previous month"], ["quarter", "Previous quarter avg"], ["year", "Previous year avg"]] as [Compare, string][])
                .map(([v, t]) => {
                  const has = comparisons?.[v]?.has ?? true;
                  return (
                    <button key={v} type="button" disabled={!has}
                      data-testid={`pace-cmp-${v}`} data-disabled={!has ? "true" : "false"}
                      aria-pressed={compare === v}
                      className={compare === v ? s.on : ""}
                      // DISABLED WITH THE REASON, never hidden and never silently empty.
                      title={has ? undefined : `No revenue on record for ${comparisons?.[v]?.label ?? "that period"} — nothing to compare against.`}
                      onClick={() => has && setCompare(v)}>{t}</button>
                  );
                })}
            </div>
          </div>
          <div className={s.ctrlGroup}>
            <span className={s.ctrlLab}>View</span>
            <select className={s.sel} data-testid="pace-city" value={city} onChange={(e) => setCity(e.target.value)}>
              {cities.map((c) => <option key={c}>{c}</option>)}
            </select>
            <select className={s.sel} data-testid="pace-field" value={field} onChange={(e) => setField(e.target.value)}>
              {fields.map((f) => <option key={f}>{f}</option>)}
            </select>
            <select className={s.sel} data-testid="pace-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="total">DPP + Membership</option>
              <option value="dpp">DPP only</option>
              <option value="member">Membership only</option>
            </select>
          </div>
        </div>
      </div>

      {rows === null ? (
        <div className={s.legend} data-testid="pace-loading">Loading…</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" data-testid="pace-chart"
          aria-label={`Daily revenue for ${anchor}, ${scope}`}>
          {[0, 1, 2, 3, 4].map((i) => {
            const yy = MT + (i * plotH) / 4;
            return (
              <g key={i}>
                <line x1={ML} y1={yy} x2={ML + plotW} y2={yy} stroke="#e6e2d8" strokeWidth={1} />
                <text x={ML - 10} y={yy + 4} textAnchor="end" fontSize={10} fill="#7b8b82">
                  {fmtMoney(maxY - (maxY * i) / 4)}
                </text>
              </g>
            );
          })}
          {Array.from({ length: nDays }, (_, i) => i).filter((i) => i % 3 === 0 || i === nDays - 1).map((i) => (
            <text key={i} x={x(i)} y={H - 12} textAnchor="middle" fontSize={10} fill="#7b8b82">{i + 1}</text>
          ))}
          {compData.length > 0 && (
            <path d={path(compData)} fill="none" stroke="#3f7fd6" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" data-testid="pace-line-compare" />
          )}
          <path d={path(current.slice(0, Math.max(lastDay, 1)))} fill="none" stroke="#2fa36b" strokeWidth={3}
            strokeLinecap="round" strokeLinejoin="round" data-testid="pace-line-current" />
        </svg>
      )}

      <div className={s.legend}>
        <span><i className={s.dot} style={{ background: "#2fa36b" }} />{anchor}</span>
        {comp?.has
          ? <span><i className={s.dot} style={{ background: "#3f7fd6" }} />{comp.label}</span>
          : <span data-testid="pace-cmp-empty">
              No revenue on record for {comp?.label ?? "the comparison period"} — that comparison is unavailable, not zero.
            </span>}
        {lastDay > 0 && lastDay < nDays && (
          // Says why the lines stop, rather than letting a short line read as a fall in revenue.
          <span data-testid="pace-partial">
            Drawn to day {lastDay} — {anchor} has no revenue recorded after it, and the comparison is
            cut to the same day so the two are read against equal ground.
          </span>
        )}
        <span>{kindLab}</span>
      </div>
    </div>
  );
}
