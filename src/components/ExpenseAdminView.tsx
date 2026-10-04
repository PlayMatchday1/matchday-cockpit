"use client";

// FINANCE › EXPENSES — one month, one list grouped by category (Ryan, 2026-10-03).
//
// Replaces the Recurring / Ledger tabs. The model is src/lib/expensesMonth.ts (pure, asserted by
// scripts/expenses-page-test.ts); this file draws it. NOTHING STORED CHANGES: every write is the
// audited finExpenseWrites path the page always used (insertFinExpense / updateFinExpense /
// deleteFinExpense), with its refusals for imported rows and Match Manager Pay.
//
// THE PAGE IS ALWAYS ONE MONTH. The shell leaves out the FINANCE title and the period bar here
// (src/lib/financeChrome.ts); the month arrows step the same period state, so ?p= and the data
// window follow. The total includes Match Manager Pay and the Meta ad rows, as read-only "auto"
// rows, so it is the number OpEx, the Cost report and the P&L read from the same table.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Lock, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog";
import ExpenseRowEditor, { type ExpenseDraft } from "@/components/ExpenseRowEditor";
import BatchExpenseDrawer from "@/components/BatchExpenseDrawer";
import { insertFinExpense, updateFinExpense, deleteFinExpense } from "@/lib/finExpenseWrites";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import { currentPeriod, stepPeriod } from "@/lib/financePeriod";
import { useAuth } from "@/lib/useAuth";
import { isCityHidden } from "@/lib/types";
import { refetchFinanceData, useFinanceData, type FinExpense } from "@/lib/useFinanceData";
import {
  ALL_CITIES, COMPANY_WIDE, MATCH_PAY, addHint, addProblem, categoryColor, compareCategories, expensesMonth,
  monthKeyOf, planAdd, similarLine, visibleCategories, type AddDraft, type ExpLine,
} from "@/lib/expensesMonth";

const CITY_DISPLAY = [
  "Austin", "Houston", "San Antonio", "Dallas", "Atlanta", "St. Louis", "OKC", "El Paso", "Company-wide",
].filter((c) => !isCityHidden(c));
const BASE_CATEGORIES = ["City Manager", "Equipment", "Marketing", "Misc"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function money(n: number): string {
  const r = Math.round(n * 100) / 100;
  return `${r < 0 ? "−" : ""}$${Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
}
/** "2026-09-30" → "Sep 2026". Only used when a row carries no explicit month string. */
function monthOf(date: string): string {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m] = (date ?? "").split("-");
  const i = Number(m) - 1;
  return M[i] ? `${M[i]} ${y}` : (date ?? "");
}
/** How many other months of the same line survive a one-month delete (fin_expenses stores one row
 *  per month; a delete removes one month only, and the confirmation says how many remain). */
function otherMonthsOf(row: FinExpense, all: FinExpense[]): number {
  const key = (r: FinExpense) => [r.city ?? "", r.category ?? "", r.vendor ?? ""].map((v) => v.trim().toLowerCase()).join("|");
  const k = key(row);
  const months = new Set<string>();
  for (const r of all) if (r.id !== row.id && key(r) === k) months.add(r.month || monthOf(r.date));
  months.delete(row.month || monthOf(row.date));
  return months.size;
}
const fmtMoney = (n: number, _signZero?: boolean) => money(n);

export default function ExpenseAdminView() {
  const { data, loading } = useFinanceData();
  const { appUser } = useAuth();
  const quarter = useFinanceQuarter();
  const { period, now, setPeriod } = useFinancePeriod();
  const year = period.start.getFullYear(), month0 = period.start.getMonth();
  const monthKey = monthKeyOf(year, month0);
  const allRows = useMemo(() => data?.expenses ?? [], [data]);

  const [city, setCity] = useState<string>(ALL_CITIES);
  // ONE BUBBLE AT A TIME (Ryan): click to show only that category, click again for everything.
  const [selected, setSelected] = useState<string | null>(null);

  const month = useMemo(() => expensesMonth(allRows, monthKey, city), [allRows, monthKey, city]);
  const shown = visibleCategories(month, selected);
  const selCat = selected ? month.categories.find((c) => c.name === selected) ?? null : null;
  const bigNumber = selected ? (selCat?.total ?? 0) : month.total;
  const share = selected && month.total ? Math.round(((selCat?.total ?? 0) / month.total) * 100) : null;
  const includesMatchPay = month.matchPay > 0 && (selected == null || selected === MATCH_PAY);

  // Every category the page knows (so a bubble can open one with nothing this month), in the
  // page's one order (expensesMonth.CATEGORY_ORDER) — the same for bubbles, cards and dropdown.
  const allCats = useMemo(() => {
    const names = new Set<string>([...BASE_CATEGORIES, ...allRows.map((r) => r.category).filter(Boolean)]);
    const totals = new Map(month.categories.map((c) => [c.name, c.total]));
    return [...names].map((n) => ({ name: n, total: totals.get(n) ?? 0 }))
      .sort((a, b) => compareCategories(a.name, b.name));
  }, [allRows, month]);
  const addableCats = allCats.map((c) => c.name).filter((c) => c !== MATCH_PAY);

  const cityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) if (r.city && r.city !== COMPANY_WIDE) set.add(r.city);
    return [ALL_CITIES, ...CITY_DISPLAY.filter((c) => c === COMPANY_WIDE || set.has(c)), ...[...set].filter((c) => !CITY_DISPLAY.includes(c)).sort()];
  }, [allRows]);

  /* ── THE ADD ROW ─────────────────────────────────────────────────────────────────────────── */
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayInMonth = () => {
    const dim = new Date(year, month0 + 1, 0).getDate();
    const d = now.getFullYear() === year && now.getMonth() === month0 ? now.getDate() : 1;
    return `${year}-${pad(month0 + 1)}-${pad(Math.min(d, dim))}`;
  };
  const blank = () => ({ what: "", category: "", amount: "", how: "monthly" as "monthly" | "once", city: "", date: todayInMonth() });
  const [add, setAdd] = useState(blank);
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // SIMILAR NAME (Ryan): "Looks like Deonna already exists. Add to that line instead?" — asked once
  // before saving, never blocking; either answer saves.
  const [similar, setSimilar] = useState<string | null>(null);
  useEffect(() => { setAdd((a) => ({ ...a, date: todayInMonth() })); }, [year, month0]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submitAdd(answer?: { use: string }) {
    if (adding) return;
    if (!appUser) { setAddMsg({ ok: false, text: "Not signed in." }); return; }
    // ONE DATE PICKER: "First payment" when it repeats (its day is the day of every month, its month
    // the first of the twelve), "Date" when it does not.
    const draft: AddDraft = {
      what: answer?.use ?? add.what, category: add.category, amount: Number(add.amount), how: add.how, city: add.city || null,
      day: Number(add.date.slice(8, 10)), date: add.date,
    };
    const problem = addProblem(draft);
    if (problem) { setAddMsg({ ok: false, text: problem }); return; }
    if (!answer) {
      const near = similarLine(draft.what, draft.category, draft.city, allRows);
      if (near) { setAddMsg(null); setSimilar(near); return; }
    }
    setSimilar(null);
    const plan = planAdd(draft, allRows);
    setAdding(true);
    setAddMsg(null);
    let written = 0;
    try {
      // ONE AUDITED INSERT PER ROW, IN ORDER, NO RETRY. A failure stops the run and says how far it got.
      for (const r of plan.rows) {
        await insertFinExpense({ date: r.date, month: r.month, city: r.city, category: r.category, vendor: r.vendor, amount: r.amount, notes: null }, appUser);
        written++;
      }
      const skipped = plan.skipped.length;
      setAddMsg({
        ok: true,
        text: draft.how === "once"
          ? `Added ${draft.what.trim()} · ${money(draft.amount)} on ${plan.rows[0].date}.`
          : `Added ${written} month${written === 1 ? "" : "s"} (${plan.rows[0]?.month ?? "—"} to ${plan.rows[plan.rows.length - 1]?.month ?? "—"})${skipped ? `; skipped ${skipped} that already had this line (${plan.skipped.join(", ")})` : ""}.`,
      });
      setAdd(blank());
    } catch (e) {
      setAddMsg({ ok: false, text: `Not saved after ${written} of ${plan.rows.length}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setAdding(false);
      await refetchFinanceData();
    }
  }

  /* ── IN-PLACE AMOUNT EDIT ────────────────────────────────────────────────────────────────── */
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [editErr, setEditErr] = useState<{ key: string; text: string } | null>(null);
  const committing = useRef(false);
  // ESCAPE MUST NOT SAVE. Closing the input blurs it, and onBlur saves — so Escape (and Enter,
  // which has already saved) mark the blur that follows as one to ignore.
  const skipBlur = useRef(false);
  async function commitEdit(line: ExpLine) {
    if (committing.current) return;
    const row = line.thisRows[0];
    const v = Number(editVal);
    setEditKey(null);
    if (!row || !appUser) return;
    if (!Number.isFinite(v) || v < 0) { setEditErr({ key: line.key, text: "Not saved: enter an amount." }); return; }
    if (Math.abs(v - Number(row.amount)) < 0.005) return;            // nothing changed, nothing sent
    committing.current = true;
    try {
      await updateFinExpense(row, { amount: Math.round(v * 100) / 100 }, appUser);
      setEditErr(null);
      await refetchFinanceData();
    } catch (e) {
      setEditErr({ key: line.key, text: `Not saved: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      committing.current = false;
    }
  }

  /* ── DIALOGS KEPT FROM THE OLD PAGE ─────────────────────────────────────────────────────── */
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchSeed, setBatchSeed] = useState<{ city: string; category: string; vendor: string; month?: string } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorRow, setEditorRow] = useState<FinExpense | null>(null);
  const [deleteRow, setDeleteRow] = useState<FinExpense | null>(null);
  const [multi, setMulti] = useState<ExpLine | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const openEdit = (row: FinExpense) => { setMenuKey(null); setEditorRow(row); setEditorOpen(true); };
  async function handleSubmit(draft: ExpenseDraft): Promise<void> {
    if (!appUser || !editorRow) throw new Error("Not signed in");
    await updateFinExpense(editorRow, {
      date: draft.date, month: draft.month, city: draft.city || null, category: draft.category,
      vendor: draft.vendor || null, amount: draft.amount, notes: draft.notes || null,
    }, appUser);
    await refetchFinanceData();
    setEditorOpen(false);
  }
  async function handleDelete(): Promise<void> {
    if (!appUser) throw new Error("Not signed in");
    if (!deleteRow) return;
    await deleteFinExpense(deleteRow, appUser);
    await refetchFinanceData();
    setDeleteRow(null);
  }

  const mon = MONTHS_FULL[month0];
  const prevFull = MONTHS_FULL[(month0 + 11) % 12];

  return (
    <div className="xp">
      <style>{CSS}</style>

      {/* ── HEADER: the page's own month control (the shell's FINANCE title and period bar are off) ── */}
      <div className="xp-top">
        <h1 className="font-display">Expenses</h1>
        <span className="xp-nav" data-testid="month-nav">
          <button type="button" className="arw" data-testid="month-prev" aria-label="Previous month" onClick={() => setPeriod(stepPeriod(period, -1, now))}>‹</button>
          <span className="mo" data-testid="month">{mon} {year}</span>
          <button type="button" className="arw" data-testid="month-next" aria-label="Next month" onClick={() => setPeriod(stepPeriod(period, 1, now))}>›</button>
          {!(now.getFullYear() === year && now.getMonth() === month0) && (
            <a className="tm" role="button" tabIndex={0} data-testid="this-month" onClick={() => setPeriod(currentPeriod("month", now))}
              onKeyDown={(e) => { if (e.key === "Enter") setPeriod(currentPeriod("month", now)); }}>This month</a>
          )}
        </span>
        <span className="sp" />
        <label className="xp-city">City
          <select data-testid="city-filter" value={city} onChange={(e) => setCity(e.target.value)}>
            {cityOptions.map((c) => <option key={c} value={c}>{c === ALL_CITIES ? "All cities" : c}</option>)}
          </select>
        </label>
      </div>

      {/* ── SUMMARY BAND ─────────────────────────────────────────────────────────────────────── */}
      <section className="xp-band" data-testid="summary">
        <div className="xp-tot">
          <span className="k">{selected ? selected : `Spent · ${mon} ${year}`}</span>
          <b className="big" data-testid="month-total" data-total={bigNumber}>{money(bigNumber)}</b>
          {share != null && <span className="sh" data-testid="share">{share}% of the month</span>}
          {includesMatchPay && <span className="note" data-testid="mmp-note">includes match manager pay</span>}
        </div>
        <div className="xp-bar" data-testid="split-bar" aria-hidden>
          {month.total > 0 && month.categories.filter((c) => c.total > 0).map((c) => (
            <i key={c.name} style={{ width: `${(c.total / month.total) * 100}%`, background: c.color, opacity: selected && selected !== c.name ? 0.25 : 1 }} title={`${c.name} ${money(c.total)}`} />
          ))}
        </div>
        <div className="xp-bubbles" data-testid="bubbles">
          {allCats.map((c) => (
            <button key={c.name} type="button" className="bub" data-testid={`bubble-${c.name}`} data-total={c.total}
              aria-pressed={selected === c.name} data-faded={selected != null && selected !== c.name ? "" : undefined}
              onClick={() => setSelected((s) => (s === c.name ? null : c.name))}>
              <span className="dot" style={{ background: categoryColor(c.name) }} />{c.name} <b>{money(c.total)}</b>
            </button>
          ))}
        </div>
      </section>

      {/* ── THE ADD ROW ──────────────────────────────────────────────────────────────────────── */}
      <form className="xp-add" data-testid="add-row" onSubmit={(e) => { e.preventDefault(); void submitAdd(); }}>
        <input className="w" data-testid="add-what" placeholder="What or who" value={add.what} onChange={(e) => { setSimilar(null); setAdd({ ...add, what: e.target.value }); }} />
        <select data-testid="add-category" value={add.category} onChange={(e) => { setSimilar(null); setAdd({ ...add, category: e.target.value }); }}>
          <option value="">Category</option>
          {addableCats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="amt">$<input data-testid="add-amount" inputMode="decimal" placeholder="Amount" value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} /></span>
        <select data-testid="add-how" value={add.how} onChange={(e) => setAdd({ ...add, how: e.target.value as "monthly" | "once" })}>
          <option value="monthly">Every month</option>
          <option value="once">Once</option>
        </select>
        <select data-testid="add-city" value={add.city} onChange={(e) => { setSimilar(null); setAdd({ ...add, city: e.target.value }); }}>
          {/* "" saves with no city — Company-wide, as the empty choice always did. */}
          <option value="">Company-wide</option>
          {CITY_DISPLAY.filter((c) => c !== COMPANY_WIDE).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="day">{add.how === "monthly" ? "First payment" : "Date"}
          <input data-testid="add-date" type="date" value={add.date} onChange={(e) => setAdd({ ...add, date: e.target.value })} />
        </label>
        <button type="submit" className="go" data-testid="add-save" disabled={adding}>{adding ? "Adding…" : "Add"}</button>
        <a className="more" role="button" tabIndex={0} data-testid="more-options" onClick={() => { setBatchSeed(null); setBatchOpen(true); }}
          onKeyDown={(e) => { if (e.key === "Enter") { setBatchSeed(null); setBatchOpen(true); } }}>More options</a>
        {similar && (
          <div className="sim" data-testid="similar">
            Looks like {similar} already exists. Add to that line instead?
            <button type="button" data-testid="similar-use" disabled={adding} onClick={() => { const use = similar; setAdd((a) => ({ ...a, what: use })); void submitAdd({ use }); }}>Add to {similar}</button>
            <button type="button" data-testid="similar-new" disabled={adding} onClick={() => void submitAdd({ use: add.what })}>Add as {add.what.trim()}</button>
          </div>
        )}
        {addMsg && <div className={`msg${addMsg.ok ? "" : " bad"}`} data-testid="add-msg">{addMsg.text}</div>}
        {addHint(add.how, add.date) && <div className="hint" data-testid="add-hint">{addHint(add.how, add.date)}</div>}
      </form>

      {/* ── ONE LIST, GROUPED BY CATEGORY ────────────────────────────────────────────────────── */}
      {loading && !data && <div className="xp-card xp-empty">Loading expenses…</div>}
      {data && shown.length === 0 && <div className="xp-card xp-empty">{selected ? `Nothing in ${selected} for ${mon}.` : `No expenses for ${mon} ${year}.`}</div>}
      {shown.map((c) => (
        <section key={c.name} className="xp-card" data-testid={`cat-${c.name}`} data-total={c.total}>
          <div className="ch">
            <span className="cn">
              <span className="dot" style={{ background: c.color }} /><b>{c.name}</b>
              {c.name === MATCH_PAY && <Link className="lnk" href="/admin/finance/manager-pay">Manager Pay page</Link>}
            </span>
            <span className="mc" data-testid="col-prev"><small>{prevFull}</small><b>{money(c.lastTotal)}</b></span>
            <span className="mc" data-testid="col-this"><small>{mon}</small><b className="ct">{money(c.total)}</b></span>
            <span />
          </div>
          {c.lines.map((l) => {
            const single = l.thisRows.length === 1 ? l.thisRows[0] : null;
            const editable = !l.auto && !l.locked && !!single && single.manual_entry === true;
            return (
              <div key={l.key} className="ln" data-testid="line" data-auto={l.auto ?? undefined} data-this={l.thisAmount}>
                <div className="nm">
                  <b>{l.auto && <span className="atag">auto</span>}{l.label}</b>
                  <small>{l.city || "Company-wide"} · {l.frequency}{l.locked && !l.auto ? " · imported" : ""}</small>
                </div>
                <span className="last">{l.lastRows.length ? money(l.lastAmount) : "—"}</span>
                <span className="cur">
                  {editKey === l.key ? (
                    <input autoFocus className="pill-in" data-testid="pill-input" inputMode="decimal" value={editVal}
                      onChange={(e) => setEditVal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); skipBlur.current = true; void commitEdit(l); }
                        if (e.key === "Escape") { e.preventDefault(); skipBlur.current = true; setEditKey(null); }
                      }}
                      onBlur={() => { if (skipBlur.current) { skipBlur.current = false; return; } void commitEdit(l); }} />
                  ) : (
                    <button type="button" data-testid="pill"
                      className={`pill ${l.thisRows.length === 0 ? "gap" : "same"}${editable || l.thisRows.length !== 1 ? "" : " ro"}`}
                      title={l.auto ? (l.auto === "match-pay" ? "From the Manager Pay page — read-only" : "From the Meta sync — read-only") : l.locked ? "Imported — read-only" : l.thisRows.length === 0 ? `Add ${mon}` : l.thisRows.length > 1 ? `${l.thisRows.length} rows this month` : "Click to change"}
                      onClick={() => {
                        if (l.auto || l.locked) return;
                        if (l.thisRows.length === 0) { setBatchSeed({ city: l.city ?? "Company-wide", category: l.category, vendor: l.vendor ?? "", month: monthKey }); setBatchOpen(true); return; }
                        if (l.thisRows.length > 1) { setMulti(l); return; }
                        if (editable) { setEditErr(null); setEditVal(String(single!.amount)); setEditKey(l.key); }
                      }}>
                      {(l.auto || l.locked) && <Lock size={10} aria-hidden />}{l.thisRows.length ? money(l.thisAmount) : l.auto || l.locked ? "—" : "+ add"}
                    </button>
                  )}
                  {editErr?.key === l.key && <small className="err">{editErr.text}</small>}
                </span>
                <span className="act">
                  {editable && (
                    <>
                      <button type="button" className="mn" aria-label="More" onClick={() => setMenuKey((k) => (k === l.key ? null : l.key))}><MoreHorizontal size={14} aria-hidden /></button>
                      {menuKey === l.key && (
                        <span className="menu">
                          <button type="button" onClick={() => openEdit(single!)}><Pencil size={12} aria-hidden /> Edit date, notes…</button>
                          <button type="button" className="del" onClick={() => { setMenuKey(null); setDeleteRow(single!); }}><Trash2 size={12} aria-hidden /> Delete {mon.slice(0, 3)}</button>
                        </span>
                      )}
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </section>
      ))}

      <BatchExpenseDrawer
        open={batchOpen}
        quarter={quarter}
        expenses={allRows}
        cities={CITY_DISPLAY}
        categories={addableCats}
        appUser={appUser}
        seed={batchSeed}
        onClose={() => setBatchOpen(false)}
        onDone={refetchFinanceData}
      />

      {multi && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-deep-green/40 p-4" onClick={() => setMulti(null)}>
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-cream-line px-5 py-4">
              <div>
                <div className="text-sm font-black text-deep-green">{multi.label}</div>
                <div className="text-xs text-deep-green/55">{multi.city ?? "Company-wide"} · {multi.category} · {monthKey} · {multi.thisRows.length} rows</div>
              </div>
              <button type="button" onClick={() => setMulti(null)} className="text-2xl leading-none text-deep-green/50 hover:text-deep-green" aria-label="Close">×</button>
            </div>
            <div className="max-h-[320px] divide-y divide-cream-line/60 overflow-auto">
              {multi.thisRows.map((row) => (
                <div key={row.id} className="flex items-center gap-3 px-5 py-3 text-xs">
                  <span className="font-mono tabular-nums text-deep-green">{row.date}</span>
                  <span className="flex-1 truncate text-deep-green/55">{row.notes ?? ""}</span>
                  <span className="font-mono font-bold tabular-nums text-coral">{money(row.amount)}</span>
                  {row.manual_entry ? (
                    <span className="flex gap-1">
                      <button type="button" onClick={() => { setMulti(null); openEdit(row); }} className="rounded-full p-1 text-deep-green/60 hover:bg-cream-soft hover:text-deep-green" aria-label="Edit row"><Pencil size={13} aria-hidden /></button>
                      <button type="button" onClick={() => { setMulti(null); setDeleteRow(row); }} className="rounded-full p-1 text-coral/70 hover:bg-coral-soft/50 hover:text-coral" aria-label="Delete row"><Trash2 size={13} aria-hidden /></button>
                    </span>
                  ) : (
                    <span title="Imported — read-only" className="text-deep-green/30"><Lock size={12} aria-hidden /></span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <ExpenseRowEditor
        open={editorOpen}
        mode="edit"
        initial={editorRow}
        knownCategories={addableCats}
        onClose={() => setEditorOpen(false)}
        onSubmit={handleSubmit}
        onDelete={(row) => { setEditorOpen(false); setDeleteRow(row); }}
      />

      <ConfirmDeleteDialog
        open={Boolean(deleteRow)}
        title={
          deleteRow
            ? `Delete ${deleteRow.category} — ${fmtMoney(deleteRow.amount, true)} — ${deleteRow.month || deleteRow.date}?`
            : "Delete this expense entry?"
        }
        summary={
          deleteRow ? (
            <div className="space-y-2 text-xs">
              <div className="space-y-1 font-mono">
                <div>
                  <span className="text-deep-green/55">Line item </span>
                  <span className="font-bold">
                    {deleteRow.city || "Company-wide"} · {deleteRow.category}
                    {deleteRow.vendor ? ` · ${deleteRow.vendor}` : ""}
                  </span>
                </div>
                <div>
                  <span className="text-deep-green/55">Month </span>
                  <span className="font-bold">{deleteRow.month || monthOf(deleteRow.date)}</span>
                  <span className="text-deep-green/55"> (dated {deleteRow.date})</span>
                </div>
                <div className="font-bold text-coral">
                  Amount {fmtMoney(deleteRow.amount, true)}
                </div>
                {deleteRow.notes && (
                  <div className="text-deep-green/55">{deleteRow.notes}</div>
                )}
              </div>
              {/* SCOPE, SAID OUT LOUD. fin_expenses has no recurrence column — a recurring cost is
                  stored as one row per month, so this removes THIS month and nothing else. Someone
                  who believes they are cancelling a subscription needs to know that. */}
              <div className="rounded-md border border-cream-line bg-cream-soft/60 px-3 py-2 leading-relaxed text-deep-green/70">
                This removes <span className="font-bold">one month only</span> —{" "}
                {deleteRow.month || monthOf(deleteRow.date)}. If{" "}
                {deleteRow.category} recurs, every other month is stored as its own entry and stays.
                {otherMonthsOf(deleteRow, allRows) > 0 && (
                  <>
                    {" "}
                    <span className="font-bold">
                      {otherMonthsOf(deleteRow, allRows)} other month
                      {otherMonthsOf(deleteRow, allRows) === 1 ? "" : "s"}
                    </span>{" "}
                    of this line item will remain.
                  </>
                )}
              </div>
            </div>
          ) : null
        }
        onCancel={() => setDeleteRow(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

const CSS = `
.xp{--line:#e3e7e1;--ink:#10231a;--ink-2:#44564c;--muted:#7a8a81;display:grid;gap:12px;color:var(--ink)}
.xp>*{min-width:0}
.xp-top{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.xp-top h1{margin:0;font-size:28px;font-weight:800;text-transform:uppercase}
.xp-nav{display:inline-flex;align-items:center;gap:6px}
.xp-nav .mo{font-weight:800;font-size:18px}
.xp-nav .arw{border:1px solid var(--line);background:#fff;border-radius:8px;width:28px;height:28px;font:inherit;font-size:16px;line-height:1;cursor:pointer;color:var(--ink-2)}
.xp-nav .tm{font-size:12.5px;font-weight:700;color:var(--ink-2);text-decoration:underline;cursor:pointer;margin-left:4px}
.xp .sp{flex:1}
.xp-city{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
.xp-city select{font:inherit;font-size:13px;text-transform:none;letter-spacing:0;font-weight:600;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:4px 8px;background:#fff}
.xp-band{background:#0f2a1e;color:#fff;border-radius:14px;padding:14px 16px;display:grid;gap:10px}
.xp-tot{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.xp-tot .k{font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:#a9bdb1;font-weight:700}
.xp-tot .big{font-size:30px;font-weight:800;letter-spacing:-.4px;font-variant-numeric:tabular-nums}
.xp-tot .sh{font-size:13px;color:#d6e4dc;font-weight:700}
.xp-tot .note{font-size:11.5px;color:#a9bdb1;font-style:italic}
.xp-bar{display:flex;height:6px;border-radius:999px;overflow:hidden;background:#24402f}
.xp-bar i{display:block;height:100%}
.xp-bubbles{display:flex;flex-wrap:wrap;gap:6px}
.xp-bubbles .bub{display:inline-flex;align-items:center;gap:6px;border:1px solid #2c4a3a;background:#173526;color:#fff;border-radius:999px;padding:4px 11px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
.xp-bubbles .bub b{font-variant-numeric:tabular-nums}
.xp-bubbles .bub .dot{width:8px;height:8px;border-radius:2px;display:inline-block}
.xp-bubbles .bub[aria-pressed="true"]{background:#fff;color:var(--ink);border-color:#fff}
.xp-bubbles .bub[data-faded]{opacity:.38}
.xp-add{display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:#e9f7ee;border:1px solid #c9ead5;border-radius:12px;padding:10px 12px}
.xp-add input,.xp-add select{font:inherit;font-size:13.5px;border:1px solid #c9d8cd;border-radius:8px;padding:6px 8px;background:#fff;color:var(--ink)}
.xp-add .w{flex:1;min-width:180px}
.xp-add .amt{display:inline-flex;align-items:center;gap:3px;font-weight:700}.xp-add .amt input{width:96px}
.xp-add .day{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:var(--ink-2)}.xp-add .day input{width:150px}
.xp-add .go{border:0;background:#22c55e;color:#06301d;font:inherit;font-weight:800;font-size:13px;padding:7px 16px;border-radius:9px;cursor:pointer}
.xp-add .go:disabled{opacity:.6;cursor:default}
.xp-add .more{font-size:12px;font-weight:700;color:var(--ink-2);text-decoration:underline;cursor:pointer}
.xp-add .msg{flex-basis:100%;font-size:12.5px;color:#15532d;font-weight:600}.xp-add .msg.bad{color:#b42318}
.xp-add .hint{flex-basis:100%;font-size:11.5px;color:var(--muted)}
.xp-card{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:visible}
.xp-empty{padding:28px;text-align:center;color:var(--muted)}
.xp-card .ch{display:grid;grid-template-columns:minmax(0,1fr) 110px 190px 34px;align-items:end;gap:10px;padding:11px 16px;border-bottom:1px solid #eef1ec}
.xp-card .ch .cn{display:flex;align-items:center;gap:8px;min-width:0;align-self:center}
.xp-card .ch .mc{display:flex;flex-direction:column;align-items:flex-end;font-variant-numeric:tabular-nums}
.xp-card .ch .mc small{font-size:10px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.xp-card .ch .mc b{font-size:13px;color:var(--ink-2)}
.xp-card .ch .dot{width:10px;height:10px;border-radius:3px;display:inline-block}
.xp-card .ch .ct{font-variant-numeric:tabular-nums;font-size:15px}
.xp-card .ch .lnk{font-size:12px;font-weight:700;color:#1a7f4b;text-decoration:underline}
.xp .ln{display:grid;grid-template-columns:minmax(0,1fr) 110px 190px 34px;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid #f3f5f2}
.xp .ln:last-child{border-bottom:0}
.xp .ln .nm b{display:block;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xp .ln .nm small{display:block;font-size:11.5px;color:var(--muted)}
.xp .atag{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#7a4e06;background:#fde9bf;border-radius:4px;padding:0 4px;margin-right:5px;vertical-align:1px}
.xp .ln .last{font-size:12px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.xp .ln .cur{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.xp .pill{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:3px 11px;font:inherit;font-size:13px;font-weight:800;font-variant-numeric:tabular-nums;cursor:pointer;border:1px solid transparent}
.xp .pill.same{background:#dff5e6;color:#15803d}
.xp .pill.gap{background:#fff;border:1px dashed #cfd6d1;color:var(--muted);font-weight:700}
.xp .pill.ro{cursor:default}
.xp .pill-in{width:110px;text-align:right;font:inherit;font-size:13px;font-weight:700;border:1px solid #15803d;border-radius:999px;padding:3px 10px}
.xp-add .sim{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:#7a4e06}
.xp-add .sim button{border:1px solid #c9d8cd;background:#fff;border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;font-weight:700;color:var(--ink);cursor:pointer}
.xp .err{font-size:11px;color:#b42318;font-weight:700}
.xp .act{position:relative;text-align:right}
.xp .mn{border:0;background:transparent;color:var(--muted);cursor:pointer;padding:2px;border-radius:6px}.xp .mn:hover{background:#f3f5f2;color:var(--ink)}
.xp .menu{position:absolute;right:0;top:24px;z-index:20;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);display:grid;min-width:170px;padding:4px}
.xp .menu button{display:flex;align-items:center;gap:6px;border:0;background:transparent;font:inherit;font-size:12.5px;padding:7px 10px;border-radius:7px;cursor:pointer;text-align:left;color:var(--ink)}
.xp .menu button:hover{background:#f3f5f2}.xp .menu .del{color:#b42318}
@media (max-width:760px){.xp .ln,.xp-card .ch{grid-template-columns:minmax(0,1fr) 78px 104px 26px;gap:6px}}
`;
