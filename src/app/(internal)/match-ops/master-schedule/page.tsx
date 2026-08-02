"use client";

// Master Schedule — rebuilt (2026-08) as a Clubhouse ↔ MatchDay reconciliation
// view: the union of schedule_master (Clubhouse plan) and mdapi_matches
// (MatchDay), paired by count per slot. Replaces the old CitiesMasterScheduleLens
// presentation (Schedule Sync card + Changes-vs-last-week banner) with a
// reconciliation summary and per-slot source states. Copy last week / Reconcile
// now / Add session are kept (all Clubhouse-side). Gate unchanged: page="cities".

import PagePermissionGuard from "@/components/PagePermissionGuard";
import MasterScheduleReconcile from "@/components/MasterScheduleReconcile";

export default function MasterSchedulePage() {
  return (
    <PagePermissionGuard page="cities">
      <MasterScheduleReconcile />
    </PagePermissionGuard>
  );
}
