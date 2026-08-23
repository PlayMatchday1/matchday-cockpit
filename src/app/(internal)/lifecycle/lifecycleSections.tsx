"use client";

// THE PLAYER LIFECYCLE RAIL — the six analytics sections, then Membership, which used to be its
// own top-nav tab. Reports read in the order a player is walked: how they arrive, what they do,
// what they are worth, whether they stay, whether they leave, and the rows behind all of it.
//
// GROUPED, AS OF THE MEMBERSHIP MOVE. This list was deliberately flat — an empty group on each item,
// which ChatsRail renders as a bare list. A second group forces headings on (a single group is not
// structure, two are), so the original six needed a name; REPORTS matches the one-word vocabulary
// the Finance rail already uses, and it is what they are.
//
// MEMBERSHIP KEEPS ITS URL. /membership is not under /lifecycle and is not being moved there —
// renaming the path would break bookmarks and buy nothing, since the rail does not care what the
// path says. The rail is mounted on that route by its own shell, which guards on the MEMBERSHIP
// permission rather than this section's.
//
// THE NAME IS THE SAME EVERYWHERE NOW. Route, file, export and label all say lifecycle — the
// mismatch that used to be explained here is gone, and /growth belongs to the Growth tab.
//
// This is nav DATA. The rail component, the collapse behaviour and the mobile sheet are the app's
// own — see /city/citySections for the same arrangement.

import type { RailItem } from "../match-ops/sections";

function I({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const LIFECYCLE_SECTIONS: RailItem[] = [
  {
    key: "growth-funnel", group: "Reports", label: "Player Funnel", href: "/lifecycle/funnel",
    desc: "Download to registration to a fifth match",
    icon: <I><path d="M3 4.5h18l-7 8.5v6.5l-4 2v-8.5z" /></I>,
  },
  {
    key: "growth-behavior", group: "Reports", label: "Player Behavior", href: "/lifecycle/behavior",
    desc: "How playing habits change month over month",
    icon: <I><path d="M4 19V5" /><path d="M4 15l4.5-4.5 3.5 3.5L20 6" /><circle cx="20" cy="6" r="1.6" /></I>,
  },
  {
    key: "growth-arpp", group: "Reports", label: "Revenue per Player", href: "/lifecycle/revenue-per-player",
    desc: "What an active player is worth per month",
    icon: <I><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v9M14.6 9.8c-.6-.8-1.6-1.2-2.6-1.2-1.4 0-2.5.8-2.5 1.9 0 2.6 5.2 1.4 5.2 4 0 1.2-1.2 2-2.7 2-1.1 0-2.2-.5-2.7-1.3" /></I>,
  },
  {
    key: "growth-retention", group: "Reports", label: "Retention", href: "/lifecycle/retention",
    desc: "Cohort curves and the month-by-month matrix",
    icon: <I><path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" /><circle cx="7.5" cy="6.5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="16.5" cy="17.5" r="1.8" /></I>,
  },
  {
    key: "growth-churn", group: "Reports", label: "Churn", href: "/lifecycle/churn",
    desc: "Who has stopped playing, and when they last did",
    icon: <I><path d="M4 5v14" /><path d="M4 8l5 4.5-3.2 3.5" /><path d="M20 6l-6.5 6.5L20 19" /></I>,
  },
  {
    key: "growth-dataroom", group: "Reports", label: "Player Data Room", href: "/lifecycle/data-room",
    desc: "The rows behind every number on the other five",
    icon: <I><ellipse cx="12" cy="6" rx="7.5" ry="3" /><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" /><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" /></I>,
  },
  // ONE ITEM, ONE GROUP. Membership was a single-page top-nav tab with no sub-rail of its own, so
  // there is nothing here to flatten and no structure lost in the move.
  {
    key: "membership", group: "Membership", label: "Membership", href: "/membership",
    desc: "Members and retention across markets",
    icon: <I><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" /><path d="M16 5.6a3.2 3.2 0 0 1 0 5.8" /><path d="M17.5 14.9c1.9.6 3 2.3 3 4.6" /></I>,
  },
];

// The section a rail item belongs to, for the two shells that mount this list: the six reports are
// gated on `lifecycle`, Membership on `membership`. A user with one permission and not the other sees
// only their half rather than links that bounce off a guard.
export const SECTION_PAGE: Record<string, "lifecycle" | "membership"> = {
  membership: "membership",
};
