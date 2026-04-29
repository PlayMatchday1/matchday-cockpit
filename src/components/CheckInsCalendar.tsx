"use client";

import { daysInMonth, formatMoney, MANAGERS } from "@/lib/checkIns";

// 31-cell-per-row payment calendar. One row per manager. Each
// manager's pay-day cell is filled in mint with the amount label
// floating above; today's cell gets a coral dashed outline matching
// the in-progress treatment used in TotalsBarChart.
export default function CheckInsCalendar() {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const days = daysInMonth(year, month);
  const todayDay = today.getDate();

  return (
    <div className="overflow-x-auto rounded-2xl border-[1.5px] border-cream-line bg-white p-4 shadow-md shadow-deep-green/10 sm:p-6">
      <div className="min-w-[760px]">
        {/* Day labels */}
        <div className="grid grid-cols-[140px_repeat(31,minmax(0,1fr))] gap-[2px]">
          <div />
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
            <div
              key={d}
              className={`pb-1 pt-1 text-center font-mono text-[9px] uppercase tracking-wider ${
                d > days
                  ? "text-deep-green/20"
                  : d === todayDay
                    ? "font-bold text-mint-hover"
                    : "text-deep-green/45"
              }`}
            >
              {d <= days ? d : ""}
            </div>
          ))}
        </div>

        {/* Manager rows */}
        {MANAGERS.map((m, mi) => {
          const paydayCol = Math.min(m.payDay, days);
          return (
            <div
              key={m.name}
              className={`grid grid-cols-[140px_repeat(31,minmax(0,1fr))] items-center gap-[2px] border-t py-1.5 ${
                mi === 0 ? "border-cream-line" : "border-cream-line/60"
              }`}
            >
              <div className="pr-3">
                <div className="text-[13px] font-bold text-deep-green">
                  {m.name}
                </div>
                <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
                  {m.city}
                </div>
              </div>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => {
                if (d > days) {
                  return <div key={d} className="invisible h-7" />;
                }
                const isPayday = d === paydayCol;
                const isToday = d === todayDay;
                return (
                  <div
                    key={d}
                    className={`flex h-7 items-center justify-center overflow-hidden rounded-[3px] ${
                      isPayday
                        ? "bg-mint shadow-[0_0_10px_rgba(44,219,135,0.45)]"
                        : "bg-cream-soft"
                    } ${
                      isToday ? "outline outline-1 outline-offset-1 outline-dashed outline-coral" : ""
                    }`}
                    title={isPayday ? `${m.name} · ${formatMoney(m.amount)}` : undefined}
                  >
                    {isPayday && (
                      <span className="text-[10px] font-bold tabular-nums leading-none text-deep-green">
                        {formatMoney(m.amount)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Legend */}
        <div className="mt-8 flex flex-wrap items-center gap-5 border-t border-cream-line/60 pt-3 font-mono text-[10px] uppercase tracking-wider text-deep-green/55">
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-[2px] bg-mint" />
            Payday
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-[2px] outline outline-1 outline-dashed outline-coral" />
            Today
          </div>
        </div>
      </div>
    </div>
  );
}
