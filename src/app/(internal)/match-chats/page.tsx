import { Suspense } from "react";
import type { Metadata } from "next";
import AdminGuard from "@/components/AdminGuard";
import CrmSubTabStrip from "@/components/CrmSubTabStrip";
import MatchChatsClient from "./MatchChatsClient";

// Two-pane Match Chats console. Left = tabbed inbox (Active /
// Upcoming), right = selected chat with realtime listener and
// composer. URL state: ?chatId=…&tab=active|upcoming.
//
// Outer div mirrors /crm — escapes AuthGate's main wrapper so the
// sub-tab strip + client occupy a single full-bleed surface flush
// with the top nav. The MatchChatsClient root no longer needs its
// own `-mx-6 -my-8` escape; that responsibility moved up here.

export const metadata: Metadata = {
  title: "Match Chats",
};

export default function MatchChatsPage() {
  return (
    <AdminGuard>
      <div className="-mx-6 -my-8 flex h-[calc(100vh-4rem-env(safe-area-inset-top))] flex-col">
        <CrmSubTabStrip />
        <Suspense fallback={null}>
          <MatchChatsClient />
        </Suspense>
      </div>
    </AdminGuard>
  );
}
