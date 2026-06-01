"use client";

import { monthLabelFromIso } from "@/lib/useMembershipSnapshots";

// Native <select> styled as a pill. Native keeps keyboard + mobile
// behavior correct for a list that grows to ~30 months without hand-
// rolling a listbox. Options are first-of-month ISO strings, newest
// first; the parent owns URL persistence.
export default function MembershipMonthSelector({
  selectedIso,
  monthOptions,
  onChange,
}: {
  selectedIso: string;
  monthOptions: string[];
  onChange: (iso: string) => void;
}) {
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">Select month</span>
      <select
        value={selectedIso}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-full bg-cream-soft py-1.5 pl-4 pr-9 text-sm font-bold text-deep-green ring-1 ring-cream-line transition hover:ring-mint-hover focus:outline-none focus:ring-2 focus:ring-mint-hover"
      >
        {monthOptions.map((iso) => (
          <option key={iso} value={iso}>
            {monthLabelFromIso(iso)}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="pointer-events-none absolute right-3 h-4 w-4 text-deep-green/55"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </label>
  );
}
