"use client";

import Link from "next/link";

// Sticky-on-scroll anchor + sub-page nav for /admin/finance. Two
// rows: primary in-page anchors, secondary sub-page links.
// Uses the existing pill button styling (rounded-full, mint accents)
// from the rest of the cockpit — no new component patterns.

const ANCHOR_LINKS: { label: string; href: string }[] = [
  { label: "Cities", href: "#cities" },
  { label: "Exec Summary", href: "#exec-summary" },
];

// `newTab: true` opens in a new tab via plain <a target="_blank"> so
// the admin doesn't lose their spot on the main finance page.
const SUBPAGE_LINKS: { label: string; href: string; newTab?: boolean }[] = [
  { label: "Expenses", href: "/admin/finance/expenses" },
  { label: "Manager Pay", href: "/admin/finance/manager-pay" },
  { label: "Field Ranking", href: "/admin/finance/fields" },
  { label: "Cash Flow", href: "/admin/finance/cash-flow" },
  { label: "City Manager Check-Ins", href: "/admin/finance/check-ins" },
  { label: "Partner Dashboards", href: "/admin/finance/partners", newTab: true },
];

export default function FinanceAnchorNav() {
  return (
    <nav
      aria-label="Finance sections"
      className="sticky top-0 z-30 -mx-4 mb-8 border-y border-cream-line bg-cream-soft/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-cream-soft/80 sm:-mx-6 sm:px-6"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {ANCHOR_LINKS.map((l) => (
          <a
            key={l.href}
            href={l.href}
            className="rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
          >
            {l.label}
          </a>
        ))}
        <span aria-hidden className="mx-1 hidden h-4 w-px bg-cream-line sm:inline-block" />
        {SUBPAGE_LINKS.map((l) => {
          const cls =
            "rounded-full border border-cream-line bg-white px-3 py-1.5 text-xs font-bold text-deep-green transition hover:bg-cream-soft";
          return l.newTab ? (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className={cls}
            >
              {l.label}
            </a>
          ) : (
            <Link key={l.href} href={l.href} className={cls}>
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
