"use client";

// THE GROWTH RAIL — six items, flat, in the order a reader walks the player journey: how they
// arrive, what they do, what they are worth, whether they stay, whether they leave, and the raw
// rows behind all of it.
//
// FLAT ON PURPOSE. No Daily Ops / Back Office style switch and no group headings: that switch
// exists to divide a fourteen-item estate, and six items in one section is a list. ChatsRail
// already suppresses headings when every item shares a group, so `group: ""` gives a bare list.
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

export const GROWTH_SECTIONS: RailItem[] = [
  {
    key: "growth-funnel", group: "", label: "Player Funnel", href: "/growth/funnel",
    desc: "Download to registration to a fifth match",
    icon: <I><path d="M3 4.5h18l-7 8.5v6.5l-4 2v-8.5z" /></I>,
  },
  {
    key: "growth-behavior", group: "", label: "Player Behavior", href: "/growth/behavior",
    desc: "How playing habits change month over month",
    icon: <I><path d="M4 19V5" /><path d="M4 15l4.5-4.5 3.5 3.5L20 6" /><circle cx="20" cy="6" r="1.6" /></I>,
  },
  {
    key: "growth-arpp", group: "", label: "Revenue per Player", href: "/growth/revenue-per-player",
    desc: "What an active player is worth per month",
    icon: <I><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v9M14.6 9.8c-.6-.8-1.6-1.2-2.6-1.2-1.4 0-2.5.8-2.5 1.9 0 2.6 5.2 1.4 5.2 4 0 1.2-1.2 2-2.7 2-1.1 0-2.2-.5-2.7-1.3" /></I>,
  },
  {
    key: "growth-retention", group: "", label: "Retention", href: "/growth/retention",
    desc: "Cohort curves and the month-by-month matrix",
    icon: <I><path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" /><circle cx="7.5" cy="6.5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="16.5" cy="17.5" r="1.8" /></I>,
  },
  {
    key: "growth-churn", group: "", label: "Churn", href: "/growth/churn",
    desc: "Who has stopped playing, and when they last did",
    icon: <I><path d="M4 5v14" /><path d="M4 8l5 4.5-3.2 3.5" /><path d="M20 6l-6.5 6.5L20 19" /></I>,
  },
  {
    key: "growth-dataroom", group: "", label: "Player Data Room", href: "/growth/data-room",
    desc: "The rows behind every number on the other five",
    icon: <I><ellipse cx="12" cy="6" rx="7.5" ry="3" /><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" /><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" /></I>,
  },
];
