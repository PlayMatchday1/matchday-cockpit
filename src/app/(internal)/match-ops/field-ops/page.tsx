"use client";

// Field Ops — relocated from the Growth page's ?tab=fields lens to Match Ops.
// Same component (FieldOpsLens), same queries, same ?fo= sub-state. The only
// change to the lens itself was making its URL base location-agnostic
// (usePathname instead of a hardcoded "/growth"). Gate unchanged: was inside
// Growth's page="cities" guard, stays gated on can_access_cities.

import { Suspense } from "react";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import FieldOpsLens from "@/components/FieldOpsLens";

export default function FieldOpsPage() {
  return (
    <PagePermissionGuard page="cities">
      <Suspense fallback={null}>
        <FieldOpsLens />
      </Suspense>
    </PagePermissionGuard>
  );
}
