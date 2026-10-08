"use client";

// Locations — where players say they live, and adoption of the in-app area prompt. Data via
// /api/matchops/locations (Supabase only). Gate: page="matchops".

import PagePermissionGuard from "@/components/PagePermissionGuard";
import LocationsBoard from "@/components/LocationsBoard";

export default function LocationsPage() {
  return (
    <PagePermissionGuard page="matchops">
      <LocationsBoard />
    </PagePermissionGuard>
  );
}
