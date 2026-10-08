"use client";

// Locations — where players say they live, against our cities and fields. Overview and Map tabs,
// both Supabase only (/api/growth/locations and /api/growth/locations/map).
//
// MOVED FROM MATCH OPS (2026-10-08). GrowthShell supplies the guard (page="growth") for every Growth
// page, so this page carries none of its own; /match-ops/locations 308s here (next.config.ts).
// Suspense because LocationsBoard reads the tab from the URL (useSearchParams), as Manager Pay does.

import { Suspense } from "react";
import LocationsBoard from "@/components/LocationsBoard";

export default function LocationsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-[#6d7b74]">Loading locations…</div>}>
      <LocationsBoard />
    </Suspense>
  );
}
