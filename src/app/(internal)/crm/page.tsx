import { Suspense } from "react";
import type { Metadata } from "next";
import AdminGuard from "@/components/AdminGuard";
import CrmSubTabStrip from "@/components/CrmSubTabStrip";
import CrmClient from "./CrmClient";

// Player Chat (route stays /crm — URL stickiness, no rename of the
// underlying CRM data layer). UI label only. AdminGuard is the
// page-level gate; the API routes also enforce the same check.
//
// The outer div escapes the AuthGate <main> wrapper's
// `mx-auto max-w-6xl px-6 py-8` padding so the sub-tab strip and
// CrmClient share a single full-bleed area that sits flush under
// the top nav. Height is calculated against TopNav (4rem) so the
// inner column can flex to fill the rest of the viewport.

export const metadata: Metadata = {
  title: "Player Chat",
};

export default function PlayerChatPage() {
  return (
    <AdminGuard>
      <div className="-mx-6 -my-8 flex h-[calc(100vh-4rem)] flex-col">
        <CrmSubTabStrip />
        {/* Suspense boundary required by Next 16 for any client tree
            that calls useSearchParams (CrmClient owns ?threadId,
            ?cities, ?status). */}
        <Suspense fallback={null}>
          <CrmClient />
        </Suspense>
      </div>
    </AdminGuard>
  );
}
