"use client";

// Field Ops — the Fields page, no tabs. Inventory moved to /match-ops/inventory
// and Veo/Community merged into /match-ops/match-chats/automation, so Field Ops
// renders the venue roster directly (the old ?fo= tab strip is gone; the param
// is stripped by a redirect in next.config). Gate: the Match Ops permission.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import CitiesFieldsLens from "@/components/CitiesFieldsLens";

export default function FieldOpsPage() {
  return (
    <PagePermissionGuard page="matchops">
      <CitiesFieldsLens />
    </PagePermissionGuard>
  );
}
