"use client";

// Master Schedule — relocated from the Growth page's ?tab=master-schedule lens
// to Match Ops. Same component (CitiesMasterScheduleLens, all-cities view, no
// city prop), same query, same data. Gate is unchanged: it was inside Growth's
// PagePermissionGuard page="cities", so it stays gated on can_access_cities —
// the move does not widen access.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import CitiesMasterScheduleLens from "@/components/CitiesMasterScheduleLens";

export default function MasterSchedulePage() {
  return (
    <PagePermissionGuard page="cities">
      <CitiesMasterScheduleLens masterSchedule />
    </PagePermissionGuard>
  );
}
