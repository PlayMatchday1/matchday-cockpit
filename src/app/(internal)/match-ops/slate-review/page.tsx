"use client";

// Slate Review — lives in the Match Ops rail, so it's gated like Match Ops:
// page="matchops" (the same permission Master Schedule, Reviews and Field Ops
// use), NOT finance. Anyone who can open Match Ops sees the whole page,
// including the Match P&L card. There is no finance sub-gate anywhere on it.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import SlateReviewView from "./SlateReviewView";

export const dynamic = "force-dynamic";

export default function SlateReviewPage() {
  return (
    <PagePermissionGuard page="matchops">
      <SlateReviewView />
    </PagePermissionGuard>
  );
}
