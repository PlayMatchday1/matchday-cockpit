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
  match: (p: string) => boolean;
};

type GatedTab = Tab & {
  // Page-permission tabs use the existing PageName / canAccess
  // mechanism. Admin-only tabs (Player Chat, Match Chats) don't
  // map to a PageName today — they render whenever is_admin is
  // true.
  page: PageName;
};

// Primary tabs gated by per-page permissions. Always rendered when
// canAccess() returns true. Order matters — left-to-right reading
// order in the header.
const PERMISSION_TABS: GatedTab[] = [
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

// Admin-only primary tabs. Single "Chats" entry covers both
// /crm (Player Chat) and /match-chats (Match Chats). The active-
// state predicate matches BOTH routes — clicking Chats lands on
// /crm by default; the sub-tab strip inside the page handles the
// final hop to Match Chats. This was previously two separate
// entries; consolidated to declutter the top nav and to make the
// strip the canonical switch between the two surfaces.
const ADMIN_PRIMARY_TABS: Tab[] = [
  {
    href: "/crm",
    label: "Chats",
    match: (p) => p.startsWith("/crm") || p.startsWith("/match-chats"),
  },
];

// Secondary tabs (user-name dropdown).
const SECONDARY_TABS: GatedTab[] = [
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

  const visiblePermission = PERMISSION_TABS.filter((t) =>
    canAccess(appUser, t.page),
  );
  const isAdmin = !!appUser?.is_admin;
  const financeActive = pathname?.startsWith("/admin/finance") ?? false;
  const adminActive = pathname === "/admin";

  return (
    <header className="bg-deep-green text-cream">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex h-16 items-center justify-between gap-2 sm:gap-4">
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
          {/* Primary tabs. Hidden on small screens — the user-menu
              dropdown picks up the slack as a hamburger surrogate.
              Above lg: full padding; between sm and lg: tighter
              padding so the row doesn't wrap. */}
          <nav className="hidden flex-1 items-center justify-center gap-0.5 md:flex">
            {visiblePermission.map((tab) => {
              const active = pathname ? tab.match(pathname) : false;
              return (
                <PrimaryLink
                  key={tab.href}
                  href={tab.href}
                  active={active}
                  label={tab.label}
                />
              );
            })}
            {canAccess(appUser, "finance") && (
              <PrimaryLink
                href="/admin/finance"
                active={financeActive}
                label="Finance"
              />
            )}
            {isAdmin &&
              ADMIN_PRIMARY_TABS.map((tab) => {
                const active = pathname ? tab.match(pathname) : false;
                return (
                  <PrimaryLink
                    key={tab.href}
                    href={tab.href}
                    active={active}
                    label={tab.label}
                  />
                );
              })}
          </nav>
          {appUser ? (
            <UserMenu
              name={displayName(appUser)}
              isAdmin={isAdmin}
              adminActive={adminActive}
              pathname={pathname}
              canAccessSecondary={(page: PageName) => canAccess(appUser, page)}
              onSignOut={signOut}
              // On mobile (md:hidden zone) the dropdown also holds
              // the primary tabs so we don't lose access to them.
              mobilePrimaryTabs={[
                ...visiblePermission,
                ...(canAccess(appUser, "finance")
                  ? [
                      {
                        href: "/admin/finance",
                        label: "Finance",
                        match: (p: string) => p.startsWith("/admin/finance"),
                      },
                    ]
                  : []),
                ...(isAdmin ? ADMIN_PRIMARY_TABS : []),
              ]}
            />
          ) : (
            <div className="shrink-0" />
          )}
        </div>
      </div>
    </header>
  );
}

function PrimaryLink({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full px-2.5 py-1.5 text-sm font-medium tracking-tight transition lg:px-4 ${
        active
          ? "bg-mint text-deep-green"
          : "text-cream/80 hover:bg-deep-green-soft hover:text-cream"
      }`}
    >
      {label}
    </Link>
  );
}

// User-name dropdown trigger + menu panel. On mobile (md:hidden) it
// also surfaces the primary tabs so we don't strand users on small
// screens after promoting Player Chat / Match Chats to primary.
function UserMenu({
  name,
  isAdmin,
  adminActive,
  pathname,
  canAccessSecondary,
  onSignOut,
  mobilePrimaryTabs,
}: {
  name: string;
  isAdmin: boolean;
  adminActive: boolean;
  pathname: string | null;
  canAccessSecondary: (page: PageName) => boolean;
  onSignOut: () => void;
  mobilePrimaryTabs: Tab[];
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
          className="absolute right-0 z-20 mt-2 w-52 overflow-hidden rounded-md border border-cream-line bg-white py-1 text-deep-green shadow-lg shadow-deep-green/20"
        >
          {/* Mobile-only primary tabs. md:hidden so desktop never
              shows duplicates. */}
          <div className="md:hidden">
            {mobilePrimaryTabs.map((t) => {
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
            {mobilePrimaryTabs.length > 0 && (
              <div aria-hidden className="my-1 h-px bg-cream-line" />
            )}
          </div>

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
