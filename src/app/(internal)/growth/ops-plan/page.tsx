"use client";

// 2027 OPERATIONS PLAN. NO PagePermissionGuard HERE: GrowthShell holds it for the whole section, as
// it does for /growth/daily-matches. 0199's tables carry their own gate besides —
// growth_pages_readable() governs every read and write at PostgREST.

import OpsPlan2027 from "@/components/OpsPlan2027";

export default function OpsPlanPage() {
  return <OpsPlan2027 />;
}
