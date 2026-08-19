"use client";

// Match Promotion — the weekly push plan (spec: mockups/mktg-v3.html). Reads the mdapi mirror
// read-only through /api/match-promotion and writes only match_promotion_plan, server-side.
// Gate: page="matchops" — the checkbox is the access control, and there is no is_admin term.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import MatchPromotionView from "@/components/MatchPromotionView";

export default function MatchPromotionPage() {
  return (
    <PagePermissionGuard page="matchops">
      <MatchPromotionView />
    </PagePermissionGuard>
  );
}
