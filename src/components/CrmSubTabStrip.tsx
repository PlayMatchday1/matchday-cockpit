"use client";

// Sub-nav pill strip rendered at the top of /crm and /match-chats.
// Lets operators jump between the two CRM-adjacent surfaces without
// going back through the user dropdown / top nav.
//
// Two pills only — Player Chat (/crm) and Match Chats (/match-chats).
// Active = deep-green pill with cream text; inactive = transparent
// pill with deep-green text + cream-line hover. Uses the same
// rounded-full pill geometry the rest of the cockpit uses for
// segmented controls.

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/crm", label: "Player Chat", match: (p: string) => p.startsWith("/crm") },
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
      className="flex shrink-0 items-center gap-1 border-b border-cream-line bg-cream px-3 py-2 sm:px-4"
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
                : "text-deep-green/70 hover:bg-cream-soft hover:text-deep-green"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
