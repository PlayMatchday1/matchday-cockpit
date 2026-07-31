"use client";

import Link from "next/link";

// Tabbed sub-nav shared across the admin section. Each page renders
// this at the top so admins can swap between sections without going
// back to the user-menu dropdown.

type Tab = { href: string; label: string };

const TABS: Tab[] = [
  { href: "/admin", label: "User access" },
  { href: "/admin/reports", label: "Reports" },
  { href: "/admin/canned-responses", label: "Canned responses" },
];

export default function AdminSubNav({
  active,
}: {
  active: "users" | "reports" | "canned-responses";
}) {
  return (
    <div
      role="tablist"
      aria-label="Admin section"
      className="mb-5 flex items-center gap-5 border-b border-cream-line"
    >
      {TABS.map((t) => {
        const isActive =
          (active === "users" && t.href === "/admin") ||
          (active === "reports" && t.href === "/admin/reports") ||
          (active === "canned-responses" &&
            t.href === "/admin/canned-responses");
        return (
          <Link
            key={t.href}
            href={t.href}
            role="tab"
            aria-selected={isActive}
            className={
              isActive
                ? "-mb-px border-b-2 border-mint-hover px-0.5 pb-2 text-[13px] font-bold tracking-tight text-deep-green"
                : "-mb-px border-b-2 border-transparent px-0.5 pb-2 text-[13px] font-medium tracking-tight text-deep-green/55 transition hover:text-deep-green"
            }
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
