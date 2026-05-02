"use client";

import { use } from "react";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import PartnerDetailAdmin from "@/components/PartnerDetailAdmin";

export default function FinancePartnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <PagePermissionGuard page="finance">
      <PartnerDetailAdmin partnerDashboardId={id} />
    </PagePermissionGuard>
  );
}
