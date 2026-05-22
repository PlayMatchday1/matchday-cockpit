import { Suspense } from "react";
import type { Metadata } from "next";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import MobileBottomNav from "@/components/MobileBottomNav";
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
    <PagePermissionGuard page="chats">
      <div
        className="-mx-6 flex h-[100dvh] flex-col md:h-[calc(100dvh-4rem)]"
        style={{
          // Cancel AuthGate <main>'s padding so the shell occupies the
          // full viewport. See /chats page wrapper for the full
          // rationale on the inline-nav layout.
          marginTop: "calc(-1 * max(env(safe-area-inset-top), 2rem))",
          marginBottom: "calc(-1 * (2rem + var(--bottom-nav-h)))",
        }}
      >
        {/* Suspense boundary required by Next 16 for any client tree
            that calls useSearchParams (MatchChatsClient owns ?chatId
            and ?tab). */}
        <Suspense fallback={null}>
          <MatchChatsClient />
        </Suspense>
        {/* Inline bottom nav: last flex child of the 100dvh shell,
            sidesteps the iOS PWA position:fixed quirk. See /chats
            page for the full rationale. */}
        <MobileBottomNav inline />
      </div>
    </PagePermissionGuard>
  );
}
