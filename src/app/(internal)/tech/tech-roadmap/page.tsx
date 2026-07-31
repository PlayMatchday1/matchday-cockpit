"use client";

// Tech Roadmap — relocated off Home to the Tech section. Same component, same
// board, same clubhouse gate it carried on Home.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import KanbanBoard from "@/components/KanbanBoard";

export default function TechRoadmapPage() {
  return (
    <PagePermissionGuard page="clubhouse">
      <KanbanBoard boardType="tech_roadmap" />
    </PagePermissionGuard>
  );
}
