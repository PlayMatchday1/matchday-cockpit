import { Suspense } from "react";
import type { Metadata } from "next";
import AdminGuard from "@/components/AdminGuard";
import CrmClient from "./CrmClient";

// Player Chat. AdminGuard is the page-level gate; the API routes
// also enforce the same check.
//
// The outer div escapes the AuthGate <main> wrapper's
// `mx-auto max-w-6xl px-6 py-8` padding so CrmClient occupies a
// single full-bleed area that sits flush under the top nav. Height
// is calculated against TopNav (4rem) so the inner column can flex
// to fill the rest of the viewport.
//
// CrmSubTabStrip used to render here as the Player/Match toggle.
// Replaced in CrmClient by a brand-aligned header with an inline
// segmented control. The /match-chats route still mounts
// CrmSubTabStrip on its own page until that surface gets a matching
// redesign.

export const metadata: Metadata = {
  title: "Player Chat",
};

export default function PlayerChatPage() {
  return (
    <AdminGuard>
      <div className="-mx-6 -my-8 flex h-[calc(100vh-env(safe-area-inset-top))] flex-col md:h-[calc(100vh-4rem-env(safe-area-inset-top))]">
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
