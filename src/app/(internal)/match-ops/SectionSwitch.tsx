"use client";

// Phase 24 (corrected) — the DAILY OPS / BACK OFFICE switch, in the sidebar.
//
// It sits ABOVE the group headings and picks which half of Match Ops the rail lists. It is a
// switch between two halves of ONE section, which is why it is not a top-level nav tab.
//
// NO NEW STATE. The active half is derived from the current route via tabForPath — exactly as
// before, just driving the rail instead of the header. Clicking a half navigates to the FIRST ITEM
// OF THAT HALF THE VIEWER CAN OPEN (firstSectionHref reads the same permission-filtered list the
// rail draws), so the switch can never point at a route the viewer would be bounced from.
//
// ROUTES DID NOT MOVE. Crossing halves is an ordinary in-layout navigation, which is the only
// reason the docked chat and its single realtime subscription survive it.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { MATCH_OPS_TABS, tabForPath, firstSectionHref } from "./sections";

export default function SectionSwitch({ collapsed = false }: { collapsed?: boolean }) {
  const { appUser } = useAuth();
  const pathname = usePathname() ?? "";
  const active = tabForPath(pathname);

  // A half with nothing the viewer may open is not shown — a switch to an empty list is a control
  // that looks live and does nothing.
  const halves = MATCH_OPS_TABS.map((t) => ({ ...t, target: firstSectionHref(appUser, t.tab) }))
    .filter((t) => !!t.target);
  if (halves.length < 2) return null;

  if (collapsed) {
    // Collapsed rail: initials only, same targets, still shows which half is live.
    return (
      <div data-testid="section-switch" data-collapsed="true" className="mb-2 flex flex-col gap-1">
        {halves.map((t) => (
          <Link key={t.tab} href={t.target!} title={t.label}
            data-testid="section-switch-item" data-tab={t.tab} data-active={t.tab === active ? "true" : "false"}
            aria-current={t.tab === active ? "page" : undefined}
            className="flex h-8 items-center justify-center rounded-[9px] text-[11px] font-[800]"
            style={t.tab === active
              ? { background: "#0d3b2e", color: "#fff" }
              : { background: "#eef3f0", color: "#5c7267" }}>
            {t.label.split(" ").map((w) => w[0]).join("")}
          </Link>
        ))}
      </div>
    );
  }

  return (
    <div data-testid="section-switch" className="mb-2 grid grid-cols-2 gap-1 rounded-[10px] p-1" style={{ background: "#eef3f0" }}>
      {halves.map((t) => (
        <Link key={t.tab} href={t.target!}
          data-testid="section-switch-item" data-tab={t.tab} data-active={t.tab === active ? "true" : "false"}
          aria-current={t.tab === active ? "page" : undefined}
          className="flex min-h-[32px] items-center justify-center whitespace-nowrap rounded-[8px] px-2 text-[11.5px] font-[750] transition"
          style={t.tab === active
            ? { background: "#ffffff", color: "#072a20", boxShadow: "0 1px 2px rgba(7,42,32,.10)" }
            : { background: "transparent", color: "#5c7267" }}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
