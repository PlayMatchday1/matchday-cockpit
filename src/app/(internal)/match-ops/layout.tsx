"use client";

// Match Ops section shell: a grouped left rail beside the content. Rail items
// are filtered to what the current user can actually open (a bounce is worse
// than a hidden item), and each route keeps its own gate — the rail is a
// convenience, not the security boundary.
//
// Groups (mockup match-ops-v1): OPERATIONS (Master Schedule, Field Pipeline,
// Field Ops, Review[admins]) and CONVERSATIONS (Match Chats, Player Chats).
//
// The chat routes render a 100dvh shell; the rail is sticky (SectionSideNav sets
// position:sticky at >=900px) and lives in a flex row beside the content, so it
// stays visible while only the message list scrolls internally.

import { usePathname } from "next/navigation";
import SectionSideNav, { type SectionNavItem } from "@/components/SectionSideNav";
import { canAccess, useAuth } from "@/lib/useAuth";
import { useCrmUnreadCount } from "@/lib/useCrmUnreadCount";

export default function MatchOpsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { appUser } = useAuth();
  const pathname = usePathname() ?? "";
  // Cheap, already-available count: unread player (customer) chats. "A human
  // needs to act" → alert tone. Only rendered when > 0 (SectionSideNav omits 0).
  const crmUnread = useCrmUnreadCount();

  // The two chat consoles (Match Chats + Player Chats) own a full-bleed
  // multi-pane layout with their own icon rail (ChatsRail), so the shared
  // SectionSideNav is suppressed on THOSE routes only — every other Match Ops
  // page keeps the shared rail byte-for-byte. The shared SectionSideNav
  // component itself is untouched. See the chat consoles' page.tsx.
  if (
    pathname.startsWith("/match-ops/match-chats") ||
    pathname.startsWith("/match-ops/player-chats")
  ) {
    return <>{children}</>;
  }

  const canCities = canAccess(appUser, "cities");
  const canClub = canAccess(appUser, "clubhouse");
  const canChats = canAccess(appUser, "chats");
  const isAdmin = !!appUser?.is_admin;

  const items: SectionNavItem[] = [];
  if (canCities)
    items.push({ group: "Operations", label: "Master Schedule", href: "/match-ops/master-schedule" });
  if (canClub)
    items.push({ group: "Operations", label: "Field Pipeline", href: "/match-ops/field-pipeline" });
  if (canCities)
    items.push({ group: "Operations", label: "Field Ops", href: "/match-ops/field-ops" });
  if (isAdmin)
    items.push({ group: "Operations", label: "Review", href: "/match-ops/review" });
  if (canChats) {
    items.push({ group: "Conversations", label: "Match Chats", href: "/match-ops/match-chats" });
    items.push({
      group: "Conversations",
      label: "Player Chats",
      href: "/match-ops/player-chats",
      count: crmUnread,
      tone: "alert",
    });
  }

  return (
    <div className="min-[900px]:flex min-[900px]:items-start min-[900px]:gap-6">
      {items.length > 0 && <SectionSideNav items={items} ariaLabel="Match Ops" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
