"use client";

// THE FINANCE RAIL — six items, flat, in the order the money is read: where it lands (Cities),
// what came in (Revenue), what it took to stage (Cost), what it does to the bank (Cash Flow),
// what runs regardless (OpEx), and which pitches earn their keep (Field Ranking).
//
// FLAT ON PURPOSE. `group: ""` on every item, so ChatsRail renders a bare list — six items in one
// section is a list, not an estate needing headings. Same arrangement as GROWTH_SECTIONS and
// CITY_SECTIONS.
//
// THIS IS NAV DATA ONLY. The rail component, its collapse and the mobile sheet are the app's own.
//
// WHAT IS NOT HERE. Configure, City Manager Check-Ins and Managers are not rail items — they are
// cross-cutting affordances reachable from every section, so they stay in the page frame where
// they were. Putting them in the rail would say they are peers of Cities and Revenue; they are not.

import type { RailItem } from "../../match-ops/sections";

function I({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const FINANCE_SECTIONS: RailItem[] = [
  {
    key: "fin-cities", group: "", label: "Cities", href: "/admin/finance/cities",
    desc: "Every city on one line, ranked by net",
    icon: <I><path d="M3 20h18" /><path d="M5 20V9l5-3.5V20" /><path d="M14 20V11l5 2.5V20" /><path d="M7.5 12.5v0M7.5 16v0" /></I>,
  },
  {
    key: "fin-revenue", group: "", label: "Revenue", href: "/admin/finance/revenue",
    desc: "What came in, by city, field and match",
    icon: <I><path d="M4 19V5" /><path d="M4 15l4.5-4.5 3.5 3.5L20 6" /><path d="M15.5 6H20v4.5" /></I>,
  },
  {
    key: "fin-cost", group: "", label: "Cost", href: "/admin/finance/cost",
    desc: "Field cost against the revenue it carried",
    icon: <I><path d="M3 20h18" /><path d="M6.5 20v-6" /><path d="M12 20V8" /><path d="M17.5 20v-9" /></I>,
  },
  {
    key: "fin-cash-flow", group: "", label: "Cash Flow", href: "/admin/finance/cash-flow",
    desc: "Month by month against starting cash",
    icon: <I><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><circle cx="12" cy="12" r="2.6" /><path d="M6 12h.01M18 12h.01" /></I>,
  },
  {
    key: "fin-opex", group: "", label: "OpEx", href: "/admin/finance/opex",
    desc: "When each recurring expense is billed",
    icon: <I><rect x="3.5" y="4.5" width="17" height="16" rx="2.5" /><path d="M3.5 9.5h17" /><path d="M8 3v3M16 3v3" /><path d="M8 13.5h3M8 17h3M14 13.5h2" /></I>,
  },
  {
    key: "fin-field-ranking", group: "", label: "Field Ranking", href: "/admin/finance/field-ranking",
    desc: "Which pitches carry their own cost",
    icon: <I><path d="M8 21h8" /><path d="M12 17v4" /><path d="M6 4h12v5a6 6 0 0 1-12 0z" /><path d="M6 5.5H3.5V7a3.5 3.5 0 0 0 3 3.4" /><path d="M18 5.5h2.5V7a3.5 3.5 0 0 1-3 3.4" /></I>,
  },
];
