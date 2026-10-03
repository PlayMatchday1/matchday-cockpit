"use client";

// OpEx — the cash-out month, as a calendar and a ledger. Layout, wording and data-testids are
// scripts/mocks/opex-calendar-v3.html (its amounts are illustrative); scripts/mocks/
// opex-calendar-v3.assert.mjs is the check, run against the mock and against this page.
//
// NUMBERS: buildOpexCalendarAsOf (src/lib/opexSources.ts) — bank payments for days up to today,
// venue / Manager Pay / Expenses settings after it — flattened by lib/opexLedger into one row per
// payment in six categories. Every figure on the page is a sum over that one list, so the header,
// the chips, the day cells, the week totals and the ledger cannot disagree.
//
// WHAT IS GONE (Ryan, 2026-10-02): the category-by-day grid, the Next 7 days tiles, the category
// bars, and the inline amount/date editor — Expenses is the place to edit, and the ledger links to
// it. The month comes from the Finance shell's period control; there are no arrows here.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { daysInMonth } from "@/lib/checkIns";
import { useFinanceData } from "@/lib/useFinanceData";
import { monthLabel } from "@/lib/opex";
import { buildOpexCalendarAsOf } from "@/lib/opexSources";
import { CATS, CAT_BY_KEY, cityLabel, paymentsOf, subLabel, sumOf, type CatKey, type Payment } from "@/lib/opexLedger";
import { useFinancePeriod } from "@/lib/financePeriodContext";

const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FIELD_COSTS_HREF = "/admin/finance/ledger/field-costs";
const EXPENSES_HREF = "/admin/finance/ledger/expenses";

// "$1,440" for whole dollars, "$698.20" when there are cents — cents never drop off.
function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(r) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

type Pop = { id: string; x: number; y: number; kind: "how" } | { id: string; x: number; y: number; kind: "pill"; day: number; cat: CatKey } | null;

export default function OpExCalendarView() {
  const { data, error } = useFinanceData();
  const { period, now } = useFinancePeriod();
  const year = period.start.getFullYear();
  const month0 = period.start.getMonth();
  const days = daysInMonth(year, month0);
  const mon = MON3[month0];

  const [solo, setSolo] = useState<CatKey | null>(null);      // one category shown, or all
  const [dayFilter, setDayFilter] = useState<number | null>(null);
  const [view, setView] = useState<"cal" | "ledger">("cal");
  const [pop, setPop] = useState<Pop>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // A new month clears the day filter: Oct 15 means nothing in November.
  useEffect(() => { setDayFilter(null); setPop(null); }, [year, month0]);

  const cal = useMemo(() => buildOpexCalendarAsOf(data, year, month0, now), [data, year, month0, now]);
  const all = useMemo(() => paymentsOf(cal), [cal]);
  const shown = useMemo(() => all.filter((p) => solo == null || p.cat === solo), [all, solo]);

  // The header is the WHOLE month whatever is filtered (Ryan: "The header month total never changes").
  const monthTotal = sumOf(all);
  const paid = sumOf(all.filter((p) => p.paid));
  const left = Math.round((monthTotal - paid) * 100) / 100;
  const paidPct = monthTotal > 0 ? (paid / monthTotal) * 100 : 0;
  const noDay = all.filter((p) => p.day == null);

  const today = cal.state === "current" ? now.getDate() : -1;
  const isPast = (d: number) => (cal.state === "past" ? true : cal.state === "current" ? d < today : false);

  // ── the calendar's cells, Monday first, as the Master Schedule lays them out ──────────────────
  const lead = (new Date(year, month0, 1).getDay() + 6) % 7;
  type Cell = { d: number | null; n: number };
  const cells: Cell[] = [];
  const prevDays = daysInMonth(month0 === 0 ? year - 1 : year, (month0 + 11) % 12);
  for (let i = 0; i < lead; i++) cells.push({ d: null, n: prevDays - lead + 1 + i });
  for (let d = 1; d <= days; d++) cells.push({ d, n: d });
  for (let n = 1; cells.length % 7; n++) cells.push({ d: null, n });
  const weeks: Cell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const byDay = useMemo(() => {
    const m = new Map<number, Payment[]>();
    for (const p of shown) if (p.day != null) m.set(p.day, [...(m.get(p.day) ?? []), p]);
    return m;
  }, [shown]);
  const pillsOf = (d: number) => {
    const g = new Map<CatKey, Payment[]>();
    for (const p of byDay.get(d) ?? []) g.set(p.cat, [...(g.get(p.cat) ?? []), p]);
    return [...g.entries()].map(([cat, ps]) => ({ cat, ps, total: sumOf(ps) })).sort((a, b) => b.total - a.total);
  };

  // ── the ledger ────────────────────────────────────────────────────────────────────────────────
  const weekOf = (d: number) => Math.floor((d - 1 + lead) / 7);
  const ledgerRows = dayFilter == null ? shown : shown.filter((p) => p.day === dayFilter);
  const ledgerTotal = sumOf(ledgerRows);

  // ── popovers: the i, and a pill's payees ──────────────────────────────────────────────────────
  const place = (id: string, el: HTMLElement) => {
    const rc = el.getBoundingClientRect();
    return { id, x: Math.max(8, Math.min(window.innerWidth - 316, rc.left)), y: rc.bottom + 8 };
  };
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (popRef.current?.contains(t) || t.closest?.(".pay") || t.closest?.(".i")) return;
      setPop(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPop(null); };
    const onScroll = () => setPop(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [pop]);

  const chipTotal = (k: CatKey) => sumOf(all.filter((p) => p.cat === k));
  const clickChip = (k: CatKey) => { setPop(null); setSolo((s) => (s === k ? null : k)); };

  const popPayments = pop?.kind === "pill" ? all.filter((p) => p.day === pop.day && p.cat === pop.cat).sort((a, b) => b.amount - a.amount) : [];

  let run = 0;
  const ledgerBody: React.ReactNode[] = [];
  const pushRow = (p: Payment) => {
    run += p.amount;
    const sub = subLabel(p);
    ledgerBody.push(
      <tr key={p.key} data-testid="ledger-row" data-day={p.day ?? ""} data-cat={p.cat} className={dayFilter != null && p.day === dayFilter ? "hl" : undefined}>
        <td>{p.day == null ? "—" : `${mon} ${p.day}`}</td>
        <td><b>{p.payee}</b></td>
        <td className="cat"><span className="sw" style={{ background: CAT_BY_KEY[p.cat].col }} />{CAT_BY_KEY[p.cat].name}{sub ? ` · ${sub}` : ""}</td>
        <td className="city">{p.city || "—"}</td>
        <td><span className={`st ${p.paid ? "paid" : "proj"}`}>{p.paid ? "Paid" : "Projected"}</span></td>
        <td className="r"><b>{fmt(p.amount)}</b></td>
        <td className="r cum">{fmt(Math.round(run * 100) / 100)}</td>
      </tr>,
    );
  };
  if (dayFilter == null) {
    let wk = -1;
    for (const p of ledgerRows.filter((x) => x.day != null)) {
      const w = weekOf(p.day as number);
      if (w !== wk) {
        wk = w;
        const a = Math.max(1, w * 7 - lead + 1), b = Math.min(days, w * 7 - lead + 7);
        const wt = sumOf(ledgerRows.filter((x) => x.day != null && weekOf(x.day) === w));
        ledgerBody.push(
          <tr key={`wk${w}`} className="wh" data-testid="ledger-week"><td colSpan={5}>{mon} {a} – {b}</td><td className="r">{fmt(wt)}</td><td /></tr>,
        );
      }
      pushRow(p);
    }
    const undated = ledgerRows.filter((x) => x.day == null);
    if (undated.length) {
      ledgerBody.push(
        <tr key="noday" className="wh" data-testid="ledger-noday"><td colSpan={5}>No day set</td><td className="r">{fmt(sumOf(undated))}</td><td /></tr>,
      );
      for (const p of undated) pushRow(p);
    }
  } else {
    for (const p of ledgerRows) pushRow(p);
    if (!ledgerRows.length) ledgerBody.push(<tr key="none"><td colSpan={7} className="none">Nothing hits on {mon} {dayFilter}.</td></tr>);
  }

  return (
    <div className="opex-v3">
      <style>{CSS}</style>

      <div className="top">
        <h1 className="font-display">OpEx</h1>
        <span className="month" data-testid="month">{monthLabel(year, month0)}</span>
        <span className="sp" />
        <div className="seg" data-testid="view-seg">
          <button type="button" aria-pressed={view === "cal"} onClick={() => setView("cal")}>Calendar</button>
          <button type="button" aria-pressed={view === "ledger"} onClick={() => setView("ledger")}>Ledger only</button>
        </div>
      </div>

      {error && <div className="ox-err">Failed to load finance data: {error}</div>}

      <section className="card hdr" data-testid="summary">
        <div className="l">
          <div className="k">Cash out · {monthLabel(year, month0)}</div>
          <div className="big" data-testid="sum-month">{fmt(monthTotal)}</div>
          <div className="bar" data-testid="paid-bar"><i style={{ width: `${paidPct.toFixed(1)}%` }} /></div>
          <div className="pl"><span><b data-testid="sum-paid">{fmt(paid)}</b> paid</span><span><b data-testid="sum-left">{fmt(left)}</b> still to go</span></div>
        </div>
        <div className="r">
          <div className="chips" id="chips">
            {CATS.map((c) => {
              const t = chipTotal(c.key);
              return (
                <button key={c.key} type="button" className="chip" data-cat={c.key} data-testid={`chip-${c.key}`}
                  aria-pressed={solo == null || solo === c.key} onClick={() => clickChip(c.key)}>
                  <span className="sw" style={{ background: c.col }} />{c.name} <b>{fmt(t)}</b>
                  <small>{monthTotal > 0 ? Math.round((t / monthTotal) * 100) : 0}%</small>
                </button>
              );
            })}
          </div>
          <div className="hint">
            Click a category to see only that one, everywhere on the page. Click it again for{" "}
            <a id="all" role="button" tabIndex={0} onClick={() => { setPop(null); setSolo(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") setSolo(null); }}>all categories</a>{" · "}
            <button type="button" className="i" data-pop="how" aria-label="How this page works" aria-expanded={pop?.kind === "how"}
              onClick={(e) => (pop?.kind === "how" ? setPop(null) : setPop({ ...place("how", e.currentTarget), kind: "how" }))}>i</button>
          </div>
          {/* DON'T HIDE THE PROBLEM (Ryan, 2026-10-02). Money in the month with no day is in every
              total and on no calendar day, so the cells cannot add to the header without this. */}
          {noDay.length > 0 && (
            <div className="noday" data-testid="noday-line">
              {noDay.length} payment{noDay.length === 1 ? "" : "s"} without a day · {fmt(sumOf(noDay))} ·{" "}
              <Link href={FIELD_COSTS_HREF}>set a billing day on Field Costs</Link>
            </div>
          )}
        </div>
      </section>

      {!data && <div className="card ox-loading">{error ? "Finance data did not load." : "Loading finance data…"}</div>}

      {data && view === "cal" && (
        <section className="card cal" data-testid="calendar">
          {/* ON A PHONE THE MONTH SCROLLS INSIDE ITS CARD; the page itself never scrolls sideways. */}
          <div className="calx"><div className="calin">
          <div className="wk h"><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div></div>
          {weeks.map((row, w) => {
            const wt = sumOf(row.flatMap((c) => (c.d == null ? [] : byDay.get(c.d) ?? [])));
            return (
              <div key={w} className="wk" data-testid="week">
                {row.map((c, i) => {
                  const wkend = i >= 5 ? " wkend" : "";
                  if (c.d == null) {
                    return <div key={`o${w}-${i}`} className={`day out${wkend}`}><div className="dh"><span className="n">{c.n}</span></div></div>;
                  }
                  const d = c.d;
                  const pills = pillsOf(d);
                  const t = sumOf(pills.flatMap((x) => x.ps));
                  const cls = `day${wkend}${d === today ? " today" : ""}${isPast(d) ? " past" : ""}${dayFilter === d ? " sel" : ""}`;
                  return (
                    <div key={d} className={cls} data-testid={`day-${d}`} data-day={d}
                      onClick={(e) => { if ((e.target as HTMLElement).closest(".pay")) return; setPop(null); setDayFilter((f) => (f === d ? null : d)); }}>
                      <div className="dh"><span className="n">{d}</span><span className={`dt${t ? "" : " none"}`} data-total={t}>{t ? fmt(t) : "—"}</span></div>
                      {pills.map((x) => {
                        const id = `pill:${d}:${x.cat}`;
                        return (
                          <button key={x.cat} type="button" className={`pay ${d <= cal.paidThrough ? "paid" : "proj"}`} data-day={d} data-cat={x.cat}
                            aria-expanded={pop?.id === id}
                            title={`${CAT_BY_KEY[x.cat].name} · ${x.ps.length} payment${x.ps.length > 1 ? "s" : ""}`}
                            onClick={(e) => { e.stopPropagation(); if (pop?.id === id) return setPop(null); setPop({ ...place(id, e.currentTarget), kind: "pill", day: d, cat: x.cat }); }}>
                            <span className="sw" style={{ background: CAT_BY_KEY[x.cat].col }} />
                            <span className="nm">{CAT_BY_KEY[x.cat].short}{x.ps.length > 1 && <small> {x.ps.length}</small>}</span>
                            <span className="v">{fmt(x.total)}</span>
                          </button>
                        );
                      })}
                      {i === 6 && wt > 0 && <span className="wkt">week {fmt(wt)}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
          </div></div>
        </section>
      )}

      {data && (
        /* data-payments: how many payments the data layer produced for the month (paymentsOf), so
           scripts/mocks/opex-calendar-v3.assert.mjs can check the ledger renders every one. */
        <section className="card led" data-testid="ledger" data-payments={all.length}>
          <div className="hd">
            <h2>Ledger · what hits when</h2>
            {dayFilter != null && (
              <span className="fchip" data-testid="ledger-filter">Showing {mon} {dayFilter}{" "}
                <button id="lclear" type="button" aria-label="Show the whole month" onClick={() => setDayFilter(null)}>×</button>
              </span>
            )}
            <span className="hint">{dayFilter == null ? (view === "cal" ? "Click a day above to see only that day." : "") : "Click the day again or × for the whole month."}</span>
            <span className="sp" />
            <Link className="ox-add" href={EXPENSES_HREF}>+ Add expense</Link>
          </div>
          <div className="tw">
            <table data-testid="ledger-table">
              <thead><tr><th>Date</th><th>Payee</th><th>Category</th><th>City</th><th>Status</th><th className="r">Amount</th><th className="r">Running total</th></tr></thead>
              <tbody>
                {ledgerBody}
                <tr className="tot" data-testid="ledger-total">
                  <td colSpan={5}>{dayFilter == null ? monthLabel(year, month0).split(" ")[0] : `${mon} ${dayFilter}`}{solo ? " · shown categories" : ""}</td>
                  <td className="r" data-total={ledgerTotal}>{fmt(ledgerTotal)}</td><td />
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div ref={popRef} className="pop" data-testid="popover" hidden={!pop} style={pop ? { left: pop.x, top: pop.y } : undefined}>
        {pop?.kind === "how" && (
          <>
            <div className="h">How this page works</div>
            Every payment MatchDay makes in the month, on the day the money leaves. Solid is paid: bank
            payments and booked expenses. Dashed is projected from the venue, pay and expense settings.
            <dl>
              {CATS.map((c) => (
                <span key={c.key} style={{ display: "contents" }}>
                  <dt><span className="swi" style={{ background: c.col }} />{c.name}</dt><dd>{c.how}</dd>
                </span>
              ))}
            </dl>
          </>
        )}
        {pop?.kind === "pill" && (
          <>
            <div className="h">{mon} {pop.day} · {CAT_BY_KEY[pop.cat].name} · {fmt(sumOf(popPayments))}</div>
            <div className="sub">{pop.day <= cal.paidThrough ? "Paid (bank)" : "Projected from settings"}</div>
            <dl className="pp">
              {popPayments.map((p) => {
                const city = cityLabel(p), sub = subLabel(p);
                return (
                  <span key={p.key} style={{ display: "contents" }}>
                    <dt>{p.payee}{city && <span className="m"> · {city}</span>}{sub && <span className="m"> · {sub}</span>}</dt>
                    <dd>{fmt(p.amount)}</dd>
                  </span>
                );
              })}
            </dl>
          </>
        )}
      </div>
    </div>
  );
}

// Scoped port of scripts/mocks/opex-calendar-v3.html. Every selector sits under .opex-v3.
const CSS = `
.opex-v3{--line:#e3e7e1;--line-2:#eef1ec;--ink:#10231a;--ink-2:#44564c;--muted:#7a8a81;--nav:#0b3a28;color:var(--ink);display:grid;gap:14px}
.opex-v3 .top{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.opex-v3 h1{margin:0;font-size:28px;font-weight:800}
.opex-v3 .month{font-weight:800;font-size:18px}
.opex-v3 .sp{flex:1}
.opex-v3 .seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;background:#fff;padding:2px}
.opex-v3 .seg button{border:0;background:transparent;padding:6px 14px;border-radius:999px;font:inherit;font-weight:700;color:var(--muted);cursor:pointer}
.opex-v3 .seg button[aria-pressed="true"]{background:var(--nav);color:#fff}
.opex-v3 .ox-err{background:#fdecec;border:1px solid #e9a6a6;border-radius:11px;padding:10px 14px;font-size:12.5px;color:#9a3838}
.opex-v3 .ox-loading{padding:40px;text-align:center;color:var(--muted)}
.opex-v3 .ox-add{border:0;background:#22c55e;color:#06301d;font-weight:700;font-size:13px;padding:7px 13px;border-radius:10px}
.opex-v3 .card{background:#fff;border:1px solid var(--line);border-radius:14px}
.opex-v3 .hdr{display:grid;grid-template-columns:300px 1fr}
@media (max-width:900px){.opex-v3 .hdr{grid-template-columns:1fr}.opex-v3 .hdr .l{border-right:0;border-bottom:1px solid var(--line)}}
.opex-v3 .hdr .l{padding:18px 22px;border-right:1px solid var(--line)}
.opex-v3 .k{font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:var(--muted);font-weight:700}
.opex-v3 .big{font-size:38px;font-weight:800;letter-spacing:-.5px;margin:2px 0 8px;font-variant-numeric:tabular-nums}
.opex-v3 .bar{height:8px;border-radius:999px;background:#e6ebe7;overflow:hidden}.opex-v3 .bar i{display:block;height:100%;background:#22c55e}
.opex-v3 .pl{display:flex;justify-content:space-between;font-size:12.5px;color:var(--ink-2);margin-top:6px}.opex-v3 .pl b{color:var(--ink)}
.opex-v3 .hdr .r{padding:16px 22px;display:flex;flex-direction:column;gap:10px;min-width:0}
.opex-v3 .chips{display:flex;gap:8px;flex-wrap:wrap}
.opex-v3 .chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 14px 7px 10px;font:inherit;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px;color:var(--ink)}
.opex-v3 .chip .sw{width:10px;height:10px;border-radius:3px;display:inline-block}
.opex-v3 .chip b{font-variant-numeric:tabular-nums}.opex-v3 .chip small{color:var(--muted);font-weight:600}
.opex-v3 .chip[aria-pressed="false"]{color:#b7c0ba;background:#f7f9f6}.opex-v3 .chip[aria-pressed="false"] .sw{opacity:.3}
.opex-v3 .chip[aria-pressed="false"] b,.opex-v3 .chip[aria-pressed="false"] small{color:#b7c0ba}
.opex-v3 .hint{font-size:12.5px;color:var(--muted)}
.opex-v3 .hint a{color:var(--ink-2);cursor:pointer;text-decoration:underline}
.opex-v3 .noday{font-size:12.5px;color:#7a4b00;background:#fff7e0;border:1px solid #f0dca8;border-radius:8px;padding:6px 10px;align-self:flex-start}
.opex-v3 .noday a{color:#7a4b00;text-decoration:underline;font-weight:700}
.opex-v3>*{min-width:0}
.opex-v3 .cal{overflow:hidden}
.opex-v3 .calx{overflow-x:auto}.opex-v3 .calin{min-width:840px}
.opex-v3 .wk{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}
.opex-v3 .wk.h div{padding:10px 12px;font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:var(--muted);font-weight:700;border-bottom:1px solid var(--line)}
.opex-v3 .wk.h div:nth-child(n+6){background:#f7f9f6}
.opex-v3 .day{min-height:118px;border-right:1px solid var(--line-2);border-bottom:1px solid var(--line-2);padding:8px 8px 22px;position:relative;display:flex;flex-direction:column;gap:4px;background:#fff;min-width:0}
.opex-v3 .day:nth-child(7n){border-right:0}
.opex-v3 .day.wkend{background:#fafbf9}
.opex-v3 .day.out{background:#f3f5f2}.opex-v3 .day.out .n{color:#c3cbc6}
.opex-v3 .day.past{background:#f6f8f5}.opex-v3 .day.past.wkend{background:#f2f4f1}
.opex-v3 .day.today{box-shadow:inset 0 0 0 2px #22a05a}
.opex-v3 .day[data-day]{cursor:pointer}.opex-v3 .day.sel{background:#fff9e6}
.opex-v3 .dh{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:2px;gap:4px}
.opex-v3 .n{font-weight:800;font-size:15px}
.opex-v3 .today .n::after{content:"TODAY";font-size:9.5px;letter-spacing:.6px;background:#dff5e6;color:#15803d;border-radius:999px;padding:2px 6px;margin-left:6px;vertical-align:2px}
.opex-v3 .dt{font-weight:800;font-size:13px;font-variant-numeric:tabular-nums}.opex-v3 .dt.none{color:#d3d9d5;font-weight:600}
.opex-v3 .pay{display:flex;align-items:center;gap:6px;padding:3px 8px 3px 7px;border-radius:999px;border:1px solid transparent;background:#eef4ef;cursor:pointer;min-width:0;text-align:left;font:inherit;font-size:11.5px;color:var(--ink);width:100%}
.opex-v3 .pay .sw{width:7px;height:7px;border-radius:2px;flex:none}
.opex-v3 .pay .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.opex-v3 .pay .nm small{color:var(--muted);font-weight:600;font-size:10.5px}
.opex-v3 .pay .v{font-weight:700;font-variant-numeric:tabular-nums;flex:none}
.opex-v3 .pay.proj{background:#fff;border:1px dashed #cfd6d1;color:var(--ink-2)}
.opex-v3 .pay:hover,.opex-v3 .pay[aria-expanded="true"]{border-color:#22a05a}
.opex-v3 .wkt{position:absolute;right:8px;bottom:5px;font-size:10.5px;color:var(--muted)}
.opex-v3 .led .hd{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.opex-v3 .led .hd h2{margin:0;font-size:13px;letter-spacing:.9px;text-transform:uppercase;color:var(--muted);font-weight:700}
.opex-v3 .fchip{display:inline-flex;align-items:center;gap:6px;background:#dff5e6;color:#15532d;border-radius:999px;padding:4px 6px 4px 12px;font-weight:700;font-size:12.5px}
.opex-v3 .fchip button{border:0;background:#fff;border-radius:50%;width:18px;height:18px;cursor:pointer;font:inherit;line-height:1;color:#15532d}
.opex-v3 .tw{overflow-x:auto}
.opex-v3 table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
.opex-v3 th,.opex-v3 td{padding:9px 14px;text-align:left;border-bottom:1px solid var(--line-2);white-space:nowrap;font-size:13px}
.opex-v3 th{font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);font-weight:700;background:#f7f9f6}
.opex-v3 td.r,.opex-v3 th.r{text-align:right}
.opex-v3 tr.wh td{background:#f3f6f2;font-weight:800;font-size:12px;letter-spacing:.4px;text-transform:uppercase;color:var(--ink-2);padding:7px 14px}
.opex-v3 tr.wh td.r{color:var(--ink)}
.opex-v3 td .sw{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:7px;vertical-align:1px}
.opex-v3 td.cat{color:var(--ink-2)}.opex-v3 td.city{color:var(--muted)}.opex-v3 td.cum{color:var(--muted)}
.opex-v3 td.none{color:var(--muted);text-align:center;padding:18px}
.opex-v3 .st{font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px}
.opex-v3 .st.paid{background:#dff5e6;color:#15803d}.opex-v3 .st.proj{background:#fff;border:1px dashed #cfd6d1;color:var(--muted)}
.opex-v3 tr.hl td{background:#fff9e6}
.opex-v3 tr.tot td{background:#eef3ef;font-weight:800;border-top:2px solid var(--line);border-bottom:0}
.opex-v3 .i{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid #c7d0ca;color:var(--muted);font:italic 700 10px/1 Georgia,serif;cursor:pointer;background:#fff;padding:0;vertical-align:-3px}
.opex-v3 .pop{position:fixed;z-index:60;width:300px;background:#10231a;color:#fff;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.45;box-shadow:0 10px 30px rgba(0,0,0,.2);white-space:normal}
.opex-v3 .pop[hidden]{display:none}
.opex-v3 .pop .h{font-weight:800;margin-bottom:4px}
.opex-v3 .pop .sub{color:#a9bdb1;font-size:12px}
.opex-v3 .pop dl{display:grid;grid-template-columns:1fr auto;align-items:baseline;gap:3px 10px;margin:6px 0 0}
.opex-v3 .pop dt{color:#a9bdb1}.opex-v3 .pop dd{margin:0}
.opex-v3 .pop dl.pp dt{color:#fff}.opex-v3 .pop dl.pp dd{text-align:right;font-variant-numeric:tabular-nums}
.opex-v3 .pop .m{color:#7f968a}
.opex-v3 .pop .swi{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}
`;
