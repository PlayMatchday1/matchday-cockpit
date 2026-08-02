"use client";

// Tech section shell. The section sidebar IS the roadmap picker now — App
// Roadmap + Clubhouse Roadmap, each with its card-count badge — instead of a
// single "Tech Roadmap" item wrapping a second in-page rail (two nested rails
// holding one item was an accident, not navigation). Each item is a real link to
// its board's URL; the active board gets the sidebar's active state.

import SectionSideNav, { type SectionNavItem } from "@/components/SectionSideNav";
import { canAccess, useAuth } from "@/lib/useAuth";
import { useRoadmapBoardCounts } from "@/lib/useRoadmapBoardCounts";

export default function TechLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { appUser } = useAuth();
  const counts = useRoadmapBoardCounts();
  const items: SectionNavItem[] = [];
  if (canAccess(appUser, "clubhouse")) {
    items.push({ label: "App Roadmap", href: "/tech/tech-roadmap/app", count: counts.app });
    items.push({ label: "Clubhouse Roadmap", href: "/tech/tech-roadmap/clubhouse", count: counts.clubhouse });
  }

  return (
    <div className="flex flex-col min-[900px]:flex-row">
      {items.length > 0 && <SectionSideNav items={items} ariaLabel="Tech" />}
      <div className="min-w-0 flex-1 p-4 sm:p-6">{children}</div>
    </div>
  );
}
