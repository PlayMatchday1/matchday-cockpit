"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  canAccess,
  displayName,
  useAuth,
  type PageName,
} from "@/lib/useAuth";

type Tab = {
  href: string;
  label: string;
  page: PageName;
  match: (p: string) => boolean;
};

const TABS: Tab[] = [
  {
    href: "/clubhouse",
    label: "Clubhouse",
    page: "clubhouse",
    match: (p) => p.startsWith("/clubhouse"),
  },
  {
    href: "/cities",
    label: "Cities",
    page: "cities",
    match: (p) => p.startsWith("/cities"),
  },
  {
    href: "/org",
    label: "Org",
    page: "org",
    match: (p) => p.startsWith("/org"),
  },
  {
    href: "/data",
    label: "Data",
    page: "data",
    match: (p) => p.startsWith("/data"),
  },
  {
    href: "/docs",
    label: "Docs",
    page: "docs",
    match: (p) => p.startsWith("/docs"),
  },
];

export default function TopNav() {
  const pathname = usePathname();
  const { appUser, signOut } = useAuth();

  const visibleTabs = TABS.filter((t) => canAccess(appUser, t.page));
  const adminActive = pathname === "/admin";
  const financeActive = pathname?.startsWith("/admin/finance") ?? false;

  return (
    <header className="bg-deep-green text-cream">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex h-16 items-center justify-between gap-4">
          <Link
            href="/clubhouse"
            className="flex shrink-0 items-center gap-2"
            aria-label="MatchDay home"
          >
            <Image
              src="/matchday-logo.png"
              alt="MatchDay"
              width={140}
              height={32}
              priority
              className="h-7 w-auto"
            />
          </Link>
          <nav className="flex flex-wrap items-center justify-center gap-1">
            {visibleTabs.map((tab) => {
              const active = pathname ? tab.match(pathname) : false;
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium tracking-tight transition ${
                    active
                      ? "bg-mint text-deep-green"
                      : "text-cream/80 hover:bg-deep-green-soft hover:text-cream"
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
            {appUser?.is_admin && (
              <Link
                href="/admin/finance"
                className={`rounded-full px-4 py-1.5 text-sm font-medium tracking-tight transition ${
                  financeActive
                    ? "bg-mint text-deep-green"
                    : "text-cream/80 hover:bg-deep-green-soft hover:text-cream"
                }`}
              >
                Finance
              </Link>
            )}
            {appUser?.is_admin && (
              <Link
                href="/admin"
                className={`rounded-full px-4 py-1.5 text-sm font-medium tracking-tight transition ${
                  adminActive
                    ? "bg-mint text-deep-green"
                    : "text-cream/80 hover:bg-deep-green-soft hover:text-cream"
                }`}
              >
                Admin
              </Link>
            )}
          </nav>
          {appUser ? (
            <div className="flex shrink-0 items-center gap-3">
              <span className="hidden text-xs text-cream/70 sm:inline">
                {displayName(appUser)}
              </span>
              <button
                type="button"
                onClick={signOut}
                className="rounded-full px-3 py-1 text-xs font-medium text-cream/80 transition hover:bg-deep-green-soft hover:text-cream"
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="shrink-0" />
          )}
        </div>
      </div>
    </header>
  );
}
