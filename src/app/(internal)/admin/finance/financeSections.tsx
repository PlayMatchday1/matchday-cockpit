"use client";

// THE FINANCE RAIL — six items, flat, in the order the money is read: where it lands (Cities),
// what came in (Revenue), what it took to stage (Cost), what it does to the bank (Cash Flow),
// what runs regardless (OpEx), and which pitches earn their keep (Field Ranking).
//
// GROUPED, because the estate stopped being six items. The four Configure sub-tabs were reachable
// only by opening a strip that replaced whichever section you were on — a second navigation system
// for pages the rail could simply name. ChatsRail renders headings as soon as there is more than
// one group, exactly as Match Ops Back Office does.
//
// REVENUE AND COST APPEAR TWICE, under REPORTS and LEDGERS. The header is what separates them: a
// REPORT reads the money, a LEDGER is the table you edit it in. If that proves ambiguous in use it
// should be renamed rather than left to context.
//
// THIS IS NAV DATA ONLY. The rail component, its collapse and the mobile sheet are the app's own.
//
// WHAT IS NOT HERE. City Manager Check-Ins moved to Match Ops › Back Office › People, and the
// Managers link is gone (it only ever redirected to a page with its own rail entry).

import type { RailItem } from "../../match-ops/sections";
import type { Grain } from "@/lib/financePeriod";

// WHICH GRAINS A SECTION CAN HONOUR. The period bar disables the rest and states the reason on
// the control — a grain that is silently ignored is a control that looks live and does nothing.
// This is data, not a guess: OpEx draws a day grid for ONE month and has no quarter form; Cash
// Flow's panels are built around a quarter (starting cash, quarter P&L, the three-month expense
// forecast) and have no month or year form.
export type SectionGrains = { grains: readonly Grain[]; why: string };
export const SECTION_GRAINS: Record<string, SectionGrains> = {
  "/admin/finance/cities":        { grains: ["month", "quarter", "year"], why: "" },
  "/admin/finance/revenue":       { grains: ["month", "quarter", "year"], why: "" },
  "/admin/finance/cost":          { grains: ["month", "quarter", "year"], why: "" },
  "/admin/finance/cash-flow":     { grains: ["quarter"], why: "Cash Flow is built around a quarter — starting cash, quarter P&L and a three-month expense forecast. It has no month or year form." },
  "/admin/finance/opex":          { grains: ["month"], why: "OpEx draws a day-by-day calendar for one month. A quarter or a year has no calendar grid." },
  "/admin/finance/field-ranking": { grains: ["month", "quarter"], why: "Field Ranking ranks venues within a month and compares across a quarter. A year would average away the ranking it exists to show." },
};

function I({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const FINANCE_SECTIONS: RailItem[] = [
  {
    key: "fin-cities", group: "Reports", label: "Cities", href: "/admin/finance/cities",
    desc: "Every city on one line, ranked by net",
    icon: <I><path d="M3 20h18" /><path d="M5 20V9l5-3.5V20" /><path d="M14 20V11l5 2.5V20" /><path d="M7.5 12.5v0M7.5 16v0" /></I>,
  },
  {
    key: "fin-revenue", group: "Reports", label: "Revenue", href: "/admin/finance/revenue",
    desc: "What came in, by city, field and match",
    icon: <I><path d="M4 19V5" /><path d="M4 15l4.5-4.5 3.5 3.5L20 6" /><path d="M15.5 6H20v4.5" /></I>,
  },
  {
    key: "fin-cost", group: "Reports", label: "Cost", href: "/admin/finance/cost",
    desc: "Field cost against the revenue it carried",
    icon: <I><path d="M3 20h18" /><path d="M6.5 20v-6" /><path d="M12 20V8" /><path d="M17.5 20v-9" /></I>,
  },
  {
    key: "fin-cash-flow", group: "Reports", label: "Cash Flow", href: "/admin/finance/cash-flow",
    desc: "Month by month against starting cash",
    icon: <I><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><circle cx="12" cy="12" r="2.6" /><path d="M6 12h.01M18 12h.01" /></I>,
  },
  {
    key: "fin-opex", group: "Reports", label: "OpEx", href: "/admin/finance/opex",
    desc: "When each recurring expense is billed",
    icon: <I><rect x="3.5" y="4.5" width="17" height="16" rx="2.5" /><path d="M3.5 9.5h17" /><path d="M8 3v3M16 3v3" /><path d="M8 13.5h3M8 17h3M14 13.5h2" /></I>,
  },
  {
    key: "fin-field-ranking", group: "Reports", label: "Field Ranking", href: "/admin/finance/field-ranking",
    desc: "Which pitches carry their own cost",
    icon: <I><path d="M8 21h8" /><path d="M12 17v4" /><path d="M6 4h12v5a6 6 0 0 1-12 0z" /><path d="M6 5.5H3.5V7a3.5 3.5 0 0 0 3 3.4" /><path d="M18 5.5h2.5V7a3.5 3.5 0 0 1-3 3.4" /></I>,
  },

  // ── LEDGERS: the tables the money is entered and corrected in ──────────────────────────────
  {
    key: "fin-ledger-revenue", group: "Ledgers", label: "Revenue", href: "/admin/finance/ledger/revenue",
    desc: "Every fin_revenue row, and the manual ones you add",
    icon: <I><path d="M4 19V5" /><path d="M20 19H4" /><rect x="7" y="9" width="3" height="7" /><rect x="13" y="6" width="3" height="10" /></I>,
  },
  {
    key: "fin-ledger-expenses", group: "Ledgers", label: "Expenses", href: "/admin/finance/ledger/expenses",
    desc: "Recurring line items, and the months one is missing",
    icon: <I><path d="M3.5 6.5h17v12h-17z" /><path d="M3.5 10.5h17" /><path d="M8 14.5h4" /></I>,
  },
  {
    key: "fin-ledger-field-costs", group: "Ledgers", label: "Field Costs", href: "/admin/finance/ledger/field-costs",
    desc: "What each venue bills, and the per-month overrides",
    icon: <I><rect x="2.5" y="5.5" width="19" height="13" rx="2" /><path d="M12 5.5v13" /><circle cx="12" cy="12" r="3" /></I>,
  },
  // ── SYSTEM ─────────────────────────────────────────────────────────────────────────────────
  {
    key: "fin-change-log", group: "System", label: "Change Log", href: "/admin/finance/change-log",
    desc: "Every production write, and whether it landed",
    icon: <I><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h6" /><circle cx="17.5" cy="16.5" r="2.2" /></I>,
  },
];
