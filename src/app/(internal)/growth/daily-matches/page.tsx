"use client";

// 2026 DAILY MATCHES — the goal sheet, as a page that computes its own left-hand column.
//
// NO PagePermissionGuard HERE. GrowthShell holds it for the whole section, the way
// /growth/field-pipeline and /growth/vc-outreach do. The tables carry their own gate besides
// (migration 0170): growth_pages_readable() governs every read and write at PostgREST, so a
// confined account querying the table directly gets nothing.

import FieldGoals2026 from "@/components/FieldGoals2026";

export default function DailyMatchesPage() {
  return <FieldGoals2026 />;
}
