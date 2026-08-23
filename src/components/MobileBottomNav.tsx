"use client";

// Persistent bottom nav for mobile viewports (under md:). Hidden on
// desktop via `md:hidden`; the TopNav owns navigation at md+. Fixed
// to the bottom of the viewport so iOS keyboards and page scroll
// don't move it. AuthGate reserves space for it via --bottom-nav-h
// so page content never sits underneath.
//
// Four slots: Chats / Cities / Finance / More. The More button opens
// a full-screen sheet listing every route NOT in the bottom nav
// (Home, Data, Org, Docs, Admin, Sign out) so operators on
// phones can still reach the rest of the cockpit.
//
// All routes are gated by the same canAccess() / is_admin predicates
// that govern TopNav, so the mobile surface mirrors desktop access.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  ChevronRight,
  Database,
  FileText,
  LayoutGrid,
  LogOut,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Shield,
  Sprout,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { canAccess, useAuth, type AppUser } from "@/lib/useAuth";
import { useCrmAwaitingCount } from "@/lib/useCrmAwaitingCount";
import UnreadCountCircle from "@/components/UnreadCountCircle";

// Mobile mirror of TopNav's primary sections, in the same order. The bottom bar
// can't hold five, so the user's first three *accessible* sections show in the
// bar and the rest fall into the More sheet (nothing dropped). Membership is no
// longer listed here: it is a Player Lifecycle rail item, reached from that
// section's mobile sheet, and the disabled "Coming soon" row it used to have
// here had outlived the tab it was mirroring.
type MobilePrimary = {
  key: string;
  href: string;
  label: string;
  /* THE BAR LABEL, when the full one will not fit five across at 320px.
   * "Player Lifecycle" is 16 characters in a 64px slot — it truncates, and a truncated tab label
   * is a tab you have to guess at. The sheet keeps the full name; only the bar shortens. */
  barLabel?: string;
  icon: LucideIcon;
  badge?: boolean;
  visible: (u: AppUser) => boolean;
  isActive: (pathname: string) => boolean;
};

const MOBILE_PRIMARY: MobilePrimary[] = [
  {
    key: "home",
    href: "/home",
    label: "Home",
    icon: LayoutGrid,
    visible: (u) => canAccess(u, "home"),
    isActive: (p) => p.startsWith("/home"),
  },
  {
    key: "finance",
    href: "/admin/finance",
    label: "Finance",
    icon: BarChart3,
    visible: (u) => canAccess(u, "finance"),
    isActive: (p) => p.startsWith("/admin/finance"),
  },
  {
    key: "lifecycle",
    href: "/lifecycle",
    label: "Player Lifecycle",
    barLabel: "Players",
    icon: MapPin,
    visible: (u) => canAccess(u, "lifecycle") || canAccess(u, "membership"),
    isActive: (p) => p.startsWith("/lifecycle") || p.startsWith("/membership"),
  },
  {
    key: "growth",
    href: "/growth",
    label: "Growth",
    icon: Sprout,
    visible: (u) => canAccess(u, "growth"),
    isActive: (p) => p.startsWith("/growth"),
  },
  {
    key: "match-ops",
    href: "/match-ops",
    label: "Match Ops",
    icon: MessageCircle,
    badge: true,
    visible: (u) => canAccess(u, "matchops") || canAccess(u, "chats"),
    isActive: (p) => p.startsWith("/match-ops"),
  },
  {
    key: "tech",
    href: "/tech",
    label: "Tech",
    icon: Wrench,
    visible: (u) => canAccess(u, "tech"),
    isActive: (p) => p.startsWith("/tech"),
  },
];

type SheetItem = {
  href?: string;
  label: string;
  icon: LucideIcon;
  visible: boolean;
  disabled?: boolean;
  badge?: boolean;
};

export default function MobileBottomNav({
  inline = false,
}: {
  // When true, render as a normal block element instead of viewport-fixed.
  // Used on chat shells (/chats, /match-chats) where the surrounding shell
  // is a 100dvh flex column with overflow-locked html — iOS Safari PWA
  // miscalculates position:fixed bottom:0 against the visual viewport in
  // that locked-shell state after a keyboard cycle, stranding the nav
  // mid-screen. Inline flex positioning sidesteps the iOS quirk entirely.
  inline?: boolean;
} = {}) {
  const pathname = usePathname() ?? "";
  const { appUser, signOut } = useAuth();
  const [sheetOpen, setSheetOpen] = useState(false);
  // Match Ops badge = player-chat threads awaiting a human reply — the same
  // shared count the top-nav pill and the rail show, so they can't disagree.
  const awaiting = useCrmAwaitingCount();

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

  /* FIVE SLOTS: four sections plus More. Finance is SECOND, because it is the page opened most and
   * it was previously buried — BAR_ORDER ranked match-ops and growth above it and the bar took only
   * three, so Finance fell into the sheet and cost two taps every time.
   *
   * Four tabs plus More at 320px gives 64px per slot, which is why the Lifecycle tab uses its barLabel. */
  // GROWTH IS LAST ON PURPOSE. Four slots plus More at 320px is 64px per slot; a fifth is 51px, so
  // the bar cannot grow. Tech already falls into the sheet for anyone holding all of these, and
  // Growth is a weekly-cadence planning surface — it loses the seat to Home, Finance, Match Ops and
  // Player Lifecycle on frequency, and sorts into More deterministically rather than by list order.
  const BAR_ORDER = ["home", "finance", "match-ops", "lifecycle", "tech", "growth"];
  const visiblePrimary = MOBILE_PRIMARY.filter((t) => t.visible(appUser));
  const prioritised = [...visiblePrimary].sort(
    (a, b) => BAR_ORDER.indexOf(a.key) - BAR_ORDER.indexOf(b.key),
  );
  const barTabs = prioritised.slice(0, 4);
  const overflowKeys = new Set(prioritised.slice(4).map((t) => t.key));

  const sheetItems: SheetItem[] = [
    // Primary sections that didn't fit the bar (kept in nav order).
    ...MOBILE_PRIMARY.filter((t) => overflowKeys.has(t.key)).map((t) => ({
      href: t.href,
      label: t.label,
      icon: t.icon,
      visible: true,
      badge: t.badge,
    })),
    {
      href: "/data",
      label: "Data",
      icon: Database,
      visible: canAccess(appUser, "tech"),
    },
    {
      href: "/docs",
      label: "Docs",
      icon: FileText,
      visible: canAccess(appUser, "tech"),
    },
    { href: "/admin", label: "Admin", icon: Shield, visible: isAdmin },
  ];

  const visibleSheetItems = sheetItems.filter((i) => i.visible);
  /* MORE IS LIT ONLY WHEN NO PRIMARY TAB OWNS THE PAGE.
   * The sheet carries { href: "/admin" }, and pathname.startsWith("/admin") is true for
   * /admin/finance/revenue — so More lit on every Finance page, giving TWO lit tabs at once. That
   * was survivable while Finance lived in the sheet; promoting it to the bar made it visible.
   * Checking the bar first fixes the whole class, not just the /admin case: any sheet href that
   * happens to prefix a bar tab's path would have done the same thing. */
  const anyBarTabActive = barTabs.some((t) => t.isActive(pathname));
  const moreActive =
    sheetOpen ||
    (!anyBarTabActive &&
      visibleSheetItems.some((i) => !i.disabled && i.href && pathname.startsWith(i.href)));

  return (
    <>
      <nav
        aria-label="Primary"
        className={
          inline
            ? "grid border-t border-cream-line bg-white md:hidden"
            : "fixed inset-x-0 bottom-0 z-30 grid border-t border-cream-line bg-white md:hidden"
        }
        style={{
          gridTemplateColumns: `repeat(${barTabs.length + 1}, minmax(0,1fr))`,
          // var(--sab), not raw env(), so the home-indicator inset is
          // overridable and therefore testable in the notch harness.
          paddingBottom: "var(--sab)",
          // EVERY TAB IS AT LEAST 44px OF TARGET. The row is h-14 (56px) plus the inset, so the
          // bar GROWS by the home indicator rather than having its tappable area eaten by it.
          minHeight: "calc(56px + var(--sab))",
        }}
      >
        {barTabs.map((t) => {
          const active = t.isActive(pathname);
          return (
            <NavTab
              key={t.key}
              href={t.href}
              label={t.barLabel ?? t.label}
              Icon={t.icon}
              active={active}
              badgeCount={t.badge ? awaiting : 0}
            />
          );
        })}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label="More"
          aria-expanded={sheetOpen}
          style={{ touchAction: "manipulation" }}
          className={`flex h-14 flex-col items-center justify-center gap-1 text-[10px] transition ${
            moreActive
              ? "font-medium text-deep-green"
              : "font-normal text-muted"
          }`}
        >
          <span
            className={`flex items-center justify-center rounded-2xl px-4 py-0.5 transition ${
              moreActive ? "bg-deep-green/10" : ""
            }`}
          >
            <MoreHorizontal aria-hidden size={22} strokeWidth={moreActive ? 2 : 1.75} />
          </span>
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
  badgeCount = 0,
}: {
  href: string;
  label: string;
  Icon: LucideIcon;
  active: boolean;
  badgeCount?: number;
}) {
  return (
    <Link
      href={href}
      aria-label={
        badgeCount > 0
          ? `${label}, ${badgeCount} player ${badgeCount === 1 ? "chat" : "chats"} waiting on a reply`
          : label
      }
      aria-current={active ? "page" : undefined}
      style={{ touchAction: "manipulation" }}
      className={`flex h-14 flex-col items-center justify-center gap-1 text-[10px] transition ${
        active ? "font-medium text-deep-green" : "font-normal text-muted"
      }`}
    >
      <span
        className={`flex items-center justify-center rounded-2xl px-4 py-0.5 transition ${
          active ? "bg-deep-green/10" : ""
        }`}
      >
        <Icon aria-hidden size={22} strokeWidth={active ? 2 : 1.75} />
      </span>
      <span className="inline-flex items-center gap-1">
        <span>{label}</span>
        {badgeCount > 0 && <UnreadCountCircle count={badgeCount} size="sm" />}
      </span>
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
            if (it.disabled || !it.href) {
              return (
                <li key={it.label}>
                  <span
                    title="Coming soon"
                    aria-disabled="true"
                    className="flex min-h-[48px] items-center gap-3 px-4 py-3 text-deep-green/35"
                  >
                    <it.icon
                      aria-hidden
                      size={20}
                      strokeWidth={1.75}
                      className="shrink-0"
                    />
                    <span className="flex-1 text-[15px] font-medium">
                      {it.label}
                    </span>
                    <span className="text-[11px] font-semibold uppercase tracking-wide">
                      Soon
                    </span>
                  </span>
                </li>
              );
            }
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
