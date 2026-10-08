"use client";

// Locations — where players say they live, and adoption of the in-app area prompt. Overview and Map
// tabs, both Supabase only (/api/matchops/locations and /locations/map). Gate: page="matchops".

import { Suspense } from "react";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import LocationsBoard from "@/components/LocationsBoard";

// Suspense because LocationsBoard reads the tab from the URL (useSearchParams), as Manager Pay does.
export default function LocationsPage() {
  return (
    <PagePermissionGuard page="matchops">
      <Suspense fallback={<div className="p-8 text-sm text-[#6d7b74]">Loading locations…</div>}>
        <LocationsBoard />
      </Suspense>
    </PagePermissionGuard>
  );
}
