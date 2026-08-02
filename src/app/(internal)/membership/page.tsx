"use client";

// Membership — its own top-level tab. Moved out of the Growth page's
// ?tab=membership lens on 2026-08-02 (same component, same data, same gate:
// can_access_cities, so the move does not widen access). /growth?tab=membership
// permanently redirects here.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import CitiesMembershipLens from "@/components/CitiesMembershipLens";

export default function MembershipPage() {
  return (
    <PagePermissionGuard page="cities">
      <div className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight text-deep-green">
          Membership
        </h1>
        <p className="mt-1 text-sm text-deep-green/70">
          Members and retention across markets.
        </p>
      </div>
      <CitiesMembershipLens />
    </PagePermissionGuard>
  );
}
