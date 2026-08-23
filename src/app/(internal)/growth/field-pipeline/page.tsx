"use client";

// Field Pipeline — Home tab → Match Ops → Growth. Same component, same board, same behaviour;
// only the route and the permission have ever changed.
//
// NO PagePermissionGuard HERE. GrowthShell holds it for the whole section, so a new Growth page
// cannot ship ungated by forgetting a wrapper.
//
// RE-GATED FROM `tech` TO `growth`. It was the one Match Ops item gated on tech, which is what
// made it obvious it did not belong there.

import FieldPipelineBoard from "@/components/FieldPipelineBoard";

export default function FieldPipelinePage() {
  return <FieldPipelineBoard />;
}
