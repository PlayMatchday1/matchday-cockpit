"use client";

// Generic left sub-nav for a top-level section (Match Ops, Tech, …). Items are
// props — no hardcoded routes — with the active item derived from the pathname.
// A light left rail; below 900px it collapses to a horizontal scrollable row.
//
// Additive extensions (existing callers pass none and render exactly as before):
//   - group?: string  → renders a small uppercase group header before the first
//     item of each group, so groups are data not markup.
//   - count?: number + tone? → a count badge (grey default / red alert). Never
//     rendered when the count is 0 or undefined — an empty/zero badge would read
//     as "nothing to do," a lie when the truth is "not loaded."

import Link from "next/link";
import { usePathname } from "next/navigation";

export type SectionNavItem = {
  label: string;
  href: string;
  disabled?: boolean;
  group?: string;
  count?: number;
  tone?: "default" | "alert";
};

export default function SectionSideNav({
  items,
  ariaLabel,
}: {
  items: SectionNavItem[];
  ariaLabel: string;
}) {
  const pathname = usePathname();
  const base = "whitespace-nowrap rounded-lg px-3 py-2 text-[13px] transition";

  let lastGroup: string | undefined;
  return (
    <nav
      aria-label={ariaLabel}
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-[#e4ddcc] bg-[#fffdf7] p-3 min-[900px]:sticky min-[900px]:top-6 min-[900px]:w-[216px] min-[900px]:flex-col min-[900px]:self-start min-[900px]:overflow-visible min-[900px]:border-b-0 min-[900px]:border-r"
    >
      {items.map((it) => {
        const header =
          it.group && it.group !== lastGroup ? (
            <div
              key={`hd-${it.group}`}
              className="hidden px-2 pb-1 pt-3 text-[10px] font-extrabold uppercase tracking-[0.13em] text-[#9aa8a1] first:pt-1 min-[900px]:block"
            >
              {it.group}
            </div>
          ) : null;
        lastGroup = it.group;

        const badge =
          typeof it.count === "number" && it.count > 0 ? (
            <span
              className={`ml-auto rounded-full px-[7px] py-[1px] text-[11px] font-bold tabular-nums ${
                it.tone === "alert"
                  ? "bg-[#fdeae4] text-[#a8351a]"
                  : "bg-[#eae4d6] text-[#6b7a73]"
              }`}
            >
              {it.count}
            </span>
          ) : null;

        if (it.disabled) {
          return (
            <div key={it.label} className="contents">
              {header}
              <span
                title="Coming soon"
                className={`${base} flex items-center gap-2 cursor-default font-medium text-[#b3bdb8]`}
              >
                {it.label}
                {badge}
              </span>
            </div>
          );
        }
        const active =
          pathname === it.href || (pathname?.startsWith(it.href + "/") ?? false);
        return (
          <div key={it.href} className="contents">
            {header}
            <Link
              href={it.href}
              aria-current={active ? "page" : undefined}
              className={`${base} flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#35c77f] ${
                active
                  ? "bg-[#e0f2e7] font-semibold text-[#0d3b2e]"
                  : "font-medium text-[#6d7b74] hover:bg-black/[0.04] hover:text-[#12241d]"
              }`}
            >
              {it.label}
              {badge}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}
