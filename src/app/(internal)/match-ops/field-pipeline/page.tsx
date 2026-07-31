"use client";

// Field Pipeline — relocated off the Home page (was a Home tab) to Match Ops.
// Same component, same board, same behaviour; only the route changed. Gate is
// the clubhouse permission it carried on Home (it lived inside Home's
// PagePermissionGuard page="clubhouse").

import PagePermissionGuard from "@/components/PagePermissionGuard";
import KanbanBoard from "@/components/KanbanBoard";

export default function FieldPipelinePage() {
  return (
    <PagePermissionGuard page="clubhouse">
      <KanbanBoard boardType="field_pipeline" />
    </PagePermissionGuard>
  );
}
