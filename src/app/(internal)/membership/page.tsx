"use client";

// Membership — a section of Player Lifecycle, reached from that rail. It was its own top-level tab
// from 2026-08-02 (when it moved out of the Growth page's ?tab=membership lens, same component and
// same data, gated on the Membership permission split out of the old Cities gate) until the rail
// move. /lifecycle (formerly /growth) ?tab=membership still permanently redirects here, and so does every bookmark: the
// URL has not changed.
//
// THE GUARD MOVED UP, not away — MembershipShell wraps this page in the same
// PagePermissionGuard page="membership" it used to declare itself, so the rail is not drawn for
// someone the page would then refuse.

import MembershipView from "@/components/MembershipView";

export default function MembershipPage() {
  return (
    <>
      <MembershipView />
    </>
  );
}
