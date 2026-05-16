import { Suspense } from "react";
import type { Metadata } from "next";
import AdminGuard from "@/components/AdminGuard";
import CrmSubTabStrip from "@/components/CrmSubTabStrip";
import CrmClient from "./CrmClient";

// Player Chat (route stays /crm — URL stickiness, no rename of the
// underlying CRM data layer). UI label only. AdminGuard is the
// page-level gate; the API routes also enforce the same check.

export const metadata: Metadata = {
  title: "Player Chat",
};

export default function PlayerChatPage() {
  return (
    <AdminGuard>
      <CrmSubTabStrip />
      {/* Suspense boundary required by Next 16 for any client tree
          that calls useSearchParams (CrmClient owns ?threadId,
          ?cities, ?status). */}
      <Suspense fallback={null}>
        <CrmClient />
      </Suspense>
    </AdminGuard>
  );
}
