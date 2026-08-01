"use client";

// Equipment Inventory — its own Match Ops rail item (moved verbatim off the old
// Field Ops ?fo=inventory tab). Same component, same data, same behaviour. Gate
// unchanged: can_access_cities (the tab was visible to all Field Ops viewers).

import PagePermissionGuard from "@/components/PagePermissionGuard";
import InventoryDashboard from "@/components/InventoryDashboard";

export default function InventoryPage() {
  return (
    <PagePermissionGuard page="cities">
      <InventoryDashboard />
    </PagePermissionGuard>
  );
}
