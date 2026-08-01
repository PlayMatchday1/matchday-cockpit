"use client";

// THE Match Ops navigation list — one array, one file. Every Match Ops nav
// surface (the desktop rail ChatsRail, the mobile MatchOpsMobileStrip, and the
// section layout's access gate) reads from here. Previously the list lived in
// three places (layout.tsx, ChatsRail.tsx, MatchOpsMobileStrip.tsx) and drifted;
// one place per fact means they can't disagree again.
//
// `badge` names WHICH count feeds an item's badge, not a number — the count
// itself is fetched once by the shared hook and rendered by each surface, hidden
// at zero (a false zero is worse than no badge).

import type { AppUser } from "@/lib/useAuth";
import { canAccess } from "@/lib/useAuth";

export type MatchOpsGroup = "Operations" | "Conversations";
export type MatchOpsAccess = "cities" | "clubhouse" | "chats" | "admin";

export type MatchOpsSection = {
  key: string;
  group: MatchOpsGroup;
  label: string;
  href: string;
  desc: string; // one-line, used by the mobile sheet
  access: MatchOpsAccess;
  icon: React.ReactNode;
  badge?: "awaiting"; // which shared count feeds this item's badge
};

function I({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const MATCH_OPS_SECTIONS: MatchOpsSection[] = [
  { key: "master", group: "Operations", label: "Master Schedule", href: "/match-ops/master-schedule", desc: "Recurring weekly slots, by city", access: "cities", icon: <I><rect x="3" y="4" width="18" height="17" rx="2.5" /><path d="M3 9h18M8 2v4M16 2v4" /></I> },
  { key: "pipeline", group: "Operations", label: "Field Pipeline", href: "/match-ops/field-pipeline", desc: "Venues we're still chasing", access: "clubhouse", icon: <I><path d="M3 5h18l-7 8v6l-4 2v-8z" /></I> },
  { key: "ops", group: "Operations", label: "Field Ops", href: "/match-ops/field-ops", desc: "Tonight's fields and staff", access: "cities", icon: <I><rect x="2.5" y="5.5" width="19" height="13" rx="2" /><path d="M12 5.5v13" /><circle cx="12" cy="12" r="3" /></I> },
  { key: "review", group: "Operations", label: "Review", href: "/match-ops/review", desc: "Slots waiting on a decision", access: "admin", icon: <I><path d="M9 11l2.5 2.5L16 8" /><rect x="3" y="3.5" width="18" height="17" rx="2.5" /></I> },
  { key: "match-chats", group: "Conversations", label: "Match Chats", href: "/match-ops/match-chats", desc: "One WhatsApp group per match", access: "chats", icon: <I><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" /></I> },
  { key: "player-chats", group: "Conversations", label: "Player Chats", href: "/match-ops/player-chats", desc: "1:1 threads with players", access: "chats", icon: <I><circle cx="9" cy="8" r="3.4" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M17 7.5a3 3 0 0 1 0 6M18.5 20a6 6 0 0 0-3-5.2" /></I>, badge: "awaiting" },
];

// The sections this viewer may actually open (a bounce is worse than a hidden
// item). Every rail/strip filters through this — the gate is still each route's.
export function visibleSections(appUser: AppUser | null | undefined): MatchOpsSection[] {
  return MATCH_OPS_SECTIONS.filter((s) =>
    s.access === "admin" ? !!appUser?.is_admin : canAccess(appUser ?? null, s.access),
  );
}
