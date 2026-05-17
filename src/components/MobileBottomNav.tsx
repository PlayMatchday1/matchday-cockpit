"use client";

// Persistent bottom nav for mobile viewports (under md:). Hidden on
// desktop via `md:hidden`; the TopNav owns navigation at md+. Fixed
// to the bottom of the viewport so iOS keyboards and page scroll
// don't move it. AuthGate reserves space for it via --bottom-nav-h
// so page content never sits underneath.
//
// Four slots: Chats / Cities / Finance / More. The More button opens
// a full-screen sheet listing every route NOT in the bottom nav
// (Clubhouse, Data, Org, Docs, Admin, Sign out) so operators on
// phones can still reach the rest of the cockpit.
//
// All routes are gated by the same canAccess() / is_admin predicates
// that govern TopNav, so the mobile surface mirrors desktop access.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Building2,
  ChevronRight,
  Database,
  FileText,
  LayoutGrid,
  LogOut,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Shield,
  X,
  type LucideIcon,
} from "lucide-react";
import { canAccess, useAuth, type PageName } from "@/lib/useAuth";

type TabKey = "chats" | "cities" | "finance" | "more";

type RouteTab = {
  key: Exclude<TabKey, "more">;
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
};

const ROUTE_TABS: RouteTab[] = [
  {
    key: "chats",
    href: "/chats",
    label: "Chats",
    icon: MessageCircle,
    isActive: (p) => p.startsWith("/chats") || p.startsWith("/match-chats"),
  },
  {
    key: "cities",
    href: "/cities",
    label: "Cities",
    icon: MapPin,
    isActive: (p) => p.startsWith("/cities"),
  },
  {
    key: "finance",
    href: "/admin/finance",
    label: "Finance",
    icon: BarChart3,
    isActive: (p) => p.startsWith("/admin/finance"),
  },
];

type SheetItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  visible: boolean;
};

export default function MobileBottomNav() {
  const pathname = usePathname() ?? "";
  const { appUser, signOut } = useAuth();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Close the sheet on route change. Tapping a sheet row navigates
  // via <Link>, so we want the sheet gone by the time the next page
  // paints.
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  // Lock body scroll while the sheet is open so the page underneath
  // doesn't scroll behind the overlay.
  useEffect(() => {
    if (!sheetOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sheetOpen]);

  if (!appUser) return null;

  const isAdmin = !!appUser.is_admin;
  const visibleTabs = ROUTE_TABS.filter((t) => {
    if (t.key === "chats") return isAdmin;
    if (t.key === "cities") return canAccess(appUser, "cities");
    if (t.key === "finance") return canAccess(appUser, "finance");
    return true;
  });

  const sheetItems: SheetItem[] = [
    {
      href: "/clubhouse",
      label: "Clubhouse",
      icon: LayoutGrid,
      visible: canAccess(appUser, "clubhouse"),
    },
    {
      href: "/data",
      label: "Data",
      icon: Database,
      visible: canAccess(appUser, "data"),
    },
    {
      href: "/org",
      label: "Org",
      icon: Building2,
      visible: canAccess(appUser, "org"),
    },
    {
      href: "/docs",
      label: "Docs",
      icon: FileText,
      visible: canAccess(appUser, "docs"),
    },
    {
      href: "/admin",
      label: "Admin",
      icon: Shield,
      visible: isAdmin,
    },
  ];

  const visibleSheetItems = sheetItems.filter((i) => i.visible);
  const moreActive =
    sheetOpen ||
    visibleSheetItems.some((i) => pathname.startsWith(i.href));

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-cream-line bg-white md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {visibleTabs.map((t) => {
          const active = t.isActive(pathname);
          return (
            <NavTab
              key={t.key}
              href={t.href}
              label={t.label}
              Icon={t.icon}
              active={active}
            />
          );
        })}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label="More"
          aria-expanded={sheetOpen}
          style={{ touchAction: "manipulation" }}
          className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] transition ${
            moreActive
              ? "font-medium text-deep-green"
              : "font-normal text-muted"
          }`}
        >
          <MoreHorizontal aria-hidden size={22} strokeWidth={1.75} />
          <span>More</span>
        </button>
      </nav>

      {sheetOpen && (
        <MoreSheet
          items={visibleSheetItems}
          pathname={pathname}
          onClose={() => setSheetOpen(false)}
          onSignOut={async () => {
            setSheetOpen(false);
            await signOut();
          }}
        />
      )}
    </>
  );
}

function NavTab({
  href,
  label,
  Icon,
  active,
}: {
  href: string;
  label: string;
  Icon: LucideIcon;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      style={{ touchAction: "manipulation" }}
      className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] transition ${
        active ? "font-medium text-deep-green" : "font-normal text-muted"
      }`}
    >
      <Icon aria-hidden size={22} strokeWidth={active ? 2 : 1.75} />
      <span>{label}</span>
    </Link>
  );
}

function MoreSheet({
  items,
  pathname,
  onClose,
  onSignOut,
}: {
  items: SheetItem[];
  pathname: string;
  onClose: () => void;
  onSignOut: () => void | Promise<void>;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="More"
      className="fixed inset-0 z-40 flex flex-col bg-cream md:hidden"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-cream-line bg-white px-4">
        <h2 className="text-base font-bold tracking-tight text-deep-green">
          More
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{ touchAction: "manipulation" }}
          className="flex h-11 w-11 items-center justify-center rounded-full text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
        >
          <X aria-hidden size={20} strokeWidth={2} />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto overflow-x-hidden bg-white">
        <ul className="divide-y divide-cream-line">
          {items.map((it) => {
            const active = pathname.startsWith(it.href);
            return (
              <li key={it.href}>
                <Link
                  href={it.href}
                  aria-current={active ? "page" : undefined}
                  style={{ touchAction: "manipulation" }}
                  className="flex min-h-[48px] items-center gap-3 px-4 py-3 text-deep-green transition hover:bg-cream-soft"
                >
                  <it.icon
                    aria-hidden
                    size={20}
                    strokeWidth={1.75}
                    className="shrink-0 text-deep-green/70"
                  />
                  <span
                    className={`flex-1 text-[15px] ${
                      active ? "font-bold" : "font-medium"
                    }`}
                  >
                    {it.label}
                  </span>
                  <ChevronRight
                    aria-hidden
                    size={18}
                    strokeWidth={1.75}
                    className="text-deep-green/40"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-cream-line bg-cream-soft p-4">
          <button
            type="button"
            onClick={() => void onSignOut()}
            style={{ touchAction: "manipulation" }}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full border border-deep-green/20 bg-white px-4 text-sm font-medium text-deep-green transition hover:bg-cream-soft"
          >
            <LogOut aria-hidden size={16} strokeWidth={1.75} />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
