"use client";

// Field Pipeline — Home tab → Match Ops → Growth. Same component, same board, same behaviour;
// only the route has ever changed.
//
// IT HAS NO SHELL YET. /match-ops/layout.tsx gave it the Match Ops rail, the 212px content offset
// and the mobile screen-picker bar; leaving that section gives all three up, and Growth builds its
// own in the next push. verify-fieldpipeline-move asserts the loss rather than letting it be
// discovered — see SHELL_EXPECTED there.
//
// STILL GATED ON `tech`. The Growth right does not exist yet; changing the gate and moving the
// route in one push would make a permission regression look like a routing one.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import FieldPipelineBoard from "@/components/FieldPipelineBoard";

export default function FieldPipelinePage() {
  return (
    <PagePermissionGuard page="tech">
      <FieldPipelineBoard />
    </PagePermissionGuard>
  );
}
