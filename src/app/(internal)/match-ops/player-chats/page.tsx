import { Suspense } from "react";
import type { Metadata } from "next";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import MobileBottomNav from "@/components/MobileBottomNav";
import CrmClient from "./CrmClient";

// Player Chat. PagePermissionGuard checks canAccess(appUser,
// "chats"); the API routes enforce the same check via authenticateCrm
// and RLS policies on crm_* tables enforce it at the DB layer.
// Admins pass via canAccess's is_admin shortcut; chats-only users
// (can_access_chats = true without is_admin) pass via the explicit
// permission check.
//
// The outer div escapes the AuthGate <main> wrapper's
// `mx-auto max-w-6xl px-6 py-8` padding so CrmClient occupies a
// single full-bleed area that sits flush under the top nav. Height
// is calculated against TopNav (4rem) so the inner column can flex
// to fill the rest of the viewport.
//
// The Players/Matches segmented control is rendered inside
// CrmClient's ChatsHeader via the shared PlayersMatchesToggle
// component; /match-chats mounts the same toggle inside its own
// MatchChatsHeader.

export const metadata: Metadata = {
  title: "Player Chat",
};

export default function PlayerChatPage() {
  return (
    <PagePermissionGuard page="chats">
      <div
        className="relative left-1/2 flex h-[100dvh] w-screen -translate-x-1/2 flex-col md:h-[calc(100dvh-4rem)]"
        style={{
          // Full-bleed escape from AuthGate <main> (mx-auto max-w-[1600px]
          // px-8 + vertical padding). Horizontal: left-1/2 w-screen
          // -translate-x-1/2 breaks out of the centered max-width without
          // touching <main>'s defaults (every other route is byte-identical).
          // Vertical: cancel main's paddingTop max(env,26px) and paddingBottom
          // calc(60px + var(--bottom-nav-h)). Same mechanism as Match Chats.
          marginTop: "calc(-1 * max(env(safe-area-inset-top), 26px))",
          marginBottom: "calc(-1 * (60px + var(--bottom-nav-h)))",
        }}
      >
        {/* Suspense boundary required by Next 16 for any client tree
            that calls useSearchParams (CrmClient owns ?threadId,
            ?cities, ?status). */}
        <Suspense fallback={null}>
          <CrmClient />
        </Suspense>
        {/* Inline bottom nav: last flex child of the 100dvh shell, so
            iOS-handled flex layout positions it at the visible bottom
            of the shrunken-by-dvh shell when the keyboard opens, and
            back at the viewport bottom when it closes. No position:fixed
            for the nav on this route — that's the whole point. */}
        <MobileBottomNav inline />
      </div>
    </PagePermissionGuard>
  );
}
