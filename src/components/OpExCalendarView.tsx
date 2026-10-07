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
import { currentPeriod, stepPeriod } from "@/lib/financePeriod";
import type { AutoMatchPay } from "@/lib/opexAutoProjection";
import type { AutoMetaInfo } from "@/lib/opexSources";
import { META_BILLING_THRESHOLD_CENTS, META_DAILY_BUDGET, buildMetaCash, type DailySpend, type LoggedCharge } from "@/lib/metaCharges";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { isWeekendColumn, monthLayout, weekdayHeaders } from "@/lib/weekStart";
import {
  REPEAT_LABEL, deleteProjection, fetchProjections, insertProjection, skipProjectionDate, updateProjection,
  type OpexProjection, type ProjCat, type ProjRepeat, type ProjectionDraft,
} from "@/lib/opexProjections";

const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const budgetFrom = (b: { from: string } | null) => (b ? <span className="m"> · from {MON3[Number(b.from.slice(5, 7)) - 1]} {Number(b.from.slice(8, 10))}</span> : null);
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

/** Which kind of money a pill holds: real (""), a projection added by hand ("p"), or the automatic
 *  match manager pay projection ("a"). Each gets its own pill, never mixed. */
type PillKind = "" | "p" | "a";
const pillKindOf = (p: Payment): PillKind => (p.projected ? (p.projected.auto || p.projected.autoMeta ? "a" : "p") : "");
type Pop =
  | { id: string; x: number; y: number; kind: "how" }
  | { id: string; x: number; y: number; kind: "pill"; day: number; cat: CatKey; pk: PillKind }
  | { id: string; x: number; y: number; kind: "auto"; auto: AutoMatchPay; day: number | null }
  | { id: string; x: number; y: number; kind: "autometa"; info: AutoMetaInfo; day: number | null; amount: number }
  | null;

/* THE PROJECTION FORM. `occurrence` is the payment it was opened from (a day on the calendar or a
 * ledger row), so "remove this payment only" knows which date to drop. */
type ProjForm = {
  editing: OpexProjection | null;
  occurrence: string | null;
  draft: { category: ProjCat; description: string; amount: string; first_date: string; repeat: ProjRepeat; end_date: string };
  busy: boolean;
  error: string | null;
  confirmDelete: boolean;
} | null;

export default function OpExCalendarView() {
  const { data, error } = useFinanceData();
  const { period, now, setPeriod } = useFinancePeriod();
  const { appUser } = useAuth();
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

  /* ── PROJECTIONS: money that might leave, added by hand here and nowhere else ──────────────────
   * Loaded by this page only (src/lib/opexProjections.ts). "Show projections" (on by default, not
   * persisted) decides whether the builder gets them at all: off, it gets none, so every figure on
   * the page is exactly the build without this feature (scripts/opex-projections-test.ts). */
  const [projections, setProjections] = useState<OpexProjection[]>([]);
  const [projMissing, setProjMissing] = useState(false);
  const [projLoadError, setProjLoadError] = useState<string | null>(null);
  const [showProj, setShowProj] = useState(true);
  const [form, setForm] = useState<ProjForm>(null);
  const [projNote, setProjNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetchProjections().then((r) => {
      if (!live) return;
      setProjections(r.rows);
      setProjMissing(r.missing);
      setProjLoadError(r.error);
    });
    return () => { live = false; };
  }, []);

  /* ── META AD CHARGES (src/lib/metaCharges.ts) ─────────────────────────────────────────────────
   * Daily spend and Meta's logged charges, from /api/finance/meta-cash (finance only, read-only).
   * If they do not load, OpEx keeps the month-end Meta rows and says so — never neither, never both. */
  const [metaIn, setMetaIn] = useState<{ daily: DailySpend[]; logged: LoggedCharge[] } | null>(null);
  const [metaErr, setMetaErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        const r = await fetch("/api/finance/meta-cash", { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) { setMetaErr(String(j?.error ?? `HTTP ${r.status}`)); return; }
        setMetaIn({ daily: j.daily ?? [], logged: j.logged ?? [] });
      } catch (e) { if (live) setMetaErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { live = false; };
  }, []);
  const meta = useMemo(() => {
    if (!metaIn) return null;
    // The rest of this month and the next two: through the first day of the month after, Central.
    const horizonEndMs = new Date(now.getFullYear(), now.getMonth() + 3, 1).getTime();
    return buildMetaCash({ daily: metaIn.daily, logged: metaIn.logged, now, horizonEndMs, budget: META_DAILY_BUDGET });
  }, [metaIn, now]);

  const cal = useMemo(
    () => buildOpexCalendarAsOf(data, year, month0, now, showProj ? projections : [], showProj, meta, META_DAILY_BUDGET),
    [data, year, month0, now, showProj, projections, meta],
  );
  const all = useMemo(() => paymentsOf(cal), [cal]);
  const shown = useMemo(() => all.filter((p) => solo == null || p.cat === solo), [all, solo]);

  // The header is the WHOLE month whatever is filtered (Ryan: "The header month total never changes").
  // THREE FIGURES THAT ADD UP TO IT: paid, expected (from real records, not yet paid) and projected.
  const monthTotal = sumOf(all);
  const paid = sumOf(all.filter((p) => p.paid));
  const projected = sumOf(all.filter((p) => p.projected));
  const expected = Math.round((monthTotal - paid - projected) * 100) / 100;
  const paidPct = monthTotal > 0 ? (paid / monthTotal) * 100 : 0;
  const noDay = all.filter((p) => p.day == null);

  const today = cal.state === "current" ? now.getDate() : -1;
  const isPast = (d: number) => (cal.state === "past" ? true : cal.state === "current" ? d < today : false);

  // ── the calendar's cells, SUNDAY first, as the Master Schedule lays them out (src/lib/weekStart) ──
  const layout = monthLayout(year, month0);
  const lead = layout.lead;
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
  /* One pill per category per day — and a SEPARATE pill for that category's projections, so a
   * projection never shares a solid or dashed pill with real money. */
  const pillsOf = (d: number) => {
    const g = new Map<string, { cat: CatKey; pk: PillKind; proj: boolean; ps: Payment[] }>();
    for (const p of byDay.get(d) ?? []) {
      const pk = pillKindOf(p);
      const k = `${p.cat}:${pk}`;
      const e = g.get(k) ?? { cat: p.cat, pk, proj: pk !== "", ps: [] };
      e.ps.push(p);
      g.set(k, e);
    }
    return [...g.values()].map((e) => ({ ...e, total: sumOf(e.ps) })).sort((a, b) => Number(a.proj) - Number(b.proj) || b.total - a.total);
  };

  // ── the ledger ────────────────────────────────────────────────────────────────────────────────
  const weekOf = layout.weekOf;
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

  const popPayments = pop?.kind === "pill" ? all.filter((p) => p.day === pop.day && p.cat === pop.cat && pillKindOf(p) === pop.pk).sort((a, b) => b.amount - a.amount) : [];

  /* ── THE PROJECTION FORM ───────────────────────────────────────────────────────────────────── */
  const iso = (d: number) => `${year}-${String(month0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const openNew = (d: number | null) => {
    setPop(null);
    setForm({
      editing: null, occurrence: null, busy: false, error: null, confirmDelete: false,
      draft: { category: solo ?? "misc", description: "", amount: "", first_date: iso(d ?? (cal.state === "current" ? now.getDate() : 1)), repeat: "once", end_date: "" },
    });
  };
  const openEdit = (id: number, occurrence: string | null) => {
    const p = projections.find((x) => x.id === id);
    if (!p) return;
    setPop(null);
    setForm({
      editing: p, occurrence, busy: false, error: null, confirmDelete: false,
      draft: { category: p.category, description: p.description, amount: String(p.amount), first_date: p.first_date, repeat: p.repeat, end_date: p.end_date ?? "" },
    });
  };
  const draftOf = (f: NonNullable<ProjForm>): ProjectionDraft => ({
    category: f.draft.category,
    description: f.draft.description,
    amount: Number(f.draft.amount),
    first_date: f.draft.first_date,
    repeat: f.draft.repeat,
    end_date: f.draft.end_date || null,
  });
  /* ONE REQUEST PER CLICK. busy disables the buttons until it answers; nothing retries. The list is
   * updated from what the server returned, never from what was typed. */
  const runForm = async (op: "save" | "skip" | "delete") => {
    if (!form || form.busy) return;
    const by = appUser?.email;
    if (!by) { setForm({ ...form, error: "Not signed in." }); return; }
    setForm({ ...form, busy: true, error: null });
    const r =
      op === "save" ? (form.editing ? await updateProjection(form.editing, draftOf(form), by) : await insertProjection(draftOf(form), by))
      : op === "skip" ? await skipProjectionDate(form.editing!, form.occurrence!, by)
      : await deleteProjection(form.editing!, by);
    if (!r.ok) { setForm((f) => (f ? { ...f, busy: false, error: r.error } : f)); return; }
    if (op === "delete") setProjections((ps) => ps.filter((x) => x.id !== form.editing!.id));
    else if (r.row) setProjections((ps) => (ps.some((x) => x.id === r.row!.id) ? ps.map((x) => (x.id === r.row!.id ? r.row! : x)) : [...ps, r.row!]));
    if (r.row || op === "delete") setProjMissing(false);
    setProjNote(r.warning ?? null);
    setForm(null);
  };

  let run = 0;
  const ledgerBody: React.ReactNode[] = [];
  const pushRow = (p: Payment) => {
    run += p.amount;
    const sub = subLabel(p);
    ledgerBody.push(
      <tr key={p.key} data-testid="ledger-row" data-day={p.day ?? ""} data-cat={p.cat} data-proj={p.projected ? p.projected.id : undefined}
        className={[dayFilter != null && p.day === dayFilter ? "hl" : "", p.projected ? "prjrow" : ""].filter(Boolean).join(" ") || undefined}
        onClick={p.projected
          ? (e) => (p.projected!.auto
            ? setPop({ ...place(`auto:${p.key}`, e.currentTarget), kind: "auto", auto: p.projected!.auto, day: p.day })
            : p.projected!.autoMeta
              ? setPop({ ...place(`autometa:${p.key}`, e.currentTarget), kind: "autometa", info: p.projected!.autoMeta, day: p.day, amount: p.amount })
              : openEdit(p.projected!.id, p.day != null ? iso(p.day) : null))
          : undefined}
        title={p.projected ? (p.projected.auto || p.projected.autoMeta ? "Calculated: click to see how" : "A projection: click to change or remove it") : undefined}>
        <td>{p.day == null ? "—" : `${mon} ${p.day}`}</td>
        <td>{p.projected && <span className="ptag">proj</span>}<b>{p.payee}</b></td>
        <td className="cat"><span className="sw" style={{ background: CAT_BY_KEY[p.cat].col }} />{CAT_BY_KEY[p.cat].name}{sub ? ` · ${sub}` : ""}</td>
        <td className="city">{p.city || "—"}</td>
        <td>{p.projected ? <span className="st prj">Projected</span> : <span className={`st ${p.paid ? "paid" : "proj"}`}>{p.paid ? "Paid" : "Expected"}</span>}</td>
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

      {/* THE PAGE'S OWN HEADER (Ryan, 2026-10-03): the shell leaves out the FINANCE title and the
          period bar here (src/lib/financeChrome.ts). OpEx is always one month, stepped by the arrows,
          through the same period state, so ?p= in the URL and the data window follow it. */}
      <div className="top">
        <h1 className="font-display">OpEx</h1>
        <span className="mnav" data-testid="month-nav">
          <button type="button" className="arw" data-testid="month-prev" aria-label="Previous month"
            onClick={() => setPeriod(stepPeriod(period, -1, now))}>‹</button>
          <span className="month" data-testid="month">{monthLabel(year, month0)}</span>
          <button type="button" className="arw" data-testid="month-next" aria-label="Next month"
            onClick={() => setPeriod(stepPeriod(period, 1, now))}>›</button>
          {cal.state !== "current" && (
            <a className="tm" role="button" tabIndex={0} data-testid="this-month"
              onClick={() => setPeriod(currentPeriod("month", now))}
              onKeyDown={(e) => { if (e.key === "Enter") setPeriod(currentPeriod("month", now)); }}>This month</a>
          )}
        </span>
        <span className="sp" />
        <button type="button" className="ox-addp" data-testid="add-projection" onClick={() => openNew(null)}>+ Add projection</button>
        <div className="seg" data-testid="view-seg">
          <button type="button" aria-pressed={view === "cal"} onClick={() => setView("cal")}>Calendar</button>
          <button type="button" aria-pressed={view === "ledger"} onClick={() => setView("ledger")}>Ledger only</button>
        </div>
      </div>

      {error && <div className="ox-err">Failed to load finance data: {error}</div>}

      {/* ── ONE COMPACT BAR, ~90px (Ryan, 2026-10-02), in the Master Schedule header's manner ──
          Left: the month's cash out on one line, the paid bar and paid / still to go under it.
          Right: the six chips in one row and, only when there is any, the no-day line. The helper
          sentence lives in the i. "Show all" appears only while a category is selected — it is the
          reset the chips' second click also gives, and costs no room when nothing is filtered. */}
      <section className="card hdr" data-testid="summary">
        <div className="l">
          <div className="tl">
            <span className="k">Cash out · {monthLabel(year, month0)}</span>
            <b className="big" data-testid="sum-month">{fmt(monthTotal)}</b>
          </div>
          <div className="bar" data-testid="paid-bar"><i style={{ width: `${paidPct.toFixed(1)}%` }} /></div>
          <div className="pl"><b data-testid="sum-paid">{fmt(paid)}</b> paid · <b data-testid="sum-expected">{fmt(expected)}</b> expected · <b data-testid="sum-projected" className="pj">{fmt(projected)}</b> projected{" "}
            {/* THE i SITS HERE, after the paid line, so the chip row has the header's full width. */}
            <button type="button" className="i" data-pop="how" aria-label="How this page works" aria-expanded={pop?.kind === "how"}
              onClick={(e) => (pop?.kind === "how" ? setPop(null) : setPop({ ...place("how", e.currentTarget), kind: "how" }))}>i</button>
          </div>
          {/* SMALL ON PURPOSE: a checkbox and a label, not a segmented control (Ryan). */}
          <label className="shp" data-testid="show-projections-label">
            <input type="checkbox" data-testid="show-projections" checked={showProj} onChange={(e) => setShowProj(e.target.checked)} />
            Show projections
          </label>
          {metaErr && (
            <div className="pjnote" data-testid="meta-status">Meta charges did not load ({metaErr}). Ad spend shows as one month-end amount instead.</div>
          )}
          {meta?.threshold.changed && (
            <div className="pjnote" data-testid="meta-threshold-changed">
              Meta&rsquo;s billing threshold looks like {fmt(meta.threshold.inUse / 100)} now (its last two charges), not the {fmt(META_BILLING_THRESHOLD_CENTS / 100)} on file. Using {fmt(meta.threshold.inUse / 100)}.
            </div>
          )}
          {(projMissing || projLoadError || projNote) && (
            <div className="pjnote" data-testid="projection-status">
              {projMissing ? "Projections are not saved yet: the table does not exist (migration 0202)." : projLoadError ? `Projections did not load: ${projLoadError}` : projNote}
            </div>
          )}
        </div>
        <div className="r">
          <div className="chiprow">
            <div className="chips" id="chips">
              {CATS.map((c) => {
                const t = chipTotal(c.key);
                const share = monthTotal > 0 ? Math.round((t / monthTotal) * 100) : 0;
                /* ONE ROW AT 1440 (Ryan, 2026-10-02): the chip shows WHOLE dollars and the pills'
                   short label ("Fields"); the exact amount and the share are in the hover text,
                   and the exact amount is data-total, so nothing that adds up reads a rounded figure. */
                return (
                  <button key={c.key} type="button" className="chip" data-cat={c.key} data-testid={`chip-${c.key}`} data-total={t}
                    aria-pressed={solo == null || solo === c.key} onClick={() => clickChip(c.key)}
                    title={`${c.name} · ${fmt(t)} · ${share}% of the month`}>
                    <span className="sw" style={{ background: c.col }} />{c.short} <b>{fmt(Math.round(t))}</b>
                  </button>
                );
              })}
            </div>
            {solo != null && (
              <a id="all" className="all" role="button" tabIndex={0} onClick={() => { setPop(null); setSolo(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") setSolo(null); }}>Show all</a>
            )}
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
          <div className="wk h">{weekdayHeaders().map((h, i) => <div key={h} className={isWeekendColumn(i) ? "we" : undefined}>{h}</div>)}</div>
          {weeks.map((row, w) => {
            const wt = sumOf(row.flatMap((c) => (c.d == null ? [] : byDay.get(c.d) ?? [])));
            return (
              <div key={w} className="wk" data-testid="week">
                {row.map((c, i) => {
                  const wkend = isWeekendColumn(i) ? " wkend" : "";
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
                      <div className="dh"><span className="n">{d}</span>
                        <button type="button" className="addd" data-testid={`add-${d}`} aria-label={`Add a projection on ${mon} ${d}`} title={`Add a projection on ${mon} ${d}`}
                          onClick={(e) => { e.stopPropagation(); openNew(d); }}>+</button>
                        <span className={`dt${t ? "" : " none"}`} data-total={t}>{t ? fmt(t) : "—"}</span></div>
                      {pills.map((x) => {
                        const id = `pill:${d}:${x.cat}:${x.pk}`;
                        // THREE STATES BY BORDER AND FILL: paid solid, expected dashed, projected dotted amber.
                        const cls = x.proj ? "prj" : d <= cal.paidThrough ? "paid" : "proj";
                        return (
                          <button key={`${x.cat}:${x.pk}`} type="button" className={`pay ${cls}`} data-day={d} data-cat={x.cat} data-proj={x.proj || undefined} data-auto={x.pk === "a" || undefined}
                            aria-expanded={pop?.id === id}
                            title={`${CAT_BY_KEY[x.cat].name} · ${x.ps.length} payment${x.ps.length > 1 ? "s" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (pop?.id === id) return setPop(null);
                              const auto = x.pk === "a" ? x.ps[0].projected?.auto : undefined;
                              const autoMeta = x.pk === "a" ? x.ps[0].projected?.autoMeta : undefined;
                              setPop(auto ? { ...place(id, e.currentTarget), kind: "auto", auto, day: d }
                                : autoMeta ? { ...place(id, e.currentTarget), kind: "autometa", info: autoMeta, day: d, amount: x.total }
                                : { ...place(id, e.currentTarget), kind: "pill", day: d, cat: x.cat, pk: x.pk });
                            }}>
                            <span className="sw" style={{ background: CAT_BY_KEY[x.cat].col }} />
                            <span className="nm">{x.proj && <span className="ptag">proj</span>}{CAT_BY_KEY[x.cat].short}{x.ps.length > 1 && <small> {x.ps.length}</small>}</span>
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

      {form && (
        <div className="pform-bg" onClick={() => !form.busy && setForm(null)}>
          <form className="pform" data-testid="projection-form" onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); void runForm("save"); }}>
            <div className="ph">{form.editing ? "Change projection" : "Add projection"}</div>
            <label>Category
              <select data-testid="pf-category" value={form.draft.category}
                onChange={(e) => setForm({ ...form, draft: { ...form.draft, category: e.target.value as ProjCat } })}>
                {CATS.map((c) => <option key={c.key} value={c.key}>{c.short}</option>)}
              </select>
            </label>
            <label>What it is
              <input data-testid="pf-description" value={form.draft.description} placeholder="A field we might open, a hire, a purchase"
                onChange={(e) => setForm({ ...form, draft: { ...form.draft, description: e.target.value } })} />
            </label>
            <label>Amount per payment
              <span className="amt">$<input data-testid="pf-amount" inputMode="decimal" value={form.draft.amount}
                onChange={(e) => setForm({ ...form, draft: { ...form.draft, amount: e.target.value } })} /></span>
            </label>
            <label>First pay date
              <input type="date" data-testid="pf-first" value={form.draft.first_date}
                onChange={(e) => setForm({ ...form, draft: { ...form.draft, first_date: e.target.value } })} />
            </label>
            <label>Repeats
              <select data-testid="pf-repeat" value={form.draft.repeat}
                onChange={(e) => setForm({ ...form, draft: { ...form.draft, repeat: e.target.value as ProjRepeat } })}>
                {(Object.keys(REPEAT_LABEL) as ProjRepeat[]).map((k) => <option key={k} value={k}>{REPEAT_LABEL[k]}</option>)}
              </select>
            </label>
            {form.draft.repeat !== "once" && (
              <label>End date <small>(optional)</small>
                <input type="date" data-testid="pf-end" value={form.draft.end_date}
                  onChange={(e) => setForm({ ...form, draft: { ...form.draft, end_date: e.target.value } })} />
              </label>
            )}
            {form.error && <div className="perr" data-testid="pf-error">{form.error}</div>}
            {form.confirmDelete ? (
              <div className="pdel" data-testid="pf-delete-choice">
                {form.editing!.repeat !== "once" && form.occurrence ? (
                  <>
                    <span>Remove which?</span>
                    <button type="button" disabled={form.busy} data-testid="pf-remove-one" onClick={() => void runForm("skip")}>
                      This payment only ({mon} {Number(form.occurrence.slice(8, 10))})
                    </button>
                    <button type="button" disabled={form.busy} data-testid="pf-remove-all" onClick={() => void runForm("delete")}>The whole series</button>
                  </>
                ) : (
                  <button type="button" disabled={form.busy} data-testid="pf-remove-all" onClick={() => void runForm("delete")}>Yes, remove it</button>
                )}
                <button type="button" className="lnk" disabled={form.busy} onClick={() => setForm({ ...form, confirmDelete: false })}>Keep it</button>
              </div>
            ) : (
              <div className="pbtns">
                {form.editing && (
                  <button type="button" className="danger" disabled={form.busy} data-testid="pf-remove"
                    onClick={() => setForm({ ...form, confirmDelete: true })}>Remove</button>
                )}
                <span className="sp" />
                <button type="button" className="lnk" disabled={form.busy} onClick={() => setForm(null)}>Cancel</button>
                <button type="submit" className="go" disabled={form.busy} data-testid="pf-save">{form.busy ? "Saving…" : "Save"}</button>
              </div>
            )}
          </form>
        </div>
      )}

      <div ref={popRef} className="pop" data-testid="popover" hidden={!pop} style={pop ? { left: pop.x, top: pop.y } : undefined}>
        {pop?.kind === "how" && (
          <>
            <div className="h">How this page works</div>
            Every payment MatchDay makes in the month, on the day the money leaves. Solid is paid. Dashed is
            expected: scheduled from real records, not yet paid. Dotted amber is a projection: money that
            might leave, never counted as paid, and every one says &ldquo;proj&rdquo;: ones you added by hand, match
            manager pay on a Tuesday with no real amount yet (the average of the last four closed weeks), and
            Meta ad charges from the daily ad budget.
            A projection drops off once its day is over. &ldquo;Show projections&rdquo; takes them all out of every
            figure on the page.
            <dl>
              {CATS.map((c) => (
                <span key={c.key} style={{ display: "contents" }}>
                  <dt><span className="swi" style={{ background: c.col }} />{c.name}</dt><dd>{c.how}</dd>
                </span>
              ))}
            </dl>
          </>
        )}
        {pop?.kind === "auto" && (
          <div data-testid="auto-basis">
            <div className="h">{pop.day != null ? `${mon} ${pop.day} · ` : ""}Match manager pay · {fmt(pop.auto.amount)}</div>
            <div className="sub">Projected automatically: the average of the last 4 weeks of match manager pay with a closed work week. The week in progress is not included. It is replaced by the real amount once the Manager Pay page has written that Tuesday.</div>
            <dl className="pp">
              {pop.auto.basis.map((w) => (
                <span key={w.tuesday} style={{ display: "contents" }}>
                  <dt>Paid {MON3[Number(w.tuesday.slice(5, 7)) - 1]} {Number(w.tuesday.slice(8, 10))} <span className="m">· week of {MON3[Number(w.weekStart.slice(5, 7)) - 1]} {Number(w.weekStart.slice(8, 10))}</span></dt>
                  <dd data-testid="auto-basis-week" data-total={w.total}>{fmt(w.total)}</dd>
                </span>
              ))}
              <dt><b>Average of {pop.auto.basis.length}</b></dt><dd data-testid="auto-basis-mean" data-total={pop.auto.amount}><b>{fmt(pop.auto.amount)}</b></dd>
            </dl>
          </div>
        )}
        {pop?.kind === "autometa" && (
          <div data-testid="auto-meta-basis">
            <div className="h">{pop.day != null ? `${mon} ${pop.day} · ` : ""}Meta ads · {fmt(pop.amount)}</div>
            {pop.info.restOfMonth ? (
              <>
                <div className="sub">Projected ad spend for the rest of the month: the daily budget times the days left. The Meta rows beside it are spend to date.</div>
                <dl className="pp">
                  <dt>Daily budget{budgetFrom(pop.info.budget)}</dt><dd data-testid="auto-meta-budget">{fmt((pop.info.budget?.cents ?? 0) / 100)}</dd>
                  <dt>Days left</dt><dd>{pop.info.restOfMonth.days}</dd>
                </dl>
              </>
            ) : (
              <>
                <div className="sub">Projected automatically from the daily ad budget, turned into card charges: one each time the unbilled balance would reach the billing threshold, and the rest on the bill date (the 6th). Charges already made are Meta&rsquo;s record.</div>
                <dl className="pp">
                  {pop.info.budget && <><dt>Daily budget{budgetFrom(pop.info.budget)}</dt><dd data-testid="auto-meta-budget">{fmt(pop.info.budget.cents / 100)}</dd></>}
                  {(!pop.info.budget || (pop.day != null && iso(pop.day) < pop.info.budget.from)) && (
                    <><dt>Daily average{pop.info.avgFrom && pop.info.avgTo ? <span className="m"> · {MON3[Number(pop.info.avgFrom.slice(5, 7)) - 1]} {Number(pop.info.avgFrom.slice(8, 10))} – {MON3[Number(pop.info.avgTo.slice(5, 7)) - 1]} {Number(pop.info.avgTo.slice(8, 10))}</span> : null}</dt>
                    <dd data-testid="auto-meta-avg" data-cents={pop.info.dailyAvgCents}>{fmt(pop.info.dailyAvgCents / 100)}</dd></>
                  )}
                  <dt>Billing threshold</dt><dd>{fmt(pop.info.thresholdCents / 100)}</dd>
                </dl>
              </>
            )}
          </div>
        )}
        {pop?.kind === "pill" && (
          <>
            <div className="h">{mon} {pop.day} · {CAT_BY_KEY[pop.cat].name} · {fmt(sumOf(popPayments))}</div>
            <div className="sub">{pop.pk === "p" ? "Projected, added by hand. Click one to change or remove it." : pop.day <= cal.paidThrough ? "Paid" : "Expected"}</div>
            <dl className="pp">
              {popPayments.map((p) => {
                const city = cityLabel(p), sub = subLabel(p);
                return (
                  <span key={p.key} style={{ display: "contents" }}>
                    <dt>{p.projected
                      ? <button type="button" className="pedit" onClick={() => openEdit(p.projected!.id, iso(pop.day))}>{p.payee}</button>
                      : p.payee}{city && <span className="m"> · {city}</span>}{sub && <span className="m"> · {sub}</span>}</dt>
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
.opex-v3 .mnav{display:inline-flex;align-items:center;gap:6px}
.opex-v3 .arw{border:1px solid var(--line);background:#fff;border-radius:8px;width:28px;height:28px;font:inherit;font-size:16px;line-height:1;cursor:pointer;color:var(--ink-2)}
.opex-v3 .arw:hover{background:#f4f7f4}
.opex-v3 .tm{font-size:12.5px;font-weight:700;color:var(--ink-2);text-decoration:underline;cursor:pointer;margin-left:4px}
.opex-v3 .ox-addp{border:1px dotted #c98a12;background:#fff7e6;color:#7a4e06;font-weight:700;font-size:13px;padding:6px 12px;border-radius:10px;cursor:pointer}
.opex-v3 .pl .pj{color:#8a5a12}
.opex-v3 .shp{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--ink-2);margin-top:4px;cursor:pointer}
.opex-v3 .shp input{margin:0}
.opex-v3 .pjnote{font-size:11.5px;color:#8a5a12;margin-top:3px}
.opex-v3 .addd{margin-left:auto;border:0;background:transparent;color:#b7c0ba;font:inherit;font-weight:800;font-size:14px;line-height:1;padding:0 2px;cursor:pointer;opacity:0}
.opex-v3 .day:hover .addd,.opex-v3 .addd:focus{opacity:1}.opex-v3 .addd:hover{color:#8a5a12}
.opex-v3 .pay.prj{background:#fff7e6;border:1px dotted #c98a12;color:#5b3d06}
.opex-v3 .ptag{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#7a4e06;background:#fde9bf;border-radius:4px;padding:0 4px;margin-right:4px;vertical-align:1px}
.opex-v3 .st.prj{background:#fff7e6;border:1px dotted #c98a12;color:#7a4e06}
.opex-v3 tr.prjrow{cursor:pointer}.opex-v3 tr.prjrow td{background:#fffbf2}
.opex-v3 .pedit{border:0;background:none;color:#fde9bf;font:inherit;text-decoration:underline;cursor:pointer;padding:0;text-align:left}
.opex-v3 .pform-bg{position:fixed;inset:0;z-index:70;background:rgba(16,35,26,.25);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}
.opex-v3 .pform{background:#fff;border-radius:14px;border:1px solid var(--line);box-shadow:0 20px 50px rgba(0,0,0,.2);padding:16px 18px;width:min(380px,calc(100vw - 32px));display:grid;gap:10px}
.opex-v3 .pform .ph{font-weight:800;font-size:15px}
.opex-v3 .pform label{display:grid;gap:4px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)}
.opex-v3 .pform label small{text-transform:none;letter-spacing:0;font-weight:500}
.opex-v3 .pform input,.opex-v3 .pform select{font:inherit;font-size:14px;text-transform:none;letter-spacing:0;font-weight:500;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:7px 9px;background:#fff}
.opex-v3 .pform .amt{display:flex;align-items:center;gap:4px;font-size:14px;color:var(--ink);text-transform:none;font-weight:600}.opex-v3 .pform .amt input{flex:1}
.opex-v3 .pform .perr{font-size:12.5px;color:#b42318;font-weight:600}
.opex-v3 .pbtns,.opex-v3 .pdel{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.opex-v3 .pdel span{font-size:12.5px;font-weight:700}
.opex-v3 .pform button{font:inherit;font-size:13px;font-weight:700;border-radius:9px;padding:7px 12px;cursor:pointer;border:1px solid var(--line);background:#fff;color:var(--ink-2)}
.opex-v3 .pform button.go{background:#22c55e;border-color:#22c55e;color:#06301d}
.opex-v3 .pform button.danger{color:#b42318}
.opex-v3 .pform button.lnk{border:0;background:none;text-decoration:underline}
.opex-v3 .pform button:disabled{opacity:.55;cursor:default}
.opex-v3 .sp{flex:1}
.opex-v3 .seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;background:#fff;padding:2px}
.opex-v3 .seg button{border:0;background:transparent;padding:6px 14px;border-radius:999px;font:inherit;font-weight:700;color:var(--muted);cursor:pointer}
.opex-v3 .seg button[aria-pressed="true"]{background:var(--nav);color:#fff}
.opex-v3 .ox-err{background:#fdecec;border:1px solid #e9a6a6;border-radius:11px;padding:10px 14px;font-size:12.5px;color:#9a3838}
.opex-v3 .ox-loading{padding:40px;text-align:center;color:var(--muted)}
.opex-v3 .ox-add{border:0;background:#22c55e;color:#06301d;font-weight:700;font-size:13px;padding:7px 13px;border-radius:10px}
.opex-v3 .card{background:#fff;border:1px solid var(--line);border-radius:14px}
.opex-v3 .hdr{display:flex;align-items:center;gap:22px;padding:12px 14px}
@media (max-width:900px){.opex-v3 .hdr{flex-direction:column;align-items:stretch;gap:10px}}
.opex-v3 .hdr .l{flex:none;max-width:100%}
.opex-v3 .tl{display:flex;align-items:baseline;gap:10px;white-space:nowrap}
.opex-v3 .k{font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:var(--muted);font-weight:700}
.opex-v3 .big{font-size:26px;font-weight:800;letter-spacing:-.4px;line-height:1.15;font-variant-numeric:tabular-nums}
.opex-v3 .bar{height:6px;border-radius:999px;background:#e6ebe7;overflow:hidden;margin-top:6px}.opex-v3 .bar i{display:block;height:100%;background:#22c55e}
.opex-v3 .pl{font-size:12px;color:var(--ink-2);margin-top:4px;white-space:nowrap;display:flex;align-items:center;gap:4px}.opex-v3 .pl b{color:var(--ink)}
.opex-v3 .hdr .r{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.opex-v3 .chiprow{display:flex;align-items:center;gap:8px;min-width:0}
.opex-v3 .chips{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px}
.opex-v3 .chip{flex:none;border:1px solid var(--line);background:#fff;border-radius:999px;padding:4px 10px;font:inherit;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:5px;color:var(--ink);white-space:nowrap}
.opex-v3 .chip .sw{width:8px;height:8px;border-radius:2px;display:inline-block;flex:none}
.opex-v3 .chip b{font-variant-numeric:tabular-nums}.opex-v3 .chip small{color:var(--muted);font-weight:600;font-size:11px}
.opex-v3 .chip[aria-pressed="false"]{color:#b7c0ba;background:#f7f9f6}.opex-v3 .chip[aria-pressed="false"] .sw{opacity:.3}
.opex-v3 .chip[aria-pressed="false"] b,.opex-v3 .chip[aria-pressed="false"] small{color:#b7c0ba}
.opex-v3 .all{font-size:12px;font-weight:700;color:var(--ink-2);text-decoration:underline;cursor:pointer;white-space:nowrap}
.opex-v3 .hint{font-size:12.5px;color:var(--muted)}
.opex-v3 .noday{font-size:12px;color:#8a5a12}
.opex-v3 .noday a{color:#8a5a12;text-decoration:underline;font-weight:700}
.opex-v3>*{min-width:0}
.opex-v3 .cal{overflow:hidden}
.opex-v3 .calx{overflow-x:auto}.opex-v3 .calin{min-width:840px}
.opex-v3 .wk{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}
.opex-v3 .wk.h div{padding:10px 12px;font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:var(--muted);font-weight:700;border-bottom:1px solid var(--line)}
.opex-v3 .wk.h div.we{background:#f7f9f6}
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
