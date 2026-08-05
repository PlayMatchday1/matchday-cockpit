"use client";

// Tech section shell. The board picker (App Roadmap vs Clubhouse Roadmap) is a
// pair of proper selector cards (TechRoadmapNav), not the generic section rail —
// one rail, and an appealing one. Gated on Tech access.

import { canAccess, useAuth } from "@/lib/useAuth";
import TechRoadmapNav from "./TechRoadmapNav";

export default function TechLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { appUser } = useAuth();
  const showNav = canAccess(appUser, "tech");

  return (
    <div className="flex flex-col min-[900px]:flex-row">
      {showNav && <TechRoadmapNav />}
      <div className="min-w-0 flex-1 p-4 sm:p-6">{children}</div>
    </div>
  );
}
