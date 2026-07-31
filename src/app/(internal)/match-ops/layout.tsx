"use client";

// Match Ops section shell: a left sub-nav (Chats, Field Pipeline) beside the
// content. Sub-nav items are filtered to what the current user can reach, so
// the rail never offers a dead link (page-level guards still enforce access on
// the routes themselves).
//
// Exception: /match-ops/chats is a full-viewport locked shell (its own 100dvh
// layout, special-cased in AuthGate). A left rail beside it would require
// changing how Chats sizes itself — out of scope ("relocation, not a rewrite").
// So on the Chats sub-route we render children full-bleed with no rail; the
// rail (with both items) shows on Field Pipeline, and the top-level Match Ops
// tab is the way back. Listed as a contradiction in the ship report.

import { usePathname } from "next/navigation";
import SectionSideNav, { type SectionNavItem } from "@/components/SectionSideNav";
import { canAccess, useAuth } from "@/lib/useAuth";

export default function MatchOpsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { appUser } = useAuth();
  const pathname = usePathname();

  const items: SectionNavItem[] = [];
  if (canAccess(appUser, "chats"))
    items.push({ label: "Chats", href: "/match-ops/chats" });
  if (canAccess(appUser, "clubhouse"))
    items.push({ label: "Field Pipeline", href: "/match-ops/field-pipeline" });

  // Chats owns the full viewport — render it without the rail.
  const isChats = pathname?.startsWith("/match-ops/chats") ?? false;
  if (isChats) return <>{children}</>;

  return (
    <div className="flex flex-col min-[900px]:flex-row">
      {items.length > 0 && <SectionSideNav items={items} ariaLabel="Match Ops" />}
      <div className="min-w-0 flex-1 p-4 sm:p-6">{children}</div>
    </div>
  );
}
