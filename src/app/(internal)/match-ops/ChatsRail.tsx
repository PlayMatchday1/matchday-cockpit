"use client";

// THE Match Ops desktop rail — the single rail component on every Match Ops
// route (mounted once, full-bleed and fixed, by the section layout). It used to
// be the chat-only rail while other routes got SectionSideNav; now it is the one
// rail everywhere. Two labelled groups (Operations, Conversations); the active
// item is a raised white pill with a 3px accent bar on the viewport edge.
// Collapse (expanded ⇄ icons-only) is owned by the layout and persisted there.
//
// The nav list, icons, and badge bindings come from ONE array (./sections);
// this component only renders it. Badges render from a real count, hidden at
// zero (a false zero is worse than no badge): Player Chats shows the shared
// "waiting on a reply" count (the same number the top-nav Match Ops pill and the
// Player Chats metrics-strip pill show). A collapsed rail keeps every item's
// accessible name via title=.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { useCrmAwaitingCount } from "@/lib/useCrmAwaitingCount";
import { visibleSections } from "./sections";

export default function ChatsRail({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { appUser } = useAuth();
  const pathname = usePathname() ?? "";
  const awaiting = useCrmAwaitingCount();

  const items = visibleSections(appUser);
  const badgeCount = (kind?: "awaiting") => (kind === "awaiting" ? awaiting : undefined);

  let lastGroup: string | undefined;

  return (
    <nav
      aria-label="Match Ops"
      className="flex h-full w-full flex-col gap-[2px] overflow-y-auto border-r px-[10px] py-[14px]"
      style={{ background: "linear-gradient(180deg,#fafbfa,#f6f9f7)", borderColor: "#e6ebe8" }}
    >
      {items.map((it) => {
        const active = pathname === it.href || pathname.startsWith(it.href + "/");
        const count = badgeCount(it.badge);
        const header =
          it.group !== lastGroup && !collapsed ? (
            <div key={`hd-${it.group}`} className="whitespace-nowrap px-[10px] pb-[6px] pt-[14px] text-[9.5px] font-[780] uppercase tracking-[0.13em] first:pt-[2px]" style={{ color: "#93a49b" }}>
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
              className={`relative flex min-h-[44px] items-center rounded-[11px] text-[13.5px] font-semibold transition ${
                collapsed ? "justify-center px-0 py-[8px]" : "gap-[10px] px-[10px] py-[8px]"
              } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#35c77f]`}
              style={
                active
                  ? { background: "#ffffff", color: "#0f3d2e", boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 14px 30px -22px rgba(7,42,32,.5)" }
                  : { color: "#3f544a" }
              }
            >
              {active && (
                <span aria-hidden className="absolute left-[-10px] top-[9px] bottom-[9px] w-[3px] rounded-r-[3px]" style={{ background: "#35c77f" }} />
              )}
              <span className="flex-none [&_svg]:h-[17px] [&_svg]:w-[17px]" style={{ color: active ? "#14764c" : "#3f544a", opacity: active ? 1 : 0.72, strokeWidth: 1.9 }}>
                {it.icon}
              </span>
              {!collapsed && (
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{it.label}</span>
              )}
              {!collapsed && typeof count === "number" && count > 0 && (
                <span
                  className="ml-auto rounded-full px-[7px] py-[1px] text-[11px] font-bold tabular-nums"
                  style={active ? { background: "#e0f2e7", color: "#12704a" } : { background: "rgba(0,0,0,.045)", color: "#8d9c94" }}
                >
                  {count}
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
          className={`flex min-h-[44px] w-full items-center rounded-[11px] py-[8px] text-[12.5px] font-semibold transition hover:bg-white/70 ${
            collapsed ? "justify-center px-0" : "gap-[10px] px-[10px]"
          }`}
          style={{ color: "#8d9c94" }}
        >
          <span className="flex-none [&_svg]:h-4 [&_svg]:w-4" style={{ strokeWidth: 2, transform: collapsed ? "rotate(180deg)" : undefined }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 6l-6 6 6 6" /></svg>
          </span>
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </nav>
  );
}
