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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
      // NOT ROUNDED PER DAY. Rounding each of 31 days put the comparison series $2 away from the
      // month's own gross — small, but it made "this line sums to what the card says" untrue, and
      // an assertion that has to carry a tolerance stops catching the thing it is for. A
      // single-month comparison is now exactly that month.
      const avg = Array.from({ length: width }, (_, d) =>
        series.reduce((sum, x) => sum + (x[d] ?? 0), 0) / series.length);
      // A comparison is LIVE only if the months behind it carry revenue. An early-2023 month has no
      // prior year, and an empty average drawn as a flat $0 line reads as a real collapse.
      out[mode] = { label: lab, data: avg, has: series.some((x) => x.some((v) => v > 0)) };
    }
    return out;
  }, [rows, year, m0, city, field, kind]);

  const comp = comparisons?.[compare] ?? null;
  // DRAWN IN FULL, not cut to the current month's last recorded day. Two lines of different
  // lengths is the point: the short one is what has happened, the long one is what it is being
  // measured against for the rest of the month. Cutting the comparison to match hid the target.
  const compData = comp && comp.has ? comp.data : [];

  // ── the plot ────────────────────────────────────────────────────────────────────────────────
  const W = 980, H = 260, ML = 68, MR = 24, MT = 18, MB = 34;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const nDays = Math.max(current.length || 31, compData.length);
  const peak = Math.max(1, ...current, ...compData);
  // A rounded ceiling, so the axis reads in round money rather than the exact maximum.
  const step = Math.pow(10, Math.max(0, String(Math.round(peak)).length - 2));
  const maxY = Math.max(step, Math.ceil((peak * 1.12) / step) * step);
  const x = (i: number) => ML + (nDays === 1 ? plotW / 2 : (i * plotW) / (nDays - 1));
  const y = (v: number) => MT + plotH - (v / maxY) * plotH;
  const path = (d: number[]) => d.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");

  /* ── HOVER READOUT ────────────────────────────────────────────────────────────────────────
   * SNAPS TO THE NEAREST DAY FROM ANYWHERE IN THE PLOT, at any height. Hit-testing the line
   * itself would be unusable — it is 2-3px wide across a 980-unit viewBox — so the whole plot is
   * one target and the x position picks the day.
   *
   * PINNED is the touch path. A tap sets it; a tap on another day moves it; a tap outside clears
   * it. Without that the chart is inert on a phone, where there is no hover at all.
   */
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Pointer x → day index. The SVG scales to its container, so client pixels are converted back
  // into viewBox units before comparing against the same x() the paths are drawn with.
  const dayAt = useCallback((clientX: number): number | null => {
    const el = svgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return null;
    const ux = (clientX - r.left) * (W / r.width);
    if (ux < ML - 12 || ux > ML + plotW + 12) return null;
    const i = nDays === 1 ? 0 : Math.round(((ux - ML) / plotW) * (nDays - 1));
    return Math.max(0, Math.min(nDays - 1, i));
  }, [W, ML, plotW, nDays]);

  // Dismiss a pinned readout on any pointer-down outside the chart.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      if (svgRef.current?.contains(e.target as Node)) return;
      setPinned(false);
      setHoverDay(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [pinned]);

  // THE READOUT'S VALUES COME FROM THE SERIES THE CHART WAS GIVEN, not from anything re-derived.
  // The comparison is read UNTRUNCATED: the line stops at lastDay so a partial month cannot read
  // as a collapse, but "what did that day take last month" is still a real question on day 25.
  const readout = useMemo(() => {
    if (hoverDay == null) return null;
    const i = hoverDay;
    const cur = i < lastDay ? current[i] ?? null : null;
    const cmp = comp?.has ? comp.data[i] ?? null : null;
    return {
      i,
      dayLabel: `${MONTH_SHORT[m0]} ${i + 1}`,
      curLabel: anchor,
      cmpLabel: comp?.label ?? null,
      cur, cmp,
      // CURRENT MINUS COMPARISON, in that order. Only when both sides exist.
      diff: cur != null && cmp != null ? cur - cmp : null,
    };
  }, [hoverDay, current, lastDay, comp, m0, anchor]);

  const scope = field !== "All fields" ? field : city !== "All cities" ? city : "All Matchday";

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
        <div className={s.paceWrap}>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" data-testid="pace-chart"
          aria-label={`Daily revenue for ${anchor}, ${scope}`}
          // THE SERIES AS GIVEN, for assertions. The rendered path is rounded to 0.1 viewBox
          // units — about $5 at a $20k axis — so a test that recovers values from `d` can never
          // check them to the dollar. These are the exact arrays the readout reads.
          data-current={JSON.stringify(current.slice(0, Math.max(lastDay, 1)))}
          data-compare={JSON.stringify(comp?.has ? comp.data : [])}
          onPointerMove={(e) => { if (!pinned) setHoverDay(dayAt(e.clientX)); }}
          onPointerLeave={() => { if (!pinned) setHoverDay(null); }}
          onPointerDown={(e) => {
            // TAP TO PIN. A tap on another day moves it; a second tap on the same day releases it.
            const d = dayAt(e.clientX);
            if (d == null) return;
            if (pinned && d === hoverDay) { setPinned(false); setHoverDay(null); return; }
            setHoverDay(d);
            setPinned(true);
          }}>
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

          {readout && (
            <g data-testid="pace-crosshair" pointerEvents="none">
              <line x1={x(readout.i)} y1={MT} x2={x(readout.i)} y2={MT + plotH}
                stroke="#12352b" strokeOpacity={0.28} strokeWidth={1} strokeDasharray="3 3" />
              {readout.cmp != null && (
                <circle cx={x(readout.i)} cy={y(readout.cmp)} r={4.5} fill="#fff" stroke="#3f7fd6"
                  strokeWidth={2.5} data-testid="pace-dot-compare" />
              )}
              {readout.cur != null && (
                <circle cx={x(readout.i)} cy={y(readout.cur)} r={4.5} fill="#fff" stroke="#2fa36b"
                  strokeWidth={2.5} data-testid="pace-dot-current" />
              )}
            </g>
          )}

          {/* THE WHOLE PLOT IS THE TARGET. Last in the SVG so it takes the events, transparent so
              it changes nothing visually. Without it a pointer over empty plot space hits nothing
              and the readout only appears on the 2px line. */}
          <rect x={ML} y={MT} width={plotW} height={plotH} fill="transparent"
            data-testid="pace-hit" style={{ cursor: "crosshair" }} />
        </svg>

        {readout && (
          <div className={s.paceTip} data-testid="pace-readout"
            data-day={readout.i + 1}
            // FOLLOWS THE CURSOR, STAYS INSIDE THE CHART. Positioned as a percentage of the same
            // viewBox the crosshair uses, and flipped to the left of the crosshair once it would
            // otherwise run past the right edge.
            style={(() => {
              const px = (x(readout.i) / W) * 100;
              const flip = px > 62;
              return flip
                ? { right: `${100 - px}%`, marginRight: 10 }
                : { left: `${px}%`, marginLeft: 10 };
            })()}>
            <div className={s.paceTipDay}>{readout.dayLabel}</div>
            <div className={s.paceTipRow}>
              <span><i className={s.dot} style={{ background: "#2fa36b" }} />{readout.curLabel}</span>
              <b data-testid="pace-readout-current">{readout.cur == null ? "—" : fmtMoney(readout.cur)}</b>
            </div>
            {readout.cmpLabel && (
              <div className={s.paceTipRow}>
                <span><i className={s.dot} style={{ background: "#3f7fd6" }} />{readout.cmpLabel}</span>
                <b data-testid="pace-readout-compare">{readout.cmp == null ? "—" : fmtMoney(readout.cmp)}</b>
              </div>
            )}
            {/* NO DIFFERENCE ROW WHEN EITHER SIDE IS MISSING — a difference against nothing is not
                zero, and printing $0 there would read as parity. */}
            {readout.diff != null && (
              <div className={s.paceTipDiff} data-testid="pace-readout-diff"
                data-sign={readout.diff >= 0 ? "pos" : "neg"}>
                {readout.diff >= 0 ? "+" : "−"}{fmtMoney(Math.abs(readout.diff))}
              </div>
            )}
          </div>
        )}
        </div>
      )}

      <div className={s.legend}>
        <span><i className={s.dot} style={{ background: "#2fa36b" }} />{anchor}</span>
        {comp?.has
          ? <span><i className={s.dot} style={{ background: "#3f7fd6" }} />{comp.label}</span>
          : <span data-testid="pace-cmp-empty">
              No revenue on record for {comp?.label ?? "the comparison period"} — that comparison is unavailable, not zero.
            </span>}
      </div>
    </div>
  );
}
