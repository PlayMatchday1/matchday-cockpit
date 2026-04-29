"use client";

import {
  daysUntil,
  formatMoney,
  formatMonthDay,
  getNextPayDate,
  MANAGERS,
  type Manager,
} from "@/lib/checkIns";

const IMMINENT_THRESHOLD_DAYS = 5;

type Card = {
  manager: Manager;
  nextDate: Date;
  daysOut: number;
};

export default function CheckInsNextPayments() {
  const today = new Date();
  const cards: Card[] = MANAGERS.map((m) => {
    const nextDate = getNextPayDate(m.payDay, today);
    return {
      manager: m,
      nextDate,
      daysOut: daysUntil(nextDate, today),
    };
  }).sort((a, b) => a.nextDate.getTime() - b.nextDate.getTime());

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((c) => (
        <PaymentCard key={c.manager.name} card={c} />
      ))}
    </div>
  );
}

function PaymentCard({ card }: { card: Card }) {
  const { manager, nextDate, daysOut } = card;
  const imminent = daysOut <= IMMINENT_THRESHOLD_DAYS;
  const dayLabel =
    daysOut === 0
      ? "TODAY"
      : daysOut === 1
        ? "TOMORROW"
        : `IN ${daysOut} DAYS`;
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border-[1.5px] bg-white p-5 shadow-md shadow-deep-green/10 ${
        imminent ? "border-mint" : "border-cream-line"
      }`}
    >
      {imminent && (
        <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-mint" />
      )}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-bold text-deep-green">
            {manager.name}
          </div>
          <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
            {manager.city}
          </div>
        </div>
        <div className="font-mono text-sm font-bold tabular-nums text-mint-hover">
          {formatMoney(manager.amount)}
        </div>
      </div>
      <div className="mt-4 flex items-baseline gap-3 border-t border-dashed border-cream-line pt-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
            Next pay
          </div>
          <div className="mt-0.5 text-base font-bold text-deep-green">
            {formatMonthDay(nextDate)}
          </div>
        </div>
        <div
          className={`ml-auto font-mono text-[10px] font-bold uppercase tracking-wider ${
            imminent ? "text-coral" : "text-deep-green/55"
          }`}
        >
          {dayLabel}
        </div>
      </div>
    </div>
  );
}
