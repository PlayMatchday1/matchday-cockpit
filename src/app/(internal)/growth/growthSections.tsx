"use client";

// THE GROWTH RAIL — what the company does BEFORE a city has players: find the field, open the
// market, and prove it works. One item today; City Launches joins it when its thresholds are ruled
// on. Adding an item here is the whole job of adding a Growth page.
//
// NOT THE OTHER GROWTH. /growth and can_access_growth belonged to Player Lifecycle until
// 2026-08-23 and now mean this section — see docs/matchday-api-facts.md for why that rename
// happened and why the legacy redirects are enumerated rather than wildcarded.
//
// This is nav DATA. The rail component, the collapse behaviour and the mobile sheet are the app's
// own — see /lifecycle and /match-ops for the same arrangement.

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
    key: "field-pipeline", group: "Fields", label: "Field Pipeline", href: "/growth/field-pipeline",
    desc: "Venues we're still chasing",
    icon: <I><path d="M3 5h18l-7 8v6l-4 2v-8z" /></I>,
  },
  {
    // ONE ENTRY, POINTING AT THE INDEX. The per-field plan hangs off it at /growth/launch/[venueId]
    // and is reached from a card there or from the plan page's own field switcher — a rail item per
    // field would grow without bound and go stale the moment a launch finishes.
    key: "launch", group: "Fields", label: "Field Launches", href: "/growth/launch",
    desc: "The 20-week plan for each field we're opening",
    icon: <I><path d="M12 3v9m0 0 3.5-3.5M12 12 8.5 8.5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></I>,
  },
  {
    key: "daily-matches", group: "Fields", label: "2026 Daily Matches", href: "/growth/daily-matches",
    desc: "The goal per field, and where it stands",
    icon: <I><path d="M3 20h18M6 20V10m5 10V4m5 16v-7" /></I>,
  },
  {
    key: "vc-outreach", group: "Fundraising", label: "VC Outreach", href: "/growth/vc-outreach",
    desc: "Firms we're raising from",
    icon: <I><path d="M4 19V9m5 10V5m5 14v-7m5 7V8" /></I>,
  },
];
