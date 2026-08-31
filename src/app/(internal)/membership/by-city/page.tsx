"use client";

// Members by City — a section of Membership, which is itself a section of Player Lifecycle.
//
// NO SHELL AND NO GUARD DECLARED HERE. src/app/(internal)/membership/layout.tsx already wraps
// everything under /membership in MembershipShell, which is PagePermissionGuard page="membership"
// plus LifecycleRail. Declaring either again would double-mount the rail.

import MembersByCityView from "@/components/MembersByCityView";

export default function MembersByCityPage() {
  return <MembersByCityView />;
}
