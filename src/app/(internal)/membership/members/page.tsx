"use client";

// Members — the Retool MEMBERSHIPS page, rebuilt. A section of Membership, inside Player Lifecycle.
//
// NO SHELL AND NO GUARD DECLARED HERE. src/app/(internal)/membership/layout.tsx already wraps
// everything under /membership in MembershipShell (PagePermissionGuard page="membership" plus
// LifecycleRail). Declaring either again would double-mount the rail.

import MembersView from "@/components/MembersView";

export default function MembersPage() {
  return <MembersView />;
}
