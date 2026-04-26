"use client";

export type InsightTone = "working" | "attention" | "watch";

const STRIPE: Record<InsightTone, string> = {
  working: "bg-mint",
  attention: "bg-coral",
  watch: "bg-gold",
};

export default function FinanceInsightCard({
  tone,
  title,
  headline,
  subtitle,
  children,
  empty,
}: {
  tone: InsightTone;
  title: string;
  headline?: string;
  subtitle?: string;
  children?: React.ReactNode;
  empty?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-deep-green/20">
      <div className={`h-[3px] w-full ${STRIPE[tone]}`} aria-hidden />
      <div className="p-5">
        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
          {title}
        </div>
        {headline && (
          <div className="mt-2 font-display text-2xl uppercase leading-tight tracking-tight text-deep-green md:text-3xl">
            {headline}
          </div>
        )}
        {subtitle && (
          <div className="mt-1 text-xs text-deep-green/60">{subtitle}</div>
        )}
        {empty ? (
          <div className="mt-3 text-xs italic text-deep-green/45">
            No items this month.
          </div>
        ) : (
          children && <div className="mt-3">{children}</div>
        )}
      </div>
    </div>
  );
}
