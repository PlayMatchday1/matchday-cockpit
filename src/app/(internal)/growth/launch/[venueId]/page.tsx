"use client";

// ONE FIELD'S LAUNCH PLAN. The id in the route is the fin_venues row, because that is where the
// launch date lives and every date on the page is computed from it.
//
// NO PagePermissionGuard HERE — GrowthShell holds it for the section. See ../page.tsx.

import { use } from "react";
import LaunchPlanView from "@/components/LaunchPlanView";

export default function LaunchPlanPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = use(params);
  const id = Number(venueId);
  /* A NON-NUMERIC id IS A TYPO, NOT A FIELD. Saying so beats rendering a plan for NaN, which reads
   * as a field that exists and has no tasks. */
  if (!Number.isFinite(id)) {
    return <p style={{ padding: 24, fontSize: 13 }}>That is not a field id.</p>;
  }
  return <LaunchPlanView venueId={id} />;
}
