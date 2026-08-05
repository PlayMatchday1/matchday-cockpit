"use client";

// Master Schedule — Veo coverage (spec: mockups/veo-v1.html). A Schedule view of
// per-city match cards (toggle camera intent) and a Veo coverage grid + worklist
// diff between Clubhouse intent and the 🎥 app emoji. Data + mutations via
// /api/veo. Gate unchanged: page="cities".

import PagePermissionGuard from "@/components/PagePermissionGuard";
import VeoMasterSchedule from "@/components/VeoMasterSchedule";

export default function MasterSchedulePage() {
  return (
    <PagePermissionGuard page="cities">
      <VeoMasterSchedule />
    </PagePermissionGuard>
  );
}
