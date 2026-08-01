"use client";

// Scoped icon rail for the Match Chats console (mockup matchops-chats-v1).
// This REPLACES the shared SectionSideNav on the /match-ops/match-chats route
// only — the shared component is untouched and every other Match Ops + Tech
// page keeps it. Two labelled groups (Operations, Conversations); active item
// is a raised white pill with a 3px accent left edge. Collapse state (212 ⇄
// 60px) is owned by the console and persisted there.
//
// Badges only render from real counts: Player Chats uses the live CRM unread
// hook. Review and Match Chats show no badge — there is no truthful source for
// them (the "waiting on a reply" count is blocked; see the ship report), and a
// false zero/guess is worse than no badge.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { canAccess, useAuth } from "@/lib/useAuth";
import { useCrmUnreadCount } from "@/lib/useCrmUnreadCount";

type Item = {
  group: "Operations" | "Conversations";
  label: string;
  href: string;
  icon: React.ReactNode;
  count?: number;
};

function I({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const ICONS: Record<string, React.ReactNode> = {
  master: (
    <I>
      <rect x="3" y="4" width="18" height="17" rx="2.5" />
      <path d="M3 9h18M8 2v4M16 2v4" />
    </I>
  ),
  pipeline: (
    <I>
      <path d="M3 5h18l-7 8v6l-4 2v-8z" />
    </I>
  ),
  ops: (
    <I>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
      <path d="M12 5.5v13" />
      <circle cx="12" cy="12" r="3" />
    </I>
  ),
  review: (
    <I>
      <path d="M9 11l2.5 2.5L16 8" />
      <rect x="3" y="3.5" width="18" height="17" rx="2.5" />
    </I>
  ),
  match: (
    <I>
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
    </I>
  ),
  players: (
    <I>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M17 7.5a3 3 0 0 1 0 6M18.5 20a6 6 0 0 0-3-5.2" />
    </I>
  ),
};

export default function MatchChatsRail({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { appUser } = useAuth();
  const pathname = usePathname() ?? "";
  const crmUnread = useCrmUnreadCount();

  const canCities = canAccess(appUser, "cities");
  const canClub = canAccess(appUser, "clubhouse");
  const canChats = canAccess(appUser, "chats");
  const isAdmin = !!appUser?.is_admin;

  const items: Item[] = [];
  if (canCities)
    items.push({ group: "Operations", label: "Master Schedule", href: "/match-ops/master-schedule", icon: ICONS.master });
  if (canClub)
    items.push({ group: "Operations", label: "Field Pipeline", href: "/match-ops/field-pipeline", icon: ICONS.pipeline });
  if (canCities)
    items.push({ group: "Operations", label: "Field Ops", href: "/match-ops/field-ops", icon: ICONS.ops });
  if (isAdmin)
    items.push({ group: "Operations", label: "Review", href: "/match-ops/review", icon: ICONS.review });
  if (canChats) {
    items.push({ group: "Conversations", label: "Match Chats", href: "/match-ops/match-chats", icon: ICONS.match });
    items.push({ group: "Conversations", label: "Player Chats", href: "/match-ops/player-chats", icon: ICONS.players, count: crmUnread });
  }

  let lastGroup: string | undefined;

  return (
    <nav
      aria-label="Match Ops"
      className="flex h-full flex-col gap-[2px] overflow-y-auto border-r px-[10px] py-[14px]"
      style={{
        background: "linear-gradient(180deg,#fafbfa,#f6f9f7)",
        borderColor: "#e6ebe8",
      }}
    >
      {items.map((it) => {
        const active =
          pathname === it.href || pathname.startsWith(it.href + "/");
        const header =
          it.group !== lastGroup && !collapsed ? (
            <div
              key={`hd-${it.group}`}
              className="whitespace-nowrap px-[10px] pb-[6px] pt-[14px] text-[9.5px] font-[780] uppercase tracking-[0.13em] first:pt-[2px]"
              style={{ color: "#93a49b" }}
            >
              {it.group}
            </div>
          ) : it.group !== lastGroup && collapsed ? (
            <div key={`hd-${it.group}`} aria-hidden className="h-[14px] pt-[8px]" />
          ) : null;
        lastGroup = it.group;

        return (
          <div key={it.href} className="contents">
            {header}
            <Link
              href={it.href}
              aria-current={active ? "page" : undefined}
              title={collapsed ? it.label : undefined}
              className={`relative flex min-h-[36px] items-center rounded-[11px] text-[13.5px] font-semibold transition ${
                collapsed ? "justify-center px-0 py-[8px]" : "gap-[10px] px-[10px] py-[8px]"
              } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#35c77f]`}
              style={
                active
                  ? { background: "#ffffff", color: "#0f3d2e", boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 14px 30px -22px rgba(7,42,32,.5)" }
                  : { color: "#3f544a" }
              }
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute left-[-10px] top-[9px] bottom-[9px] w-[3px] rounded-r-[3px]"
                  style={{ background: "#35c77f" }}
                />
              )}
              <span
                className="flex-none [&_svg]:h-[17px] [&_svg]:w-[17px]"
                style={{ color: active ? "#14764c" : "#3f544a", opacity: active ? 1 : 0.72, strokeWidth: 1.9 }}
              >
                {it.icon}
              </span>
              {!collapsed && (
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {it.label}
                </span>
              )}
              {!collapsed && typeof it.count === "number" && it.count > 0 && (
                <span
                  className="ml-auto rounded-full px-[7px] py-[1px] text-[11px] font-bold tabular-nums"
                  style={
                    active
                      ? { background: "#e0f2e7", color: "#12704a" }
                      : { background: "rgba(0,0,0,.045)", color: "#8d9c94" }
                  }
                >
                  {it.count}
                </span>
              )}
            </Link>
          </div>
        );
      })}

      <div className="mt-auto pt-[12px]">
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand rail" : "Collapse rail"}
          className={`flex w-full items-center rounded-[11px] py-[8px] text-[12.5px] font-semibold transition hover:bg-white/70 ${
            collapsed ? "justify-center px-0" : "gap-[10px] px-[10px]"
          }`}
          style={{ color: "#8d9c94" }}
        >
          <span
            className="flex-none [&_svg]:h-4 [&_svg]:w-4"
            style={{ strokeWidth: 2, transform: collapsed ? "rotate(180deg)" : undefined }}
          >
            <I>
              <path d="M14 6l-6 6 6 6" />
            </I>
          </span>
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </nav>
  );
}
