import { Suspense } from "react";
import type { Metadata } from "next";
import AdminGuard from "@/components/AdminGuard";
import MatchChatsClient from "./MatchChatsClient";

// Two-pane Match Chats console. Left = tabbed inbox (Active /
// Upcoming), right = selected chat with realtime listener and
// composer. URL state: ?chatId=…&tab=active|upcoming.
//
// Mirrors /chats: outer div escapes AuthGate's <main> padding so the
// header + client occupy one full-bleed area flush under the top nav.
// Height math uses 100dvh + --bottom-nav-h so MobileBottomNav (under
// md:) doesn't cover the composer. The Players/Matches segmented
// control lives inside MatchChatsClient's header now, replacing the
// old CrmSubTabStrip mount.

export const metadata: Metadata = {
  title: "Match Chats",
};

export default function MatchChatsPage() {
  return (
    <AdminGuard>
      <div
        className="-mx-6 -mb-8 flex h-[calc(100dvh-var(--bottom-nav-h))] flex-col md:h-[calc(100dvh-4rem)]"
        style={{
          marginTop: "calc(-1 * max(env(safe-area-inset-top), 2rem))",
        }}
      >
        {/* Suspense boundary required by Next 16 for any client tree
            that calls useSearchParams (MatchChatsClient owns ?chatId
            and ?tab). */}
        <Suspense fallback={null}>
          <MatchChatsClient />
        </Suspense>
      </div>
    </AdminGuard>
  );
}
