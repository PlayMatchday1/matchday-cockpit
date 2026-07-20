"use client";

// OpEx Calendar — "blend v3" redesign. A cash-outflow calendar where
// every source sits on its real date: City Manager Pay and Match Manager
// Pay from fin_expenses, Field Costs dated per venue (per-match venues on
// their match days, flat/quarterly venues on their billing day), and every
// other operating category mirrored from fin_expenses (one group per
// category). Categories collapse to a single timing row (aggregated chips)
// and expand to per-line detail. Read-only — expenses are added/edited on
// the Expenses tab (+ Add expense deep-links there). Ported from
// docs/opex-blend.html (v3).
//
// Data wiring lives in src/lib/opexSources.ts (buildOpexCalendar). This
// component is presentation + collapse state + month nav only.

import { useMemo, useState } from "react";
import { daysInMonth } from "@/lib/checkIns";
import { useFinanceData } from "@/lib/useFinanceData";
import { formatMoney, monthLabel } from "@/lib/opex";
import { buildOpexCalendar, type CalGroup } from "@/lib/opexSources";

const WD = ["S", "M", "T", "W", "T", "F", "S"];

export default function OpExCalendarView({
  // Wired by the Finance page to switch to the Expenses tab, where
  // fin_expenses rows are added/edited (the single source this calendar
  // mirrors). Optional so the component still renders standalone.
  onAddExpense,
}: {
  onAddExpense?: () => void;
} = {}) {
  const { data, loading, error } = useFinanceData();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month0, setMonth0] = useState(now.getMonth());
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const days = daysInMonth(year, month0);
  const isThisMonth = year === now.getFullYear() && month0 === now.getMonth();
  const today = isThisMonth ? now.getDate() : -1;

  const cal = useMemo(
    () => buildOpexCalendar(data, year, month0),
    [data, year, month0],
  );

  // Collapse state: fall back to each group's default until the user
  // toggles it. Keyed by group.key so it persists across month nav.
  const isOpen = (g: CalGroup) => open[g.key] ?? g.defaultOpen;
  function toggle(key: string, def: boolean) {
    setOpen((s) => ({ ...s, [key]: !(s[key] ?? def) }));
  }
  const anyClosed = cal.groups.some((g) => !isOpen(g));
  function toggleAll() {
    const next: Record<string, boolean> = {};
    for (const g of cal.groups) next[g.key] = anyClosed; // expand if any closed
    setOpen(next);
  }

  // Bars: one per group present this month (mirrors Cash Flow's category
  // breakdown), biggest share first.
  const bars = useMemo(() => {
    const rows = cal.groups.map((g) => ({ name: g.name, amount: g.subtotal }));
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const max = Math.max(1, ...rows.map((r) => r.amount));
    return rows
      .sort((a, b) => b.amount - a.amount)
      .map((r) => ({
        ...r,
        pct: total > 0 ? (r.amount / total) * 100 : 0,
        width: r.amount ? Math.max(2, (r.amount / max) * 100) : 0,
      }));
  }, [cal.groups]);

  const topCat = bars.find((b) => b.amount > 0) ?? null;

  function shiftMonth(delta: number) {
    const d = new Date(year, month0 + delta, 1);
    setYear(d.getFullYear());
    setMonth0(d.getMonth());
  }

  const dayCols = Array.from({ length: days }, (_, i) => i + 1);
  const cellCls = (d: number) =>
    (d === today ? " today-c" : "") + (isWeekend(year, month0, d) ? " wknd-c" : "");

  return (
    <div className="opex-cal">
      <style>{OPEX_CSS}</style>

      {/* Toolbar */}
      <div className="ox-toolbar">
        <div>
          <h1 className="font-display">OpEx Calendar</h1>
          <div className="ox-sub">Operating cash outflow · {monthLabel(year, month0)}</div>
        </div>
        <div className="ox-controls">
          <div className="ox-seg">
            <button onClick={() => shiftMonth(-1)}>‹ Prev</button>
            <button
              className={isThisMonth ? "on" : ""}
              onClick={() => {
                setYear(now.getFullYear());
                setMonth0(now.getMonth());
              }}
            >
              Current
            </button>
            <button onClick={() => shiftMonth(1)}>Next ›</button>
          </div>
          <button className="ox-add" onClick={() => onAddExpense?.()}>
            + Add expense
          </button>
        </div>
      </div>

      {error && <div className="ox-err">Failed to load finance data: {error}</div>}

      {/* KPI tiles */}
      <div className="ox-kpis">
        <Kpi label={`Total ${MONTHS[month0]} outflow`} value={formatMoney(cal.monthTotal)} />
        <Kpi
          label="Top category"
          value={topCat ? topCat.name : "—"}
          small={topCat ? `${Math.round(topCat.pct)}%` : undefined}
        />
        <Kpi
          label="Biggest hit"
          value={cal.biggestHit ? `${MONTHS[month0]} ${cal.biggestHit.day}` : "—"}
          small={cal.biggestHit ? formatMoney(cal.biggestHit.amount) : undefined}
        />
        <Kpi
          label="Categories with spend"
          value={String(cal.categoriesWithSpend)}
          small={`of ${cal.groups.length}`}
        />
      </div>

      {/* Where the money goes */}
      <div className="ox-panel ox-bpanel">
        <div className="ox-ph">
          <span className="t">Where the money goes</span>
          <span className="s">{monthLabel(year, month0)} · share of outflow</span>
        </div>
        <div>
          {bars.map((b) => (
            <div key={b.name} className={`ox-bar ${b.amount ? "" : "zero"}`}>
              <div className="bl">
                <div className="nm">{b.name}</div>
              </div>
              <div className="track">
                {b.amount > 0 && <div className="fill" style={{ width: `${b.width}%` }} />}
              </div>
              <div className="amt">{b.amount ? formatMoney(b.amount) : "$0"}</div>
              <div className="pct">{b.amount ? `${Math.round(b.pct)}%` : "—"}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Calendar */}
      <div className="ox-panel">
        <div className="ox-caltitle">
          <span className="t">Calendar · when cash goes out</span>
          <span className="s">
            click a category to expand ·{" "}
            <button className="ox-expand" onClick={toggleAll}>
              {anyClosed ? "Expand all" : "Collapse all"}
            </button>
          </span>
        </div>
        <div className="ox-scroll">
          <table>
            <thead>
              <tr>
                <th className="corner">Category / line item</th>
                {dayCols.map((d) => {
                  const wd = new Date(year, month0, d).getDay();
                  const cls =
                    "dcell" +
                    (d === today ? " today-h" : wd === 0 || wd === 6 ? " wknd" : "");
                  return (
                    <th key={d} className={cls}>
                      <div className="dn">{d}</div>
                      <div className="dw">{WD[wd]}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {cal.groups.map((g) => {
                const opened = isOpen(g);
                return (
                  <GroupRows
                    key={g.key}
                    group={g}
                    opened={opened}
                    days={days}
                    dayCols={dayCols}
                    cellCls={cellCls}
                    onToggle={() => toggle(g.key, g.defaultOpen)}
                  />
                );
              })}

              {/* Daily total */}
              <tr className="ox-dtot">
                <td className="lab">Daily total</td>
                {dayCols.map((d) => (
                  <td key={d} className={cellCls(d)}>
                    {cal.dayTotal[d] ? (
                      <span className="n">{formatMoney(cal.dayTotal[d])}</span>
                    ) : (
                      <span className="n dash">—</span>
                    )}
                  </td>
                ))}
              </tr>

              {/* Cumulative sparkline */}
              <tr className="ox-cum">
                <td className="lab">Cumulative</td>
                <td className="spark" colSpan={days}>
                  <Sparkline cumulative={cal.cumulative} days={days} />
                  <span className="cend">{formatMoney(cal.monthTotal)} by month end</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="ox-recon">
          Everything sits on its real pay / billing date ·{" "}
          <b>{monthLabel(year, month0)} total {formatMoney(cal.monthTotal)}</b>.
          {cal.undatedFieldCosts > 0 && (
            <>
              {" "}
              {formatMoney(cal.datedTotal)} dated +{" "}
              <b>{formatMoney(cal.undatedFieldCosts)}</b> field costs awaiting a
              billing date (set cadence/day in Field Costs).
            </>
          )}
          {loading && <> · loading finance data…</>}
        </div>
      </div>
    </div>
  );
}

// ---------------- subcomponents ----------------

function Kpi({ label, value, small }: { label: string; value: string; small?: string }) {
  return (
    <div className="ox-kpi">
      <div className="lab">{label}</div>
      <div className="val font-display">
        {value}
        {small && <small>{small}</small>}
      </div>
    </div>
  );
}

function GroupRows({
  group,
  opened,
  days,
  dayCols,
  cellCls,
  onToggle,
}: {
  group: CalGroup;
  opened: boolean;
  days: number;
  dayCols: number[];
  cellCls: (d: number) => string;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className={`ox-cat ${opened ? "open" : ""}`} onClick={onToggle}>
        <td className="lab">
          <div className="catname">
            <span className="nm">
              <span className="chev" />
              {group.name}
              {group.tag && <span className="tag">{group.tag}</span>}
            </span>
            <span className="st">{formatMoney(group.subtotal)}</span>
          </div>
          <div className="src">{group.src}</div>
        </td>
        {dayCols.map((d) => (
          <td key={d} className={cellCls(d)}>
            {group.agg[d] ? <span className="achip">{formatMoney(group.agg[d])}</span> : ""}
          </td>
        ))}
      </tr>

      {opened &&
        group.rows.map((r) => (
          <tr key={r.key} className="ox-child">
            <td className="lab">
              <span className="nm">{r.label}</span>
              {r.sublabel && <span className="city">{r.sublabel}</span>}
              {r.tag && <span className={`vtag ${r.quarterly ? "q" : ""}`}>{r.tag}</span>}
            </td>
            {dayCols.map((d) => (
              <td key={d} className={cellCls(d)}>
                {r.cells[d] ? (
                  <span className={`chip ${r.quarterly ? "q" : ""}`}>
                    {formatMoney(r.cells[d])}
                  </span>
                ) : (
                  ""
                )}
              </td>
            ))}
          </tr>
        ))}

      {/* Undated field-cost remainder (in subtotal, on no day) */}
      {opened && group.undated > 0 && (
        <tr className="ox-child">
          <td className="lab">
            <span className="nm undated">Undated — timing not set</span>
          </td>
          <td className="espan" colSpan={days}>
            {formatMoney(group.undated)} awaiting a billing date
          </td>
        </tr>
      )}
    </>
  );
}

// Filled step sparkline across the day columns. viewBox width matches the
// day-column count so it stretches edge to edge; non-scaling stroke keeps
// the line crisp under the horizontal scale.
function Sparkline({ cumulative, days }: { cumulative: number[]; days: number }) {
  const W = days * 46;
  const yB = 42;
  const yT = 10;
  const run = cumulative[days] || 0;
  const maxCum = run || 1;
  const X = (d: number) => (d - 0.5) * 46;
  const Y = (d: number) => yB - (cumulative[d] / maxCum) * (yB - yT);
  let pts = "";
  for (let d = 1; d <= days; d++) pts += `${d > 1 ? " L " : ""}${X(d).toFixed(1)},${Y(d).toFixed(1)}`;
  const area = `M ${X(1).toFixed(1)},${yB} L ${pts} L ${X(days).toFixed(1)},${yB} Z`;
  return (
    <svg className="sv" viewBox={`0 0 ${W} 54`} preserveAspectRatio="none">
      <path d={area} fill="#e2f1e8" />
      <path
        d={`M ${pts}`}
        fill="none"
        stroke="#2fbf6c"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------- helpers ----------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function isWeekend(year: number, month0: number, d: number): boolean {
  const g = new Date(year, month0, d).getDay();
  return g === 0 || g === 6;
}

// Scoped styles ported from docs/opex-blend.html (v3). Every selector is
// namespaced under .opex-cal so nothing leaks into the rest of the app.
const OPEX_CSS = `
.opex-cal{--card:#fff;--ink:#17241d;--green-deep:#123d2c;--green-bright:#2fbf6c;--green-mid:#3aa86a;
  --green-tint:#e6f4ec;--green-tint-2:#d5eddd;--today:#d7f0e0;--today-head:#33c46f;--muted:#8b8f85;
  --muted-2:#a7a99d;--amber-bg:#fbeede;--amber-line:#e9a86a;--line:#e9e1d1;--line-soft:#f0e9db;--cream-2:#efe7d6;
  color:var(--ink)}
.opex-cal h1{font-size:38px;letter-spacing:.5px;color:var(--green-deep);line-height:.95;text-transform:uppercase}
.opex-cal .ox-sub{color:var(--muted);font-size:14px;margin-top:6px;font-weight:500}
.opex-cal .ox-toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:16px;flex-wrap:wrap}
.opex-cal .ox-controls{display:flex;align-items:center;gap:8px}
.opex-cal .ox-seg{display:flex;background:var(--card);border:1px solid var(--line);border-radius:11px;overflow:hidden}
.opex-cal .ox-seg button{border:0;background:transparent;padding:9px 15px;font-weight:600;font-size:13px;color:var(--green-deep);cursor:pointer}
.opex-cal .ox-seg button+button{border-left:1px solid var(--line)}
.opex-cal .ox-seg button.on{background:var(--green-tint)}
.opex-cal .ox-add{border:0;background:var(--green-bright);color:#06301d;font-weight:700;font-size:13px;padding:11px 17px;border-radius:11px;cursor:pointer}
.opex-cal .ox-err{background:#fdecec;border:1px solid #e9a6a6;border-radius:11px;padding:10px 14px;margin-bottom:16px;font-size:12.5px;color:#9a3838}
.opex-cal .ox-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}
.opex-cal .ox-kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.opex-cal .ox-kpi .lab{font-size:11px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--muted)}
.opex-cal .ox-kpi .val{font-size:25px;color:var(--green-deep);margin-top:6px;letter-spacing:.3px;line-height:1.05;text-transform:uppercase}
.opex-cal .ox-kpi .val small{font-size:13px;font-weight:600;color:var(--muted-2);margin-left:5px}
.opex-cal .ox-panel{background:var(--card);border:1px solid var(--line);border-radius:16px}
.opex-cal .ox-bpanel{padding:16px 20px;margin-bottom:16px}
.opex-cal .ox-ph{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px}
.opex-cal .ox-ph .t{font-weight:800;font-size:12.5px;letter-spacing:.7px;text-transform:uppercase;color:var(--green-deep)}
.opex-cal .ox-ph .s{font-size:12px;color:var(--muted);font-weight:600}
.opex-cal .ox-bar{display:grid;grid-template-columns:168px 1fr 88px 44px;align-items:center;gap:12px;padding:7px 0}
.opex-cal .ox-bar+.ox-bar{border-top:1px solid var(--line-soft)}
.opex-cal .ox-bar .bl .nm{font-weight:700;font-size:12.5px;color:var(--ink)}
.opex-cal .ox-bar .track{height:18px;background:#f1ead9;border-radius:5px;overflow:hidden}
.opex-cal .ox-bar .fill{height:100%;background:linear-gradient(90deg,var(--green-mid),var(--green-bright));border-radius:5px;min-width:2px}
.opex-cal .ox-bar .amt{text-align:right;font-weight:800;font-size:13px;color:var(--green-deep);font-variant-numeric:tabular-nums}
.opex-cal .ox-bar .pct{text-align:right;font-size:11.5px;color:var(--muted);font-weight:600;font-variant-numeric:tabular-nums}
.opex-cal .ox-bar.zero .nm,.opex-cal .ox-bar.zero .amt{color:var(--muted-2)}
.opex-cal .ox-bar.zero .track{background:#f6f1e6}
.opex-cal .ox-caltitle{display:flex;align-items:baseline;justify-content:space-between;padding:16px 20px 12px;gap:12px;flex-wrap:wrap}
.opex-cal .ox-caltitle .t{font-weight:800;font-size:12.5px;letter-spacing:.7px;text-transform:uppercase;color:var(--green-deep)}
.opex-cal .ox-caltitle .s{font-size:12px;color:var(--muted);font-weight:600}
.opex-cal .ox-expand{border:1px solid var(--line);background:#fff;border-radius:8px;padding:5px 11px;font-weight:600;font-size:11px;color:var(--green-deep);cursor:pointer}
.opex-cal .ox-scroll{overflow-x:auto;border-top:1px solid var(--line)}
.opex-cal table{border-collapse:separate;border-spacing:0;width:100%;min-width:max-content}
.opex-cal th,.opex-cal td{white-space:nowrap}
.opex-cal thead th{position:sticky;top:0;z-index:3;background:var(--green-deep);color:#eaf5ee;font-weight:700;font-size:12px;height:50px}
.opex-cal thead th.corner{left:0;z-index:5;text-align:left;padding:0 18px;letter-spacing:.7px;text-transform:uppercase;color:#bfe0cd;font-size:11px;min-width:250px;width:250px}
.opex-cal .dcell{width:46px;min-width:46px;text-align:center;position:relative}
.opex-cal .dcell .dn{font-weight:700;font-size:14px}
.opex-cal .dcell .dw{font-size:9.5px;font-weight:600;color:#8fc2a4;margin-top:1px}
.opex-cal thead th.today-h{background:var(--today-head);color:#06301d}
.opex-cal thead th.today-h .dw{color:#0b4a2c}
.opex-cal thead th.today-h::after{content:'TODAY';position:absolute;font-size:7px;font-weight:800;letter-spacing:.5px;left:50%;transform:translate(-50%,14px)}
.opex-cal thead th.wknd{background:#173f2e}
.opex-cal tbody td{border-bottom:1px solid var(--line-soft);height:40px;text-align:center;font-size:12px}
.opex-cal tbody td.lab{position:sticky;left:0;z-index:2;background:var(--card);text-align:left;padding:0 18px;min-width:250px;width:250px;border-right:1px solid var(--line)}
.opex-cal td.today-c{background:var(--today)}
.opex-cal td.wknd-c{background:#faf7ef}
.opex-cal td.today-c.wknd-c{background:var(--today)}
.opex-cal tr.ox-cat{cursor:pointer}
.opex-cal tr.ox-cat td{background:var(--green-tint);border-bottom:1px solid var(--green-tint-2);height:44px}
.opex-cal tr.ox-cat td.lab{background:var(--green-tint)}
.opex-cal tr.ox-cat td.today-c{background:var(--green-tint-2)}
.opex-cal tr.ox-cat:hover td{background:#def0e5}
.opex-cal tr.ox-cat:hover td.lab{background:#def0e5}
.opex-cal .chev{display:inline-block;width:0;height:0;border-left:6px solid var(--green-deep);border-top:5px solid transparent;border-bottom:5px solid transparent;margin-right:9px;transition:transform .15s;vertical-align:middle}
.opex-cal tr.ox-cat.open .chev{transform:rotate(90deg)}
.opex-cal .catname{display:flex;align-items:center;justify-content:space-between;gap:10px}
.opex-cal .catname .nm{font-weight:800;font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:var(--green-deep)}
.opex-cal .catname .st{font-weight:800;font-size:12.5px;color:var(--green-deep);font-variant-numeric:tabular-nums}
.opex-cal .src{font-size:10px;color:#6f9a82;font-weight:600;margin-top:2px;padding-left:15px}
.opex-cal .tag{display:inline-block;font-size:8.5px;font-weight:800;letter-spacing:.4px;padding:1px 6px;border-radius:5px;background:#eaf3ec;color:#4b7a5f;text-transform:uppercase;margin-left:7px;vertical-align:middle}
.opex-cal .achip{display:inline-block;padding:3px 8px;border-radius:7px;background:#dff0e6;color:var(--green-deep);font-weight:700;font-size:11px;font-variant-numeric:tabular-nums;border:1px solid var(--green-tint-2)}
.opex-cal tr.ox-child .lab{padding-left:34px}
.opex-cal tr.ox-child.editable{cursor:pointer}
.opex-cal tr.ox-child.editable:hover td.lab{background:#f4fbf6}
.opex-cal tr.ox-child .nm{font-weight:600;font-size:13px}
.opex-cal tr.ox-child .nm.undated{color:var(--muted);font-style:italic;font-weight:600}
.opex-cal tr.ox-child .city{font-size:11px;color:var(--muted);font-weight:500;margin-left:6px}
.opex-cal .vtag{display:inline-block;font-size:8px;font-weight:800;letter-spacing:.3px;padding:1px 5px;border-radius:4px;background:#eef1e9;color:#5c7a63;text-transform:uppercase;margin-left:7px;vertical-align:middle}
.opex-cal .vtag.q{background:#fbeede;color:#b5701f}
.opex-cal .chip{display:inline-block;padding:3px 9px;border-radius:7px;background:var(--green-tint);color:var(--green-deep);font-weight:700;font-size:11.5px;font-variant-numeric:tabular-nums;border:1px solid var(--green-tint-2)}
.opex-cal .chip.q{background:#fbeede;color:#a15a1f;border-color:var(--amber-line)}
.opex-cal tr.ox-empty td{height:40px;background:#fbfaf5;border-bottom:1px solid var(--line-soft)}
.opex-cal tr.ox-empty td.lab{background:#fbfaf5}
.opex-cal .enm{font-weight:700;font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:var(--muted)}
.opex-cal td.espan{text-align:left !important;padding-left:18px;color:var(--muted-2);font-size:12.5px;font-weight:600}
.opex-cal .ehint{color:#bcb6a7;font-weight:500;font-size:11px}
.opex-cal tr.ox-dtot td{height:44px;background:var(--cream-2);border-top:2px solid var(--green-deep);border-bottom:1px solid var(--line)}
.opex-cal tr.ox-dtot td.lab{background:var(--cream-2);font-weight:800;font-size:11.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--green-deep)}
.opex-cal tr.ox-dtot td .n{font-weight:800;font-size:11.5px;color:var(--green-deep);font-variant-numeric:tabular-nums}
.opex-cal tr.ox-dtot td .n.dash{color:#c3bca9}
.opex-cal tr.ox-dtot td.today-c{background:#e6ddc9}
.opex-cal tr.ox-cum td{background:#fbf9f3}
.opex-cal tr.ox-cum td.lab{background:#fbf9f3;font-weight:700;font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)}
.opex-cal tr.ox-cum td.spark{position:relative;height:54px;padding:0}
.opex-cal tr.ox-cum td.spark .sv{display:block;width:100%;height:54px}
.opex-cal tr.ox-cum td.spark .cend{position:absolute;top:8px;right:14px;font-size:11px;font-weight:800;color:var(--green-deep);font-variant-numeric:tabular-nums;background:rgba(251,249,243,.9);padding:2px 7px;border-radius:6px;border:1px solid var(--line)}
.opex-cal .ox-recon{padding:14px 20px;background:#fbf9f3;border-top:1px solid var(--line);font-size:12.5px;color:#5c6b60;line-height:1.5}
.opex-cal .ox-recon b{color:var(--green-deep);font-variant-numeric:tabular-nums}
`;
