"use client";

// Field Pipeline — relocated off the Home page (was a Home tab) to Match Ops.
// Same component, same board, same behaviour; only the route changed. Now gated
// on the Tech permission (PagePermissionGuard page="tech").

import PagePermissionGuard from "@/components/PagePermissionGuard";
import FieldPipelineBoard from "@/components/FieldPipelineBoard";

export default function FieldPipelinePage() {
  return (
    <PagePermissionGuard page="tech">
      <FieldPipelineBoard />
    </PagePermissionGuard>
  );
}
