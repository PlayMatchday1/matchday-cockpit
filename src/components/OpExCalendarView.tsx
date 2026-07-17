"use client";

// OpEx Calendar — cash-outflow calendar on a 31-column date grid, in the
// Payment Calendar visual language (mint pill = scheduled payment, coral
// dashed outline = today). Rows group by category then subcategory. City
// Manager Pay is derived read-only from the checkIns roster; all other
// categories are user-editable via the entry modal. Phase 1.

import { useMemo, useState } from "react";
import { daysInMonth } from "@/lib/checkIns";
import { useAuth } from "@/lib/useAuth";
import { useOpexEntries } from "@/lib/useOpexEntries";
import {
  OPEX_CATEGORIES,
  cityManagerRows,
  entryRows,
  formatMoney,
  monthLabel,
  type OpexCategory,
  type OpexDraft,
  type OpexEntry,
  type OpexRow,
} from "@/lib/opex";
import OpExEntryModal from "./OpExEntryModal";

const GRID = "grid grid-cols-[180px_repeat(31,minmax(0,1fr))] gap-[2px]";

export default function OpExCalendarView() {
  const { appUser } = useAuth();
  const { entries, loading, error, create, update, remove } = useOpexEntries();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month0, setMonth0] = useState(now.getMonth());
  const [modal, setModal] = useState<{ entry: OpexEntry | null } | null>(null);

  const days = daysInMonth(year, month0);
  const isThisMonth =
    year === now.getFullYear() && month0 === now.getMonth();
  const todayDay = isThisMonth ? now.getDate() : -1;

  // Rows per category (city_manager derived; the rest from entries).
  const sections = useMemo(() => {
    return OPEX_CATEGORIES.map((cat) => {
      const rows: OpexRow[] =
        cat.key === "city_manager"
          ? cityManagerRows(year, month0)
          : entryRows(entries, cat.key, year, month0);
      const subtotal = rows.reduce(
        (s, r) => s + r.amount * r.days.length,
        0,
      );
      return { cat, rows, subtotal };
    });
  }, [entries, year, month0]);

  // Daily totals + cumulative across every row.
  const { daily, cumulative, monthTotal } = useMemo(() => {
    const daily = new Array<number>(days + 1).fill(0); // 1-indexed
    for (const s of sections) {
      for (const r of s.rows) {
        for (const d of r.days) daily[d] += r.amount;
      }
    }
    const cumulative = new Array<number>(days + 1).fill(0);
    let run = 0;
    for (let d = 1; d <= days; d++) {
      run += daily[d];
      cumulative[d] = run;
    }
    return { daily, cumulative, monthTotal: run };
  }, [sections, days]);

  const breakdown = useMemo(
    () =>
      sections
        .map((s) => ({
          key: s.cat.key,
          label: s.cat.label,
          amount: s.subtotal,
          pct: monthTotal > 0 ? (s.subtotal / monthTotal) * 100 : 0,
        }))
        .filter((b) => b.amount > 0),
    [sections, monthTotal],
  );

  function shiftMonth(delta: number) {
    const d = new Date(year, month0 + delta, 1);
    setYear(d.getFullYear());
    setMonth0(d.getMonth());
  }

  async function handleSave(id: string | null, draft: OpexDraft) {
    if (id) await update(id, draft);
    else await create(draft, appUser?.id ?? null);
  }

  const dayCols = Array.from({ length: 31 }, (_, i) => i + 1);

  return (
    <div>
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-deep-green">
            OpEx Calendar
          </h2>
          <p className="mt-0.5 text-sm text-deep-green/60">
            Cash outflow calendar · {monthLabel(year, month0)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <NavBtn onClick={() => shiftMonth(-1)}>‹ Prev</NavBtn>
            <NavBtn
              onClick={() => {
                setYear(now.getFullYear());
                setMonth0(now.getMonth());
              }}
            >
              Current
            </NavBtn>
            <NavBtn onClick={() => shiftMonth(1)}>Next ›</NavBtn>
          </div>
          <button
            type="button"
            onClick={() => setModal({ entry: null })}
            className="rounded-full bg-deep-green px-4 py-1.5 text-xs font-bold text-cream transition hover:bg-deep-green-soft"
          >
            + Add expense
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral-hover">
          Failed to load: {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border-[1.5px] border-cream-line bg-white p-4 shadow-md shadow-deep-green/10">
        <div className="min-w-[900px]">
          {/* Day-number header */}
          <div className={GRID}>
            <div />
            {dayCols.map((d) => (
              <div
                key={d}
                className={`pb-1 text-center font-mono text-[9px] uppercase tracking-wider ${
                  d > days
                    ? "text-deep-green/20"
                    : d === todayDay
                      ? "font-bold text-coral"
                      : "text-deep-green/45"
                }`}
              >
                {d <= days ? d : ""}
              </div>
            ))}
          </div>

          {/* Category sections */}
          {sections.map((s) => (
            <div key={s.cat.key} className="mt-3 first:mt-2">
              <div className="mb-1 flex items-center justify-between border-b border-cream-line px-1 pb-1">
                <span className="text-[11px] font-bold uppercase tracking-wider text-deep-green">
                  {s.cat.label}
                </span>
                <span className="font-mono text-xs font-bold tabular-nums text-deep-green/70">
                  {formatMoney(s.subtotal)}
                </span>
              </div>
              {s.rows.length === 0 ? (
                <p className="px-1 py-1 text-[11px] italic text-deep-green/35">
                  {s.cat.key === "city_manager"
                    ? "No managers on the roster."
                    : "No entries this month."}
                </p>
              ) : (
                s.rows.map((r) => (
                  <div key={r.key} className={`${GRID} items-center py-0.5`}>
                    <div className="truncate pr-2 text-[12px] font-semibold text-deep-green">
                      {r.label}
                      {!r.editable && (
                        <span className="ml-1 text-[9px] font-bold uppercase text-deep-green/35">
                          auto
                        </span>
                      )}
                    </div>
                    {dayCols.map((d) => {
                      if (d > days)
                        return <div key={d} className="invisible h-6" />;
                      const hit = r.days.includes(d);
                      const isToday = d === todayDay;
                      return (
                        <div
                          key={d}
                          onClick={
                            hit && r.editable && r.entryId
                              ? () => {
                                  const e = entries.find(
                                    (x) => x.id === r.entryId,
                                  );
                                  if (e) setModal({ entry: e });
                                }
                              : undefined
                          }
                          className={`flex h-6 items-center justify-center overflow-hidden rounded-[3px] ${
                            hit
                              ? `bg-mint shadow-[0_0_8px_rgba(44,219,135,0.4)] ${
                                  r.editable ? "cursor-pointer" : ""
                                }`
                              : "bg-cream-soft"
                          } ${
                            isToday
                              ? "outline outline-1 outline-offset-1 outline-dashed outline-coral"
                              : ""
                          }`}
                          title={
                            hit
                              ? `${r.label} · ${formatMoney(r.amount)}`
                              : undefined
                          }
                        >
                          {hit && (
                            <span className="px-0.5 text-[9px] font-bold tabular-nums leading-none text-deep-green">
                              {formatMoney(r.amount)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          ))}

          {/* Daily total + cumulative */}
          <TotalsRow
            label="Daily total"
            values={daily}
            days={days}
            todayDay={todayDay}
            strong
          />
          <TotalsRow
            label="Cumulative"
            values={cumulative}
            days={days}
            todayDay={todayDay}
          />
        </div>
      </div>

      {/* Month total + breakdown + legend */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        <div className="flex flex-col justify-center rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
          <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/50">
            Month total · {monthLabel(year, month0)}
          </div>
          <div className="mt-1 text-3xl font-extrabold tabular-nums text-deep-green">
            {formatMoney(monthTotal)}
          </div>
        </div>

        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
          <div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-deep-green/50">
            Category breakdown
          </div>
          {breakdown.length === 0 ? (
            <p className="text-sm italic text-deep-green/40">
              {loading ? "Loading…" : "No expenses this month."}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {breakdown.map((b) => (
                <div key={b.key} className="flex items-center gap-3 text-sm">
                  <span className="w-40 shrink-0 font-semibold text-deep-green">
                    {b.label}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-cream-soft">
                    <div
                      className="h-full rounded-full bg-mint"
                      style={{ width: `${b.pct}%` }}
                    />
                  </div>
                  <span className="w-14 text-right font-mono text-xs font-bold tabular-nums text-deep-green/70">
                    {Math.round(b.pct)}%
                  </span>
                  <span className="w-20 text-right font-mono text-xs font-bold tabular-nums text-deep-green">
                    {formatMoney(b.amount)}
                  </span>
                </div>
              ))}
              <div className="mt-2 flex items-center gap-3 border-t border-cream-line pt-2 text-sm">
                <span className="w-40 shrink-0 font-bold text-deep-green">
                  Total
                </span>
                <div className="flex-1" />
                <span className="w-14" />
                <span className="w-20 text-right font-mono text-sm font-extrabold tabular-nums text-deep-green">
                  {formatMoney(monthTotal)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-4 flex flex-wrap items-center gap-5 font-mono text-[10px] uppercase tracking-wider text-deep-green/55">
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-[2px] bg-mint" />
          Scheduled payment
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-[2px] outline outline-1 outline-dashed outline-coral" />
          Today
        </div>
        <div className="flex items-center gap-2">
          <span className="text-deep-green/35">auto</span>= derived from roster
          (read-only)
        </div>
      </div>

      {modal && (
        <OpExEntryModal
          entry={modal.entry}
          createdBy={appUser?.id ?? null}
          onSave={handleSave}
          onDelete={remove}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function NavBtn({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-cream-line bg-white px-3 py-1.5 text-xs font-bold text-deep-green/70 transition hover:bg-cream-soft"
    >
      {children}
    </button>
  );
}

function TotalsRow({
  label,
  values,
  days,
  todayDay,
  strong,
}: {
  label: string;
  values: number[];
  days: number;
  todayDay: number;
  strong?: boolean;
}) {
  const dayCols = Array.from({ length: 31 }, (_, i) => i + 1);
  return (
    <div
      className={`${GRID} mt-2 items-center border-t border-cream-line pt-1 ${
        strong ? "" : ""
      }`}
    >
      <div className="truncate pr-2 text-[11px] font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      {dayCols.map((d) => {
        if (d > days) return <div key={d} className="invisible h-5" />;
        const v = values[d] ?? 0;
        const isToday = d === todayDay;
        return (
          <div
            key={d}
            className={`flex h-5 items-center justify-center overflow-hidden rounded-[2px] ${
              isToday
                ? "outline outline-1 outline-offset-1 outline-dashed outline-coral"
                : ""
            }`}
          >
            {v > 0 && (
              <span
                className={`px-0.5 text-[8px] leading-none tabular-nums ${
                  strong
                    ? "font-bold text-deep-green"
                    : "font-medium text-deep-green/55"
                }`}
              >
                {formatMoney(v)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
