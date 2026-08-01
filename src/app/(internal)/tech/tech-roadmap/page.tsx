"use client";

// Tech Roadmap — App + Clubhouse boards (mockup docs/mockups/roadmap-v1_3.html).
// Viewing keeps the clubhouse gate it carried on Home; mutations inside are
// gated on app_users.is_admin (a non-admin gets a read-only board).

import PagePermissionGuard from "@/components/PagePermissionGuard";
import RoadmapView from "./RoadmapView";

export default function TechRoadmapPage() {
  return (
    <PagePermissionGuard page="clubhouse">
      <RoadmapView />
    </PagePermissionGuard>
  );
}
