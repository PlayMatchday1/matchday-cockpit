"use client";

// Sub-nav pill strip rendered at the top of /crm and /match-chats.
// This is the canonical switch between the two surfaces — the top
// nav consolidated "Player Chat" + "Match Chats" into a single
// "Chats" entry, so this strip is how operators move between them.
//
// Two pills side-by-side. Active = filled deep-green / cream text.
// Inactive = transparent with a thin deep-green/20 border so the
// affordance reads as "tappable" without competing with the active
// pill's mass.

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/chats", label: "Player Chat", match: (p: string) => p.startsWith("/chats") },
  {
    href: "/match-chats",
    label: "Match Chats",
    match: (p: string) => p.startsWith("/match-chats"),
  },
] as const;

export default function CrmSubTabStrip() {
  const pathname = usePathname() ?? "";
  return (
    <nav
      aria-label="Player Chat / Match Chats"
      className="flex shrink-0 items-center gap-2 border-b border-cream-line bg-cream px-3 py-2 sm:px-4"
    >
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`rounded-full px-3 py-1 text-xs font-medium transition sm:text-sm ${
              active
                ? "bg-deep-green text-cream"
                : "border border-deep-green/20 text-deep-green hover:bg-cream-soft"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
