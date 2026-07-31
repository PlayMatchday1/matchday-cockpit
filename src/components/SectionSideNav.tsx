"use client";

// Generic left sub-nav for a top-level section (Match Ops, Tech, …). Takes its
// items as props — no hardcoded routes — with the active item derived from the
// pathname. A light left rail (not a dark full-height rail: the app already has
// dark top chrome and stacking two dark navs reads as competing navs). Below
// 900px it collapses to a horizontal scrollable row above the content.
//
// Palette is taken verbatim from public/mockups/home-goals-v3.html
// (--surface #fffdf7, --line #e4ddcc, --mint #e0f2e7, --forest #0d3b2e,
// --muted #6d7b74, --ink #12241d).

import Link from "next/link";
import { usePathname } from "next/navigation";

export type SectionNavItem = {
  label: string;
  href: string;
  disabled?: boolean;
};

export default function SectionSideNav({
  items,
  ariaLabel,
}: {
  items: SectionNavItem[];
  ariaLabel: string;
}) {
  const pathname = usePathname();
  const base =
    "whitespace-nowrap rounded-lg px-3 py-2 text-[13px] transition";
  return (
    <nav
      aria-label={ariaLabel}
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-[#e4ddcc] bg-[#fffdf7] p-3 min-[900px]:w-[200px] min-[900px]:flex-col min-[900px]:overflow-visible min-[900px]:border-b-0 min-[900px]:border-r"
    >
      {items.map((it) => {
        if (it.disabled) {
          return (
            <span
              key={it.label}
              title="Coming soon"
              className={`${base} cursor-default font-medium text-[#b3bdb8]`}
            >
              {it.label}
            </span>
          );
        }
        const active =
          pathname === it.href || (pathname?.startsWith(it.href + "/") ?? false);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? "page" : undefined}
            className={`${base} ${
              active
                ? "bg-[#e0f2e7] font-semibold text-[#0d3b2e]"
                : "font-medium text-[#6d7b74] hover:bg-black/[0.04] hover:text-[#12241d]"
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
