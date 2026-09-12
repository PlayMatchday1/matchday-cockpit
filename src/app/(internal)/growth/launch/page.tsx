"use client";

// LAUNCHES — the index, and the landing page for the launch plans.
//
// NO PagePermissionGuard HERE. GrowthShell holds it for the whole section, the way
// /growth/field-pipeline and /growth/daily-matches do. field_launch_tasks carries its own gate
// besides (migration 0173): the same kanban_board_readable('field_pipeline') predicate the board
// uses governs every read and write at PostgREST, so a confined account querying the table
// directly gets nothing.

import LaunchIndex from "@/components/LaunchIndex";

export default function LaunchIndexPage() {
  return <LaunchIndex />;
}
