"use client";

// The Tech roadmap board picker — App Roadmap vs Clubhouse Roadmap. Replaces the
// generic blocky section rail with a pair of proper selector cards: an icon
// tile, the board name + a one-line subtitle, and the card count. The active
// board gets a mint wash, an accent spine, and a lift; inactive cards are quiet
// white with a hover raise. Stacks in the left rail on desktop, scrolls
// horizontally on mobile.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRoadmapBoardCounts } from "@/lib/useRoadmapBoardCounts";

const C = {
  forestDeep: "#072a20", forest: "#0d3b2e", accent: "#35c77f", mint: "#e0f2e7",
  ink: "#12241d", muted: "#6d7b74", line: "#e6ebe8", chipBg: "#eef3f0", chipLine: "#e2eae5",
  surface: "#ffffff",
};

// Short labels — "Roadmap" is implied by the ROADMAPS header, so the big line
// never truncates; the subtitle carries the context.
const BOARDS = [
  {
    key: "app", href: "/tech/tech-roadmap/app", name: "App", sub: "Player app", full: "App Roadmap",
    icon: (<><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M11 18.5h2" /></>),
  },
  {
    key: "clubhouse", href: "/tech/tech-roadmap/clubhouse", name: "Clubhouse", sub: "Internal tools", full: "Clubhouse Roadmap",
    icon: (<><path d="M3 10.5 12 4l9 6.5" /><path d="M5 10v10h14V10" /></>),
  },
] as const;

export default function TechRoadmapNav() {
  const pathname = usePathname() ?? "";
  const counts = useRoadmapBoardCounts();

  return (
    <nav
      aria-label="Roadmaps"
      className="flex shrink-0 gap-2 overflow-x-auto p-3 min-[900px]:sticky min-[900px]:top-6 min-[900px]:w-[236px] min-[900px]:flex-col min-[900px]:self-start min-[900px]:overflow-visible"
    >
      <div className="hidden px-1 pb-0.5 text-[10px] font-[800] uppercase tracking-[0.14em] min-[900px]:block" style={{ color: "#9aa8a1" }}>
        Roadmaps
      </div>
      {BOARDS.map((b) => {
        const active = pathname === b.href || pathname.startsWith(b.href + "/");
        const count = b.key === "app" ? counts.app : counts.clubhouse;
        return (
          <Link
            key={b.key}
            href={b.href}
            aria-label={b.full}
            aria-current={active ? "page" : undefined}
            className="group relative flex min-w-[210px] items-center gap-3 overflow-hidden rounded-[13px] border px-3 py-2.5 transition min-[900px]:min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#35c77f]"
            style={
              active
                ? { background: "linear-gradient(180deg,#effaf3,#ffffff)", borderColor: "#bfe2cf", boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 12px 26px -20px rgba(7,42,32,.5)" }
                : { background: C.surface, borderColor: C.line }
            }
          >
            {/* accent spine on the active board */}
            {active && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-[3px]" style={{ background: C.accent }} />}
            <span
              aria-hidden
              className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] transition"
              style={active ? { background: C.mint, color: C.forest } : { background: C.chipBg, color: C.muted }}
            >
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                {b.icon}
              </svg>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-[800] tracking-[-0.01em]" style={{ color: active ? C.forestDeep : C.ink }}>
                {b.name}
              </span>
              <span className="block truncate text-[11px] font-semibold" style={{ color: C.muted }}>{b.sub}</span>
            </span>
            <span
              className="flex-none rounded-full px-[9px] py-[2px] text-[11.5px] font-[800] tabular-nums"
              style={active ? { background: C.surface, border: "1px solid #bfe0cd", color: C.forest } : { background: C.chipBg, border: `1px solid ${C.chipLine}`, color: C.muted }}
            >
              {count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
