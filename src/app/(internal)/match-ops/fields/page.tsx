"use client";

// FIELDS — Clubhouse's first field admin. Match Ops › Back Office › Fields.
// Gated on the Match Ops permission like its neighbours; the WRITES additionally require
// EDIT MATCHES, enforced at apiWrite rather than by hiding a button.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import FieldsView from "@/components/FieldsView";

export default function FieldsPage() {
  return (
    <PagePermissionGuard page="matchops">
      <FieldsView />
    </PagePermissionGuard>
  );
}
