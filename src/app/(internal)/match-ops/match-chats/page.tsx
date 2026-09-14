import { Suspense } from "react";
import type { Metadata } from "next";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import MobileBottomNav from "@/components/MobileBottomNav";
import MatchChatsClient from "./MatchChatsClient";

// Full-bleed three-pane Match Chats console (mockup matchops-chats-v1):
//   rail (212 / 60px) · list (360–404px) · thread (1fr)
// The console fills the viewport below TopNav and never scrolls as a page —
// each pane scrolls on its own.
//
// Escape hatch from AuthGate's shared <main> (mx-auto max-w-[1600px] px-8 +
// vertical padding): the wrapper breaks out horizontally with
// left-1/2 w-screen -translate-x-1/2 and cancels main's top/bottom padding with
// matching negative margins. AuthGate's <main> defaults are NOT changed, so
// every other route renders byte-identically. The gate (page="chats") is
// unchanged — this route does not widen access.

export const metadata: Metadata = {
  title: "Match Chats",
};

export default function MatchChatsPage() {
  return (
    <PagePermissionGuard page="chats">
      <div
        className="relative left-1/2 flex h-[calc(100dvh-var(--appbar-h))] w-screen -translate-x-1/2 flex-col md:h-[calc(100dvh-var(--nav-h))]"
        style={{
          // Cancel AuthGate <main>'s padding so the shell occupies the full area under TopNav.
          // ONE FORMULA, NOT A COPY OF ONE. This used to spell out
          // max(env(safe-area-inset-top), 26px) by hand and negate it, which meant three files had
          // to agree about it forever and only these two were ever kept in line. --main-pt is 0
          // below the rail breakpoint, so on a phone this cancels nothing and the shell simply
          // starts under the app bar.
          marginTop: "calc(-1 * var(--main-pt))",
          marginBottom: "calc(-1 * (60px + var(--bottom-nav-h)))",
        }}
      >
        <Suspense fallback={null}>
          <MatchChatsClient />
        </Suspense>
        {/* Inline bottom nav: last flex child of the 100dvh shell, sidesteps
            the iOS PWA position:fixed quirk. Hidden on md+ (rail takes over). */}
        <MobileBottomNav inline />
      </div>
    </PagePermissionGuard>
  );
}
