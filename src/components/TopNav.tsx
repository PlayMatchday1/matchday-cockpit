"use client";

import { useEffect, useRef, useState } from "react";
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

// Primary tabs — always-visible top nav. Secondary destinations
// (Data, Org, Docs, Admin, Sign out) live in the user-name dropdown
// on the right.
const PRIMARY_TABS: Tab[] = [
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
];

// Secondary tabs that go in the user-name dropdown above the
// divider, in this order. Sign out is rendered separately below.
const SECONDARY_TABS: Tab[] = [
  {
    href: "/data",
    label: "Data",
    page: "data",
    match: (p) => p.startsWith("/data"),
  },
  {
    href: "/org",
    label: "Org",
    page: "org",
    match: (p) => p.startsWith("/org"),
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

  const visiblePrimary = PRIMARY_TABS.filter((t) => canAccess(appUser, t.page));
  const financeActive = pathname?.startsWith("/admin/finance") ?? false;
  const adminActive = pathname === "/admin";

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
            {visiblePrimary.map((tab) => {
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
            {canAccess(appUser, "finance") && (
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
          </nav>
          {appUser ? (
            <UserMenu
              name={displayName(appUser)}
              isAdmin={!!appUser.is_admin}
              adminActive={adminActive}
              pathname={pathname}
              canAccessSecondary={(page: PageName) => canAccess(appUser, page)}
              onSignOut={signOut}
            />
          ) : (
            <div className="shrink-0" />
          )}
        </div>
      </div>
    </header>
  );
}

// User-name dropdown trigger + menu panel. Secondary nav items
// (Data, Org, Docs, Admin) are rendered in the order they're defined
// above, with Sign out below a divider. Closes on click outside,
// Escape, or any item activation.
function UserMenu({
  name,
  isAdmin,
  adminActive,
  pathname,
  canAccessSecondary,
  onSignOut,
}: {
  name: string;
  isAdmin: boolean;
  adminActive: boolean;
  pathname: string | null;
  canAccessSecondary: (page: PageName) => boolean;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent | TouchEvent) {
      const target = e.target as Node | null;
      if (ref.current && target && !ref.current.contains(target)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visibleSecondary = SECONDARY_TABS.filter((t) =>
    canAccessSecondary(t.page),
  );
  const showAdmin = isAdmin;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium text-cream/80 transition hover:bg-deep-green-soft hover:text-cream"
      >
        <span className="hidden sm:inline">{name}</span>
        <span aria-hidden className="text-[10px] leading-none">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-md border border-cream-line bg-white py-1 text-deep-green shadow-lg shadow-deep-green/20"
        >
          {visibleSecondary.map((t) => {
            const active = pathname ? t.match(pathname) : false;
            return (
              <Link
                key={t.href}
                href={t.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className={`block px-3 py-1.5 text-sm transition hover:bg-cream-soft ${
                  active ? "bg-mint-soft font-bold" : ""
                }`}
              >
                {t.label}
              </Link>
            );
          })}
          {showAdmin && (
            <Link
              href="/crm"
              role="menuitem"
              onClick={() => setOpen(false)}
              className={`block px-3 py-1.5 text-sm transition hover:bg-cream-soft ${
                pathname?.startsWith("/crm") ? "bg-mint-soft font-bold" : ""
              }`}
            >
              CRM
            </Link>
          )}
          {showAdmin && (
            <Link
              href="/match-chats"
              role="menuitem"
              onClick={() => setOpen(false)}
              className={`block px-3 py-1.5 text-sm transition hover:bg-cream-soft ${
                pathname?.startsWith("/match-chats") ? "bg-mint-soft font-bold" : ""
              }`}
            >
              Match Chats
            </Link>
          )}
          {showAdmin && (
            <Link
              href="/admin"
              role="menuitem"
              onClick={() => setOpen(false)}
              className={`block px-3 py-1.5 text-sm transition hover:bg-cream-soft ${
                adminActive ? "bg-mint-soft font-bold" : ""
              }`}
            >
              Admin
            </Link>
          )}
          {(visibleSecondary.length > 0 || showAdmin) && (
            <div aria-hidden className="my-1 h-px bg-cream-line" />
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="block w-full px-3 py-1.5 text-left text-sm text-deep-green/75 transition hover:bg-cream-soft hover:text-deep-green"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
