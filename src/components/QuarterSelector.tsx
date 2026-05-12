"use client";

// Compact quarter-picker dropdown. Shared by /finance and /clubhouse;
// styling mirrors the small pill controls (cream-line border, ALL
// CAPS label). Renders " · Planning" suffix on any quarter whose
// start is strictly after `now` so the operator can see at a glance
// which option is the forward-planning slot.

import { isPlanningQuarter, type QuarterInfo } from "@/lib/quarters";

export default function QuarterSelector({
  available,
  value,
  onChange,
  now,
}: {
  available: QuarterInfo[];
  value: string;
  onChange: (key: string) => void;
  now: Date;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
      <span aria-hidden>Quarter</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-full border border-cream-line bg-white px-3 py-1.5 text-[12px] font-bold tracking-[0.05em] text-deep-green shadow-sm transition hover:border-deep-green/40 focus:border-deep-green focus:outline-none"
        aria-label="Select quarter"
      >
        {available.map((q) => (
          <option key={q.key} value={q.key}>
            {q.label}
            {isPlanningQuarter(q, now) ? " · Planning" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
