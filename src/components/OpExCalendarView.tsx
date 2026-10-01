"use client";

// OpEx — the cash-out calendar. Layout is scripts/mocks/opex-calendar-v2.html (the spec for
// layout, wording and data-testids; its amounts are placeholders).
//
// NUMBERS come from buildOpexCalendarAsOf (src/lib/opexSources.ts): days up to today are what was
// actually PAID (solid chip), days after today are the PROJECTION from venue settings (dashed chip).
// Field Costs' paid side is the bank reconciliation; see the block above BANK_SOURCE for what that
// can and cannot say (it records the month, not the day).
//
// One set of numbers feeds the cells, the row Month column, the category totals and the header
// card, so they cannot disagree. This component is presentation, collapse state, the i popover and
// the inline expense editor only. The month comes from the Finance shell's period control.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { daysInMonth } from "@/lib/checkIns";
import { refetchFinanceData, useFinanceData, type FinExpense } from "@/lib/useFinanceData";
import { monthLabel } from "@/lib/opex";
import {
  buildOpexCalendarAsOf,
  monthKeyFor,
  rowTotal,
  type CalGroup,
  type CalRow,
  type OpexCalendarAsOf,
} from "@/lib/opexSources";
import { updateFinExpense } from "@/lib/finExpenseWrites";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import { canAccess, useAuth } from "@/lib/useAuth";

const WD1 = ["S", "M", "T", "W", "T", "F", "S"];
const WD3 = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "$1,440" for whole dollars, "$698.20" when there are cents — cents never drop off.
function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(r) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

// data-testid key for a category: city / match / field / exp-<slug>
function catKey(g: CalGroup): string {
  if (g.key.startsWith("expcat:")) return `exp-${g.key.slice(7).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return g.key;
}

type DayPop = { label: string; total: number; items: [string, number][] };
type PopState = { id: string; x: number; y: number; group?: CalGroup; row?: CalRow; day?: DayPop } | null;

// Category bar colours, biggest category first: the mock's three greens, extended in the same
// family (deep → teal → light) so five or six categories stay distinguishable.
const CAT_COL = ["#2f6b4f", "#5aa77a", "#a7d3b6", "#3f8f8a", "#8cc7c0", "#1f4d4a"];

export default function OpExCalendarView() {
  const { data, loading, error } = useFinanceData();
  const { appUser } = useAuth();
  // Same gate as the Expenses page. Only decides whether edit affordances render; the shared
  // write path re-checks the manual_entry lock on every save.
  const canEdit = canAccess(appUser, "finance");

  const { period, now } = useFinancePeriod();
  const year = period.start.getFullYear();
  const month0 = period.start.getMonth();
  const days = daysInMonth(year, month0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pop, setPop] = useState<PopState>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const saveEdit = useCallback(
    async (expense: FinExpense, amountStr: string, dateStr: string) => {
      if (!appUser) throw new Error("Not signed in");
      const amount = Number(amountStr);
      if (amountStr.trim() === "" || !Number.isFinite(amount)) throw new Error("Amount must be a number.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error("Date must be YYYY-MM-DD.");
      const [y, mo] = dateStr.split("-").map(Number);
      const month = monthKeyFor(y, mo - 1); // keep month bucket consistent with date
      await updateFinExpense(expense, { amount, date: dateStr, month }, appUser);
      await refetchFinanceData();
      setEditingId(null);
    },
    [appUser],
  );

  const cal = useMemo(() => buildOpexCalendarAsOf(data, year, month0, now), [data, year, month0, now]);

  // NEXT 7 DAYS is about the real calendar, whatever month the grid shows — so it reads this
  // month's calendar and, when the week crosses month end, next month's.
  const next7 = useMemo(() => {
    const ty = now.getFullYear();
    const tm = now.getMonth();
    const cur = buildOpexCalendarAsOf(data, ty, tm, now);
    const ny = tm === 11 ? ty + 1 : ty;
    const nm = (tm + 1) % 12;
    let nxt: OpexCalendarAsOf | null = null;
    const out: { key: string; wd: number; label: string; total: number; items: [string, number][] }[] = [];
    for (let i = 1; i <= 7; i++) {
      const dt = new Date(ty, tm, now.getDate() + i);
      const inNext = dt.getMonth() !== tm;
      if (inNext && !nxt) nxt = buildOpexCalendarAsOf(data, ny, nm, now);
      const c = inNext ? nxt! : cur;
      const d = dt.getDate();
      const items = new Map<string, number>();
      for (const g of c.groups) for (const r of g.rows) {
        const v = r.cells[d];
        if (v) items.set(r.label, r2((items.get(r.label) ?? 0) + v));
      }
      const list = [...items.entries()].sort((a, b) => b[1] - a[1]);
      out.push({
        key: `${dt.getMonth()}-${d}`,
        wd: dt.getDay(),
        label: `${MON3[dt.getMonth()]} ${d}`,
        total: r2(list.reduce((s, [, v]) => s + v, 0)),
        items: list,
      });
    }
    return out;
  }, [data, now]);
  const maxNext = Math.max(0, ...next7.map((x) => x.total));

  // Every category starts collapsed, as in the mock; open state is per category and survives month nav.
  const isOpen = (g: CalGroup) => open[g.key] ?? false;
  const toggle = (g: CalGroup) => {
    setPop(null);
    setOpen((s) => ({ ...s, [g.key]: !isOpen(g) }));
  };

  // The i popover: second click on the same i, a click outside, Esc, or scrolling the grid closes it.
  const openPop = (id: string, el: HTMLElement, group: CalGroup, row?: CalRow) => {
    if (pop?.id === id) return setPop(null);
    anchorRef.current = el;
    const rc = el.getBoundingClientRect();
    setPop({ id, x: Math.max(8, Math.min(window.innerWidth - 316, rc.left - 10)), y: rc.bottom + 8, group, row });
  };
  // A day tile: hover shows every payment that day, leaving closes it, a click pins/unpins it.
  const showDay = (id: string, el: HTMLElement, day: DayPop) => {
    anchorRef.current = el;
    const rc = el.getBoundingClientRect();
    setPop({ id, x: Math.max(8, Math.min(window.innerWidth - 316, rc.left)), y: rc.bottom + 8, day });
  };
  const catLines = useMemo(() => {
    const total = cal.monthTotal;
    const sorted = [...cal.groups].sort((a, b) => b.subtotal - a.subtotal);
    const mx = Math.max(0, ...sorted.map((g) => g.subtotal));
    return sorted.map((g, i) => ({
      key: g.key,
      name: g.name,
      t: g.subtotal,
      col: CAT_COL[i % CAT_COL.length],
      pct: total > 0 ? Math.round((g.subtotal / total) * 100) : 0,
      w: mx > 0 ? Math.max(0, (g.subtotal / mx) * 100) : 0,
    }));
  }, [cal]);
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (popRef.current?.contains(t) || t.closest?.(".i") || t.closest?.(".dayt")) return;
      setPop(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setPop(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pop]);

  const dayCols = Array.from({ length: days }, (_, i) => i + 1);
  const today = cal.state === "current" ? now.getDate() : -1;
  const dayCls = (d: number) => {
    const w = new Date(year, month0, d).getDay();
    return `day${d === today ? " today" : ""}${w === 0 || w === 6 ? " wkend" : ""}`;
  };
  const chipCls = (d: number) => `chip ${d <= cal.paidThrough ? "actual" : "proj"}`;
  const left = r2(cal.monthTotal - cal.paidTotal);
  const paidPct = cal.monthTotal > 0 ? (cal.paidTotal / cal.monthTotal) * 100 : 0;

  return (
    <div className="opex-cal">
      <style>{OPEX_CSS}</style>

      <div className="top">
        <h1 className="font-display">OpEx</h1>
        <span className="month" data-testid="month">{monthLabel(year, month0)}</span>
        <span className="sp" />
        <Link className="ox-add" href="/admin/finance/ledger/expenses">+ Add expense</Link>
      </div>

      {error && <div className="ox-err">Failed to load finance data: {error}</div>}

      <section className="hdr" data-testid="summary">
        <div className="hdr-left">
          <div className="k">Cash out · {monthLabel(year, month0)}</div>
          <div className="big num" data-testid="sum-month">{fmt(cal.monthTotal)}</div>
          <div className="bar" data-testid="paid-bar">
            <span className="paid" id="paidFill" style={{ width: `${paidPct.toFixed(1)}%` }} />
          </div>
          <div className="barcap">
            <span><i className="dot paid" /><b className="num" data-testid="sum-paid">{fmt(cal.paidTotal)}</b> paid</span>
            <span><i className="dot left" /><b className="num" data-testid="sum-left">{fmt(left)}</b> still to go</span>
          </div>
          <div className="cats" data-testid="cat-split">
            {catLines.map((c) => (
              <div key={c.key} className="crow" data-testid="cat-line">
                <span className="sw" style={{ background: c.col }} />
                <span className="n">{c.name}</span>
                <span className="pc">{c.pct}%</span>
                <b>{fmt(c.t)}</b>
                <span className="tr"><span style={{ width: `${c.w.toFixed(1)}%`, background: c.col }} /></span>
              </div>
            ))}
          </div>
        </div>
        <div className="hdr-right">
          <div className="k">Next 7 days</div>
          <div className="days" data-testid="next7">
            {next7.map((x) => {
              const id = `day:${x.key}`;
              const day = { label: x.label, total: x.total, items: x.items };
              return (
              <button
                type="button"
                key={x.key}
                className={`dayt${x.total ? " busy" : ""}${x.total && x.total === maxNext ? " topday" : ""}`}
                data-testid="next-day"
                disabled={!x.total}
                aria-expanded={pop?.id === id}
                onMouseEnter={(e) => { if (pop?.id !== id) showDay(id, e.currentTarget, day); }}
                onMouseLeave={(e) => {
                  const to = e.relatedTarget as Node | null;
                  if (pop?.id === id && !(to && popRef.current?.contains(to))) setPop(null);
                }}
                onClick={(e) => (pop?.id === id ? setPop(null) : showDay(id, e.currentTarget, day))}
              >
                <span className="w">{WD3[x.wd]}</span>
                <span className="d">{x.label}</span>
                <span className={`a${x.total ? "" : " none"}`}>{x.total ? fmt(x.total) : "—"}</span>
                <ul>
                  {x.items.slice(0, 2).map(([n]) => <li key={n}>{n}</li>)}
                  {x.items.length > 2 && <li className="more">+{x.items.length - 2} more</li>}
                </ul>
              </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* NO GRID UNTIL THE DATA IS HERE. An empty table is a page that rendered nothing, and a
          check waiting on the grid would take it for a page that rendered. */}
      {!data && <div className="card ox-loading">{error ? "Finance data did not load." : "Loading finance data…"}</div>}
      {data && <div className="card">
        <div className="wrap" data-testid="grid-wrap" onScroll={(e) => {
          // FOLLOW THE i, DON'T CLOSE ON ANY SCROLL. Scrolling a row into view and clicking its i
          // delivers the scroll event a frame AFTER the click, which closed the popover it opened.
          if (!pop || !anchorRef.current) return;
          const a = anchorRef.current.getBoundingClientRect();
          const w = e.currentTarget.getBoundingClientRect();
          if (a.bottom < w.top || a.top > w.bottom || a.right < w.left || a.left > w.right) return setPop(null);
          setPop({ ...pop, x: Math.max(8, Math.min(window.innerWidth - 316, a.left - 10)), y: a.bottom + 8 });
        }}>
          <table data-testid="grid">
            <thead>
              <tr>
                <th className="c-name">Category / line item</th>
                <th className="c-tot">Month</th>
                {dayCols.map((d) => (
                  <th key={d} className={dayCls(d)} data-testid={`day-${d}`}>
                    {d}
                    <small>{WD1[new Date(year, month0, d).getDay()]}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cal.groups.map((g) => {
                const ck = catKey(g);
                const opened = isOpen(g);
                return (
                  <GroupRows
                    key={g.key}
                    group={g}
                    ck={ck}
                    opened={opened}
                    days={days}
                    dayCols={dayCols}
                    dayCls={dayCls}
                    chipCls={chipCls}
                    onToggle={() => toggle(g)}
                    onInfo={openPop}
                    popId={pop?.id ?? null}
                    canEdit={canEdit}
                    editingId={editingId}
                    onStartEdit={setEditingId}
                    onCancelEdit={() => setEditingId(null)}
                    onSaveEdit={saveEdit}
                  />
                );
              })}

              <tr className="dtot">
                <td className="c-name">Daily total</td>
                <td className="c-tot">{fmt(cal.monthTotal)}</td>
                {dayCols.map((d) => (
                  <td key={d} className={dayCls(d)}>
                    {cal.dayTotal[d] ? <span className="n">{fmt(cal.dayTotal[d])}</span> : <span className="n dash">—</span>}
                  </td>
                ))}
              </tr>
              <tr className="cum">
                <td className="c-name">Cumulative</td>
                <td className="c-tot" />
                <td className="spark" colSpan={days}>
                  <Sparkline cumulative={cal.cumulative} days={days} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {(cal.undatedFieldCosts !== 0 || loading) && (
          <div className="ox-recon">
            {cal.undatedFieldCosts !== 0 && (
              <>
                {`${fmt(cal.undatedFieldCosts)} of ${fmt(cal.monthTotal)} has no day: it is in the Month totals but on no date. Each row's i says which.`}
              </>
            )}
            {loading && <> Loading finance data…</>}
          </div>
        )}
      </div>}

      <div
        ref={popRef}
        className="pop"
        data-testid="popover"
        hidden={!pop}
        style={pop ? { left: pop.x, top: pop.y } : undefined}
      >
        {pop?.day && (
          <>
            <div className="h">{pop.day.label} · {fmt(pop.day.total)}</div>
            <dl>
              {pop.day.items.map(([n, v]) => (
                <span key={n} style={{ display: "contents" }}><dt>{n}</dt><dd className="amt">{fmt(v)}</dd></span>
              ))}
            </dl>
          </>
        )}
        {pop?.group && !pop.row && (
          <>
            <div className="h">{pop.group.name}</div>
            {pop.group.how}
          </>
        )}
        {pop?.row?.info && (
          <>
            <div className="h">{pop.row.info.title}</div>
            <dl>
              <dt>Billed</dt><dd>{pop.row.info.billed}</dd>
              <dt>Rate</dt><dd>{pop.row.info.rate}</dd>
              <dt>Source</dt><dd>{pop.row.info.source}</dd>
              {pop.row.info.ytd && (<><dt>{year} so far</dt><dd>{pop.row.info.ytd}</dd></>)}
            </dl>
            {pop.row.info.notes.map((n) => <p key={n} className="note">{n}</p>)}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- rows ----------------

function GroupRows({
  group, ck, opened, days, dayCols, dayCls, chipCls, onToggle, onInfo, popId,
  canEdit, editingId, onStartEdit, onCancelEdit, onSaveEdit,
}: {
  group: CalGroup;
  ck: string;
  opened: boolean;
  days: number;
  dayCols: number[];
  dayCls: (d: number) => string;
  chipCls: (d: number) => string;
  onToggle: () => void;
  onInfo: (id: string, el: HTMLElement, group: CalGroup, row?: CalRow) => void;
  popId: string | null;
  canEdit: boolean;
  editingId: number | null;
  onStartEdit: (id: number) => void;
  onCancelEdit: () => void;
  onSaveEdit: (expense: FinExpense, amount: string, date: string) => Promise<void>;
}) {
  const catId = `cat:${ck}`;
  return (
    <>
      <tr className="cat" data-testid={`cat-${ck}`} aria-expanded={opened}>
        <td className="c-name">
          <span className="nm">
            <button type="button" className="catbtn" onClick={onToggle}>
              <span className="tw">▼</span>{group.name}
            </button>
            <button
              type="button"
              className="i"
              aria-label={`About ${group.name}`}
              aria-expanded={popId === catId}
              onClick={(e) => onInfo(catId, e.currentTarget, group)}
            >i</button>
          </span>
        </td>
        <td className="c-tot" data-total={r2(group.subtotal)}>{fmt(group.subtotal)}</td>
        {dayCols.map((d) => (
          <td key={d} className={dayCls(d)}>
            {group.agg[d] ? <span className={chipCls(d)}>{fmt(group.agg[d])}</span> : null}
          </td>
        ))}
      </tr>

      {opened && group.rows.map((r, i) => {
        const exp = r.edit?.expense;
        const editable = canEdit && !!exp && exp.manual_entry;
        const rowId = `row:${ck}:${i}`;
        const total = rowTotal(r);
        if (editable && exp && editingId === exp.id) {
          return (
            <LeafEditRow key={r.key} row={r} ck={ck} index={i} total={total} expense={exp} days={days}
              onSave={onSaveEdit} onCancel={onCancelEdit} />
          );
        }
        return (
          <tr key={r.key} className="sub" data-testid={`row-${ck}-${i}`} data-cat={ck}>
            <td className="c-name">
              <span className="nm">
                <b>{r.label}</b>
                {r.sublabel && <span className="city">{r.sublabel}</span>}
                <button
                  type="button"
                  className="i"
                  aria-label={`About ${r.label}`}
                  aria-expanded={popId === rowId}
                  onClick={(e) => onInfo(rowId, e.currentTarget, group, r)}
                >i</button>
              </span>
            </td>
            <td className="c-tot" data-total={total}>{fmt(total)}</td>
            {dayCols.map((d) => (
              <td key={d} className={dayCls(d)} data-day={d}>
                {r.cells[d] ? (
                  editable && exp ? (
                    <button
                      type="button"
                      className={chipCls(d)}
                      title="Click to edit amount / date"
                      data-testid="opex-amount-chip"
                      data-expense-id={exp.id}
                      onClick={() => onStartEdit(exp.id)}
                    >{fmt(r.cells[d])}</button>
                  ) : (
                    <span className={chipCls(d)}>{fmt(r.cells[d])}</span>
                  )
                ) : null}
              </td>
            ))}
          </tr>
        );
      })}
    </>
  );
}

// Inline editor for a single manual expense row: amount + date only. Explicit commit — Enter or
// Save writes, Esc or Cancel aborts. NO blur-to-save, so a stray click can never silently write to
// a booked cost. A failed write keeps the row open with the error and the entered values intact.
function LeafEditRow({
  row, ck, index, total, expense, days, onSave, onCancel,
}: {
  row: CalRow;
  ck: string;
  index: number;
  total: number;
  expense: FinExpense;
  days: number;
  onSave: (expense: FinExpense, amount: string, date: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(String(expense.amount));
  const [date, setDate] = useState(expense.date);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const commit = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setErr(null);
    try {
      await onSave(expense, amount, date);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
      setSaving(false);
    }
  }, [saving, onSave, expense, amount, date]);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); void commit(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    },
    [commit, onCancel],
  );

  return (
    <tr className="sub editing" data-testid={`row-${ck}-${index}`} data-cat={ck}>
      <td className="c-name">
        <span className="nm"><b>{row.label}</b>{row.sublabel && <span className="city">{row.sublabel}</span>}</span>
      </td>
      <td className="c-tot" data-total={total}>{fmt(total)}</td>
      <td className="editcell" colSpan={days} data-testid="opex-edit-row">
        <div className="editform">
          <label className="fld">
            <span>Amount</span>
            <input type="number" step="0.01" data-testid="opex-amount-input" value={amount} autoFocus
              disabled={saving} onChange={(e) => setAmount(e.target.value)} onKeyDown={onKey} />
          </label>
          <label className="fld">
            <span>Date</span>
            <input type="date" value={date} disabled={saving} onChange={(e) => setDate(e.target.value)} onKeyDown={onKey} />
          </label>
          <button type="button" className="save" data-testid="opex-save" disabled={saving} onClick={() => void commit()}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="cancel" disabled={saving} onClick={onCancel}>Cancel</button>
          {err && <span className="editerr">{err}</span>}
        </div>
      </td>
    </tr>
  );
}

// Filled step sparkline across the day columns.
function Sparkline({ cumulative, days }: { cumulative: number[]; days: number }) {
  const W = days * 58;
  const yB = 42;
  const yT = 10;
  const maxCum = cumulative[days] || 1;
  const X = (d: number) => (d - 0.5) * 58;
  const Y = (d: number) => yB - (cumulative[d] / maxCum) * (yB - yT);
  let pts = "";
  for (let d = 1; d <= days; d++) pts += `${d > 1 ? " L " : ""}${X(d).toFixed(1)},${Y(d).toFixed(1)}`;
  const area = `M ${X(1).toFixed(1)},${yB} L ${pts} L ${X(days).toFixed(1)},${yB} Z`;
  return (
    <svg className="sv" viewBox={`0 0 ${W} 54`} preserveAspectRatio="none">
      <path d={area} fill="#e2f1e8" />
      <path d={`M ${pts}`} fill="none" stroke="#22a05a" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

// Scoped styles ported from scripts/mocks/opex-calendar-v2.html. Every selector is namespaced
// under .opex-cal so nothing leaks into the rest of the app.
const OPEX_CSS = `
.opex-cal{--nav:#0b3a28;--line:#e3e8e1;--line-2:#eef1ec;--ink:#10231a;--ink-2:#46594e;--muted:#7b8b82;
  --cat:#e9f3ec;--wk:#f6f8f5;--today:#fff6dc;--chip:#e2f2e7;--chip-ink:#14532d;--proj-line:#a9c9b4;
  color:var(--ink);display:grid;gap:14px}
.opex-cal .num{font-variant-numeric:tabular-nums}
.opex-cal .top{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.opex-cal h1{margin:0;font-size:28px;font-weight:800;color:var(--ink)}
.opex-cal .month{font-weight:800;font-size:18px}
.opex-cal .sp{flex:1}
.opex-cal .legend{display:flex;gap:14px;align-items:center;color:var(--ink-2);font-size:12px}
.opex-cal .lg{display:inline-flex;align-items:center;gap:6px}
.opex-cal .lg i{display:inline-block;width:26px;height:14px;border-radius:5px}
.opex-cal .lg-paid{background:var(--chip)}
.opex-cal .lg-proj{background:#fff;border:1px dashed var(--proj-line)}
.opex-cal .lg-today{background:var(--today);border:1px solid #f2c94c}
.opex-cal .ox-add{border:0;background:#22c55e;color:#06301d;font-weight:700;font-size:13px;padding:9px 15px;border-radius:10px}
.opex-cal .ox-err{background:#fdecec;border:1px solid #e9a6a6;border-radius:11px;padding:10px 14px;font-size:12.5px;color:#9a3838}

.opex-cal .hdr{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px 22px;display:grid;grid-template-columns:minmax(300px,380px) 1fr;gap:28px}
@media (max-width:900px){.opex-cal .hdr{grid-template-columns:1fr}}
.opex-cal .hdr .k{font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);font-weight:700}
.opex-cal .big{font-size:38px;font-weight:800;line-height:1.1;margin:6px 0 12px}
.opex-cal .bar{height:10px;border-radius:999px;background:repeating-linear-gradient(135deg,#eef3ef 0 6px,#e1ebe4 6px 12px);overflow:hidden}
.opex-cal .bar .paid{display:block;height:100%;background:#22a05a;border-radius:999px}
.opex-cal .barcap{display:flex;justify-content:space-between;margin-top:8px;font-size:13px;color:var(--ink-2)}
.opex-cal .barcap b{color:var(--ink)}
.opex-cal .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:1px}
.opex-cal .dot.paid{background:#22a05a}.opex-cal .dot.left{background:#cfdcd3}
.opex-cal .cats{margin-top:16px;padding-top:14px;border-top:1px solid var(--line-2);display:grid;gap:10px}
.opex-cal .crow{display:grid;grid-template-columns:10px 1fr auto auto;align-items:center;gap:4px 10px;font-size:13px}
.opex-cal .crow .sw{width:10px;height:10px;border-radius:3px}
.opex-cal .crow .n{color:var(--ink-2)}
.opex-cal .crow .pc{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;width:38px;text-align:right}
.opex-cal .crow b{color:var(--ink);font-variant-numeric:tabular-nums;width:84px;text-align:right}
.opex-cal .crow .tr{grid-column:2 / -1;height:6px;border-radius:999px;background:#eef2ef;overflow:hidden}
.opex-cal .crow .tr span{display:block;height:100%;border-radius:999px}
.opex-cal .dayt{cursor:pointer;text-align:left;font:inherit;color:inherit}
.opex-cal .dayt:disabled{cursor:default}
.opex-cal .dayt:not(:disabled):hover,.opex-cal .dayt[aria-expanded="true"]{border-color:#22a05a}
.opex-cal .dayt .more{color:#16803c;font-weight:700}
.opex-cal .pop dd.amt{text-align:right;font-variant-numeric:tabular-nums}
.opex-cal .hdr-right{border-left:1px solid var(--line-2);padding-left:28px;min-width:0}
@media (max-width:900px){.opex-cal .hdr-right{border-left:0;padding-left:0}}
.opex-cal .days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;margin-top:10px}
.opex-cal .dayt{border:1px solid var(--line);border-radius:12px;padding:10px 10px 9px;min-width:0;display:grid;gap:2px;background:#fff;align-content:start}
.opex-cal .dayt.busy{background:#f3faf5;border-color:#cfe6d7}
.opex-cal .dayt.topday{border-color:#22a05a;box-shadow:inset 0 0 0 1px #22a05a}
.opex-cal .dayt .w{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.6px}
.opex-cal .dayt .d{font-size:18px;font-weight:800}
.opex-cal .dayt .a{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums}
.opex-cal .dayt .a.none{color:#c3cbc6;font-weight:600}
.opex-cal .dayt ul{list-style:none;margin:4px 0 0;padding:0;display:grid;gap:2px;font-size:11.5px;color:var(--ink-2)}
.opex-cal .dayt li{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* the grid scrolls inside its own container so both headers stay put */
.opex-cal .card{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.opex-cal .wrap{overflow:auto;max-height:calc(100vh - 290px);min-height:420px}
.opex-cal table{border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums}
.opex-cal th,.opex-cal td{border-bottom:1px solid var(--line-2);padding:0;height:40px;white-space:nowrap;font-size:13px}
.opex-cal thead th{position:sticky;top:0;z-index:3;background:var(--nav);color:#fff;height:48px;font-weight:700}
.opex-cal thead th.day{width:58px;min-width:58px;text-align:center;font-size:15px}
.opex-cal thead th.day small{display:block;font-size:10px;font-weight:600;opacity:.7}
.opex-cal thead th.day.wkend{background:#14432f}
.opex-cal thead th.day.today{background:#f2c94c;color:#3d2c00}
.opex-cal .c-name{position:sticky;left:0;z-index:2;background:#fff;width:300px;min-width:300px;max-width:300px;padding:0 10px 0 14px;box-shadow:inset -1px 0 0 var(--line);text-align:left}
.opex-cal .c-tot{position:sticky;left:300px;z-index:2;background:#fff;width:96px;min-width:96px;text-align:right;padding-right:12px;font-weight:700;box-shadow:inset -2px 0 0 var(--line)}
.opex-cal thead .c-name,.opex-cal thead .c-tot{z-index:5;background:var(--nav);color:#fff;font-size:11px;letter-spacing:.8px;text-transform:uppercase}
.opex-cal thead .c-tot{text-align:right}
.opex-cal td.day{text-align:center;border-left:1px solid var(--line-2);min-width:58px}
.opex-cal td.day.wkend{background:var(--wk)}
.opex-cal td.day.today{background:var(--today)}
.opex-cal tr.cat td{background:var(--cat);height:44px}
.opex-cal tr.cat td.c-name,.opex-cal tr.cat td.c-tot{background:var(--cat)}
.opex-cal tr.cat td.day.today{background:#f7ecc4}
.opex-cal .catbtn{border:0;background:transparent;padding:0;display:flex;align-items:center;gap:8px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;font-size:13px;cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;color:inherit}
.opex-cal .catbtn .tw{display:inline-block;transition:transform .12s;font-size:10px;color:var(--ink-2)}
.opex-cal tr.cat[aria-expanded="false"] .tw{transform:rotate(-90deg)}
.opex-cal .nm{display:flex;align-items:center;gap:6px;min-width:0}
.opex-cal .nm b{font-weight:600;overflow:hidden;text-overflow:ellipsis}
.opex-cal .nm .city{color:var(--muted);font-size:12px;flex:none}
.opex-cal .chip{display:inline-block;border-radius:6px;padding:3px 6px;font-size:12px;font-weight:700;line-height:1.2;border:1px solid transparent;font-family:inherit}
.opex-cal .chip.actual{background:var(--chip);color:var(--chip-ink)}
.opex-cal .chip.proj{background:#fff;color:var(--ink-2);border:1px dashed var(--proj-line)}
.opex-cal button.chip{cursor:pointer}
.opex-cal button.chip:hover{outline:2px solid #22a05a}
.opex-cal tr.cat .chip{font-size:12.5px}
.opex-cal tr.sub td.c-name{padding-left:30px}
.opex-cal tr.dtot td{background:#f1f4f0;font-weight:800;border-top:2px solid var(--nav)}
.opex-cal tr.dtot td.c-name,.opex-cal tr.dtot td.c-tot{background:#f1f4f0;font-size:12px;letter-spacing:.5px;text-transform:uppercase}
.opex-cal tr.dtot td .n{font-size:12px}
.opex-cal tr.dtot td .n.dash{color:#c3cbc6;font-weight:600}
.opex-cal tr.cum td{background:#f8faf7}
.opex-cal tr.cum td.c-name,.opex-cal tr.cum td.c-tot{background:#f8faf7;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)}
.opex-cal tr.cum td.spark{height:54px}
.opex-cal tr.cum td.spark .sv{display:block;width:100%;height:54px}
.opex-cal .ox-loading{padding:40px;text-align:center;color:var(--muted)}
.opex-cal .ox-recon{padding:10px 16px;background:#f8faf7;border-top:1px solid var(--line);font-size:12.5px;color:var(--ink-2)}

.opex-cal .i{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid #c7d0ca;color:var(--muted);
  font:italic 700 10px/1 Georgia,serif;cursor:pointer;background:#fff;padding:0;flex:none}
.opex-cal .i:hover,.opex-cal .i[aria-expanded="true"]{color:var(--ink);border-color:var(--ink-2)}
.opex-cal .pop{position:fixed;z-index:60;width:300px;background:#10231a;color:#fff;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.45;box-shadow:0 10px 30px rgba(0,0,0,.2);white-space:normal}
.opex-cal .pop[hidden]{display:none}
.opex-cal .pop .h{font-weight:800;margin-bottom:4px}
.opex-cal .pop dl{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin:6px 0 0}
.opex-cal .pop dt{color:#a9bdb1}
.opex-cal .pop dd{margin:0}
.opex-cal .pop .note{margin:8px 0 0;color:#cfe0d5;font-size:12px}

.opex-cal tr.editing td{background:#f4fbf6}
.opex-cal td.editcell{text-align:left;padding:6px 14px}
.opex-cal .editform{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.opex-cal .fld{display:flex;flex-direction:column;gap:3px}
.opex-cal .fld span{font-size:9.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)}
.opex-cal .fld input{border:1px solid var(--line);border-radius:8px;padding:5px 9px;font-size:13px;font-weight:600;background:#fff}
.opex-cal .save{border:0;background:#22c55e;color:#06301d;font-weight:800;font-size:12px;padding:7px 16px;border-radius:8px;cursor:pointer}
.opex-cal .cancel{border:1px solid var(--line);background:#fff;font-weight:700;font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer}
.opex-cal .save:disabled,.opex-cal .cancel:disabled{opacity:.6;cursor:default}
.opex-cal .editerr{font-size:11.5px;font-weight:700;color:#9a3838;background:#fdecec;border:1px solid #e9a6a6;border-radius:7px;padding:6px 10px}
`;
