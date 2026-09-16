"use client";

// Growth › Competitors — what Plei and GoodRec are selling, next to what we sell.
//
// NO PagePermissionGuard HERE. GrowthShell holds it for the whole section, so a new Growth page
// cannot ship ungated by forgetting a wrapper.

import CompetitorsView from "@/components/CompetitorsView";

export default function CompetitorsPage() {
  return <CompetitorsView />;
}
