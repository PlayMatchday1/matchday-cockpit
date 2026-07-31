"use client";

// Tech section shell — same generic left sub-nav as Match Ops. One item this
// round (Tech Roadmap, relocated off Home).

import SectionSideNav, { type SectionNavItem } from "@/components/SectionSideNav";
import { canAccess, useAuth } from "@/lib/useAuth";

export default function TechLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { appUser } = useAuth();
  const items: SectionNavItem[] = [];
  if (canAccess(appUser, "clubhouse"))
    items.push({ label: "Tech Roadmap", href: "/tech/tech-roadmap" });

  return (
    <div className="flex flex-col min-[900px]:flex-row">
      {items.length > 0 && <SectionSideNav items={items} ariaLabel="Tech" />}
      <div className="min-w-0 flex-1 p-4 sm:p-6">{children}</div>
    </div>
  );
}
