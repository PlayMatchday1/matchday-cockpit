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
];
