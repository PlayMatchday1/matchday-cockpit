"use client";

// Tech section shell. The board picker (App Roadmap vs Clubhouse Roadmap) is a
// pair of proper selector cards (TechRoadmapNav), not the generic section rail —
// one rail, and an appealing one. Gated on Tech access.

import { canAccess, useAuth } from "@/lib/useAuth";
import { useSectionNav } from "@/components/SectionNav";
import type { RailItem } from "../match-ops/sections";
import TechRoadmapNav from "./TechRoadmapNav";

/* ── TECH HAD NO MOBILE BAR AT ALL ────────────────────────────────────────────────────────────
 * Three routes with sub-pages and, on a phone, no way to move between them except the browser's
 * back button. TechRoadmapNav is a desktop selector; below the rail breakpoint it is the only nav
 * and it was not reachable as one. These are the same two boards it draws, as a published list.
 *
 * ICONS MATCH THE RAIL'S SHAPE (a 24-box stroked path) so the sheet's icon tile renders the same
 * as every other section's. */
const I = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

const TECH_SECTIONS: RailItem[] = [
  { key: "app", group: "Roadmaps", label: "App Roadmap", href: "/tech/tech-roadmap/app",
    desc: "Player app", icon: <I d="M7 3h10v18H7zM11 19h2" /> },
  { key: "clubhouse", group: "Roadmaps", label: "Clubhouse Roadmap", href: "/tech/tech-roadmap/clubhouse",
    desc: "Internal tools", icon: <I d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /> },
];

export default function TechLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { appUser } = useAuth();
  const showNav = canAccess(appUser, "tech");
  useSectionNav(showNav ? { items: TECH_SECTIONS, label: "Tech", showSwitch: false } : null);

  return (
    <div className="flex flex-col min-[900px]:flex-row">
      {showNav && <TechRoadmapNav />}
      <div className="min-w-0 flex-1 p-4 sm:p-6">{children}</div>
    </div>
  );
}
