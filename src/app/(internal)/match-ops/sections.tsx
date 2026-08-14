"use client";

// THE Match Ops navigation list — one array, one file. Every Match Ops nav
// surface (the desktop rail ChatsRail, the mobile MatchOpsMobileBar, and the
// section layout's access gate) reads from here. Previously the list lived in
// three places (layout.tsx, ChatsRail.tsx, and the mobile header) and drifted;
// one place per fact means they can't disagree again.
//
// `badge` names WHICH count feeds an item's badge, not a number — the count
// itself is fetched once by the shared hook and rendered by each surface, hidden
// at zero (a false zero is worse than no badge).

import type { AppUser, PageName } from "@/lib/useAuth";
import { canAccess, canManagePromos } from "@/lib/useAuth";

// Phase 24 — Match Ops is TWO TABS: what you do today, and what you manage over weeks.
// THE ROUTES DID NOT MOVE. Every href is still /match-ops/*, there is still ONE route group and
// ONE layout. This is a presentation split in the nav only, and it has to stay that way: the docked
// chat survives navigation solely because match-ops/layout.tsx does not remount between these
// routes. A second route group would mean a second layout, tearing down CrmConversationProvider and
// its crm-stream-v2 channel on every crossing — that is Phase 19 Step 3a destroyed. It would also
// churn every e2e path and break bookmarks. Keep the section in the DATA, never in the URL.
export type MatchOpsTab = "daily" | "back";
export type MatchOpsGroup =
  | "Operations" | "Conversations"                 // daily
  | "Scheduling" | "Fields" | "People" | "System"; // back office
// "promos" is a WRITE-grant gate (can_manage_promos), not a page-read gate — handled specially
// in visibleSections. The Promo Codes screen ships behind MANAGE PROMOS (Phase 18b).
export type MatchOpsAccess = "matchops" | "tech" | "chats" | "admin" | "finance" | "promos";

export type MatchOpsSection = {
  key: string;
  section: MatchOpsTab;
  group: MatchOpsGroup;
  label: string;
  href: string;
  desc: string; // one-line, used by the mobile sheet
  access: MatchOpsAccess;
  icon: React.ReactNode;
  badge?: "awaiting" | "manager-pay" | "partner-dashboards"; // which shared count feeds this item's badge
};

function I({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const MATCH_OPS_SECTIONS: MatchOpsSection[] = [
  // DAILY OPS — today's rhythm: 6 items in 2 groups.
  { key: "gameday", section: "daily", group: "Operations", label: "Gameday Ops", href: "/match-ops/gameday", desc: "Today's matches, soonest first — what's about to go wrong", access: "matchops", icon: <I><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I> },
  { key: "player-lookup", section: "daily", group: "Operations", label: "Player Lookup", href: "/match-ops/player-lookup", desc: "One player — account, membership, matches; add or remove them", access: "matchops", icon: <I><circle cx="11" cy="8" r="3.6" /><path d="M4 20a7 7 0 0 1 12.2-4.6" /><circle cx="17.5" cy="16.5" r="3.2" /><path d="M19.8 18.8 22 21" /></I> },
  { key: "promos", section: "daily", group: "Operations", label: "Promo Codes", href: "/match-ops/promos", desc: "Discount codes — live and past; create a new one", access: "promos", icon: <I><path d="M8.5 3.5h7l5 5v7l-5 5h-7l-5-5v-7z" /><circle cx="12" cy="12" r="2.4" /></I> },
  { key: "reviews", section: "daily", group: "Operations", label: "Reviews", href: "/match-ops/reviews", desc: "Per-match ratings and manager standings", access: "matchops", icon: <I><path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 9.7l5.4-.8z" /></I> },
  { key: "match-chats", section: "daily", group: "Conversations", label: "Match Chats", href: "/match-ops/match-chats", desc: "One WhatsApp group per match", access: "chats", icon: <I><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" /></I> },
  { key: "player-chats", section: "daily", group: "Conversations", label: "Player Chats", href: "/match-ops/player-chats", desc: "1:1 threads with players", access: "chats", icon: <I><circle cx="9" cy="8" r="3.4" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M17 7.5a3 3 0 0 1 0 6M18.5 20a6 6 0 0 0-3-5.2" /></I>, badge: "awaiting" },
  // BACK OFFICE — the weeks-long rhythm: 8 items in 4 groups.
  { key: "master", section: "back", group: "Scheduling", label: "Master Schedule", href: "/match-ops/master-schedule", desc: "Recurring weekly slots, by city", access: "matchops", icon: <I><rect x="3" y="4" width="18" height="17" rx="2.5" /><path d="M3 9h18M8 2v4M16 2v4" /></I> },
  { key: "slate-review", section: "back", group: "Scheduling", label: "Slate Review", href: "/match-ops/slate-review", desc: "Weekly per-city decision snapshot", access: "matchops", icon: <I><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h8M8 17h5" /></I> },
  { key: "pipeline", section: "back", group: "Fields", label: "Field Pipeline", href: "/match-ops/field-pipeline", desc: "Venues we're still chasing", access: "tech", icon: <I><path d="M3 5h18l-7 8v6l-4 2v-8z" /></I> },
  { key: "ops", section: "back", group: "Fields", label: "Field Ops", href: "/match-ops/field-ops", desc: "Tonight's fields and staff", access: "matchops", icon: <I><rect x="2.5" y="5.5" width="19" height="13" rx="2" /><path d="M12 5.5v13" /><circle cx="12" cy="12" r="3" /></I> },
  { key: "inventory", section: "back", group: "Fields", label: "Inventory", href: "/match-ops/inventory", desc: "Balls, bibs and manager reports", access: "matchops", icon: <I><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></I> },
  { key: "manager-pay", section: "back", group: "People", label: "Manager Pay", href: "/match-ops/manager-pay", desc: "What each manager is owed, and the Gusto file", access: "matchops", icon: <I><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><circle cx="12" cy="12" r="2.6" /><path d="M6 9.5v5M18 9.5v5" /></I>, badge: "manager-pay" },
  { key: "partner-dashboards", section: "back", group: "People", label: "Partner Dashboards", href: "/match-ops/partner-dashboards", desc: "Per-venue revenue pages partners see at their link", access: "tech", icon: <I><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M7 20h10M7 9h5M7 13h9" /></I>, badge: "partner-dashboards" },
  { key: "change-log", section: "back", group: "System", label: "Change Log", href: "/match-ops/change-log", desc: "Every production write, and whether it landed", access: "matchops", icon: <I><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h6" /><circle cx="17.5" cy="16.5" r="2.2" /></I> },
];

// The sections this viewer may actually open (a bounce is worse than a hidden
// item). Every rail/strip filters through this — the gate is still each route's.
export function visibleSections(
  appUser: AppUser | null | undefined,
  tab?: MatchOpsTab,
): MatchOpsSection[] {
  return MATCH_OPS_SECTIONS.filter((s) =>
    (tab === undefined || s.section === tab) &&
    (s.access === "admin" ? !!appUser?.is_admin
     : s.access === "promos" ? canManagePromos(appUser) // WRITE-grant gate, not a page-read gate
     : canAccess(appUser ?? null, s.access as PageName)),
  );
}

// NO NEW PERMISSION. Whatever gates Match Ops gates both tabs identically — `access` is untouched
// above and nothing here consults the tab. The split decides which items a surface DRAWS, never who
// may open them; each route keeps its own gate.

// The ACTIVE TAB IS DERIVED from the route — there is no tab state anywhere. Longest href match
// wins so /match-ops/match-chats/automation resolves to its parent item.
export function tabForPath(pathname: string): MatchOpsTab {
  let best: MatchOpsSection | null = null;
  for (const s of MATCH_OPS_SECTIONS) {
    if (pathname === s.href || pathname.startsWith(s.href + "/")) {
      if (!best || s.href.length > best.href.length) best = s;
    }
  }
  // Bare /match-ops (and anything unrecognised) belongs to Daily Ops, which is where it redirects.
  return best ? best.section : "daily";
}

// The two top-nav tabs. href points at the first item of each tab so the nav can never link at a
// route that does not exist.
export const MATCH_OPS_TABS: { tab: MatchOpsTab; label: string; href: string }[] = [
  { tab: "daily", label: "Daily Ops", href: "/match-ops/gameday" },
  { tab: "back", label: "Back Office", href: "/match-ops/master-schedule" },
];

// THE MATCH OPS LANDING TARGET. Gameday Ops is the front door — it is what "Match Ops" means to
// someone tapping it — but a viewer who cannot open it must never be sent there. A city manager
// holds neither Gameday Ops nor most of Daily Ops, and a 403 on the section's own nav entry is
// worse than landing somewhere arbitrary. So: Gameday Ops if reachable, otherwise the first item in
// THIS viewer's own list (which is already permission-filtered), otherwise null for the caller to
// fall back on firstAllowedPath.
export function matchOpsLandingHref(appUser: AppUser | null | undefined): string | null {
  const daily = visibleSections(appUser, "daily");
  const gameday = daily.find((s) => s.key === "gameday");
  if (gameday) return gameday.href;
  return daily[0]?.href ?? visibleSections(appUser, "back")[0]?.href ?? null;
}

// Where a viewer should land inside a tab — the first item they can actually open.
export function firstSectionHref(appUser: AppUser | null | undefined, tab: MatchOpsTab): string | null {
  return visibleSections(appUser, tab)[0]?.href ?? null;
}
